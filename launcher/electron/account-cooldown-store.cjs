const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const PRIMARY_ACCOUNT = "@primary";
const MAX_MESSAGE_BYTES = 2048;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TIMESTAMP = 8_640_000_000_000_000;

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hasKeys = (value, keys) => isObject(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field && field.enumerable && Object.hasOwn(field, "value");
  });
const isTime = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP;
const isMessage = value => typeof value === "string" && value.length > 0
  && Buffer.byteLength(value, "utf8") <= MAX_MESSAGE_BYTES;
const isAccountName = value => typeof value === "string" && (value === PRIMARY_ACCOUNT
  || /^[a-zA-Z0-9_-]+$/.test(value));

function validateAccountName(account) {
  if (!isAccountName(account)) throw new Error("Invalid account cooldown name");
}

function corruptStore(filePath) {
  return new Error(`Account cooldown store is corrupt; original preserved: ${filePath}`);
}

function readEntries(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw error;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw corruptStore(filePath);
  const bytes = fs.readFileSync(filePath);
  const content = bytes.toString("utf8");
  if (bytes.length > MAX_FILE_BYTES || !bytes.equals(Buffer.from(content, "utf8"))) throw corruptStore(filePath);
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    throw corruptStore(filePath);
  }
  if (!hasKeys(data, ["version", "accounts"]) || data.version !== 1 || !isObject(data.accounts)) {
    throw corruptStore(filePath);
  }
  const entries = new Map();
  for (const [account, entry] of Object.entries(data.accounts)) {
    // Validate expired entries too: invalid metadata must never be silently repaired.
    if (!isAccountName(account) || !hasKeys(entry, ["retryAt", "message"])
      || !isTime(entry.retryAt) || !isMessage(entry.message)) throw corruptStore(filePath);
    entries.set(account, { retryAt: entry.retryAt, message: entry.message });
  }
  return entries;
}

// Synchronous launcher-main-process writes. Reload before each operation so
// separate instances cannot overwrite another account using stale state.
// The only persisted values are account names, absolute times and cooldown text.
class AccountCooldownStore {
  #filePath;
  #now;

  constructor(filePath, { now = Date.now } = {}) {
    if (typeof filePath !== "string" || !filePath || filePath.includes("\0") || typeof now !== "function") {
      throw new Error("An account cooldown file path and clock function are required");
    }
    this.#filePath = filePath;
    this.#now = now;
    readEntries(filePath);
  }

  #time() {
    const now = this.#now();
    if (!isTime(now)) throw new Error("The account cooldown clock must return a valid absolute timestamp");
    return now;
  }

  #write(entries) {
    const content = `${JSON.stringify({ version: 1, accounts: Object.fromEntries(entries) }, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      throw new Error("Account cooldown store capacity exceeded; original preserved");
    }
    writePrivateFileAtomic(this.#filePath, content);
  }

  get(account) {
    validateAccountName(account);
    const now = this.#time();
    const entry = readEntries(this.#filePath).get(account);
    return entry && entry.retryAt > now ? { ...entry } : null;
  }

  record(account, entry) {
    validateAccountName(account);
    const now = this.#time();
    if (!hasKeys(entry, ["retryAt", "message"]) || !isTime(entry.retryAt) || entry.retryAt <= now
      || !isMessage(entry.message)) {
      throw new Error(`Invalid account cooldown metadata: expected a future absolute retryAt and a nonempty message of at most ${MAX_MESSAGE_BYTES} UTF-8 bytes`);
    }
    const entries = readEntries(this.#filePath);
    const existing = entries.get(account);
    // Keep the message associated with the longest wait, including equal observations.
    if (existing && existing.retryAt >= entry.retryAt) return { ...existing };
    const pending = { retryAt: entry.retryAt, message: entry.message };
    entries.set(account, pending);
    this.#write(entries);
    return { ...pending };
  }

  snapshot() {
    const now = this.#time();
    return Object.fromEntries([...readEntries(this.#filePath)]
      .filter(([, entry]) => entry.retryAt > now));
  }

  clear(account) {
    validateAccountName(account);
    const entries = readEntries(this.#filePath);
    if (!entries.delete(account)) return false;
    this.#write(entries);
    return true;
  }
}

module.exports = { PRIMARY_ACCOUNT, AccountCooldownStore };
