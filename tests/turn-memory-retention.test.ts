import { expect, test } from "bun:test";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import type { ChatGptTurnRuntime } from "../src/adapters/chatgpt-web/turn-execution";
import type { CodexParsedRequest, AdapterEvent } from "../src/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 24; i++) await Promise.resolve(); }

test("terminal replay releases large input only after physical and admitted observer settlement", async () => {
  const browser = deferred<string>(), physical = deferred<void>(), observer = deferred<void>(), retire = deferred<void>();
  let retired = 0, cancelled = 0, released = 0, progress = 0;
  const input = { _rawBody: { input: "x".repeat(2_000_000) } } as unknown as CodexParsedRequest;
  const runtime: ChatGptTurnRuntime = { mode: "read-only", browser: browser.promise, physicalSettlement: physical.promise,
    usageInput: input, trace: new ChatGptTraceFeed(() => progress++), text: new ChatGptTextFeed(() => progress++),
    cancel: () => { cancelled++; }, retireCapability: async () => { retired++; await retire.promise; },
    releaseRetainedConversation: async () => { released++; } };
  const session = new ChatGptTurnSession(runtime);
  const events: AdapterEvent[] = [{ type: "text_delta", text: "saved answer" }];
  runtime.text.push("saved answer");
  session.appendRoundEvents("round", events); session.completeRound("round"); session.setFinalEvents(events);
  const reading = session.runExclusive(() => observer.promise);
  browser.resolve("saved answer"); await session.browserOutcome;
  expect(runtime.usageInput).toBe(input);
  physical.resolve(); await flush(); expect(retired).toBe(0);
  observer.resolve(); await reading; await flush(); expect(retired).toBe(1);
  expect(runtime.usageInput).toBe(input); // Retirement can still need the active closure.
  retire.resolve(); await flush();
  expect(runtime.usageInput).toBeUndefined(); expect(runtime.retireCapability).toBeUndefined();
  session.cancel(); expect(cancelled).toBe(0);
  expect(session.settledOutcome()).toEqual({ type: "final", answer: "saved answer" });
  expect(runtime.text.value()).toBe("saved answer");
  expect(runtime.text.drain()).toEqual(["saved answer"]);
  expect(session.roundEvents("round")).toEqual(events); expect(session.eventsForFinalReplay()).toEqual(events);
  const before = progress; runtime.text.push("late"); runtime.trace.push({ kind: "reasoning", text: "late" });
  expect(progress).toBe(before);
  await runtime.releaseRetainedConversation!(); expect(released).toBe(1);
});

test("read-only completion without a broker also releases execution references", async () => {
  const physical = deferred<void>();
  const runtime: ChatGptTurnRuntime = { mode: "read-only", browser: Promise.resolve("answer"), physicalSettlement: physical.promise,
    usageInput: {} as CodexParsedRequest, trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {} };
  const session = new ChatGptTurnSession(runtime);
  await session.runExclusive(async () => {}); await session.browserOutcome;
  physical.resolve(); await flush(); expect(runtime.usageInput).toBeUndefined();
  expect(session.settledOutcome()).toEqual({ type: "final", answer: "answer" });
});

test("cleanup retains a failed outcome and runs even when capability retirement rejects", async () => {
  const runtime: ChatGptTurnRuntime = { mode: "read-only", browser: Promise.reject(new Error("original failure")), physicalSettlement: Promise.resolve(),
    usageInput: {} as CodexParsedRequest, trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {},
    retireCapability: async () => { throw new Error("retirement failed"); } };
  const session = new ChatGptTurnSession(runtime);
  await session.runExclusive(async () => {}); await session.browserOutcome; await flush();
  expect(runtime.usageInput).toBeUndefined();
  expect(session.settledOutcome()).toMatchObject({ type: "error", error: { message: "original failure" } });
});

test("physical settlement alone cannot release a still pending browser outcome", async () => {
  const browser = deferred<string>();
  const runtime: ChatGptTurnRuntime = { mode: "read-only", browser: browser.promise, physicalSettlement: Promise.resolve(),
    usageInput: {} as CodexParsedRequest, trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {} };
  const session = new ChatGptTurnSession(runtime);
  await session.runExclusive(async () => {}); await flush(); expect(runtime.usageInput).toBeDefined();
  browser.resolve("answer"); await session.browserOutcome; await flush(); expect(runtime.usageInput).toBeUndefined();
});
