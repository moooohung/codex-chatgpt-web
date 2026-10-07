import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright-core";
import { selectLauncherPage } from "../../src/launcher-browser-host";
const { NativeHostClient } = require("./host-client.cjs");
const { processSample } = require("./process-sample.cjs");
const outputRoot=resolve(process.env.CHATGPT_NATIVE_COMPARISON_OUTPUT ?? "output/native-webview2-comparison");
mkdirSync(outputRoot,{recursive:true});
const build=JSON.parse(readFileSync(process.env.CHATGPT_NATIVE_BUILD_JSON!,"utf8"));
const fixture=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response('<!doctype html><title>Matched offline fixture</title><pre id="content"></pre>',{headers:{'content-type':'text/html'}})});
const configurations=[{kind:"native",executable:build.executable},{kind:"electron_minimal",executable:resolve(process.env.CHATGPT_ELECTRON_COMPARISON_BINARY ?? "launcher/node_modules/electron/dist/electron.exe"),bootstrapScript:join(import.meta.dir,"electron-comparison.cjs")}];
const measurements:any[]=[];
const timing=(samples:number[])=>{const ordered=[...samples].sort((a,b)=>a-b);return {samplesMs:samples,medianMs:ordered[Math.floor(ordered.length/2)],maxMs:ordered.at(-1)};};
if(existsSync(join(outputRoot,'comparison.json')))throw Error('Preserve the previous comparison; choose a new output directory');
try{
 for(const configuration of configurations){
  const startup=performance.now();
  const client=await NativeHostClient.start({...configuration,userDataFolder:join(outputRoot,'profiles',configuration.kind+'-'+randomBytes(4).toString('hex'))});
  const hostReadyMs=performance.now()-startup;
  const tabs:string[]=[];let browser,firstDocumentReadyMs:number|undefined;
  try{
   await client.addTab({tabId:'bootstrap',profile:'default',url:'about:blank'});tabs.push('bootstrap');
   await client.request('bounds',['bootstrap','0','66','725','431','1']);
   browser=await chromium.connectOverCDP(client.endpoint);
   const {page:bootstrap}=await selectLauncherPage(browser,{surfaceTargets:{bootstrap:(await client.snapshot()).tabs.find((entry:any)=>entry.tabId==='bootstrap').targetId}} as any,10000,'bootstrap');
   const record=async(phase:string,loadedTabs:number,page:any)=>{
    const observationMs:number[]=[],selectionMs:number[]=[];
    let viewport:any,observedChars=0;
    for(let sample=0;sample<7;sample++){
      const began=performance.now();
      const value=await page.evaluate(()=>({chars:(document.body?.textContent||'').length,width:innerWidth,height:innerHeight,dpr:devicePixelRatio}));
      observationMs.push(performance.now()-began);viewport={width:value.width,height:value.height,dpr:value.dpr};observedChars=value.chars;
    }
    if(loadedTabs){
      if(observedChars!==1200000||viewport.width!==725||viewport.height!==431)throw Error('Matched fixture dimensions or text changed');
      for(let sample=0;sample<7;sample++){
        const began=performance.now();await client.selectTab('fixture_0');await page.evaluate(()=>innerWidth);selectionMs.push(performance.now()-began);
      }
    }
    const state=await client.snapshot(),pids=[...new Set<number>(state.processes.map((entry:any)=>entry.pid))];
    const before=processSample(pids);await Bun.sleep(1000);const after=processSample(pids);
    const elapsedSeconds=(Date.parse(after.at)-Date.parse(before.at))/1000;
    const common=after.rows.filter((entry:any)=>before.rows.some((prior:any)=>prior.pid===entry.pid));
    const cpuSeconds=common.reduce((sum:number,entry:any)=>sum+Math.max(0,entry.cpuSeconds-before.rows.find((prior:any)=>prior.pid===entry.pid).cpuSeconds),0);
    const memory=after.rows;
    measurements.push({kind:configuration.kind,phase,tabs:loadedTabs,idleTabs:1,runtime:client.runtime.runtimeVersion,viewport,
      bodyTextChars:observedChars,hostReadyMs,firstDocumentReadyMs,processes:memory,hostPrivateBytes:memory.find((entry:any)=>entry.pid===client.pid)?.privateBytes,
      totalPrivateBytes:memory.reduce((sum:number,entry:any)=>sum+entry.privateBytes,0),observation:timing(observationMs),
      selection:selectionMs.length?timing(selectionMs):null,idleCpu:{elapsedSeconds,cpuSeconds,averageCores:cpuSeconds/elapsedSeconds,
        sampledProcesses:common.length,treeProcesses:pids.length},ownedTabs:state.tabs.map((entry:any)=>entry.tabId)});
   };
   await record('idle',0,bootstrap);
   for(let index=0;index<4;index++){
    const documentStarted=performance.now();
    const id='fixture_'+index, tab=await client.addTab({tabId:id,profile:index%2?'beta':'alpha',url:'http://127.0.0.1:'+fixture.port+'/',leased:true,selected:index===0});tabs.push(id);
    await client.request('bounds',[id,index===0?'0':'-1200','66','725','431','1']);
    const {page}=await selectLauncherPage(browser,{surfaceTargets:{[id]:tab.targetId}} as any,10000,id);
    await page.waitForLoadState('domcontentloaded');
    await page.locator('#content').evaluate(element=>{element.textContent='context line\n'.repeat(92307).padEnd(1200000,'x');});
    await page.locator('#content').evaluate(element=>element.getBoundingClientRect().height);
    if(index===0)firstDocumentReadyMs=performance.now()-documentStarted;
    const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}));
    if(viewport.width!==725||viewport.height!==431)throw Error(configuration.kind+' comparison viewport mismatch: '+JSON.stringify({viewport,bounds:(await client.snapshot()).tabs.find((entry:any)=>entry.tabId===id)}));
    if(![0,1,3].includes(index))continue;
    const {page:firstPage}=await selectLauncherPage(browser,{surfaceTargets:{first:(await client.snapshot()).tabs.find((entry:any)=>entry.tabId==='fixture_0').targetId}} as any,10000,'first');
    await record('loaded',index+1,firstPage);
   }
   for(const id of tabs.slice(1)){await client.setLease(id,false);await client.closeTab(id);}
   tabs.splice(1);await Bun.sleep(1000);await record('released',0,bootstrap);
  }finally{
   await browser?.close().catch(()=>{});
   for(const id of tabs){await client.setLease(id,false).catch(()=>{});await client.closeTab(id).catch(()=>{});}
   await client.quit().catch(()=>client.child.kill());
  }
 }
}finally{fixture.stop(true);}
const result={at:new Date().toISOString(),measurements,buildSha256:build.sha256,scope:'Sequential single-run offline comparison: thin native and thin Electron hosts; idle, one empty bootstrap tab plus 1/2/4 loaded 1.2-million-character pre elements in two profiles, and after closing all four fixture controllers. Seven scalar DOM observations and selection round trips per loaded phase, short idle CPU samples. First-document time covers controller creation, fixture navigation, text assignment and forced layout. Common Playwright harness, full menu backend, daemon and browser helper excluded. Engine versions differ. This is not ChatGPT latency, a production launcher saving percentage or sustained leak certification.',authenticatedSends:0,proTestSends:0};
writeFileSync(join(outputRoot,'comparison.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({path:join(outputRoot,'comparison.json'),scope:result.scope,measurements:measurements.map(({kind,phase,tabs,hostPrivateBytes,totalPrivateBytes,viewport,runtime,observation,selection,idleCpu})=>({kind,phase,tabs,hostPrivateMiB:Math.round(hostPrivateBytes/1048576*10)/10,totalPrivateMiB:Math.round(totalPrivateBytes/1048576*10)/10,viewport,runtime,observationMedianMs:observation.medianMs,selectionMedianMs:selection?.medianMs,idleCpu}))}));
