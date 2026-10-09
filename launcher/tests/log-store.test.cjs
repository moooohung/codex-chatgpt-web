const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const transpile = source => ts.transpileModule(source.replaceAll("import.meta.url", '"file:///launcher/App.tsx"'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
const storeExports = {};
vm.runInNewContext(transpile(fs.readFileSync(path.join(root, "src/log-store.ts"), "utf8")), { exports: storeExports });
const { createLauncherLogStore } = storeExports;
const record = index => ({ at: String(index), level: "info", event: `event-${index}`, detail: {} });

test("Activity receives bounded ordered history accumulated while it was closed", () => {
  const store = createLauncherLogStore();
  store.seed(Array.from({ length: 150 }, (_, i) => record(i)));
  const initial = store.getSnapshot();
  assert.equal(store.getSnapshot(), initial);
  store.append(Array.from({ length: 200 }, (_, i) => record(i + 150)));
  assert.equal(initial.length, 150);
  assert.equal(store.getSnapshot().length, 300);
  assert.equal(store.getSnapshot()[0].event, "event-50");
  assert.equal(store.getSnapshot().at(-1).event, "event-349");
  let updates = 0;
  const unsubscribe = store.subscribe(() => updates++);
  store.append([]);
  assert.equal(updates, 0);
  store.append([record(350), record(351)]);
  assert.equal(updates, 1);
  unsubscribe();
  store.append([record(352)]);
  assert.equal(updates, 1);
  assert.equal(store.getSnapshot().at(-1).event, "event-352");
});

test("background log bursts retain Activity history without scheduling a launcher render", async () => {
  const effects = [], timers = [], stores = [];
  let onLog, renders = 0;
  const api = {
    snapshot: async () => ({ browser: {}, logs: [record(0)], operation: null }),
    onLog: callback => { onLog = callback; return () => {}; },
  };
  for (const method of ["onStateChanged", "onConnectorNamesChanged", "onBrowserState", "onOperation", "onUpdateState"]) {
    api[method] = () => () => {};
  }
  const react = {
    useState: initial => [typeof initial === "function" ? initial() : initial, () => renders++],
    useRef: current => ({ current }),
    useEffect: effect => effects.push(effect),
    useCallback: callback => callback,
  };
  const exported = {};
  vm.runInNewContext(transpile(fs.readFileSync(path.join(root, "src/App.tsx"), "utf8")), {
    exports: exported, URL, window: { codexWebLauncher: api },
    document: { documentElement: {} },
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {},
    require: name => name === "react" ? react : name === "./log-store" ? {
      createLauncherLogStore: () => { const store = createLauncherLogStore(); stores.push(store); return store; },
    } : name === "./utils" ? { isIdleBrowserSurface: () => false }
      : name === "react/jsx-runtime" ? { jsx: () => null, jsxs: () => null } : {},
  });
  exported.App();
  const cleanup = effects.map(effect => effect());
  await Promise.resolve();
  renders = 0;
  for (let i = 1; i <= 500; i++) onLog(record(i));
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(renders, 0);
  assert.equal(stores[0].getSnapshot().length, 300);
  assert.equal(stores[0].getSnapshot()[0].event, "event-201");
  assert.equal(stores[0].getSnapshot().at(-1).event, "event-500");
  for (const dispose of cleanup) dispose?.();
});
