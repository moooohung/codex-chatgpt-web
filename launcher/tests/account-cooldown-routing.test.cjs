const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { AccountCooldownStore, PRIMARY_ACCOUNT, UNUSUAL_ACTIVITY_MESSAGE_PREFIX } = require("../electron/account-cooldown-store.cjs");
const { readAccountConfig, writeAccountConfig } = require("../electron/account-policy.cjs");
const { BrowserHost } = require("../electron/browser-host.cjs");
const { BrowserControlServer } = require("../electron/control-server.cjs");
const { createStateStore } = require("../electron/state.cjs");

function fixture(t, pool = ["alpha", "beta"], timerApis = ["Date"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cooldown-routing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: timerApis, now: 1_000_000 });
  const configPath = path.join(root, "accounts-config.json");
  const configuredAccounts = Object.fromEntries(pool.filter(name => name !== PRIMARY_ACCOUNT)
    .map(name => [name, { enabled: true }]));
  if (Object.keys(configuredAccounts).length) writeAccountConfig(configPath, { accounts: configuredAccounts });
  const statePath = path.join(root, "launcher-state.json");
  const cooldownPath = path.join(root, "cooldowns.json");
  const stateStore = createStateStore(statePath);
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    accountPool: pool, accountConfigPresent: pool.length > 0, accountStatuses: new Map(pool.map(name => [name,
      { authenticated: true, routingAuthenticated: true, routingAuthCheckedAt: Date.now() }])),
    accountPaths: { config: configPath, partition: name => `persist:fixture-${name}` },
    stateStore,
    accountCooldowns: new AccountCooldownStore(cooldownPath),
    stickyConversations: new Map([["a".repeat(64), "alpha"]]),
    disabledAccounts: new Set(), unusualActivityDisabledAccounts: new Map(), pendingRemovalAccounts: new Set(), turnTabs: new Map(),
    logger: { info() {}, warn() {}, error() {} }, snapshot: () => ({}), saveStickyMap() {}, writeDescriptor() {},
    browserInteractionMode: () => "automatic",
  });
  return { host, root, configPath, statePath, cooldownPath };
}

test("only the observed account cools down; failover keeps original preference and expiry restores it", async t => {
  const { host } = fixture(t);
  const key = "a".repeat(64);
  const tab = { id: "alpha-tab", accountName: "alpha", traceId: "trace-alpha", helperPid: 123,
    conversationKey: key, status: "running" };
  host.turnTabs.set(tab.id, tab);
  assert.deepEqual(await host.recordTurnCooldown(tab.traceId, 123, Date.now() + 60_000, "Try again in 1 minute"),
    { alternateAvailable: true });
  assert.equal(host.resolveAccountForConversation(key), "beta");
  host.commitAccountBinding(key, "beta");
  assert.equal(host.stickyConversations.get(key), "alpha");
  assert.equal(host.accountCooldowns.get("beta"), null);
  assert.equal(host.accountStatuses.get("alpha").authenticated, true, "a usage wait must not sign out an account");
  const beta = { id: "beta-tab", accountName: "beta", traceId: "trace-beta", helperPid: 456,
    conversationKey: key, status: "running" };
  host.turnTabs.set(beta.id, beta);
  t.mock.timers.tick(60_000);
  host.accountStatuses.get("alpha").routingAuthCheckedAt = Date.now();
  await host.admitAccount(key, "trace-beta", 456);
  assert.equal(beta.accountName, "beta", "expiry must never move an in-flight turn");
  assert.equal(host.resolveAccountForConversation(key), "alpha");
});

test("unusual activity pauses admission without changing enabled preferences or other accounts", async t => {
  const { host, configPath } = fixture(t);
  const key = "a".repeat(64);
  host.turnTabs.set("alpha-tab", { id: "alpha-tab", accountName: "alpha", traceId: "trace-unusual-alpha",
    helperPid: 123, conversationKey: key, status: "running" });
  const retryAt = Date.now() + 30 * 60_000;
  assert.deepEqual(await host.recordTurnCooldown("trace-unusual-alpha", 123, retryAt,
    `${UNUSUAL_ACTIVITY_MESSAGE_PREFIX}Our systems have detected unusual activity coming from your system. Please try again later. Try again in 30 minutes.`,
    "chatgpt_unusual_activity"), { alternateAvailable: true, retryAt });
  assert.equal(readAccountConfig(configPath).accounts.alpha.enabled, true);
  assert.equal(host.disabledAccounts.has("alpha"), false);
  assert.deepEqual(host.stateStore.read().unusualActivityDisabledAccounts.alpha,
    { retryAt, traceId: "trace-unusual-alpha", reactivate: false });
  assert.equal(host.resolveAccountForConversation("b".repeat(64)), "beta");
});

test("unusual activity expires without persisting a disable or moving in-flight work", async t => {
  const { host, configPath } = fixture(t, ["alpha"], ["Date", "setTimeout"]);
  const events = [];
  host.logger = { info(event, details) { events.push({ event, details }); }, warn() {}, error() {} };
  host.turnTabs.set("alpha-tab", { id: "alpha-tab", accountName: "alpha", traceId: "trace-auto-reactivate",
    helperPid: 123, conversationKey: "c".repeat(64), status: "running" });
  const retryAt = Date.now() + 3 * 60_000;
  await host.recordTurnCooldown("trace-auto-reactivate", 123, retryAt,
    `${UNUSUAL_ACTIVITY_MESSAGE_PREFIX}fixture Try again in 30 minutes.`, "chatgpt_unusual_activity");
  assert.equal(readAccountConfig(configPath).accounts.alpha.enabled, true);
  t.mock.timers.tick(3 * 60_000);
  assert.equal(readAccountConfig(configPath).accounts.alpha.enabled, true);
  assert.equal(host.disabledAccounts.has("alpha"), false);
  assert.equal(host.stateStore.read().unusualActivityDisabledAccounts?.alpha, undefined);
  assert.equal(host.accountCooldowns.get("alpha"), null);
  assert.ok(events.some(entry => entry.event === "unusual_activity_cooldown_ended"
    && entry.details.traceId === "trace-auto-reactivate" && entry.details.account === "alpha"));
});

test("unusual activity cooldown survives launcher restart and still rejects when no account is active", async t => {
  const { host, configPath, statePath, cooldownPath } = fixture(t, ["alpha"]);
  host.turnTabs.set("alpha-tab", { id: "alpha-tab", accountName: "alpha", traceId: "trace-restart",
    helperPid: 123, conversationKey: "d".repeat(64), status: "running" });
  const retryAt = Date.now() + 30 * 60_000;
  await host.recordTurnCooldown("trace-restart", 123, retryAt,
    `${UNUSUAL_ACTIVITY_MESSAGE_PREFIX}fixture Try again in 30 minutes.`, "chatgpt_unusual_activity");
  for (const timer of host.unusualActivityCooldownTimers.values()) clearTimeout(timer);

  const restarted = Object.assign(Object.create(BrowserHost.prototype), {
    accountPool: ["alpha"], accountConfigPresent: true,
    accountStatuses: new Map([["alpha", { authenticated: true, routingAuthenticated: true, routingAuthCheckedAt: Date.now() }]]),
    accountPaths: { config: configPath, partition: name => `persist:fixture-${name}` },
    stateStore: createStateStore(statePath), accountCooldowns: new AccountCooldownStore(cooldownPath),
    stickyConversations: new Map(), disabledAccounts: new Set(), pendingRemovalAccounts: new Set(), turnTabs: new Map(),
    unusualActivityCooldownTimers: new Map(), logger: { info() {}, warn() {}, error() {} },
    snapshot: () => ({}), publishState() {}, saveStickyMap() {}, writeDescriptor() {}, browserInteractionMode: () => "automatic",
  });
  restarted.unusualActivityDisabledAccounts = restarted.loadUnusualActivityDisabledAccounts();
  restarted.restoreUnusualActivityDisabledAccounts();
  assert.deepEqual(restarted.unusualActivityDisabledAccounts.get("alpha"),
    { retryAt, traceId: "trace-restart", reactivate: false });
  assert.equal(readAccountConfig(configPath).accounts.alpha.enabled, true);
  await assert.rejects(restarted.admitAccount("e".repeat(64), "new-trace", 999), error =>
    error.code === "chatgpt_unusual_activity" && error.retryAt === retryAt && error.retryAfterSeconds === 30 * 60);
  for (const timer of restarted.unusualActivityCooldownTimers.values()) clearTimeout(timer);
});

test("a manually disabled account is never reactivated by unusual activity expiry", async t => {
  const { host, configPath } = fixture(t, ["alpha"], ["Date", "setTimeout"]);
  const data = readAccountConfig(configPath);
  data.accounts.alpha.enabled = false;
  writeAccountConfig(configPath, data);
  host.disabledAccounts.add("alpha");
  host.turnTabs.set("alpha-tab", { id: "alpha-tab", accountName: "alpha", traceId: "trace-manual-disable",
    helperPid: 123, conversationKey: "f".repeat(64), status: "running" });
  const retryAt = Date.now() + 1_000;
  await host.recordTurnCooldown("trace-manual-disable", 123, retryAt,
    `${UNUSUAL_ACTIVITY_MESSAGE_PREFIX}fixture Try again in 30 minutes.`, "chatgpt_unusual_activity");
  assert.equal(host.stateStore.read().unusualActivityDisabledAccounts.alpha.reactivate, false);
  t.mock.timers.tick(3 * 60_000);
  assert.equal(readAccountConfig(configPath).accounts.alpha.enabled, false);
  assert.equal(host.disabledAccounts.has("alpha"), true);
});

test("account-wide backoff survives restart and concurrent observations do not renew it", async t => {
  const { host, statePath } = fixture(t, ["alpha"], ["Date", "setTimeout"]);
  host.turnTabs.set("one", { id: "one", accountName: "alpha", traceId: "one", helperPid: 123, status: "running" });
  const report = () => host.recordTurnCooldown("one", 123, Date.now() + 180_000,
    `${UNUSUAL_ACTIVITY_MESSAGE_PREFIX}fixture`, "chatgpt_unusual_activity", true);
  const first = await report();
  t.mock.timers.tick(30_000);
  assert.equal((await report()).retryAt, first.retryAt);
  assert.equal(host.stateStore.read().unusualActivityHistory.alpha.failures, 1);
  t.mock.timers.tick(150_000);
  host.stateStore = createStateStore(statePath);
  host.unusualActivityHistory = undefined;
  const retry = await report();
  assert.equal(retry.retryAt - Date.now(), 5 * 60_000);
  assert.equal(host.stateStore.read().unusualActivityHistory.alpha.failures, 2);
  assert.equal(host.disabledAccounts.has("alpha"), false);
});

test("legacy bridge-owned disabled accounts recover on admission even if the expiry timer was lost", async t => {
  const { host, configPath } = fixture(t, ["alpha"]);
  const data = readAccountConfig(configPath);
  data.accounts.alpha.enabled = false;
  writeAccountConfig(configPath, data);
  host.disabledAccounts.add("alpha");
  const retryAt = Date.now() + 1000;
  host.accountCooldowns.record("alpha", { retryAt, message: `${UNUSUAL_ACTIVITY_MESSAGE_PREFIX}fixture` });
  host.unusualActivityDisabledAccounts.set("alpha", { retryAt, traceId: "legacy", reactivate: true });
  host.persistUnusualActivityDisableState();
  t.mock.timers.tick(1000);
  assert.equal(host.resolveAccountForConversation("a".repeat(64)), "alpha");
  assert.equal(readAccountConfig(configPath).accounts.alpha.enabled, true);
  assert.equal(host.disabledAccounts.has("alpha"), false);
});

test("expired legacy marker cannot clear a later provider wait or unrelated usage limit", t => {
  const { host } = fixture(t, ["alpha"]);
  const oldRetryAt = Date.now() + 1000;
  host.unusualActivityDisabledAccounts.set("alpha", { retryAt: oldRetryAt, traceId: "legacy", reactivate: false });
  const retryAt = Date.now() + 60_000;
  host.accountCooldowns.record("alpha", { retryAt, message: `${UNUSUAL_ACTIVITY_MESSAGE_PREFIX}later` });
  t.mock.timers.tick(1000);
  host.restoreUnusualActivityDisabledAccounts();
  assert.equal(host.unusualActivityDisabledAccounts.get("alpha").retryAt, retryAt);
  assert.equal(host.accountCooldowns.get("alpha").retryAt, retryAt);
  host.accountCooldowns.record("alpha", { retryAt: retryAt + 60_000, message: "Hourly usage limit" });
  host.restoreUnusualActivityDisabledAccounts();
  assert.equal(host.unusualActivityDisabledAccounts.has("alpha"), false);
  assert.equal(host.accountCooldowns.get("alpha").message, "Hourly usage limit");
  for (const timer of host.unusualActivityCooldownTimers?.values() || []) clearTimeout(timer);
});

test("manual disable during an active pause remains disabled after the pause expires", async t => {
  const { host, configPath } = fixture(t, ["alpha"], ["Date", "setTimeout"]);
  host.turnTabs.set("one", { accountName: "alpha", traceId: "one", helperPid: 123, status: "running" });
  await host.recordTurnCooldown("one", 123, Date.now() + 180_000,
    `${UNUSUAL_ACTIVITY_MESSAGE_PREFIX}fixture`, "chatgpt_unusual_activity", true);
  const data = readAccountConfig(configPath);
  data.accounts.alpha.enabled = false;
  writeAccountConfig(configPath, data);
  host.recordManualAccountEnabledChange("alpha");
  host.setAccountEnabled("alpha", false);
  t.mock.timers.tick(180_000);
  assert.equal(host.disabledAccounts.has("alpha"), true);
  assert.equal(readAccountConfig(configPath).accounts.alpha.enabled, false);
});

test("no alternate rejects every new request without probing a cooling account or creating a tab", async t => {
  const { host } = fixture(t, ["alpha"]);
  const retryAt = Date.now() + 60_000;
  host.accountCooldowns.record("alpha", { retryAt, message: "Try again after 8:27 PM" });
  host.view = { webContents: { get session() { throw new Error("Cooling account must not be queried"); } } };
  for (let i = 0; i < 3; i++) await assert.rejects(host.admitAccount("a".repeat(64), `trace-new-${i}`, 321),
    error => error.code === "chatgpt_account_cooldown" && error.retryAt === retryAt && error.retryAfterSeconds === 60);
  assert.equal(host.turnTabs.size, 0);
});

test("unusual activity blocks new turns before tab creation and expires exactly on time", async t => {
  const { host } = fixture(t, ["alpha"]);
  const retryAt = Date.now() + 30 * 60_000;
  host.accountCooldowns.record("alpha", {
    retryAt,
    message: `${UNUSUAL_ACTIVITY_MESSAGE_PREFIX}Our systems have detected unusual activity coming from your system. Please try again later. Try again in 30 minutes.`,
  });
  host.view = { webContents: { get session() { throw new Error("Cooling account must not be opened"); } } };
  await assert.rejects(host.admitAccount("a".repeat(64), "trace-unusual", 321), error =>
    error.code === "chatgpt_unusual_activity"
      && error.retryAt === retryAt
      && error.retryAfterSeconds === 30 * 60
      && error.message.includes("Cooldown remaining: 30 minutes"));
  assert.equal(host.turnTabs.size, 0);
  t.mock.timers.tick(30 * 60_000 - 1);
  await assert.rejects(host.admitAccount("a".repeat(64), "trace-still-cooling", 321), error =>
    error.code === "chatgpt_unusual_activity" && error.retryAfterSeconds === 1);
  t.mock.timers.tick(1);
  host.accountStatuses.get("alpha").routingAuthCheckedAt = Date.now();
  await assert.doesNotReject(host.admitAccount("a".repeat(64), "trace-after-cooldown", 321));
  assert.equal(host.resolveAccountForConversation("a".repeat(64)), "alpha");
  assert.equal(host.turnTabs.size, 0);
});

test("unusual activity logs detection and cooldown end with the originating trace id", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cooldown-logging-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 2_000_000 });
  const events = [];
  const configPath = path.join(root, "accounts-config.json");
  writeAccountConfig(configPath, { accounts: { alpha: { enabled: true } } });
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    accountPool: ["alpha"], accountConfigPresent: true,
    accountStatuses: new Map([["alpha", { authenticated: true, routingAuthenticated: true, routingAuthCheckedAt: Date.now() }]]),
    accountPaths: { config: configPath, partition: name => `persist:fixture-${name}` },
    stateStore: createStateStore(path.join(root, "launcher-state.json")),
    accountCooldowns: new AccountCooldownStore(path.join(root, "cooldowns.json")),
    stickyConversations: new Map(), disabledAccounts: new Set(), unusualActivityDisabledAccounts: new Map(), pendingRemovalAccounts: new Set(),
    turnTabs: new Map([["tab", { id: "tab", accountName: "alpha", traceId: "trace-log", helperPid: 77,
      conversationKey: "b".repeat(64), status: "running" }]]),
    logger: {
      info(event, details) { events.push({ level: "info", event, details }); },
      warn(event, details) { events.push({ level: "warn", event, details }); },
      error() {},
    },
    snapshot: () => ({}), publishState() {}, saveStickyMap() {}, writeDescriptor() {},
    browserInteractionMode: () => "automatic",
  });
  await host.recordTurnCooldown(
    "trace-log",
    77,
    Date.now() + 3 * 60_000,
    `${UNUSUAL_ACTIVITY_MESSAGE_PREFIX}fixture Try again in 30 minutes.`,
    "chatgpt_unusual_activity",
  );
  assert.ok(events.some(entry => entry.event === "unusual_activity_detected" && entry.details.traceId === "trace-log"));
  t.mock.timers.tick(3 * 60_000);
  assert.ok(events.some(entry => entry.event === "unusual_activity_cooldown_ended" && entry.details.traceId === "trace-log"));
});

test("unknown, signed-out, disabled and security-check accounts cannot become alternates", t => {
  const { host } = fixture(t);
  for (const status of [{}, { authenticated: false, routingAuthenticated: true },
    { authenticated: true, routingAuthenticated: false }, { authenticated: true, routingAuthenticated: true, securityCheckRequired: true }]) {
    host.accountStatuses.set("beta", status);
    host.accountCooldowns.record("alpha", { retryAt: Date.now() + 60_000, message: "Try again in 1 minute" });
    assert.throws(() => host.resolveAccountForConversation("a".repeat(64)), error => error.code === "chatgpt_account_cooldown");
  }
  host.accountStatuses.set("beta", { authenticated: true, routingAuthenticated: true });
  host.disabledAccounts.add("beta");
  assert.throws(() => host.resolveAccountForConversation("a".repeat(64)), error => error.code === "chatgpt_account_cooldown");
});

test("cookie audit success cannot clear the usage cooldown or authorize an unverified alternate", async t => {
  const { host } = fixture(t);
  host.accountCooldowns.record("alpha", { retryAt: Date.now() + 60_000, message: "Try again in 1 minute" });
  host.accountStatuses.set("beta", { authenticated: true });
  host.recordAccountAuthSuccess("alpha");
  assert.throws(() => host.resolveAccountForConversation("a".repeat(64)), error => error.code === "chatgpt_account_cooldown");
});

test("cooldown notification is bound to exact helper and tab, including the primary session", async t => {
  const { host } = fixture(t, []);
  host.turnTabs.set("tab", { id: "tab", accountName: null, traceId: "primary-trace", helperPid: 123, status: "running" });
  await assert.rejects(host.recordTurnCooldown("primary-trace", 124, Date.now() + 1000, "Try again soon"), /exact active/);
  assert.deepEqual(await host.recordTurnCooldown("primary-trace", 123, Date.now() + 1000, "Try again soon"), { alternateAvailable: false });
  assert.ok(host.accountCooldowns.get(PRIMARY_ACCOUNT));
});

test("control admission returns 429 and Retry-After; running same-trace reconnect remains admitted", async t => {
  const { host } = fixture(t, ["alpha"]);
  const key = "a".repeat(64), retryAt = Date.now() + 60_000;
  host.accountCooldowns.record("alpha", { retryAt, message: "Try again after 8:27 PM" });
  const server = await new BrowserControlServer({ logger: host.logger, getBrowserHost: () => host,
    getPreferences: () => ({}) }).start();
  t.after(() => server.close());
  const { endpoint, token } = server.descriptor();
  async function request(traceId) { return fetch(endpoint + "/v1/account/admit", { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ traceId, helperPid: 123, conversationKey: key }) }); }
  let response = await request("new-trace");
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.deepEqual(await response.json(), { error: `ChatGPT account [alpha] is temporarily limited. No other signed-in account is available. Try again after ${new Date(retryAt).toISOString()}. Try again after 8:27 PM`,
    code: "chatgpt_account_cooldown", retryAt, retry_after_seconds: 60 });
  host.turnTabs.set("active", { traceId: "active-trace", helperPid: 123, conversationKey: key, status: "running", accountName: "alpha" });
  response = await request("active-trace");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("Zero Risk selection and binding retain the legacy manual contract without native auth probes", t => {
  const { host } = fixture(t);
  host.browserInteractionMode = () => "manual";
  host.accountStatuses = new Map();
  const key = "a".repeat(64);
  host.accountCooldowns.record("alpha", { retryAt: Date.now() + 60_000, message: "Try again in 1 minute" });
  assert.equal(host.resolveAccountForConversation(key), "alpha");
  host.commitAccountBinding(key, "beta");
  assert.equal(host.stickyConversations.get(key), "beta");
});

test("an auth failure revokes cached routing proof even after a cookie success", t => {
  const { host } = fixture(t);
  host.recordAccountAuthFailure("beta");
  assert.equal(host.accountStatuses.get("beta").routingAuthenticated, false);
  host.recordAccountAuthSuccess("beta");
  host.accountCooldowns.record("alpha", { retryAt: Date.now() + 60_000, message: "Try again in 1 minute" });
  assert.throws(() => host.resolveAccountForConversation("a".repeat(64)), error => error.code === "chatgpt_account_cooldown");
});

test("a pending session probe cannot restore routing after a newer auth failure", async t => {
  const { host } = fixture(t);
  host.accountCooldowns.record("beta", { retryAt: Date.now() + 60_000, message: "Try again in 1 minute" });
  host.accountStatuses.get("alpha").routingAuthCheckedAt = 0;
  host.accountPaths = { partition: () => "persist:fixture" };
  let finish;
  host.session = { fromPartition: () => ({ fetch: () => new Promise(resolve => { finish = resolve; }) }) };
  const pending = host.refreshRoutingAccounts();
  assert.equal(typeof finish, "function");
  host.recordAccountAuthFailure("alpha");
  finish(Response.json({ user: { id: "fixture" } }));
  await pending;
  assert.equal(host.accountStatuses.get("alpha").routingAuthenticated, false);
  assert.equal(host.accountStatuses.get("alpha").authenticated, false);
});

test("primary cookie revisions invalidate a native session probe started before the change", async t => {
  const { host } = fixture(t, [PRIMARY_ACCOUNT, "beta"]);
  host.accountCooldowns.record("beta", { retryAt: Date.now() + 60_000, message: "Try again in 1 minute" });
  host.accountStatuses.get(PRIMARY_ACCOUNT).routingAuthCheckedAt = 0;
  host.accountStatuses.get(PRIMARY_ACCOUNT).routingAuthenticated = false;
  host.authenticationRevision = 0;
  let finish;
  host.view = { webContents: { session: { fetch: () => new Promise(resolve => { finish = resolve; }) } } };
  const pending = host.refreshRoutingAccounts();
  host.authenticationRevision++;
  finish(Response.json({ user: { id: "fixture" } }));
  await pending;
  assert.notEqual(host.accountStatuses.get(PRIMARY_ACCOUNT)?.routingAuthenticated, true);
});

test("ordinary turns preserve legacy routing without adding a separate native authentication request", async t => {
  const { host } = fixture(t);
  host.accountStatuses = new Map();
  host.session = { fromPartition() { assert.fail("No extra request without an observed cooldown"); } };
  await host.admitAccount("a".repeat(64), "ordinary-trace", 123);
  assert.equal(host.resolveAccountForConversation("a".repeat(64)), "alpha");
});

test("one unavailable partition cannot reject new requests on another independently verified account", async t => {
  const { host } = fixture(t, ["alpha", "beta", "gamma"]);
  host.accountCooldowns.record("alpha", { retryAt: Date.now() + 60_000, message: "Hourly usage limit" });
  for (const name of ["beta", "gamma"]) host.accountStatuses.get(name).routingAuthCheckedAt = 0;
  host.session = { fromPartition(name) {
    if (name.endsWith("beta")) throw new Error("synthetic destroyed partition");
    return { fetch: async () => Response.json({ user: { id: "synthetic-gamma" } }) };
  } };
  await assert.doesNotReject(host.admitAccount("a".repeat(64), "independent-request", 123));
  assert.equal(host.accountStatuses.get("beta").routingAuthenticated, false);
  assert.equal(host.accountStatuses.get("gamma").routingAuthenticated, true);
  assert.equal(host.resolveAccountForConversation("a".repeat(64)), "gamma");
});
