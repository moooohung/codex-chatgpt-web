import {test,expect} from 'bun:test';
import {join,resolve} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {chromium} from 'playwright-core';
import {selectLauncherPage} from '../src/launcher-browser-host';
import {copyFor} from '../launcher/src/i18n';
const {freezeLegacy}=require('../launcher/native-webview2/freeze-legacy.cjs');
const {startNativeLauncher}=require('../launcher/native-webview2/backend.cjs');

test.skipIf(!process.env.CHATGPT_NATIVE_HOST_BINARY||!process.env.CHATGPT_NATIVE_RUNTIME_ROOT)('native launcher displays every existing menu and uses the existing action handlers',async()=>{
  const root=resolve(process.env.CHATGPT_NATIVE_TEST_OUTPUT||'output/native-webview2'),caseRoot=join(root,'ui-'+randomBytes(6).toString('hex'));mkdirSync(caseRoot,{recursive:true});
  const {legacyRoot}=freezeLegacy(resolve(import.meta.dir,'..'),join(caseRoot,'capsule'));
  const application=await startNativeLauncher({nativeExecutable:process.env.CHATGPT_NATIVE_HOST_BINARY,legacyRoot,rendererRoot:resolve(process.env.CHATGPT_NATIVE_RENDERER_ROOT||'launcher/dist'),runtimeRoot:process.env.CHATGPT_NATIVE_RUNTIME_ROOT,
    profile:{kind:'development',displayName:'Codex Web GPT DEV',coreHome:join(caseRoot,'core'),userData:join(caseRoot,'launcher'),codexHome:join(caseRoot,'codex'),browserPartition:'persist:codex-web-gpt-dev-chatgpt'},startRuntime:false});
  let browser;
  const errors:string[]=[],menus:string[]=[];
  try {
    await application.client.request('resize',['2800','1950']);await application.platform.window.refresh();
    browser=await chromium.connectOverCDP(application.client.endpoint);
    const {page}=await selectLauncherPage(browser,{surfaceTargets:{ui:application.ui.targetId}} as any,10000,'ui');
    page.on('pageerror',error=>errors.push(error.message));
    await page.waitForFunction(()=>typeof (window as any).codexWebLauncher?.snapshot==='function');
    await page.getByRole('navigation').waitFor({timeout:15000});
    const methods=await page.evaluate(()=>Object.keys((window as any).codexWebLauncher));
    const expectedMethods=[...readFileSync(join(legacyRoot,'preload.cjs'),'utf8').matchAll(/^  (\w+):/gm)].map(match=>match[1]);
    expect(methods.sort()).toEqual(expectedMethods.sort());
    expect(application.actions.actionCount).toBeGreaterThanOrEqual(48);
    const copy=copyFor('en'),titles:Record<string,string>={Setup:copy.devSetupTitle,MCP:copy.devMcpTitle,Accounts:copy.accountsTitle,Activity:copy.activityTitle,Limits:'Limits',Settings:copy.devSettingsTitle,Browser:copy.stepAccount};
    for(const name of ['Setup','MCP','Accounts','Activity','Limits','Settings','Browser']) {
      await page.getByRole('button',{name,exact:true}).click();menus.push(name);
      await page.getByRole('heading',{name:titles[name],exact:true}).waitFor({state:'visible',timeout:10000});
      await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('.surface-transition')!).opacity)>0.99);
      expect(await page.locator('#root').textContent()).not.toContain('Unknown launcher action');
    }
    const state=await page.evaluate(async()=>{const api=(window as any).codexWebLauncher;await api.setPreference('showBrowserDuringTurns',true);await api.setSidebarState({open:true,width:336});return api.snapshot();});
    expect(state.state.showBrowserDuringTurns).toBe(true);
    expect(state.profile).toBe('development');
    await expect(page.evaluate(()=>(window as any).codexWebLauncher.setPreference('bad-setting',true))).rejects.toThrow('Unknown preference');
    expect(errors).toEqual([]);
    await page.screenshot({path:join(caseRoot,'all-menus.png')});
    writeFileSync(join(root,'native-ui-verification.json'),JSON.stringify({at:new Date().toISOString(),menus,apiMethods:methods,actionCount:application.actions.actionCount,pageErrors:errors,profile:'isolated-development',runtimeStarted:false,proTestSends:0,authenticatedSends:0,artifactRoot:caseRoot},null,2));
  } finally {await browser?.close().catch(()=>{});const result=await application.close();if(!result.ok){application.client.child.kill();throw Error(result.message);}}
},60000);
