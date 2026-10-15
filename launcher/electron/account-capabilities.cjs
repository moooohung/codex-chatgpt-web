const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

// Subscription evidence only. Never inspect cookies or access/refresh tokens.
// Plus defaults to High until that partition's model picker proves Extra High.
function capabilitiesFromPlan(context, checkedAt = Date.now()) {
  const proAvailable = context.planType === "pro" || context.planType === "prolite";
  if (typeof context.accountKey !== "string" || !/^[a-f0-9]{64}$/.test(context.accountKey)
    || !["free", "plus", "pro", "prolite"].includes(context.planType)) {
    throw new Error("Invalid per-account plan evidence");
  }
  return { accountKey: context.accountKey, planType: context.planType, checkedAt,
    solAvailable: context.planType !== "free", proAvailable, extraHighAvailable: proAvailable };
}

function validateEntries(accounts) {
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) throw new Error("Invalid account capabilities store");
  return Object.entries(accounts).map(([name, entry]) => {
    const expected = capabilitiesFromPlan(entry, entry.checkedAt);
    if (!(name === "@primary" || /^[a-zA-Z0-9_-]+$/.test(name)) || !Number.isFinite(entry?.checkedAt)
      || Object.keys(entry).some(key => !Object.hasOwn(expected, key))
      || Object.keys(expected).some(key => key !== "extraHighAvailable" && entry[key] !== expected[key])
      || typeof entry.extraHighAvailable !== "boolean" || (!expected.solAvailable && entry.extraHighAvailable)) {
      throw new Error("Invalid account capabilities entry");
    }
    return [name, entry];
  });
}

function readCapabilities(file) {
  if (!file || !fs.existsSync(file)) return new Map();
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!data || data.version !== 1) throw new Error("Invalid account capabilities store");
  // Persisted observations are diagnostics; re-prove plans after every launcher restart.
  return new Map(validateEntries(data.accounts).map(([name, entry]) => [name, { ...entry, checkedAt: 0 }]));
}

function saveCapabilities(file, entries) {
  if (file) {
    const accounts = Object.fromEntries(entries);
    validateEntries(accounts);
    writePrivateFileAtomic(file, JSON.stringify({ version: 1, accounts }, null, 2) + "\n");
  }
}

function modelAccountPool({ pool, capabilities, statuses = new Map(), disabled = new Set(), pending = new Set(),
  cooldowns, proUnavailable = new Map(), requiresPro = false, now = Date.now() }) {
  const usable = pool.filter(name => {
    const status = statuses.get(name);
    const proof = capabilities.get(name);
    return Number.isFinite(proof?.checkedAt) && proof.checkedAt > 0 && proof.checkedAt >= now - 30_000
      && !disabled.has(name) && !pending.has(name)
      && status?.authenticated !== false && !status?.securityCheckRequired
      && !(status?.cooldownUntil > now) && !cooldowns?.get(name);
  });
  if (!requiresPro) return usable;
  const pro = usable.filter(name => capabilities.get(name).proAvailable && !(proUnavailable.get(name) > now));
  if (pro.length) return pro;
  const nonPro = usable.filter(name => !capabilities.get(name).proAvailable);
  const paid = nonPro.filter(name => capabilities.get(name).solAvailable);
  return paid.length ? paid : nonPro;
}

module.exports = { capabilitiesFromPlan, readCapabilities, saveCapabilities, modelAccountPool };
