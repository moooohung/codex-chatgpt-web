import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import vm from "node:vm";
import { chromium } from "playwright-core";
import { chatGptSubmissionDomProjection } from "../src/adapters/chatgpt-web/submission-ui";
import { ChatGptBrowserWorker, ChatGptCompletionTracker, isChatGptMultipartAcknowledgement, chatGptTurnIsComplete } from "../src/adapters/chatgpt-web/browser-worker";
import { captureChatGptToolBoundary } from "../src/adapters/chatgpt-web/tool-boundary";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { CHATGPT_USER_TURN_SELECTOR, CHATGPT_ASSISTANT_TURN_SELECTOR, CHATGPT_STOP_BUTTON_SELECTOR } from "../src/chatgpt-session";
const options={userTurnSelector:CHATGPT_USER_TURN_SELECTOR,assistantTurnSelector:CHATGPT_ASSISTANT_TURN_SELECTOR,stopButtonSelector:CHATGPT_STOP_BUTTON_SELECTOR,attributeFilter:[]};
const picker=readFileSync(new URL("./fixtures/chatgpt-model-picker-oct7.html",import.meta.url),"utf8");
const ack="CODEX_MULTIPART_ACK ctx_offline 1/2 a1b2c3d4";
const projections: Array<{ name: string; project: typeof chatGptSubmissionDomProjection }>=[{name:"source",project:chatGptSubmissionDomProjection}];
if(process.env.CHATGPT_RENDER_CANDIDATE_ROOT){
 const ts=require("typescript");
 for(const relative of ["app/cli.js","app/browser-helper.cjs"]){
  const file=ts.createSourceFile(relative,readFileSync(join(process.env.CHATGPT_RENDER_CANDIDATE_ROOT,relative),"utf8"),ts.ScriptTarget.Latest,true);
  const matches=file.statements.filter((node:any)=>ts.isFunctionDeclaration(node)
    && (node.name?.text==="__codexSubmissionUi20261007"
      || node.getText(file).includes('codex-history-render-budget') && node.getText(file).includes('contain-intrinsic-size')));
  if(matches.length!==1)throw Error("Exactly one compiled rendering projection is required");
  const fn=matches[0];
  projections.push({name:relative,project:vm.runInNewContext("("+fn.getText(file)+")")});
 }
}
for(const {name,project} of projections)for(const chars of [320000,1000000])test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`${name}: ${chars} chars preserve model/effort, multipart ACK, tool boundary and completion`,async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
 try{
  const page=await browser.newPage({viewport:process.env.CHATGPT_RENDER_TEST_VIEWPORT === "bounded"
    ? {width:1280,height:900} : {width:1120,height:800}});await page.route("**/*",route=>route.abort());await page.setContent(picker);
  await page.evaluate(({chars,ack})=>{
   const main=document.createElement("main");document.body.prepend(main);
   for(let i=0;i<8;i++){
    const group=document.createElement("article");group.dataset.turnKey="fixture_"+i;
    group.innerHTML='<div data-user-message-bubble><pre class="payload"></pre></div><div data-content-search-unit-key="assistant_'+i+'"><div data-conversation-role="assistant"><div class="markdown"><p></p></div></div></div>';
    group.querySelector(".payload")!.textContent="context line\n".repeat(Math.ceil(chars/8/13)).slice(0,chars/8);
    group.querySelector(".markdown p")!.textContent=i===7?ack:"old answer";
    if(i===7)group.querySelector('[data-conversation-role="assistant"]')!.insertAdjacentHTML("beforeend",'<button data-testid="copy-turn-action-button">Copy</button>');
    main.appendChild(group);
   }
  },{chars,ack});
  const payload=()=>page.locator(".payload").allTextContents();
  const original=(await payload()).join(""),hash=createHash("sha256").update(original).digest("hex");expect(original.length).toBe(chars);
  const projected=await page.evaluate(project,options);
  expect(projected.snapshot?.userTurnCount).toBe(8);expect(projected.snapshot?.assistantTurnCount).toBe(8);
  expect(projected.deferredHistoryNodes).toBe(6);expect(projected.deferredInputNodes).toBe(8);
  const boundaryProjection=await page.evaluate(project,{...options,purpose:"tool_boundary" as const,knownKey:projected.key});
  expect(boundaryProjection.snapshot?.turnIdentities).toEqual(projected.snapshot?.turnIdentities);
  expect(boundaryProjection.deferredHistoryNodes).toBe(0);expect(boundaryProjection.deferredInputNodes).toBe(0);
  expect(boundaryProjection.snapshot?.visibleStopButtonCount).toBe(0);
  const worker:any=Object.create(ChatGptBrowserWorker.prototype);
  const mode=await worker.selectModelAndEffort(page,CHATGPT_WEB_MODEL_ID,"high",{localToolsEnabled:false,solAvailable:true,extraHighAvailable:true,proAvailable:false},undefined,false,"5.6");
  await worker.assertSelectedEffort(page,mode);
  expect(await page.evaluate(()=>(window as any).sends)).toBe(0);expect(await page.locator("#prompt-textarea").innerText()).toBe("Unsent draft");
  const current=page.locator('[data-turn-key="fixture_7"]');await current.scrollIntoViewIfNeeded();
  const snapshot=await worker.responseDomSnapshot(current,{});
  expect(isChatGptMultipartAcknowledgement(snapshot.visibleText,ack)).toBeTrue();expect(snapshot.visibleText).not.toContain("context line");
  expect(snapshot.completionActionVisible).toBeTrue();
  const tracker=new ChatGptCompletionTracker(),progress=new ChatGptExternalTurnProgress(),revision=progress.recordToolBatch(1),events:string[]=[];
  await captureChatGptToolBoundary({tracker,revision,timeoutMs:1000,capture:async()=>{events.push("capture");return (await worker.responseDomSnapshot(current,{})).visibleText;},acknowledge:async()=>{events.push("ack");progress.acknowledgeToolBatch(revision);}});
  await progress.waitForToolBatchObservation(revision);events.push("emission");expect(events).toEqual(["capture","ack","emission"]);
  const completion={responsePresent:snapshot.responsePresent,running:false,currentText:snapshot.visibleText,completionActionVisible:snapshot.completionActionVisible};
  expect(chatGptTurnIsComplete(completion)).toBeTrue();expect(chatGptTurnIsComplete({...completion,running:true})).toBeFalse();expect(chatGptTurnIsComplete({...completion,completionActionVisible:false})).toBeFalse();
  expect(await page.locator('[data-turn-key="fixture_7"]').getAttribute("data-codex-history-render-budget")).toBeNull();
  expect(await page.locator('[data-turn-key="fixture_7"] [data-conversation-role="assistant"]').evaluate(el=>getComputedStyle(el).contentVisibility)).toBe("visible");
  expect(createHash("sha256").update((await payload()).join("")).digest("hex")).toBe(hash);
 }finally{await browser.close();}
},30000);
