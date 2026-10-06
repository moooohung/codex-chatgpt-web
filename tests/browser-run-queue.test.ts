import {expect,test} from "bun:test";
import {ChatGptBrowserRunQueue,MAX_CHATGPT_BROWSER_TABS,resolveMaxChatGptBrowserTabs} from "../src/adapters/chatgpt-web/concurrency";
import {ChatGptBrowserWorker,type BrowserTurn} from "../src/adapters/chatgpt-web/browser-worker";
import {ChatGptTurnSessions,ChatGptTraceFeed,ChatGptTextFeed} from "../src/adapters/chatgpt-web/turn-execution";

test("browser admission stays bounded and FIFO across successful and failed physical runs",async()=> {
  const queue=new ChatGptBrowserRunQueue<number>(2), starts:number[]=[], finish=new Map<number,(fail?:boolean)=>void>();
  const runs=Array.from({length:5},(_,id)=>queue.run(()=>new Promise<number>((resolve,reject)=> {
    starts.push(id); finish.set(id,fail=>fail?reject(new Error("physical failure")):resolve(id));
  })));
  const failed=runs[1]!.then(()=>null,error=>error);
  await Promise.resolve(); expect(starts).toEqual([0,1]);
  finish.get(1)!(true); expect((await failed).message).toBe("physical failure"); await Promise.resolve(); expect(starts).toEqual([0,1,2]);
  finish.get(0)!(); await runs[0]; await Promise.resolve(); expect(starts).toEqual([0,1,2,3]);
  finish.get(2)!(); await runs[2]; await Promise.resolve(); expect(starts).toEqual([0,1,2,3,4]);
  finish.get(3)!();finish.get(4)!(); await Promise.all([runs[3],runs[4]]);
});

test("browser admission defaults to four slots and accepts only bounded overrides",()=> {
  expect(resolveMaxChatGptBrowserTabs(undefined)).toBe(4);
  expect(resolveMaxChatGptBrowserTabs("1")).toBe(1);
  expect(resolveMaxChatGptBrowserTabs("8")).toBe(8);
  expect(resolveMaxChatGptBrowserTabs("9")).toBe(4);
  expect(resolveMaxChatGptBrowserTabs("nope")).toBe(4);
});

test("a fifth registered request queues before browser preparation and starts after physical settlement",async()=> {
  const sessions=new ChatGptTurnSessions(), starts:string[]=[], releases=new Map<string,()=>void>();
  const worker=Object.assign(Object.create(ChatGptBrowserWorker.prototype),{
    config:{browserHost:"managed-chrome"},activeRuns:new Map(),
    runExclusive:(turn:BrowserTurn)=>new Promise<string>(resolve=>{
      starts.push(turn.traceId);releases.set(turn.traceId,()=>resolve(turn.traceId));
    }),
  }) as ChatGptBrowserWorker;
  const runs=Array.from({length:5},(_,index)=>sessions.getOrCreate(`request_${index}`,()=>{
    const browser=worker.run({traceId:`request_${index}`,modelId:"chatgpt-web/high",
      capabilities:{localToolsEnabled:false,solAvailable:true,extraHighAvailable:true,proAvailable:true},
      prepare:async()=>({text:"queued",images:[],release(){}}),onTextDelta(){}});
    return {mode:"read-only" as const,browser,physicalSettlement:browser.then(()=>{}),
      trace:new ChatGptTraceFeed(),text:new ChatGptTextFeed(),cancel(){}};
  }));
  await Promise.resolve();
  expect(sessions.activeCount()).toBe(5);
  expect(starts).toEqual(["request_0","request_1","request_2","request_3"]);
  releases.get("request_0")!();await runs[0]!.runtime.browser;await Promise.resolve();
  expect(starts).toEqual(["request_0","request_1","request_2","request_3","request_4"]);
  for(const id of starts.slice(1))releases.get(id)!();
  await Promise.all(runs.map(session=>session.runtime.browser));sessions.clear();
});

test("cancelled queued requests never prepare or start when a permit later becomes free",async()=> {
  const queue=new ChatGptBrowserRunQueue<string>(1), controller=new AbortController();
  let release!:()=>void, starts=0;
  const first=queue.run(()=>new Promise<string>(resolve=> {release=()=>resolve("first");}));
  const queued=queue.run(async()=>{starts++;return "cancelled";},controller.signal);
  const rejected=queued.then(()=>null,error=>error);
  controller.abort(new Error("queued cancellation"));expect((await rejected).message).toBe("queued cancellation");
  await Promise.resolve();release();await first;
  expect(await queue.run(async()=>"last")).toBe("last");expect(starts).toBe(0);
  await expect(queue.run(async()=>{starts++;return "never";},controller.signal)).rejects.toThrow("queued cancellation");
  expect(starts).toBe(0);
});

test("closing rejects queued requests before a physical completion can admit them",async()=> {
  const queue=new ChatGptBrowserRunQueue<string>(1);let release!:()=>void, starts=0;
  const first=queue.run(()=>new Promise<string>(resolve=>{release=()=>resolve("first");}));
  const pending=queue.run(async()=>{starts++;return "never";});
  const rejected=pending.then(()=>null,error=>error);queue.cancelPending();expect((await rejected).message).toContain("closing");
  await Promise.resolve();release();await first;
  await expect(queue.run(async()=>"never")).rejects.toThrow("closing");expect(starts).toBe(0);
});

test("a waiting request keeps its owner alive and stops heartbeat after cancellation",async()=> {
  const queue=new ChatGptBrowserRunQueue<string>(1), controller=new AbortController();
  let release!:()=>void,pulses=0;
  const first=queue.run(()=>new Promise<string>(resolve=>{release=()=>resolve("first");}));
  const pending=queue.run(async()=>"never",controller.signal,()=>{pulses++;});
  const rejected=pending.then(()=>null,error=>error);
  await Bun.sleep(1_080);expect(pulses).toBe(1);
  controller.abort(new Error("cancel heartbeat"));expect((await rejected).message).toBe("cancel heartbeat");
  await Bun.sleep(1_080);expect(pulses).toBe(1);release();await first;
});

test("worker shutdown rejects its queue and a later reopened worker can run again",async()=> {
  const releases:(()=>void)[]=[],starts:string[]=[];
  const worker=Object.assign(Object.create(ChatGptBrowserWorker.prototype),{
    config:{browserHost:"managed-chrome"},activeRuns:new Map(),maintenanceTail:Promise.resolve(),
    runExclusive:(turn:BrowserTurn)=>new Promise<string>(resolve=>{
      starts.push(turn.traceId);releases.push(()=>resolve(turn.traceId));
    }),
  }) as ChatGptBrowserWorker;
  const turn=(traceId:string)=>({traceId,modelId:"chatgpt-web/high",capabilities:{localToolsEnabled:false,solAvailable:true,extraHighAvailable:true,proAvailable:true},prepare:async()=>({text:traceId,images:[],release(){}}),onTextDelta(){}});
  const active=Array.from({length:MAX_CHATGPT_BROWSER_TABS},(_,i)=>worker.run(turn(`active_${i}`)));
  const pending=worker.run(turn("pending")).then(()=>null,error=>error);
  await Promise.resolve();
  const closing=worker.close();expect((await pending).message).toContain("closing");
  for(const release of releases)release();await Promise.all(active);await closing;
  expect(starts).not.toContain("pending");
  const reopened=worker.run(turn("reopened"));await Promise.resolve();releases.at(-1)!();expect(await reopened).toBe("reopened");
});
