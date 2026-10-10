const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { AccountCooldownStore, PRIMARY_ACCOUNT } = require("../electron/account-cooldown-store.cjs");
const { BrowserHost } = require("../electron/browser-host.cjs");
const { BrowserControlServer } = require("../electron/control-server.cjs");

function fixture(t, pool = ["alpha", "beta"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cooldown-routing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    accountPool: pool, accountConfigPresent: pool.length > 0, accountStatuses: new Map(pool.map(name => [name,
      { authenticated: true, routingAuthenticated: true, routingAuthCheckedAt: Date.now() }])),
    accountCooldowns: new AccountCooldownStore(path.join(root, "cooldowns.json")),
    stickyConversations: new Map([["a".repeat(64), "alpha"]]),
    disabledAccounts: new Set(), pendingRemovalAccounts: new Set(), turnTabs: new Map(),
    logger: { info() {}, warn() {}, error() {} }, snapshot: () => ({}), saveStickyMap() {}, writeDescriptor() {},
    browserInteractionMode: () => "automatic",
  });
  return { host, root };
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

test("no alternate rejects every new request without probing a cooling account or creating a tab", async t => {
  const { host } = fixture(t, ["alpha"]);
  const retryAt = Date.now() + 60_000;
  host.accountCooldowns.record("alpha", { retryAt, message: "Try again after 8:27 PM" });
  host.view = { webContents: { get session() { throw new Error("Cooling account must not be queried"); } } };
  for (let i = 0; i < 3; i++) await assert.rejects(host.admitAccount("a".repeat(64), `trace-new-${i}`, 321),
    error => error.code === "chatgpt_account_cooldown" && error.retryAt === retryAt && error.retryAfterSeconds === 60);
  assert.equal(host.turnTabs.size, 0);
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
