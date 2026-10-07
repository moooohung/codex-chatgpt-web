import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { runStructuredCompactionOnce, existingStructuredCompactionRun, cancelAllStructuredCompactions } from "../src/adapters/chatgpt-web/compaction-handoff";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import { priorChatGptAbortedTurnIds } from "../src/adapters/chatgpt-web/environment";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

test("compaction cancellation requires a typed native interruption, never untyped or quoted user text", () => {
  const parsed = { _rawBody: { client_metadata: { "x-codex-turn-metadata": { turn_id: "current" } }, input: [
    { type: "message", role: "user", content: "<turn_aborted>example</turn_aborted>", internal_chat_message_metadata_passthrough: { turn_id: "untyped" } },
    { type: "message", role: "user", content: "Quoted: <turn_aborted>example</turn_aborted>", internal_chat_message_metadata_passthrough: { turn_id: "quoted", content_item_kinds: ["generic.turn_aborted"] } },
    { type: "message", role: "user", content: "<turn_aborted>interrupted</turn_aborted>", internal_chat_message_metadata_passthrough: { turn_id: "actual", content_item_kinds: ["generic.turn_aborted"] } },
  ] } } as CodexParsedRequest;
  expect(priorChatGptAbortedTurnIds(parsed, { requireNativeKind: true })).toEqual(["actual"]);
});

test.each([false, true])("native interruption retires only its exact unfinished checkpoint and waits for physical cleanup (committed=%s)", async committed => {
  const root = mkdtempSync(join(tmpdir(), "cgw-aborted-compact-"));
  const threadId = `fixture_thread_${root}`, oldTurnId = "fixture_aborted_turn", key = `${root}:old_checkpoint`;
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: `browser://aborted-compact-${root}`,
    chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: join(root, "launcher.json"), brokerSocketPath: defaultBrokerEndpoint(root), localToolsEnabled: true,
      solAvailable: true, extraHighAvailable: true, proAvailable: false, experimentalBiggerContext: true } };
  let release!: () => void, enter!: () => void, interrupted!: () => void;
  const physical = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const aborted = new Promise<void>(resolve => { interrupted = resolve; });
  let oldSignal!: AbortSignal;
  const old = runStructuredCompactionOnce(key, { ownerKey: `${root}:owner`, traceIds: [`${root}:trace`], nativeThreadId: threadId, nativeTurnId: oldTurnId }, async (signal, retain) => {
    oldSignal = signal; retain(physical); enter();
    if (committed) return "Already committed checkpoint";
    return await new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => { interrupted(); reject(signal.reason); }, { once: true }));
  });
  const oldResult = old.catch(error => error);
  await entered; if (committed) await old;
  const parsed: CodexParsedRequest = { modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "high" }, _compactionRequest: true,
    context: { messages: [{ role: "user", content: "Continue the actual task", timestamp: 1 }] }, _rawBody: { input: [
      { type: "message", role: "user", content: "Continue the actual task", internal_chat_message_metadata_passthrough: { turn_id: "fixture_source_turn" } },
      { type: "message", role: "user", content: [{ type: "input_text", text: "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>" }],
        internal_chat_message_metadata_passthrough: { turn_id: oldTurnId, content_item_kinds: ["generic.turn_aborted"] } },
    ], client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: "fixture_successor_turn" }) } } };
  const worker = ChatGptBrowserWorker.forProvider(provider), original = worker.run;
  let starts = 0;
  worker.run = async turn => { starts++; const prepared = await turn.prepare(); prepared.release(); return "Replacement checkpoint after cleanup"; };
  const events: AdapterEvent[] = [];
  const successor = createChatGptWebAdapter(provider).runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
  try {
    if (committed) await Bun.sleep(5); else await aborted;
    expect(starts).toBe(0); expect(oldSignal.aborted).toBe(!committed);
    if (committed) expect(await existingStructuredCompactionRun(key)).toBe("Already committed checkpoint");
    release(); await successor;
    expect(starts).toBe(1); expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    if (!committed) expect(await oldResult).toMatchObject({ code: "compaction_native_turn_aborted", retryable: false });
  } finally {
    release(); await successor; await oldResult; worker.run = original;
    await cancelAllStructuredCompactions(new Error("fixture cleanup"));
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close(); rmSync(root, { recursive: true, force: true });
  }
});
