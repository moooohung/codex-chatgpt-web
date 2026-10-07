import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { ChatGptBrowserWorker, ChatGptBrowserObservationTimeoutError, ChatGptCompletionTracker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptExternalTurnProgress, ChatGptMirroredTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { captureChatGptToolBoundary, logChatGptToolBoundary, setChatGptToolBoundaryTrace, waitForChatGptToolBoundaryAck } from "../src/adapters/chatgpt-web/tool-boundary";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("reconcile after accepted MCP captures and ACKs before the daemon can emit, including an empty boundary", async () => {
  for (const visibleText of ["pre-tool answer", ""]) {
    const worker: any = Object.create(ChatGptBrowserWorker.prototype);
    const progress = new ChatGptExternalTurnProgress();
    const tracker = new ChatGptCompletionTracker();
    const events: string[] = [];
    const capture = deferred<void>();
    let emitted = false, revision = 0, sends = 0;
    let emission!: Promise<void>;
    const hidden: any = { filter: () => hidden, last: () => hidden, getByText: () => hidden,
      isVisible: async () => false, count: async () => 0 };
    let auditIdentity: string | undefined;
    const page = Object.assign(new EventEmitter(), {
      isClosed: () => false, locator: () => hidden,
      evaluate: async (_fn: unknown, identity?: string) => {
        if (identity) auditIdentity = identity;
        return { identity: auditIdentity, document: 1, url: "fixture", keydowns: 0, submits: 0 };
      },
    });
    const send = { waitFor: async () => {}, isEnabled: async () => true, press: async () => { sends++; } };
    worker.activeComposer = async () => ({ evaluate: async () => "draft", locator: () => ({ locator: () => send }) });
    worker.currentSubmissionEvidence = async () => undefined;
    worker.waitForSubmissionAcceptedWithRecovery = async () => {
      revision = progress.recordToolBatch(1);
      emission = waitForChatGptToolBoundaryAck({ traceId: "146b3b30d06b", revision,
        timeoutMs: 1000, wait: signal => progress.waitForToolBatchObservation(revision, signal) })
        .then(() => { events.push("emission"); emitted = true; });
      // Actual Send recovery now takes its reconcile branch while the ordinary DOM probe failed.
      throw new ChatGptBrowserObservationTimeoutError(5000);
    };
    worker.submissionDomState = async () => {
      if (revision === 0) return { turnIdentities: [], visibleStopButtonCount: 0, responseIdentities: [] };
      events.push("capture"); await capture.promise;
      return { responseIdentities: visibleText ? ["new-assistant"] : [] };
    };
    worker.responseDomSnapshot = async () => ({ visibleText });
    const observing = spyOn(tracker, "observeToolBatch");
    const result = worker.sendAttachedPrompt(page, { submittedText: "draft", initialTurnIdentities: [], domCache: {} },
      undefined, undefined, progress, { traceId: "146b3b30d06b", onSendActivated() {}, onSubmitted() {} }, tracker);
    while (!events.includes("capture")) await Bun.sleep(1);
    expect(emitted).toBe(false);
    expect(observing).not.toHaveBeenCalled();
    capture.resolve();
    expect(await result).toBe("mcp_tool_call");
    await emission;
    expect(observing).toHaveBeenCalledWith(revision, visibleText);
    expect(events).toEqual(["capture", "emission"]);
    expect(sends).toBe(1);
    observing.mockRestore();
  }
});

test("normal observer and reconcile join one revision through a pending ACK", async () => {
  const tracker = new ChatGptCompletionTracker(), ack = deferred<void>();
  let captures = 0, acks = 0;
  const options = { tracker, revision: 1, timeoutMs: 200,
    capture: async () => { captures++; return "same boundary"; },
    acknowledge: async () => { acks++; await ack.promise; } };
  const first = captureChatGptToolBoundary(options);
  await Bun.sleep(1);
  const second = captureChatGptToolBoundary(options);
  expect(second).toBe(first);
  expect(captures).toBe(1); expect(acks).toBe(1);
  ack.resolve(); await Promise.all([first, second]);
});

test("unresponsive projection fails with a boundary code and cannot observe or ACK after its budget", async () => {
  const tracker = new ChatGptCompletionTracker(), projection = deferred<string>();
  let acks = 0;
  const observe = spyOn(tracker, "observeToolBatch");
  const options = { tracker, revision: 1, timeoutMs: 10,
    capture: async () => projection.promise, acknowledge: async () => { acks++; } };
  await expect(captureChatGptToolBoundary(options)).rejects.toMatchObject({ code: "chatgpt_tool_boundary_observation_timeout", retryable: false });
  projection.resolve("late answer"); await Bun.sleep(1);
  expect(observe).not.toHaveBeenCalled(); expect(acks).toBe(0);
  await expect(captureChatGptToolBoundary(options)).rejects.toMatchObject({ code: "chatgpt_tool_boundary_observation_timeout" });
  observe.mockRestore();
});

test("parent cancellation fences late capture without an ACK", async () => {
  const tracker = new ChatGptCompletionTracker(), projection = deferred<string>(), controller = new AbortController();
  let acks = 0;
  const result = captureChatGptToolBoundary({ tracker, revision: 1, timeoutMs: 200, signal: controller.signal,
    capture: async () => projection.promise, acknowledge: async () => { acks++; } });
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  projection.resolve("late"); await Bun.sleep(1);
  expect(tracker.needsToolBatchObservation(1)).toBe(true); expect(acks).toBe(0);
});

test("capture failure and ACK failure are classified separately", async () => {
  for (const phase of ["capture", "ack"]) {
    const tracker = new ChatGptCompletionTracker();
    await expect(captureChatGptToolBoundary({ tracker, revision: 1, timeoutMs: 100,
      capture: async () => { if (phase === "capture") throw new Error("fixture"); return "boundary"; },
      acknowledge: async () => { throw new Error("fixture"); },
    })).rejects.toMatchObject({ code: phase === "capture" ? "chatgpt_tool_boundary_observation_failed" : "chatgpt_tool_boundary_ack_failed" });
  }
});

test("lost ACK is bounded, cancels its waiter, and retirement rejects late ACK without emission", async () => {
  const progress = new ChatGptExternalTurnProgress(), revision = progress.recordToolBatch(1);
  let emitted = false, owned!: AbortSignal;
  const result = waitForChatGptToolBoundaryAck({ traceId: "146b3b30d06b", revision, timeoutMs: 10,
    wait: signal => { owned = signal; return progress.waitForToolBatchObservation(revision, signal); } })
    .then(() => { emitted = true; });
  await expect(result).rejects.toMatchObject({ code: "chatgpt_tool_boundary_ack_timeout" });
  expect(owned.aborted).toBe(true);
  progress.retire(new Error("fixture retired"));
  await expect(progress.acknowledgeToolBatch(revision)).rejects.toThrow("fixture retired");
  expect(emitted).toBe(false);
});

test("actual helper ACK receive accepts exact revision and rejects corrupt or retired batches", async () => {
  for (const kind of ["valid", "invalid", "retired"]) {
    const client: any = Object.create(LauncherBrowserHelperClient.prototype);
    const progress = new ChatGptExternalTurnProgress(), revision = progress.recordToolBatch(1);
    if (kind === "retired") progress.retire(new Error("fixture retired"));
    const failures: Error[] = [];
    client.pending = new Map([["146b3b30d06b", { turn: { traceId: "146b3b30d06b", externalProgress: progress } }]]);
    client.abortWithLocalFailure = (_id: string, error: Error) => { failures.push(error); };
    client.child = {};
    const mirror = new ChatGptMirroredTurnProgress(rev => client.handleLine(client.child, JSON.stringify({ type: "event", id: "146b3b30d06b", event: "tool_batch_observed", revision: kind === "invalid" ? rev + 1 : rev })));
    mirror.apply(progress.snapshot());
    await mirror.acknowledgeToolBatch(revision);
    await Bun.sleep(1);
    if (kind === "valid") {
      expect(failures).toEqual([]); await progress.waitForToolBatchObservation(revision);
    } else expect(failures[0]).toMatchObject({ code: "chatgpt_tool_boundary_ack_rejected" });
  }
});

test("boundary diagnostics use only short trace IDs, revision and lengths", async () => {
  const output = spyOn(console, "info").mockImplementation(() => {});
  try {
    const tracker = new ChatGptCompletionTracker();
    setChatGptToolBoundaryTrace(tracker, "146b3b30d06babcdef");
    await captureChatGptToolBoundary({ tracker, revision: 1, timeoutMs: 100,
      capture: async () => "private prompt or tool arguments", acknowledge: async () => {} });
    logChatGptToolBoundary("ack_received", "secret-capability-token", 1);
    const text = output.mock.calls.flat().join("\n");
    expect(text).toContain('"traceId":"146b3b30d06b"');
    expect(text).toContain('"revision":1');
    expect(text).not.toContain("private prompt");
    expect(text).not.toContain("abcdef");
    expect(text).not.toContain("secret-capability-token");
  } finally { output.mockRestore(); }
});

test("pending MCP boundary is ACKed before a blocked assistant alert probe, which remains cancellable", async () => {
  const worker: any = Object.create(ChatGptBrowserWorker.prototype);
  const progress = new ChatGptExternalTurnProgress(), tracker = new ChatGptCompletionTracker(), controller = new AbortController();
  const revision = progress.recordToolBatch(1);
  const hidden: any = { filter: () => hidden, last: () => hidden, isVisible: () => new Promise(() => {}) };
  const page = { isClosed: () => false, locator: () => hidden };
  worker.submissionDomState = async () => ({ responseIdentities: [] });
  const observed = worker.waitForNewAssistantTurn(page, { initialTurnIdentities: [], domCache: {} }, undefined,
    controller.signal, progress, 60000, tracker);
  await progress.waitForToolBatchObservation(revision);
  expect(tracker.needsToolBatchObservation(revision)).toBe(false);
  controller.abort();
  await expect(observed).rejects.toMatchObject({ name: "AbortError" });
});

test("bound response projection exits when its parent turn is cancelled", async () => {
  const worker: any = Object.create(ChatGptBrowserWorker.prototype), controller = new AbortController();
  worker.responseDomSnapshot = () => new Promise(() => {});
  const observed = worker.boundedResponseDomSnapshot({}, {}, {}, controller.signal);
  controller.abort();
  await expect(observed).rejects.toMatchObject({ name: "AbortError" });
});
