const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createStateStore } = require("../electron/state.cjs");
const { EFFORT_RECHECK_MS, observeEffortCeiling, effortRecheckDue } = require("../electron/effort-ceiling.cjs");
const { BrowserControlServer } = require("../electron/control-server.cjs");

const restricted = { family: "5.6", requestedPosition: 3, actualPosition: 2, available: [true, true] };
test("ceiling survives restart, remains account/model scoped, and restores on a wider picker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "effort-ceiling-"));
  const file = path.join(root, "launcher-state.json");
  try {
    let store = createStateStore(file);
    assert.equal(observeEffortCeiling(store, "a", restricted, 1000).event.event, "effort_clamped");
    observeEffortCeiling(store, "b", { ...restricted, family: "6" }, 1000);
    store = createStateStore(file);
    assert.equal(store.read().effortCeilings.length, 2);
    const persisted = store.read().effortCeilings[0];
    assert.equal(persisted.observedAt, 1000);
    assert.equal(effortRecheckDue(persisted, 1000 + EFFORT_RECHECK_MS - 1), false);
    assert.equal(effortRecheckDue(persisted, 1000 + EFFORT_RECHECK_MS), true);
    const repeated = observeEffortCeiling(store, "a", restricted, 1000 + EFFORT_RECHECK_MS);
    assert.equal(repeated.ceiling.observedAt, 1000);
    assert.equal(repeated.event, undefined);
    const restored = observeEffortCeiling(store, "a", { ...restricted, actualPosition: 3, available: [true, true, true] }, 602000);
    assert.deepEqual(restored.event, { event: "effort_restored", account: "a", family: "5.6", requestedPosition: 3, actualPosition: 3 });
    assert.equal(createStateStore(file).read().effortCeilings.length, 1);
    assert.equal(createStateStore(file).read().effortCeilings[0].account, "b");
    assert.deepEqual(Object.keys(persisted).sort(), ["account", "actualPosition", "family", "lastCheckedAt", "observedAt", "requestedPosition"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("lower multipart requests do not forget the ceiling, and unlocked ticks restore it", () => {
  let state = {};
  const store = { read: () => state, update: patch => { state = { ...state, ...patch }; } };
  observeEffortCeiling(store, "a", restricted, 1000);
  observeEffortCeiling(store, "a", { ...restricted, requestedPosition: 1, actualPosition: 1 }, 2000);
  assert.equal(state.effortCeilings[0].requestedPosition, 3);
  assert.equal(observeEffortCeiling(store, "a", { ...restricted, requestedPosition: 1, actualPosition: 1,
    available: [true, true, true] }, 3000).event.event, "effort_restored");
});
test("widening between selection and confirmation restores without persisting a false ceiling", () => {
  let state = {};
  const store = { read: () => state, update: patch => { state = { ...state, ...patch }; } };
  observeEffortCeiling(store, "a", restricted, 1000);
  const restored = observeEffortCeiling(store, "a", { ...restricted, available: [true, true, true] }, 2000);
  assert.equal(restored.event.event, "effort_restored");
  assert.equal(restored.ceiling, null);
  assert.deepEqual(state.effortCeilings, []);
});
test("effort control channel rejects a foreign helper and persists only the leased account", async () => {
  let state = {};
  const logs = [], notices = [];
  const store = { read: () => state, update: patch => { state = { ...state, ...patch }; } };
  const tab = { traceId: "effort-fixture", helperPid: process.pid, status: "running", accountName: "a" };
  const host = { browserInteractionMode: () => "automatic", turnTabs: new Map([["a", tab]]) };
  const server = await new BrowserControlServer({ logger: { info: (...args) => logs.push(args), warn() {}, error() {} },
    getBrowserHost: () => host, getPreferences: () => ({}), stateStore: store, publishState: s => notices.push(s) }).start();
  const { endpoint, token } = server.descriptor();
  const send = body => fetch(`${endpoint}/v1/turn/effort`, { method: "POST", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ traceId: tab.traceId, helperPid: tab.helperPid, ...restricted, ...body }) });
  try {
    assert.equal((await send({ helperPid: process.pid + 1 })).status, 400);
    assert.equal((await send({})).status, 200);
    assert.equal(state.effortCeilings[0].account, "a");
    assert.equal(notices.length, 1);
    assert.equal(logs.filter(v => v[0] === "effort_clamped").length, 1);
    assert.equal((await send({ actualPosition: 3, available: [true, true, true] })).status, 200);
    assert.equal(state.effortCeilings.length, 0);
    assert.equal(logs.filter(v => v[0] === "effort_restored").length, 1);
  } finally { await server.close(); }
});
