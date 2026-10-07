import { expect, test } from "bun:test";
import { planLargeContextCompaction, runLargeContextCompaction, COMPACTION_BATCH_FRAGMENTS } from "../src/adapters/chatgpt-web/large-context-compaction";
import { prepareCompactionStageTransport, COMPACTION_STAGE_PAGE_CHAR_BUDGET } from "../src/adapters/chatgpt-web/compaction-stage-transport";
import { compiledChatGptWebMessages, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { resolveChatGptWebMultipartStagingMode } from "../src/adapters/chatgpt-web/browser-worker";
import { estimateTokens } from "../src/lib/token-estimate";
import { compactionStageData } from "./fixtures/compaction-stage";
import { canonicalizeCompactionHandoff } from "../src/adapters/chatgpt-web/compaction-handoff";
import type { CodexParsedRequest } from "../src/types";

function request(chars: number): CodexParsedRequest {
  const pattern = 'Evidence file:123 original error {"status":"failed"} preserve cause\n';
  return { modelId: "gpt-5.6-sol", options: { reasoning: "xhigh" }, stream: true, _compactionRequest: true,
    context: { systemPrompt: ["Preserve verified scope, original priorities and pending work."], messages: [
      { role: "assistant", phase: "commentary", timestamp: 1, content: [{ type: "text", text: pattern.repeat(Math.ceil(chars / pattern.length)).slice(0, chars) }] },
      { role: "toolResult", toolName: "read", toolNamespace: "mcp__fixture", toolCallId: "call_original", isError: true, timestamp: 2, content: "Original failed verification; do not report success." },
      { role: "user", timestamp: 3, content: "Later correction: preserve the original model and evidence." },
    ] }, _rawBody: { input: [{ type: "message", role: "user", content: "Later correction: preserve the original model and evidence.", internal_chat_message_metadata_passthrough: { turn_id: "source_turn" } }],
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "fixture_compaction_batch", turn_id: "compact_turn" }) } } };
}

test.each([true, false])("batched %s account compaction preserves every compiled source byte, order and checkpoint with fewer summaries", async proAvailable => {
  const parsed = request(870_774), capabilities = { solAvailable: true, extraHighAvailable: true, proAvailable, localToolsEnabled: false };
  const plan = planLargeContextCompaction(parsed)!, observed: typeof plan.fragments = [], progress: any[] = [];
  let calls = 0, active = 0, maximumActive = 0;
  const checkpoint = "Verified checkpoint; preserve failure provenance, original instructions and next steps. ".repeat(55).trim();
  const summary = await runLargeContextCompaction({ parsed, plan, signal: new AbortController().signal,
    prepare: (stage, options) => prepareCompactionStageTransport(stage, capabilities, { ...options, multipart: true }),
    onProgress: event => progress.push(event), run: async (stage, prepared) => {
      maximumActive = Math.max(maximumActive, ++active);
      expect(stage.modelId).toBe(parsed.modelId); expect(stage.options).toBe(parsed.options);
      expect(stage.context.tools).toBeUndefined(); expect(prepared!.trimmedCompactionMessages).toBeUndefined();
      const data = compactionStageData(prepared!);
      expect(data.checkpoint).toBe(calls++ === 0 ? "" : checkpoint); observed.push(...data.fragments);
      const messages = compiledChatGptWebMessages(prepared!);
      expect(messages.reduce((n, text) => n + text.length, 0)).toBeLessThanOrEqual(COMPACTION_STAGE_PAGE_CHAR_BUDGET);
      for (const message of messages) { expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(110_000); if (!proAvailable) expect(message.length).toBeLessThanOrEqual(60_000); }
      expect(estimateCompiledChatGptWebInputTokens(prepared!, stage.modelId)).toBeLessThan(proAvailable ? 95_000 : 80_000);
      if (prepared!.multipart) {
        const inert = messages.slice(0, -1);
        expect(resolveChatGptWebMultipartStagingMode(stage.modelId, capabilities,
          Math.max(...inert.map(text => estimateTokens(text, stage.modelId))), Math.max(...inert.map(text => text.length))).effort).not.toBe("max");
      }
      active--; return checkpoint;
    },
  });
  expect(maximumActive).toBe(1); expect(observed).toEqual(plan.fragments);
  expect(JSON.parse(observed.map(fragment => fragment.text).join(""))).toEqual({ systemPrompt: parsed.context.systemPrompt, messages: parsed.context.messages });
  expect(calls).toBeLessThanOrEqual(Math.ceil(plan.fragments.length / COMPACTION_BATCH_FRAGMENTS) + 1);
  expect(progress.at(-1).fragmentsProcessed).toBe(plan.fragments.length);
  expect(canonicalizeCompactionHandoff(parsed, summary)).toContain('CODEX_LATEST_USER_PROMPT_JSON\n"Later correction: preserve the original model and evidence."');
}, 30_000);

test("disabled multipart retains one source fragment per summary", async () => {
  const parsed = request(120_000), plan = planLargeContextCompaction(parsed)!;
  let calls = 0;
  await runLargeContextCompaction({ parsed, plan, signal: new AbortController().signal,
    prepare: (stage, options) => prepareCompactionStageTransport(stage, { solAvailable: true, extraHighAvailable: true, proAvailable: false, localToolsEnabled: false }, { ...options, multipart: false }),
    run: async (_stage, prepared) => { expect(prepared!.multipart).toBeUndefined(); calls++; return "checkpoint"; } });
  expect(calls).toBe(plan.fragments.length);
});

test("preflight rejection or cancellation cannot submit a partial history", async () => {
  const parsed = request(120_000), plan = planLargeContextCompaction(parsed)!;
  let calls = 0;
  await expect(runLargeContextCompaction({ parsed, plan, signal: new AbortController().signal, prepare: () => undefined,
    run: async () => { calls++; return "unreachable"; } })).rejects.toMatchObject({ code: "compaction_stage_too_large", retryable: false });
  const controller = new AbortController();
  await expect(runLargeContextCompaction({ parsed, plan, signal: controller.signal, prepare: () => { controller.abort(new Error("cancel preflight")); return undefined; },
    run: async () => { calls++; return "unreachable"; } })).rejects.toThrow("cancel preflight");
  expect(calls).toBe(0);
});

test("batched text is followed by every ordered original image attachment", async () => {
  const parsed = request(120_000), images = Array.from({ length: 13 }, (_, i) => ({ type: "image" as const, imageUrl: `https://fixture.invalid/${i}.png`, detail: "high" }));
  parsed.context.messages.push({ role: "user", timestamp: 4, content: images });
  const plan = planLargeContextCompaction(parsed)!, observed: string[] = [];
  await runLargeContextCompaction({ parsed, plan, signal: new AbortController().signal,
    prepare: (stage, options) => prepareCompactionStageTransport(stage, { solAvailable: true, extraHighAvailable: true, proAvailable: true, localToolsEnabled: false }, { ...options, multipart: true }),
    run: async (_stage, prepared) => { observed.push(...prepared!.images.map(image => image.imageUrl)); return "Source and image checkpoint"; } });
  expect(observed).toEqual(images.map(image => image.imageUrl));
});
