import { expect, test } from "bun:test";
import {
  chatGptObservationBudgetForSize,
  chatGptPageObservationTimeoutMs,
  chatGptPageBoundaryTimeoutMs,
  inheritChatGptPageObservationBudget,
  recordChatGptPageObservationSize,
} from "../src/adapters/chatgpt-web/page-observation-budget";
import { ChatGptBrowserWorker, withChatGptBrowserObservationTimeout } from "../src/adapters/chatgpt-web/browser-worker";
import { recoverChatGptSubmission } from "../src/adapters/chatgpt-web/submission-recovery";
import { CHATGPT_TOOL_BOUNDARY_ACK_TIMEOUT_MS } from "../src/adapters/chatgpt-web/tool-boundary";
import { ChatGptCompletionTracker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";

test("large tool captures have bounded headroom without changing normal probes or the MCP deadline", () => {
  const large = {}, small = {};
  recordChatGptPageObservationSize(large, 1_200_000);
  expect(chatGptPageObservationTimeoutMs(large)).toBe(20_000);
  expect(chatGptPageBoundaryTimeoutMs(large)).toBe(60_000);
  expect(chatGptPageBoundaryTimeoutMs(small)).toBe(5_000);
  expect(CHATGPT_TOOL_BOUNDARY_ACK_TIMEOUT_MS).toBeGreaterThan(chatGptPageBoundaryTimeoutMs(large));
  expect(CHATGPT_TOOL_BOUNDARY_ACK_TIMEOUT_MS).toBeLessThanOrEqual(75_000);
});

test("actual large-page boundary tolerates a 21s DOM read and captures before ACK/emission", async () => {
  const order: string[] = [];
  const page = { evaluate: async () => {
    await Bun.sleep(21_000);
    order.push("capture");
    return { key: "busy-page:1", snapshot: { responseIdentities: [] } };
  } };
  recordChatGptPageObservationSize(page, 1_200_000);
  const worker: any = Object.create(ChatGptBrowserWorker.prototype);
  const tracker = new ChatGptCompletionTracker();
  const observe = tracker.observeToolBatch.bind(tracker);
  tracker.observeToolBatch = (revision, text) => {
    expect(text).toBe(""); order.push("observe"); return observe(revision, text);
  };
  const progress = new ChatGptExternalTurnProgress();
  const revision = progress.recordToolBatch(1);
  const ack = progress.acknowledgeToolBatch.bind(progress);
  progress.acknowledgeToolBatch = async batch => { order.push("ack"); return ack(batch); };
  await worker.observeSubmissionToolBoundary(page, { initialTurnIdentities: [] }, undefined, progress, tracker);
  await progress.waitForToolBatchObservation(revision);
  order.push("emission");
  expect(order).toEqual(["capture", "observe", "ack", "emission"]);
}, 25_000);

test("recorded large-page sizes get bounded observation headroom; ordinary and invalid hints keep 5s", () => {
  for (const chars of [0, 250_000, -1, NaN, Infinity]) expect(chatGptObservationBudgetForSize(chars)).toBe(5_000);
  expect(chatGptObservationBudgetForSize(250_001)).toBe(10_000);
  expect(chatGptObservationBudgetForSize(733_021)).toBe(15_000);
  for (const chars of [789_765, 1_171_581, 1_365_385, Number.MAX_VALUE]) expect(chatGptObservationBudgetForSize(chars)).toBe(20_000);
});

test("page hints stay isolated, survive same-page reconnection, and do not store prompt contents", () => {
  const large = {}, small = {}, rebound = {};
  recordChatGptPageObservationSize(large, 1_365_385);
  recordChatGptPageObservationSize(large, 0);
  recordChatGptPageObservationSize(large, NaN);
  expect(chatGptPageObservationTimeoutMs(large)).toBe(20_000);
  expect(chatGptPageObservationTimeoutMs(small)).toBe(5_000);
  inheritChatGptPageObservationBudget(large, rebound);
  expect(chatGptPageObservationTimeoutMs(rebound)).toBe(20_000);
  expect(Object.keys(large)).toEqual([]);
});

test("the actual submission DOM reader accepts an observation delayed beyond the old 5s budget", async () => {
  const read = (ChatGptBrowserWorker.prototype as unknown as {
    submissionDomState(page: unknown, cache: unknown, signal?: AbortSignal): Promise<unknown>;
  }).submissionDomState;
  const snapshot = { userTurnCount: 1, assistantTurnCount: 0, visibleStopButtonCount: 0,
    turnIdentities: ["new-user"], userIdentities: ["new-user"], responseIdentities: [] };
  let requests = 0;
  const page = { evaluate: async () => { requests++; await Bun.sleep(5_100); return { key: "large-page:1", snapshot }; } };
  recordChatGptPageObservationSize(page, 1_171_581);
  expect(await read.call({}, page, {})).toEqual(snapshot);
  expect(requests).toBe(1);
}, 8_000);

test("a larger observation budget cannot outlive the enclosing stage or user stop", async () => {
  const read = (ChatGptBrowserWorker.prototype as unknown as {
    submissionDomState(page: unknown, cache: unknown, signal?: AbortSignal): Promise<unknown>;
  }).submissionDomState;
  const page = { evaluate: () => new Promise<never>(() => {}) };
  recordChatGptPageObservationSize(page, 1_171_581);
  const controller = new AbortController(), reason = new Error("parent stage ended");
  const result = read.call({}, page, {}, controller.signal);
  controller.abort(reason);
  await expect(result).rejects.toMatchObject({ name: "AbortError", message: "ChatGPT web turn aborted" });
});

test("a DOM timeout remains unknown and cannot authorize another Send", async () => {
  let activations = 0;
  const page = {}, controller = new AbortController();
  recordChatGptPageObservationSize(page, 1_365_385);
  const result = recoverChatGptSubmission({
    key: {}, identity: "large-page-send", signal: controller.signal, checkpointMs: 1,
    activate: async () => { activations++; },
    observe: async () => withChatGptBrowserObservationTimeout(new Promise<never>(() => {}), 2),
    reconcile: async () => ({ state: "ambiguous" as const }),
  });
  await expect(result).rejects.toMatchObject({ name: "ChatGptSubmissionRecoveryExhausted", state: "ambiguous" });
  expect(activations).toBe(0);
});
