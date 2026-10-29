const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { BrowserHost, IDLE_BROWSER_URL } = require("../electron/browser-host.cjs");

const FAKE_ACCOUNT_CONTEXT = Object.freeze({ accountKey: "a".repeat(64), planType: "plus" });

async function readFakeAccountContext(browserSession) {
  assert.ok(browserSession && [...this.turnTabs.values()].some(tab => (
    tab.status === "running" && tab.interactionMode === "automatic"
    && tab.view?.webContents.session === browserSession
  )), "account proof must read the owned automatic tab's session");
  return FAKE_ACCOUNT_CONTEXT;
}

function fixture(url = "https://chatgpt.com/c/saved") {
  const contents = Object.assign(new EventEmitter(), {
    session: {}, isDestroyed: () => false, getURL: () => url,
    loadURL: async next => { url = next; },
    getProcessMemoryInfo: async () => ({ private: 100 * 1024 }),
    setBackgroundThrottling() {},
  });
  const tab = { id: "tab", surfaceId: "surface", traceId: "old_trace", helperPid: process.pid,
    conversationKey: "a".repeat(64), interactionMode: "automatic", status: "running",
    useTemporaryChats: false,
    view: { webContents: contents } };
  const events = [];
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]), manualOperation: null,
    userCancelledTurnOwners: new Map(), closedTurnOwners: new Map(), selectedTabId: "another",
    memoryPolicy: { releaseIdleTabMemory: true, recycleAfterTurns: 8, recycleRendererMb: 512, maxTabs: 4 },
    resolveAccountForConversation: () => null, markTurnTabSurface: async () => {},
    conversationLoadState: async () => "loaded",
    readAccountContext: readFakeAccountContext,
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

test("hidden viewports retain the measured browser pane without collapsing or overlapping the launcher", () => {
  for (const [width, height] of [[3840, 2160], [1528, 812], [0, 0]]) {
    const f = fixture();
    f.host.window = { getContentSize: () => [width, height] };
    f.host.boundsReady = width > 0;
    f.host.bounds = { width: Math.max(800, width - 320), height: Math.max(600, height - 80) };
    const hidden = f.host.hiddenTurnBounds();
    assert.equal(hidden.width, f.host.bounds.width);
    assert.equal(hidden.height, f.host.bounds.height);
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

test("temporary and unknown-mode /c/ documents stay in memory for retained continuation", async () => {
  for (const mode of [true, undefined]) {
    const f = fixture("https://chatgpt.com/c/temporary-without-query");
    f.tab.useTemporaryChats = mode;
    f.host.getUseTemporaryChats = () => false; // A later setting cannot make this document durable.
    f.host.memoryPolicy.recycleAfterTurns = 1;
    f.host.memoryPolicy.recycleRendererMb = 1;
    const loads = [];
    f.contents.loadURL = async next => { loads.push(next); };
    assert.deepEqual(await f.host.endTurn("old_trace", process.pid, "completed", false, undefined, true),
      { cancelledByUser: false });
    assert.equal(f.tab.status, "ready");
    assert.equal(f.tab.memorySuspended, undefined);
    const lease = await f.host.beginTurn("continuation", false, process.pid, f.tab.conversationKey, undefined, true);
    assert.equal(lease.reused, true);
    assert.equal(lease.tabId, f.tab.id);
    assert.deepEqual(lease.accountContext, FAKE_ACCOUNT_CONTEXT);
    assert.equal(f.tab.view.webContents, f.contents);
    assert.deepEqual(loads, [], "retained continuation must not reload a temporary conversation");
  }
});

test("observed temporary navigation stays non-restorable after ChatGPT removes the query", async () => {
  for (const event of ["did-start-navigation", "did-navigate-in-page"]) {
    const f = fixture();
    f.contents.setWindowOpenHandler = () => {};
    f.host.bindTurnContents(f.tab);
    const navigate = url => event === "did-start-navigation"
      ? f.contents.emit(event, {}, url, false, true) : f.contents.emit(event, {}, url, true);
    navigate("https://chatgpt.com/?temporary-chat=true");
    await f.contents.loadURL("https://chatgpt.com/c/temporary-without-query");
    navigate(f.url());
    assert.equal(f.tab.useTemporaryChats, true, event);
    assert.equal(await f.host.suspendRetainedTurnTab(f.tab), false, event);
    assert.equal(f.url(), "https://chatgpt.com/c/temporary-without-query", event);
  }
});

test("idle release rechecks chat durability after the asynchronous memory probe", async () => {
  for (const change of ["temporary", "another conversation", "destroyed"]) {
    const f = fixture();
    f.contents.getProcessMemoryInfo = async () => {
      if (change === "temporary") f.tab.useTemporaryChats = true;
      if (change === "another conversation") await f.contents.loadURL("https://chatgpt.com/c/another");
      if (change === "destroyed") f.contents.isDestroyed = () => true;
      return { private: 600 * 1024 };
    };
    assert.equal(await f.host.suspendRetainedTurnTab(f.tab), false, change);
    assert.notEqual(f.url(), IDLE_BROWSER_URL, change);
    assert.equal(f.tab.memorySuspended, undefined, change);
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

test("recycling a retained renderer keeps the replacement when the old page reports destruction", async () => {
  // 2026-10-24 live log: tab_memory_suspended (renderer_memory, recycleOnResume) was followed on
  // the next turn by tab_closed_externally + "Browser closed during idle document bootstrap":
  // the OLD page's destroyed/render-gone listeners removed the tab, closing the replacement.
  for (const signal of ["destroyed", "render-process-gone", "did-fail-load"]) {
    const f = fixture(IDLE_BROWSER_URL);
    Object.assign(f.tab, { status: "ready", memorySuspended: true, recycleOnResume: true,
      retainedUrl: "https://chatgpt.com/c/saved", accountName: "alpha", partition: "persist:test-alpha",
      connectorIdentity: "Codex Native2", connectorBound: true });
    f.host.resolveAccountForConversation = () => "alpha";
    f.host.getUseTemporaryChats = () => true; // Existing saved documents keep their creation mode.
    f.host.accountCapabilities = new Map([
      ["alpha", { ...FAKE_ACCOUNT_CONTEXT, checkedAt: Date.now(), extraHighAvailable: false }],
      ["beta", { accountKey: "b".repeat(64), planType: "pro", checkedAt: Date.now(), extraHighAvailable: true }],
    ]);
    let oldDestroyed = false;
    f.contents.isDestroyed = () => oldDestroyed;
    f.contents.setWindowOpenHandler = () => {};
    f.contents.close = () => {
      if (signal === "render-process-gone") f.contents.emit(signal, {}, { reason: "killed", exitCode: 1 });
      if (signal === "did-fail-load") f.contents.emit(signal, {}, -2, "closed", "https://chatgpt.com/c/saved", true);
      oldDestroyed = true;
      f.contents.emit("destroyed");
    };
    f.host.bindTurnContents(f.tab); // the live bindings the old renderer carries
    let url = IDLE_BROWSER_URL;
    const replacement = Object.assign(new EventEmitter(), {
      session: {}, isDestroyed: () => false, getURL: () => url,
      loadURL: async next => { url = next; }, setZoomFactor() {}, setWindowOpenHandler() {},
      getProcessMemoryInfo: async () => ({ private: 100 * 1024 }), setBackgroundThrottling() {},
      close() { throw new Error("the replacement renderer must stay open"); },
    });
    Object.assign(f.host, {
      window: { contentView: {
        addChildView(view, index) {
          assert.equal(view.webContents, replacement);
          assert.equal(index, 0, "recycled browser stays below launcher notices");
        },
        removeChildView() {},
      } },
      state: { zoomFactor: 1 }, bindShellZoomShortcuts() {},
    });
    f.host.logger.error = (...args) => f.events.push(args);
    // restoreRetainedTurnTab calls the prototype method directly (Electron's View is absent here).
    const createView = BrowserHost.prototype.createAutomaticTurnView;
    BrowserHost.prototype.createAutomaticTurnView = partition => {
      assert.equal(partition, "persist:test-alpha", "renderer recycling keeps its leased account partition");
      return { webContents: replacement };
    };
    let lease;
    try {
      lease = await f.host.beginTurn("next_trace", false, process.pid, f.tab.conversationKey, "Codex Native2", true);
    } finally {
      BrowserHost.prototype.createAutomaticTurnView = createView;
    }
    assert.equal(lease.reused, true, signal);
    assert.equal(lease.connectorBound, true, signal);
    assert.deepEqual(lease.accountContext, { ...FAKE_ACCOUNT_CONTEXT, extraHighAvailable: false }, signal);
    assert.equal(f.tab.accountName, "alpha", signal);
    assert.equal(f.tab.connectorIdentity, "Codex Native2", signal);
    assert.equal(f.tab.view.webContents, replacement, signal);
    assert.equal(url, "https://chatgpt.com/c/saved", signal);
    assert.equal(f.host.turnTabs.get("tab"), f.tab, signal);
    assert.equal(f.tab.status, "running", signal);
    f.contents.emit("did-start-navigation", {}, "https://chatgpt.com/?temporary-chat=true", false, true);
    f.contents.emit("did-navigate-in-page", {}, "https://chatgpt.com/?temporary-chat=true", true);
    assert.equal(f.tab.useTemporaryChats, false, "retired page events cannot change replacement durability");
    assert.ok(f.events.some(([event]) => event === "browser.tab_renderer_recycled"), signal);
    assert.ok(!f.events.some(([event]) => ["browser.tab_closed_externally", "browser.tab_renderer_gone",
      "browser.tab_navigation_failed"].includes(event)), signal);
  }
});

// Live 2026-10-28: a memory-recycled tab reopened /c/<id> to "Could not load this ChatGPT
// conversation"; the committed document passed restore and the next turn found no composer.
function loadFailureFixture({ suspended }) {
  const f = fixture(suspended ? IDLE_BROWSER_URL : "https://chatgpt.com/c/saved");
  Object.assign(f.tab, { status: "ready" },
    suspended ? { memorySuspended: true, retainedUrl: "https://chatgpt.com/c/saved" } : {});
  f.contents.close = () => {};
  f.host.syncPowerSaveBlocker = () => {};
  f.host.window = { contentView: { removeChildView() {} } };
  f.host.conversationLoadState = async tab => tab === f.tab ? "failed" : "loaded";
  const fresh = Object.assign(new EventEmitter(), {
    session: {}, isDestroyed: () => false, getURL: () => "https://chatgpt.com/",
    setBackgroundThrottling() {},
  });
  const created = [];
  f.host.createTurnTab = async (traceId, helperPid, conversationKey, connectorIdentity) => {
    const tab = { id: "fresh", surfaceId: "fresh_surface", traceId, helperPid, conversationKey, connectorIdentity,
      interactionMode: "automatic", status: "running", view: { webContents: fresh } };
    f.host.turnTabs.set(tab.id, tab);
    created.push(tab);
    return tab;
  };
  return { ...f, created };
}

test("a lost temporary renderer never restores its /c/ URL and only an ordinary new turn gets a fresh tab", async () => {
  for (const mode of [true, undefined]) {
    for (const recycleOnResume of [false, true]) {
      for (const required of [false, true]) {
        const f = loadFailureFixture({ suspended: true });
        Object.assign(f.tab, { useTemporaryChats: mode, recycleOnResume });
        let loads = 0;
        f.contents.loadURL = async () => { loads++; throw new Error("must never restore temporary /c/"); };
        f.host.conversationLoadState = async () => { throw new Error("must not inspect the lost document"); };
        const starting = f.host.beginTurn("next_trace", false, process.pid, f.tab.conversationKey, undefined, required);
        if (required) {
          await assert.rejects(starting, { code: "retained_conversation_unavailable" });
          assert.equal(f.created.length, 0, "incremental continuation must fail without a fresh submission");
        } else {
          const lease = await starting;
          assert.equal(lease.reused, false);
          assert.equal(lease.tabId, "fresh");
          assert.equal(f.created.length, 1, "full-context turn can use one fresh document");
        }
        assert.equal(loads, 0);
        assert.equal(f.host.turnTabs.has("tab"), false);
      }
    }
  }
});

test("saved-mode restore rejects foreign, temporary and malformed conversation URLs before navigation", async () => {
  for (const url of ["https://example.com/c/saved", "https://chatgpt.com/c/saved?temporary-chat=true",
    "https://chatgpt.com/", "https://chatgpt.com/c/", "https://chatgpt.com/c/id/extra", undefined]) {
    const f = fixture(IDLE_BROWSER_URL);
    Object.assign(f.tab, { memorySuspended: true, recycleOnResume: true, retainedUrl: url });
    f.contents.loadURL = () => { throw new Error("must not navigate"); };
    await assert.rejects(f.host.restoreRetainedTurnTab(f.tab), { code: "retained_conversation_unavailable" });
    assert.equal(f.tab.view.webContents, f.contents, "invalid restore cannot allocate a replacement");
    assert.equal(f.tab.memorySuspended, true);
  }
});

test("losing a running temporary document never invokes the fresh-tab recovery path", async () => {
  for (const required of [false, true]) {
    const f = loadFailureFixture({ suspended: false });
    Object.assign(f.tab, { status: "running", useTemporaryChats: true });
    f.contents.isDestroyed = () => true;
    await assert.rejects(f.host.beginTurn(f.tab.traceId, false, process.pid, f.tab.conversationKey, undefined, required),
      { code: "account_context_lease_lost" });
    assert.equal(f.created.length, 0, "an in-flight message may already have been accepted");
    assert.ok(!f.events.some(([event]) => event === "browser.retained_conversation_replaced"));
  }
});

test("an ordinary turn replaces a retained tab that shows ChatGPT's load-failure card with a new tab", async () => {
  for (const suspended of [true, false]) {
    const f = loadFailureFixture({ suspended });
    const lease = await f.host.beginTurn("next_trace", false, process.pid, f.tab.conversationKey, undefined, false);
    assert.equal(lease.reused, false, `suspended=${suspended}`);
    assert.equal(lease.tabId, "fresh");
    assert.equal(f.created.length, 1);
    assert.equal(f.host.turnTabs.has("tab"), false, "the broken document is never reused");
    const replaced = f.events.find(([event]) => event === "browser.retained_conversation_replaced");
    assert.ok(replaced, `suspended=${suspended}`);
    assert.equal(replaced[1].traceId, "next_trace");
  }
});

test("a turn that requires the retained conversation still fails closed on the load-failure card", async () => {
  for (const suspended of [true, false]) {
    const f = loadFailureFixture({ suspended });
    await assert.rejects(
      f.host.beginTurn("compaction_trace", false, process.pid, f.tab.conversationKey, undefined, true),
      error => error.code === "retained_conversation_unavailable"
        && /Could not load this ChatGPT conversation/.test(error.message));
    assert.equal(f.created.length, 0);
    assert.equal(f.host.turnTabs.has("tab"), false);
  }
});

test("a restored conversation that is still rendering is reused once it loads", async () => {
  const f = loadFailureFixture({ suspended: true });
  const states = ["pending", "pending", "loaded"];
  f.host.conversationLoadState = async () => states.shift();
  const lease = await f.host.beginTurn("next_trace", false, process.pid, f.tab.conversationKey, undefined, false);
  assert.equal(lease.reused, true);
  assert.equal(lease.tabId, "tab");
  assert.equal(states.length, 0);
  assert.equal(f.tab.memorySuspended, false);
});

test("showing a parked tab that ChatGPT cannot load keeps it parked for the next turn", async () => {
  const f = presentationFixture();
  f.host.conversationLoadState = async () => "failed";
  f.host.selectTab(f.tab.id);
  await f.tab.memoryTransition;
  assert.equal(f.tab.presentationRestoreFailed, true);
  assert.equal(f.tab.memorySuspended, true, "the next turn restores or replaces it");
  assert.equal(f.tab.retainedUrl, "https://chatgpt.com/c/saved");
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
