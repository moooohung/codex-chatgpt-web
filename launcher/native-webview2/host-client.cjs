const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { EventEmitter } = require('node:events');

async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const port = server.address().port;
  await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return port;
}

class NativeHostClient extends EventEmitter {
  constructor(executable, userDataFolder, debugPort, bootstrapScript, attached=false) {
    super();
    this.pending = new Map(); this.sequence = 0; this.stderr = '';
    this.endpoint = 'http://127.0.0.1:' + debugPort;
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
    this.child = attached ? Object.assign(new EventEmitter(),{pid:null,stdin:process.stdout,stdout:process.stdin,stderr:null,exitCode:null,signalCode:null,kill:()=>{throw new Error('An attached native parent must exit through its shutdown protocol');}}) : spawn(resolve(executable), [...(bootstrapScript ? [resolve(bootstrapScript)] : ['--controlled']), '--hidden', '--no-home', '--user-data-folder', resolve(userDataFolder), bootstrapScript ? '--fixture-cdp-port' : '--debug-port', String(debugPort)], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: resolve(userDataFolder), env: environment,
    });
    this.pid = this.child.pid;
    this.ready = new Promise((accept, reject) => { this.acceptReady = accept; this.rejectReady = reject; });
    this.exited = new Promise(accept => { this.acceptExit = accept; });
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => { this.fail(new Error('Native host exited: ' + code + ' ' + (signal ?? '') + '; ' + this.stderr.slice(-2000))); this.acceptExit({code, signal}); });
    this.child.stderr?.on('data', chunk => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-8192); });
    if(attached)this.child.stdout.on('end',()=>{this.child.exitCode=0;this.child.emit('exit',0,null);});
    let buffer = '';
    this.child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 4 * 1024 * 1024) { this.fail(new Error('Native protocol output exceeded its bound')); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let value; try { value = JSON.parse(line); } catch { this.fail(new Error('Native host emitted invalid JSON')); continue; }
        if (value.event === 'ready') { this.pid=value.pid;this.endpoint='http://127.0.0.1:'+value.debugPort;this.acceptReady(value); }
        if (value.event) this.emit('event', value);
        const pending = this.pending.get(value.id);
        if (pending) {
          this.emit('reply', {id:value.id,operation:pending.operation,ok:value.ok===true});
          this.pending.delete(value.id); clearTimeout(pending.timer);
          value.ok === true ? pending.accept(value) : pending.reject(Object.assign(new Error(value.error || 'Native operation failed'), {hresult: value.hresult}));
        } else if (value.id === 0 && value.ok === false) this.rejectReady(new Error(value.error || 'Native startup failed'));
      }
    });
  }
  fail(error) {
    this.rejectReady(error);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  static async start({executable, userDataFolder, debugPort, bootstrapScript}) {
    mkdirSync(userDataFolder, {recursive: true});
    const client = new NativeHostClient(executable, userDataFolder, debugPort ?? await unusedLoopbackPort(), bootstrapScript);
    let timer;
    try {
      client.runtime = await Promise.race([client.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native host startup timed out')), 20000); })]);
      return client;
    } catch (error) { client.child.kill(); throw error; }
    finally { clearTimeout(timer); }
  }
  static async attach({executable,userDataFolder}) {
    const client=new NativeHostClient(executable,userDataFolder,0,undefined,true);let timer;
    try {client.runtime=await Promise.race([client.ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Attached native host startup timed out')),20000);})]);return client;}
    finally{clearTimeout(timer);}
  }
  request(operation, fields = [], timeoutMs = 20000) {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.reject(new Error('Native host is no longer running'));
    if (fields.some(value => /[\r\n\t\0]/.test(String(value)))) return Promise.reject(new Error('Invalid native command field'));
    const id = ++this.sequence;
    if (this.runtime?.comparisonControl) {
      const {endpoint,token}=this.runtime.comparisonControl;
      return fetch(endpoint,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',connection:'close'},body:JSON.stringify({operation,id,fields}),signal:AbortSignal.timeout(timeoutMs)}).then(async response=>{
        if(!response.ok)throw new Error('Offline comparison control HTTP '+response.status);
        const value=await response.json();if(value.ok!==true)throw new Error(value.error||'Comparison operation failed');return value;
      }).catch(error=>{throw new Error('Offline comparison '+operation+' failed: '+error.message);});
    }
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Native ' + operation + ' timed out')); }, timeoutMs);
      this.pending.set(id, {accept, reject, timer,operation});
      this.emit('request',{id,operation});
      this.child.stdin.write([operation, id, ...fields].join('\t') + '\n', error => {
        if (error) { const pending = this.pending.get(id); if (pending) { this.pending.delete(id); clearTimeout(timer); reject(error); } }
      });
    });
  }
  addTab({tabId, profile = 'default', url = 'about:blank', leased = false, selected = true}) {
    return this.request('add', [tabId, profile, Buffer.from(url, 'utf8').toString('base64'), leased ? '1' : '0', selected ? '1' : '0']);
  }
  selectTab(tabId) { return this.request('select', [tabId]); }
  setLease(tabId, leased) { return this.request('lease', [tabId, leased ? '1' : '0']); }
  closeTab(tabId) { return this.request('close', [tabId]); }
  setVisible(visible) { return this.request('visible', [visible ? '1' : '0']); }
  snapshot() { return this.request('snapshot'); }
  async quit() { await this.request('quit'); return this.exited; }
}

module.exports = { NativeHostClient, unusedLoopbackPort };
