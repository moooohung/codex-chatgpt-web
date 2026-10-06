// Synthetic renderer lifecycle measurement. Its private session serves every HTTPS request
// locally; no signed-in browser, ChatGPT request, account, or existing application is touched.
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const output = path.resolve(process.argv[2] || "output/offline-browser-memory.json");

if (!process.versions.electron) {
  const { spawn } = require("node:child_process");
  const executable = require(path.resolve(__dirname, "../launcher/node_modules/electron"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [__filename, output], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  child.stderr.on("data", data => { errors = (errors + data).slice(-2_000); });
  child.stdout.on("data", () => {});
  child.on("error", error => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", code => {
    process.exitCode = code ?? 1;
    if (code !== 0) console.error(errors);
    else console.log(fs.readFileSync(output, "utf8"));
  });
  return;
}

const { app, BrowserWindow, WebContentsView, session } = require("electron");
const { BrowserHost, IDLE_BROWSER_URL } = require("../launcher/electron/browser-host.cjs");
const { applyChromiumMemoryPolicy } = require("../launcher/electron/browser-memory-policy.cjs");
fs.mkdirSync(path.dirname(output), { recursive: true });
app.setPath("userData", path.join(path.dirname(output), "offline-electron-userdata"));
const policy = applyChromiumMemoryPolicy(app);
const timeout = setTimeout(() => app.exit(1), 45_000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const partition = `offline-bridge-memory-${randomUUID()}`;
  const local = session.fromPartition(partition);
  let requests = 0;
  await local.protocol.handle("https", request => {
    requests++;
    if (new URL(request.url).origin !== "https://chatgpt.com") return new Response("", { status: 403 });
    return new Response('<!doctype html><title>Offline bridge memory fixture</title><div contenteditable="true" id="composer"></div>',
      { headers: { "content-type": "text/html" } });
  });
  const window = new BrowserWindow({ show: false, width: 800, height: 600 });
  const view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true,
    nodeIntegration: false, backgroundThrottling: false } });
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  const tab = { id: "offline-tab", traceId: "offline-trace", partition, retainedTurnCount: 7, view };
  const events = [];
  const host = Object.assign(Object.create(BrowserHost.prototype), { window, state: { zoomFactor: 1 },
    partition, memoryPolicy: policy, getAppMetrics: () => app.getAppMetrics(),
    writeDescriptor() {}, bindShellZoomShortcuts() {}, bindTurnContents() {},
    markTurnTabSurface: async () => {},
    presentTurnView: candidate => candidate.view.setBounds({ x: 0, y: 0, width: 800, height: 600 }),
    logger: { info: (event, detail) => events.push({ event, detail }), warn() {} } });
  const measure = label => {
    const pid = tab.view.webContents.getOSProcessId();
    const metrics = app.getAppMetrics();
    const renderer = metrics.find(metric => metric.pid === pid);
    return { label, rendererPid: pid, rendererPrivateMb: (renderer?.memory?.privateBytes ?? 0) / 1024,
      rendererWorkingSetMb: (renderer?.memory?.workingSetSize ?? 0) / 1024,
      totalPrivateMb: metrics.reduce((sum, metric) => sum + (metric.memory.privateBytes ?? 0), 0) / 1024 };
  };
  await view.webContents.loadURL("https://chatgpt.com/c/offline-memory-fixture");
  const samples = [measure("empty_fixture")];
  for (let turn = 1; turn <= 3; turn++) {
    await view.webContents.executeJavaScript(`(() => { globalThis.retainedBuffers ??= []; const block = new Uint8Array(48 * 1024 * 1024); block.fill(${turn}); globalThis.retainedBuffers.push(block); document.getElementById('composer').textContent = 'x'.repeat(318208); })()`);
    await sleep(250);
    samples.push(measure(`synthetic_turn_${turn}`));
  }
  const baseline = samples.at(-1);
  const measuredByPolicy = await host.turnRendererPrivateMb(tab);
  if (!await host.suspendRetainedTurnTab(tab)) throw new Error("offline saved fixture did not suspend");
  await sleep(500);
  samples.push(measure("idle_document"));
  if (tab.view.webContents.getURL() !== IDLE_BROWSER_URL) throw new Error("idle surface mismatch");
  if (!await host.restoreRetainedTurnTab(tab)) throw new Error("offline saved fixture did not restore");
  await sleep(250);
  if (await tab.view.webContents.executeJavaScript("document.title") !== "Offline bridge memory fixture") throw new Error("fixture restore failed");
  samples.push(measure("recycled_restored_fixture"));
  const idle = samples.find(sample => sample.label === "idle_document");
  const result = { kind: "synthetic_offline_electron_lifecycle", electronVersion: process.versions.electron,
    policy, requestsHandledLocally: requests, measuredByPolicyMb: measuredByPolicy, samples, events,
    rendererReductionMb: baseline.rendererPrivateMb - idle.rendererPrivateMb,
    totalPrivateReductionMb: baseline.totalPrivateMb - idle.totalPrivateMb,
    limits: "Synthetic retained buffers and composer; not live ChatGPT savings, send recovery, or temporary-conversation reload proof." };
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  clearTimeout(timeout);
  window.destroy();
  app.exit(0);
}).catch(error => {
  fs.writeFileSync(output, JSON.stringify({ error: error.message }));
  console.error(error);
  app.exit(1);
});
