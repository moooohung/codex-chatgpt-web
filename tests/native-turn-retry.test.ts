import {afterEach, expect, test} from "bun:test";
import {appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {authenticateNativeFailedTurnRetry, prepareNativeFailedTurnRetry} from "../src/adapters/chatgpt-web/native-turn-retry";
import {CHATGPT_TURN_REVISION_CONFLICT_MESSAGE, extractChatGptTurnUserRevision, verifiedNativeRetrySourceTurnId} from "../src/adapters/chatgpt-web/environment";
import {ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions, chatGptTurnExecutionKey} from "../src/adapters/chatgpt-web/turn-execution";
import {parseRequest} from "../src/responses/parser";
import {defaultConfig} from "../src/config";
import {responseRequest} from "../src/server";

const roots: string[]=[];
afterEach(()=> { for(const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
const threadId="11111111-1111-7111-8111-111111111111";
const oldTurn="22222222-2222-7222-8222-222222222222";
const turnId="33333333-3333-7333-8333-333333333333";
function fixture(error: unknown={codex_error_info:"server_overloaded"}) {
  const home=mkdtempSync(join(tmpdir(),"native-retry-")); roots.push(home);
  const directory=join(home,"sessions/2026/10/02"); mkdirSync(directory,{recursive:true});
  const source={type:"message",id:"msg_continue",role:"user",content:[{type:"input_text",text:"continue\n"}],internal_chat_message_metadata_passthrough:{turn_id:oldTurn,content_item_kinds:["user.text"]}};
  const metadata={thread_id:threadId,turn_id:turnId,request_kind:"turn",sandbox:"none",workspaces:{[home]:{}}};
  const context={type:"turn_context",payload:{turn_id:turnId,cwd:home,workspace_roots:[home],permission_profile:{type:"disabled"},sandbox_policy:{type:"danger-full-access"}}};
  const rows: unknown[]=[{type:"session_meta",payload:{id:threadId,source:"cli"}},
    {type:"response_item",payload:source},{type:"event_msg",payload:{type:"task_complete",turn_id:oldTurn,error}},
    {type:"event_msg",payload:{type:"task_started",turn_id:turnId}},context];
  const file=join(directory,`rollout-2026-10-02T06-00-00-${threadId}.jsonl`);
  const save=()=>writeFileSync(file,rows.map(row=>JSON.stringify(row)).join("\n")+"\n"); save();
  const request=()=>parseRequest({model:"chatgpt-web/gpt-5.6-sol",input:[structuredClone(source)],client_metadata:{"x-codex-turn-metadata":JSON.stringify(metadata)}});
  return {home,source,metadata,context,rows,file,save,request};
}

function interruptedFixture() {
  const f=fixture();
  f.rows.splice(1, f.rows.length-1,
    {type:"event_msg",payload:{type:"task_started",turn_id:oldTurn}},
    {...f.context,payload:{...f.context.payload,turn_id:oldTurn}},
    {type:"response_item",payload:f.source},
    {type:"event_msg",payload:{type:"task_started",turn_id:turnId}}, f.context);
  f.save();
  return f;
}

test("desktop Play resumes an unfinished native task with its original instruction after restart",()=> {
  const f=interruptedFixture(), parsed=f.request();
  expect(()=>chatGptTurnExecutionKey(parsed)).toThrow("conflicts with native Codex turn_id");
  expect(authenticateNativeFailedTurnRetry(parsed,f.home)).toBe(true);
  expect(extractChatGptTurnUserRevision(parsed)).toEqual(f.source.content);
  expect(chatGptTurnExecutionKey(parsed)).toBeString();
  // A fresh daemon has no process-local evidence; the native rollout proves the new request.
  const restarted=f.request();
  expect(()=>chatGptTurnExecutionKey(restarted)).toThrow();
  expect(authenticateNativeFailedTurnRetry(restarted,f.home)).toBe(true);
  expect(chatGptTurnExecutionKey(restarted)).toBe(chatGptTurnExecutionKey(parsed));
  expect(verifiedNativeRetrySourceTurnId(restarted)).toBe(oldTurn);
  const original=f.request();
  (original._rawBody as {client_metadata:Record<string,string>}).client_metadata["x-codex-turn-metadata"]=JSON.stringify({...f.metadata,turn_id:oldTurn});
  expect(chatGptTurnExecutionKey(original)).not.toBe(chatGptTurnExecutionKey(restarted));
});

test("authenticated Play retires the old browser and starts one replacement only after physical cleanup",async()=> {
  const f=interruptedFixture(), parsed=f.request();
  expect(authenticateNativeFailedTurnRetry(parsed,f.home)).toBe(true);
  const sessions=new ChatGptTurnSessions();
  let cleanup!:()=>void;
  let cancellations=0, starts=0;
  const runtime=()=>({mode:"read-only" as const,browser:new Promise<string>(()=>{}),
    physicalSettlement:new Promise<void>(resolve=>{cleanup=resolve}),trace:new ChatGptTraceFeed(),text:new ChatGptTextFeed(),cancel:()=>{cancellations++}});
  sessions.getOrCreate("old",runtime,"old_trace","owner",oldTurn,threadId);
  sessions.getOrCreate("other",()=>({mode:"read-only" as const,browser:new Promise<string>(()=>{}),
    physicalSettlement:Promise.resolve(),trace:new ChatGptTraceFeed(),text:new ChatGptTextFeed(),cancel:()=>{}}),"other_trace","other_owner",oldTurn,threadId);
  expect(sessions.retireAbortedOwnerTurns("owner",new Set([verifiedNativeRetrySourceTurnId(parsed)!]),"new")).toBe(1);
  const start=()=>{starts++;return {mode:"read-only" as const,browser:Promise.resolve("done"),physicalSettlement:Promise.resolve(),trace:new ChatGptTraceFeed(),text:new ChatGptTextFeed(),cancel:()=>{}}};
  const first=sessions.getOrCreateAfterOwnerRetirement("new","owner",start,"new_trace",undefined,turnId,threadId);
  const duplicate=sessions.getOrCreateAfterOwnerRetirement("new","owner",start,"new_trace",undefined,turnId,threadId);
  await Promise.resolve();
  expect(starts).toBe(0);
  expect(cancellations).toBe(1);
  expect(sessions.find("other")).toBeDefined();
  cleanup();
  expect(await first).toBe(await duplicate);
  expect(starts).toBe(1);
  sessions.clear();
});

test("restart recovery waits for complete native writes and rechecks cancellation",async()=> {
  for(const cancel of [false,true]) {
    const f=interruptedFixture();
    const row={type:"event_msg",payload:{type:cancel?"task_aborted":"token_count",turn_id:turnId}};
    const line=JSON.stringify(row); const split=Math.floor(line.length/2);
    appendFileSync(f.file,line.slice(0,split));
    const timer=setTimeout(()=>appendFileSync(f.file,line.slice(split)+"\n"),20);
    try {expect(await prepareNativeFailedTurnRetry(f.request(),{codexHome:f.home,timeoutMs:200})).toBe(!cancel);}
    finally {clearTimeout(timer);}
  }
});

test("an unfinished native append returns a temporary failure without granting replay authority",async()=> {
  const f=interruptedFixture(), parsed=f.request(); appendFileSync(f.file,'{"type":"event_msg"');
  await expect(prepareNativeFailedTurnRetry(parsed,{codexHome:f.home,timeoutMs:20})).rejects.toMatchObject({status:503,code:"native_snapshot_not_ready"});
  expect(verifiedNativeRetrySourceTurnId(parsed)).toBeUndefined();
});

test("native Play can arrive after task_started but before its new turn_context is appended",async()=> {
  const f=interruptedFixture(); f.rows.pop(); f.save();
  const timer=setTimeout(()=>appendFileSync(f.file,JSON.stringify(f.context)+"\n"),20);
  try {expect(await prepareNativeFailedTurnRetry(f.request(),{codexHome:f.home,timeoutMs:200})).toBe(true);}
  finally {clearTimeout(timer);}
});

test("restart recovery requires both task boundaries and never revives completed or cancelled work",()=> {
  for (const mutation of ["oldStart","oldContext","newStart","success","failure","cancel","foreignTurn","newInstruction","compaction","completedReplay"]) {
    const f=interruptedFixture();
    if(mutation==="oldStart") f.rows.splice(1,1);
    else if(mutation==="oldContext") f.rows.splice(2,1);
    else if(mutation==="newStart") f.rows.splice(4,1);
    else if(mutation==="success" || mutation==="failure") f.rows.splice(4,0,
      {type:"event_msg",payload:{type:"task_complete",turn_id:oldTurn,error:mutation==="success"?null:{codex_error_info:"other"}}});
    else if(mutation==="cancel") f.rows.splice(4,0,{type:"event_msg",payload:{type:"task_aborted",turn_id:oldTurn}});
    else if(mutation==="foreignTurn") f.rows.splice(4,0,{type:"event_msg",payload:{type:"task_started",turn_id:oldTurn.replace(/.$/,"9")}});
    else if(mutation==="newInstruction") f.rows.splice(4,0,{type:"response_item",payload:{...f.source,id:"new_instruction",content:"a different task"}});
    else if(mutation==="compaction") f.rows.splice(4,0,{type:"response_item",payload:{type:"compaction",encrypted_content:"checkpoint"}});
    else f.rows.push({type:"event_msg",payload:{type:"task_complete",turn_id:turnId}});
    f.save();
    expect(authenticateNativeFailedTurnRetry(f.request(),f.home)).toBe(false);
  }
});

test("Play can recover an unfinished instruction after an older build rejected the first Play",()=> {
  for (const message of [CHATGPT_TURN_REVISION_CONFLICT_MESSAGE,"an unrelated validation failure"]) {
    const f=interruptedFixture();
    const intermediate=oldTurn.replace(/.$/,"9");
    f.rows.splice(4,0,{type:"event_msg",payload:{type:"task_started",turn_id:intermediate}},
      {...f.context,payload:{...f.context.payload,turn_id:intermediate}},
      {type:"event_msg",payload:{type:"task_complete",turn_id:intermediate,error:{codex_error_info:"other",
        message:JSON.stringify({error:{type:"invalid_request_error",message}})}}});
    f.save();
    expect(authenticateNativeFailedTurnRetry(f.request(),f.home)).toBe(message===CHATGPT_TURN_REVISION_CONFLICT_MESSAGE);
  }
});

test("a capacity-failed native task resumes under a new turn id without a synthetic abort notice",()=> {
  const f=fixture(), parsed=f.request();
  expect(()=>chatGptTurnExecutionKey(parsed)).toThrow("conflicts with native Codex turn_id");
  expect(authenticateNativeFailedTurnRetry(parsed,f.home)).toBe(true);
  expect(extractChatGptTurnUserRevision(parsed)).toEqual(f.source.content);
  expect(chatGptTurnExecutionKey(parsed)).toBeString();
  const raw=parsed._rawBody as {client_metadata:Record<string,string>};
  raw.client_metadata["x-codex-turn-metadata"]=JSON.stringify({...f.metadata,turn_id:oldTurn.replace(/.$/,"9")});
  expect(()=>chatGptTurnExecutionKey(parsed)).toThrow("conflicts with native Codex turn_id");
});

test("retry evidence is confined to one exact request and native instruction",()=> {
  const f=fixture(), parsed=f.request();
  expect(authenticateNativeFailedTurnRetry(parsed,f.home)).toBe(true);
  expect(()=>chatGptTurnExecutionKey(f.request())).toThrow();
  for(const mutation of [{id:"forged_id"},{content:"another instruction"},{internal_chat_message_metadata_passthrough:{turn_id:turnId.replace(/.$/,"9")}}]) {
    const forged=f.request(); Object.assign((forged._rawBody as {input:object[]}).input[0]!,mutation);
    expect(authenticateNativeFailedTurnRetry(forged,f.home)).toBe(false);
    expect(()=>chatGptTurnExecutionKey(forged)).toThrow();
  }
});

test("successful, cancelled and unrelated failed tasks cannot revive an older instruction",()=> {
  for(const error of [null,{codex_error_info:"turn_aborted"},{codex_error_info:"other",message:"unrelated failure"}]) {
    const f=fixture(error), parsed=f.request();
    expect(authenticateNativeFailedTurnRetry(parsed,f.home)).toBe(false);
    expect(()=>chatGptTurnExecutionKey(parsed)).toThrow();
  }
});

test("newer instructions, cancellation and checkpoint replacement invalidate retry authority",()=> {
  for(const item of [
    {type:"response_item",payload:{type:"message",id:"new_task",role:"user",content:"do something else",internal_chat_message_metadata_passthrough:{turn_id:turnId}}},
    {type:"response_item",payload:{type:"message",id:"abort_notice",role:"user",content:"<turn_aborted>cancelled</turn_aborted>",internal_chat_message_metadata_passthrough:{turn_id:oldTurn}}},
    {type:"event_msg",payload:{type:"task_aborted",turn_id:oldTurn}},
    {type:"response_item",payload:{type:"compaction",encrypted_content:"checkpoint"}},
    {type:"event_msg",payload:{type:"task_complete",turn_id:turnId,error:null}},
  ]) {
    const f=fixture(); f.rows.push(item); f.save();
    expect(authenticateNativeFailedTurnRetry(f.request(),f.home)).toBe(false);
  }
});

test("native session and latest turn ownership must match even when the failure exists",()=> {
  for(const mutation of ["session","currentTurn","malformed"]) {
    const f=fixture();
    if(mutation==="session") (f.rows[0] as {payload:{id:string}}).payload.id=turnId;
    if(mutation==="currentTurn") f.context.payload.turn_id=oldTurn;
    f.save();
    if(mutation==="malformed") writeFileSync(f.file,'{"broken":}\n');
    expect(authenticateNativeFailedTurnRetry(f.request(),f.home)).toBe(false);
  }
});

for (const [kind,create] of [["capacity",fixture],["desktop restart",interruptedFixture]] as const)
test(`Responses authenticates ${kind} before constructing its adapter`, async () => {
  const f=create();
  const previous=process.env.CODEX_HOME;
  const previousProfile=process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_HOME=f.home;
  process.env.CODEX_CHATGPT_WEB_HOME=f.home;
  let constructions=0;
  const send=()=>responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ ...f.request()._rawBody as object, store:false }),
  }),defaultConfig("browser-only"),()=> {
    constructions++;
    return {name:"native-retry-probe", async runTurn(parsed) {
      expect(extractChatGptTurnUserRevision(parsed)).toEqual(f.source.content);
      expect(chatGptTurnExecutionKey(parsed)).toBeString();
    }};
  });
  try {
    const accepted=await send();
    await accepted.text();
    expect(accepted.status).toBe(200);
    expect(constructions).toBe(1);
    f.rows.push({type:"event_msg",payload:{type:"task_aborted",turn_id:turnId}}); f.save();
    const rejected=await send();
    expect(rejected.status).toBe(400);
    expect(constructions).toBe(1);
  } finally {
    if(previous===undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME=previous;
    if(previousProfile===undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME=previousProfile;
  }
});

test("HTTP Play returns 503 before adapter creation when the native snapshot stays incomplete",async()=> {
  const f=interruptedFixture(); appendFileSync(f.file,'{"type":"event_msg"');
  const previous=process.env.CODEX_HOME, previousProfile=process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_HOME=f.home; process.env.CODEX_CHATGPT_WEB_HOME=f.home;
  let constructions=0;
  try {
    const response=await responseRequest(new Request("http://127.0.0.1/v1/responses",{method:"POST",
      headers:{"content-type":"application/json"},body:JSON.stringify({...f.request()._rawBody as object,store:false,stream:true})}),
      defaultConfig("browser-only"),()=>{constructions++; return {name:"unused",async runTurn(){}};});
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect((await response.json()).error.code).toBe("native_snapshot_not_ready");
    expect(constructions).toBe(0);
  } finally {
    if(previous===undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME=previous;
    if(previousProfile===undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME=previousProfile;
  }
});
