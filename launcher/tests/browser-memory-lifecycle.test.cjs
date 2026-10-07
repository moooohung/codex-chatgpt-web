const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { BrowserHost, IDLE_BROWSER_URL } = require("../electron/browser-host.cjs");

function fixture(url = "https://chatgpt.com/c/saved") {
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, getURL: () => url,
    loadURL: async next => { url = next; },
    getProcessMemoryInfo: async () => ({ private: 100 * 1024 }),
    setBackgroundThrottling() {},
  });
  const tab = { id: "tab", surfaceId: "surface", traceId: "old_trace", helperPid: process.pid,
    conversationKey: "a".repeat(64), interactionMode: "automatic", status: "running",
    view: { webContents: contents } };
  const events = [];
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]), manualOperation: null,
    userCancelledTurnOwners: new Map(), closedTurnOwners: new Map(), selectedTabId: "another",
    memoryPolicy: { releaseIdleTabMemory: true, recycleAfterTurns: 8, recycleRendererMb: 512, maxTabs: 4 },
    resolveAccountForConversation: () => null, markTurnTabSurface: async () => {},
    syncPowerSaveBlocker() {}, writeDescriptor() {}, presentTurnView() {}, syncViewVisibility() {},
    publishState() {}, snapshot: () => ({}),
    logger: { info: (...args) => events.push(args), warn: (...args) => events.push(args) },
  });
  return { host, tab, contents, events, url: () => url };
}

function presentationFixture() {
  const f = fixture(IDLE_BROWSER_URL);
  Object.assign(f.tab, { status: "ready", memorySuspended: true,
    retainedUrl: "https://chatgpt.com/c/saved" });
  Object.assign(f.host, { visible: true, surfaceActive: true, boundsReady: true,
    window: { isVisible: () => true, isMinimized: () => false }, setState() {},
    syncViewVisibility() { this.restoreSelectedRetainedTab(); } });
  f.contents.focus = () => {};
  return f;
}

test("selecting a parked tab restores only that exact conversation and coalesces visibility updates", async () => {
  const f = presentationFixture();
  const unused = { ...f.tab, id: "unused", traceId: "unused_trace" };
  f.host.turnTabs.set(unused.id, unused);
  const loads = [];
  const originalLoad = f.contents.loadURL;
  f.contents.loadURL = async next => { loads.push(next); return originalLoad(next); };
  assert.deepEqual(f.host.selectTab(f.tab.id), {}, "selection keeps its synchronous snapshot contract");
  const restore = f.tab.memoryTransition;
  assert.equal(f.host.restoreSelectedRetainedTab(), restore);
  f.host.setSurfaceActive(true);
  await restore;
  assert.deepEqual(loads, ["https://chatgpt.com/c/saved"]);
  assert.equal(f.tab.memorySuspended, false);
  assert.equal(unused.memorySuspended, true);
  assert.equal(f.tab.status, "ready");
  assert.equal(f.tab.traceId, "old_trace");
});

test("tray and surface restoration is lazy until the selected browser is actually visible", async () => {
  for (const hiddenBy of ["window", "minimized", "surface", "bounds", "browser", "authentication", "operation"]) {
    const f = presentationFixture();
    f.host.selectedTabId = f.tab.id;
    if (hiddenBy === "window") f.host.window.isVisible = () => false;
    if (hiddenBy === "minimized") f.host.window.isMinimized = () => true;
    if (hiddenBy === "surface") f.host.surfaceActive = false;
    if (hiddenBy === "bounds") f.host.boundsReady = false;
    if (hiddenBy === "browser") f.host.visible = false;
    if (hiddenBy === "authentication") f.host.authView = {};
    if (hiddenBy === "operation") f.host.manualOperation = "session-refresh";
    assert.equal(f.host.restoreSelectedRetainedTab(), undefined, hiddenBy);
    assert.equal(f.url(), IDLE_BROWSER_URL);
    Object.assign(f.host, { visible: true, surfaceActive: true, boundsReady: true, authView: null, manualOperation: null });
    f.host.window.isVisible = () => true;
    f.host.window.isMinimized = () => false;
    await f.host.restoreSelectedRetainedTab();
    assert.equal(f.url(), "https://chatgpt.com/c/saved", hiddenBy);
  }
});

test("presentation never navigates running, manual, or already restored tabs", () => {
  for (const kind of ["running", "manual", "restored"]) {
    const f = presentationFixture();
    f.host.selectedTabId = f.tab.id;
    if (kind === "running") f.tab.status = "running";
    if (kind === "manual") f.tab.interactionMode = "manual";
    if (kind === "restored") f.tab.memorySuspended = false;
    f.contents.loadURL = () => { throw new Error("must not navigate"); };
    assert.equal(f.host.restoreSelectedRetainedTab(), undefined, kind);
  }
});

test("switching tabs or closing the selected tab during idle release cancels its presentation restore", async () => {
  for (const action of ["switch", "close"]) {
    const f = presentationFixture();
    f.host.selectedTabId = f.tab.id;
    let release;
    f.tab.memoryTransition = new Promise(resolve => { release = resolve; });
    const restore = f.host.restoreSelectedRetainedTab();
    if (action === "switch") f.host.selectedTabId = "home";
    else f.host.turnTabs.delete(f.tab.id);
    release();
    await restore;
    assert.equal(f.url(), IDLE_BROWSER_URL, action);
    assert.equal(f.tab.memorySuspended, true, action);
  }
});

test("a worker waiting for release also waits for a newly queued presentation restore", async () => {
  const f = presentationFixture();
  f.host.selectedTabId = f.tab.id;
  let release, restored;
  f.tab.memoryTransition = new Promise(resolve => { release = resolve; });
  const starting = f.host.beginTurn("next_trace", false, process.pid, f.tab.conversationKey, undefined, true);
  const originalLoad = f.contents.loadURL;
  let loads = 0;
  f.contents.loadURL = async next => {
    loads++;
    await new Promise(resolve => { restored = resolve; });
    return originalLoad(next);
  };
  const presenting = f.host.restoreSelectedRetainedTab();
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.tab.traceId, "old_trace", "worker cannot claim the tab until UI navigation commits");
  assert.equal(loads, 1);
  restored();
  await presenting;
  const lease = await starting;
  assert.equal(lease.reused, true);
  assert.equal(f.tab.traceId, "next_trace");
  assert.equal(loads, 1, "worker reuses the restored document");
});

test("a presentation failure keeps the saved conversation and permits an explicit retry without looping", async () => {
  const f = presentationFixture();
  let loads = 0;
  const originalLoad = f.contents.loadURL;
  f.contents.loadURL = async next => {
    if (++loads === 1) throw new Error("offline");
    return originalLoad(next);
  };
  f.host.selectTab(f.tab.id);
  await f.tab.memoryTransition;
  assert.equal(f.tab.presentationRestoreFailed, true);
  assert.equal(f.tab.retainedUrl, "https://chatgpt.com/c/saved");
  assert.equal(f.tab.status, "ready", "completed result and worker continuation remain available");
  assert.equal(f.host.restoreSelectedRetainedTab(), undefined);
  assert.equal(loads, 1);
  assert.ok(f.events.some(([event]) => event === "browser.tab_presentation_restore_failed"));
  f.host.selectTab(f.tab.id);
  await f.tab.memoryTransition;
  assert.equal(f.url(), "https://chatgpt.com/c/saved");
  assert.equal(loads, 2);
});

test("hidden viewports are capped without collapsing or overlapping a large launcher window", () => {
  for (const [width, height] of [[3840, 2160], [1528, 812], [0, 0]]) {
    const f = fixture();
    f.host.window = { getContentSize: () => [width, height] };
    const hidden = f.host.hiddenTurnBounds();
    assert.ok(hidden.width >= 800 && hidden.width <= 1280);
    assert.ok(hidden.height >= 600 && hidden.height <= 900);
    assert.ok(hidden.x > width && hidden.y > height);
  }
});

test("identical surface measurements do not repeat native layout or resize scripts, but window changes still update hidden views", () => {
  const f = fixture();
  let width = 1600, layouts = 0, resizeScripts = 0;
  f.host.window = { getContentSize: () => [width, 900] };
  f.host.view = { webContents: { executeJavaScript: async () => { resizeScripts++; } } };
  f.host.syncViewVisibility = () => { layouts++; };
  const bounds = { x: 300, y: 100, width: 900, height: 600 };
  for (let i = 0; i < 60; i++) f.host.setBounds(bounds);
  assert.equal(layouts, 1);
  assert.equal(resizeScripts, 1);
  width = 1700;
  f.host.setBounds(bounds);
  assert.equal(layouts, 2, "offscreen placement follows the resized window too");
  f.host.setBounds({ ...bounds, width: 950 });
  assert.equal(layouts, 3);
  assert.equal(resizeScripts, 3);
});

test("idle release preserves temporary and unknown conversations in their existing document", async () => {
  for (const url of ["https://chatgpt.com/?temporary-chat=true", "https://chatgpt.com/c/temp?temporary-chat=true",
    "https://example.com/c/foreign", "about:blank"]) {
    const f = fixture(url);
    let loads = 0;
    f.contents.loadURL = async () => { loads++; };
    assert.equal(await f.host.suspendRetainedTurnTab(f.tab), false);
    assert.equal(loads, 0);
    assert.equal(f.tab.memorySuspended, undefined);
  }
});

test("a new turn waits for idle release and then restores the same conversation exactly once", async () => {
  const f = fixture();
  let release;
  let loads = 0;
  const originalLoad = f.contents.loadURL;
  f.contents.loadURL = async next => {
    loads++;
    if (next === IDLE_BROWSER_URL) await new Promise(resolve => { release = resolve; });
    return originalLoad(next);
  };
  const ending = f.host.endTurn("old_trace", process.pid, "completed", false, undefined, true);
  await new Promise(resolve => setImmediate(resolve));
  const starting = f.host.beginTurn("next_trace", false, process.pid, f.tab.conversationKey, undefined, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.tab.traceId, "old_trace");
  assert.equal(loads, 1);
  release();
  await ending;
  const lease = await starting;
  assert.equal(lease.tabId, "tab");
  assert.equal(lease.reused, true);
  assert.equal(loads, 2);
  assert.equal(f.url(), "https://chatgpt.com/c/saved");
  assert.equal(f.tab.traceId, "next_trace");
  assert.equal(f.tab.status, "running");
});

test("restoring a retained renderer reserves ownership before navigation can block", async () => {
  const f = fixture(IDLE_BROWSER_URL);
  f.tab.status = "ready";
  f.tab.memorySuspended = true;
  f.tab.retainedUrl = "https://chatgpt.com/c/saved";
  let restore;
  const originalLoad = f.contents.loadURL;
  f.contents.loadURL = async next => {
    await new Promise(resolve => { restore = resolve; });
    return originalLoad(next);
  };
  const first = f.host.beginTurn("first_trace", false, process.pid, f.tab.conversationKey, undefined, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.tab.status, "running");
  await assert.rejects(f.host.beginTurn("second_trace", false, process.pid, f.tab.conversationKey, undefined, true),
    error => error.code === "retained_conversation_unavailable");
  assert.equal(f.tab.traceId, "first_trace");
  restore();
  await first;
});

test("cancelling while memory is being released cannot claim or evict the old owner's tab", async () => {
  const f = fixture();
  f.tab.status = "ready";
  let finish;
  f.tab.memoryTransition = new Promise(resolve => { finish = resolve; });
  const controller = new AbortController();
  const pending = f.host.beginTurn("cancelled_trace", false, process.pid, f.tab.conversationKey, undefined, true, controller.signal);
  controller.abort(new Error("cancelled memory wait"));
  await assert.rejects(pending, /cancelled memory wait/);
  assert.equal(f.host.evictOldestRetainedTurnTab(), false);
  assert.equal(f.tab.traceId, "old_trace");
  finish();
});

test("failed optional idle navigation preserves the completed result and its saved restore URL", async () => {
  const f = fixture();
  f.contents.loadURL = async () => { throw new Error("navigation failed"); };
  assert.deepEqual(await f.host.endTurn("old_trace", process.pid, "completed", false, undefined, true), { cancelledByUser: false });
  assert.equal(f.tab.status, "ready");
  assert.equal(f.tab.memorySuspended, true);
  assert.equal(f.tab.retainedUrl, "https://chatgpt.com/c/saved");
  assert.equal(f.tab.memoryTransition, undefined);
  assert.ok(f.events.some(([event]) => event === "browser.tab_memory_suspend_failed"));
});

test("an unresponsive renderer memory probe has a bounded optional budget", async () => {
  const f = fixture();
  f.contents.getProcessMemoryInfo = () => new Promise(() => {});
  assert.equal(await f.host.turnRendererPrivateMb(f.tab), null);
});

test("renderer memory thresholds use Electron app metrics for the exact OS PID", async () => {
  const f = fixture();
  f.contents.getOSProcessId = () => 123;
  f.contents.getProcessMemoryInfo = undefined;
  f.host.getAppMetrics = () => [
    { pid: 999, memory: { privateBytes: 999 * 1024 } },
    { pid: 123, memory: { privateBytes: 640 * 1024 } },
  ];
  assert.equal(await f.host.turnRendererPrivateMb(f.tab), 640);
  await f.host.suspendRetainedTurnTab(f.tab);
  assert.equal(f.tab.recycleOnResume, true);
});
