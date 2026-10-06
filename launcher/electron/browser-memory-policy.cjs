const DEFAULT_BROWSER_MEMORY_POLICY = Object.freeze({
  releaseIdleTabMemory: true,
  idleTabTimeoutMs: 60_000,
  recycleAfterTurns: 8,
  recycleRendererMb: 512,
  maxTabs: 4,
  disableBackForwardCache: true,
  disableGpu: false,
  rendererJsHeapMb: 0,
  throttleIdleTabs: true,
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
    idleTabTimeoutMs: integerSetting(env, "CODEX_WEB_GPT_IDLE_TAB_TIMEOUT_MS", 60_000, 0, 1_800_000),
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
    throttleIdleTabs: booleanSetting(env, "CODEX_WEB_GPT_THROTTLE_IDLE_TABS", true),
  };
}

// appendSwitch replaces a value, so preserve independently configured Chromium features/flags.
function appendSwitchValue(commandLine, name, value, separator) {
  const previous = commandLine.getSwitchValue?.(name) || "";
  const values = previous.split(separator).filter(Boolean);
  if (!values.includes(value)) values.push(value);
  commandLine.appendSwitch(name, values.join(separator));
}

function applyChromiumMemoryPolicy(app, policy = resolveBrowserMemoryPolicy()) {
  if (policy.disableGpu) app.disableHardwareAcceleration();
  if (policy.disableBackForwardCache) appendSwitchValue(app.commandLine, "disable-features", "BackForwardCache", ",");
  if (policy.rendererJsHeapMb > 0) {
    // An explicit pre-existing heap policy wins over this optional default.
    const existing = app.commandLine.getSwitchValue?.("js-flags") || "";
    if (!/--max[-_]old[-_]space[-_]size(?:=|\s)/.test(existing)) {
      appendSwitchValue(app.commandLine, "js-flags", `--max-old-space-size=${policy.rendererJsHeapMb}`, " ");
    }
  }
  return policy;
}

function rendererMemorySnapshot(contents, metrics) {
  try {
    if (!contents || contents.isDestroyed() || typeof contents.getOSProcessId !== "function") return null;
    const pid = contents.getOSProcessId();
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const memory = metrics.find(metric => metric.pid === pid)?.memory;
    if (!memory) return null;
    const mib = value => Number.isFinite(value) && value >= 0 ? value / 1024 : null;
    return { pid, privateMiB: mib(memory.privateBytes), workingSetMiB: mib(memory.workingSetSize) };
  } catch { return null; }
}

function retainedTabRecycleReason(tab, policy) {
  if (tab.interactionMode !== "automatic" || tab.status !== "ready") return null;
  const memoryMiB = tab.rendererMemory?.privateMiB ?? tab.rendererMemory?.workingSetMiB;
  if (policy.recycleRendererMb > 0 && Number.isFinite(memoryMiB) && memoryMiB >= policy.recycleRendererMb) return "renderer_memory";
  if (policy.recycleAfterTurns > 0 && (tab.retainedTurnCount ?? 0) >= policy.recycleAfterTurns) return "turn_count";
  return null;
}

function retainedTabReleaseReason(tab, policy, now, visible = false) {
  if (tab.interactionMode !== "automatic" || tab.status !== "ready" || visible
    || !Number.isFinite(tab.memoryIdleSince) || now - tab.memoryIdleSince < policy.idleTabTimeoutMs) return null;
  return retainedTabRecycleReason(tab, policy) ?? (policy.releaseIdleTabMemory ? "idle_release" : null);
}

module.exports = {
  DEFAULT_BROWSER_MEMORY_POLICY,
  applyChromiumMemoryPolicy,
  resolveBrowserMemoryPolicy,
  rendererMemorySnapshot,
  retainedTabReleaseReason,
  retainedTabRecycleReason,
};
