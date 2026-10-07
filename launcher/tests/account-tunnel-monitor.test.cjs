const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { AccountTunnelMonitor } = require("../electron/account-tunnel-monitor.cjs");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

function fixture(overrides = {}) {
  const recovered = [], events = [];
  const accounts = { busy: { tunnelId: "fixture-busy" }, healthy: { tunnelId: "fixture-healthy" } };
  const monitor = new AccountTunnelMonitor({
    readAccounts: () => accounts,
    probe: async name => ({ observed: true, ok: name === "healthy", fatal: name === "busy", detail: "internal 502" }),
    reconnect: async name => { recovered.push(name); return true; },
    write: (event, detail) => events.push({ event, ...detail }),
    ...overrides,
  });
  return { monitor, accounts, recovered, events };
}

test("a healthy default relay cannot hide an account's internal MCP failure", async () => {
  const { monitor, recovered, events } = fixture();
  await monitor.poll();
  assert.deepEqual(recovered, ["busy"]);
  assert.deepEqual(events.map(e => e.event), ["recovering", "recovered"]);
  assert.equal(JSON.stringify(events).includes("fixture-busy"), false);
});

test("unknown observations and ordinary MCP application errors do not authorize replacement", async () => {
  const { monitor, recovered } = fixture({ probe: async name => name === "busy"
    ? { observed: false, fatal: true } : { observed: true, ok: false, fatal: false } });
  await monitor.poll();
  assert.deepEqual(recovered, []);
});

test("account probes coalesce and a stopped monitor cannot start a delayed replacement", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { monitor, recovered } = fixture({ probe: async () => { await gate; return { observed: true, fatal: true }; } });
  const first = monitor.poll();
  assert.equal(monitor.poll(), first);
  monitor.stop();
  release();
  await first;
  assert.deepEqual(recovered, []);
});

test("account recovery has a bounded retry budget and a replacement identity gets its own budget", async () => {
  let attempts = 0;
  const { monitor, accounts, events } = fixture({ reconnect: async () => { attempts++; return false; } });
  for (let i = 0; i < 8; i++) await monitor.poll();
  assert.equal(attempts, 5);
  assert.equal(events.filter(e => e.event === "recovery_exhausted").length, 1);
  accounts.busy.tunnelId = "fixture-replacement";
  await monitor.poll();
  assert.equal(attempts, 6);
  delete accounts.busy;
  await monitor.poll();
  assert.equal(monitor.states.has("busy"), false);
});

test("local diagnostics are scoped to the exact account alias without changing default endpoint", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-account-relay-"));
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ events: [{
      time: new Date().toISOString(),
      message: "dispatcher received MCP upstream error; posted error response to control plane",
      attrs: { failure_source: "client_internal", status_code: 502, upstream_response_received: false, rpc_method: "initialize" },
    }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const file = path.join(root, "owned-account.url");
    fs.writeFileSync(file, `http://127.0.0.1:${server.address().port}`);
    const supervisor = new RuntimeSupervisor({ app: {}, logger: { info() {}, warn() {} }, coreHome: root, browserDescriptorPath: path.join(root, "browser.json") });
    supervisor.tunnelHealthBaseUrl = "http://127.0.0.1:1";
    supervisor.readConfig = () => ({ mode: "full", tunnel: { alias: "default" } });
    const alias = supervisor.accountPaths().tunnelAlias("busy");
    supervisor.runTunnelCommand = async (_config, args) => {
      assert.deepEqual(args, ["runtimes", "list", "--json"]);
      return { code: 0, output: JSON.stringify({ aliases: [{ alias: "default", health_url_file: "unrelated" }, { alias, health_url_file: file }] }) };
    };
    const health = await supervisor.probeAccountTunnel("busy");
    assert.equal(health.fatal, true);
    assert.equal(health.observed, true);
    assert.equal(supervisor.tunnelHealthBaseUrl, "http://127.0.0.1:1");
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("normal account replacement rechecks removal and never touches the daemon or default relay", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-account-recovery-"));
  try {
    const supervisor = new RuntimeSupervisor({ app: {}, logger: { info() {}, warn() {} }, coreHome: root, browserDescriptorPath: path.join(root, "browser.json") });
    const account = { tunnelId: "fixture", keyFile: "fixture-key-file" };
    let present = true;
    const calls = [];
    supervisor.monitoredAccountTunnels = () => present ? { busy: account } : {};
    supervisor.stopAccountTunnel = async name => { calls.push(["stop", name]); present = false; return true; };
    supervisor.startAccountTunnel = async name => { calls.push(["start", name]); return true; };
    supervisor.startDaemon = supervisor.startTunnel = () => { throw new Error("unrelated relay touched"); };
    assert.equal(await supervisor.recoverAccountTunnel("busy", account, () => true), false);
    assert.deepEqual(calls, [["stop", "busy"]]);
    present = true;
    supervisor.stopAccountTunnel = async name => { calls.push(["stop", name]); return true; };
    supervisor.probeAccountTunnel = async () => ({ observed: true, ok: true });
    assert.equal(await supervisor.recoverAccountTunnel("busy", account, () => true), true);
    assert.deepEqual(calls.slice(1), [["stop", "busy"], ["start", "busy"]]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
