import { expect, test } from "bun:test";
import { recoverChatGptSubmission, type SubmissionRecoveryDecision, type SubmissionRecoveryEvent } from "../src/adapters/chatgpt-web/submission-recovery";

function fixture() {
  let presses = 0, accepted = false, decisions: Array<SubmissionRecoveryDecision<string>> = [];
  const events: SubmissionRecoveryEvent[] = [];
  const options = {
    key: {}, identity: "native-turn:submission", checkpointMs: 2, backoffMs: 1,
    activate: async () => { presses++; },
    observe: (signal: AbortSignal) => new Promise<string>((resolve, reject) => {
      const timer = setInterval(() => { if (accepted) { clearInterval(timer); signal.removeEventListener("abort", abort); resolve("user_turn"); } }, 1);
      const abort = () => { clearInterval(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
    }),
    reconcile: async (): Promise<SubmissionRecoveryDecision<string>> => decisions.shift() ?? { state: "ambiguous" },
    onEvent: (event: SubmissionRecoveryEvent) => { events.push(event); },
  };
  return { options, events, presses: () => presses, accept: () => { accepted = true; }, decide: (...values: typeof decisions) => { decisions.push(...values); } };
}

test("already accepted before recovery resumes observation without Send", async () => {
  const f = fixture(); f.decide({ state: "accepted", evidence: "mcp_tool_call" });
  expect(await recoverChatGptSubmission(f.options)).toBe("mcp_tool_call"); expect(f.presses()).toBe(0);
});

test("confirmed input non-dispatch permits one same-identity retry and acceptance", async () => {
  const f = fixture();
  f.decide({ state: "not_dispatched" }, { state: "not_dispatched" }, { state: "not_dispatched" });
  f.options.activate = async () => { f.events.push({ identity: "input", event: "activate", activations: 0, reconciliations: 0 });
    if (f.events.filter(e => e.identity === "input").length === 2) f.accept(); };
  expect(await recoverChatGptSubmission(f.options)).toBe("user_turn");
  expect(f.events.filter(e => e.event === "retry")).toHaveLength(1);
});

test("late acceptance during backoff invalidates a previously safe retry", async () => {
  const f = fixture(); f.decide({ state: "not_dispatched" }, { state: "not_dispatched" }, { state: "accepted", evidence: "assistant_turn" });
  expect(await recoverChatGptSubmission(f.options)).toBe("assistant_turn"); expect(f.presses()).toBe(1);
});

test("ambiguous acknowledgement never authorizes a replacement Send and reports exhaustion", async () => {
  const f = fixture(); f.decide({ state: "not_dispatched" });
  await expect(recoverChatGptSubmission(f.options)).rejects.toMatchObject({ name: "ChatGptSubmissionRecoveryExhausted", state: "ambiguous" });
  expect(f.presses()).toBe(1); expect(f.events.at(-1)?.event).toBe("exhausted");
});

test("a stalled physical input cannot be repeated even if the DOM reports no dispatch", async () => {
  const f = fixture(); f.decide(...Array.from({ length: 5 }, () => ({ state: "not_dispatched" as const })));
  let presses = 0; f.options.activate = async () => { presses++; await new Promise<void>(() => {}); };
  await expect(recoverChatGptSubmission(f.options)).rejects.toMatchObject({ name: "ChatGptSubmissionRecoveryExhausted" });
  expect(presses).toBe(1);
});

test("failed observation can reconcile a current accepted response without reactivation", async () => {
  const f = fixture(); f.decide({ state: "not_dispatched" }, { state: "accepted", evidence: "generation_running" });
  f.options.observe = async () => { throw Object.assign(new Error("DOM transport timeout"), { name: "ChatGptBrowserObservationTimeoutError" }); };
  expect(await recoverChatGptSubmission(f.options)).toBe("generation_running"); expect(f.presses()).toBe(1);
});

test("concurrent callers and a completed caller share the same submission receipt", async () => {
  const f = fixture(); f.decide({ state: "not_dispatched" });
  f.options.activate = async () => { f.accept(); };
  let preparations = 0, completions = 0;
  const options = { ...f.options, prepare: async () => { preparations++; }, onAccepted: () => { completions++; } };
  const first = recoverChatGptSubmission(options), second = recoverChatGptSubmission(options);
  expect(second).toBe(first); expect(await first).toBe("user_turn"); expect(await recoverChatGptSubmission(options)).toBe("user_turn");
  expect(preparations).toBe(1); expect(completions).toBe(1);
  await expect(recoverChatGptSubmission({ ...options, identity: "other-owner" })).rejects.toThrow("ownership changed");
});

test("failed submission identities retain an exhausted tombstone instead of replaying", async () => {
  const f = fixture(); f.decide({ state: "not_dispatched" });
  const first = recoverChatGptSubmission(f.options);
  await expect(first).rejects.toThrow("ambiguous prompt was not resent");
  expect(recoverChatGptSubmission(f.options)).toBe(first); expect(f.presses()).toBe(1);
});

test("retry count stays bounded at three physical activations", async () => {
  const f = fixture(); f.decide(...Array.from({ length: 10 }, () => ({ state: "not_dispatched" as const })));
  await expect(recoverChatGptSubmission(f.options)).rejects.toMatchObject({ state: "not_dispatched" }); expect(f.presses()).toBe(3);
});

test("user stop and inherited goal-budget cancellation stop backoff without another activation", async () => {
  for (const reason of [new Error("user stop"), new Error("goal budget exhausted")]) {
    const f = fixture(), controller = new AbortController();
    f.decide({ state: "not_dispatched" }, { state: "not_dispatched" });
    const options = { ...f.options, signal: controller.signal, backoffMs: 40,
      onEvent: (event: SubmissionRecoveryEvent) => { f.events.push(event); if (event.event === "reconcile") controller.abort(reason); } };
    await expect(recoverChatGptSubmission(options)).rejects.toBe(reason); expect(f.presses()).toBe(1);
  }
});

test("approval pending never becomes automatic submission authority", async () => {
  const f = fixture(); f.decide(...Array.from({ length: 5 }, () => ({ state: "approval_pending" as const })));
  await expect(recoverChatGptSubmission(f.options)).rejects.toMatchObject({ state: "approval_pending" }); expect(f.presses()).toBe(0);
});

test("session, limit and protocol failures retain their cause without retry", async () => {
  const f = fixture(); f.decide({ state: "not_dispatched" });
  const failure = Object.assign(new Error("session expired"), { name: "ChatGptWebAdapterError" });
  f.options.observe = async () => { throw failure; };
  await expect(recoverChatGptSubmission(f.options)).rejects.toBe(failure); expect(f.presses()).toBe(1);
});
