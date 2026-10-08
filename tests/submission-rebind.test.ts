import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { ChatGptBrowserWorker, ChatGptCompletionTracker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { chatGptToolBoundaryError } from "../src/adapters/chatgpt-web/tool-boundary";

function fixture() {
  const hidden = { filter() { return this; }, last() { return this; }, isVisible: async () => false,
    count: async () => 0, evaluateAll: async () => undefined };
  let closed = false, presses = 0, auditReads = 0;
  let audit: any;
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => closed, locator: () => hidden,
    evaluate: async (_fn: unknown, id?: string) => {
      if (closed) throw new Error("original CDP page closed");
      if (id) return audit = { identity: id, document: 1, url: "https://chatgpt.com/", keydowns: 0, submits: 0 };
      auditReads++; return audit;
    },
  });
  const rebound = { isClosed: () => false, locator: () => hidden };
  const send = { waitFor: async () => {}, isEnabled: async () => true, press: async () => { presses++; } };
  const composer = { evaluate: async () => "original draft", locator: () => ({ locator: () => send }) };
  const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async () => composer,
    currentSubmissionEvidence: async (observedPage: unknown) => {
      if (observedPage === page && closed) throw new Error("original CDP page closed");
      return observedPage === rebound ? "user_turn" : undefined;
    },
    submissionDomState: async () => ({ turnIdentities: [], responseIdentities: [], visibleStopButtonCount: 0 }),
  });
  const baseline = { submittedText: "original draft", initialTurnIdentities: [], domCache: {} };
  const timeout = Object.assign(new Error("DOM read expired"), { name: "ChatGptBrowserObservationTimeoutError" });
  const recover = async () => { closed = true; return { page: rebound, baseline: { ...baseline, domCache: {} } }; };
  return { worker, page, rebound, baseline, timeout, recover, presses: () => presses, auditReads: () => auditReads };
}

test("send reconciliation uses the rebound page and preserves the original submission receipt", async () => {
  const f = fixture(); let submitted = 0;
  f.worker.waitForSubmissionAcceptedWithRecovery = async (_page: unknown, baseline: unknown, signal: AbortSignal,
    _progress: unknown, _revision: number, _tracker: unknown, recover: any) => {
    expect(baseline).toBe(f.baseline);
    const recovered = await recover(1, f.timeout, baseline, signal);
    expect(recovered.page).toBe(f.rebound); expect(recovered.baseline).toBe(f.baseline);
    throw f.timeout;
  };
  const send = () => f.worker.sendAttachedPrompt(f.page, f.baseline, undefined, undefined, undefined,
    { onSubmitted: () => { submitted++; } }, undefined, f.recover);
  expect(await send()).toBe("user_turn");
  expect(f.presses()).toBe(1); expect(submitted).toBe(1);
});

test("a reconciliation already reading the old transport waits for the same-tab rebind", async () => {
  const f = fixture(); let staleRead!: () => void;
  const reading = new Promise<void>(resolve => { staleRead = resolve; });
  let reads = 0;
  f.worker.currentSubmissionEvidence = async (page: unknown) => {
    if (page === f.rebound) return "user_turn";
    if (++reads === 1) return undefined;
    staleRead(); await Bun.sleep(20); throw new Error("original CDP page closed");
  };
  f.worker.waitForSubmissionAcceptedWithRecovery = async (_page: unknown, baseline: unknown, signal: AbortSignal,
    _progress: unknown, _revision: number, _tracker: unknown, recover: any) => {
    await reading; await recover(1, f.timeout, baseline, signal); throw f.timeout;
  };
  expect(await f.worker.sendAttachedPrompt(f.page, f.baseline, undefined, undefined, undefined, undefined, undefined, f.recover)).toBe("user_turn");
  expect(f.presses()).toBe(1);
}, 6_000);

test("MCP acceptance after reconnect still captures, observes and ACKs the new page", async () => {
  const f = fixture(), progress = new ChatGptExternalTurnProgress(), tracker = new ChatGptCompletionTracker();
  const order: string[] = [];
  f.worker.waitForSubmissionAcceptedWithRecovery = async (_page: unknown, baseline: unknown, signal: AbortSignal,
    _progress: unknown, _revision: number, _tracker: unknown, recover: any) => {
    await recover(1, f.timeout, baseline, signal); progress.recordToolBatch(1); throw f.timeout;
  };
  f.worker.submissionDomState = async (page: unknown) => {
    if (progress.snapshot().lastToolBatchRevision) { expect(page).toBe(f.rebound); order.push("capture"); }
    return { turnIdentities: [], responseIdentities: [], visibleStopButtonCount: 0 };
  };
  const observe = tracker.observeToolBatch.bind(tracker);
  tracker.observeToolBatch = (revision, text) => { order.push("observe"); return observe(revision, text); };
  const ack = progress.acknowledgeToolBatch.bind(progress);
  progress.acknowledgeToolBatch = async revision => { order.push("ack"); return ack(revision); };
  expect(await f.worker.sendAttachedPrompt(f.page, f.baseline, undefined, undefined, progress, undefined, tracker, f.recover)).toBe("mcp_tool_call");
  await progress.waitForToolBatchObservation(1);
  expect(order).toEqual(["capture", "observe", "ack"]); expect(f.presses()).toBe(1);
});

test("an unchanged rebound page cannot authorize a second Send with the old input audit", async () => {
  const f = fixture(); f.worker.currentSubmissionEvidence = async () => undefined;
  f.worker.waitForSubmissionAcceptedWithRecovery = async (_page: unknown, baseline: unknown, signal: AbortSignal,
    _progress: unknown, _revision: number, _tracker: unknown, recover: any) => {
    await recover(1, f.timeout, baseline, signal); throw f.timeout;
  };
  await expect(f.worker.sendAttachedPrompt(f.page, f.baseline, undefined, undefined,
    undefined, undefined, undefined, f.recover)).rejects.toMatchObject({ code: "chatgpt_submission_recovery_exhausted" });
  expect(f.presses()).toBe(1); expect(f.auditReads()).toBe(1);
});

test("a boundary failure during reconnect retains its error and cannot ACK or resend", async () => {
  const f = fixture(), progress = new ChatGptExternalTurnProgress(), tracker = new ChatGptCompletionTracker();
  const failure = chatGptToolBoundaryError("chatgpt_tool_boundary_observation_failed"); let acks = 0;
  progress.acknowledgeToolBatch = async () => { acks++; };
  f.worker.observeSubmissionToolBoundary = async () => { throw failure; };
  f.worker.waitForSubmissionAcceptedWithRecovery = async (_page: unknown, baseline: unknown, signal: AbortSignal,
    _progress: unknown, _revision: number, _tracker: unknown, recover: any) => {
    await recover(1, f.timeout, baseline, signal); progress.recordToolBatch(1); throw f.timeout;
  };
  await expect(f.worker.sendAttachedPrompt(f.page, f.baseline, undefined, undefined, progress, undefined, tracker, f.recover)).rejects.toBe(failure);
  expect(acks).toBe(0); expect(f.presses()).toBe(1);
});

test("user cancellation fences a pending rebind and cannot publish late acceptance", async () => {
  const f = fixture(), controller = new AbortController(), cache = f.baseline.domCache;
  let entered!: () => void, release!: () => void, submitted = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  f.worker.waitForSubmissionAcceptedWithRecovery = async (_page: unknown, baseline: unknown, signal: AbortSignal,
    _progress: unknown, _revision: number, _tracker: unknown, recover: any) => {
    await recover(1, f.timeout, baseline, signal); return "user_turn";
  };
  const result = f.worker.sendAttachedPrompt(f.page, f.baseline, undefined, controller.signal, undefined,
    { onSubmitted: () => { submitted++; } }, undefined,
    async () => { entered(); await waiting; return f.recover(); });
  await started;
  const reason = new Error("user stopped this turn"); controller.abort(reason);
  await expect(result).rejects.toBe(reason);
  release(); await Bun.sleep(0);
  expect(f.baseline.domCache).toBe(cache); expect(submitted).toBe(0); expect(f.presses()).toBe(1);
});
