const DEFAULT_BROWSER_MEMORY_POLICY = Object.freeze({
  releaseIdleTabMemory: true,
  recycleAfterTurns: 8,
  recycleRendererMb: 512,
  maxTabs: 4,
  disableBackForwardCache: true,
  disableGpu: false,
  rendererJsHeapMb: 0,
});

function booleanSetting(env, name, fallback) {
  const raw = env?.[name];
  if (raw === undefined || raw === "") return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  return fallback;
}

function integerSetting(env, name, fallback, minimum, maximum) {
  const raw = env?.[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

function resolveBrowserMemoryPolicy(env = process.env) {
  return {
    releaseIdleTabMemory: booleanSetting(
      env,
      "CODEX_WEB_GPT_RELEASE_IDLE_TAB_MEMORY",
      DEFAULT_BROWSER_MEMORY_POLICY.releaseIdleTabMemory,
    ),
    recycleAfterTurns: integerSetting(
      env,
      "CODEX_WEB_GPT_RECYCLE_AFTER_TURNS",
      DEFAULT_BROWSER_MEMORY_POLICY.recycleAfterTurns,
      0,
      10_000,
    ),
    recycleRendererMb: integerSetting(
      env,
      "CODEX_WEB_GPT_RECYCLE_RENDERER_MB",
      DEFAULT_BROWSER_MEMORY_POLICY.recycleRendererMb,
      0,
      16_384,
    ),
    maxTabs: integerSetting(
      env,
      "CODEX_WEB_GPT_MAX_BROWSER_TABS",
      DEFAULT_BROWSER_MEMORY_POLICY.maxTabs,
      1,
      8,
    ),
    disableBackForwardCache: booleanSetting(
      env,
      "CODEX_WEB_GPT_DISABLE_BFCACHE",
      DEFAULT_BROWSER_MEMORY_POLICY.disableBackForwardCache,
    ),
    disableGpu: booleanSetting(
      env,
      "CODEX_WEB_GPT_DISABLE_GPU",
      DEFAULT_BROWSER_MEMORY_POLICY.disableGpu,
    ),
    rendererJsHeapMb: integerSetting(
      env,
      "CODEX_WEB_GPT_RENDERER_JS_HEAP_MB",
      DEFAULT_BROWSER_MEMORY_POLICY.rendererJsHeapMb,
      0,
      4096,
    ),
  };
}

function applyChromiumMemoryPolicy(app, policy = resolveBrowserMemoryPolicy()) {
  if (policy.disableGpu) app.disableHardwareAcceleration();
  if (policy.disableBackForwardCache) app.commandLine.appendSwitch("disable-features", "BackForwardCache");
  if (policy.rendererJsHeapMb > 0) {
    app.commandLine.appendSwitch("js-flags", `--max-old-space-size=${policy.rendererJsHeapMb}`);
  }
  return policy;
}

module.exports = {
  DEFAULT_BROWSER_MEMORY_POLICY,
  applyChromiumMemoryPolicy,
  resolveBrowserMemoryPolicy,
};
