const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startAccountPasskeyLogin } = require("../electron/account-passkey-login.cjs");
const { BrowserHost } = require("../electron/browser-host.cjs");

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-chrome-login-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("account-chrome-login-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const config = path.join(root, "accounts.json");
  const accounts = { alpha: { email: "alpha@example.test", enabled: true }, beta: { email: "beta@example.test", enabled: true } };
  const save = () => fs.writeFileSync(config, JSON.stringify({ accounts }));
  save();
  const sessions = new Map();
  function makeSession(name) {
    const state = { name, cleared: 0, flushed: 0, cookiesSet: [], email: "alpha@example.test", failSet: false };
    return Object.assign(state, {
      cookies: { set: async cookie => {
        if (state.failSet) throw new Error("synthetic cookie import failure");
        state.cookiesSet.push(cookie);
      }, flushStore: async () => { state.flushed++; } },
      clearStorageData: async () => { state.cleared++; },
      flushStorageData() {},
      fetch: async (url, options) => {
        assert.equal(url, "https://chatgpt.com/api/auth/session");
        assert.equal(options.redirect, "error");
        assert.equal(options.credentials, "include");
        return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ user: { id: "synthetic", email: state.email }, expires: new Date(Date.now() + 60_000).toISOString() }) };
      },
    });
  }
  const sessionApi = { fromPartition(name) {
    if (!sessions.has(name)) sessions.set(name, makeSession(name));
    return sessions.get(name);
  } };
  const primary = sessionApi.fromPartition("persist:primary");
  const target = sessionApi.fromPartition("persist:account-alpha");
  const neighbor = sessionApi.fromPartition("persist:account-beta");
  let destroyed = false;
  let composerReady = true;
  const navigated = [];
  const scripts = [];
  const contents = { session: target, isDestroyed: () => destroyed,
    loadURL: async url => { navigated.push(url); },
    executeJavaScript: async script => { scripts.push(script); return composerReady; } };
  const tab = { id: "alpha-login", isSignInTab: true, accountName: "alpha", status: "ready", view: { webContents: contents } };
  const betaTab = { id: "beta-running", accountName: "beta", status: "running", traceId: "untouched-beta", view: { webContents: { session: neighbor } } };
  const phases = [];
  let captured = 0;
  let cleaned = 0;
  const transfer = { storageState: {
    cookies: [{ name: "__Secure-next-auth.session-token", value: "synthetic-cookie-only", domain: ".chatgpt.com", path: "/",
      secure: true, httpOnly: true, sameSite: "Lax", expires: Date.now() / 1000 + 60 }],
    origins: [{ origin: "https://chatgpt.com", localStorage: [{ name: "synthetic-preference", value: "<safe>" }] }],
  }, cleanup: async () => { cleaned++; } };
  const host = {
    accountPool: ["alpha", "beta"], accountConfigPresent: true, accountPaths: { config, partition: name => `persist:account-${name}` },
    accountStatuses: new Map([["alpha", { authenticated: false }], ["beta", { authenticated: true, routingAuthenticated: true }]]),
    turnTabs: new Map([[tab.id, tab], [betaTab.id, betaTab]]), view: { webContents: { session: primary } },
    state: { authenticated: true, status: "ready" }, ready: async () => {},
    requireAutomaticBrowserInspection() {}, isAccountBusy(name) { return BrowserHost.prototype.isAccountBusy.call(this, name); },
    openAccountLoginTab(name) { assert.equal(name, "alpha"); return tab; },
    setState(patch) { phases.push({ ...patch }); Object.assign(this.state, patch); },
    loginWithPasskey: async progress => { captured++; progress("waiting"); return transfer; },
    snapshot() { return { ...this.state }; }, selectTab(id) { assert.equal(id, tab.id); }, show() {},
    removeTurnTab(tab) { this.turnTabs.delete(tab.id); }, writeDescriptor() {}, logger: { info() {} },
    ...overrides,
  };
  const options = { idleUrl: "about:blank#owned", composerSelector: "#prompt-textarea", readyTimeoutMs: 20 };
  return { root, config, accounts, save, host, tab, betaTab, primary, target, neighbor, sessionApi, sessions, phases, transfer, options, scripts, navigated,
    captured: () => captured, cleaned: () => cleaned, close: () => { destroyed = true; }, noComposer: () => { composerReady = false; },
    start: () => startAccountPasskeyLogin(host, "alpha", sessionApi, options) };
}

test("additional-account Chrome login succeeds while primary is signed in and a neighbor turn runs", async t => {
  const f = fixture(t);
  const neighborBefore = structuredClone(f.host.accountStatuses.get("beta"));
  const result = await f.start();
  assert.equal(result.authenticated, true);
  assert.equal(result.passkeyPhase, null);
  assert.equal(f.host.state.passkeyPhase, null);
  assert.equal(f.host.state.passkeyAccount, null);
  assert.equal(f.host.accountPasskeyLogin, null);
  assert.equal(f.host.isAccountBusy("alpha"), false);
  assert.equal(f.host.accountStatuses.get("alpha").routingAuthenticated, true);
  assert.deepEqual(f.host.accountStatuses.get("beta"), neighborBefore);
  assert.equal(f.betaTab.status, "running");
  assert.equal(f.primary.cleared + f.neighbor.cleared, 0);
  assert.equal(f.primary.cookiesSet.length + f.neighbor.cookiesSet.length, 0);
  assert.equal(f.target.cleared, 1);
  assert.equal(f.target.cookiesSet.length, 1);
  assert.ok(f.scripts.some(script => script.includes("\\u003csafe>")));
  assert.equal(f.captured(), 1);
  assert.equal(f.cleaned(), 1);
  const preflight = [...f.sessions.values()].find(s => s.name.startsWith("codex-web-gpt-login-check-"));
  assert.equal(preflight.cleared, 1);
  assert.ok(!preflight.name.startsWith("persist:"));
});

test("a duplicate target click joins one capture; another target is rejected and routing reserves only this account", async t => {
  const f = fixture(t);
  let release;
  f.host.loginWithPasskey = () => new Promise(resolve => { release = () => resolve(f.transfer); });
  const first = f.start();
  assert.equal(f.start(), first);
  assert.throws(() => startAccountPasskeyLogin(f.host, "beta", f.sessionApi, f.options), /current account/);
  assert.equal(f.host.isAccountBusy("alpha"), true);
  f.host.accountStatuses.get("alpha").authenticated = true;
  f.host.browserInteractionMode = () => "automatic";
  assert.equal(BrowserHost.prototype.resolveAccountForConversation.call(f.host, "alpha-preferred"), "beta");
  await new Promise(resolve => setImmediate(resolve));
  release();
  await first;
});

test("wrong Chrome identity is rejected before modifying the selected partition", async t => {
  const f = fixture(t);
  const fromPartition = f.sessionApi.fromPartition;
  f.sessionApi.fromPartition = name => {
    const s = fromPartition(name);
    if (!name.startsWith("persist:")) s.email = "wrong@example.test";
    return s;
  };
  await assert.rejects(f.start(), /does not match/);
  assert.equal(f.target.cleared, 0);
  assert.equal(f.target.cookiesSet.length, 0);
  assert.equal(f.cleaned(), 1);
  assert.equal(f.host.accountPasskeyLogin, null);
});

test("account identity drift during Chrome authentication leaves existing storage untouched", async t => {
  const f = fixture(t);
  f.host.loginWithPasskey = async () => { f.accounts.alpha.email = "changed@example.test"; f.save(); return f.transfer; };
  await assert.rejects(f.start(), /account.*changed/);
  assert.equal(f.target.cleared, 0);
  assert.equal(f.cleaned(), 1);
});

test("a closed sign-in tab is rejected before selected-account storage changes", async t => {
  const f = fixture(t);
  f.host.loginWithPasskey = async () => { f.close(); return f.transfer; };
  await assert.rejects(f.start(), /tab was closed/);
  assert.equal(f.target.cleared, 0);
  assert.equal(f.cleaned(), 1);
});

test("an invalid transfer is removed without importing it", async t => {
  const f = fixture(t);
  f.transfer.storageState.cookies = [];
  await assert.rejects(f.start(), /no ChatGPT\/OpenAI cookies/);
  assert.equal(f.target.cleared, 0);
  assert.equal(f.cleaned(), 1);
});

test("capture failure releases the reservation without affecting any browser session", async t => {
  const f = fixture(t, { loginWithPasskey: async () => { throw new Error("synthetic Chrome launch failed"); } });
  await assert.rejects(f.start(), /Chrome launch failed/);
  assert.equal(f.host.accountPasskeyLogin, null);
  assert.equal(f.host.accountLoginReservations.size, 0);
  assert.equal(f.target.cleared + f.primary.cleared + f.neighbor.cleared, 0);
});

test("a selected account's active turn prevents capture; unrelated active turns do not", t => {
  const f = fixture(t);
  f.tab.status = "running";
  assert.throws(f.start, /active turns/);
  assert.equal(f.captured(), 0);
  assert.equal(f.target.cleared, 0);
});

test("missing or pending-removal accounts cannot start Chrome authentication", t => {
  const f = fixture(t);
  f.accounts.alpha.pendingRemoval = true;
  f.save();
  assert.throws(f.start, /unavailable/);
  delete f.accounts.alpha;
  f.save();
  assert.throws(f.start, /unavailable/);
  assert.equal(f.captured(), 0);
});

test("partition aliasing to the primary account is rejected before Chrome opens", async t => {
  const f = fixture(t);
  f.target = f.primary;
  f.tab.view.webContents.session = f.primary;
  const fromPartition = f.sessionApi.fromPartition;
  f.sessionApi.fromPartition = name => name === "persist:account-alpha" ? f.primary : fromPartition(name);
  await assert.rejects(f.start(), /isolated browser partition/);
  assert.equal(f.captured(), 0);
  assert.equal(f.primary.cleared, 0);
});

test("a partial import failure discards only the selected account's session", async t => {
  const f = fixture(t);
  f.target.failSet = true;
  await assert.rejects(f.start(), /cookie import failure/);
  assert.equal(f.target.cleared, 2);
  assert.equal(f.primary.cleared + f.neighbor.cleared, 0);
  assert.equal(f.host.accountStatuses.get("alpha").authenticated, false);
  assert.equal(f.host.accountStatuses.get("beta").authenticated, true);
  assert.equal(f.cleaned(), 1);
});

test("temporary-state cleanup failure rejects and clears an otherwise imported account", async t => {
  const f = fixture(t);
  f.transfer.cleanup = async () => { throw new Error("synthetic cleanup failed"); };
  await assert.rejects(f.start(), /temporary Chrome sign-in state failed/);
  assert.equal(f.target.cleared, 2);
  assert.equal(f.primary.cleared + f.neighbor.cleared, 0);
  assert.equal(f.host.accountStatuses.get("alpha").authenticated, false);
});

test("closing the target tab during capture cleanup rejects through selected-account rollback", async t => {
  const f = fixture(t);
  f.transfer.cleanup = async () => { f.close(); f.host.turnTabs.delete(f.tab.id); };
  await assert.rejects(f.start(), /sign-in tab was closed or changed/);
  assert.equal(f.target.cleared, 2);
  assert.equal(f.primary.cleared + f.neighbor.cleared, 0);
  assert.equal(f.host.accountStatuses.get("alpha").authenticated, false);
  assert.equal(f.host.accountPasskeyLogin, null);
});

test("successful account import invalidates older primary authentication probes", async t => {
  const f = fixture(t);
  f.host.authenticationRevision = 7;
  f.host.reauthenticationRequired = true;
  await f.start();
  assert.equal(f.host.authenticationRevision, 8);
  assert.equal(f.host.reauthenticationRequired, false);
});

test("signing in does not enable a disabled account or claim aggregate availability from it", async t => {
  const f = fixture(t);
  f.host.disabledAccounts = new Set(["alpha"]);
  f.host.state.authenticated = false;
  await f.start();
  assert.equal(f.host.accountStatuses.get("alpha").authenticated, true);
  assert.equal(f.host.state.authenticated, false);
  assert.equal(f.host.disabledAccounts.has("alpha"), true);
});

test("the selected account's composer must become ready before sign-in succeeds", async t => {
  const f = fixture(t);
  f.noComposer();
  f.options.readyTimeoutMs = 0;
  await assert.rejects(f.start(), /composer did not become ready/);
  assert.equal(f.target.cleared, 2);
  assert.equal(f.primary.cleared + f.neighbor.cleared, 0);
});
