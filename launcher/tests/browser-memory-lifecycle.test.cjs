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
