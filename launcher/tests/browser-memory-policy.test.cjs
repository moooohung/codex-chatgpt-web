const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_BROWSER_MEMORY_POLICY,
  applyChromiumMemoryPolicy,
  resolveBrowserMemoryPolicy,
} = require("../electron/browser-memory-policy.cjs");

test("browser memory policy defaults favor idle release and a four-tab queue", () => {
  assert.deepEqual(resolveBrowserMemoryPolicy({}), DEFAULT_BROWSER_MEMORY_POLICY);
  assert.equal(DEFAULT_BROWSER_MEMORY_POLICY.releaseIdleTabMemory, true);
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
