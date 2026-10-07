import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { selectLauncherPage } from "../../src/launcher-browser-host";
const { NativeHostClient } = require("./host-client.cjs");
const outputRoot=resolve(process.env.CHATGPT_NATIVE_COMPARISON_OUTPUT ?? "output/native-webview2-comparison");
mkdirSync(outputRoot,{recursive:true});
const build=JSON.parse(readFileSync(process.env.CHATGPT_NATIVE_BUILD_JSON!,"utf8"));
const fixture=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response('<!doctype html><title>Matched offline fixture</title><pre id="content"></pre>',{headers:{'content-type':'text/html'}})});
const configurations=[{kind:"native",executable:build.executable},{kind:"electron_minimal",executable:resolve("launcher/node_modules/electron/dist/electron.exe"),bootstrapScript:join(import.meta.dir,"electron-comparison.cjs")}];
const measurements:any[]=[];
const privateMemory=(pids:number[])=>{
  if(pids.some(pid=>!Number.isInteger(pid)||pid<1))throw Error('Invalid owned PID list');
  const code='$nativeRows = @(); foreach ($nativeId in @('+pids.join(',')+')) { $nativeProcess = Get-Process -Id $nativeId -ErrorAction SilentlyContinue; if ($nativeProcess) { $nativeRows += @{pid=$nativeId;privateBytes=$nativeProcess.PrivateMemorySize64;workingSetBytes=$nativeProcess.WorkingSet64} } }; ConvertTo-Json -InputObject $nativeRows -Compress';
  return JSON.parse(execFileSync('C:/Program Files/PowerShell/7/pwsh.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true}));
};
try{
 for(const configuration of configurations){
  const client=await NativeHostClient.start({...configuration,userDataFolder:join(outputRoot,'profiles',configuration.kind+'-'+randomBytes(4).toString('hex'))});
  const tabs:string[]=[];let browser;
  try{
   await client.addTab({tabId:'bootstrap',profile:'default',url:'about:blank'});tabs.push('bootstrap');
   browser=await chromium.connectOverCDP(client.endpoint);
   for(let index=0;index<4;index++){
    const id='fixture_'+index, tab=await client.addTab({tabId:id,profile:index%2?'beta':'alpha',url:'http://127.0.0.1:'+fixture.port+'/',leased:true,selected:index===0});tabs.push(id);
    await client.request('bounds',[id,index===0?'0':'-1200','66','725','431','1']);
    const {page}=await selectLauncherPage(browser,{surfaceTargets:{[id]:tab.targetId}} as any,10000,id);
    await page.waitForLoadState('domcontentloaded');
    await page.locator('#content').evaluate(element=>{element.textContent='context line\n'.repeat(92307).padEnd(1200000,'x');});
    await page.locator('#content').evaluate(element=>element.getBoundingClientRect().height);
    const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}));
    if(viewport.width!==725||viewport.height!==431)throw Error(configuration.kind+' comparison viewport mismatch: '+JSON.stringify({viewport,bounds:(await client.snapshot()).tabs.find((entry:any)=>entry.tabId===id)}));
    if(![0,1,3].includes(index))continue;
    const state=await client.snapshot(), memory=privateMemory([...new Set<number>(state.processes.map((entry:any)=>entry.pid))]);
    measurements.push({kind:configuration.kind,tabs:index+1,idleTabs:1,runtime:client.runtime.runtimeVersion,viewport:await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})),bodyTextChars:1200000,processes:memory,hostPrivateBytes:memory.find((entry:any)=>entry.pid===client.pid)?.privateBytes,totalPrivateBytes:memory.reduce((sum:number,entry:any)=>sum+entry.privateBytes,0)});
   }
  }finally{
   await browser?.close().catch(()=>{});
   for(const id of tabs){await client.setLease(id,false).catch(()=>{});await client.closeTab(id).catch(()=>{});}
   await client.quit().catch(()=>client.child.kill());
  }
 }
}finally{fixture.stop(true);}
const result={at:new Date().toISOString(),measurements,scope:'Sequential single-run offline comparison: thin native and thin Electron hosts, one empty bootstrap tab plus 1/2/4 loaded tabs in two profiles. Common Playwright harness, daemon and browser helper excluded. Engine versions differ. This is not a production launcher saving percentage or sustained leak certification.',authenticatedSends:0,proTestSends:0};
writeFileSync(join(outputRoot,'comparison.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({path:join(outputRoot,'comparison.json'),scope:result.scope,measurements:measurements.map(({kind,tabs,hostPrivateBytes,totalPrivateBytes,viewport,runtime})=>({kind,tabs,hostPrivateMiB:Math.round(hostPrivateBytes/1048576*10)/10,totalPrivateMiB:Math.round(totalPrivateBytes/1048576*10)/10,viewport,runtime}))}));
