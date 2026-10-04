import { expect, test } from "bun:test";
import { ChatGptResponseProgressTracker } from "../src/adapters/chatgpt-web/response-progress";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { chatGptRoundFailureEvidence } from "../src/adapters/chatgpt-web/round-observer";
import type { ChatGptExternalTurnProgressSnapshot } from "../src/adapters/chatgpt-web/turn-progress";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function fixture() {
  const scheduled: Array<{ task: () => void; delay: number; cancelled: boolean }> = [];
  const sessions = new ChatGptTurnSessions(30 * 60_000, 256, 5000, (task, delay) => {
    const entry = { task, delay, cancelled: false };
    scheduled.push(entry);
    return () => { entry.cancelled = true; };
  });
  const browser = deferred<string>();
  const physical = deferred<void>();
  const release = deferred<void>();
  const cancellations: Array<Error | undefined> = [];
  let releases = 0;
  const session = sessions.getOrCreate("exact-turn", () => ({
    mode: "read-only", browser: browser.promise, physicalSettlement: physical.promise,
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), conversationKey: "owned-chat",
    cancel: reason => { cancellations.push(reason); browser.reject(reason ?? new Error("cancelled")); },
    releaseRetainedConversation: () => { releases++; return release.promise; },
  }), "trace-test", "owner-test");
  return { sessions, session, scheduled, browser, physical, release, cancellations, releases: () => releases };
}

test("exact reconnect invalidates the old disconnect timer and does not resend", async () => {
  const f = fixture();
  const first = new AbortController();
  f.sessions.observe("exact-turn", f.session, first.signal);
  first.abort();
  expect(f.scheduled[0]!.delay).toBe(5000);
  expect(f.sessions.getOrCreate("exact-turn", () => { throw new Error("duplicate Send"); })).toBe(f.session);
  const second = new AbortController();
  const finish = f.sessions.observe("exact-turn", f.session, second.signal);
  expect(f.scheduled[0]!.cancelled).toBeTrue();
  f.scheduled[0]!.task(); // An already-queued stale timer cannot cancel the reconnected owner.
  expect(f.cancellations).toEqual([]);
  finish();
  second.abort();
  expect(f.scheduled).toHaveLength(1);
  f.browser.resolve("completed"); f.physical.resolve(); await f.session.browserOutcome;
});

test("last lost observer cancels only its owner and blocks replacement through real cleanup", async () => {
  const f = fixture();
  let otherCancelled = 0;
  f.sessions.getOrCreate("other-turn", () => ({
    mode: "read-only", browser: new Promise<string>(() => {}), physicalSettlement: new Promise<void>(() => {}),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel: () => { otherCancelled++; },
  }), "trace-other", "owner-other");
  const controller = new AbortController();
  f.sessions.observe("exact-turn", f.session, controller.signal);
  controller.abort(); f.scheduled[0]!.task();
  await f.session.browserOutcome;
  expect(f.cancellations).toHaveLength(1);
  expect(f.cancellations[0]).toMatchObject({ code: "client_cancelled", retryable: false });
  expect(otherCancelled).toBe(0);
  expect(f.sessions.findConversationHead("owned-chat")).toBeUndefined();
  expect(f.sessions.getOrCreate("exact-turn", () => { throw new Error("late resend"); })).toBe(f.session);
  let replacementStarted = false;
  const replacement = f.sessions.getOrCreateAfterOwnerRetirement("next-turn", "owner-test", () => {
    replacementStarted = true;
    return { mode: "read-only", browser: Promise.resolve("new"), physicalSettlement: Promise.resolve(),
      trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel: () => {} };
  });
  await flush(); expect(replacementStarted).toBeFalse(); expect(f.releases()).toBe(0);
  f.physical.resolve(); await flush();
  expect(f.releases()).toBe(1); expect(replacementStarted).toBeFalse();
  f.release.resolve(); await replacement;
  expect(replacementStarted).toBeTrue(); expect(f.cancellations).toHaveLength(1);
});

test("one lost observer cannot cancel another observer's active response", () => {
  const f = fixture(); const first = new AbortController(); const second = new AbortController();
  f.sessions.observe("exact-turn", f.session, first.signal);
  f.sessions.observe("exact-turn", f.session, second.signal);
  first.abort(); expect(f.scheduled).toHaveLength(0);
  second.abort(); expect(f.scheduled).toHaveLength(1);
  f.scheduled[0]!.task(); expect(f.cancellations).toHaveLength(1);
  f.physical.resolve(); f.release.resolve();
});

test("normal tool-round completion leaves native execution alive without an orphan timer", () => {
  const f = fixture(); const controller = new AbortController();
  const completeRound = f.sessions.observe("exact-turn", f.session, controller.signal);
  completeRound(); completeRound(); controller.abort();
  expect(f.scheduled).toHaveLength(0); expect(f.cancellations).toHaveLength(0);
  expect(f.session.isActive()).toBeTrue();
  f.browser.resolve("done"); f.physical.resolve();
});

test("callback disconnect and an already-aborted signal both arm bounded cleanup", () => {
  for (const signalAbort of [false, true]) {
    const f = fixture(); const controller = new AbortController();
    if (signalAbort) controller.abort();
    const detach = f.sessions.observe("exact-turn", f.session, controller.signal);
    if (!signalAbort) detach(true);
    detach(); expect(f.scheduled).toHaveLength(1);
    f.scheduled[0]!.task(); expect(f.cancellations).toHaveLength(1);
    f.physical.resolve(); f.release.resolve();
  }
});

test("physical completion before disconnect deadline cancels pending cleanup", async () => {
  const f = fixture(); const controller = new AbortController();
  f.sessions.observe("exact-turn", f.session, controller.signal); controller.abort();
  f.browser.resolve("done"); f.physical.resolve(); await flush();
  expect(f.scheduled[0]!.cancelled).toBeTrue(); f.scheduled[0]!.task();
  expect(f.cancellations).toHaveLength(0); expect(f.releases()).toBe(0);
});

test("failed retained-conversation cleanup cannot admit a replacement", async () => {
  const f = fixture(); const controller = new AbortController();
  f.sessions.observe("exact-turn", f.session, controller.signal); controller.abort();
  f.scheduled[0]!.task(); f.physical.resolve(); await flush();
  f.release.reject(new Error("release acknowledgement missing")); await flush();
  let started = false; let caught: unknown;
  try { await f.sessions.getOrCreateAfterOwnerRetirement("next", "owner-test", () => {
    started = true; return f.session.runtime;
  }); } catch (error) { caught = error; }
  expect(caught).toMatchObject({ message: "release acknowledgement missing" }); expect(started).toBeFalse();
});

function toolProgress(at: number, revision = 1): ChatGptExternalTurnProgressSnapshot {
  return { revision, lastToolBatchRevision: 1, activeToolCalls: 1, lastProgressAt: at };
}

test("976 keep-alive polls and a persistent active tool cannot extend a 600-second budget", () => {
  const progress = new ChatGptResponseProgressTracker(600); progress.accepted(0);
  for (let i = 0; i < 976; i++) expect(progress.check(toolProgress(0), i * 600)).toBeUndefined();
  expect(progress.check(toolProgress(0, 2), 600_000)).toMatchObject({
    status: 504, code: "upstream_stall_timeout", retryable: false,
  });
  expect(chatGptRoundFailureEvidence(progress.check(undefined, 600_000))).toEqual({
    errorName: "ChatGptWebAdapterError", errorCode: "upstream_stall_timeout",
  });
});

test("new answer or native tool activity advances the deadline, repeated acceptance does not", () => {
  const progress = new ChatGptResponseProgressTracker(600); progress.accepted(0);
  progress.emittedContent(500_000); progress.accepted(600_000);
  expect(progress.check(undefined, 1_099_999)).toBeUndefined();
  expect(progress.check(toolProgress(1_000_000), 1_100_000)).toBeUndefined();
  expect(progress.check(toolProgress(1_000_000, 2), 1_599_999)).toBeUndefined();
  expect(progress.check(toolProgress(1_000_000, 3), 1_600_000)?.code).toBe("upstream_stall_timeout");
});

test("preparation is unarmed and invalid, stale or future tool frames buy no extra budget", () => {
  const progress = new ChatGptResponseProgressTracker(600);
  progress.emittedContent(1); expect(progress.check(undefined, 9_000_000)).toBeUndefined();
  progress.accepted(0);
  expect(progress.check(toolProgress(Number.NaN), 500_000)).toBeUndefined();
  expect(progress.check(toolProgress(9_000_000), 500_000)).toBeUndefined();
  expect(progress.check(toolProgress(-1), 600_000)?.code).toBe("upstream_stall_timeout");
  const proven = new ChatGptResponseProgressTracker(600);
  expect(proven.check(toolProgress(100), 100)).toBeUndefined();
  expect(proven.check(toolProgress(99), 600_100)?.code).toBe("upstream_stall_timeout");
});

test("content feeds report new content only; draining a replay is not execution progress", () => {
  let activity = 0; const trace = new ChatGptTraceFeed(() => { activity++; });
  const text = new ChatGptTextFeed(() => { activity++; });
  trace.push({ kind: "reasoning", text: "  " }); text.push(""); expect(activity).toBe(0);
  trace.push({ kind: "reasoning", text: "new reasoning" }); text.push("new answer");
  expect(activity).toBe(2); trace.drain(); text.drain(); expect(activity).toBe(2);
});

test("accepted automatic browser stalls are cancelled once and terminal reconnect never resends", async () => {
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: "browser://watchdog-fixture",
    chatgptWeb: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, stallTimeoutSec: 1 } };
  const request: CodexParsedRequest = { modelId: CHATGPT_WEB_MODEL_ID, stream: true,
    context: { tools: [], messages: [{ role: "user", content: "watchdog fixture", timestamp: 1 }] },
    options: { reasoning: "high" }, _rawBody: {
      prompt_cache_key: "thread_watchdog_fixture",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_watchdog_fixture", turn_id: "turn_watchdog_fixture" }) },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "watchdog fixture" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_watchdog_fixture" } }],
    } };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const original = worker.run;
  let starts = 0; const cancellations: unknown[] = [];
  worker.run = (turn: BrowserTurn) => new Promise<string>((_resolve, reject) => {
    starts++; turn.onSubmitted?.();
    turn.abortSignal?.addEventListener("abort", () => {
      cancellations.push(turn.abortSignal?.reason); reject(turn.abortSignal?.reason);
    }, { once: true });
  });
  try {
    const adapter = createChatGptWebAdapter(provider); const events: AdapterEvent[] = [];
    await adapter.runTurn!(request, { headers: new Headers() }, event => events.push(event));
    expect(events.find(event => event.type === "error")).toMatchObject({
      status: 504, code: "upstream_stall_timeout", retryable: false,
    });
    expect(cancellations).toHaveLength(1); expect(starts).toBe(1);
    const replay: AdapterEvent[] = [];
    await adapter.runTurn!(request, { headers: new Headers() }, event => replay.push(event));
    expect(starts).toBe(1); expect(cancellations).toHaveLength(1);
    expect(replay.find(event => event.type === "error")).toMatchObject({ code: "upstream_stall_timeout", retryable: false });
  } finally { worker.run = original; }
}, 10_000);
