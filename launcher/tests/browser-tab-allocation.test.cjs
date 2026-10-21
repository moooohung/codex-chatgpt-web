const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Exercise the production allocation method, including its await boundaries, without
// starting Chromium, opening an authenticated session, or sending any messages.
const views = [];
class TestView {
  constructor(options) {
    this.options = options;
    this.closed = false;
    this.webContents = {
      session: {}, isDestroyed: () => this.closed,
      close: () => { this.closed = true; }, setZoomFactor() {},
    };
    views.push(this);
  }
}
const load = Module._load;
let BrowserHost;
try {
  Module._load = function (name, ...args) {
    if (name === "electron") return {
      session: { fromPartition: () => ({}) }, WebContentsView: TestView,
    };
    return load.call(this, name, ...args);
  };
  ({ BrowserHost } = require("../electron/browser-host.cjs"));
} finally {
  Module._load = load;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  views.length = 0;
  return Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map(), memoryPolicy: { maxTabs: 8 }, partition: "test-only",
    state: { zoomFactor: 1 }, selectedTabId: "home", closedTurnOwners: new Map(),
    resolveAccountForConversation: () => null,
    configureLocalePreferences: async () => {},
    syncPowerSaveBlocker() {}, presentTurnView() {}, bindShellZoomShortcuts() {},
    bindTurnContents() {}, commitAccountBinding() {}, syncViewVisibility() {},
    writeDescriptor() {}, publishState() {}, snapshot: () => ({}),
    window: { contentView: { addChildView() {}, removeChildView() {} } },
    initializeTurnTab: async () => {},
  });
}

test("a burst of 32 pending initializations cannot exceed eight renderer slots", async () => {
  const host = fixture(), locale = deferred();
  host.configureLocalePreferences = () => locale.promise;
  const jobs = Array.from({ length: 32 }, (_, i) =>
    host.createTurnTab(`trace-${i}`, process.pid, `conversation-${i}`));
  const settled = Promise.allSettled(jobs);
  locale.resolve();
  const results = await settled;
  assert.equal(results.filter(item => item.status === "fulfilled").length, 8);
  assert.equal(results.filter(item => item.status === "rejected"
    && item.reason.code === "browser_tab_limit").length, 24);
  assert.equal(host.turnTabs.size, 8);
  assert.equal(views.length, 8, "overflow must not create a hidden renderer");
  assert.deepEqual([...host.turnTabs.values()].map(tab => tab.ordinal).sort(), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("a manual tab cannot take an ordinal reserved by a pending automatic initialization", async () => {
  const host = fixture(), locale = deferred();
  host.memoryPolicy.maxTabs = 1;
  host.configureLocalePreferences = () => locale.promise;
  const starting = host.createTurnTab("automatic", process.pid);
  let rejection;
  try { host.allocateTabOrdinal(); } catch (error) { rejection = error; }
  locale.resolve();
  await starting;
  assert.equal(rejection?.code, "browser_tab_limit");
});

test("aborting while locale configuration is pending closes only the pending tab", async () => {
  const host = fixture(), locale = deferred(), controller = new AbortController();
  host.configureLocalePreferences = () => locale.promise;
  let initialized = false;
  host.initializeTurnTab = async () => { initialized = true; };
  const starting = host.createTurnTab("aborted", process.pid, undefined, undefined, controller.signal);
  controller.abort(new Error("cancel pending initialization"));
  await assert.rejects(starting, /cancel pending initialization/);
  locale.resolve();
  assert.equal(host.turnTabs.size, 0);
  assert.equal(views[0]?.closed, true);
  assert.equal(initialized, false);
  assert.equal(host.allocateTabOrdinal(), 1);
});

test("repeated bursts and completed releases do not accumulate views or lose capacity", async () => {
  const host = fixture();
  for (let cycle = 0; cycle < 20; cycle++) {
    const locale = deferred();
    host.configureLocalePreferences = () => locale.promise;
    const settled = Promise.allSettled(Array.from({ length: 16 }, (_, i) =>
      host.createTurnTab(`cycle-${cycle}-${i}`, process.pid)));
    locale.resolve();
    const results = await settled;
    assert.equal(results.filter(item => item.status === "fulfilled").length, 8);
    assert.equal(host.turnTabs.size, 8);
    for (const tab of [...host.turnTabs.values()]) host.removeTurnTab(tab, false);
    assert.equal(host.turnTabs.size, 0);
    assert.equal(views.filter(view => !view.closed).length, 0);
  }
});

test("partial native view setup and initialization failures release their exact renderer slot", async () => {
  for (const stage of ["addChildView", "presentTurnView", "bindTurnContents", "initializeTurnTab", "commitAccountBinding"]) {
    const host = fixture();
    const fail = () => { throw new Error(`failed ${stage}`); };
    if (stage === "addChildView") host.window.contentView.addChildView = fail;
    else host[stage] = fail;
    await assert.rejects(host.createTurnTab(`failure-${stage}`, process.pid), /failed/);
    assert.equal(host.turnTabs.size, 0, stage);
    assert.equal(views[0].closed, true, stage);
    assert.equal(host.allocateTabOrdinal(), 1, stage);
  }
});

test("automated initial and recycled views disable spell checking of machine-generated payloads", async () => {
  const host = fixture();
  await host.createTurnTab("initial", process.pid);
  host.createAutomaticTurnView("test-recycle");
  assert.equal(views.length, 2);
  for (const view of views) {
    assert.equal(view.options.webPreferences.spellcheck, false);
    assert.equal(view.options.webPreferences.backgroundThrottling, false);
    assert.equal(view.options.webPreferences.sandbox, true);
    assert.equal(view.options.webPreferences.nodeIntegration, false);
    assert.equal(view.options.webPreferences.contextIsolation, true);
  }
});
