const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  capabilitiesFromPlan,
  readCapabilities,
  saveCapabilities,
  modelAccountPool,
} = require("../electron/account-capabilities.cjs");

const NOW = 1_000_000;
const ACCOUNT_KEY = "a".repeat(64);
const OTHER_ACCOUNT_KEY = "b".repeat(64);
const CAPABILITY_KEYS = [
  "accountKey", "checkedAt", "extraHighAvailable", "planType", "proAvailable", "solAvailable",
];

function proof(planType = "plus", checkedAt = NOW, accountKey = ACCOUNT_KEY) {
  return capabilitiesFromPlan({ accountKey, planType }, checkedAt);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-capabilities-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "nested", "account-capabilities.json");
}

function writeStore(file, accounts, version = 1) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version, accounts }));
}

function route(capabilities, overrides = {}) {
  return modelAccountPool({ pool: [...capabilities.keys()], capabilities, now: NOW, ...overrides });
}

for (const [planType, solAvailable, proAvailable] of [
  ["free", false, false],
  ["plus", true, false],
  ["pro", true, true],
  ["prolite", true, true],
]) {
  test(`${planType} evidence defaults Extra High only for Pro plans`, () => {
    const context = Object.freeze({ accountKey: ACCOUNT_KEY, planType });
    assert.deepEqual(capabilitiesFromPlan(context, NOW), {
      accountKey: ACCOUNT_KEY, planType, checkedAt: NOW,
      solAvailable, proAvailable, extraHighAvailable: proAvailable,
    });
  });
}

test("plan proof defaults checkedAt to the current time", () => {
  const before = Date.now();
  const result = capabilitiesFromPlan({ accountKey: ACCOUNT_KEY, planType: "plus" });
  assert.ok(result.checkedAt >= before && result.checkedAt <= Date.now());
});

test("plan proof rejects invalid account identities and unsupported subscription evidence", () => {
  for (const accountKey of [undefined, null, "", "a".repeat(63), "a".repeat(65), "A".repeat(64),
    "g".repeat(64), ` ${ACCOUNT_KEY}`, "synthetic-user@example.invalid"]) {
    assert.throws(() => capabilitiesFromPlan({ accountKey, planType: "pro" }, NOW),
      /Invalid per-account plan evidence/);
  }
  for (const planType of [undefined, null, "", "Pro", "team", "enterprise", "unknown"]) {
    assert.throws(() => capabilitiesFromPlan({ accountKey: ACCOUNT_KEY, planType }, NOW),
      /Invalid per-account plan evidence/);
  }
});

test("proof generation never reads raw auth and persistence contains only capability evidence", t => {
  const context = { accountKey: ACCOUNT_KEY, planType: "plus" };
  for (const field of ["accessToken", "refreshToken", "cookies", "session", "user", "email"]) {
    Object.defineProperty(context, field, {
      enumerable: true,
      get() { assert.fail(`Capability evidence must not inspect ${field}`); },
    });
  }
  const result = capabilitiesFromPlan(context, NOW);
  assert.deepEqual(Object.keys(result).sort(), CAPABILITY_KEYS);
  const file = fixture(t);
  saveCapabilities(file, new Map([["alpha", result]]));
  const bytes = fs.readFileSync(file, "utf8");
  const persisted = JSON.parse(bytes);
  assert.deepEqual(Object.keys(persisted).sort(), ["accounts", "version"]);
  assert.deepEqual(Object.keys(persisted.accounts.alpha).sort(), CAPABILITY_KEYS);
  assert.doesNotMatch(bytes, /accessToken|refreshToken|cookies|session|user|email/);
});

test("missing capability paths and empty stores start with no proved accounts", t => {
  const file = fixture(t);
  for (const candidate of [undefined, null, "", file]) {
    assert.deepEqual(readCapabilities(candidate), new Map());
  }
  saveCapabilities(file, new Map());
  assert.deepEqual(readCapabilities(file), new Map());
  assert.doesNotThrow(() => saveCapabilities(undefined, new Map()));
});

test("save/read preserves identities and picker overrides but resets every persisted proof", t => {
  const file = fixture(t);
  const entries = new Map([
    ["Alpha-2_beta", { ...proof("plus"), extraHighAvailable: true }],
    ["@primary", { ...proof("pro", NOW - 100, OTHER_ACCOUNT_KEY), extraHighAvailable: false }],
    ["free", proof("free")],
  ]);
  const snapshot = structuredClone(entries);
  saveCapabilities(file, entries);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    version: 1, accounts: Object.fromEntries(entries),
  });
  assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"));
  const restored = readCapabilities(file);
  assert.deepEqual(restored, new Map([...entries].map(([name, entry]) => [name, { ...entry, checkedAt: 0 }])));
  assert.deepEqual(entries, snapshot, "saving must not invalidate current in-memory proof");
  for (const requiresPro of [false, true]) {
    assert.deepEqual(route(restored, { requiresPro }), [], "persisted diagnostics must be re-proved");
  }
  restored.set("@primary", proof("pro", NOW, OTHER_ACCOUNT_KEY));
  assert.deepEqual(route(restored, { requiresPro: true }), ["@primary"]);
});

test("save replaces obsolete accounts without leaving atomic-write temporary files", t => {
  const file = fixture(t);
  saveCapabilities(file, new Map([["removed", proof("pro")]]));
  saveCapabilities(file, new Map([["replacement", proof("plus", NOW, OTHER_ACCOUNT_KEY)]]));
  assert.deepEqual([...readCapabilities(file).keys()], ["replacement"]);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("read rejects malformed stores and preserves the rejected file", t => {
  const file = fixture(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const content of ["{", "null", "{}", JSON.stringify({ version: 2, accounts: {} }),
    JSON.stringify({ version: 1, accounts: null }), JSON.stringify({ version: 1, accounts: "alpha" })]) {
    fs.writeFileSync(file, content);
    assert.throws(() => readCapabilities(file));
    assert.equal(fs.readFileSync(file, "utf8"), content);
  }
});

test("read rejects invalid aliases, hashes, timestamps and forged plan flags", t => {
  const file = fixture(t);
  const plus = proof("plus");
  const invalid = [
    ...["", "@other", "../alpha", "alpha.beta", " alpha", "alpha/beta"].map(name => [name, plus]),
    ["alpha", null],
    ["alpha", { ...plus, accountKey: "not-a-hash" }],
    ["alpha", { ...plus, accountKey: "A".repeat(64) }],
    ["alpha", { ...plus, planType: "unknown" }],
    ["alpha", { ...plus, checkedAt: "1000000" }],
    ["alpha", { ...plus, checkedAt: null }],
    ["alpha", { ...plus, checkedAt: Infinity }],
    ["alpha", { ...plus, proAvailable: true }],
    ["alpha", { ...plus, solAvailable: false }],
    ["alpha", { ...plus, extraHighAvailable: "true" }],
    ["alpha", { ...proof("pro"), proAvailable: false }],
    ["alpha", { ...proof("free"), solAvailable: true }],
    ["alpha", { ...proof("free"), extraHighAvailable: true }],
    ["alpha", { accountKey: ACCOUNT_KEY, planType: "plus", checkedAt: NOW }],
  ];
  for (const [name, entry] of invalid) {
    writeStore(file, { [name]: entry });
    const original = fs.readFileSync(file, "utf8");
    assert.throws(() => readCapabilities(file), `Invalid entry ${name}: ${JSON.stringify(entry)}`);
    assert.equal(fs.readFileSync(file, "utf8"), original);
  }
});

test("read rejects persisted raw auth or identity metadata outside the evidence schema", t => {
  const file = fixture(t);
  for (const field of ["accessToken", "refreshToken", "cookies", "session", "user", "email", "userId"]) {
    writeStore(file, { alpha: { ...proof("plus"), [field]: "synthetic-private-fixture" } });
    assert.throws(() => readCapabilities(file), /Invalid account capabilities entry/, field);
  }
});

test("identity validation rejects arrays and coercible objects without converting them to hashes", t => {
  let coercions = 0;
  const coercible = { toString() { coercions++; return ACCOUNT_KEY; } };
  for (const accountKey of [[ACCOUNT_KEY], new String(ACCOUNT_KEY), coercible]) {
    assert.throws(() => capabilitiesFromPlan({ accountKey, planType: "plus" }, NOW),
      /Invalid per-account plan evidence/);
  }
  assert.equal(coercions, 0, "non-string identities must not be coerced");
  const file = fixture(t);
  writeStore(file, { alpha: { ...proof("plus"), accountKey: [ACCOUNT_KEY] } });
  const original = fs.readFileSync(file, "utf8");
  assert.throws(() => readCapabilities(file), /Invalid per-account plan evidence/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("read rejects both empty and populated accounts arrays instead of admitting numeric aliases", t => {
  const file = fixture(t);
  for (const accounts of [[], [proof("plus")]]) {
    writeStore(file, accounts);
    const original = fs.readFileSync(file, "utf8");
    assert.throws(() => readCapabilities(file), /Invalid account capabilities store/);
    assert.equal(fs.readFileSync(file, "utf8"), original);
  }
});

test("read rejects prototype-named extra fields containing raw auth envelopes", t => {
  const file = fixture(t);
  for (const field of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const entry = { ...proof("plus"), [field]: { accessToken: "synthetic-private-fixture" } };
    assert.equal(Object.hasOwn(entry, field), true);
    writeStore(file, { alpha: entry });
    const original = fs.readFileSync(file, "utf8");
    assert.throws(() => readCapabilities(file), /Invalid account capabilities entry/, field);
    assert.equal(fs.readFileSync(file, "utf8"), original);
  }
});

test("save rejects arbitrary extras before replacing a good store or creating temporary files", t => {
  const file = fixture(t);
  const good = new Map([["alpha", proof("plus")], ["@primary", proof("pro", NOW, OTHER_ACCOUNT_KEY)]]);
  saveCapabilities(file, good);
  const original = fs.readFileSync(file);
  const restored = readCapabilities(file);
  for (const field of ["accessToken", "refreshToken", "cookies", "unexpected", "constructor", "__proto__"]) {
    const invalid = { ...proof("plus"), [field]: { accessToken: "synthetic-private-fixture" } };
    const entries = new Map([...good, ["invalid", invalid]]);
    assert.throws(() => saveCapabilities(file, entries), /Invalid account capabilities entry/, field);
    assert.deepEqual(fs.readFileSync(file), original, "rejected saves must preserve the good store byte for byte");
    assert.deepEqual(readCapabilities(file), restored);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
    assert.equal(entries.get("invalid"), invalid, "rejection must not alter the supplied entry");
  }
});

test("Pro/max routing prefers all usable proved Pro plans in pool order over Plus/free", () => {
  const capabilities = new Map([
    ["plus", proof("plus")], ["prolite", proof("prolite")],
    ["free", proof("free")], ["pro", proof("pro")],
  ]);
  assert.deepEqual(route(capabilities, { requiresPro: true }), ["prolite", "pro"]);
  assert.deepEqual(route(capabilities), ["plus", "prolite", "free", "pro"]);
  assert.deepEqual(route(capabilities, { pool: ["pro", "plus", "prolite"], requiresPro: true }), ["pro", "prolite"]);
});

test("Pro/max uses paid Plus fallback when every Pro candidate is unusable", () => {
  const capabilities = new Map([
    ["free", proof("free")], ["pro", proof("pro")],
    ["plus-a", proof("plus")], ["plus-b", proof("plus", NOW, OTHER_ACCOUNT_KEY)],
  ]);
  for (const unavailable of [
    { disabled: new Set(["pro"]) },
    { pending: new Set(["pro"]) },
    { statuses: new Map([["pro", { authenticated: false }]]) },
    { statuses: new Map([["pro", { securityCheckRequired: true }]]) },
    { statuses: new Map([["pro", { cooldownUntil: NOW + 1 }]]) },
    { cooldowns: new Map([["pro", { retryAt: NOW + 1 }]]) },
    { proUnavailable: new Map([["pro", NOW + 1]]) },
  ]) assert.deepEqual(route(capabilities, { requiresPro: true, ...unavailable }), ["plus-a", "plus-b"]);
  const stale = new Map(capabilities);
  stale.set("pro", proof("pro", NOW - 30_001));
  assert.deepEqual(route(stale, { requiresPro: true }), ["plus-a", "plus-b"]);
  const unproved = new Map(capabilities);
  unproved.delete("pro");
  assert.deepEqual(route(unproved, { pool: [...capabilities.keys()], requiresPro: true }), ["plus-a", "plus-b"]);
});

test("installed fallback allows proved free only when no paid non-Pro remains", () => {
  const capabilities = new Map([["pro", proof("pro")], ["free", proof("free")]]);
  assert.deepEqual(route(capabilities, { requiresPro: true, proUnavailable: new Map([["pro", NOW + 1]]) }), ["free"]);
  assert.deepEqual(route(new Map([["pro", proof("pro")]]), {
    requiresPro: true, proUnavailable: new Map([["pro", NOW + 1]]),
  }), []);
});

test("every unavailable account is excluded for ordinary and Pro/max requests", () => {
  const pool = ["disabled", "pending", "logged-out", "security", "status-cooldown", "stored-cooldown", "unproved", "ready"];
  const capabilities = new Map(pool.filter(name => name !== "unproved").map(name => [name, proof("pro")]));
  const statuses = new Map([
    ["logged-out", { authenticated: false }], ["security", { securityCheckRequired: true }],
    ["status-cooldown", { cooldownUntil: NOW + 1 }],
    ["unproved", { authenticated: true }], ["ready", { authenticated: true }],
  ]);
  const options = { pool, statuses, disabled: new Set(["disabled"]), pending: new Set(["pending"]),
    cooldowns: new Map([["stored-cooldown", { retryAt: NOW + 1 }]]) };
  const snapshot = structuredClone({ capabilities, ...options });
  for (const requiresPro of [false, true]) assert.deepEqual(route(capabilities, { ...options, requiresPro }), ["ready"]);
  assert.deepEqual({ capabilities, ...options }, snapshot, "selection must not change availability or evidence");
});

test("proof freshness rejects zero, missing, nonfinite and expired timestamps at the 30-second boundary", () => {
  for (const checkedAt of [undefined, null, "1000000", NaN, Infinity, -Infinity, -1, 0, NOW - 30_001]) {
    const capabilities = new Map([["invalid", { ...proof("pro"), checkedAt }], ["fresh", proof("plus")]]);
    for (const requiresPro of [false, true]) {
      assert.deepEqual(route(capabilities, { requiresPro }), ["fresh"], String(checkedAt));
    }
  }
  const capabilities = new Map([
    ["boundary", proof("pro", NOW - 30_000)], ["fresh", proof("pro", NOW)],
  ]);
  assert.deepEqual(route(capabilities, { requiresPro: true }), ["boundary", "fresh"]);
  assert.deepEqual(route(capabilities, { requiresPro: true, now: NOW + 1 }), ["fresh"]);
});

test("finite future proof follows current clock-skew semantics but cannot bypass disablement", () => {
  const capabilities = new Map([["pro", proof("pro", NOW + 1_000)]]);
  assert.deepEqual(route(capabilities, { requiresPro: true }), ["pro"]);
  assert.deepEqual(route(capabilities, { requiresPro: true, disabled: new Set(["pro"]) }), []);
});

test("expired status and model waits restore Pro preference without blocking ordinary requests", () => {
  const capabilities = new Map([["plus", proof("plus")], ["pro", proof("pro")]]);
  const proUnavailable = new Map([["pro", NOW + 1]]);
  assert.deepEqual(route(capabilities, { proUnavailable }), ["plus", "pro"]);
  assert.deepEqual(route(capabilities, { proUnavailable, requiresPro: true }), ["plus"]);
  assert.deepEqual(route(capabilities, { proUnavailable, requiresPro: true, now: NOW + 1,
    statuses: new Map([["pro", { cooldownUntil: NOW + 1 }]]) }), ["pro"]);
});

test("primary and named accounts both require usable proof and an empty pool stays empty", () => {
  const capabilities = new Map([["plus", proof("plus")], ["@primary", proof("pro")]]);
  assert.deepEqual(route(capabilities, { requiresPro: true }), ["@primary"]);
  assert.deepEqual(route(capabilities, { requiresPro: true, pending: new Set(["@primary"]) }), ["plus"]);
  assert.deepEqual(route(capabilities, { pool: [] }), []);
  assert.deepEqual(route(new Map(), { pool: ["@primary"], statuses: new Map([["@primary", { authenticated: true }]]) }), []);
});
