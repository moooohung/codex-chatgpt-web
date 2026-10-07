import { expect, test, spyOn } from "bun:test";
import { ChatGptBrowserWorker, ChatGptCompletionTracker, throwIfChatGptTerminalErrorAlert } from "../src/adapters/chatgpt-web/browser-worker";
import { logChatGptBrowserObservation, setChatGptToolBoundaryTrace } from "../src/adapters/chatgpt-web/tool-boundary";

test("observation diagnostics name the timed-out probe without content or capability tokens", async () => {
  const output=spyOn(console,"info").mockImplementation(()=>{});
  try {
    const worker:any=Object.create(ChatGptBrowserWorker.prototype),tracker=new ChatGptCompletionTracker();
    setChatGptToolBoundaryTrace(tracker,"2bb429a19c75abcdef");
    await expect(worker.observeResponseProbe({}, {}, undefined, undefined, tracker,
      () => new Promise(()=>{}), 10, "terminal_error")).rejects.toMatchObject({name:"ChatGptBrowserObservationTimeoutError"});
    const text=output.mock.calls.flat().join("\n");
    expect(text).toContain('"traceId":"2bb429a19c75"');
    expect(text).toContain('"probe":"terminal_error"');
    expect(text).toContain('"errorCode":"browser_observation_timeout"');
    expect(text).not.toContain("abcdef");
    expect(text).not.toContain("prompt");
  } finally {output.mockRestore();}
});

test("fast successful probes stay quiet; slow probes report only timing and operation", () => {
  const output=spyOn(console,"info").mockImplementation(()=>{});
  try{
    const tracker=new ChatGptCompletionTracker();setChatGptToolBoundaryTrace(tracker,"secret-capability-token");
    logChatGptBrowserObservation(tracker,"response_projection",{elapsedMs:4,timeoutMs:20_000,failed:false});
    expect(output).not.toHaveBeenCalled();
    logChatGptBrowserObservation(tracker,"response_projection",{elapsedMs:1_100,timeoutMs:20_000,failed:false});
    const text=output.mock.calls.flat().join("\n");
    expect(text).toContain('"traceId":"untracked"');expect(text).toContain('"elapsedMs":1100');
    expect(text).not.toContain("secret-capability-token");
  }finally{output.mockRestore();}
});

test("cancellation identifies the blocked boundary substep and still fences late ACK", async () => {
  const output=spyOn(console,"info").mockImplementation(()=>{});
  try{
    const worker:any=Object.create(ChatGptBrowserWorker.prototype),tracker=new ChatGptCompletionTracker();
    const controller=new AbortController();let finish!:()=>void,acks=0;
    worker.submissionDomState=()=>new Promise(resolve=>{finish=()=>resolve({responseIdentities:[]})});
    const progress={snapshot:()=>({lastToolBatchRevision:1}),acknowledgeToolBatch:async()=>{acks++}};
    const pending=worker.observeSubmissionToolBoundary({}, {initialTurnIdentities:[],domCache:{}}, controller.signal, progress, tracker);
    await Bun.sleep(1);controller.abort(new Error("fixture cancellation"));
    await expect(pending).rejects.toThrow("fixture cancellation");finish();await Bun.sleep(1);
    expect(acks).toBe(0);expect(tracker.needsToolBatchObservation(1)).toBe(true);
    expect(output.mock.calls.flat().join("\n")).toContain('"probe":"boundary_turn_state"');
  }finally{output.mockRestore();}
});

test("a failed terminal UI projection remains an observation failure", async () => {
  const failure=new Error("fixture projection unavailable"),hidden={last(){return this},isVisible:async()=>false};
  const scope={getByTestId:()=>hidden,locator:()=>({evaluateAll:()=>Promise.reject(failure)})};
  await expect(throwIfChatGptTerminalErrorAlert(scope as never)).rejects.toBe(failure);
});

test("a bound assistant projection failure cannot become an empty boundary ACK", async()=>{
  const worker:any=Object.create(ChatGptBrowserWorker.prototype),tracker=new ChatGptCompletionTracker();let acks=0;
  worker.submissionDomState=async()=>({responseIdentities:["group:assistant:offline"]});
  worker.responseDomSnapshot=async()=>({responsePresent:false,visibleText:"",stoppedThinkingVisible:false});
  const progress={snapshot:()=>({lastToolBatchRevision:1}),acknowledgeToolBatch:async()=>{acks++}};
  await expect(worker.observeSubmissionToolBoundary({locator:()=>({})},{initialTurnIdentities:[],domCache:{}},undefined,progress,tracker))
    .rejects.toMatchObject({code:"chatgpt_tool_boundary_observation_failed",retryable:false});
  expect(acks).toBe(0);expect(tracker.needsToolBatchObservation(1)).toBe(true);
});
