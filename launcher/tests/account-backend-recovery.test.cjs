const test = require("node:test");
const assert = require("node:assert/strict");
const { bindAccountBackendRecovery, handleAccountBackendResponse } = require("../electron/account-backend-recovery.cjs");
const { selectAccount } = require("../electron/account-policy.cjs");

function fixture() {
  const calls = [];
  const tab = { id: "login", accountName: "first", isSignInTab: true, status: "ready",
    view: { webContents: { id: 42, isDestroyed: () => false, getURL: () => "https://chatgpt.com/?temporary-chat=true" } } };
  const host = { turnTabs: new Map([[tab.id, tab]]), accountStatuses: new Map(), cloudflareChallengeRecoveryDelayMs: 0,
    logger: { warn: (event, detail) => calls.push({ event, detail }) }, snapshot: () => ({}),
    loadAccountSignInSurface: async (_contents, url) => calls.push({ reload: url }), publishState() {} };
  const challenge = { webContentsId: 42, url: "https://chatgpt.com/backend-api/models", statusCode: 403,
    responseHeaders: { "Cf-Mitigated": ["challenge"] } };
  return { host, tab, calls, challenge };
}

test("each account session binds once and challenges affect only the owning account", async () => {
  const { host, tab, calls, challenge } = fixture();
  let binds = 0, handler;
  const session = { webRequest: { onCompleted: (_filter, callback) => { binds++; handler = callback; } } };
  bindAccountBackendRecovery(host, session); bindAccountBackendRecovery(host, session); assert.equal(binds, 1);
  for (const change of [{ webContentsId: 99 }, { url: "https://other.example/backend-api/models" }, { responseHeaders: {} }]) {
    handler({ ...challenge, ...change });
  }
  assert.equal(calls.length, 0);
  handler(challenge); handler(challenge); await tab.challengeRecovery;
  assert.equal(calls.filter(c => c.reload).length, 1);
  assert.equal(tab.status, "error");
  assert.equal(host.accountStatuses.get("first").securityCheckRequired, true);
  assert.equal(selectAccount({ pool: ["first", "second"], statuses: host.accountStatuses }), "second");
  assert.throws(() => selectAccount({ pool: ["first"], statuses: host.accountStatuses }), /security check required/);
  handler({ ...challenge, statusCode: 200, responseHeaders: { "content-type": ["application/json"] } });
  assert.equal(tab.securityCheckRequired, true); // unrelated backend success cannot clear it
  handler({ ...challenge, url: "https://chatgpt.com/api/auth/session", statusCode: 200,
    responseHeaders: { "Content-Type": ["application/json; charset=utf-8"] } });
  assert.equal(tab.securityCheckRequired, false); assert.equal(tab.status, "ready");
  handler(challenge); await tab.challengeRecovery;
  assert.equal(calls.filter(c => c.reload).length, 1); // no endless refresh cycle
  assert.equal(tab.status, "error");
});

test("running work and retained chats are never refreshed for a security challenge", async () => {
  for (const scenario of ["running", "retained", "other-running", "closed", "new-work", "foreign-url"]) {
    const { host, tab, calls, challenge } = fixture();
    if (scenario === "running") tab.status = "running";
    if (scenario === "retained") tab.isSignInTab = false;
    if (scenario === "other-running") host.turnTabs.set("work", { ...tab, id: "work", status: "running" });
    if (scenario === "foreign-url") tab.view.webContents.getURL = () => "https://chatgpt.com/c/retained";
    handleAccountBackendResponse(host, challenge);
    if (scenario === "closed") host.turnTabs.delete(tab.id);
    if (scenario === "new-work") tab.status = "running";
    await tab.challengeRecovery;
    assert.equal(calls.filter(c => c.reload).length, 0, scenario);
    if (scenario === "running" || scenario === "new-work") assert.equal(tab.status, "running");
  }
});

test("a failed sign-in refresh is reported without deleting the account or its browser", async () => {
  const { host, tab, challenge } = fixture();
  host.loadAccountSignInSurface = async () => { throw Error("load failed"); };
  handleAccountBackendResponse(host, challenge); await tab.challengeRecovery;
  assert.equal(tab.status, "error"); assert.equal(tab.loading, false);
  assert.equal(host.turnTabs.get(tab.id), tab);
});
