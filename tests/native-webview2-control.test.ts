import {test,expect} from 'bun:test';
import {join,resolve} from 'node:path';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {connectLauncherBrowserHost} from '../src/launcher-browser-host';
const {freezeLegacy}=require('../launcher/native-webview2/freeze-legacy.cjs');
const {startNativeLauncher}=require('../launcher/native-webview2/backend.cjs');

test.skipIf(!process.env.CHATGPT_NATIVE_HOST_BINARY||!process.env.CHATGPT_NATIVE_RUNTIME_ROOT)('native WebView2 preserves authenticated control leases, retained targets and owner rejection',async()=>{
  const root=resolve(process.env.CHATGPT_NATIVE_TEST_OUTPUT||'output/native-webview2'),caseRoot=join(root,'control-'+randomBytes(6).toString('hex'));mkdirSync(caseRoot,{recursive:true});
  const {legacyRoot}=freezeLegacy(resolve(import.meta.dir,'..'),join(caseRoot,'capsule'));
  const application=await startNativeLauncher({nativeExecutable:process.env.CHATGPT_NATIVE_HOST_BINARY,legacyRoot,rendererRoot:resolve('launcher/dist'),runtimeRoot:process.env.CHATGPT_NATIVE_RUNTIME_ROOT,
    profile:{kind:'development',displayName:'Codex Web GPT DEV',coreHome:join(caseRoot,'core'),userData:join(caseRoot,'launcher'),codexHome:join(caseRoot,'codex'),browserPartition:'persist:codex-web-gpt-dev-chatgpt'},startRuntime:false});
  let connection;
  const descriptor=JSON.parse(readFileSync(application.descriptorPath,'utf8'));
  const post=(route:string,body:object,authorized=true)=>fetch(descriptor.control.endpoint+route,{method:'POST',headers:{'content-type':'application/json',...(authorized?{authorization:'Bearer '+descriptor.control.token}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const owner={traceId:'native_fixture_one',helperPid:process.pid,conversationKey:'a'.repeat(64),connectorIdentity:'OfflineFixture'};
  try {
    expect((await post('/v1/turn/start',owner,false)).status).toBe(401);
    const start=await post('/v1/turn/start',owner);expect(start.status).toBe(200);const lease=await start.json();expect(lease.reused).toBe(false);
    connection=await connectLauncherBrowserHost(application.descriptorPath,10000,lease.surfaceId);
    await connection.page.evaluate(()=>{(window as any).nativeFixtureDocument='preserved';document.body.textContent='offline tool boundary fixture';});
    const tab=[...application.browserHost.turnTabs.values()].find((entry:any)=>entry.traceId===owner.traceId) as any;
    await application.platform.flush();
    await expect(application.client.closeTab(tab.view.id)).rejects.toThrow('Active turn tab');
    expect((await post('/v1/turn/heartbeat',{...owner,helperPid:process.pid+9876})).status).toBe(400);
    expect((await post('/v1/turn/approval',{...owner,pending:true})).status).toBe(200);
    expect(tab.approvalPending).toBe(true);
    expect((await post('/v1/turn/heartbeat',{...owner,refreshViewport:true,progress:{stage:'chatgpt',activeToolCalls:1}})).status).toBe(200);
    expect((await post('/v1/turn/end',{...owner,status:'completed',retain:true,connectorBound:true})).status).toBe(200);
    await application.platform.flush();
    const reusedOwner={...owner,traceId:'native_fixture_two',requireRetainedConversation:true};
    const resume=await post('/v1/turn/start',reusedOwner);expect(resume.status).toBe(200);const resumed=await resume.json();
    expect(resumed.reused).toBe(true);expect(resumed.surfaceId).toBe(lease.surfaceId);expect(resumed.connectorBound).toBe(true);
    expect(await connection.page.evaluate(()=>(window as any).nativeFixtureDocument)).toBe('preserved');
    expect((await post('/v1/turn/start',{...reusedOwner,connectorIdentity:'wrong-connector'})).status).toBe(400);
    expect((await post('/v1/turn/end',{...reusedOwner,status:'completed',retain:true,connectorBound:true})).status).toBe(200);
    const release=await post('/v1/turn/release',{conversationKey:owner.conversationKey});expect(release.status).toBe(200);expect((await release.json()).released).toBe(1);
    await application.platform.flush();
    expect(application.browserHost.turnTabs.size).toBe(0);
    writeFileSync(join(root,'native-control-verification.json'),JSON.stringify({at:new Date().toISOString(),bearerRequired:true,wrongOwnerRejected:true,leasedCloseRejected:true,retainedDocumentPreserved:true,connectorIdentityPreserved:true,releaseCompleted:true,scope:'Offline real WebView2 and existing HTTP control server; no ChatGPT authentication, prompt send, MCP tool emission or boundary ACK proof.',proTestSends:0,authenticatedSends:0},null,2));
  } finally {await connection?.browser.close().catch(()=>{});const result=await application.close();if(!result.ok){application.client.child.kill();throw Error(result.message);}}
},60000);
