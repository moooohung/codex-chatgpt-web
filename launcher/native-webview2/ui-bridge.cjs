const { readFileSync } = require('node:fs');

function createUiBridge(preloadPath, applicationUrl) {
  const source=readFileSync(preloadPath,'utf8');
  const importLine='const { contextBridge, ipcRenderer } = require("electron");';
  if(!source.startsWith(importLine)||source.slice(importLine.length).includes('require('))throw new Error('Review the changed launcher preload before generating the native bridge');
  const applicationOrigin=new URL(applicationUrl).origin;
  return `(() => {
    if(window!==window.top || location.origin!==${JSON.stringify(applicationOrigin)})return;
    const pending=new Map(), listeners=new Map();let sequence=0;
    chrome.webview.addEventListener('message',event=>{
      const value=event.data;
      if(value?.kind==='reply') { const entry=pending.get(value.id);if(!entry)return;pending.delete(value.id);clearTimeout(entry.timer);value.ok===true?entry.resolve(value.value):entry.reject(new Error(value.error||'Launcher operation failed')); }
      if(value?.kind==='event')for(const listener of listeners.get(value.channel)||[])listener({},value.value);
    });
    const invoke=(channel,...args)=>new Promise((resolve,reject)=>{
      const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Launcher operation did not respond'));},600000);
      pending.set(id,{resolve,reject,timer});chrome.webview.postMessage({kind:'invoke',id,channel,args});
    });
    const ipcRenderer={invoke,send:(channel,...args)=>chrome.webview.postMessage({kind:'send',channel,args}),on:(channel,listener)=>{let group=listeners.get(channel);if(!group)listeners.set(channel,group=new Set());group.add(listener);},removeListener:(channel,listener)=>listeners.get(channel)?.delete(listener)};
    const contextBridge={exposeInMainWorld:(name,api)=>Object.defineProperty(window,name,{value:Object.freeze(api),configurable:false,writable:false})};
    ${source.slice(importLine.length)}
  })();`;
}

class UiDispatcher {
  constructor(client, sender) { this.client=client;this.sender=sender;this.handlers=new Map();this.events=new Map();this.accepting=true;this.listener=message=>{if(message.event==='ui-message')void this.dispatch(message.value);};client.on('event',this.listener); }
  handle(channel,handler) { if(this.handlers.has(channel))throw new Error('Duplicate launcher action: '+channel);this.handlers.set(channel,handler); }
  on(channel,handler) { this.events.set(channel,handler); }
  async dispatch(message) {
    if(!this.accepting || !message || !Array.isArray(message.args)||message.args.length>8 || typeof message.channel!=='string')return;
    if(message.kind==='send') { const handler=this.events.get(message.channel);if(handler)await handler({sender:this.sender},...message.args);return; }
    if(message.kind!=='invoke'||!Number.isSafeInteger(message.id)||message.id<1)return;
    let reply;
    try { const handler=this.handlers.get(message.channel);if(!handler)throw new Error('Unknown launcher action');reply={kind:'reply',id:message.id,ok:true,value:await handler({sender:this.sender},...message.args)}; }
    catch(error) { reply={kind:'reply',id:message.id,ok:false,error:error instanceof Error?error.message:'Launcher operation failed'}; }
    await this.post(reply).catch(()=>{});
  }
  post(value) { return this.client.request('message',[Buffer.from(JSON.stringify(value),'utf8').toString('base64')]); }
  publish(channel,value) { return this.post({kind:'event',channel,value}); }
  destroy() { this.accepting=false;this.client.off('event',this.listener);this.handlers.clear();this.events.clear(); }
}
module.exports={createUiBridge,UiDispatcher};
