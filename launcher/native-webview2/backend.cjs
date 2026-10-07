const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createServer}=require('node:http');
const {createRequire}=require('node:module');
const {NativeHostClient}=require('./host-client.cjs');
const {NativePlatform,loadNativeBrowserHost}=require('./native-platform.cjs');
const {createUiBridge,UiDispatcher}=require('./ui-bridge.cjs');
const {registerLegacyActions}=require('./legacy-actions.cjs');
const {nativeDialogs}=require('./windows-services.cjs');

async function serveRenderer(root) {
  const rendererRoot=fs.realpathSync(root),types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
  const server=createServer((request,response)=>{
    if(request.method!=='GET'){response.writeHead(405);response.end();return;}
    try {
      const pathname=decodeURIComponent(new URL(request.url,'http://127.0.0.1').pathname),file=path.resolve(rendererRoot,'.'+(pathname==='/'?'/index.html':pathname));
      if(!file.startsWith(rendererRoot+path.sep)){response.writeHead(403);response.end();return;}
      const resolved=fs.realpathSync(file);if(!resolved.startsWith(rendererRoot+path.sep))throw new Error('Invalid renderer path');
      response.setHeader('content-type',types[path.extname(file)]||'application/octet-stream');response.setHeader('x-content-type-options','nosniff');response.setHeader('cache-control','no-store');
      fs.createReadStream(resolved).on('error',()=>response.destroy()).pipe(response);
    } catch {response.writeHead(404);response.end();}
  });
  await new Promise((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',accept);});
  return {url:'http://127.0.0.1:'+server.address().port+'/index.html',server,close:()=>new Promise((accept,reject)=>server.close(error=>error?reject(error):accept()))};
}

async function startNativeLauncher({nativeExecutable,legacyRoot,rendererRoot,runtimeRoot,profile,version='6.1.4',hidden=true,startRuntime=true,attachedClient}) {
  if(!path.isAbsolute(profile.coreHome)||!path.isAbsolute(profile.userData)||!path.isAbsolute(profile.codexHome))throw new Error('Native profile paths must be absolute');
  const load=createRequire(path.join(legacyRoot,'main.cjs'));
  fs.mkdirSync(profile.userData,{recursive:true});fs.mkdirSync(profile.coreHome,{recursive:true});
  const client=attachedClient||await NativeHostClient.start({executable:nativeExecutable,userDataFolder:path.join(profile.userData,'native-webview2')});
  let uiReady=false,browserHost,runtimeHost,runtimeSupervisor,dispatcher,control,renderer,lastOperation=null,closing=false;
  const send=(channel,value)=>{if(uiReady)void dispatcher.publish(channel,value).catch(()=>{});};
  const logger=load('./logging.cjs').createLogger({filePath:path.join(profile.userData,'logs','launcher-native.jsonl'),publish:record=>send('launcher:log',record)});
  const platform=new NativePlatform(client,{onError:error=>logger.warn('native.surface_operation_failed',{message:error.message})});
  const mainWindow=platform.window;
  await mainWindow.refresh();
  const stateStore=load('./state.cjs').createStateStore(path.join(profile.userData,'launcher-state.json'));
  if(profile.kind==='development')stateStore.update({onboardingComplete:true,autoStart:false});
  const app={isPackaged:true,getVersion:()=>version,getPath:key=>({userData:profile.userData,logs:path.join(profile.userData,'logs'),documents:path.join(os.homedir(),'Documents'),exe:nativeExecutable,appData:process.env.APPDATA})[key],
    setLoginItemSettings:settings=>require('./windows-services.cjs').setNativeAutostart(nativeExecutable,settings),
    getLoginItemSettings:()=>require('./windows-services.cjs').getNativeAutostart(nativeExecutable)};
  dispatcher=new UiDispatcher(client,mainWindow.webContents);mainWindow.dispatcher=dispatcher;
  const limitsController=new (load('./limits-controller.cjs').LimitsController)(path.join(profile.userData,'limits.json'),{getInteractionMode:()=>stateStore.read().browserInteractionMode});
  const descriptorPath=path.join(profile.coreHome,'runtime','launcher-browser.json');
  let scope;
  const publishOperation=operation=>{lastOperation=operation;send('launcher:operation',operation);};
  const browserHelper=path.join(runtimeRoot,'app','browser-helper.cjs');
  const sourceRoot=path.resolve(__dirname,'../..');
  try {
    control=await new (load('./control-server.cjs').BrowserControlServer)({logger,getBrowserHost:()=>browserHost,getPreferences:()=>scope?.syncBrowserPreferences?scope.syncBrowserPreferences(stateStore,runtimeHost.runtimeConfigSnapshot().config):stateStore.read(),resolveProxy:url=>platform.session(profile.browserPartition).resolveProxy(url),limits:limitsController}).start();
    runtimeSupervisor=new (load('./runtime-supervisor.cjs').RuntimeSupervisor)({app,logger,sourceRoot,installedRuntimeRoot:runtimeRoot,runtimeRootProvider:()=>runtimeRoot,coreHome:profile.coreHome,browserDescriptorPath:descriptorPath,launcherProfile:profile.kind,
      accountProfile:{coreHome:profile.coreHome,userData:profile.userData,partition:profile.browserPartition},publishOperation});
    runtimeHost=new (load('./runtime.cjs').RuntimeHost)({app,logger,sourceRoot,installedRuntimeRoot:runtimeRoot,runtimeRootProvider:()=>runtimeRoot,coreHome:profile.coreHome,codexHome:profile.codexHome,browserDescriptorPath:descriptorPath,launcherProfile:profile.kind,publishOperation,supervisor:runtimeSupervisor,getBrowserInteractionMode:()=>stateStore.read().browserInteractionMode});
    const NativeBrowserHost=loadNativeBrowserHost(path.join(legacyRoot,'browser-host.cjs'),platform);
    browserHost=new NativeBrowserHost({window:mainWindow,descriptorPath,cdpPort:Number(new URL(client.endpoint).port),control:control.descriptor(),cancelTurn:(traceId,reason)=>runtimeSupervisor.cancelBrowserTurn(traceId,reason),
      getConnectorName:()=>runtimeHost.browserConnectorName(),helper:{executable:path.join(runtimeRoot,'runtime','bun.exe'),script:browserHelper},logger,loginWithPasskey:()=>runtimeHost.capturePasskeyLogin(),
      partition:profile.browserPartition,profile:profile.kind,coreHome:profile.coreHome,userData:profile.userData,publishState:state=>send('launcher:browser-state',state),showWindow:()=>mainWindow.show(),
      getBrowserInteractionMode:()=>stateStore.read().browserInteractionMode,getUseSavedChats:()=>runtimeHost.runtimeConfigSnapshot().config?.useSavedChats===true});
    await browserHost.ready();
    renderer=await serveRenderer(rendererRoot);
    const updateController={getState:()=>({status:'disabled',reason:'native_release_feed_unpublished'}),beginInstall:()=>Promise.reject(new Error('A reviewed native release package is required before installing an update')),cancelInstall:()=>{}};
    const requestQuit=async()=>{
      if(closing)return {ok:false,message:'Native launcher shutdown is already in progress'};
      const operation=runtimeHost.currentOperation()||browserHost.currentOperation();if(operation)return {ok:false,message:'Wait for '+operation+' to finish before quitting'};
      closing=true;
      try {
        if(startRuntime)await runtimeSupervisor.shutdown({cancelActiveTurns:true,force:true});scope?.stopCatalogVerificationMonitor();
        await browserHost.persistSession();browserHost.destroy();await platform.close();await control.close();
        dispatcher.destroy();uiReady=false;await renderer.close();await client.closeTab('launcher_ui');await client.quit();
        return {ok:true};
      } catch(error){closing=false;logger.error('native.shutdown_failed',{message:error.message});return {ok:false,message:error.message};}
    };
    mainWindow.on('close',event=>{event.preventDefault();if(stateStore.read().keepRunningOnClose)mainWindow.hide();else void requestQuit();});
    mainWindow.on('quit-requested',()=>{void requestQuit();});
    scope={logger,stateStore,app,ipcMain:dispatcher,mainWindow,browserHost,runtimeHost,runtimeSupervisor,limitsController,updateController,runtimeStartup:Promise.resolve(),
      LAUNCHER_PROFILE:profile,CORE_HOME:profile.coreHome,launcherUserData:profile.userData,IS_DEV_PROFILE:profile.kind==='development',
      GITHUB_URL:'https://github.com/miuuyy/codex-chatgpt-web',X_URL:'https://x.com/miu21590',CONNECTORS_URL:'https://chatgpt.com/#settings/Plugins',TUNNELS_URL:'https://platform.openai.com/settings/organization/tunnels',KEYS_URL:'https://platform.openai.com/settings/organization/api-keys',
      send,publishOperation,smokePassedThisSession:false,dialog:nativeDialogs(client),openWebUrl:url=>platform.electron.shell.openExternal(url),requestQuit,
      catalogVerificationTimer:null,catalogVerificationInFlight:false,
      showMainWindow:()=>mainWindow.show(),tray:{setContextMenu:items=>{void client.request('tray',[Buffer.from(profile.displayName).toString('base64'),Buffer.from(items[0].label).toString('base64'),Buffer.from(items.at(-1).label).toString('base64')]).catch(error=>logger.warn('native.tray_update_failed',{message:error.message}));}},Menu:{buildFromTemplate:items=>items},BrowserWindow:{fromWebContents:()=>mainWindow},
      get lastOperation(){return lastOperation;}};
    scope.ALLOWED_EXTERNAL_URLS=new Set([scope.GITHUB_URL,scope.X_URL,scope.CONNECTORS_URL,scope.TUNNELS_URL,scope.KEYS_URL,load('./limits-store.cjs').SOURCE_URL]);
    const actions=registerLegacyActions(legacyRoot,scope);
    scope.updateTrayMenu(stateStore.read().language);
    const ui=await client.request('ui',[Buffer.from(renderer.url).toString('base64'),Buffer.from(createUiBridge(path.join(legacyRoot,'preload.cjs'),renderer.url)).toString('base64')]);
    uiReady=true;
    if(!hidden)mainWindow.show();
    if(startRuntime)await runtimeSupervisor.startIfConfigured();
    return {client,platform,browserHost,runtimeHost,runtimeSupervisor,dispatcher,stateStore,logger,ui,uiUrl:renderer.url,actions,descriptorPath,close:requestQuit};
  } catch(error) {
    logger.error('native.startup_failed',{message:error.message});
    browserHost?.destroy();await platform.close().catch(()=>{});await control?.close().catch(()=>{});await renderer?.close().catch(()=>{});dispatcher?.destroy();
    await client.closeTab('launcher_ui').catch(()=>{});await client.quit().catch(()=>client.child.kill());throw error;
  }
}
module.exports={serveRenderer,startNativeLauncher};
