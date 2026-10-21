import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, resolveBrowserConfig, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import { extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { chatGptWebExecutionNamespace, chatGptWebTraceId, createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import {
  ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions, chatGptInstructionLineage,
  chatGptThreadOwnershipKey, chatGptTurnExecutionKey, chatGptTurnRoundKey, chatGptTurnSessions,
  type ChatGptTurnRuntime,
} from "../src/adapters/chatgpt-web/turn-execution";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { defaultBrokerEndpoint } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

function provider(enabled: boolean): CodexProviderConfig {
  const root = join(tmpdir(), `cgw-approval-identity-${randomUUID()}`);
  return {
    adapter: "chatgpt-web", baseUrl: "https://chatgpt.com",
    chatgptWeb: {
      appName: "Codex app", browserHost: "launcher", browserInteractionMode: "automatic",
      browserHostDescriptorPath: join(root, "launcher.json"), storageStatePath: join(root, "account.json"),
      brokerSocketPath: defaultBrokerEndpoint(root), localToolsEnabled: true,
      solAvailable: true, extraHighAvailable: true, proAvailable: true,
      autoApproveToolCalls: enabled,
    },
  };
}

function toggled(original: CodexProviderConfig): CodexProviderConfig {
  return { ...original, chatgptWeb: { ...original.chatgptWeb, autoApproveToolCalls: !original.chatgptWeb!.autoApproveToolCalls } };
}

function request(threadId = "thread_live_approval", turnId = "turn_live_approval", toolResult = false): CodexParsedRequest {
  return parseRequest({
    model: CHATGPT_WEB_MODEL_ID, stream: true, reasoning: { effort: "high" },
    prompt_cache_key: threadId,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }) },
    input: [
      { type: "message", id: "instruction_live_approval", role: "user",
        content: [{ type: "input_text", text: "Inspect the project" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId } },
      ...(toolResult ? [
        { type: "function_call", call_id: "call_live_approval", name: "exec_command", arguments: '{"cmd":"pwd"}' },
        { type: "function_call_output", call_id: "call_live_approval", output: "offline fixture result" },
      ] : []),
    ],
  });
}

function identity(config: CodexProviderConfig, parsed: CodexParsedRequest) {
  const namespace = chatGptWebExecutionNamespace(config);
  return {
    namespace,
    execution: `${namespace}:${chatGptTurnExecutionKey(parsed)}`,
    owner: `${namespace}:${chatGptThreadOwnershipKey(parsed)}`,
    conversation: chatGptConversationKey(parsed, namespace),
    trace: chatGptWebTraceId(config, parsed),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle within 2000ms`)), 2000);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

for (const enabled of [false, true]) {
  test(`approval toggle from ${enabled} preserves namespace, execution, trace, owner and conversation identity`, () => {
    const before = provider(enabled);
    const after = toggled(before);
    const first = request();
    const result = request(undefined, undefined, true);
    expect(identity(after, first)).toEqual(identity(before, first));
    expect(identity(after, result)).toEqual(identity(before, first));
    // The tool result changes the round journal, while remaining in its original physical execution.
    expect(chatGptTurnRoundKey(result)).not.toBe(chatGptTurnRoundKey(first));
    const compact = { ...first, _compactionRequest: true };
    expect(identity(after, compact)).toEqual(identity(before, compact));
    // Identity stability must not erase the policy passed to a newly created worker.
    expect(resolveBrowserConfig(before).autoApproveToolCalls).toBe(enabled);
    expect(resolveBrowserConfig(after).autoApproveToolCalls).toBe(!enabled);
  });
}

const securityChanges: Array<[string, (config: CodexProviderConfig) => void]> = [
  ["account storage", config => { config.chatgptWeb!.storageStatePath += ".other-account"; }],
  ["browser owner descriptor", config => { config.chatgptWeb!.browserHostDescriptorPath += ".other-owner"; }],
  ["browser host", config => { config.chatgptWeb!.browserHost = "managed-chrome"; }],
  ["interaction mode", config => { config.chatgptWeb!.browserInteractionMode = "manual"; }],
  ["connector identity", config => { config.chatgptWeb!.appName = "Other connector"; }],
  ["broker endpoint", config => { config.chatgptWeb!.brokerSocketPath += "-other"; }],
  ["local tool authority", config => { config.chatgptWeb!.localToolsEnabled = false; }],
  ["account capability", config => { config.chatgptWeb!.proAvailable = false; }],
  ["provider origin", config => { config.baseUrl = "https://other.invalid"; }],
];

for (const [name, change] of securityChanges) {
  test(`approval identity exclusion retains the ${name} boundary`, () => {
    const before = provider(false);
    const after = toggled(before);
    change(after);
    const original = identity(before, request());
    const changed = identity(after, request());
    for (const key of ["namespace", "execution", "owner", "conversation", "trace"] as const) {
      expect(changed[key]).not.toBe(original[key]);
    }
  });
}

for (const enabled of [false, true]) {
  test(`registry reconnect and tool-result replay retain the ${enabled} runtime policy after toggle`, async () => {
    const before = provider(enabled);
    const after = toggled(before);
    const firstRequest = request();
    const firstIdentity = identity(before, firstRequest);
    const sessions = new ChatGptTurnSessions();
    const browser = deferred<string>();
    const physical = deferred<void>();
    const policies: boolean[] = [];
    const start = (config: CodexProviderConfig): ChatGptTurnRuntime & { approvalPolicy: boolean } => {
      const approvalPolicy = resolveBrowserConfig(config).autoApproveToolCalls;
      policies.push(approvalPolicy);
      return {
        mode: "tools", approvalPolicy, token: Promise.resolve("offline-fixture-only"),
        externalProgress: new ChatGptExternalTurnProgress(), browser: browser.promise,
        physicalSettlement: physical.promise, trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
        conversationKey: identity(config, firstRequest).conversation,
        cancel() { browser.resolve("offline cancelled"); physical.resolve(); },
      };
    };
    const attach = (config: CodexProviderConfig, parsed: CodexParsedRequest) => {
      const current = identity(config, parsed);
      const native = extractChatGptTurnIdentity(parsed);
      return within(sessions.getOrCreateAfterOwnerRetirement(current.execution, current.owner,
        () => start(config), current.trace, undefined, native.turnId, native.threadId,
        chatGptInstructionLineage(parsed)), "offline registry attachment");
    };
    const first = await attach(before, firstRequest);
    first.setOutstanding([{ callId: "call_live_approval", wireName: "exec_command", freeform: false, arguments: { cmd: "pwd" } }]);
    try {
      const reconnected = await attach(after, structuredClone(firstRequest));
      const resultRound = await attach(after, request(undefined, undefined, true));
      expect(reconnected).toBe(first);
      expect(resultRound).toBe(first);
      expect(resultRound.runtime).toBe(first.runtime);
      expect((resultRound.runtime as ReturnType<typeof start>).approvalPolicy).toBe(enabled);
      expect(resultRound.conversationKey()).toBe(firstIdentity.conversation);
      expect(resultRound.outstanding()).toEqual(first.outstanding());
      resultRound.markResultDelivered("call_live_approval");
      expect(reconnected.outstanding()).toEqual([]);
      expect(() => reconnected.markResultDelivered("call_live_approval")).toThrow("does not match an outstanding call");
      expect(policies).toEqual([enabled]);
      browser.resolve("offline complete");
      physical.resolve();
      await first.physicalSettlement;
      await first.browserOutcome;
      const next = await attach(after, request(undefined, "turn_live_approval_next"));
      expect(next).not.toBe(first);
      expect((next.runtime as ReturnType<typeof start>).approvalPolicy).toBe(!enabled);
      expect(policies).toEqual([enabled, !enabled]);
    } finally {
      browser.resolve("offline cleanup"); physical.resolve(); sessions.clear();
    }
  });
}

test("actual adapters reconnect after an approval toggle without a second browser run", async () => {
  const threadId = `thread_live_approval_${randomUUID()}`;
  const turnId = `turn_live_approval_${randomUUID()}`;
  const before = provider(false);
  before.chatgptWeb = { ...before.chatgptWeb, browserHost: "managed-chrome", localToolsEnabled: false };
  delete before.chatgptWeb.browserHostDescriptorPath;
  const after = toggled(before);
  const oldWorker = ChatGptBrowserWorker.forProvider(before);
  const newWorker = ChatGptBrowserWorker.forProvider(after);
  expect(newWorker).not.toBe(oldWorker);
  const oldRun = oldWorker.run;
  const newRun = newWorker.run;
  const started = deferred<void>();
  const finish = deferred<string>();
  const policies: boolean[] = [];
  const abort = new AbortController();
  const firstEvents: AdapterEvent[] = [];
  const replayEvents: AdapterEvent[] = [];
  oldWorker.run = async (turn: BrowserTurn) => {
    policies.push(resolveBrowserConfig(before).autoApproveToolCalls);
    started.resolve();
    const answer = await finish.promise;
    turn.onTextDelta(answer);
    return answer;
  };
  newWorker.run = async () => { policies.push(resolveBrowserConfig(after).autoApproveToolCalls); return "duplicate browser run"; };
  const first = createChatGptWebAdapter(before).runTurn!(request(threadId, turnId), { headers: new Headers(), abortSignal: abort.signal }, event => firstEvents.push(event));
  let replay: Promise<void> | undefined;
  try {
    await within(Promise.race([started.promise, first.then(() => {
      throw new Error("Offline adapter ended before the mocked browser started");
    })]), "offline browser start");
    replay = createChatGptWebAdapter(after).runTurn!(request(threadId, turnId), { headers: new Headers(), abortSignal: abort.signal }, event => replayEvents.push(event));
    finish.resolve("offline complete");
    await within(Promise.all([first, replay]), "offline adapter replay");
    expect(policies).toEqual([false]);
    for (const events of [firstEvents, replayEvents]) {
      expect(events.flatMap(event => event.type === "text_delta" && event.phase === "final_answer" ? [event.text] : []).join("")).toBe("offline complete");
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    }
  } finally {
    finish.resolve("offline cleanup");
    abort.abort(new Error("offline fixture cleanup"));
    try {
      await within(Promise.allSettled([first, ...(replay ? [replay] : [])]), "offline adapter cleanup");
    } finally {
      oldWorker.run = oldRun; newWorker.run = newRun;
      await within(chatGptTurnSessions.cancelNativeTurn(threadId, turnId, new Error("offline fixture cleanup")).settlement,
        "offline registry cleanup");
    }
  }
}, 10_000);
