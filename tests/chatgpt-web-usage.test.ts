import { expect, test } from "bun:test";
import { estimateChatGptWebInputTokens, estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import { compileChatGptWebPrompt, createChatGptWebPromptPreparation } from "../src/adapters/chatgpt-web/prompt";
import { compiledChatGptWebMessages, estimateChatGptWebImageTokens, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { assertChatGptWebMultipartInputWithinLimits, resolveChatGptWebMultipartStagingMode } from "../src/adapters/chatgpt-web/browser-worker";
import { estimateTokens } from "../src/lib/token-estimate";
import type { CodexParsedRequest } from "../src/types";
import { resolveChatGptWebMessageTokenBudget, resolveChatGptWebStagingTokenBudget } from "../src/chatgpt-web-models";

const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };

function request(text: string): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: false,
    context: { messages: [{ role: "user", content: text, timestamp: 1 }] },
    options: { reasoning: "high" },
  };
}

test("request preparation reuse preserves the complete multipart prompt and usage accounting", () => {
  const parsed = request("");
  parsed.context.messages = Array.from({ length: 12 }, (_, index) => ({
    role: "user", timestamp: index + 1, content: `${index}: ${"한글 😀 word ".repeat(1_000)}`,
  }));
  for (const caps of [capabilities, { ...capabilities, proAvailable: false }]) {
    const preparation = createChatGptWebPromptPreparation(parsed);
    const parts = resolveBiggerContextMultipartParts(parsed, caps, false, preparation);
    expect(parts).toBe(resolveBiggerContextMultipartParts(parsed, caps));
    const shared = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: parts, preparation });
    const independent = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: parts });
    expect(shared).toEqual(independent);
    const expected = estimateCompiledChatGptWebInputTokens(independent, parsed.modelId);
    expect(estimateChatGptWebInputTokens(parsed, caps, { experimentalMultipartParts: parts, preparation })).toBe(expected);
    const usage = estimateChatGptWebUsage(parsed, { answer: "done" }, caps, true);
    expect(usage.inputTokens).toBe(expected);
    expect(usage.totalTokens).toBe(expected + usage.outputTokens!);
  }
}, 15_000);

test("another request cannot reuse a multipart preparation or its token counts", () => {
  const first = request("original task");
  const second = request("new task");
  const preparation = createChatGptWebPromptPreparation(first);
  expect(() => resolveBiggerContextMultipartParts(second, capabilities, false, preparation)).toThrow(/another request/);
  expect(() => estimateChatGptWebInputTokens(second, capabilities, { preparation })).toThrow(/another request/);
});

test.each([
  ["highly compressible", "a".repeat(480_000)],
  ["ordinary repeated words", `${"word ".repeat(79_999)}word`],
])("%s context uses tokenizer-derived usage without character-pressure inflation", (_label, text) => {
  expect(estimateChatGptWebInputTokens(request(text), capabilities)).toBeLessThan(100_000);
}, 15_000);

test("multipart selection accounts for whole-record and composer fit before submission", () => {
  const plus = { ...capabilities, extraHighAvailable: false, proAvailable: false };
  for (const [contents, expected] of [
    [["small task"], undefined],
    [Array.from({ length: 6 }, () => `${"word ".repeat(5_000)}end`), 4],
    [Array.from({ length: 3 }, () => `start${" ".repeat(45_000)}end`), 4],
  ] as const) {
    const parsed = request("");
    parsed.context.messages = contents.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
    const parts = resolveBiggerContextMultipartParts(parsed, plus);
    expect(parts).toBe(expected);
    const compiled = compileChatGptWebPrompt(parsed, plus, undefined, { experimentalMultipartParts: parts });
    if (parts) {
      expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
        .toEqual([...contents]);
    }
  }
  // Low-token text can still exceed the reasoning model's server character ceiling.
  // Stage the complete record instead of sending it inline or dropping its contents.
  const sparsePro = request("x".repeat(600_000));
  expect(resolveBiggerContextMultipartParts(sparsePro, capabilities)).toBe(2);
  const stagedPro = compileChatGptWebPrompt(sparsePro, capabilities, undefined, { experimentalMultipartParts: 2 });
  expect(stagedPro.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
    .toEqual([sparsePro.context.messages[0]!.content]);
  const proMessages = compiledChatGptWebMessages(stagedPro);
  expect(proMessages[1]!.length).toBeLessThanOrEqual(500_000);
  expect(resolveChatGptWebMultipartStagingMode(
    "gpt-5.6-sol", capabilities, estimateTokens(proMessages[0]!), proMessages[0]!.length,
  ).effort).toBe("max");
}, 60_000);

test("Bigger Context compaction chooses the fewest complete parts and supports legacy rollback", () => {
  const parsed = request("x".repeat(160_000));
  parsed._compactionRequest = true;
  const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
  expect(parts).toBe(2);
  expect(resolveBiggerContextMultipartParts(parsed, capabilities, false, undefined, false)).toBe(6);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: parts });
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
    .toEqual([parsed.context.messages[0]!.content]);
});

test("small compaction uses one complete inline message without acknowledgements or trimming", () => {
  const parsed = request("Keep every constraint and checkpoint");
  parsed.context.messages.unshift({ role: "user", content: "Earlier Korean evidence 한글 😀", timestamp: 0 });
  parsed._compactionRequest = true;
  expect(resolveBiggerContextMultipartParts(parsed, capabilities)).toBeUndefined();
  expect(resolveBiggerContextMultipartParts(parsed, capabilities, false, undefined, false)).toBe(6);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { preserveCompactionHistory: true });
  expect(compiled.multipart).toBeUndefined();
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.text).toContain("Earlier Korean evidence 한글 😀");
  expect(compiled.text).toContain("Keep every constraint and checkpoint");
});

test("inline compaction planning checks UTF-8 JSON bytes before choosing one message", () => {
  const parsed = request("\u0800".repeat(37_000));
  parsed._compactionRequest = true;
  const caps = { ...capabilities, proAvailable: false };
  const parts = resolveBiggerContextMultipartParts(parsed, caps);
  expect(parts).toBeDefined();
  const compiled = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: parts });
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
    .toEqual([parsed.context.messages[0]!.content]);
});
test("Plus history is rebalanced into smaller Instant uploads and a larger selected-mode final message", () => {
  const plus = { ...capabilities, proAvailable: false, extraHighAvailable: false };
  const parsed = request("");
  parsed.context.messages = Array.from({ length: 18 }, (_, index) => ({
    // Expensive Unicode tokens exercise the new token headroom while preserving our
    // conservative 60k-character server limit and complete semantic records.
    role: "user", content: `record-${index}: ${"뷁".repeat(1500)}`, timestamp: index + 1,
  }));
  for (const compaction of [false, true]) {
    parsed._compactionRequest = compaction;
    const compiled = compileChatGptWebPrompt(parsed, plus, undefined, { experimentalMultipartParts: 6 });
    const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
    expect(records.map(record => record.message.content)).toEqual(parsed.context.messages.map(message => message.content));
    expect(compiled.trimmedCompactionMessages).toBeUndefined();
    const messages = compiledChatGptWebMessages(compiled);
    const stagingTokens = messages.slice(0, -1).map(text => estimateTokens(text));
    const stagingBudget = resolveChatGptWebStagingTokenBudget("gpt-5.6-sol", "low", plus);
    expect(Math.max(...stagingTokens)).toBeLessThanOrEqual(stagingBudget);
    expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", plus,
      Math.max(...stagingTokens), Math.max(...messages.slice(0, -1).map(text => text.length))).effort).toBe("low");
    const finalTokens = estimateTokens(messages.at(-1)!);
    expect(finalTokens).toBeGreaterThan(Math.max(...stagingTokens));
    expect(finalTokens).toBeLessThanOrEqual(resolveChatGptWebMessageTokenBudget("gpt-5.6-sol", "high", plus));
  }
}, 30_000);

test("multipart planning leaves room for final attachments and execution instructions without losing history", () => {
  for (const scenario of [
    { extraHighAvailable: false, proAvailable: false, images: 3, schema: false },
    { extraHighAvailable: true, proAvailable: true, images: 10, schema: false },
    { extraHighAvailable: false, proAvailable: false, images: 0, schema: true },
  ]) {
    const caps = { ...capabilities, proAvailable: scenario.proAvailable };
    const parsed = request("");
    const texts = Array.from({ length: 18 }, (_, index) => `record ${index}: ${"word ".repeat(5_000)}end`);
    parsed.context.messages = texts.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
    const images = Array.from({ length: scenario.images }, (_, index) => ({
      type: "image" as const, imageUrl: `data:image/png;base64,partition-image-${index}`, detail: "original" as const,
    }));
    if (images.length) parsed.context.messages.push({ role: "user", content: images, timestamp: 37 });
    if (scenario.schema) parsed.options.outputFormat = {
      type: "json_schema", name: "result", strict: true, schema: { type: "string", description: "schema ".repeat(5_000) },
    };
    const parts = resolveBiggerContextMultipartParts(parsed, caps)!;
    const compiled = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: parts });
    const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
    expect(records.map(record => record.message_index)).toEqual(parsed.context.messages.map((_, index) => index));
    expect(records.slice(0, texts.length).map(record => record.message.content)).toEqual(texts);
    expect(compiled.images.map(image => ({ imageUrl: image.imageUrl, detail: image.detail })))
      .toEqual(images.map(image => ({ imageUrl: image.imageUrl, detail: image.detail })));
    if (scenario.schema) expect(compiled.multipart!.commit).toContain(JSON.stringify(parsed.options.outputFormat!.schema));
    const messages = compiledChatGptWebMessages(compiled);
    const tokens = messages.map(text => estimateTokens(text));
    const chars = messages.map(text => text.length);
    const maxStageMessageTokens = Math.max(...tokens.slice(0, -1));
    const maxStageChars = Math.max(...chars.slice(0, -1));
    const stage = resolveChatGptWebMultipartStagingMode(parsed.modelId, caps, maxStageMessageTokens, maxStageChars);
    expect(() => assertChatGptWebMultipartInputWithinLimits(
      estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId), Math.max(...tokens),
      parsed.modelId, "high", caps, Math.max(...chars), parts,
      { stagingEffort: stage.effort, maxStageMessageTokens, maxStageChars, finalMessageTokens: tokens.at(-1)!, finalMessageChars: chars.at(-1)!, finalImageTokens: estimateChatGptWebImageTokens(compiled) },
    )).not.toThrow();
  }
}, 30_000);
