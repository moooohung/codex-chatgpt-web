import { expect, test } from "bun:test";
import { createDocument } from "@mixmark-io/domino";
import type { Locator } from "playwright-core";
import { ChatGptDeliveryRecovery, chatGptMessageDeliveryTimeoutVisible, type DeliveryRecoveryState } from "../src/adapters/chatgpt-web/delivery-recovery";

test("delivery recovery cancels a stalled state read and owns its late rejection", async () => {
  const controller = new AbortController();
  let rejectRead!: (error: Error) => void;
  let continuations = 0;
  const pending = new ChatGptDeliveryRecovery("abort-read").recover("response", {
    signal: controller.signal,
    readState: () => new Promise((_, reject) => { rejectRead = reject; }),
    continue: async () => { continuations++; },
  });
  controller.abort(new DOMException("user stop", "AbortError"));
  await expect(pending).rejects.toThrow("user stop");
  rejectRead(new Error("late browser failure"));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(continuations).toBe(0);
});

function fixture() {
  const state: DeliveryRecoveryState = { currentResponseIdentity: "response-1", errorVisible: true, running: false,
    toolsInFlight: false, approvalPending: false, deadlineReached: false };
  const prompts: string[] = [], events: string[] = [];
  const options = { backoffMs: 1, readState: async () => ({ ...state }),
    continue: async (prompt: string) => { prompts.push(prompt); return "new-response"; },
    onEvent: (event: { event: string }) => { events.push(event.event); } };
  return { state, prompts, events, options, recovery: new ChatGptDeliveryRecovery("native-turn") };
}

test("delivery error continues unfinished work once and keeps duplicate receipts", async () => {
  const f = fixture();
  const first = f.recovery.recover("response-1", f.options), duplicate = f.recovery.recover("response-1", f.options);
  expect(duplicate).toBe(first); expect(await first).toEqual({ kind: "continued", result: "new-response" });
  expect(await f.recovery.recover("response-1", f.options)).toEqual({ kind: "continued", result: "new-response" });
  expect(f.prompts).toHaveLength(1);
  expect(f.prompts[0]).toContain("Do not repeat completed commands, commits, messages, or the original request");
  expect(f.events).toEqual(["continuation_started", "continuation_accepted"]);
});

test("generation, outstanding tools, approval and a historical error preserve observation", async () => {
  for (const patch of [{ running: true }, { toolsInFlight: true }, { approvalPending: true }, { errorVisible: false }, { currentResponseIdentity: "newer-response" }]) {
    const f = fixture(); Object.assign(f.state, patch);
    expect(await f.recovery.recover("response-1", f.options)).toEqual({ kind: "wait" }); expect(f.prompts).toHaveLength(0);
  }
});

test("late generation during backoff cancels the continuation plan", async () => {
  const f = fixture(); let reads = 0;
  f.options.readState = async () => { if (++reads === 2) f.state.running = true; return { ...f.state }; };
  expect(await f.recovery.recover("response-1", f.options)).toEqual({ kind: "wait" }); expect(f.prompts).toHaveLength(0);
});

test("delivery retry budget spans three distinct response errors", async () => {
  const f = fixture();
  for (let i = 1; i <= 3; i++) { f.state.currentResponseIdentity = `response-${i}`; await f.recovery.recover(`response-${i}`, f.options); }
  f.state.currentResponseIdentity = "response-4";
  await expect(f.recovery.recover("response-4", f.options)).rejects.toMatchObject({ name: "ChatGptDeliveryRecoveryExhausted" });
  expect(f.prompts).toHaveLength(3); expect(f.events.at(-1)).toBe("exhausted");
});

test("user stop, goal-budget abort and deadline prevent continuation Send", async () => {
  for (const reason of [new Error("user stop"), new Error("goal budget exhausted")]) {
    const f = fixture(), controller = new AbortController();
    f.options.readState = async () => { controller.abort(reason); return { ...f.state }; };
    await expect(f.recovery.recover("response-1", { ...f.options, signal: controller.signal })).rejects.toBe(reason); expect(f.prompts).toHaveLength(0);
  }
  const f = fixture(); f.state.deadlineReached = true;
  await expect(f.recovery.recover("response-1", f.options)).rejects.toThrow("turn timed out"); expect(f.prompts).toHaveLength(0);
});

test("a failed continuation retains its exact error instead of duplicating a completed step", async () => {
  const f = fixture(), failure = new Error("ambiguous continuation acceptance");
  f.options.continue = async prompt => { f.prompts.push(prompt); throw failure; };
  const first = f.recovery.recover("response-1", f.options);
  await expect(first).rejects.toBe(failure); expect(f.recovery.recover("response-1", f.options)).toBe(first); expect(f.prompts).toHaveLength(1);
});

test("delivery-timeout UI detection ignores quoted and historical error text", async () => {
  const document = createDocument(`<div id="old"><span data-error-text>Message delivery timed out. Please try again.</span><button>Retry</button></div>
    <div id="current"><div class="markdown"><span data-error-text>Message delivery timed out. Please try again.</span><button>Retry</button></div></div>`);
  const original = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (() => ({ display: "block", visibility: "visible" })) as any;
  for (const element of document.querySelectorAll("*")) {
    Object.defineProperty(element, "isConnected", { value: true });
    (element as any).getBoundingClientRect = () => ({ width: 100, height: 20 });
  }
  const scope = (id: string) => ({ getByText: (pattern: RegExp) => ({
    evaluateAll: (fn: (elements: Element[]) => boolean) => Promise.resolve(fn([...document.getElementById(id)!.querySelectorAll("[data-error-text]")]
      .filter(element => pattern.test(element.textContent ?? "")))),
  }) }) as unknown as Locator;
  try {
    expect(await chatGptMessageDeliveryTimeoutVisible(scope("old"))).toBe(true);
    expect(await chatGptMessageDeliveryTimeoutVisible(scope("current"))).toBe(false);
    document.getElementById("current")!.firstElementChild!.className = "error-banner";
    expect(await chatGptMessageDeliveryTimeoutVisible(scope("current"))).toBe(true);
  } finally { globalThis.getComputedStyle = original; }
});
