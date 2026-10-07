import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { ChatGptBrowserObservationTimeoutError, ChatGptBrowserWorker, MAX_CHATGPT_BROWSER_PAGE_REBINDS } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { chatGptToolBoundaryError } from "../src/adapters/chatgpt-web/tool-boundary";

// Execute the actual response-loop catch. A fixture drives its continuation without a browser Send.
const file = ts.createSourceFile("browser-worker.ts", readFileSync("src/adapters/chatgpt-web/browser-worker.ts", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const catches: ts.CatchClause[] = [];
const visit = (node: ts.Node) => {
  if (ts.isCatchClause(node) && node.getText(file).includes("consecutiveObservationRebinds += 1")
    && node.getText(file).includes("internalObservationFaults += 1")) catches.push(node);
  ts.forEachChild(node, visit);
};
visit(file);
if (catches.length !== 1) throw Error("Exactly one response-observation recovery catch is required");
const code = `async function fixtureRun(fixture) {
  let { turn, launcherObservationRecovery, observedThisIteration, deadline } = fixture;
  let consecutiveObservationRebinds = 0, internalObservationFaults = 0, completionFenceRevision = 17;
  let submissionBaseline = { initialTurnIdentities: ["old"], acceptedUserIdentity: "accepted-user", submittedText: "original unsent-again input", domCache: { key: "old" } };
  let responseTurn = { identity: "current-assistant", acceptedTurnIdentities: ["old", "accepted-user"], locator: "old locator" };
  const responseDomCache = { key: "old", snapshot: { visibleText: "stale" } };
  const page = { locator: selector => ({ selector }) }, diagnostics = { capture: async () => { fixture.captures++; } };
  const rebindLauncherPage = async (...args) => { fixture.rebinds.push(args); await fixture.onRebind?.(); };
  for (const error of fixture.errors) {
    try { throw error; } ${catches[0]!.getText(file)}
  }
  return { submissionBaseline, responseTurn, responseDomCache, completionFenceRevision, consecutiveObservationRebinds };
}`;
const execute: (fixture: any) => Promise<any> = new Function("ChatGptBrowserObservationTimeoutError", "ChatGptWebAdapterError", "MAX_CHATGPT_BROWSER_PAGE_REBINDS", "MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS", "chatGptAssistantTurnSelector", "CHATGPT_USER_TURN_SELECTOR", "CHATGPT_ASSISTANT_TURN_SELECTOR",
  ts.transpile(code, { target: ts.ScriptTarget.ESNext }) + "; return fixtureRun;")(
    ChatGptBrowserObservationTimeoutError, ChatGptWebAdapterError, MAX_CHATGPT_BROWSER_PAGE_REBINDS, 2,
    (id: string) => `assistant:${id}`, "users", "assistants",
  );
const fixture = (errors: unknown[]) => ({ errors, turn: {}, launcherObservationRecovery: true, observedThisIteration: false,
  rebinds: [] as unknown[], captures: 0, onRebind: undefined as (() => void) | undefined, deadline: undefined as number | undefined });

for (const probe of ["session_alert", "delivery_timeout", "terminal_error", "response_projection"] as const) {
  test(`${probe} timeout reconnects the accepted page and invalidates stale caches`, async () => {
    const input = fixture([new ChatGptBrowserObservationTimeoutError(20_000, probe)]);
    const result = await execute(input);
    expect(input.rebinds).toHaveLength(1);
    expect(result.submissionBaseline).toMatchObject({ initialTurnIdentities: ["old"], acceptedUserIdentity: "accepted-user", submittedText: "original unsent-again input", domCache: {} });
    expect(result.responseTurn).toMatchObject({ identity: "current-assistant", acceptedTurnIdentities: ["old", "accepted-user"] });
    expect(result.responseDomCache).toEqual({ key: undefined, snapshot: undefined });
    expect(result.completionFenceRevision).toBeUndefined();
  });
}
test("persistent unresponsive page has only two reconnects and an explicit terminal error", async () => {
  const input = fixture(Array.from({ length: 3 }, () => new ChatGptBrowserObservationTimeoutError(20_000, "session_alert")));
  await expect(execute(input)).rejects.toMatchObject({ code: "browser_observation_recovery_exhausted", retryable: false, message: expect.stringContaining("probe=session_alert") });
  expect(input.rebinds).toHaveLength(2);
});
test("ACK failures, deliberate UI errors, and consumer timeouts never enter observation recovery", async () => {
  for (const error of [chatGptToolBoundaryError("chatgpt_tool_boundary_ack_timeout"), new ChatGptWebAdapterError("expired", { code: "chatgpt_session_expired", status: 401, errorType: "authentication_error", retryable: false })]) {
    const input = fixture([error]);
    await expect(execute(input)).rejects.toBe(error);
    expect(input.rebinds).toEqual([]);
  }
  for (const settings of [{ observedThisIteration: true }, { launcherObservationRecovery: false }, { deadline: 0 }]) {
    const error = new ChatGptBrowserObservationTimeoutError(20_000, "session_alert");
    const input = { ...fixture([error]), ...settings };
    await expect(execute(input)).rejects.toBe(error);
    expect(input.rebinds).toEqual([]);
  }
});
test("cancellation before or during reconnect fences further observations", async () => {
  for (const during of [false, true]) {
    const controller = new AbortController();
    const input = Object.assign(fixture([new ChatGptBrowserObservationTimeoutError(20_000)]), { turn: { abortSignal: controller.signal } });
    if (during) input.onRebind = () => controller.abort(); else controller.abort();
    await expect(execute(input)).rejects.toMatchObject({ name: "AbortError" });
    expect(input.rebinds).toHaveLength(during ? 1 : 0);
    expect(input.captures).toBe(0);
  }
});
test("a timed-out response probe owns its cancellation and reports its exact operation", async () => {
  const worker: any = Object.create(ChatGptBrowserWorker.prototype);
  let owned!: AbortSignal;
  const result = worker.observeResponseProbe({}, {}, undefined, undefined, undefined,
    (signal: AbortSignal) => { owned = signal; return new Promise(() => {}); }, 5, "session_alert");
  await expect(result).rejects.toMatchObject({ code: "browser_observation_timeout", probe: "session_alert", timeoutMs: 5 });
  expect(owned.aborted).toBe(true);
});

test("session-alert timeout before assistant binding enters the same-page recovery contract", async () => {
  const worker: any = Object.create(ChatGptBrowserWorker.prototype);
  const first = { isClosed: () => false, locator: () => ({ page: "first" }) };
  const rebound = { isClosed: () => false, locator: () => ({ page: "rebound" }) };
  let recoveries = 0;
  worker.observeResponseProbe = async (page: unknown, _baseline: unknown, _signal: unknown, _progress: unknown,
    _tracker: unknown, _read: unknown, _timeout: unknown, probe: string) => {
    if (probe === "session_alert" && page === first) throw new ChatGptBrowserObservationTimeoutError(20_000, "session_alert");
    if (probe === "turn_state") return { responseIdentities: ["current-assistant"], userIdentities: ["accepted-user"], turnIdentities: ["accepted-user", "current-assistant"] };
  };
  const baseline = { initialTurnIdentities: [], acceptedUserIdentity: "accepted-user", domCache: {} };
  const binding = await worker.waitForNewAssistantTurn(first, baseline, undefined, undefined, undefined, 60_000,
    undefined, async (_attempt: number, error: Error, received: unknown) => {
      expect(error).toBeInstanceOf(ChatGptBrowserObservationTimeoutError);
      expect(received).toBe(baseline);
      recoveries++;
      return { page: rebound, baseline };
    });
  expect(recoveries).toBe(1);
  expect(binding).toMatchObject({ identity: "current-assistant", locator: { page: "rebound" } });
});

test("visible session failure while MCP is live still fails immediately without recovery", async () => {
  const worker: any = Object.create(ChatGptBrowserWorker.prototype);
  const error = new ChatGptWebAdapterError("expired", { code: "chatgpt_session_expired", status: 401, errorType: "authentication_error", retryable: false });
  worker.observeSubmissionToolBoundary = async () => {};
  worker.observeResponseProbe = async () => { throw error; };
  let recoveries = 0;
  await expect(worker.waitForNewAssistantTurn({ isClosed: () => false }, {}, undefined, undefined,
    { snapshot: () => ({ revision: 1, lastToolBatchRevision: 1, activeToolCalls: 1, lastProgressAt: Date.now() }) },
    60_000, undefined, async () => { recoveries++; })).rejects.toBe(error);
  expect(recoveries).toBe(0);
});
