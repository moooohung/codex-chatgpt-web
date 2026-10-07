// Isolated offline Electron host. HTTPS names resolve only to the pinned local
// fixture server; no authenticated ChatGPT page is contacted.
const { app, BrowserWindow, WebContentsView, session } = require("electron");
const { createInterface } = require("node:readline");
const { createServer } = require("node:http");
const { randomBytes, X509Certificate } = require("node:crypto");
const { BrowserHost } = require("../../launcher/electron/browser-host.cjs");
const { bindBrowserResourceBudget } = require("../../launcher/electron/browser-resource-budget.cjs");
const args=process.argv, argument=name=>args[args.indexOf(name)+1];
app.setPath("userData", argument("--user-data-folder"));
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.commandLine.appendSwitch("remote-debugging-port", argument("--fixture-cdp-port"));
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("no-proxy-server");
const fixtureHosts=["chatgpt.com","cdn.oaistatic.com","cdn.segment.com"];
if(!/^\d+$/.test(process.env.CHATGPT_RENDER_FIXTURE_PORT??""))throw Error("Missing offline HTTPS fixture");
app.commandLine.appendSwitch("host-resolver-rules",fixtureHosts.map(name=>`MAP ${name} 127.0.0.1:${process.env.CHATGPT_RENDER_FIXTURE_PORT}`).join(",")+",MAP * ~NOTFOUND");
const tabs=new Map(), requests=new Map(), events=[];
let window, closing=false;
const host={turnTabs:tabs,closedTurnOwners:new Map(),userCancelledTurnOwners:new Map(),
  syncPowerSaveBlocker(){},syncViewVisibility(){},snapshot:()=>({}),writeDescriptor(){},
  logger:{info:(event,details)=>events.push({event,details}),warn(){}},
  removeTurnTab(tab,abort){BrowserHost.prototype.removeTurnTab.call(this,tab,abort);},
};
const emit=value=>{process.stdout.write(JSON.stringify(value)+"\n");return value;};
async function command(line){
  const [operation,rawId,...fields]=line.split("\t"),id=Number(rawId);
  try{
    let result={};
    if(operation==="add"){
      const [tabId,profile,encodedUrl,leased]=fields, partition=session.fromPartition("persist:"+profile);
      requests.set(tabId,{});
      partition.setCertificateVerifyProc((request,callback)=>{
        let matches=false;
        try{matches=fixtureHosts.includes(request.hostname)&&new X509Certificate(request.certificate.data).fingerprint256===process.env.CHATGPT_RENDER_FIXTURE_FINGERPRINT;}catch{}
        callback(matches?0:-2);
      });
      partition.webRequest.onCompleted({urls:["https://*/*"]},details=>{
        const counts=requests.get(tabId),pathname=new URL(details.url).pathname;counts[pathname]=(counts[pathname]??0)+1;
      });
      if(profile.includes("resource"))bindBrowserResourceBudget(partition,contentsId=>{
        const tab=[...tabs.values()].find(item=>item.view.webContents.id===contentsId);
        return tab?{...tab,documentUrl:tab.view.webContents.getURL()}:null;
      },{});
      const view=new WebContentsView({webPreferences:{session:partition,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
      const tab={id:tabId,view,profile,leased:leased==="1",helperPid:777,traceId:"offline_"+tabId,status:"running",interactionMode:"automatic",targetId:""};
      tabs.set(tabId,tab);window.contentView.addChildView(view);view.setBounds({x:0,y:0,width:725,height:431});view.setVisible(true);
      await view.webContents.loadURL(Buffer.from(encodedUrl,"base64").toString("utf8"));
      view.webContents.enableDeviceEmulation({screenPosition:"desktop",viewSize:{width:725,height:431},deviceScaleFactor:0,scale:1});
      view.webContents.debugger.attach("1.3");tab.targetId=(await view.webContents.debugger.sendCommand("Target.getTargetInfo")).targetInfo.targetId;view.webContents.debugger.detach();
      result={tabId,profile,targetId:tab.targetId};
    }else if(operation==="snapshot")result={tabs:[...tabs].map(([tabId,tab])=>({tabId,profile:tab.profile,targetId:tab.targetId,leased:tab.leased,rendererPid:tab.view.webContents.getOSProcessId(),requestsServed:requests.get(tabId)})),processes:app.getAppMetrics().map(row=>({pid:row.pid,kind:row.type})),events};
    else if(operation==="lease")tabs.get(fields[0]).leased=fields[1]==="1";
    else if(operation==="close"){
      const tab=tabs.get(fields[0]);if(tab.leased)throw Error("Active turn lease");
      await BrowserHost.prototype.endTurn.call(host,tab.traceId,777,fields[1]??"completed",false,undefined,false,false);
    }else if(operation==="quit"){
      if(tabs.size)throw Error("Unreleased fixture turn");closing=true;
    }else throw Error("Unknown offline operation");
    return emit({id,ok:true,...result});
  }catch(error){return emit({id,ok:false,error:error.message});}
}
app.whenReady().then(async()=>{
  window=new BrowserWindow({width:725,height:431,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});host.window=window;
  window.on("close",event=>{if(!closing){event.preventDefault();window.hide();}});
  await window.loadURL("data:text/html,<title>Offline rendering fixture</title>");
  const token=randomBytes(32).toString("hex"),control=createServer(async(request,response)=>{
    if(request.headers.authorization!=="Bearer "+token){response.writeHead(401);response.end();return;}
    let input="";for await(const chunk of request){input+=chunk;if(input.length>65536){response.writeHead(413);response.end();return;}}
    try{const {operation,id,fields}=JSON.parse(input),result=await command([operation,id,...fields].join("\t"));response.setHeader("content-type","application/json");response.end(JSON.stringify(result),()=>{if(operation==="quit"&&result.ok)setTimeout(()=>app.quit(),100);});}
    catch{response.writeHead(400);response.end();}
  });
  await new Promise(resolve=>control.listen(0,"127.0.0.1",resolve));
  emit({event:"ready",pid:process.pid,debugPort:Number(argument("--fixture-cdp-port")),runtimeVersion:process.versions.chrome,comparisonControl:{endpoint:"http://127.0.0.1:"+control.address().port,token}});
  const input=createInterface({input:process.stdin});let sequence=Promise.resolve();
  input.on("line",line=>{sequence=sequence.then(()=>command(line));});
  const parentPid = process.ppid;
  setInterval(() => { try { process.kill(parentPid, 0); } catch { closing=true;app.quit(); } }, 1000).unref();
});
