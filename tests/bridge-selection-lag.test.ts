import { expect, test } from "bun:test";
import { ChatGptBrowserWorker, ChatGptCompletionTracker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { captureChatGptToolBoundary, observeChatGptToolBoundaryDuring, waitForChatGptToolBoundaryAck } from "../src/adapters/chatgpt-web/tool-boundary";
import { readClosedChatGptEffortLabel, selectChatGptModelFamily } from "../src/adapters/chatgpt-web/model-selection";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("family readback survives a replaced menu and a commit delayed beyond the old one-second window", async () => {
  let selectedAt = Infinity, clicks = 0, activations = 0;
  const makeMenu = (stale: boolean): any => ({ menu: {
    getByRole: () => ({ count: async () => stale ? 0 : 1, getAttribute: async () => Date.now() >= selectedAt ? "true" : "false",
      waitFor: async () => {}, click: async () => { clicks++; selectedAt = Date.now() + 1_150; } }),
    locator: () => ({ count: async () => 1, getAttribute: async () => "advanced" }),
  } });
  const initial = makeMenu(false), stale = makeMenu(true), fresh = makeMenu(false);
  const result = await selectChatGptModelFamily(initial, "5.6", async () => ++activations === 1 ? stale : fresh, 2_000);
  expect(result).toBe(fresh);
  expect(clicks).toBe(1);
  expect(activations).toBeGreaterThan(1);
});

test("a blocked model DOM read is transient and cannot click after its budget expires", async () => {
  const count = deferred<number>();
  let clicks = 0;
  const menu: any = { menu: { getByRole: () => ({ count: () => count.promise, click: async () => { clicks++; } }) } };
  await expect(selectChatGptModelFamily(menu, "5.6", async () => menu, 15))
    .rejects.toMatchObject({ code: "chatgpt_model_selection_timeout", retryable: true });
  count.resolve(1); await Bun.sleep(1);
  expect(clicks).toBe(0);
});

test("ambiguous family controls remain a terminal rejection", async () => {
  let clicks = 0;
  const menu: any = { menu: { getByRole: () => ({ count: async () => 2, click: async () => { clicks++; } }) } };
  await expect(selectChatGptModelFamily(menu, "5.6", async () => menu, 100))
    .rejects.toMatchObject({ code: "chatgpt_model_family_selection_failed", retryable: false });
  expect(clicks).toBe(0);
});

test("a closing menu's transient trigger label cannot become effort selection proof", async () => {
  const readyAt = Date.now() + 90;
  const control: any = { getAttribute: async () => Date.now() >= readyAt ? "false" : "true",
    innerText: async () => Date.now() >= readyAt ? "Extra High" : "Thinking effort" };
  expect(await readClosedChatGptEffortLabel(control, "5.6", 300)).toBe("Extra High");
});

test("a follow-up batch arriving inside a blocked response probe captures and ACKs before emission", async () => {
  const worker: any = Object.create(ChatGptBrowserWorker.prototype);
  const progress = new ChatGptExternalTurnProgress(), tracker = new ChatGptCompletionTracker();
  const probe = deferred<string>(), capture = deferred<void>();
  const events: string[] = [];
  let started = false, probeFinished = false;
  worker.submissionDomState = async () => {
    events.push("capture"); await capture.promise;
    return { responseIdentities: ["assistant"] };
  };
  worker.responseDomSnapshot = async () => ({ visibleText: "pre-dispatch answer", stoppedThinkingVisible: false });
  const result = worker.observeResponseProbe({ locator: () => ({}) }, { initialTurnIdentities: [], domCache: {} },
    undefined, progress, tracker, async () => { started = true; const value = await probe.promise; probeFinished = true; return value; }, 1_000);
  while (!started) await Bun.sleep(1);
  const revision = progress.recordToolBatch(1);
  const emitting = waitForChatGptToolBoundaryAck({ traceId: "c189656d23a1", revision,
    wait: signal => progress.waitForToolBatchObservation(revision, signal), timeoutMs: 500 }).then(() => events.push("emission"));
  while (!events.includes("capture")) await Bun.sleep(1);
  expect(events).toEqual(["capture"]);
  capture.resolve(); await emitting;
  expect(events).toEqual(["capture", "emission"]);
  expect(probeFinished).toBe(false);
  expect(tracker.needsToolBatchObservation(revision)).toBe(false);
  probe.resolve("UI recovered"); expect(await result).toBe("UI recovered");
});

test("a concurrent boundary timeout cancels the UI scope and fences a late projection without releasing tools", async () => {
  const progress = new ChatGptExternalTurnProgress(), tracker = new ChatGptCompletionTracker(), projection = deferred<string>();
  let started = false, acks = 0, owned!: AbortSignal;
  const result = observeChatGptToolBoundaryDuring({ progress,
    observe: async signal => { owned = signal; started = true; return await new Promise<string>(() => {}); },
    capture: async signal => {
      const revision = progress.snapshot().lastToolBatchRevision;
      if (!revision) return;
      await captureChatGptToolBoundary({ tracker, revision, signal, timeoutMs: 15,
        capture: () => projection.promise, acknowledge: async () => { acks++; } });
    },
  });
  while (!started) await Bun.sleep(1);
  const revision = progress.recordToolBatch(1);
  await expect(result).rejects.toMatchObject({ code: "chatgpt_tool_boundary_observation_timeout" });
  expect(owned.aborted).toBe(true);
  projection.resolve("late"); await Bun.sleep(1);
  expect(acks).toBe(0); expect(tracker.needsToolBatchObservation(revision)).toBe(true);
});

test("cancelling a blocked response probe removes its progress observer without acknowledging a later batch", async () => {
  const worker: any = Object.create(ChatGptBrowserWorker.prototype), progress = new ChatGptExternalTurnProgress();
  const tracker = new ChatGptCompletionTracker(), controller = new AbortController();
  let started = false, captures = 0;
  worker.currentSubmissionAnswerText = async () => { captures++; return ""; };
  const result = worker.observeResponseProbe({}, {}, controller.signal, progress, tracker,
    async () => { started = true; return await new Promise(() => {}); });
  while (!started) await Bun.sleep(1);
  controller.abort(); await expect(result).rejects.toMatchObject({ name: "AbortError" });
  progress.recordToolBatch(1); await Bun.sleep(1);
  expect(captures).toBe(0);
});
