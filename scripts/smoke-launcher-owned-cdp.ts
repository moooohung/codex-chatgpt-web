import { chromium } from "playwright-core";
import { connectLauncherBrowserHost, LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const executablePath = process.env.CODEX_WEB_GPT_TEST_CHROME;
if (!executablePath) throw Error("Set CODEX_WEB_GPT_TEST_CHROME to an installed Chrome/Chromium executable");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request): Response {
  return new Response(new URL(request.url).pathname === "/child" ? "<body>child</body>"
    : '<main><div id="history">'+"synthetic history ".repeat(62500)+'</div><textarea id="composer"></textarea><button id="model">Sol fixture</button><iframe src="http://localhost:'+server.port+'/child"></iframe></main>', { headers: { "content-type": "text/html" } });
} });
const browser = await chromium.launch({ executablePath, headless: true, args: ["--remote-debugging-port=0", "--enable-automation", "--site-per-process"] });
const root = await browser.newBrowserCDPSession();
let scoped;
let descriptorFile: string | undefined;
const results: Record<string, unknown> = { at: new Date().toISOString(), network: "local synthetic HTML only", chatGptMessagesSent: 0 };
try {
  const healthy = await browser.newPage();
  const busy = await browser.newPage();
  await healthy.goto(`http://127.0.0.1:${server.port}/document`);
  await busy.goto("data:text/html,<title>Busy fixture</title>");
  const hs = await healthy.context().newCDPSession(healthy);
  const { targetInfo } = await hs.send("Target.getTargetInfo");
  const bs = await busy.context().newCDPSession(busy);
  const info = await root.send("Browser.getBrowserCommandLine");
  const profileArg = info.arguments.find((arg: string) => arg.startsWith("--user-data-dir="))!;
  const profile = profileArg.slice("--user-data-dir=".length);
  const activePort = await Bun.file(profile+"/DevToolsActivePort").text();
  const [port, wsPath] = activePort.trim().split("\n");
  const endpoint = `ws://127.0.0.1:${port}${wsPath}`;
  // Deliberately occupy one isolated renderer for four seconds; bounded even if
  // the fixture fails, and never touches the user's launcher or any worker.
  const occupied = bs.send("Runtime.evaluate", { expression: "{const end=performance.now()+4000;while(performance.now()<end){};true}" });
  await Bun.sleep(80);
  const globalAt = performance.now();
  try {
    const global = await chromium.connectOverCDP(endpoint, { timeout: 700, noDefaults: true });
    results.global = { connected: true, ms: Math.round(performance.now()-globalAt) }; await global.close();
  } catch (e) { results.global = { connected: false, ms: Math.round(performance.now()-globalAt), timeout: String(e).includes("Timeout") }; }
  const scopedAt=performance.now();
  descriptorFile=join(tmpdir(),`owned-cdp-${randomUUID()}.json`);
  const surfaceId="a".repeat(32);
  writeFileSync(descriptorFile,JSON.stringify({version:3,kind:LAUNCHER_BROWSER_HOST_KIND,profile:"production",pid:process.pid,
    endpoint:`http://127.0.0.1:${port}`,control:{endpoint:`http://127.0.0.1:${port}`,token:"x".repeat(43)},
    helper:{executable:process.execPath,script:resolve(import.meta.path)},partition:"persist:codex-web-gpt-chatgpt",
    idleUrl:LAUNCHER_BROWSER_IDLE_URL,surfaceId,surfaceTargets:{[surfaceId]:targetInfo.targetId},createdAt:new Date().toISOString()}),{mode:0o600});
  const connection=await connectLauncherBrowserHost(descriptorFile,1500,surfaceId);
  scoped=connection.browser;
  const pages = scoped.contexts().flatMap(c=>c.pages());
  if (pages.length!==1) throw Error(`Expected one owned page, received ${pages.length}`);
  const p=pages[0]!;
  const inspection=await p.context().newCDPSession(p);
  const inspected=await inspection.send("Target.getTargetInfo");
  if(inspected.targetInfo.targetId!==targetInfo.targetId)throw Error("Owned target metadata changed");
  await inspection.detach();
  const inputSession=await p.context().newCDPSession(p);
  await inputSession.send("Emulation.setFocusEmulationEnabled",{enabled:true});
  const chars = await p.locator("#history").evaluate(el=>el.textContent!.length);
  await p.locator("#composer").fill("fixture input");
  results.scoped = { connected:true, ms:Math.round(performance.now()-scopedAt), pages:pages.length, historyChars:chars, input:await p.locator("#composer").inputValue(), childFrameText:await p.frames()[1]!.locator("body").textContent() };
  await p.goto(`http://127.0.0.1:${server.port}/document?next`, { waitUntil:"domcontentloaded", timeout:1500 });
  results.navigation = { complete: true, historyChars: await p.locator("#history").evaluate(el=>el.textContent!.length) };
  await occupied;
  await scoped.close(); scoped=undefined;
  results.ownership={busyPageSurvived:!busy.isClosed(),healthyPageSurvived:!healthy.isClosed()};
  if ((results.global as any).connected || (results.scoped as any).historyChars<1_000_000) throw Error("Fixture did not demonstrate stalled-page isolation");
  results.passed=true;
} catch(e){results.error=String(e);results.passed=false;process.exitCode=1;}
finally { await scoped?.close().catch(()=>{}); await browser.close(); server.stop(true); if(descriptorFile)unlinkSync(descriptorFile); }
if (process.env.CODEX_WEB_GPT_TEST_RECEIPT) writeFileSync(process.env.CODEX_WEB_GPT_TEST_RECEIPT,JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
