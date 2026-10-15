const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { createAccountApi } = require("../electron/account-api.cjs");

const root = path.resolve(__dirname, "..");
const profile = { coreHome: path.join(__dirname, "fixtures/inert-account-passkey"),
  userData: path.join(__dirname, "fixtures/inert-account-passkey/data"), browserPartition: "persist:offline-fixture" };

test("account API validates the name and delegates the exact target without a global login or configuration mutation", async () => {
  const calls = [];
  const state = { authenticated: true, passkeyAccount: "beta", passkeyPhase: "waiting" };
  let resolve;
  const host = { openAccountPasskeyLogin: name => {
    calls.push(name); return new Promise(done => { resolve = done; });
  } };
  const api = createAccountApi({ profile, getHost: () => host,
    getSupervisor: () => assert.fail("login must not restart tunnels"), logger: {} });
  const pending = api.passkeyLogin(" beta ");
  assert.deepEqual(calls, ["beta"]);
  resolve(state);
  assert.equal(await pending, state);
  for (const invalid of ["", "../alpha", "beta/alpha", { name: "bad.name" }, null]) {
    assert.throws(() => api.passkeyLogin(invalid), /Invalid account name/);
  }
  assert.deepEqual(calls, ["beta"]);
  host.openAccountPasskeyLogin = async name => { assert.equal(name, "beta"); throw new Error("Selected account has an active turn"); };
  await assert.rejects(api.passkeyLogin({ name: "beta" }), /Selected account has an active turn/);
});

test("preload routes account login through startup-gated IPC and Continue through the existing runtime route", async () => {
  let api, ready;
  const calls = [], handlers = new Map();
  const startup = new Promise(resolve => { ready = resolve; });
  const result = { passkeyAccount: "beta", passkeyPhase: "waiting" };
  const accountApi = { resume() {}, passkeyLogin: name => { calls.push(["account", name]); return result; } };
  const context = vm.createContext({ runtimeStartup: startup, LAUNCHER_PROFILE: profile,
    browserHost: {}, runtimeSupervisor: {}, logger: { warn() {} }, stateStore: {},
    runtimeHost: { continuePasskeyLogin: () => { calls.push(["continue"]); return true; } },
    createAccountApi: () => accountApi, ipcMain: { on() {} },
    registerLoggedIpc: (_ipc, _logger, channel, handler) => handlers.set(channel, handler),
  });
  const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
  const tree = ts.createSourceFile("main.cjs", main, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const register = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "registerIpc");
  assert.ok(register);
  vm.runInContext(register.getText(tree) + "\nregisterIpc({ logger, stateStore });", context);
  vm.runInNewContext(fs.readFileSync(path.join(root, "electron/preload.cjs"), "utf8"), {
    require(name) {
      assert.equal(name, "electron");
      return { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, "codexWebLauncher"); api = value; } },
        ipcRenderer: { invoke: (channel, ...args) => handlers.get(channel)({}, ...args) } };
    },
  });
  const pending = api.openAccountPasskeyLogin("beta");
  assert.deepEqual(calls, [], "account login waits for runtime initialization");
  ready();
  assert.equal(await pending, result);
  assert.deepEqual(calls, [["account", "beta"]]);
  assert.equal(await api.continuePasskeyLogin(), true);
  assert.deepEqual(calls, [["account", "beta"], ["continue"]]);
  accountApi.passkeyLogin = async () => { throw new Error("Account login ownership failed"); };
  await assert.rejects(api.openAccountPasskeyLogin("beta"), /Account login ownership failed/);
});
