const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { PRIMARY_ACCOUNT, AccountCooldownStore } = require("../electron/account-cooldown-store.cjs");

const NOW = 1_791_590_400_000;
const pending = (retryAt = NOW + 60_000, message = "Try again later") => ({ retryAt, message });
const document = accounts => JSON.stringify({ version: 1, accounts });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-cooldown-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "metadata", "cooldowns.json");
  let now = NOW;
  return {
    root,
    filePath,
    now: () => now,
    setTime(value) { now = value; },
    open() { return new AccountCooldownStore(filePath, { now: () => now }); },
    write(content) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    },
  };
}

test("an absent store stays absent until a cooldown is recorded", t => {
  const f = fixture(t);
  const store = f.open();
  assert.equal(PRIMARY_ACCOUNT, "@primary");
  assert.equal(store.get("alpha"), null);
  assert.equal(store.get(PRIMARY_ACCOUNT), null);
  assert.deepEqual(store.snapshot(), {});
  assert.equal(store.clear("alpha"), false);
  assert.equal(fs.existsSync(path.dirname(f.filePath)), false);
});

test("cooldown metadata survives recreation and a fresh Node process", t => {
  const f = fixture(t);
  const store = f.open();
  store.record("alpha", pending());
  store.record(PRIMARY_ACCOUNT, pending(NOW + 120_000, "Primary cooldown"));
  const expected = { alpha: pending(), [PRIMARY_ACCOUNT]: pending(NOW + 120_000, "Primary cooldown") };
  assert.deepEqual(f.open().snapshot(), expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.filePath, "utf8")), { version: 1, accounts: expected });
  assert.deepEqual(fs.readdirSync(path.dirname(f.filePath)), ["cooldowns.json"]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(f.filePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(f.filePath)).mode & 0o777, 0o700);
  }

  const restarted = spawnSync(process.execPath, ["-e", `
    const { AccountCooldownStore } = require(process.argv[1]);
    const store = new AccountCooldownStore(process.argv[2], { now: () => Number(process.argv[3]) });
    process.stdout.write(JSON.stringify(store.snapshot()));
  `, require.resolve("../electron/account-cooldown-store.cjs"), f.filePath, String(NOW)], { encoding: "utf8" });
  assert.equal(restarted.error, undefined);
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(JSON.parse(restarted.stdout), expected);
});

test("shorter or equal observations preserve the longest wait and its message", t => {
  const f = fixture(t);
  const store = f.open();
  const longest = pending(NOW + 300_000, "Long wait");
  store.record("alpha", pending());
  assert.deepEqual(store.record("alpha", longest), longest);
  const before = fs.readFileSync(f.filePath);
  assert.deepEqual(f.open().record("alpha", pending(NOW + 10_000, "Short wait")), longest);
  assert.deepEqual(store.record("alpha", pending(longest.retryAt, "Equal wait")), longest);
  assert.deepEqual(fs.readFileSync(f.filePath), before);
  assert.deepEqual(f.open().get("alpha"), longest);
});

test("expired accounts are available exactly at retryAt and reads do not rewrite metadata", t => {
  const f = fixture(t);
  const store = f.open();
  store.record("alpha", pending(NOW + 10));
  store.record("beta", pending(NOW + 20, "Beta wait"));
  store.record(PRIMARY_ACCOUNT, pending(NOW + 5, "Primary wait"));
  const before = fs.readFileSync(f.filePath);
  f.setTime(NOW + 9);
  assert.deepEqual(store.get("alpha"), pending(NOW + 10));
  assert.equal(store.get(PRIMARY_ACCOUNT), null);
  f.setTime(NOW + 10);
  assert.equal(store.get("alpha"), null);
  assert.deepEqual(f.open().snapshot(), { beta: pending(NOW + 20, "Beta wait") });
  f.setTime(NOW + 20);
  assert.equal(f.open().get("beta"), null);
  assert.deepEqual(store.snapshot(), {});
  assert.deepEqual(fs.readFileSync(f.filePath), before);
  const renewed = pending(NOW + 30, "Renewed wait");
  assert.deepEqual(store.record("alpha", renewed), renewed);
  assert.deepEqual(f.open().snapshot(), { alpha: renewed });
});

test("concurrent same-process A/B observations stay isolated across stale instances", async t => {
  const f = fixture(t);
  const first = f.open();
  const second = f.open();
  await Promise.all([
    Promise.resolve().then(() => first.record("A", pending(NOW + 300_000, "A wait"))),
    Promise.resolve().then(() => second.record("B", pending(NOW + 60_000, "B wait"))),
    Promise.resolve().then(() => first.record("A", pending(NOW + 10_000, "Short A wait"))),
    Promise.resolve().then(() => second.record("B", pending(NOW + 120_000, "Longer B wait"))),
  ]);
  const expected = { A: pending(NOW + 300_000, "A wait"), B: pending(NOW + 120_000, "Longer B wait") };
  assert.deepEqual(first.snapshot(), expected);
  assert.deepEqual(second.snapshot(), expected);
  assert.deepEqual(f.open().snapshot(), expected);
  assert.equal(first.get(PRIMARY_ACCOUNT), null);
  assert.equal(first.get("C"), null);
});

test("clear removes only the requested account and persists removal", t => {
  const f = fixture(t);
  const store = f.open();
  const stale = f.open();
  store.record("alpha", pending());
  store.record("beta", pending(NOW + 120_000));
  store.record(PRIMARY_ACCOUNT, pending(NOW + 1));
  assert.equal(stale.clear("alpha"), true);
  assert.equal(store.clear("alpha"), false);
  assert.equal(f.open().get("alpha"), null);
  assert.deepEqual(store.get("beta"), pending(NOW + 120_000));
  f.setTime(NOW + 1);
  assert.equal(stale.clear(PRIMARY_ACCOUNT), true);
  assert.deepEqual(f.open().snapshot(), { beta: pending(NOW + 120_000) });
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(f.filePath)).accounts, PRIMARY_ACCOUNT), false);
});

test("inputs, returned entries and snapshots cannot mutate persistent state", t => {
  const f = fixture(t);
  const store = f.open();
  const entry = pending();
  const result = store.record("alpha", entry);
  entry.retryAt += 100;
  result.message = "Changed return value";
  const read = store.get("alpha");
  read.retryAt = NOW;
  const snapshot = store.snapshot();
  snapshot.alpha.message = "Changed snapshot";
  snapshot.beta = pending();
  assert.deepEqual(store.snapshot(), { alpha: pending() });
  assert.deepEqual(f.open().get("alpha"), pending());
});

test("normal account names preserve casing and punctuation without fanout", t => {
  const f = fixture(t);
  const store = f.open();
  const names = ["alpha", "Alpha", "a-b_1", "0", "_", "-", "prototype", ...Object.getOwnPropertyNames(Object.prototype)];
  const prototypeKeys = Reflect.ownKeys(Object.prototype);
  for (const name of names) store.record(name, pending(NOW + 1, name));
  assert.deepEqual(Object.keys(f.open().snapshot()), Object.keys(Object.fromEntries(names.map(name => [name, true]))));
  for (const name of names) assert.deepEqual(store.get(name), pending(NOW + 1, name));
  assert.deepEqual(Reflect.ownKeys(Object.prototype), prototypeKeys);
  assert.equal({}.polluted, undefined);
});

test("account APIs reject invalid names without writing", t => {
  const f = fixture(t);
  const store = f.open();
  store.record("alpha", pending());
  const before = fs.readFileSync(f.filePath);
  const names = ["", "@other", "a.b", "../alpha", "a b", "a/b", "alpha\n", "alpha\r", "alpha\u2028", "한글", null, 1, {}];
  const prototypeKeys = Reflect.ownKeys(Object.prototype);
  for (const name of names) {
    assert.throws(() => store.get(name), /Invalid account cooldown name/);
    assert.throws(() => store.record(name, pending()), /Invalid account cooldown name/);
    assert.throws(() => store.clear(name), /Invalid account cooldown name/);
  }
  assert.deepEqual(Reflect.ownKeys(Object.prototype), prototypeKeys);
  assert.deepEqual(fs.readFileSync(f.filePath), before);
});

test("record requires future absolute timestamps and bounded scalar messages", t => {
  const f = fixture(t);
  const store = f.open();
  store.record("alpha", pending());
  const before = fs.readFileSync(f.filePath);
  const invalid = [
    null, [], {}, { retryAt: NOW + 1 }, { message: "Wait" },
    ...[NOW, NOW - 1, 60_000, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, "1791590400001", new Date(NOW + 1)]
      .map(retryAt => ({ retryAt, message: "Wait" })),
    ...[undefined, null, 0, {}, "", "x".repeat(2049), "가".repeat(683)].map(message => ({ retryAt: NOW + 1, message })),
    { ...pending(), cookies: [] }, { ...pending(), tokens: "synthetic" },
    { ...pending(), selectedAccount: "alpha" },
    { ...pending(), [Symbol("extra")]: true },
    Object.create(pending()),
    Object.assign(Object.create({ tokens: "synthetic" }), pending()),
    Object.defineProperty({ retryAt: NOW + 1 }, "message", { enumerable: true, get() { assert.fail("message getter must not run"); } }),
    Object.defineProperty({ message: "Wait" }, "retryAt", { enumerable: true, get() { assert.fail("timestamp getter must not run"); } }),
    Object.defineProperty({ retryAt: NOW + 1 }, "message", { value: "Wait" }),
    JSON.parse('{"retryAt":1791590400001,"message":"Wait","__proto__":{"polluted":true}}'),
  ];
  for (const entry of invalid) assert.throws(() => store.record("beta", entry), /Invalid account cooldown metadata/);
  assert.deepEqual(fs.readFileSync(f.filePath), before);
  assert.equal(store.get("beta"), null);
  assert.deepEqual(store.record("beta", pending(NOW + 1, "x".repeat(2048))), pending(NOW + 1, "x".repeat(2048)));
  assert.deepEqual(store.record(PRIMARY_ACCOUNT, pending(NOW + 1, "가".repeat(682))), pending(NOW + 1, "가".repeat(682)));
  assert.equal({}.polluted, undefined);
});

test("malformed or unexpected persisted data is preserved byte-for-byte", t => {
  const f = fixture(t);
  const store = f.open();
  const cases = [
    "", "{", "null", "[]", "{}", '{"version":1}',
    '{"version":2,"accounts":{}}', '{"version":"1","accounts":{}}',
    '{"version":1,"accounts":null}', '{"version":1,"accounts":[]}',
    '{"version":1,"accounts":{},"selectedAccount":"alpha"}',
    '{"version":1,"accounts":{},"cookies":[]}', '{"version":1,"accounts":{},"tokens":{}}',
    '{"version":1,"accounts":{},"__proto__":{"polluted":true}}',
    ...[null, [], {}, { retryAt: NOW + 1 }, { retryAt: NOW + 1, message: "Wait", cookies: [] },
      { retryAt: NOW + 1, message: "Wait", tokens: "synthetic" },
      { retryAt: NOW + 1, message: "Wait", selectedAccount: "alpha" },
      { retryAt: -1, message: "Wait" }, { retryAt: 1.5, message: "Wait" },
      { retryAt: "1791590400001", message: "Wait" }, { retryAt: null, message: "Wait" },
      { retryAt: Number.MAX_SAFE_INTEGER, message: "Wait" },
      { retryAt: NOW + 1, message: {} }, { retryAt: NOW + 1, message: "" },
      { retryAt: NOW - 1, message: "x".repeat(2049) }].map(entry => document({ alpha: entry })),
    ...["@other", "../alpha"]
      .map(name => document(Object.fromEntries([[name, pending()]]))),
    '{"version":1,"accounts":{"alpha":{"retryAt":1791590400001,"message":"Wait","__proto__":{"polluted":true}}}}',
    Buffer.concat([Buffer.from('{"version":1,"accounts":{"alpha":{"retryAt":1791590400001,"message":"'), Buffer.from([0xff]), Buffer.from('"}}}')]),
  ];
  const prototypeKeys = Reflect.ownKeys(Object.prototype);
  for (const content of cases) {
    f.write(content);
    const before = fs.readFileSync(f.filePath);
    assert.throws(() => f.open(), /corrupt; original preserved/);
    assert.throws(() => store.get("alpha"), /corrupt; original preserved/);
    assert.throws(() => store.snapshot(), /corrupt; original preserved/);
    assert.throws(() => store.record("beta", pending()), /corrupt; original preserved/);
    assert.throws(() => store.clear("alpha"), /corrupt; original preserved/);
    assert.deepEqual(fs.readFileSync(f.filePath), before);
    assert.deepEqual(fs.readdirSync(path.dirname(f.filePath)), ["cooldowns.json"]);
  }
  assert.deepEqual(Reflect.ownKeys(Object.prototype), prototypeKeys);
  assert.equal({}.polluted, undefined);
});

test("valid expired metadata loads alongside live metadata without repair writes", t => {
  const f = fixture(t);
  f.write(document({ old: pending(NOW - 1), boundary: pending(NOW), live: pending(NOW + 1) }));
  const before = fs.readFileSync(f.filePath);
  const store = f.open();
  assert.equal(store.get("old"), null);
  assert.equal(store.get("boundary"), null);
  assert.deepEqual(store.snapshot(), { live: pending(NOW + 1) });
  assert.deepEqual(fs.readFileSync(f.filePath), before);
});

test("oversized and non-regular stores cannot be overwritten", t => {
  const f = fixture(t);
  const store = f.open();
  f.write(document({}) + " ".repeat(1024 * 1024));
  const before = fs.readFileSync(f.filePath);
  assert.throws(() => f.open(), /original preserved/);
  assert.throws(() => store.record("alpha", pending()), /original preserved/);
  assert.throws(() => store.clear("alpha"), /original preserved/);
  assert.deepEqual(fs.readFileSync(f.filePath), before);
  fs.unlinkSync(f.filePath);
  fs.mkdirSync(f.filePath);
  assert.throws(() => f.open(), /original preserved/);
  assert.throws(() => store.record("alpha", pending()), /original preserved/);
  assert.equal(fs.statSync(f.filePath).isDirectory(), true);
});

test("atomic write failure preserves the previous file and cleans temporary files", t => {
  const f = fixture(t);
  const store = f.open();
  store.record("alpha", pending());
  const before = fs.readFileSync(f.filePath);
  const rename = t.mock.method(fs, "renameSync", () => {
    const error = new Error("synthetic rename failure");
    error.code = "EIO";
    throw error;
  });
  assert.throws(() => store.record("beta", pending()), /synthetic rename failure/);
  assert.throws(() => store.clear("alpha"), /synthetic rename failure/);
  assert.deepEqual(fs.readFileSync(f.filePath), before);
  assert.deepEqual(store.snapshot(), { alpha: pending() });
  assert.deepEqual(fs.readdirSync(path.dirname(f.filePath)), ["cooldowns.json"]);
  rename.mock.restore();
  store.record("beta", pending());
  assert.deepEqual(f.open().snapshot(), { alpha: pending(), beta: pending() });
});

test("store capacity failures preserve existing account metadata", t => {
  const f = fixture(t);
  const store = f.open();
  store.record("alpha", pending());
  const before = fs.readFileSync(f.filePath);
  assert.throws(() => store.record("a".repeat(1024 * 1024), pending()), /capacity exceeded; original preserved/);
  assert.deepEqual(fs.readFileSync(f.filePath), before);
  assert.deepEqual(f.open().snapshot(), { alpha: pending() });
});

test("invalid configuration or clock values cannot write metadata", t => {
  const f = fixture(t);
  for (const filePath of ["", null, 1, "bad\0path"]) assert.throws(() => new AccountCooldownStore(filePath), /file path and clock/);
  assert.throws(() => new AccountCooldownStore(f.filePath, { now: NOW }), /file path and clock/);
  for (const now of [() => NaN, () => -1, () => "1791590400000", () => 1.5, () => Number.MAX_SAFE_INTEGER]) {
    const store = new AccountCooldownStore(f.filePath, { now });
    assert.throws(() => store.get("alpha"), /clock must return/);
    assert.throws(() => store.snapshot(), /clock must return/);
    assert.throws(() => store.record("alpha", pending()), /clock must return/);
  }
  assert.equal(fs.existsSync(f.filePath), false);
});

test("the default clock accepts a future wall-clock timestamp", t => {
  const f = fixture(t);
  const store = new AccountCooldownStore(f.filePath);
  const entry = pending(Date.now() + 60_000);
  store.record(PRIMARY_ACCOUNT, entry);
  assert.deepEqual(store.get(PRIMARY_ACCOUNT), entry);
  assert.deepEqual(new AccountCooldownStore(f.filePath).snapshot(), { [PRIMARY_ACCOUNT]: entry });
});
