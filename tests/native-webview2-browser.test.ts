import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { connectLauncherBrowserHost } from "../src/launcher-browser-host";
import { throwIfChatGptTerminalErrorAlert } from "../src/adapters/chatgpt-web/browser-worker";
const { NativeHostClient } = require("../launcher/native-webview2/host-client.cjs");

test.skipIf(!process.env.CHATGPT_NATIVE_HOST_BINARY)("native WebView2 owns CDP targets, isolates profiles, preserves leased pages and closes completed controllers", async () => {
  const artifactRoot = resolve(process.env.CHATGPT_NATIVE_TEST_OUTPUT ?? "output/native-webview2");
  mkdirSync(artifactRoot, { recursive: true });
  const server = Bun.serve({hostname:"127.0.0.1", port:0, fetch:()=>new Response('<!doctype html><title>Offline native host fixture</title><article data-turn-key="offline"><div data-user-message-bubble></div><div data-conversation-role="assistant"><div class="markdown">PART_ACCEPTED</div></div></article>', {headers:{"content-type":"text/html"}})});
  const client = await NativeHostClient.start({executable:process.env.CHATGPT_NATIVE_HOST_BINARY, userDataFolder:join(artifactRoot,"profiles",randomBytes(8).toString("hex"))});
  let browser: Browser | undefined;
  const probes:any[]=[];
  const ownedTabs:string[]=[];
  try {
    const alphaId=randomBytes(24).toString("base64url"), betaId=randomBytes(24).toString("base64url");
    const url='http://127.0.0.1:'+server.port+'/fixture';
    const alpha=await client.addTab({tabId:alphaId,profile:"account_alpha",url,leased:true}); ownedTabs.push(alphaId);
    const beta=await client.addTab({tabId:betaId,profile:"account_beta",url,leased:true}); ownedTabs.push(betaId);
    expect(alpha.targetId).not.toBe(beta.targetId);
    const descriptorPath=join(artifactRoot,"launcher-browser-development.json");
    writeFileSync(descriptorPath,JSON.stringify({version:3,kind:"codex-web-gpt-launcher",profile:"development",pid:client.pid,endpoint:client.endpoint,
      control:{endpoint:'http://127.0.0.1:'+server.port,token:randomBytes(36).toString("base64url")},helper:{executable:process.execPath,script:import.meta.path},
      partition:"persist:codex-web-gpt-dev-chatgpt",idleUrl:"data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Chtml%3E%3Chead%3E%3Cmeta%20charset%3D%22utf-8%22%3E%3Ctitle%3ECodex%20Web%20GPT%3C%2Ftitle%3E%3C%2Fhead%3E%3Cbody%3E%3C%2Fbody%3E%3C%2Fhtml%3E#codex-web-gpt-browser-host",
      surfaceId:alphaId,surfaceTargets:{[alphaId]:alpha.targetId,[betaId]:beta.targetId},createdAt:new Date().toISOString()}));
    const connection=await connectLauncherBrowserHost(descriptorPath,10000,alphaId);
    browser=connection.browser;
    const alphaPage=connection.page;
    await alphaPage.waitForURL(url); await alphaPage.waitForLoadState("domcontentloaded");
    const betaConnection=await connectLauncherBrowserHost(descriptorPath,10000,betaId);
    const betaPage=betaConnection.page;
    await betaPage.waitForURL(url); await betaPage.waitForLoadState("domcontentloaded");
    await alphaPage.evaluate(()=>{localStorage.setItem("isolated-account","alpha");document.cookie="isolated_account=alpha; path=/";});
    expect(await betaPage.evaluate(()=>localStorage.getItem("isolated-account"))).toBeNull();
    expect(await betaPage.evaluate(()=>document.cookie)).not.toContain("isolated_account=alpha");
    await expect(client.closeTab(alphaId)).rejects.toThrow("Active turn tab cannot be closed");
    await expect(client.quit()).rejects.toThrow("Active turn leases");
    await client.selectTab(alphaId);
    await client.setVisible(true); await client.setVisible(false); await client.setVisible(true);
    expect(await alphaPage.evaluate(()=>localStorage.getItem("isolated-account"))).toBe("alpha");
    const restored=await client.snapshot();
    expect(restored.visible).toBe(true);
    expect(restored.tabs.find((tab:any)=>tab.tabId===alphaId).width).toBeGreaterThanOrEqual(320);
    expect(restored.tabs.find((tab:any)=>tab.tabId===betaId).height).toBeGreaterThanOrEqual(240);
    await alphaPage.locator('[data-user-message-bubble]').evaluate(element=>{element.textContent="Something went wrong ".repeat(57000);});
    const started=performance.now(); await throwIfChatGptTerminalErrorAlert(alphaPage.locator("article"));
    const probeMs=Math.round(performance.now()-started);
    expect(probeMs).toBeLessThan(1000);
    probes.push({phase:"large_dom",bodyChars:await alphaPage.evaluate(()=>document.body.textContent!.length),probeMs});
    await client.setVisible(false); await client.selectTab(betaId); await client.setVisible(true);
    expect(await alphaPage.evaluate(()=>localStorage.getItem("isolated-account"))).toBe("alpha");
    expect(await betaPage.evaluate(()=>localStorage.getItem("isolated-account"))).toBeNull();
    probes.push({phase:"two_profiles",snapshot:await client.snapshot()});
    for(let index=0;index<8;index++){
      const tabId='cycle_'+index;
      const tab=await client.addTab({tabId,profile:"account_alpha",url,selected:false}); ownedTabs.push(tabId);
      const targets=await(await fetch(client.endpoint+'/json/list')).json() as Array<{id:string}>;
      expect(targets.some(target=>target.id===tab.targetId)).toBe(true);
      await client.closeTab(tabId); ownedTabs.splice(ownedTabs.indexOf(tabId),1);
      const after=await(await fetch(client.endpoint+'/json/list')).json() as Array<{id:string}>;
      expect(after.some(target=>target.id===tab.targetId)).toBe(false);
      probes.push({phase:"closed_controller",cycle:index,snapshot:await client.snapshot()});
    }
    await betaConnection.browser.close();
    writeFileSync(join(artifactRoot,"native-browser-verification.json"),JSON.stringify({at:new Date().toISOString(),runtime:client.runtime,descriptorContract:true,profileStorageIsolated:true,leaseCloseRejected:true,visibilityApiRestoredDocument:true,closedControllerCycles:8,probes,authenticatedSends:0,proTestSends:0,productionDescriptorWrites:0,limitation:"Offline native host and CDP checks through the visibility API; no physical tray-click, authenticated model/tool turn or sustained memory-leak certification."},null,2));
  } finally {
    await browser?.close().catch(()=>{});
    for(const tabId of ownedTabs){await client.setLease(tabId,false).catch(()=>{});await client.closeTab(tabId).catch(()=>{});}
    await client.quit().catch(()=>client.child.kill());
    server.stop(true);
  }
},60000);
