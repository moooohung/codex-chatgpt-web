const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { readAccountContext, readLeasedAccountContext, ACCOUNT_CONTEXT_TIMEOUT_MS } = require("../electron/account-context.cjs");
const { BrowserHost, IDLE_BROWSER_URL } = require("../electron/browser-host.cjs");

const ENDPOINT = "https://chatgpt.com/api/auth/session";
const USER_ID = "inert-user";
const ACCOUNT_ID = "inert-selected-account";
const ACCOUNT_KEY = createHash("sha256").update(`${USER_ID}\0${ACCOUNT_ID}`).digest("hex");
const context = planType => ({ accountKey: ACCOUNT_KEY, planType });
const owner = { traceId: "next-turn", helperPid: process.pid,
  conversationKey: "c".repeat(64), connectorIdentity: "inert-connector" };

function payload(planType = "plus") {
  return { user: { id: USER_ID, email: "never-export@example.test", name: "Never export" },
    account: { id: ACCOUNT_ID, planType, structure: "personal", isDelinquent: false },
    expires: new Date(Date.now() + 60_000).toISOString(),
    accessToken: "never-export-token", refreshToken: "never-export-refresh" };
}

function response(body = payload(), extra = {}) {
  return { ok: true, status: 200, url: ENDPOINT, redirected: false,
    headers: new Headers({ "content-type": "application/json; charset=utf-8" }),
    json: async () => body, ...extra };
}

function inertSession(read = () => response()) {
  const calls = [];
  const session = { async fetch(url, options) {
    assert.equal(this, session, "fetch retains the exact session receiver");
    calls.push({ url, options });
    assert.equal(url, ENDPOINT);
    assert.equal(options.method, "GET");
    assert.equal(options.credentials, "include");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.accept, "application/json");
    assert.ok(options.signal instanceof AbortSignal);
    return read(url, options);
  } };
  return { session, calls };
}

function leaseFixture({ reused = false, running = false, read = () => response(), injected } = {}) {
  const selected = inertSession(read);
  let primaryReads = 0;
  let neighbourReads = 0;
  let destroyed = false;
  const events = [];
  const forbiddenDom = () => { throw new Error("DOM inspection is forbidden"); };
  const contents = { session: selected.session, isDestroyed: () => destroyed,
    setBackgroundThrottling() {}, close() { destroyed = true; events.push("closed"); },
    getURL: forbiddenDom, executeJavaScript: forbiddenDom };
  const tab = { id: "selected-tab", surfaceId: "s".repeat(32), accountName: "selected",
    partition: "inert-selected-partition", interactionMode: "automatic", status: reused ? "ready" : "running",
    traceId: reused ? "previous-turn" : owner.traceId, helperPid: owner.helperPid,
    conversationKey: owner.conversationKey, connectorIdentity: owner.connectorIdentity,
    connectorBound: reused, bootstrapReady: reused, cachedPlan: "pro", view: { webContents: contents } };
  const neighbour = { id: "neighbour-tab", traceId: "neighbour-turn", helperPid: 123,
    status: "running", interactionMode: "automatic", conversationKey: "n".repeat(64),
    view: { webContents: { session: { fetch() { neighbourReads++; throw new Error("neighbour session used"); } } } } };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[neighbour.id, neighbour], ...(reused || running ? [[tab.id, tab]] : [])]),
    manualOperation: null, userCancelledTurnOwners: new Map(), closedTurnOwners: new Map(),
    selectedTabId: "home", visible: false,
    state: { authenticated: true }, accountStatuses: new Map([["selected", { authenticated: true, routingAuthenticated: true }]]),
    view: { webContents: { session: { fetch() { primaryReads++; throw new Error("primary session used"); } },
      getURL: () => IDLE_BROWSER_URL } },
    window: { contentView: { removeChildView() { events.push("removed"); } } },
    resolveAccountForConversation: () => "selected",
    // Account proof must not read the DOM; the separate reuse load check is covered elsewhere.
    conversationLoadState: async () => "loaded",
    createTurnTab: async () => { host.turnTabs.set(tab.id, tab); events.push("created"); return tab; },
    syncPowerSaveBlocker() {}, syncViewVisibility() { events.push("visible"); },
    presentTurnView() {}, show() {}, hide() {}, snapshot: () => ({ tabs: [] }),
    publishState() { events.push("published"); }, writeDescriptor() { events.push("descriptor"); },
    logger: { info() {}, warn() {} },
    ...(injected ? { readAccountContext: injected } : {}),
  });
  const unchangedState = structuredClone(host.state);
  const unchangedStatuses = structuredClone(host.accountStatuses);
  return { host, tab, contents, neighbour, selected, events,
    destroy: () => { destroyed = true; },
    begin: signal => host.beginTurn(owner.traceId, false, owner.helperPid,
      owner.conversationKey, owner.connectorIdentity, false, signal),
    assertUntouched() {
      assert.equal(primaryReads, 0);
      assert.equal(neighbourReads, 0);
      assert.equal(host.turnTabs.get(neighbour.id), neighbour);
      assert.equal(neighbour.status, "running");
      assert.deepEqual(host.state, unchangedState);
      assert.deepEqual(host.accountStatuses, unchangedStatuses);
    } };
}

for (const plan of ["plus", "pro", "prolite", "free"]) {
  test(`authenticated ${plan} proof contains only the hash and exact plan`, async () => {
    const f = inertSession(() => response(payload(plan)));
    const result = await readAccountContext(f.session);
    assert.deepEqual(result, context(plan));
    assert.deepEqual(Object.keys(result).sort(), ["accountKey", "planType"]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].options.signal.aborted, false);
    assert.doesNotMatch(JSON.stringify(result), /inert-user|inert-selected-account|never-export/);
  });
}

test("Electron's empty native response URL is supported only with the fixed nonredirecting endpoint", async () => {
  const f = inertSession(() => response(payload(), { url: "" }));
  assert.deepEqual(await readAccountContext(f.session), context("plus"));
  assert.equal(f.calls[0].url, ENDPOINT);
  assert.equal(f.calls[0].options.redirect, "error");
});

for (const url of ["https://example.test/api/auth/session", "http://chatgpt.com/api/auth/session",
  "https://chatgpt.com/backend-api/accounts/check", `${ENDPOINT}?x=1`, `${ENDPOINT}#x`,
  "https://user:secret@chatgpt.com/api/auth/session", "not-a-url", null]) {
  test(`wrong endpoint fails closed (${url})`, async () => {
    let parsed = false;
    await assert.rejects(readAccountContext(inertSession(() => response(payload(), {
      url, json: async () => { parsed = true; return payload(); },
    })).session), { code: "account_context_invalid_endpoint" });
    assert.equal(parsed, false);
  });
}

test("redirect, non-2xx and a misleading ok flag cannot establish proof", async () => {
  for (const status of [0, 199, 301, 401, 403, 429, 500]) {
    await assert.rejects(readAccountContext(inertSession(() => response(payload(), { status })).session),
      { code: "account_context_http_error" });
  }
  await assert.rejects(readAccountContext(inertSession(() => response(payload(), { ok: false })).session),
    { code: "account_context_http_error" });
  await assert.rejects(readAccountContext(inertSession(() => response(payload(), { redirected: true })).session),
    { code: "account_context_invalid_endpoint" });
});

test("HTML and malformed JSON fail without exposing the response or upstream errors", async () => {
  await assert.rejects(readAccountContext(inertSession(() => response(payload(), {
    headers: new Headers({ "content-type": "text/html" }),
  })).session), { code: "account_context_invalid_response" });
  for (const read of [() => { throw new Error("never-export-token"); },
    () => response(payload(), { json: async () => { throw new Error("never-export-token"); } })]) {
    const error = await readAccountContext(inertSession(read).session).catch(error => error);
    assert.match(error.code, /^account_context_(fetch_failed|invalid_json)$/);
    assert.doesNotMatch(error.message, /never-export/);
    assert.equal(error.cause, undefined);
  }
});

const invalidPayloads = [
  ["null session", () => null, "invalid_session"],
  ["array session", () => [], "invalid_session"],
  ["array user", p => ({ ...p, user: [] }), "invalid_session"],
  ["array account", p => ({ ...p, account: [] }), "invalid_session"],
  ["session error", p => ({ ...p, error: "never-export-session-error" }), "session_error"],
  ["session errors", p => ({ ...p, errors: ["never-export-session-error"] }), "session_error"],
  ["missing expiry", p => ({ ...p, expires: undefined }), "invalid_expiry"],
  ["invalid expiry", p => ({ ...p, expires: "bad-date" }), "invalid_expiry"],
  ["expired session", p => ({ ...p, expires: new Date(Date.now() - 1).toISOString() }), "expired"],
  ["missing user id", p => ({ ...p, user: {} }), "invalid_identity"],
  ["missing account id", p => ({ ...p, account: { ...p.account, id: undefined } }), "invalid_identity"],
  ["NUL identity", p => ({ ...p, user: { id: "inert\0user" } }), "invalid_identity"],
  ["unbounded identity", p => ({ ...p, user: { id: "u".repeat(257) } }), "invalid_identity"],
  ["blank identity", p => ({ ...p, user: { id: " " } }), "invalid_identity"],
  ["workspace account", p => ({ ...p, account: { ...p.account, structure: "business" } }), "unsupported_structure"],
  ["missing structure", p => ({ ...p, account: { ...p.account, structure: undefined } }), "unsupported_structure"],
  ["delinquent account", p => ({ ...p, account: { ...p.account, isDelinquent: true } }), "delinquent"],
  ["missing delinquency", p => ({ ...p, account: { ...p.account, isDelinquent: undefined } }), "invalid_delinquency"],
  ["invalid delinquency", p => ({ ...p, account: { ...p.account, isDelinquent: "false" } }), "invalid_delinquency"],
  ["missing plan", p => ({ ...p, account: { ...p.account, planType: undefined } }), "missing_plan"],
  ["empty plan", p => ({ ...p, account: { ...p.account, planType: "" } }), "missing_plan"],
  ["unknown plan", p => ({ ...p, account: { ...p.account, planType: "team" } }), "unsupported_plan"],
  ["malformed plan", p => ({ ...p, account: { ...p.account, planType: [] } }), "unsupported_plan"],
];
for (const [name, change, code] of invalidPayloads) {
  test(`${name} fails closed with a precise sanitized error`, async () => {
    const error = await readAccountContext(inertSession(() => response(change(payload()))).session).catch(error => error);
    assert.equal(error.code, `account_context_${code}`);
    assert.doesNotMatch(error.message, /inert-user|inert-selected-account|never-export/);
  });
}

test("proof times out and aborts at five seconds even when fetch ignores abort", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = inertSession(() => new Promise(() => {}));
  const pending = readAccountContext(f.session);
  const rejected = assert.rejects(pending, { code: "account_context_timeout" });
  assert.equal(ACCOUNT_CONTEXT_TIMEOUT_MS, 5_000);
  t.mock.timers.tick(4_999);
  assert.equal(f.calls[0].options.signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(f.calls[0].options.signal.aborted, true);
});

test("five second bound also covers a stalled response body", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reading = false;
  const f = inertSession(() => response(payload(), { json: async () => {
    reading = true;
    return new Promise(() => {});
  } }));
  const pending = readAccountContext(f.session);
  const rejected = assert.rejects(pending, { code: "account_context_timeout" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(reading, true);
  t.mock.timers.tick(5_000);
  await rejected;
  assert.equal(f.calls[0].options.signal.aborted, true);
});

test("external abort stops proof even if fetch ignores the signal, without exporting its reason", async () => {
  const controller = new AbortController();
  const f = inertSession(() => new Promise(() => {}));
  const pending = readAccountContext(f.session, { signal: controller.signal });
  controller.abort(new Error("never-export-abort-reason"));
  await assert.rejects(pending, error => error.code === "account_context_aborted"
    && !error.message.includes("never-export"));
  assert.equal(f.calls[0].options.signal.aborted, true);
  await assert.rejects(readAccountContext(f.session, { signal: controller.signal }), { code: "account_context_aborted" });
  assert.equal(f.calls.length, 1, "preaborted proof never starts a request");
});

for (const reused of [false, true]) {
  test(`${reused ? "reused" : "fresh"} automatic lease proves only the exact session before returning`, async () => {
    let finish;
    const f = leaseFixture({ reused, read: () => new Promise(resolve => { finish = resolve; }) });
    const pending = f.begin();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.selected.calls.length, 1);
    assert.equal(f.events.includes("published"), false, "lease cannot be acknowledged before proof");
    finish(response());
    const lease = await pending;
    assert.deepEqual(lease, { surfaceId: f.tab.surfaceId, tabId: f.tab.id,
      reused, connectorBound: reused, accountContext: context("plus") });
    assert.equal(f.tab.accountContext, undefined, "proof is not cached on the tab");
    f.assertUntouched();
  });

  test(`${reused ? "reused" : "fresh"} proof failure releases only the leased tab through normal removal`, async () => {
    const f = leaseFixture({ reused, read: () => response(payload("unknown")) });
    await assert.rejects(f.begin(), { code: "account_context_unsupported_plan" });
    assert.equal(f.host.turnTabs.has(f.tab.id), false);
    assert.equal(f.contents.isDestroyed(), true);
    assert.equal(f.host.closedTurnOwners.get(owner.traceId), owner.helperPid);
    assert.ok(f.events.includes("removed"));
    f.assertUntouched();
  });
}

test("a running lease repeat refetches the exact session and never trusts a cached plan", async () => {
  let plan = "pro";
  const f = leaseFixture({ running: true, read: () => response(payload(plan)) });
  assert.deepEqual((await f.begin()).accountContext, context("pro"));
  plan = "free";
  assert.deepEqual((await f.begin()).accountContext, context("free"));
  assert.equal(f.selected.calls.length, 2);
  f.assertUntouched();
});

test("missing production session.fetch fails closed, while fixtures can explicitly inject evidence", async () => {
  const missing = leaseFixture();
  missing.contents.session = {};
  await assert.rejects(missing.begin(), { code: "account_context_session_unavailable" });
  assert.equal(missing.host.turnTabs.has(missing.tab.id), false);
  const injected = leaseFixture({ injected: async (session, { signal }) => {
    assert.equal(session, injected.contents.session);
    assert.equal(signal, undefined);
    return context("plus");
  } });
  injected.contents.session = {};
  assert.deepEqual((await injected.begin()).accountContext, context("plus"));
  assert.equal(injected.selected.calls.length, 0);
  injected.assertUntouched();
});

test("injected missing/malformed/raw evidence is also rejected and released", async () => {
  for (const proof of [undefined, {}, { ...context("plus"), token: "never-export-token" },
    { accountKey: "raw-identity", planType: "plus" }, context("unknown")]) {
    const f = leaseFixture({ injected: async () => proof });
    await assert.rejects(f.begin(), { code: "account_context_invalid_proof" });
    assert.equal(f.host.turnTabs.has(f.tab.id), false);
    f.assertUntouched();
  }
});

test("tab release failure preserves the precise proof error and never includes cleanup raw data", async () => {
  const f = leaseFixture({ read: () => response(payload("unknown")) });
  f.host.removeTurnTab = () => { throw new Error("never-export-cleanup-error"); };
  await assert.rejects(f.begin(), error => error.code === "account_context_unsupported_plan"
    && error.tabReleaseFailed === true && !error.message.includes("never-export"));
  f.assertUntouched();
});

test("ownership is checked before proof and rejects manual, primary, foreign and dead tabs", async () => {
  for (const change of [f => { f.tab.interactionMode = "manual"; },
    f => { f.tab.helperPid++; }, f => { f.tab.traceId = "different"; },
    f => { f.tab.conversationKey = "different"; }, f => { f.tab.connectorIdentity = "different"; },
    f => { f.tab.view = f.host.view; }, f => { f.host.turnTabs.delete(f.tab.id); },
    f => { f.destroy(); }]) {
    const f = leaseFixture({ running: true });
    change(f);
    await assert.rejects(readLeasedAccountContext(f.host, f.tab, owner), { code: "account_context_lease_lost" });
    assert.equal(f.selected.calls.length, 0);
    f.assertUntouched();
  }
});

test("postawait ownership checks reject cancellation, destruction, changed metadata and session", async () => {
  for (const change of [f => { f.host.userCancelledTurnOwners.set(owner.traceId, owner.helperPid); },
    f => { f.destroy(); }, f => { f.tab.surfaceId = "changed"; },
    f => { f.tab.partition = "changed"; }, f => { f.tab.accountName = "changed"; },
    f => { f.contents.session = {}; }]) {
    let finish;
    const f = leaseFixture({ read: () => new Promise(resolve => { finish = resolve; }) });
    const pending = f.begin();
    await Promise.resolve();
    change(f);
    finish(response());
    await assert.rejects(pending, { code: "account_context_lease_lost" });
    assert.equal(f.host.turnTabs.has(f.tab.id), false);
    f.assertUntouched();
  }
});

test("postawait failure never removes a replacement tab, transferred lease, or replacement view", async () => {
  for (const change of [f => { f.host.turnTabs.set(f.tab.id, { ...f.tab }); },
    f => { f.tab.helperPid++; }, f => { f.tab.traceId = "transferred"; },
    f => { f.tab.view = f.neighbour.view; }]) {
    let finish;
    const f = leaseFixture({ read: () => new Promise(resolve => { finish = resolve; }) });
    const pending = f.begin();
    await Promise.resolve();
    change(f);
    const replacement = f.host.turnTabs.get(f.tab.id);
    finish(response());
    await assert.rejects(pending, { code: "account_context_lease_lost" });
    assert.equal(f.host.turnTabs.get(f.tab.id), replacement);
    assert.equal(f.events.includes("removed"), false);
    f.assertUntouched();
  }
});

test("abort during an automatic proof releases the tab without using other sessions", async () => {
  const controller = new AbortController();
  const f = leaseFixture({ read: () => new Promise(() => {}) });
  const pending = f.begin(controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { code: "account_context_aborted" });
  assert.equal(f.host.turnTabs.has(f.tab.id), false);
  f.assertUntouched();
});

// Exercise the actual client function with an inert fetch and descriptor reader. Strip
// types in memory only; loading the full runtime would pull unrelated worker changes in.
function loadNotifyLauncherTurn(fetchResponse) {
  const ts = require("../../node_modules/typescript");
  const source = fs.readFileSync(path.join(__dirname, "../../src/launcher-browser-host.ts"), "utf8");
  const start = source.indexOf("export async function notifyLauncherTurn(");
  const end = source.indexOf("\nexport ", start + 1);
  const compiled = ts.transpileModule(source.slice(start, end === -1 ? undefined : end), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText;
  const sandbox = { exports: {}, AbortController, AbortSignal, DOMException, setTimeout, clearTimeout,
    LAUNCHER_TURN_START_TIMEOUT_MS: 1_000, LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS: 1_000, LAUNCHER_TURN_END_TIMEOUT_MS: 1_000,
    readLauncherBrowserHostDescriptor: () => ({ control: { endpoint: "http://inert.test", token: "inert" } }),
    fetch: async (url, options) => {
      assert.equal(url, "http://inert.test/v1/turn/start");
      assert.equal(JSON.parse(options.body).phase, "start");
      return { ok: true, json: async () => fetchResponse };
    },
    LauncherBrowserTurnCancelledError: class extends Error {},
    LauncherRetainedConversationUnavailableError: class extends Error {},
    LauncherBrowserTurnOwnerLostError: class extends Error {},
    ChatGptWebAdapterError: class extends Error {},
  };
  vm.runInNewContext(compiled, sandbox);
  return sandbox.exports.notifyLauncherTurn;
}

test("notifyLauncherTurn start validates and carries the optional account proof without raw data", async () => {
  const lease = { surfaceId: "s".repeat(32), reused: false, connectorBound: false };
  for (const plan of ["plus", "pro", "prolite", "free"]) {
    const result = await loadNotifyLauncherTurn({ ...lease, accountContext: context(plan), ignoredToken: "never-export" })
      ("inert-descriptor", { phase: "start", ...owner });
    assert.equal(JSON.stringify(result.accountContext), JSON.stringify(context(plan)));
    assert.doesNotMatch(JSON.stringify(result), /never-export/);
  }
  const withoutProof = await loadNotifyLauncherTurn(lease)("inert-descriptor", { phase: "start", ...owner });
  assert.equal(withoutProof.accountContext, undefined, "client optional compatibility remains intact");
  for (const proof of [null, [], {}, context("unknown"), { ...context("plus"), userId: USER_ID },
    { accountKey: "raw-user", planType: "plus" }, { accountKey: ACCOUNT_KEY, planType: { toString: () => "plus" } }]) {
    await assert.rejects(loadNotifyLauncherTurn({ ...lease, accountContext: proof })
      ("inert-descriptor", { phase: "start", ...owner }), /invalid account plan evidence/);
  }
});
