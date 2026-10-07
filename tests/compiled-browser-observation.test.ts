import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { chromium } from "playwright-core";
import { ChatGptCompletionTracker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
const ts=require("typescript");
const nodes=(root:any,predicate:(n:any)=>boolean)=>{const result:any[]=[];const visit=(n:any)=>{if(predicate(n))result.push(n);ts.forEachChild(n,visit)};visit(root);return result;};
const one=(items:any[],label:string)=>{expect(items.length,label).toBe(1);return items[0]};
const candidate=process.env.CHATGPT_STAGE_CALL_RUNTIME_ROOT;
const browserPath=process.env.CHATGPT_DOM_TEST_BROWSER;

test.skipIf(!candidate || !process.env.CHATGPT_OBSERVATION_BASE_RUNTIME_ROOT)("the reviewed overlay reproduces each candidate exactly and preserves all other runtime bytes",()=>{
  const patch=require("../scripts/bridge-observation-runtime-overlay.cjs");
  for(const relative of ["app/cli.js","app/browser-helper.cjs"]){
    const original=readFileSync(join(process.env.CHATGPT_OBSERVATION_BASE_RUNTIME_ROOT!,relative),"utf8");
    const result=patch(original,relative);
    expect(result.evidence.reverseRestoresOriginalBytes).toBe(true);
    expect(result.code).toBe(readFileSync(join(candidate!,relative),"utf8"));
    expect(()=>patch(original.replace(/Something went wrong\[\\s\\S\]\{0,512\}help/,"changed pattern"),relative)).toThrow();
  }
});

test.skipIf(!candidate || !browserPath)("actual compiled UI projections skip a 1.2M body and quoted errors, while short visible errors still fail", async()=>{
  const browser=await chromium.launch({executablePath:browserPath,headless:true}),results:any[]=[];let networkRequests=0;
  try{
    const page=await browser.newPage();await page.route("**/*",r=>{networkRequests++;return r.abort()});
    for(const relative of ["app/cli.js","app/browser-helper.cjs"]){
      const code=readFileSync(join(candidate!,relative),"utf8"),f=ts.createSourceFile(relative,code,ts.ScriptTarget.Latest,true);
      const project=one(nodes(f,n=>ts.isFunctionDeclaration(n)&&n.name?.text==="__codexTerminalUi20261007"),"compiled UI projection");
      const locator=one(nodes(f,n=>ts.isVariableDeclaration(n)&&n.initializer?.getText(f).includes('evaluateAll(__codexTerminalUi20261007)')),"compiled terminal locator");
      const factory=vm.runInNewContext(project.getText(f)+";("+locator.initializer.getText(f)+")");
      await page.setContent('<main><article><div data-user-message-bubble></div><div data-conversation-role="assistant"><div class="markdown">PART_ACCEPTED</div><div id="error"></div></div></article><aside></aside></main>');
      await page.locator('[data-user-message-bubble]').evaluate(element=>{
        element.innerHTML='<div>'.repeat(160)+'</div>'.repeat(160);let deepest:Element=element;while(deepest.firstElementChild)deepest=deepest.firstElementChild;
        deepest.textContent='Something went wrong '.repeat(15500);
      });
      await page.locator("aside").evaluate(e=>{e.textContent="x".repeat(1200000-document.querySelector("article")!.textContent!.length)});
      const start=performance.now();expect(await factory(page.locator("article")).isVisible()).toBe(false);
      const elapsedMs=Math.round(performance.now()-start);expect(elapsedMs).toBeLessThan(1000);
      const bodyChars=await page.evaluate(()=>document.body.textContent!.length);expect(bodyChars).toBe(1200000);
      const quote="Something went wrong. Please contact help.openai.com.";
      await page.locator('[data-user-message-bubble]').evaluate((e,q)=>{e.textContent=q.repeat(6000)},quote);
      await page.locator(".markdown").evaluate((e,q)=>{e.textContent=q},quote);
      expect(await factory(page.locator("article")).isVisible()).toBe(false);
      await page.locator("#error").evaluate(e=>{e.innerHTML='<span>Something went wrong.</span><span> Please contact </span><a href="#">help.openai.com</a>.'});
      expect(await factory(page.locator("article")).isVisible()).toBe(true);
      await page.locator("#error").evaluate(e=>{(e as HTMLElement).style.display="none"});
      expect(await factory(page.locator("article")).isVisible()).toBe(false);
      results.push({relative,elapsedMs,bodyChars,depth:160,compiledProjectionExecuted:true,quotedErrorIgnored:true,visibleErrorDetected:true});
    }
    if(process.env.CHATGPT_OBSERVATION_FIXTURE_REPORT)writeFileSync(process.env.CHATGPT_OBSERVATION_FIXTURE_REPORT,JSON.stringify({at:new Date().toISOString(),results,networkRequests,proTestSends:0},null,2));
  }finally{await browser.close()}
},15000);

test.skipIf(!candidate)("actual compiled observation wrappers retain empty-boundary capture->observe->ACK and cancel late capture",async()=>{
  for(const relative of ["app/cli.js","app/browser-helper.cjs"]){
    const f=ts.createSourceFile(relative,readFileSync(join(candidate!,relative),"utf8"),ts.ScriptTarget.Latest,true);
    const method=(name:string)=>one(nodes(f,n=>ts.isMethodDeclaration(n)&&n.name.getText(f)===name),name);
    const fn=(name:string)=>one(nodes(f,n=>ts.isFunctionDeclaration(n)&&n.name?.text===name),name);
    const observer=method("observeResponseProbe"),boundary=method("observeSubmissionToolBoundary"),current=method("currentSubmissionAnswerText");
    const budgetAlias=observer.parameters[6].initializer.expression.expression.getText(f);
    const duringCall=one(nodes(observer,n=>ts.isCallExpression(n)&&n.expression.getText(f).endsWith('.observeChatGptToolBoundaryDuring')),"compiled progress observation");
    const duringName=duringCall.expression.expression.expression.getText(f);
    const during=one(nodes(fn(duringName),n=>ts.isFunctionDeclaration(n)&&n.name?.text==="observeChatGptToolBoundaryDuring"),"compiled progress function");
    const timeoutCall=one(nodes(observer,n=>ts.isCallExpression(n)&&n.arguments.length===2&&n.arguments[1].getText(f)==="timeoutMs"),"timeout call");
    const timeoutName=timeoutCall.expression.getText(f),abortName=timeoutCall.arguments[0].expression.getText(f);
    const boundaryFactory=fn("__codexToolBoundary20261007");
    const adapterAlias=one(nodes(boundaryFactory,n=>ts.isVariableDeclaration(n)&&n.name.getText(f)==="ChatGptWebAdapterError"),"adapter alias").initializer.getText(f);
    const adapter=one(nodes(f,n=>ts.isClassDeclaration(n)&&n.name?.text===adapterAlias),"adapter class");
    const observationError=one(nodes(f,n=>ts.isClassDeclaration(n)&&n.getText(f).includes('"ChatGptBrowserObservationTimeoutError"')),"observation error class");
    const identityCall=one(nodes(current,n=>ts.isCallExpression(n)&&n.arguments[0]?.getText(f).endsWith('.initialTurnIdentities')),"bound identity helper");
    const locatorCall=one(nodes(current,n=>ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==="locator"),"bound locator");
    const selectorName=locatorCall.arguments[0].expression.getText(f);
    const stopped=one(nodes(current,n=>ts.isThrowStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.arguments.length===0),"stopped-thinking error").expression.expression.getText(f);
    const logs:string[]=[];
    const context=vm.createContext({AbortController,AbortSignal,DOMException,Date,performance,setTimeout,clearTimeout,Error,
      console:{info:(s:string)=>logs.push(s)},[budgetAlias]:{chatGptPageObservationTimeoutMs:()=>5000},[selectorName]:(identity:string)=>identity});
    vm.runInContext([adapter.getText(f),observationError.getText(f),fn(timeoutName).getText(f),fn(abortName).getText(f),boundaryFactory.getText(f),
      during.getText(f),`function ${duringName}(){return {observeChatGptToolBoundaryDuring}}`,fn(identityCall.expression.getText(f)).getText(f),
      fn(stopped).getText(f),
      `class Worker {${observer.getText(f)} ${boundary.getText(f)} ${current.getText(f)} ${method("boundedResponseDomSnapshot").getText(f)}};globalThis.worker=new Worker();`].join("\n"),context);
    const worker:any=context.worker,tracker=new ChatGptCompletionTracker(),progress=new ChatGptExternalTurnProgress();
    context.tracker=tracker;vm.runInContext('__codexToolBoundary20261007().setChatGptToolBoundaryTrace(tracker,"2bb429a19c75abcdef")',context);
    worker.submissionDomState=async()=>({responseIdentities:[]});const revision=progress.recordToolBatch(1);
    await worker.observeSubmissionToolBoundary({}, {initialTurnIdentities:[],domCache:{}}, undefined, progress, tracker);
    await progress.waitForToolBatchObservation(revision);expect(tracker.needsToolBatchObservation(revision)).toBe(false);
    expect(logs.some(s=>s.includes('"stage":"capture_observed"'))).toBe(true);
    const trackerText=new ChatGptCompletionTracker(),progressText=new ChatGptExternalTurnProgress();
    worker.submissionDomState=async()=>({responseIdentities:["group:assistant:offline"]});
    worker.responseDomSnapshot=async()=>({responsePresent:true,visibleText:"observed pre-tool text",stoppedThinkingVisible:false});
    const revisionText=progressText.recordToolBatch(1);
    await worker.observeSubmissionToolBoundary({locator:()=>({})},{initialTurnIdentities:[],domCache:{}},undefined,progressText,trackerText);
    await progressText.waitForToolBatchObservation(revisionText);expect(trackerText.needsToolBatchObservation(revisionText)).toBe(false);
    expect(logs.some(s=>s.includes('"stage":"capture_observed"')&&s.includes('"textChars":22'))).toBe(true);
    const trackerFailed=new ChatGptCompletionTracker(),progressFailed=new ChatGptExternalTurnProgress();
    worker.responseDomSnapshot=async()=>({responsePresent:false,visibleText:"",stoppedThinkingVisible:false});
    const revisionFailed=progressFailed.recordToolBatch(1);
    await expect(worker.observeSubmissionToolBoundary({locator:()=>({})},{initialTurnIdentities:[],domCache:{}},undefined,progressFailed,trackerFailed))
      .rejects.toMatchObject({code:"chatgpt_tool_boundary_observation_failed",retryable:false});
    expect(trackerFailed.needsToolBatchObservation(revisionFailed)).toBe(true);
    const cancelled=new AbortController(),tracker2=new ChatGptCompletionTracker(),progress2=new ChatGptExternalTurnProgress();
    let finish!:()=>void;worker.submissionDomState=()=>new Promise(resolve=>{finish=()=>resolve({responseIdentities:[]})});
    const revision2=progress2.recordToolBatch(1),pending=worker.observeSubmissionToolBoundary({}, {initialTurnIdentities:[],domCache:{}}, cancelled.signal, progress2, tracker2);
    await Bun.sleep(1);cancelled.abort(new Error("offline cancellation"));await expect(pending).rejects.toThrow("offline cancellation");finish();await Bun.sleep(1);
    expect(tracker2.needsToolBatchObservation(revision2)).toBe(true);
    expect(logs.some(s=>s.includes('"probe":"boundary_turn_state"')&&s.includes('"failed":true'))).toBe(true);
    await expect(worker.observeResponseProbe({}, {}, undefined, undefined, tracker,()=>new Promise(()=>{}),10,"terminal_error"))
      .rejects.toMatchObject({name:"ChatGptBrowserObservationTimeoutError"});
    expect(logs.some(s=>s.includes('"probe":"terminal_error"')&&s.includes('browser_observation_timeout'))).toBe(true);
    expect(logs.join("\n")).not.toContain("abcdef");
  }
});
