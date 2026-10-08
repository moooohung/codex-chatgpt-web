import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { ChatGptBrowserWorker, ChatGptCompletionTracker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";

function fixture(press: (key: string, options: any) => Promise<void>) {
  const hidden = { filter() { return this; }, last() { return this; }, isVisible: async () => false,
    evaluateAll: async () => undefined };
  const page = { isClosed: () => false, locator: () => hidden } as unknown as Page;
  const send = { waitFor: async () => {}, isEnabled: async () => true, press };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async () => ({ locator: () => ({ locator: () => send }) }),
  }) as any;
  return { worker, page };
}

test("semantic acceptance is observed while the Enter acknowledgement is stalled, without a second activation", async () => {
  let release!: () => void;
  let presses = 0;
  const { worker, page } = fixture(async () => {
    presses++;
    await new Promise<void>(resolve => { release = resolve; });
  });
  worker.waitForSubmissionAcceptedWithRecovery = async () => "user_turn";
  const phases: string[] = [];
  try {
    await expect(worker.runStage("stalled_enter", "send", 600, (signal: AbortSignal) =>
      worker.sendAttachedPrompt(page, {}, undefined, signal, undefined, {
        onSendActivated: () => { phases.push("activated"); },
        onSubmitted: () => { phases.push("accepted"); },
      }),
    )).resolves.toBe("user_turn");
    expect(presses).toBe(1);
    expect(phases).toEqual(["activated", "accepted"]);
  } finally { release?.(); }
});

test("a current MCP batch confirms a stalled Enter after capturing and ACKing an empty assistant boundary", async () => {
  const progress = new ChatGptExternalTurnProgress();
  let release!: () => void;
  let presses = 0;
  const { worker, page } = fixture(async () => {
    presses++;
    progress.recordToolBatch(1);
    await new Promise<void>(resolve => { release = resolve; });
  });
  worker.currentSubmissionEvidence = async () => { throw new Error("renderer DOM unavailable"); };
  worker.submissionDomState = async () => ({ responseIdentities: [] });
  const tracker = new ChatGptCompletionTracker();
  try {
    await expect(worker.runStage("mcp_during_enter", "send", 600, (signal: AbortSignal) =>
      worker.sendAttachedPrompt(page, { initialTurnIdentities: [], domCache: {} }, undefined, signal, progress, undefined, tracker),
    )).resolves.toBe("mcp_tool_call");
    expect(presses).toBe(1);
    expect(tracker.needsToolBatchObservation(1)).toBeFalse();
    await progress.waitForToolBatchObservation(1);
  } finally { release?.(); }
});

test("Enter completion alone never confirms a prompt and abort cancels semantic observation", async () => {
  let presses = 0;
  let accepted = 0;
  let observationSignal: AbortSignal | undefined;
  const { worker, page } = fixture(async () => { presses++; });
  worker.waitForSubmissionAcceptedWithRecovery = async (_page: Page, _baseline: unknown, signal: AbortSignal) => {
    observationSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () =>
      reject(new DOMException("observation cancelled", "AbortError")), { once: true }));
  };
  await expect(worker.runStage("no_acceptance", "send", 600, (signal: AbortSignal) =>
    worker.sendAttachedPrompt(page, {}, undefined, signal, undefined, {
      onSubmitted: () => { accepted++; },
    }),
  )).rejects.toThrow("timed out: send");
  expect(presses).toBe(1);
  expect(accepted).toBe(0);
  expect(observationSignal?.aborted).toBe(true);
});

test("failed activation preserves the error and never retries an ambiguous send", async () => {
  let presses = 0;
  let accepted = 0;
  const failure = new Error("keyboard transport disconnected");
  const { worker, page } = fixture(async () => { presses++; throw failure; });
  worker.waitForSubmissionAcceptedWithRecovery = async (_page: Page, _baseline: unknown, signal: AbortSignal) =>
    new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  await expect(worker.sendAttachedPrompt(page, {}, undefined, undefined, undefined, {
    onSubmitted: () => { accepted++; },
  })).rejects.toBe(failure);
  expect(presses).toBe(1);
  expect(accepted).toBe(0);
});
