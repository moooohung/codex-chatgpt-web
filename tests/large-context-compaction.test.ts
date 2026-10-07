import { expect, test } from "bun:test";
import { planLargeContextCompaction, runLargeContextCompaction, splitCompactionSource, COMPACTION_CHUNK_JSON_BYTES } from "../src/adapters/chatgpt-web/large-context-compaction";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { canonicalizeCompactionHandoff } from "../src/adapters/chatgpt-web/compaction-handoff";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: false };
function request(chars = 1200000): CodexParsedRequest {
  return { modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "xhigh" }, _compactionRequest: true,
    context: { systemPrompt: ["Keep instruction priorities and evidence provenance."], messages: [
      { role: "user", origin: "codex_skill", content: "Original skill metadata", timestamp: 1 },
      { role: "assistant", phase: "commentary", content: [{ type: "text", text: "evidence한글😀\n".repeat(Math.ceil(chars / 13)).slice(0, chars) }], timestamp: 2 },
      { role: "toolResult", toolName: "read", toolNamespace: "mcp__fixture", toolCallId: "call_fixture", isError: true, content: "Original failed check", timestamp: 3 },
      { role: "user", content: "Continue the original task without changing models.", timestamp: 4 },
    ] }, _rawBody: { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue the original task without changing models." }], internal_chat_message_metadata_passthrough: { turn_id: "fixture_source" } }],
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "fixture_large_context", turn_id: "fixture_compact" }) } } };
}

test("large staged compaction preserves all source roles, metadata and Unicode while keeping each real compiled prompt bounded", async () => {
  const parsed = request(), plan = planLargeContextCompaction(parsed)!;
  const source = plan.fragments.map(f => f.text).join("");
  expect(JSON.parse(source)).toEqual({ systemPrompt: parsed.context.systemPrompt, messages: parsed.context.messages });
  const observed: string[] = [], sizes: number[] = [];
  let active = 0, maximumActive = 0;
  const summary = await runLargeContextCompaction({ parsed, plan, signal: new AbortController().signal, run: async stage => {
    expect(stage.modelId).toBe(parsed.modelId); expect(stage.options).toBe(parsed.options);
    expect(stage._compactionRequest).toBe(true); expect(stage.context.tools).toBeUndefined();
    maximumActive = Math.max(maximumActive, ++active);
    const compiled = compileChatGptWebPrompt(stage, capabilities, undefined, { preserveCompactionHistory: true });
    expect(compiled.multipart).toBeUndefined(); expect(compiled.trimmedCompactionMessages).toBeUndefined();
    const size = Buffer.byteLength(JSON.stringify(compiled.text)); sizes.push(size); expect(size).toBeLessThan(110000);
    const text = stage.context.messages[0]!.content as string;
    const payload = JSON.parse(text.split("<codex_compaction_stage_json>\n")[1]!.split("\n</codex_compaction_stage_json>")[0]!);
    expect(payload.offset).toBe(observed.join("").length); observed.push(payload.fragment);
    expect(payload.previous_checkpoint).toBe(observed.length === 1 ? "" : "Verified cumulative checkpoint");
    active--; return "Verified cumulative checkpoint";
  } });
  expect(maximumActive).toBe(1); expect(observed.join("")).toBe(source);
  expect(canonicalizeCompactionHandoff(parsed, summary)).toContain('CODEX_LATEST_USER_PROMPT_JSON\n"Continue the original task without changing models."');
});

test.each([31.8, 30.2])("synthetic %s MiB context has exact complete coverage without a huge browser message", mib => {
  const size = Math.ceil(mib * 1048576), pattern = "state file:123 commit:abc result=verified\n";
  const source = pattern.repeat(Math.ceil(size / pattern.length)).slice(0, size);
  expect(Buffer.byteLength(source)).toBe(size);
  const fragments = splitCompactionSource(source);
  expect(fragments.map(f => f.text).join("")).toBe(source);
  let offset = 0;
  for (const fragment of fragments) {
    expect(fragment.offset).toBe(offset); offset += fragment.text.length;
    expect(Buffer.byteLength(JSON.stringify(fragment.text))).toBeLessThanOrEqual(COMPACTION_CHUNK_JSON_BYTES);
    expect(/[\uD800-\uDBFF]$/.test(fragment.text)).toBe(false);
    expect(/^[\uDC00-\uDFFF]/.test(fragment.text)).toBe(false);
  }
  expect(offset).toBe(source.length);
}, 30000);

test("historical images remain actual ordered attachments, and image-like tool arguments remain literal data", async () => {
  const parsed = request(100000);
  parsed.context.messages.push({ role: "assistant", timestamp: 5, content: [{ type: "toolCall", id: "call_2", name: "test", arguments: { type: "image", imageUrl: "literal_argument" } }] });
  const images = Array.from({ length: 13 }, (_, i) => ({ type: "image" as const, imageUrl: `https://fixture.invalid/${i}.png`, detail: "high" }));
  parsed.context.messages.push({ role: "user", timestamp: 6, content: images });
  const plan = planLargeContextCompaction(parsed)!;
  expect(plan.images).toEqual(images); expect(plan.fragments.map(f => f.text).join("")).toContain("literal_argument");
  expect(plan.fragments.map(f => f.text).join("")).not.toContain("https://fixture.invalid");
  const actual: unknown[] = [];
  await runLargeContextCompaction({ parsed, plan, signal: new AbortController().signal, run: async stage => {
    const content = stage.context.messages[0]!.content;
    if (Array.isArray(content)) { expect(content.length).toBeLessThanOrEqual(11); actual.push(...content.slice(1)); }
    return "Image evidence and source checkpoint";
  } });
  expect(actual).toEqual(images);
});

test("cancellation and oversized/empty summaries cannot advance or commit a partial checkpoint", async () => {
  const parsed = request(120000), plan = planLargeContextCompaction(parsed)!;
  for (const answer of ["", "x".repeat(24001)]) {
    let calls = 0;
    await expect(runLargeContextCompaction({ parsed, plan, signal: new AbortController().signal, run: async () => { calls++; return answer; } })).rejects.toMatchObject({ retryable: false });
    expect(calls).toBe(1);
  }
  const controller = new AbortController(); let calls = 0;
  await expect(runLargeContextCompaction({ parsed, plan, signal: controller.signal, run: async () => { calls++; controller.abort(new Error("cancel fixture")); return "Partial checkpoint"; } })).rejects.toThrow("cancel fixture");
  expect(calls).toBe(1);
  expect(planLargeContextCompaction({ ...parsed, _compactionRequest: false })).toBeUndefined();
  expect(planLargeContextCompaction(request(10))).toBeUndefined();
});

test("escape-heavy source and checkpoints include all three browser JSON escaping layers in their budgets", async () => {
  const parsed = request(100000);
  parsed.context.messages[1]!.content = "\"\\\u0000\n😀".repeat(25000);
  const plan = planLargeContextCompaction(parsed)!;
  const checkpoint = "\"\\\u0000\n".repeat(400);
  await runLargeContextCompaction({ parsed, plan, signal: new AbortController().signal, run: async stage => {
    const compiled = compileChatGptWebPrompt(stage, capabilities, undefined, { preserveCompactionHistory: true });
    expect(compiled.trimmedCompactionMessages).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(compiled.text))).toBeLessThan(110000);
    return checkpoint;
  } });
});
