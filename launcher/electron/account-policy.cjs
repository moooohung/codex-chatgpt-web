const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

function accountNameForTab(tab) {
  return tab.accountName ?? tab.assignedAccount ?? null;
}

function accountPaths({ coreHome = path.join(os.homedir(), ".codex-chatgpt-web"), userData, partition = "persist:codex-web-gpt-chatgpt" } = {}) {
  const data = userData || path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "Codex Web GPT");
  const canonicalHome = path.resolve(coreHome);
  const normalize = value => process.platform === "win32" ? value.toLowerCase() : value;
  const production = normalize(canonicalHome) === normalize(path.resolve(os.homedir(), ".codex-chatgpt-web"))
    && partition === "persist:codex-web-gpt-chatgpt";
  const namespace = production ? "codex-chatgpt-web" : `codex-chatgpt-web-${createHash("sha256").update(`${canonicalHome.toLowerCase()}\n${partition}`).digest("hex").slice(0, 16)}`;
  return {
    config: path.join(canonicalHome, "switcher", "accounts-config.json"),
    secrets: path.join(canonicalHome, "secrets"),
    sticky: path.join(data, "conversations-sticky.json"),
    partition: name => `${partition}-${validateAccountName(name)}`,
    partitionDirectory: name => path.join(data, "Partitions", `${partition.replace(/^persist:/, "")}-${validateAccountName(name)}`),
    tunnelAlias: name => `${namespace}-${validateAccountName(name)}`,
  };
}

function validateAccountName(name) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Invalid account name");
  return name;
}

function readAccountConfig(filePath) {
  if (!fs.existsSync(filePath)) return { accounts: {} };
  let data;
  try { data = JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { throw new Error(`Account configuration is corrupt; original preserved: ${filePath}`); }
  if (!data || typeof data !== "object" || Array.isArray(data)
    || !data.accounts || typeof data.accounts !== "object" || Array.isArray(data.accounts)) {
    throw new Error(`Invalid account configuration; original preserved: ${filePath}`);
  }
  for (const [name, account] of Object.entries(data.accounts)) {
    validateAccountName(name);
    if (!account || typeof account !== "object" || Array.isArray(account)) throw new Error(`Invalid account configuration for ${name}`);
  }
  return data;
}

function writeAccountConfig(filePath, data) {
  // Validate the old file before replacing it, including writes after a failed read.
  readAccountConfig(filePath);
  writePrivateFileAtomic(filePath, JSON.stringify(data, null, 2) + "\n");
}

function accountUnavailable(reasons) {
  const error = new Error(`No ChatGPT account is available: ${reasons.join(", ") || "empty account pool"}`);
  error.code = "account_unavailable";
  error.reasons = reasons;
  return error;
}

function selectAccount({ pool = [], configured = false, disabled = new Set(), pending = new Set(), statuses = new Map(), tabs = [], bound, roundRobin = 0, now = Date.now() }) {
  if (pool.length === 0 && !configured) return null;
  const reasons = [];
  const available = pool.filter(name => {
    const status = statuses.get(name);
    const reason = pending.has(name) ? "pending removal" : disabled.has(name) ? "disabled"
      : status?.authenticated === false ? "signed out" : status?.cooldownUntil > now ? "cooling down" : null;
    if (reason) reasons.push(`${name}: ${reason}`);
    return !reason;
  });
  if (!available.length) throw accountUnavailable(reasons);
  if (available.includes(bound)) return bound;
  const counts = new Map(available.map(name => [name, 0]));
  for (const tab of tabs) {
    const name = accountNameForTab(tab);
    if (counts.has(name) && (tab.status === "running" || tab.loading === true)) counts.set(name, counts.get(name) + 1);
  }
  const minimum = Math.min(...counts.values());
  const candidates = available.filter(name => counts.get(name) === minimum);
  return candidates[roundRobin % candidates.length];
}

module.exports = { accountNameForTab, accountPaths, accountUnavailable, readAccountConfig, selectAccount, validateAccountName, writeAccountConfig };
