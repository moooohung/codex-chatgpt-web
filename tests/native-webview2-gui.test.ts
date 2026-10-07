import {test,expect} from 'bun:test';
import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {chromium} from 'playwright-core';
import {selectLauncherPage} from '../src/launcher-browser-host';
import {copyFor} from '../launcher/src/i18n';
const {packagePrototype}=require('../launcher/native-webview2/package-prototype.cjs');
const {processSample}=require('../launcher/native-webview2/process-sample.cjs');
const enabled=Boolean(process.env.CHATGPT_NATIVE_HOST_BINARY&&process.env.CHATGPT_NATIVE_RUNTIME_ROOT&&process.env.CHATGPT_NATIVE_RENDERER_ROOT);
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
test.skipIf(!enabled).each(['explicit-dev','default-dev','parent-loss'])('packaged native GUI lifecycle (%s)',async mode=>{
  const explicitDev=mode==='explicit-dev';
  const output=resolve(process.env.CHATGPT_NATIVE_TEST_OUTPUT||'output/native-webview2');
  const root=join(output,'gui-'+randomBytes(6).toString('hex'));mkdirSync(root,{recursive:true});
  const packaged=packagePrototype({sourceRoot:resolve(import.meta.dir,'..'),outputRoot:join(root,'package'),
    nativeExecutable:process.env.CHATGPT_NATIVE_HOST_BINARY,runtimeRoot:process.env.CHATGPT_NATIVE_RUNTIME_ROOT,rendererRoot:process.env.CHATGPT_NATIVE_RENDERER_ROOT});
  const profileRoot=join(root,'profile'),userData=join(profileRoot,'launcher'),healthPath=join(userData,'native-launcher-health.json');
  const child=spawn(packaged.executable,[...(explicitDev?['--dev-profile']:[]),'--offline','--hidden','--user-data-folder',join(userData,'native-webview2')],
    {windowsHide:true,stdio:'ignore',env:{...process.env,CODEX_WEB_GPT_DEV_HOME:profileRoot}});
  const exited=new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('exit',yes);});
  let browser,health:any;const errors:string[]=[],menus:string[]=[];
  try{
    const started=performance.now(),deadline=Date.now()+20000;
    while(!existsSync(healthPath)&&Date.now()<deadline){
      if(child.exitCode!==null)throw Error('Native GUI exited before readiness: '+readFileSync(join(userData,'native-backend.stderr.log'),'utf8'));
      await Bun.sleep(50);
    }
    if(!existsSync(healthPath))throw Error('Native GUI readiness timed out');
    health=JSON.parse(readFileSync(healthPath,'utf8'));const readyMs=performance.now()-started;
    expect(health).toMatchObject({hostPid:child.pid,profile:'development',runtimeStarted:false,ready:true,packagedActions:true});
    expect(existsSync(join(packaged.packageRoot,'node_modules','typescript'))).toBeFalse();
    const descriptor=JSON.parse(readFileSync(health.descriptorPath,'utf8'));
    expect(descriptor).toMatchObject({pid:child.pid,profile:'development',kind:'codex-web-gpt-launcher'});
    expect(resolve(health.descriptorPath).startsWith(profileRoot)).toBeTrue();
    expect(health.backendPid).not.toBe(child.pid);expect(alive(health.backendPid)).toBeTrue();
    if(mode==='parent-loss'){
      // Only this test's freshly spawned native process is stopped, in an offline
      // DEV profile. No installed launcher, worker or training PID enters here.
      child.kill();await exited;
      const exitDeadline=Date.now()+10000;while(alive(health.backendPid)&&Date.now()<exitDeadline)await Bun.sleep(50);
      expect(alive(health.backendPid)).toBeFalse();
      writeFileSync(join(root,'gui-parent-loss-verification.json'),JSON.stringify({at:new Date().toISOString(),mode,hostPid:child.pid,backendPid:health.backendPid,
        backendExited:true,scope:'Own isolated offline fixture parent stopped; backend servers disposed after its actual pipe EOF. No live-turn recovery or Native2 ACK claim.',runtimeStarted:false,productionLauncherStopped:false,workerPromptSends:0,proTestSends:0},null,2));
      return;
    }
    browser=await chromium.connectOverCDP(descriptor.endpoint);
    const targets=await(await fetch(descriptor.endpoint+'/json/list')).json() as any[];
    const uiTarget=targets.find(target=>target.type==='page'&&/^http:\/\/127\.0\.0\.1:\d+\/index\.html$/.test(target.url));
    expect(uiTarget).toBeDefined();
    const {page}=await selectLauncherPage(browser,{surfaceTargets:{ui:uiTarget.id}} as any,10000,'ui');
    page.on('pageerror',error=>errors.push(error.message));
    await page.waitForFunction(()=>typeof (window as any).codexWebLauncher?.snapshot==='function');
    await page.getByRole('navigation').waitFor({timeout:15000});
    const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}));
    expect(viewport.width).toBeGreaterThan(1000);expect(viewport.height).toBeGreaterThan(600);
    const copy=copyFor('en'),titles:Record<string,string>={Setup:copy.devSetupTitle,MCP:copy.devMcpTitle,Accounts:copy.accountsTitle,Activity:copy.activityTitle,Limits:'Limits',Settings:copy.devSettingsTitle,Browser:copy.stepAccount};
    for(const name of ['Setup','MCP','Accounts','Activity','Limits','Settings','Browser']){
      await page.getByRole('button',{name,exact:true}).click();menus.push(name);
      await page.getByRole('heading',{name:titles[name],exact:true}).waitFor({state:'visible',timeout:10000});
      await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('.surface-transition')!).opacity)>0.99);
      expect(await page.locator('#root').textContent()).not.toContain('Unknown launcher action');
    }
    const methods=await page.evaluate(()=>Object.keys((window as any).codexWebLauncher));
    const expectedMethods=[...readFileSync(join(packaged.packageRoot,'backend','legacy','preload.cjs'),'utf8').matchAll(/^  (\w+):/gm)].map(match=>match[1]);
    const state=await page.evaluate(async()=>{const api=(window as any).codexWebLauncher;await api.setPreference('showBrowserDuringTurns',true);return api.snapshot();});
    expect(methods.sort()).toEqual(expectedMethods.sort());expect(state.profile).toBe('development');expect(state.state.showBrowserDuringTurns).toBeTrue();
    expect(errors).toEqual([]);
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByRole('heading',{name:copy.devSettingsTitle,exact:true}).waitFor({state:'visible'});
    await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('.surface-transition')!).opacity)>0.99);
    await page.screenshot({path:join(root,'native-gui-settings.png')});
    const session=await browser.newBrowserCDPSession(),processes=await session.send('SystemInfo.getProcessInfo');await session.detach();
    const memory=processSample([child.pid,health.backendPid,...processes.processInfo.map(entry=>Number(entry.id))]);
    const totalPrivateBytes=memory.rows.reduce((sum:number,entry:any)=>sum+entry.privateBytes,0);
    await page.evaluate(async()=>{await (window as any).codexWebLauncher.setPreference('keepRunningOnClose',false);});
    await page.evaluate(()=>{(window as any).codexWebLauncher.windowControl('close');});
    const exitCode=await Promise.race([exited,Bun.sleep(10000).then(()=>{throw Error('Native GUI did not close gracefully');})]);
    expect(exitCode).toBe(0);
    const exitDeadline=Date.now()+5000;while(alive(health.backendPid)&&Date.now()<exitDeadline)await Bun.sleep(50);
    expect(alive(health.backendPid)).toBeFalse();
    writeFileSync(join(root,'gui-verification.json'),JSON.stringify({at:new Date().toISOString(),explicitDev,hostPid:child.pid,backendPid:health.backendPid,
      readyMs,viewport,menus,menuTitles:titles,apiMethods:methods.length,pageErrors:errors,profile:'isolated-development',parentDescriptorPidMatched:true,packagedActions:true,
      guiCloseExitCode:exitCode,backendExited:true,runtimeStarted:false,authenticatedSends:0,proTestSends:0,productionDescriptorWrites:0,
      fullPrototypeMemory:{at:memory.at,processes:memory.rows,totalPrivateBytes,scope:'Offline native GUI, Bun action backend and WebView2; Settings displayed, static login placeholder, no loaded ChatGPT conversation or bridge daemon. No equivalent full Electron GUI baseline.'},
      screenshot:join(root,'native-gui-settings.png'),packageManifest:join(packaged.packageRoot,'prototype-package.json')},null,2));
  }finally{
    await browser?.close().catch(()=>{});
    if(child.exitCode===null)child.kill();
  }
},60000);
