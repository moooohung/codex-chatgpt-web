const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { accountPaths, readAccountConfig, selectAccount, writeAccountConfig } = require("../electron/account-policy.cjs");
const { AccountRemoval } = require("../electron/account-removal.cjs");
const { createAccountApi } = require("../electron/account-api.cjs");
const { BrowserHost } = require("../electron/browser-host.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = accountPaths({ coreHome: root, userData: path.join(root, "launcher") });
  writeAccountConfig(paths.config, { accounts: { alpha: { enabled: true }, beta: { enabled: true } } });
  return { root, paths };
}

test("production tunnel aliases preserve identity across Windows path casing", {skip:process.platform !== "win32"}, () => {
  const coreHome = path.join(os.homedir(), ".codex-chatgpt-web");
  assert.equal(accountPaths({coreHome:coreHome.toUpperCase()}).tunnelAlias("alpha"), "codex-chatgpt-web-alpha");
});

test("cookie audit uses Electron expirationDate and never marks an expired session available", async () => {
  const observed = [];
  const host = {
    accountPaths: {partition:name=>`persist:test-${name}`},
    session: {fromPartition:()=>({cookies:{get:async()=>[{name:"session-token",value:"synthetic-session-token",expirationDate:Date.now()/1000-60}]}})},
    recordAccountAuthSuccess:name=>observed.push([name,true]),
    recordAccountAuthFailure:name=>observed.push([name,false]),
  };
  assert.equal(await BrowserHost.prototype.auditAccountCookie.call(host,"alpha"), false);
  assert.deepEqual(observed, [["alpha",false]]);
});

test("account selection has no mutation or login side effects and excludes every unavailable state", () => {
  const statuses = new Map([["alpha", { authenticated: false }], ["beta", { authenticated: true }]]);
  const options = { pool: ["alpha", "beta"], configured: true, statuses, bound: "alpha", roundRobin: 0 };
  assert.equal(selectAccount(options), "beta");
  assert.equal(options.bound, "alpha");
  assert.equal(options.roundRobin, 0);
  assert.equal(statuses.get("alpha").authenticated, false);
  for (const overrides of [
    { disabled: new Set(["alpha", "beta"]) },
    { pending: new Set(["alpha", "beta"]) },
    { statuses: new Map([["alpha", { authenticated: false }], ["beta", { authenticated: false }]]) },
    { statuses: new Map([["alpha", { cooldownUntil: 200 }], ["beta", { cooldownUntil: 200 }]]), now: 100 },
    { pool: [] },
  ]) assert.throws(() => selectAccount({ ...options, ...overrides }), error => error.code === "account_unavailable");
  assert.equal(selectAccount({ pool: [] }), null);
});

test("production, development and custom paths never share account files, partitions or aliases", () => {
  const production = accountPaths();
  const development = accountPaths({ coreHome: path.join(os.homedir(), ".codex-chatgpt-web-dev"), userData: path.join(os.homedir(), ".codex-chatgpt-web-dev/launcher"), partition: "persist:codex-web-gpt-dev-chatgpt" });
  const custom = accountPaths({ coreHome: path.join(os.tmpdir(), "custom-home"), userData: path.join(os.tmpdir(), "custom-data"), partition: "persist:codex-web-gpt-custom-0123456789abcdef-chatgpt" });
  for (const field of ["config", "secrets", "sticky"]) assert.equal(new Set([production[field], development[field], custom[field]]).size, 3);
  for (const field of ["partition", "tunnelAlias"]) assert.equal(new Set([production[field]("alpha"), development[field]("alpha"), custom[field]("alpha")]).size, 3);
  assert.equal(production.tunnelAlias("alpha"), "codex-chatgpt-web-alpha");
});

test("corrupt account configuration is retained and cannot be overwritten by a mutation", t => {
  const { paths } = fixture(t);
  fs.writeFileSync(paths.config, '{"accounts":');
  assert.throws(() => readAccountConfig(paths.config), /original preserved/);
  assert.throws(() => writeAccountConfig(paths.config, { accounts: {} }), /original preserved/);
  assert.equal(fs.readFileSync(paths.config, "utf8"), '{"accounts":');
});

test("account deletion waits for running work and physical cleanup before stopping its tunnel", async t => {
  const { paths } = fixture(t);
  let running = true;
  let cleanup = true;
  let stopped = 0;
  let removed = 0;
  const host = { pendingRemovalAccounts: new Set(), isAccountBusy: () => running || cleanup,
    async removeAccountFromPool() { removed++; } };
  const removal = new AccountRemoval({ filePath: paths.config, host, supervisor: { async stopAccountTunnel() { stopped++; return true; } }, retryMs: 60_000 });
  t.after(() => clearTimeout(removal.timer));
  assert.deepEqual(await removal.request("alpha"), { ok: true, name: "alpha", deferred: true });
  assert.equal(readAccountConfig(paths.config).accounts.alpha.pendingRemoval, true);
  assert.equal(host.pendingRemovalAccounts.has("alpha"), true);
  running = false;
  assert.equal(await removal.finish("alpha"), false);
  assert.equal(stopped, 0);
  cleanup = false;
  assert.equal(await removal.finish("alpha"), true);
  assert.equal(stopped, 1);
  assert.equal(removed, 1);
  assert.equal(readAccountConfig(paths.config).accounts.alpha, undefined);
  assert.ok(readAccountConfig(paths.config).accounts.beta);
});

test("a failed tunnel stop preserves pending deletion and a later retry completes it", async t => {
  const { paths } = fixture(t);
  let stopped = false;
  const host = { isAccountBusy: () => false, async removeAccountFromPool() {} };
  const removal = new AccountRemoval({ filePath: paths.config, host, supervisor: { async stopAccountTunnel() { return stopped; } }, retryMs: 60_000 });
  t.after(() => clearTimeout(removal.timer));
  await assert.rejects(removal.request("alpha"), /tunnel stop failed/);
  assert.equal(readAccountConfig(paths.config).accounts.alpha.pendingRemoval, true);
  stopped = true;
  assert.equal(await removal.finish("alpha"), true);
});

test("automatic and legacy manual auth failures affect their own account and leave another signed-in account ready", () => {
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    accountPool: ["alpha", "beta"], accountStatuses: new Map([["beta", { authenticated: true }]]),
    logger: { warn() {} }, setState(value) { this.state = value; }, writeDescriptor() {},
  });
  host.markTurnAuthenticationRequired({ id: "automatic", assignedAccount: "alpha" });
  assert.equal(host.accountStatuses.get("alpha").authenticated, false);
  assert.equal(host.accountStatuses.get("beta").authenticated, true);
  assert.equal(host.state.authenticated, true);
  host.markTurnAuthenticationRequired({ id: "manual", accountName: "beta" });
  assert.equal(host.state.authenticated, false);
});

test("disable blocks new work while an existing automatic turn can reconnect", async () => {
  const tab = { id: "active", traceId: "trace", helperPid: process.pid, accountName: "alpha", conversationKey: "conversation",
    interactionMode: "automatic", status: "running", view: { webContents: { isDestroyed: () => true } } };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    accountPool: ["alpha"], accountConfigPresent: true, disabledAccounts: new Set(["alpha"]),
    turnTabs: new Map([[tab.id, tab]]), userCancelledTurnOwners: new Map(), selectedTabId: tab.id,
    logger: { info() {} }, snapshot: () => ({}), writeDescriptor() {}, presentTurnView() {},
  });
  await host.beginTurn("trace", false, process.pid, "conversation");
  assert.equal(tab.status, "running");
  assert.throws(() => host.resolveAccountForConversation("new-conversation"), error => error.code === "account_unavailable");
});

test("shared login tab allocation respects configured limits and reuses free ordinals", () => {
  for (const maxTabs of [4, 8]) {
    const host = Object.assign(Object.create(BrowserHost.prototype), { memoryPolicy: { maxTabs },
      turnTabs: new Map(), removeTurnTab(tab) { this.turnTabs.delete(tab.id); } });
    for (let i = 1; i <= maxTabs; i++) {
      const ordinal = host.allocateTabOrdinal();
      host.turnTabs.set(String(i), { id: String(i), ordinal, isSignInTab: true, status: "ready" });
    }
    assert.throws(() => host.allocateTabOrdinal(), error => error.code === "browser_tab_limit");
    host.turnTabs.delete("2");
    assert.equal(host.allocateTabOrdinal(), 2);
  }
});

test("deletion holds account ownership until WebContents destruction", async () => {
  const contents = new EventEmitter();
  let destroyed = false;
  contents.isDestroyed = () => destroyed;
  const tab = { id: "ready", accountName: "alpha", status: "ready", view: { webContents: contents } };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]), accountCleanup: new Map(), accountPool: ["alpha"], stickyConversations: new Map(),
    removeTurnTab(tab) { this.turnTabs.delete(tab.id); }, saveStickyMap() {}, async refreshAuthenticationFromSession() {},
  });
  assert.equal(await host.removeAccountFromPool("alpha"), false);
  assert.equal(host.isAccountBusy("alpha"), true);
  destroyed = true;
  contents.emit("destroyed");
  assert.equal(await host.removeAccountFromPool("alpha"), true);
  assert.equal(host.accountPool.length, 0);
});

test("API includes automatic tab counts and does not report a tunnel start failure as success", async t => {
  const { root, paths } = fixture(t);
  const host = { turnTabs: new Map([["automatic", { accountName: "alpha" }]]), accountStatuses: new Map(),
    isAccountBusy: () => false, async auditAccountCookie() {}, addAccountToPool() {}, openAccountLoginTab() { assert.fail("Failed tunnel must not open a login tab"); } };
  const api = createAccountApi({ profile: { coreHome: root, userData: path.join(root, "launcher"), browserPartition: "persist:codex-web-gpt-chatgpt" },
    getHost: () => host, getSupervisor: () => ({ async startAccountTunnel() { return false; } }) });
  assert.equal((await api.list()).accounts.find(account => account.name === "alpha").activeTabs, 1);
  await assert.rejects(api.add({ name: "gamma", tunnelId: "tunnel", runtimeKey: "private-fixture" }), /tunnel failed to start/);
  assert.ok(readAccountConfig(paths.config).accounts.gamma);
});
