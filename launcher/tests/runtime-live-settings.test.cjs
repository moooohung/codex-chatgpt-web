const test = require("node:test");
const assert = require("node:assert/strict");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

function fixture() {
  let config = { autoApproveToolCalls: false };
  const actions = [];
  const supervisor = Object.assign(Object.create(RuntimeSupervisor.prototype), {
    stopping: false, stopPromise: null, startPromise: null, shutdownIntents: new WeakSet(),
    daemon: { pid: process.pid }, logger: { info() {} }, readConfig: () => config,
    proxyHealth: async () => true,
    async control(_config, action, options) {
      actions.push(action);
      assert.deepEqual(options.body, { enabled: true, expectedValue: false, expectedPid: process.pid });
      config = { ...config, autoApproveToolCalls: true };
      return { status: "ok", pid: process.pid, autoApproveToolCalls: true, applies_to: "new_turns" };
    },
  });
  return { supervisor, actions };
}

test("live preference setter verifies owned daemon and persisted acknowledgement without lifecycle operations", async () => {
  const { supervisor, actions } = fixture();
  assert.deepEqual(await supervisor.setAutoApproveToolCalls(true), { enabled: true, appliesTo: "new_turns" });
  assert.deepEqual(actions, ["tool-approvals"]);
});

test("live preference setter rejects lifecycle changes, doomed children and missing health before sending", async () => {
  for (const change of [
    s => { s.stopping = true; }, s => { s.startPromise = Promise.resolve(); },
    s => { s.stopPromise = Promise.resolve(); }, s => { s.daemon = null; },
    s => { s.shutdownIntents.add(s.daemon); }, s => { s.proxyHealth = async () => false; },
  ]) {
    const { supervisor, actions } = fixture();
    change(supervisor);
    await assert.rejects(supervisor.setAutoApproveToolCalls(true), /Runtime is changing|healthy launcher-owned/);
    assert.deepEqual(actions, []);
  }
});

test("live preference setter never falls back to restarting after transport or acknowledgement failure", async () => {
  for (const result of [null, { status: "ok", pid: process.pid + 1, autoApproveToolCalls: true, applies_to: "new_turns" },
    { status: "ok", pid: process.pid, autoApproveToolCalls: false, applies_to: "new_turns" },
    { status: "ok", pid: process.pid, autoApproveToolCalls: true, applies_to: "new_turns" }]) {
    const { supervisor, actions } = fixture();
    supervisor.control = async (_config, action) => {
      actions.push(action);
      if (result === null) throw new Error("synthetic transport failure");
      return result;
    };
    await assert.rejects(supervisor.setAutoApproveToolCalls(true), /transport failure|did not confirm/);
    assert.deepEqual(actions, ["tool-approvals"]);
  }
});
