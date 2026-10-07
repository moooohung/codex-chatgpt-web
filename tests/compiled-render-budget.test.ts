import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
const ts=require("typescript"),patch=require("../scripts/bridge-render-budget-runtime-overlay.cjs"),failed=require("../scripts/bridge-failed-tab-release-runtime-overlay.cjs");
const base=process.env.CHATGPT_RENDER_BASE_ROOT,candidate=process.env.CHATGPT_RENDER_CANDIDATE_ROOT,failedBase=process.env.CHATGPT_FAILED_TAB_BASE_ROOT;
const nodes=(root:any,predicate:(node:any)=>boolean)=>{const found:any[]=[];const visit=(node:any)=>{if(predicate(node))found.push(node);ts.forEachChild(node,visit);};visit(root);return found;};
function deferred(){let resolve!:()=>void;return {promise:new Promise<void>(yes=>{resolve=yes;}),resolve:()=>resolve()};}
test.skipIf(!base||!candidate)("render/resource edits reproduce all staged modules, reverse all other bytes and preserve all 34 runStage calls",()=>{
 for(const relative of ["app/cli.js","app/browser-helper.cjs","launcher/electron/browser-host.cjs"]){
  const original=readFileSync(join(base!,relative),"utf8"),apply=relative.startsWith("app/")?patch.patchRenderBudgetRuntime:patch.patchResourceBudgetHost,result=apply(original);
  expect(result.code).toBe(readFileSync(join(candidate!,relative),"utf8"));expect(result.evidence.reverseRestoresOriginalBytes).toBeTrue();
  expect(()=>apply(result.code)).toThrow("already present");if(relative.startsWith("app/"))expect(result.evidence.runStageCallsPreserved).toBe(17);
 }
 expect(readFileSync(join(candidate!,"launcher/electron/browser-resource-budget.cjs"),"utf8"))
  .toBe(readFileSync(new URL("../launcher/electron/browser-resource-budget.cjs",import.meta.url),"utf8"));
});
for(const relative of ["app/cli.js","app/browser-helper.cjs"])for(const retain of [false,true])test.skipIf(!candidate||!failedBase)(`${relative}: completed lease releases before diagnostics/physical settlement only when retention is unnecessary (${retain})`,async()=>{
 const code=readFileSync(join(candidate!,relative),"utf8"),file=ts.createSourceFile(relative,code,ts.ScriptTarget.Latest,true);
 const bindings=failed.patchFailedTabRuntime(readFileSync(join(failedBase!,relative),"utf8")).evidence.bindings;
 const browser=nodes(file,(node:any)=>ts.isMethodDeclaration(node)&&node.name.getText(file)==="runBrowserTurn")[0];
 const exclusive=browser.parent.members.find((node:any)=>ts.isMethodDeclaration(node)&&node.name.getText(file)==="runExclusive");
 const lifecycle=browser.body.statements.find((node:any)=>ts.isTryStatement(node)&&node.catchClause&&node.finallyBlock);
 const capture=nodes(browser,(node:any)=>ts.isCallExpression(node)&&node.arguments[1]?.getText(file)==='"turn-completed"')[0];
 let expression=capture;while(!ts.isParenthesizedExpression(expression))expression=expression.parent;
 const diagnostic=deferred(),usage=deferred(),transport=deferred(),rendered=deferred(),diagnosticReached=deferred(),transportReached=deferred();
 let closed=false,released=false,settled=false,captures=0;
 const messages:any[]=[],scope:Record<string,any>={Error,DOMException,AbortController,setInterval,clearInterval,process:{pid:777},console:{info(){},warn(){},error(){}},fixtureRendered:rendered};
 Object.assign(scope,{
  [bindings.notify]:async(_descriptor:string,message:any)=>{messages.push(message);if(message.phase==="end")closed=true;return message.phase==="start"?{surfaceId:"a".repeat(32),reused:false,connectorBound:false}:{cancelledByUser:false};},
  [bindings.compaction]:ChatGptCompactionHandoffAccepted,[bindings.adapterError]:ChatGptWebAdapterError,
  [bindings.heartbeatInterval]:100000,[bindings.heartbeatTimeout]:1000,[bindings.observer]:{dispose(){}},
  [capture.expression.expression.getText(file)]:{capture:async()=>{captures++;diagnosticReached.resolve();await diagnostic.promise;}},
  [capture.arguments[0].getText(file)]:{isClosed:()=>closed},[bindings.usageWrites]:[usage.promise],
  [bindings.prepared]:{release(){released=true;}},[bindings.connection]:{close:async()=>{transportReached.resolve();await transport.promise;}},[bindings.managedPage]:undefined,
 });
 vm.createContext(scope);vm.runInContext(`class Worker{${exclusive.getText(file)}};globalThis.worker=new Worker();
  globalThis.observed=async function(${bindings.turn},__codexOnTurnCompleted){try{${expression.getText(file)};fixtureRendered.resolve();return "answer";}finally ${lifecycle.finallyBlock.getText(file)}};`,scope);
 scope.worker.config={browserHost:"launcher",browserHostDescriptorPath:"offline",appName:"Codex Native2"};
 scope.worker.runBrowserTurn=(turn:any,surface:any,maintenance:any,reused:any,track:any,onFailure:any,onCompleted:any)=>scope.observed(turn,onCompleted);
 const outcome=scope.worker.runExclusive({traceId:"offline_completed",capabilities:{localToolsEnabled:false},conversationKey:"b".repeat(64),retainConversation:retain}).then((value:any)=>{settled=true;return value;});
 try{
  await (retain?diagnosticReached.promise:rendered.promise);
  expect(messages.filter(message=>message.phase==="end")).toHaveLength(retain?0:1);expect(captures).toBe(retain?1:0);
  expect(released).toBeFalse();expect(settled).toBeFalse();diagnostic.resolve();usage.resolve();await transportReached.promise;
  expect(released).toBeTrue();expect(settled).toBeFalse();transport.resolve();expect(await outcome).toBe("answer");
  const ends=messages.filter(message=>message.phase==="end");expect(ends).toHaveLength(1);expect(ends[0].retain).toBe(retain?true:undefined);expect(ends[0].status).toBe("completed");
 }finally{diagnostic.resolve();usage.resolve();transport.resolve();await outcome;}
},10000);
