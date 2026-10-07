import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { chatGptSubmissionDomProjection } from "../src/adapters/chatgpt-web/submission-ui";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { selectLauncherPage } from "../src/launcher-browser-host";
import { CHATGPT_USER_TURN_SELECTOR, CHATGPT_ASSISTANT_TURN_SELECTOR, CHATGPT_STOP_BUTTON_SELECTOR } from "../src/chatgpt-session";
const { NativeHostClient } = require("../launcher/native-webview2/host-client.cjs");
const { processSample } = require("../launcher/native-webview2/process-sample.cjs");
const output=resolve(process.env.CHATGPT_RENDER_BUDGET_OUTPUT!);
if(existsSync(join(output,"measurements.json")))throw Error("Preserve prior measurement evidence");
mkdirSync(output,{recursive:true});
const certificate=join(output,"fixture-cert.pem"),key=join(output,"fixture-key.pem");
execFileSync("C:/Program Files/Git/usr/bin/openssl.exe",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",certificate,"-days","1","-subj","/CN=offline-render-fixture","-addext","subjectAltName=DNS:chatgpt.com,DNS:cdn.oaistatic.com,DNS:cdn.segment.com"],{windowsHide:true,stdio:"ignore"});
const html=readFileSync(join(import.meta.dir,"../tests/fixtures/chatgpt-render-budget.html"),"utf8"),font=readFileSync("C:/Windows/Fonts/segoeui.ttf");
const fixture=Bun.serve({hostname:"127.0.0.1",port:0,tls:{cert:readFileSync(certificate),key:readFileSync(key)},fetch:request=>{
 const url=new URL(request.url);
 if(url.pathname==="/c/fixture")return new Response(html,{headers:{"content-type":"text/html"}});
 if(url.pathname.endsWith(".svg"))return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#ccc"/></svg>',{headers:{"content-type":"image/svg+xml"}});
 if(url.pathname.endsWith(".woff2"))return new Response(font,{headers:{"content-type":"font/ttf"}});
 if(url.hostname==="cdn.segment.com")return new Response("window.fixtureAnalyticsLoads++;",{headers:{"content-type":"text/javascript"}});
 if(url.pathname==="/backend-api/conversations")return Response.json({items:Array.from({length:28},(_,i)=>({title:'history '+i+' '+"sidebar ".repeat(30)}))});
 if(url.pathname.startsWith("/backend-api/"))return Response.json({offline:true});
 return new Response("",{status:404});
}});
process.env.CHATGPT_RENDER_FIXTURE_PORT=String(fixture.port);
process.env.CHATGPT_RENDER_FIXTURE_FINGERPRINT=new X509Certificate(readFileSync(certificate)).fingerprint256;
const client=await NativeHostClient.start({executable:process.env.CHATGPT_RENDER_ELECTRON_BINARY!,userDataFolder:join(output,"profile"),bootstrapScript:join(import.meta.dir,"fixtures/render-budget-electron.cjs")});
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
const measurements:any[]=[],releases:any[]=[];
const options={userTurnSelector:CHATGPT_USER_TURN_SELECTOR,assistantTurnSelector:CHATGPT_ASSISTANT_TURN_SELECTOR,stopButtonSelector:CHATGPT_STOP_BUTTON_SELECTOR,attributeFilter:[]};
const scenarios=[
  {name:"baseline",history:false,multipart:false,motion:false,sidebar:false,resources:false},
  {name:"history_multipart",history:true,multipart:true,motion:false,sidebar:false,resources:false},
  {name:"resources_sidebar",history:false,multipart:false,motion:false,sidebar:true,resources:true},
  {name:"motion",history:false,multipart:false,motion:true,sidebar:false,resources:false},
  {name:"combined",history:true,multipart:true,motion:true,sidebar:true,resources:true},
];
try{
 for(const chars of [320000,1000000])for(const scenario of scenarios){
  const id=scenario.name+"_"+chars,tab=await client.addTab({tabId:id,profile:id+(scenario.resources?"_resource":""),url:"https://chatgpt.com/c/fixture?chars="+chars,leased:true});
  browser ??= await chromium.connectOverCDP(client.endpoint);
  const {page}=await selectLauncherPage(browser,{surfaceTargets:{[id]:tab.targetId}} as any,10000,id);
  await page.evaluate(()=> (window as any).fixtureReady);
  const source=await page.locator(".payload").allTextContents(),sourceHash=createHash("sha256").update(source.join("")).digest("hex");
  if(source.join("").length!==chars)throw Error("Fixture source length changed");
  const projected=await page.evaluate(chatGptSubmissionDomProjection,{...options,renderBudget:scenario});
  await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));await Bun.sleep(100);
  const state=await client.snapshot(),pid=state.tabs.find((entry:any)=>entry.tabId===id).rendererPid;
  const before=processSample([pid]),cdp=await page.context().newCDPSession(page);await cdp.send("Performance.enable");
  const metricsBefore=await cdp.send("Performance.getMetrics");
  const observations:number[]=[];
  for(let i=0;i<9;i++){
   // Identical width changes invalidate historical layout, as when opening or
   // resizing the launcher. Source text and the current answer stay unchanged.
   await page.evaluate(width=>{document.querySelector<HTMLElement>("main")!.style.width=width+"px";document.querySelector("main")!.getBoundingClientRect();},i%2?700:680);
   const began=performance.now(),value=await page.evaluate(chatGptSubmissionDomProjection,{...options,knownKey:projected.key,renderBudget:scenario});observations.push(performance.now()-began);
   if(value.bodyTextChars!==projected.bodyTextChars)throw Error("DOM text changed during observation");
  }
  await Bun.sleep(800);const metricsAfter=await cdp.send("Performance.getMetrics"),after=processSample([pid]);
  const row=after.rows.find((entry:any)=>entry.pid===pid),prior=before.rows.find((entry:any)=>entry.pid===pid),elapsedSeconds=(Date.parse(after.at)-Date.parse(before.at))/1000;
  const metric=(list:any,name:string)=>list.metrics.find((entry:any)=>entry.name===name)?.value??0;
  const semantics=await page.evaluate(()=>({source:[...document.querySelectorAll(".payload")].map(el=>el.textContent).join(""),answer:document.querySelector("#current-response")?.textContent,
    draft:document.querySelector("#prompt-textarea")?.textContent,allowed:(window as any).fixtureAllowed,analytics:(window as any).fixtureAnalyticsLoads,animations:document.getAnimations().length,
    currentVisibility:getComputedStyle(document.querySelector("#current-response")!).contentVisibility,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}}));
  const worker:any=Object.create(ChatGptBrowserWorker.prototype),response=await worker.responseDomSnapshot(page.locator('[data-turn-key="fixture_11"]'),{});
  if(response.visibleText!=="final boundary: fixture_tool"||!response.completionActionVisible)throw Error("Current assistant projection changed");
  if(createHash("sha256").update(semantics.source).digest("hex")!==sourceHash||semantics.allowed.length!==5||semantics.answer!=="final boundary: fixture_toolCopy"||semantics.draft!=="Unsent draft"||semantics.currentVisibility!=="visible")throw Error("Render/transport contract changed");
  measurements.push({chars,scenario:scenario.name,rendererPid:pid,runtime:client.runtime.runtimeVersion,viewport:semantics.viewport,sourceHash,bodyTextChars:projected.bodyTextChars,
    memory:{privateBytes:row.privateBytes,workingSetBytes:row.workingSetBytes,jsHeapUsedBytes:metric(metricsAfter,"JSHeapUsedSize")},cpu:{elapsedSeconds,cpuSeconds:row.cpuSeconds-prior.cpuSeconds,averageCores:(row.cpuSeconds-prior.cpuSeconds)/elapsedSeconds},
    domObservation:{samplesMs:observations,medianMs:[...observations].sort((a,b)=>a-b)[4],projectionMs:projected.projectionElapsedMs},
    layoutDurationSeconds:metric(metricsAfter,"LayoutDuration")-metric(metricsBefore,"LayoutDuration"),recalcStyleDurationSeconds:metric(metricsAfter,"RecalcStyleDuration")-metric(metricsBefore,"RecalcStyleDuration"),
    deferredHistoryNodes:projected.deferredHistoryNodes,deferredInputNodes:projected.deferredInputNodes,animationCount:semantics.animations,analyticsLoads:semantics.analytics,
    requestsServed:state.tabs.find((entry:any)=>entry.tabId===id).requestsServed,allSourceTextPreserved:true,currentResponsePreserved:true,currentAssistantProjectionVerified:true,requiredOfflineTransportsSucceeded:5});
  await cdp.detach();const releaseStarted=performance.now();await client.setLease(id,false);await client.request("close",[id,chars===320000?"completed":"failed"]);
  if (!page.isClosed()) await page.waitForEvent("close", { timeout: 5000 });
  await Bun.sleep(350);
  const released=await client.snapshot(),remaining=processSample([pid]);
  releases.push({chars,scenario:scenario.name,status:chars===320000?"completed":"failed",elapsedMs:performance.now()-releaseStarted,rendererPid:pid,rendererStillPresent:remaining.rows.length>0,remainingMemory:remaining.rows,
    normalReleaseEvent:released.events.find((entry:any)=>entry.event==="browser.tab_released"&&entry.details.traceId==="offline_"+id),ownedTabsAfter:released.tabs.length});
  if(released.tabs.length!==0)throw Error("Terminal synthetic tab remained leased");
  writeFileSync(join(output,"partial.json"),JSON.stringify({measurements,releases},null,2));
  console.log(JSON.stringify({chars,scenario:scenario.name,privateMiB:row.privateBytes/1048576,cpuCores:measurements.at(-1).cpu.averageCores,observationMedianMs:measurements.at(-1).domObservation.medianMs,rendererReleased:remaining.rows.length===0}));
 }
}finally{await browser?.close().catch(()=>{});for(const tab of (await client.snapshot()).tabs){await client.setLease(tab.tabId,false);await client.closeTab(tab.tabId);}await client.quit();fixture.stop(true);}
const report={at:new Date().toISOString(),scope:"Single sequential offline Electron run, isolated partitions, identical 320k/1M source payloads and 725x431 DPR1. Nine identical width invalidations/scalar DOM observations plus an 800ms idle window per scenario. Real HTTPS networking remapped to a loopback-only TLS fixture, isolated profile certificate pin, native webRequest budget. A 28-row optional sidebar, 16 SVG decorations, one local font and one analytics script. Renderer-only OS memory/CPU and CDP layout/style metrics; baseline, each item separately, combined, then normal completed/failed tab release. Synthetic optional resources and animation, not authenticated ChatGPT performance or a sustained leak test.",measurements,releases,liveWorkerSends:0,authenticatedNetworkRequests:0,proTestSends:0};
writeFileSync(join(output,"measurements.json"),JSON.stringify(report,null,2));
