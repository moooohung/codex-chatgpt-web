import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isChatGptAccountPreparation, type ChatGptAccountPreparation } from "../src/adapters/chatgpt-web/account-context";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import type { BrowserTurn, ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { createBrowserHelperPromptSelection } from "../src/adapters/chatgpt-web/browser-helper-prompt-selection";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { isChatGptWebMultipartPartCount, type CompiledChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { validateSkillFiles } from "../src/adapters/chatgpt-web/skill-attachments";
import { ChatGptMirroredTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { chatGptToolBoundaryError, logChatGptToolBoundary } from "../src/adapters/chatgpt-web/tool-boundary";

type Frame = Record<string, unknown>;
type Prepared = CompiledChatGptWebPrompt & { release(): void };
const traceId = "account-context-helper";
const config: ResolvedBrowserConfig = {
  appName: "offline", browserHost: "launcher", browserHostDescriptorPath: "/offline/launcher.json",
  storageStatePath: "/offline/unused.json", chromeExecutablePath: "/offline/unused-chrome",
  headed: true, autoApproveToolCalls: false
};

function preparation(planType: ChatGptAccountPreparation["planType"]): ChatGptAccountPreparation {
  const pro = planType === "pro" || planType === "prolite";
  return {
    accountKey: ({ pro: "a", plus: "b", prolite: "c", free: "d" }[planType]).repeat(64),
    planType,
    capabilities: { localToolsEnabled: false, solAvailable: planType !== "free", extraHighAvailable: pro, proAvailable: pro },
    ...(planType !== "free" ? { modelFamily: pro ? "6" as const : "5.6" as const } : {}),
    reasoning: pro ? "max" : planType === "plus" ? "high" : "low",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error("Offline IPC fixture did not reach its expected boundary");
}

function clientFixture(overrides: Partial<BrowserTurn> = {}) {
  const client = new LauncherBrowserHelperClient(config);
  const internal = client as unknown as {
    child: unknown;
    ensureChild(): Promise<void>;
    send(frame: Frame): Promise<void>;
    handleLine(child: unknown, line: string): void;
    handleExit(child: unknown, error: Error): void;
    terminateChild(child: unknown): Promise<void>;
    finishWithError(id: string, error: Error): void;
  };
  const child = {};
  const sent: Frame[] = [];
  const protocolErrors: Error[] = [];
  internal.child = child;
  internal.ensureChild = async () => {};
  // Invalid protocol normally retires a real process and its launcher lease. Both are inert here.
  internal.handleExit = (_child, error) => {
    protocolErrors.push(error);
    internal.finishWithError(traceId, error);
  };
  internal.terminateChild = async () => {};
  const emit = (frame: Frame) => internal.handleLine(child, JSON.stringify({ id: traceId, ...frame }));
  internal.send = async frame => {
    sent.push(JSON.parse(JSON.stringify(frame)) as Frame);
    if (frame.type === "abort") queueMicrotask(() => emit({ type: "error", name: "AbortError", message: "fixture aborted" }));
  };
  const turn: BrowserTurn = {
    traceId, modelId: "gpt-5.6-sol", modelFamily: "6", reasoning: "max",
    capabilities: preparation("pro").capabilities,
    prepare: async () => ({ text: "legacy", images: [], release() {} }),
    onTextDelta() {}, ...overrides,
  };
  return {
    internal, emit, sent, protocolErrors,
    async start() {
      const result = client.run(turn);
      void result.catch(() => {});
      await until(() => sent.some(frame => frame.type === "run"));
      return { result };
    },
    select(accountPreparation?: unknown, reused = false) {
      emit({ type: "event", event: "prepared_selected", reused,
        ...(accountPreparation !== undefined ? { accountPreparation } : {}) });
    },
    acks: () => sent.filter(frame => frame.type === "prepared_selected_ack"),
  };
}

// Execute the actual helper event loop with injected module bindings. No child, browser, launcher
// server, or provider is started. Only static imports are removed before TypeScript transpilation.
const helperBody = new Bun.Transpiler({ loader: "ts" }).transformSync(
  readFileSync(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url), "utf8")
    .replace(/^import[\s\S]*?from ["'][^"']+["'];\r?\n/gm, ""),
);
function helperFixture(runWorker: (turn: BrowserTurn) => Promise<string>, forward?: (frame: Frame) => void) {
  const frames: Frame[] = [];
  const listeners = new Map<string, (line: string) => void>();
  const input = { on(event: string, listener: (line: string) => void) { listeners.set(event, listener); }, close() {} };
  const stdout = {};
  const bindings = {
    createInterface: () => input, stdin: {}, stdout, stderr: {},
    console: { info() {}, warn() {}, error() {} },
    process: { pid: 1234, once() {}, exit() {} },
    createProcessLineWriter: (stream: unknown) => ({
      write(line: string) {
        if (stream === stdout) {
          const frame = JSON.parse(line) as Frame;
          frames.push(frame);
          forward?.(frame);
        }
        return true;
      },
      close() {},
    }),
    ChatGptBrowserWorker: { forProvider: () => ({ run: runWorker }) },
    closeChatGptBrowserWorkers: async () => {},
    ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError, isChatGptAccountPreparation,
    createBrowserHelperPromptSelection, validateSkillFiles, isChatGptWebMultipartPartCount,
    ChatGptMirroredTurnProgress, chatGptToolBoundaryError, logChatGptToolBoundary,
  };
  new Function("bindings", `const { ${Object.keys(bindings).join(", ")} } = bindings;\n${helperBody}`)(bindings);
  return {
    frames,
    receive(frame: Frame) { listeners.get("line")!(JSON.stringify(frame)); },
    start() {
      listeners.get("line")!(JSON.stringify({ type: "run", id: traceId,
        config: { ...config, turnTimeoutMs: 60_000 },
        turn: { traceId, modelId: "gpt-5.6-sol", reasoning: "max", modelFamily: "6",
          capabilities: preparation("pro").capabilities, resumeAvailable: true },
      }));
    },
  };
}

function linkedFixture(runWorker: (turn: BrowserTurn) => Promise<string>, overrides: Partial<BrowserTurn>) {
  const client = clientFixture(overrides);
  const helper = helperFixture(runWorker, frame => queueMicrotask(() => client.emit(frame)));
  client.internal.send = async frame => {
    client.sent.push(JSON.parse(JSON.stringify(frame)) as Frame);
    queueMicrotask(() => helper.receive(frame));
  };
  return { client, helper };
}

for (const plan of ["pro", "plus", "prolite", "free"] as const) {
  for (const reused of [false, true]) {
    test(`exact ${plan} payload reaches ${reused ? "resume" : "fresh"} preparation after account selection`, async () => {
      const actual = preparation(plan);
      const order: string[] = [];
      const releases: string[] = [];
      const prepare = (kind: string) => async (account?: ChatGptAccountPreparation): Promise<Prepared> => {
        expect(account).toEqual(actual);
        order.push(kind);
        return { text: `${account!.planType}:${kind}`, images: [], release: () => { releases.push(kind); } };
      };
      const { client, helper } = linkedFixture(async turn => {
        await turn.onPreparedSelected!(reused, actual);
        const selected = await (reused ? turn.prepareResume! : turn.prepare)(actual);
        expect(selected.text).toBe(`${plan}:${reused ? "resume" : "prepare"}`);
        return "done";
      }, {
        prepare: prepare("prepare"), prepareResume: prepare("resume"),
        onAccountSelected: account => { expect(account).toEqual(actual); order.push("account"); },
        onPreparedSelected: (selectedReused, account) => {
          expect(selectedReused).toBe(reused); expect(account).toEqual(actual); order.push("selected");
        },
      });
      const { result } = await client.start();
      await expect(result).resolves.toBe("done");
      expect(order).toEqual(["account", reused ? "resume" : "prepare", "selected"]);
      expect(helper.frames.find(frame => frame.event === "prepared_selected")).toEqual({
        type: "event", id: traceId, event: "prepared_selected", reused, accountPreparation: actual,
      });
      expect(client.acks()).toEqual([{ type: "prepared_selected_ack", id: traceId,
        prepared: { text: `${plan}:${reused ? "resume" : "prepare"}`, images: [] } }]);
      expect(releases).toEqual([reused ? "resume" : "prepare"]);
    });
  }
}

test.each([{ reused: false }, { reused: true }])("legacy selection remains optional and never guesses an account (reused=$reused)", async ({ reused }) => {
  const calls: Array<ChatGptAccountPreparation | undefined> = [];
  let accountCalls = 0;
  const prepare = async (account?: ChatGptAccountPreparation) => {
    calls.push(account); return { text: "legacy", images: [], release() {} };
  };
  const { client, helper } = linkedFixture(async turn => {
    await turn.onPreparedSelected!(reused);
    expect((await (reused ? turn.prepareResume! : turn.prepare)()).text).toBe("legacy");
    return "done";
  }, { prepare, prepareResume: prepare, onAccountSelected: () => { accountCalls++; } });
  const { result } = await client.start();
  await expect(result).resolves.toBe("done");
  expect(calls).toEqual([undefined]); expect(accountCalls).toBe(0);
  expect(helper.frames.find(frame => frame.event === "prepared_selected")).toEqual({
    type: "event", id: traceId, event: "prepared_selected", reused,
  });
});

test.each([
  { first: "pro", second: "plus", reused: false },
  { first: "plus", second: "pro", reused: true },
] as const)("UNSENT $first to $second failover recompiles and releases the superseded prompt (resume=$reused)", async ({ first, second, reused }) => {
  const order: string[] = [];
  const released: string[] = [];
  const compile = (kind: string) => async (account?: ChatGptAccountPreparation) => {
    order.push(`${kind}:${account!.planType}`);
    if (account!.planType === second) expect(released).toEqual([first]);
    return { text: `${account!.planType}:${kind}`, images: [],
      multipart: { parts: [`${account!.planType} context`, "final context"], commit: `${account!.planType} commit` },
      release() { released.push(account!.planType); },
    };
  };
  const { client, helper } = linkedFixture(async turn => {
    await turn.onPreparedSelected!(false, preparation(first));
    expect((await turn.prepare()).text).toBe(`${first}:fresh`);
    await turn.onPreparedSelected!(reused, preparation(second));
    const selected = await (reused ? turn.prepareResume! : turn.prepare)();
    expect(selected.text).toBe(`${second}:${reused ? "resume" : "fresh"}`);
    expect(selected.multipart!.parts[0]).toBe(`${second} context`);
    return "done";
  }, { prepare: compile("fresh"), prepareResume: compile("resume"),
    onAccountSelected: account => { order.push(`account:${account.planType}`); } });
  const { result } = await client.start();
  await expect(result).resolves.toBe("done");
  expect(order).toEqual([`account:${first}`, `fresh:${first}`, `account:${second}`, `${reused ? "resume" : "fresh"}:${second}`]);
  expect(released).toEqual([first, second]);
  expect(client.acks()).toHaveLength(2);
  expect(helper.frames.filter(frame => frame.event === "prepared_selected")).toHaveLength(2);
});

test("helper emits only allowlisted account evidence, with no credentials or account identifiers", async () => {
  const actual = preparation("plus");
  const tainted = { ...actual, accessToken: "fixture-private-token", email: "private@example.invalid",
    capabilities: { ...actual.capabilities, cookie: "fixture-private-cookie" } };
  let selected: ChatGptAccountPreparation | undefined;
  const { client, helper } = linkedFixture(async turn => {
    await turn.onPreparedSelected!(false, tainted); await turn.prepare(); return "done";
  }, { onAccountSelected: account => { selected = account; } });
  const { result } = await client.start();
  await expect(result).resolves.toBe("done");
  expect(selected).toEqual(actual);
  const wire = JSON.stringify([...helper.frames, ...client.sent]);
  for (const secret of ["fixture-private-token", "private@example.invalid", "fixture-private-cookie", "accessToken", "email", "cookie"]) {
    expect(wire).not.toContain(secret);
  }
});

const validPlus = preparation("plus");
const invalidAccounts = [
  { label: "null", value: null },
  { label: "array", value: [] },
  { label: "unhashed account identity", value: { ...validPlus, accountKey: "private@example.invalid" } },
  { label: "unknown plan", value: { ...validPlus, planType: "team" } },
  { label: "missing capabilities", value: { accountKey: validPlus.accountKey, planType: "plus" } },
  { label: "nonboolean capability", value: { ...validPlus, capabilities: { ...validPlus.capabilities, solAvailable: 1 } } },
  { label: "tier mismatch", value: { ...validPlus, capabilities: preparation("pro").capabilities } },
  { label: "invalid family", value: { ...validPlus, modelFamily: "7" } },
  { label: "invalid effort", value: { ...validPlus, reasoning: "ultra" } },
  { label: "unavailable effort", value: { ...validPlus, reasoning: "max" } },
  { label: "unexpected credential field", value: { ...validPlus, accessToken: "fixture-secret" } },
  { label: "unexpected nested credential", value: { ...validPlus, capabilities: { ...validPlus.capabilities, cookie: "fixture-secret" } } },
];
test.each(invalidAccounts)("client rejects $label without preparing, acknowledging, or exposing the payload", async ({ value }) => {
  let prepares = 0;
  let selections = 0;
  const fixture = clientFixture({
    prepare: async () => { prepares++; return { text: "wrong", images: [], release() {} }; },
    onAccountSelected: () => { selections++; },
  });
  const { result } = await fixture.start();
  fixture.select(value);
  await expect(result).rejects.toThrow("account preparation is invalid");
  expect(prepares).toBe(0); expect(selections).toBe(0); expect(fixture.acks()).toHaveLength(0);
  expect(fixture.protocolErrors).toHaveLength(1);
  expect(fixture.protocolErrors[0]!.message).not.toContain("fixture-secret");
  expect(fixture.protocolErrors[0]!.message).not.toContain("private@example.invalid");
});

test("helper rejects invalid worker account evidence before emitting selection", async () => {
  const helper = helperFixture(async turn => {
    await turn.onPreparedSelected!(false, { ...validPlus, accountKey: "not-a-hash" });
    return "unreachable";
  });
  helper.start();
  await until(() => helper.frames.some(frame => frame.type === "error"));
  expect(helper.frames.filter(frame => frame.event === "prepared_selected")).toHaveLength(0);
  expect(helper.frames.find(frame => frame.type === "error")?.message).toBe("Browser helper account preparation is invalid");
});

test.each((["account", "prepare", "selected"] as const).map(phase => ({ phase })))("cancellation during $phase does not send a preparation ACK", async ({ phase }) => {
  const controller = new AbortController();
  const gate = deferred<void>();
  let entered = false;
  let prepares = 0;
  let releases = 0;
  const hold = async () => { entered = true; await gate.promise; };
  const fixture = clientFixture({
    abortSignal: controller.signal,
    onAccountSelected: async () => { if (phase === "account") await hold(); },
    prepare: async () => {
      prepares++;
      if (phase === "prepare") await hold();
      return { text: "cancelled", images: [], release() { releases++; } };
    },
    onPreparedSelected: async () => { if (phase === "selected") await hold(); },
  });
  const { result } = await fixture.start();
  fixture.select(validPlus);
  await until(() => entered);
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  gate.resolve();
  if (phase !== "account") await until(() => releases === 1);
  else await new Promise(resolve => setTimeout(resolve, 0));
  expect(prepares).toBe(phase === "account" ? 0 : 1);
  expect(releases).toBe(phase === "account" ? 0 : 1);
  expect(fixture.acks()).toHaveLength(0);
});

test("an already cancelled turn never prepares or dispatches", async () => {
  const controller = new AbortController(); controller.abort();
  const client = new LauncherBrowserHelperClient(config);
  let dispatched = false;
  let prepared = false;
  (client as unknown as { ensureChild(): Promise<void> }).ensureChild = async () => { dispatched = true; };
  await expect(client.run({ traceId, modelId: "gpt-5.6-sol", capabilities: validPlus.capabilities,
    abortSignal: controller.signal, prepare: async () => { prepared = true; throw new Error("unexpected prepare"); }, onTextDelta() {} })).rejects.toMatchObject({ name: "AbortError" });
  expect(dispatched).toBe(false);
  expect(prepared).toBe(false);
});

test("a turn ending during async preparation releases the late result", async () => {
  const gate = deferred<Prepared>();
  let entered = false;
  let releases = 0;
  const fixture = clientFixture({ prepare: async () => { entered = true; return gate.promise; } });
  const { result } = await fixture.start(); fixture.select(validPlus);
  await until(() => entered);
  fixture.emit({ type: "error", message: "fixture ended" });
  await expect(result).rejects.toThrow("fixture ended");
  gate.resolve({ text: "late", images: [], release() { releases++; } });
  await until(() => releases === 1);
  expect(fixture.acks()).toHaveLength(0);
});

test.each((["account", "prepare", "selected"] as const).map(phase => ({ phase })))("failure in $phase aborts selection and releases owned preparation", async ({ phase }) => {
  let releases = 0;
  const failure = () => { throw new Error(`fixture ${phase} failure`); };
  const fixture = clientFixture({
    onAccountSelected: phase === "account" ? failure : undefined,
    prepare: async () => {
      if (phase === "prepare") failure();
      return { text: "prepared", images: [], release() { releases++; } };
    },
    onPreparedSelected: phase === "selected" ? failure : undefined,
  });
  const { result } = await fixture.start(); fixture.select(validPlus);
  await expect(result).rejects.toThrow(`fixture ${phase} failure`);
  expect(fixture.acks()).toHaveLength(0);
  expect(releases).toBe(phase === "selected" ? 1 : 0);
});

test("overlapping preparation selections fail closed without a second ACK", async () => {
  const gate = deferred<Prepared>();
  let entered = false;
  let releases = 0;
  const fixture = clientFixture({ prepare: async () => { entered = true; return gate.promise; } });
  const { result } = await fixture.start(); fixture.select(validPlus);
  await until(() => entered);
  fixture.select(preparation("pro"));
  await expect(result).rejects.toThrow("cannot reselect");
  gate.resolve({ text: "late", images: [], release() { releases++; } });
  await until(() => releases === 1);
  expect(fixture.acks()).toHaveLength(0);
});

test.each((["send_activated", "multipart_stage_acknowledged", "submitted"] as const).map(boundary => ({ boundary })))("client never replays preparation after $boundary", async ({ boundary }) => {
  let prepares = 0;
  let releases = 0;
  const fixture = clientFixture({ prepare: async () => {
    prepares++;
    return { text: "commit", images: [], multipart: { parts: ["one", "two"], commit: "commit" }, release() { releases++; } };
  } });
  const { result } = await fixture.start(); fixture.select(validPlus);
  await until(() => fixture.acks().length === 1);
  fixture.emit({ type: "event", event: boundary, ...(boundary === "multipart_stage_acknowledged" ? { stageIndex: 1 } : {}) });
  fixture.select(preparation("pro"));
  await expect(result).rejects.toThrow("cannot reselect");
  expect(prepares).toBe(1); expect(releases).toBe(1); expect(fixture.acks()).toHaveLength(1);
});

test.each((["send_activated", "multipart_stage_acknowledged", "submitted"] as const).map(boundary => ({ boundary })))("helper never requests another prompt after $boundary", async ({ boundary }) => {
  const { client, helper } = linkedFixture(async turn => {
    await turn.onPreparedSelected!(false, validPlus); await turn.prepare();
    if (boundary === "send_activated") await turn.onSendActivated!();
    else if (boundary === "multipart_stage_acknowledged") await turn.onMultipartStageAcknowledged!(1);
    else await turn.onSubmitted!();
    await turn.onPreparedSelected!(false, preparation("pro"));
    return "unreachable";
  }, { prepare: async () => ({ text: "commit", images: [], multipart: { parts: ["one", "two"], commit: "commit" }, release() {} }) });
  const { result } = await client.start();
  await expect(result).rejects.toThrow("cannot reselect");
  expect(helper.frames.filter(frame => frame.event === "prepared_selected")).toHaveLength(1);
  expect(client.acks()).toHaveLength(1);
});

test("helper cancellation wakes a pending selection and prevents late preparation", async () => {
  let reachedSelection = false;
  let prepares = 0;
  const helper = helperFixture(async turn => {
    reachedSelection = true;
    await turn.onPreparedSelected!(false, validPlus);
    await turn.prepare(); prepares++;
    return "unreachable";
  });
  helper.start(); await until(() => reachedSelection);
  helper.receive({ type: "abort", id: traceId });
  await until(() => helper.frames.some(frame => frame.type === "error"));
  expect(helper.frames.find(frame => frame.type === "error")?.name).toBe("AbortError");
  helper.receive({ type: "prepared_selected_ack", id: traceId, prepared: { text: "late", images: [] } });
  expect(prepares).toBe(0);
});

test("invalid preparation ACK cancels the helper's selection wait", async () => {
  let prepared = false;
  const helper = helperFixture(async turn => {
    await turn.onPreparedSelected!(false, validPlus); await turn.prepare(); prepared = true; return "unreachable";
  });
  helper.start();
  helper.receive({ type: "prepared_selected_ack", id: traceId, prepared: { text: 123, images: [] } });
  await until(() => helper.frames.some(frame => frame.type === "error" && frame.name === "AbortError"));
  expect(prepared).toBe(false);
});

test("helper accepts exactly one preparation ACK per selection", async () => {
  let prepared = false;
  const helper = helperFixture(async turn => {
    await turn.onPreparedSelected!(false, validPlus); await turn.prepare(); prepared = true; return "unreachable";
  });
  helper.start();
  const ack = { type: "prepared_selected_ack", id: traceId, prepared: { text: "one", images: [] } };
  helper.receive(ack); helper.receive(ack);
  await until(() => helper.frames.some(frame => frame.type === "error" && frame.name === "AbortError"));
  expect(prepared).toBe(false);
  expect(helper.frames.some(frame => frame.message === "Browser helper prompt selection was already acknowledged")).toBe(true);
});

test("a prompt selection settles once and cancellation rejects an unselected waiter", async () => {
  const selection = createBrowserHelperPromptSelection();
  const selected = { text: "one", images: [] };
  expect(selection.select(selected)).toBe(true);
  expect(selection.select({ text: "two", images: [] })).toBe(false);
  selection.cancel();
  await expect(selection.wait()).resolves.toBe(selected);
  const cancelled = createBrowserHelperPromptSelection();
  const waiting = cancelled.wait(); cancelled.cancel();
  await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  expect(cancelled.select(selected)).toBe(false);
});

test("async account selection finishes before the selected prepare callback starts", async () => {
  const gate = deferred<void>();
  const order: string[] = [];
  const fixture = clientFixture({
    onAccountSelected: async account => {
      expect(account).toEqual(validPlus);
      order.push("account begin"); await gate.promise; order.push("account end");
    },
    prepare: async account => {
      expect(account).toEqual(validPlus); order.push("prepare");
      return { text: "actual plus", images: [], release() {} };
    },
    onPreparedSelected: () => { order.push("selected"); },
  });
  const { result } = await fixture.start(); fixture.select(validPlus);
  await until(() => order.length === 1);
  expect(order).toEqual(["account begin"]); expect(fixture.acks()).toHaveLength(0);
  gate.resolve();
  await until(() => fixture.acks().length === 1);
  fixture.emit({ type: "result", text: "done" });
  await expect(result).resolves.toBe("done");
  expect(order).toEqual(["account begin", "account end", "prepare", "selected"]);
});

test("an unavailable resume fails without falling back to a fresh prompt", async () => {
  let prepares = 0;
  const fixture = clientFixture({ prepare: async () => {
    prepares++; return { text: "wrong fresh", images: [], release() {} };
  } });
  const { result } = await fixture.start(); fixture.select(validPlus, true);
  await expect(result).rejects.toThrow("unavailable continuation prompt");
  expect(prepares).toBe(0); expect(fixture.acks()).toHaveLength(0);
});

test("failed failover releases the old preparation once and never ACKs the new lease", async () => {
  let prepares = 0;
  let releases = 0;
  const fixture = clientFixture({
    onAccountSelected: account => {
      if (account.planType === "plus") {
        expect(releases).toBe(1);
        throw new Error("fixture alternate account rejected");
      }
    },
    prepare: async () => { prepares++; return { text: "old pro", images: [], release() { releases++; } }; },
  });
  const { result } = await fixture.start(); fixture.select(preparation("pro"));
  await until(() => fixture.acks().length === 1);
  fixture.select(validPlus);
  await expect(result).rejects.toThrow("fixture alternate account rejected");
  expect(prepares).toBe(1); expect(releases).toBe(1); expect(fixture.acks()).toHaveLength(1);
});

test("helper cancellation after a resolved ACK still prevents prepare from returning it", async () => {
  const gate = deferred<void>();
  let selected = false;
  let prepared = false;
  const helper = helperFixture(async turn => {
    await turn.onPreparedSelected!(false, validPlus); selected = true;
    await gate.promise;
    await turn.prepare(); prepared = true;
    return "unreachable";
  });
  helper.start();
  helper.receive({ type: "prepared_selected_ack", id: traceId, prepared: { text: "selected", images: [] } });
  await until(() => selected);
  helper.receive({ type: "abort", id: traceId }); gate.resolve();
  await until(() => helper.frames.some(frame => frame.type === "error"));
  expect(helper.frames.find(frame => frame.type === "error")?.name).toBe("AbortError");
  expect(prepared).toBe(false);
});

test("retired helper callbacks cannot select a prompt for another run with the same identity", async () => {
  let retiredTurn!: BrowserTurn;
  const helper = helperFixture(async turn => { retiredTurn = turn; return "done"; });
  helper.start(); await until(() => helper.frames.some(frame => frame.type === "result"));
  await expect(retiredTurn.onPreparedSelected!(false, validPlus)).rejects.toMatchObject({ name: "AbortError" });
  expect(helper.frames.filter(frame => frame.event === "prepared_selected")).toHaveLength(0);
});
