const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_BROWSER_MEMORY_POLICY,
  applyChromiumMemoryPolicy,
  resolveBrowserMemoryPolicy,
  rendererMemorySnapshot,
  retainedTabReleaseReason,
} = require("../electron/browser-memory-policy.cjs");

test("browser memory policy defaults favor idle release and a four-tab queue", () => {
  assert.deepEqual(resolveBrowserMemoryPolicy({}), DEFAULT_BROWSER_MEMORY_POLICY);
  assert.equal(DEFAULT_BROWSER_MEMORY_POLICY.releaseIdleTabMemory, true);
  assert.equal(DEFAULT_BROWSER_MEMORY_POLICY.idleTabTimeoutMs, 60_000);
  assert.equal(DEFAULT_BROWSER_MEMORY_POLICY.throttleIdleTabs, true);
  assert.equal(DEFAULT_BROWSER_MEMORY_POLICY.maxTabs, 4);
  assert.equal(DEFAULT_BROWSER_MEMORY_POLICY.recycleAfterTurns, 8);
  assert.equal(DEFAULT_BROWSER_MEMORY_POLICY.recycleRendererMb, 512);
  assert.equal(DEFAULT_BROWSER_MEMORY_POLICY.disableBackForwardCache, true);
  assert.equal(DEFAULT_BROWSER_MEMORY_POLICY.disableGpu, false);
  assert.equal(DEFAULT_BROWSER_MEMORY_POLICY.rendererJsHeapMb, 0);
});

test("browser memory policy accepts bounded overrides and ignores invalid values", () => {
  assert.deepEqual(resolveBrowserMemoryPolicy({
    CODEX_WEB_GPT_RELEASE_IDLE_TAB_MEMORY: "off",
    CODEX_WEB_GPT_RECYCLE_AFTER_TURNS: "12",
    CODEX_WEB_GPT_RECYCLE_RENDERER_MB: "768",
    CODEX_WEB_GPT_MAX_BROWSER_TABS: "6",
    CODEX_WEB_GPT_DISABLE_BFCACHE: "0",
    CODEX_WEB_GPT_DISABLE_GPU: "yes",
    CODEX_WEB_GPT_RENDERER_JS_HEAP_MB: "640",
  }), {
    ...DEFAULT_BROWSER_MEMORY_POLICY,
    releaseIdleTabMemory: false,
    recycleAfterTurns: 12,
    recycleRendererMb: 768,
    maxTabs: 6,
    disableBackForwardCache: false,
    disableGpu: true,
    rendererJsHeapMb: 640,
  });
  assert.equal(resolveBrowserMemoryPolicy({ CODEX_WEB_GPT_MAX_BROWSER_TABS: "99" }).maxTabs, 4);
  assert.equal(resolveBrowserMemoryPolicy({ CODEX_WEB_GPT_RECYCLE_AFTER_TURNS: "invalid" }).recycleAfterTurns, 8);
});

test("all memory controls can be disabled and invalid settings keep bounded defaults", () => {
  const policy = resolveBrowserMemoryPolicy({
    CODEX_WEB_GPT_RELEASE_IDLE_TAB_MEMORY: "false", CODEX_WEB_GPT_IDLE_TAB_TIMEOUT_MS: "0",
    CODEX_WEB_GPT_RECYCLE_AFTER_TURNS: "0", CODEX_WEB_GPT_RECYCLE_RENDERER_MB: "0",
    CODEX_WEB_GPT_DISABLE_BFCACHE: "off", CODEX_WEB_GPT_DISABLE_GPU: "off",
    CODEX_WEB_GPT_RENDERER_JS_HEAP_MB: "0", CODEX_WEB_GPT_THROTTLE_IDLE_TABS: "false",
  });
  assert.equal(policy.idleTabTimeoutMs, 0);
  assert.equal(policy.throttleIdleTabs, false);
  const switches = [];
  applyChromiumMemoryPolicy({ commandLine: { appendSwitch: (...args) => switches.push(args) } }, policy);
  assert.deepEqual(switches, []);
  const tab = { interactionMode: "automatic", status: "ready", memoryIdleSince: 0, retainedTurnCount: 99, rendererMemory: { privateMiB: 2048 } };
  assert.equal(retainedTabReleaseReason(tab, policy, 999_999), null);
  for (const value of ["-1", "1.5", "Infinity", "NaN", "1800001"]) {
    assert.equal(resolveBrowserMemoryPolicy({ CODEX_WEB_GPT_IDLE_TAB_TIMEOUT_MS: value }).idleTabTimeoutMs, 60_000);
  }
});

test("Chromium flags preserve existing features and an explicit heap policy", () => {
  const switches = new Map([["disable-features", "ExistingFeature"], ["js-flags", "--expose-gc --max_old_space_size=1024"]]);
  const commandLine = { getSwitchValue: key => switches.get(key) || "", appendSwitch: (key, value) => switches.set(key, value) };
  applyChromiumMemoryPolicy({ commandLine }, { ...DEFAULT_BROWSER_MEMORY_POLICY, rendererJsHeapMb: 512 });
  assert.equal(switches.get("disable-features"), "ExistingFeature,BackForwardCache");
  assert.equal(switches.get("js-flags"), "--expose-gc --max_old_space_size=1024");
  applyChromiumMemoryPolicy({ commandLine });
  assert.equal(switches.get("disable-features"), "ExistingFeature,BackForwardCache");
});

test("renderer sampling binds an OS PID to Electron metrics and converts KiB to MiB", () => {
  const contents = { isDestroyed: () => false, getOSProcessId: () => 42 };
  const metrics = [
    { pid: 9, memory: { privateBytes: 999999 } },
    { pid: 42, memory: { privateBytes: 600 * 1024, workingSetSize: 550 * 1024 } },
  ];
  assert.deepEqual(rendererMemorySnapshot(contents, metrics), { pid: 42, privateMiB: 600, workingSetMiB: 550 });
  assert.equal(rendererMemorySnapshot(contents, []), null);
  assert.equal(rendererMemorySnapshot({ isDestroyed: () => true }, metrics), null);
  assert.equal(rendererMemorySnapshot({ isDestroyed: () => false }, metrics), null);
  assert.equal(rendererMemorySnapshot({ isDestroyed: () => false, getOSProcessId: () => { throw new Error("gone"); } }, metrics), null);
});

test("idle release waits for the grace period and never releases running, manual, or visible tabs", () => {
  const tab = { interactionMode: "automatic", status: "ready", memoryIdleSince: 1000, retainedTurnCount: 1 };
  const policy = DEFAULT_BROWSER_MEMORY_POLICY;
  assert.equal(retainedTabReleaseReason(tab, policy, 60999), null);
  assert.equal(retainedTabReleaseReason(tab, policy, 61000), "idle_release");
  assert.equal(retainedTabReleaseReason(tab, policy, 61000, true), null);
  assert.equal(retainedTabReleaseReason({ ...tab, status: "running" }, policy, 999999), null);
  assert.equal(retainedTabReleaseReason({ ...tab, interactionMode: "manual" }, policy, 999999), null);
  assert.equal(retainedTabReleaseReason({ ...tab, memoryIdleSince: undefined }, policy, 999999), null);
});

test("turn-count and memory recycling work independently when ordinary idle release is disabled", () => {
  const policy = { ...DEFAULT_BROWSER_MEMORY_POLICY, releaseIdleTabMemory: false };
  const tab = { interactionMode: "automatic", status: "ready", memoryIdleSince: 0, retainedTurnCount: 7 };
  assert.equal(retainedTabReleaseReason(tab, policy, 60000), null);
  assert.equal(retainedTabReleaseReason({ ...tab, retainedTurnCount: 8 }, policy, 60000), "turn_count");
  assert.equal(retainedTabReleaseReason({ ...tab, rendererMemory: { privateMiB: 512 } }, policy, 60000), "renderer_memory");
  assert.equal(retainedTabReleaseReason({ ...tab, rendererMemory: { privateMiB: null, workingSetMiB: 600 } }, policy, 60000), "renderer_memory");
  assert.equal(retainedTabReleaseReason({ ...tab, rendererMemory: null }, policy, 60000), null);
  assert.equal(retainedTabReleaseReason({ ...tab, rendererMemory: { privateMiB: NaN } }, policy, 60000), null);
});

test("Chromium memory switches are applied only when their policy enables them", () => {
  const switches = [];
  let gpuDisabled = false;
  const app = {
    disableHardwareAcceleration: () => { gpuDisabled = true; },
    commandLine: { appendSwitch: (name, value) => switches.push([name, value]) },
  };
  applyChromiumMemoryPolicy(app, {
    ...DEFAULT_BROWSER_MEMORY_POLICY,
    disableGpu: true,
    rendererJsHeapMb: 512,
  });
  assert.equal(gpuDisabled, true);
  assert.deepEqual(switches, [
    ["disable-features", "BackForwardCache"],
    ["js-flags", "--max-old-space-size=512"],
  ]);
});
