const { EventEmitter }=require('node:events');
const { createHash,randomBytes }=require('node:crypto');
const { readFileSync }=require('node:fs');
const { createRequire }=require('node:module');
const { dirname }=require('node:path');
const encode=value=>Buffer.from(String(value),'utf8').toString('base64');

// The existing browser domain owns account allocation, retained conversations, manual
// turns and cancellation. This adapter implements its browser surface with WebView2.
class NativePlatform {
  constructor(client,{onError=()=>{}}={}) {
    this.client=client;this.onError=onError;this.sessions=new Map();this.views=new Map();this.nextView=0;this.pending=new Set();this.powerMonitor=new EventEmitter();
    this.window=new NativeWindow(this);this.client.on('event',event=>this.onEvent(event));
    const platform=this;
    const powerLeases=new Set();let nextPowerLease=0;
    this.electron={
      WebContentsView:class extends NativeView { constructor(options){super(platform,options);} },
      session:{fromPartition:partition=>this.session(partition)},
      app:{getAppMetrics:()=>[]},powerMonitor:this.powerMonitor,
      powerSaveBlocker:{start:()=>{const id=++nextPowerLease;powerLeases.add(id);this.background(this.client.request('power',['1']));return id;},isStarted:id=>powerLeases.has(id),stop:id=>{powerLeases.delete(id);this.background(this.client.request('power',[powerLeases.size?'1':'0']));}},
      clipboard:{writeText:text=>this.background(this.client.request('clipboard',[encode(text)]))},
      shell:{openExternal:url=>this.client.request('external',[encode(url)])},
    };
  }
  background(promise) { this.pending.add(promise);promise.catch(error=>this.onError(error)).finally(()=>this.pending.delete(promise));return promise; }
  async flush() { while(this.pending.size)await Promise.all([...this.pending]); }
  session(partition) { if(!this.sessions.has(partition))this.sessions.set(partition,new NativeSession(this,partition));return this.sessions.get(partition); }
  onEvent(event) {
    const contents=this.views.get(event.tabId)?.webContents;
    if(contents)contents.onNativeEvent(event);
    if(event.event==='close-requested')this.window.close();
    if(event.event==='quit-requested')this.window.emit('quit-requested');
    if(event.event==='resume')this.powerMonitor.emit('resume');
  }
  async close() { for(const view of [...this.views.values()])await view.webContents.close();await this.flush(); }
}

class NativeSession {
  constructor(platform,partition) {
    this.platform=platform;this.partition=partition;this.profile='p_'+createHash('sha256').update(partition).digest('hex').slice(0,32);this.views=new Set();this.completed=new Set();
    this.cookies=new EventEmitter();this.userAgent='';
    this.webRequest={onCompleted:(_filter,listener)=>{if(listener)this.completed.add(listener);else this.completed.clear();}};
    this.cookies.get=filter=>this.getCookies(filter);
    this.cookies.set=cookie=>this.setCookie(cookie);
    this.cookies.remove=async(url,name)=>{const contents=await this.contents();await contents.cdp('Network.deleteCookies',{url,name});this.cookies.emit('changed',{}, {name,domain:new URL(url).hostname},'explicit',true);};
    // WebView2 persists its profile automatically. There is no Electron flushStore API;
    // wait for submitted cookie operations here and verify persistence across host restarts.
    this.cookies.flushStore=()=>this.platform.flush();
  }
  async contents() {
    let view=[...this.views].find(view=>!view.webContents.isDestroyed());
    if(!view) { view=new NativeView(this.platform,{webPreferences:{partition:this.partition}});view.setBounds({x:-1200,y:0,width:800,height:600});view.setVisible(true); }
    await view.webContents.ready;return view.webContents;
  }
  getUserAgent(){return this.userAgent;}
  setUserAgent(userAgent,languages){this.userAgent=userAgent;this.languages=languages;}
  async getCookies(filter={}) {
    const contents=await this.contents();const result=await contents.cdp('Network.getCookies',filter.url?{urls:[filter.url]}:{});
    return (result.cookies||[]).filter(cookie=>(!filter.name||cookie.name===filter.name)&&(!filter.domain||cookie.domain.replace(/^\./,'').endsWith(filter.domain.replace(/^\./,'')))).map(cookie=>({...cookie,expirationDate:cookie.expires>0?cookie.expires:undefined,sameSite:cookie.sameSite==='None'?'no_restriction':String(cookie.sameSite||'unspecified').toLowerCase()}));
  }
  async setCookie(cookie) {
    const contents=await this.contents();const {expirationDate,sameSite,...rest}=cookie;
    const mapping={lax:'Lax',strict:'Strict',no_restriction:'None'};
    const result=await contents.cdp('Network.setCookie',{...rest,...(expirationDate?{expires:expirationDate}:{}),...(mapping[sameSite]?{sameSite:mapping[sameSite]}:{})});
    if(result.success===false)throw new Error('WebView2 rejected the profile cookie');
    this.cookies.emit('changed',{},cookie,'explicit',false);
  }
  async clearStorageData() {
    const contents=await this.contents();await this.platform.client.request('clear',[contents.tabId]);
    this.cookies.emit('changed',{}, {name:'__Secure-next-auth.session-token',domain:'.chatgpt.com'},'explicit',true);
  }
  flushStorageData(){return this.platform.flush();}
  async resolveProxy(url) { return require('./windows-services.cjs').resolveWindowsProxy(url); }
}

class NativeView {
  constructor(platform,options={}) {
    if(options.webContents?.view)return options.webContents.view;
    this.platform=platform;this.id='native_'+(++platform.nextView);this.bounds={x:-1200,y:0,width:800,height:600};this.visible=true;
    this.webContents=new NativeContents(this,platform.session(options.webPreferences?.partition||'default'));
    platform.views.set(this.id,this);this.webContents.session.views.add(this);
  }
  setBounds(bounds){this.bounds={...bounds};this.sync();}
  setVisible(visible){this.visible=visible===true;this.sync();}
  sync(){this.platform.background(this.webContents.ready.then(()=>{if(!this.webContents.isDestroyed())return this.platform.client.request('bounds',[this.id,...['x','y','width','height'].map(key=>Math.round(this.bounds[key])),this.visible?'1':'0']);}));}
}

class NativeContents extends EventEmitter {
  constructor(view,session) {
    super();this.view=view;this.platform=view.platform;this.tabId=view.id;this.session=session;this.id=this.platform.nextView;
    this.destroyed=false;this.url='about:blank';this.title='ChatGPT';this.loading=false;this.zoomFactor=1;this.targetId=null;this.cssKeys=new Set();this.navigationWaiters=new Set();
    this.navigationHistory={canGoBack:()=>this.back===true,canGoForward:()=>this.forward===true,goBack:()=>this.backgroundAction('back'),goForward:()=>this.backgroundAction('forward')};
    this.debugger={isAttached:()=>this.debuggerAttached===true,attach:()=>{this.debuggerAttached=true;},detach:()=>{this.debuggerAttached=false;},sendCommand:(method,parameters)=>this.cdp(method,parameters)};
    this.ready=this.platform.client.addTab({tabId:this.tabId,profile:session.profile,url:'about:blank',selected:false}).then(async result=>{
      this.targetId=result.targetId;
      await this.platform.client.request('subscribe',[this.tabId,encode('Network.responseReceived')]);
      await this.platform.client.request('subscribe',[this.tabId,encode('Page.domContentEventFired')]);
      await this.rawCdp('Network.enable',{});
      return this;
    });
  }
  isDestroyed(){return this.destroyed;}
  getURL(){return this.url;}
  getTitle(){return this.title;}
  isLoading(){return this.loading;}
  isLoadingMainFrame(){return this.loading;}
  getZoomFactor(){return this.zoomFactor;}
  getZoomLevel(){return Math.log(this.zoomFactor)/Math.log(1.2);}
  getOSProcessId(){return 0;}
  getProcessMemoryInfo(){return Promise.reject(new Error('Per-renderer memory attribution is unavailable in WebView2'));}
  getOrCreateDevToolsTargetId(){if(!this.targetId)throw new Error('Native target has not initialized');return this.targetId;}
  async rawCdp(method,parameters={}) { return (await this.platform.client.request('cdp',[this.tabId,encode(method),encode(JSON.stringify(parameters))])).result; }
  async cdp(method,parameters={}) { await this.ready;if(this.destroyed)throw new Error('Native document was closed');return this.rawCdp(method,parameters); }
  async executeJavaScript(expression) {
    const result=await this.cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.text||'Browser script failed');return result.result?.value;
  }
  async insertCSS(css) { const key='native-css-'+randomBytes(6).toString('hex');await this.executeJavaScript(`(()=>{const style=document.createElement('style');style.id=${JSON.stringify(key)};style.textContent=${JSON.stringify(css)};(document.head||document.documentElement).append(style);})()`);this.cssKeys.add(key);return key; }
  async removeInsertedCSS(key){if(!this.cssKeys.delete(key))return;await this.executeJavaScript(`document.getElementById(${JSON.stringify(key)})?.remove()`);}
  setZoomFactor(value){this.zoomFactor=value;this.platform.background(this.ready.then(()=>{if(!this.destroyed)return this.platform.client.request('zoom',[this.tabId,String(value)]);}));}
  setZoomLevel(level){this.setZoomFactor(Math.pow(1.2,level));}
  setBackgroundThrottling(){/* Active leases remain drawable; no WebView2 suspension is requested. */}
  enableDeviceEmulation(options){const size=options.viewSize;this.platform.background(this.cdp('Emulation.setDeviceMetricsOverride',{width:size.width,height:size.height,deviceScaleFactor:options.deviceScaleFactor||0,mobile:false}));}
  disableDeviceEmulation(){this.platform.background(this.cdp('Emulation.clearDeviceMetricsOverride',{}));}
  setWindowOpenHandler(handler){this.windowOpenHandler=handler;}
  backgroundAction(action){this.platform.background(this.ready.then(()=>{if(!this.destroyed)return this.platform.client.request('action',[this.tabId,action]);}));}
  focus(){this.backgroundAction('focus');}
  stop(){this.backgroundAction('stop');}
  reload(){return this.reloadIgnoringCache(false);}
  async reloadIgnoringCache(ignoreCache=true){await this.ready;this.loading=true;this.emit('did-start-loading');await this.cdp('Page.reload',{ignoreCache});}
  async loadURL(url) {
    await this.ready;if(this.destroyed)throw new Error('Native document was closed');this.loading=true;this.emit('did-start-loading');
    return new Promise((accept,reject)=>{
      const waiter={accept,reject,url,timer:setTimeout(()=>{this.navigationWaiters.delete(waiter);reject(new Error('Native navigation did not finish within 60000ms'));},60000)};
      this.navigationWaiters.add(waiter);
      this.platform.client.request('navigate',[this.tabId,encode(url)]).catch(error=>{this.navigationWaiters.delete(waiter);clearTimeout(waiter.timer);reject(error);});
    });
  }
  onNativeEvent(event) {
    if(event.event==='source-changed'&&event.url)this.url=event.url;
    if(event.event==='navigation-completed') {
      if(event.success&&!event.url) {
        // This installed WebView2 returns an empty Source for data: documents. Read
        // the committed document location; a requested URL is not readiness evidence.
        void this.rawCdp('Runtime.evaluate',{expression:'location.href',returnByValue:true}).then(result=>{
          const url=result.result?.value;if(typeof url!=='string'||!url)throw new Error('Committed native document URL unavailable');
          this.onNativeEvent({...event,url});
        }).catch(error=>this.platform.onError(error));return;
      }
      this.url=event.url;this.title=event.title||this.title;this.back=event.canGoBack;this.forward=event.canGoForward;this.loading=false;
      if(event.success){this.emit('dom-ready');this.emit('did-navigate',{},this.url);this.emit('did-finish-load');this.emit('did-stop-loading');}
      else this.emit('did-fail-load',{},-event.errorCode,'WebView2 navigation failure',this.url,true);
      for(const waiter of [...this.navigationWaiters]) {
        // Ignore the initial about:blank completion left over from controller creation.
        if(this.url==='about:blank'&&waiter.url!=='about:blank')continue;
        this.navigationWaiters.delete(waiter);clearTimeout(waiter.timer);event.success?waiter.accept():waiter.reject(new Error('WebView2 navigation failed: '+event.errorCode));
      }
    }
    if(event.event==='cdp-event') {
      if(event.method==='Page.domContentEventFired')this.emit('dom-ready');
      if(event.method==='Network.responseReceived') {
        const response=event.value.response;
        const details={url:response.url,statusCode:response.status,webContentsId:this.id,responseHeaders:Object.fromEntries(Object.entries(response.headers||{}).map(([key,value])=>[key,[String(value)]]))};
        for(const listener of this.session.completed)listener(details);
      }
    }
    if(event.event==='process-failed')this.emit('render-process-gone',{}, {reason:'webview2-'+event.kind,exitCode:null});
    if(event.event==='new-window')void this.handlePopup(event);
  }
  async handlePopup(event) {
    try {
      const decision=this.windowOpenHandler?.({url:event.url});
      if(decision?.action==='allow'&&typeof decision.createWindow==='function') {
        const view=new NativeView(this.platform,{webPreferences:{partition:this.session.partition}});
        decision.createWindow({webContents:view.webContents});await view.webContents.ready;
        await this.platform.client.request('popup-bind',[event.popupId,view.id]);return;
      }
    } catch(error){this.platform.onError(error);}
    await this.platform.client.request('popup-deny',[event.popupId]).catch(error=>this.platform.onError(error));
  }
  async close() {
    if(this.closing)return this.closing;this.destroyed=true;
    this.closing=(async()=>{
      for(const waiter of this.navigationWaiters){clearTimeout(waiter.timer);waiter.reject(new Error('Native document was closed'));}this.navigationWaiters.clear();
      await this.ready.catch(()=>{});
      await this.platform.client.setLease(this.tabId,false).catch(()=>{});await this.platform.client.closeTab(this.tabId);
      this.platform.views.delete(this.tabId);this.session.views.delete(this.view);this.emit('destroyed');this.removeAllListeners();
    })();
    this.platform.background(this.closing);return this.closing;
  }
}

class NativeWindow extends EventEmitter {
  constructor(platform) { super();this.platform=platform;this.visible=false;this.minimized=false;this.maximized=false;this.bounds={x:0,y:0,width:1120,height:800};this.content=[1080,740];this.webContents=new EventEmitter();this.webContents.isDestroyed=()=>false;this.webContents.isFocused=()=>this.visible;this.webContents.getZoomFactor=()=>1;this.webContents.send=(channel,value)=>this.dispatcher?.publish(channel,value);this.contentView={addChildView:()=>{},removeChildView:()=>{}}; }
  isDestroyed(){return this.destroyed===true;}
  isVisible(){return this.visible;}
  isMinimized(){return this.minimized;}
  isMaximized(){return this.maximized;}
  isFullScreen(){return false;}
  isFocused(){return this.visible&&!this.minimized;}
  getBounds(){return {...this.bounds};}
  getNormalBounds(){return {...this.bounds};}
  getContentSize(){return this.content;}
  async refresh(){const state=await this.platform.client.snapshot();this.visible=state.visible;this.minimized=state.minimized;this.maximized=state.maximized;this.bounds=state.windowBounds;this.content=[Math.round(state.contentWidth),Math.round(state.contentHeight)];return state;}
  show(){this.visible=true;this.minimized=false;this.platform.background(this.platform.client.setVisible(true));this.emit('show');}
  hide(){this.visible=false;this.platform.background(this.platform.client.setVisible(false));this.emit('hide');}
  action(action,event){this.platform.background(this.platform.client.request('window',[action]).then(()=>this.refresh()).then(()=>this.emit(event||action)));}
  minimize(){this.minimized=true;this.action('minimize');}
  maximize(){this.maximized=true;this.action('maximize');}
  unmaximize(){this.maximized=false;this.action('restore','unmaximize');}
  restore(){this.minimized=false;this.action('restore');}
  focus(){this.action('focus');}
  setAlwaysOnTop(value){this.action(value?'top':'normal');}
  close(){let prevented=false;this.emit('close',{preventDefault:()=>{prevented=true;}});if(!prevented)this.emit('quit-requested');}
}

function loadNativeBrowserHost(file,platform) {
  const originalRequire=createRequire(file),module={exports:{}};
  new Function('require','module','exports','__filename','__dirname',readFileSync(file,'utf8'))(name=>name==='electron'?platform.electron:originalRequire(name),module,module.exports,file,dirname(file));
  const LegacyHost=module.exports.BrowserHost;
  return class NativeBrowserHost extends LegacyHost {
    async beginTurn(...args){const result=await super.beginTurn(...args);this.syncPowerSaveBlocker();await platform.flush();return result;}
    syncPowerSaveBlocker(){super.syncPowerSaveBlocker();for(const tab of this.turnTabs.values())platform.background(tab.view.webContents.ready.then(()=>{if(!tab.view.webContents.isDestroyed())return platform.client.setLease(tab.view.id,tab.status==='running');}));}
    writeDescriptor(){super.writeDescriptor();const descriptor=JSON.parse(readFileSync(this.descriptorPath,'utf8'));descriptor.pid=platform.client.pid;originalRequire('./atomic-file.cjs').writePrivateFileAtomic(this.descriptorPath,JSON.stringify(descriptor,null,2)+'\n');}
    destroy(){super.destroy();}
  };
}
module.exports={NativePlatform,NativeView,NativeContents,loadNativeBrowserHost};
