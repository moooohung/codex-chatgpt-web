/* Isolated Electron fixture only: no production profile, account, or network requests. */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { app, BrowserWindow, WebContentsView } = require("electron");
const { BrowserHost } = require("../launcher/electron/browser-host.cjs");
const { resolveBrowserMemoryPolicy, applyChromiumMemoryPolicy, rendererMemorySnapshot } = require("../launcher/electron/browser-memory-policy.cjs");

const output = process.argv[2];
const scenario = process.argv[3] || "default";
if (!output || !path.isAbsolute(output)) throw new Error("Pass an absolute isolated output directory");
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, `profile-${scenario}`));
const switches = {
  "gpu-off": { CODEX_WEB_GPT_DISABLE_GPU: "true" },
  "heap512": { CODEX_WEB_GPT_RENDERER_JS_HEAP_MB: "512" },
  "bfcache-off": { CODEX_WEB_GPT_DISABLE_BFCACHE: "false" },
  "idle-throttle-off": { CODEX_WEB_GPT_THROTTLE_IDLE_TABS: "false" },
};
const policy = applyChromiumMemoryPolicy(app, resolveBrowserMemoryPolicy(switches[scenario] || {}));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { console.error("ISOLATED_MEMORY_SMOKE_TIMEOUT"); app.exit(1); }, 90000);
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true } });
  const events = [], samples = [], errors = [];
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    window, turnTabs: new Map(), selectedTabId: "home", visible: false, surfaceActive: false,
    memoryPolicy: policy, userCancelledTurnOwners: new Map(), closedTurnOwners: new Map(),
    logger: { info: (event, detail) => events.push({event, detail}), warn: (event, detail) => events.push({event, detail}) },
    syncPowerSaveBlocker() {}, syncViewVisibility() {}, snapshot: () => ({}), writeDescriptor() {},
    getProcessMetrics: () => app.getAppMetrics(),
  });
  let tab;
  const context = [];
  for (let turn = 1; turn <= 4; turn++) {
    if (!tab || !host.turnTabs.has(tab.id)) {
      const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true,
        partition: `memory-smoke-${scenario}`, backgroundThrottling: false } });
      window.contentView.addChildView(view);
      view.setBounds({x:0,y:0,width:800,height:600});
      view.webContents.on("console-message", event => { if (event.level === "error" || event.level >= 3) errors.push(event.message); });
      await view.webContents.loadURL("data:text/html,<button id='send'>Send</button><pre id='history'></pre><script>document.querySelector('button').onclick=()=>{document.querySelector('pre').textContent=JSON.stringify(globalThis.requestContext);globalThis.heap=new Float64Array(3000000);globalThis.heap.fill(0.5);globalThis.backing=new Uint8Array(96*1024*1024);globalThis.backing.fill(1)};</script>");
      tab = { id: `fixture-${turn}`, view, traceId: `turn-${turn}`, helperPid: process.pid,
        interactionMode: "automatic", conversationKey: "same-thread", accountName: "isolated-fixture",
        status: "running", bootstrapReady: true, lastHeartbeatAt: Date.now() };
      host.turnTabs.set(tab.id, tab);
    }
    tab.status = "running";
    tab.memoryIdleSince = undefined;
    tab.traceId = `turn-${turn}`;
    tab.view.webContents.setBackgroundThrottling(false);
    context.push(`request-${turn}`);
    const contents = tab.view.webContents;
    const answer = await contents.executeJavaScript(`globalThis.requestContext=${JSON.stringify(context)};document.querySelector('#send').click();document.querySelector('#history').textContent`);
    assert.deepEqual(JSON.parse(answer), context, "full fixture context must survive renderer recreation");
    host.reapExpiredTurnTabs(Date.now());
    assert.equal(contents.isDestroyed(), false, "active renderer must stay alive");
    await sleep(150);
    const before = rendererMemorySnapshot(contents, app.getAppMetrics());
    await host.endTurn(tab.traceId, process.pid, "completed", false, undefined, true, false);
    // Advance only the reaper's injected clock; never delay or manipulate a live launcher.
    host.lastTurnSweepAt = undefined;
    host.reapExpiredTurnTabs(tab.memoryIdleSince + policy.idleTabTimeoutMs);
    assert.equal(host.turnTabs.has(tab.id), false, "reaper must relinquish the tab before native closure settles");
    const closeDeadline = Date.now() + 3000;
    while (!contents.isDestroyed() && Date.now() < closeDeadline) await sleep(25);
    assert.equal(contents.isDestroyed(), true, "idle renderer must close");
    await sleep(300);
    samples.push({ turn, before, contentsDestroyed: contents.isDestroyed(),
      formerPidStillPresent: app.getAppMetrics().some(metric => metric.pid === before?.pid),
      appWorkingSetMiB: app.getAppMetrics().reduce((sum, metric) => sum + (metric.memory?.workingSetSize || 0) / 1024, 0) });
  }
  assert.equal(errors.length, 0);
  const evidence = { status: "passed", scenario, electron: process.versions.electron, chromium: process.versions.chrome,
    policy, samples, events, consoleErrors: errors, authenticatedChatGpt: false, networkRequests: false };
  fs.writeFileSync(path.join(output, `electron-${scenario}.json`), JSON.stringify(evidence, null, 2));
  window.destroy();
  clearTimeout(watchdog);
  console.log(`ISOLATED_MEMORY_SMOKE_OK ${scenario}`);
  app.exit(0);
}).catch(error => {
  fs.writeFileSync(path.join(output, `electron-${scenario}-error.txt`), String(error.stack || error));
  console.error(error);
  clearTimeout(watchdog);
  app.exit(1);
});
