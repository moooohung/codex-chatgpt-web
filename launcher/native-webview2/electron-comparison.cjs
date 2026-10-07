// A minimal Electron comparison host for the same offline fixtures. It is not the production launcher.
const { app, BrowserWindow, WebContentsView, session } = require('electron');
const { createInterface } = require('node:readline');
const { createServer } = require('node:http');
const { randomBytes } = require('node:crypto');
const args = process.argv, readArgument = name => args[args.indexOf(name) + 1];
const port = Number(readArgument('--fixture-cdp-port'));
app.setPath('userData', readArgument('--user-data-folder'));
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
app.commandLine.appendSwitch('remote-debugging-port', String(port));
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
let window, selectedTab, closing = false;
const tabs = new Map();
const emit = value => { process.stdout.write(JSON.stringify(value) + '\n'); return value; };
const layout = () => {
  for (const [id, tab] of tabs) {
    tab.view.setBounds({x:id === selectedTab ? 0 : -1200,y:66,width:725,height:431});
    tab.view.setVisible(id === selectedTab || tab.leased);
  }
};
async function command(line) {
  const [operation, rawId, ...fields] = line.split('\t'), id = Number(rawId);
  try {
    let result = {};
    if (operation === 'add') {
      const [tabId, profile, encodedUrl, leased, selected] = fields;
      const view = new WebContentsView({webPreferences:{session:session.fromPartition('persist:'+profile),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
      const tab = {view,profile,leased:leased==='1',targetId:''}; tabs.set(tabId,tab);
      window.contentView.addChildView(view);
      if (selected === '1' || !selectedTab) selectedTab=tabId;
      layout();
      await view.webContents.loadURL(Buffer.from(encodedUrl,'base64').toString('utf8'));
      view.webContents.enableDeviceEmulation({screenPosition:'desktop',viewSize:{width:725,height:431},deviceScaleFactor:0,scale:1});
      view.webContents.debugger.attach('1.3');
      const target=await view.webContents.debugger.sendCommand('Target.getTargetInfo');
      tab.targetId=target.targetInfo.targetId; view.webContents.debugger.detach();
      result={tabId,profile,targetId:tab.targetId};
    } else if (operation === 'snapshot') {
      result={selectedTab,visible:window.isVisible(),tabs:[...tabs].map(([tabId,tab])=>({tabId,profile:tab.profile,targetId:tab.targetId,leased:tab.leased})),processes:app.getAppMetrics().map(metric=>({pid:metric.pid,kind:metric.type}))};
    } else if (operation === 'visible') { fields[0] === '1' ? window.showInactive() : window.hide();layout(); }
    else if (operation === 'select') { selectedTab=fields[0];layout(); }
    else if (operation === 'lease') { tabs.get(fields[0]).leased=fields[1]==='1';layout(); }
    else if (operation === 'bounds') { const tab=tabs.get(fields[0]),[tabId,x,y,width,height,visible]=fields;tab.view.setBounds({x:Number(x),y:Number(y),width:Number(width),height:Number(height)});tab.view.setVisible(visible==='1'||tab.leased); }
    else if (operation === 'close') {
      const tab=tabs.get(fields[0]);if(tab.leased)throw Error('Active turn tab cannot be closed');
      window.contentView.removeChildView(tab.view);tab.view.webContents.close();tabs.delete(fields[0]);
      if(selectedTab===fields[0])selectedTab=tabs.keys().next().value;layout();
    } else if (operation === 'quit') {
      if([...tabs.values()].some(tab=>tab.leased))throw Error('Active turn leases');
      closing=true;return emit({id,ok:true});
    } else throw Error('Unknown comparison command');
    return emit({id,ok:true,...result});
  } catch (error) { return emit({id,ok:false,error:error.message}); }
}
app.whenReady().then(async()=>{
  window=new BrowserWindow({width:1120,height:800,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  window.on('close',event=>{if(!closing){event.preventDefault();window.hide();}});
  await window.loadURL('data:text/html;charset=utf-8,<title>Offline Electron comparison</title>');
  const token=randomBytes(32).toString('hex');
  const control=createServer(async(request,response)=>{
    if(request.headers.authorization!=='Bearer '+token){response.writeHead(401);response.end();return;}
    let input='';for await(const chunk of request){input+=chunk;if(input.length>65536){response.writeHead(413);response.end();return;}}
    try { const {operation,id,fields}=JSON.parse(input);const result=await command([operation,id,...fields].join('\t'));response.setHeader('content-type','application/json');response.end(JSON.stringify(result),()=>{if(operation==='quit')setTimeout(()=>app.quit(),100);}); }
    catch { response.writeHead(400);response.end(); }
  });
  await new Promise(accept=>control.listen(0,'127.0.0.1',accept));
  emit({event:'ready',pid:process.pid,debugPort:port,runtimeVersion:process.versions.chrome,comparisonControl:{endpoint:'http://127.0.0.1:'+control.address().port,token}});
  const input=createInterface({input:process.stdin});let sequence=Promise.resolve();
  input.on('line',line=>{sequence=sequence.then(()=>command(line));});
});
