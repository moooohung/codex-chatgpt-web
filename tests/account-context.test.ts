import { expect, test } from "bun:test";
import { isChatGptAccountPreparation, resolveChatGptAccountPreparation } from "../src/adapters/chatgpt-web/account-context";
import { resolveChatGptWebContextLimits, resolveChatGptWebTransportLimits } from "../src/chatgpt-web-models";
import { resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import type { CodexParsedRequest } from "../src/types";

const base = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: false };
const turn = { modelId: "gpt-5.6-sol", modelFamily: "6" as const, reasoning: "high", capabilities: base };

test("mixed account leases independently size GPT-6 context and physical composer budgets", () => {
  const tiers = ["plus", "pro", "prolite", "plus"] as const;
  for (const planType of tiers) {
    const actual = resolveChatGptAccountPreparation(turn, { accountKey: "a".repeat(64), planType });
    const limits = resolveChatGptWebContextLimits("gpt-5.6-sol", "high",
      { ...actual.capabilities, experimentalBiggerContext: true }, actual.modelFamily);
    expect([limits.contextWindow, limits.autoCompactTokenLimit]).toEqual(planType === "plus" ? [120_000, 110_000] : [240_000, 220_000]);
    const transport = resolveChatGptWebTransportLimits("gpt-5.6-sol", "high", actual.capabilities);
    expect(transport.browserComposerCharLimit).toBe(planType === "plus" ? 60_000 : 500_000);
    expect(base.proAvailable).toBeFalse();
    expect(actual.capabilities).not.toBe(base);
  }
});

test("Pro setup cannot grant Plus a Pro budget; Plus Pro requests use the requested 5.6 High fallback", () => {
  const actual = resolveChatGptAccountPreparation({ ...turn, reasoning: "max", capabilities: { ...base, proAvailable: true } },
    { accountKey: "b".repeat(64), planType: "plus" });
  expect(actual).toMatchObject({ modelFamily: "5.6", reasoning: "high", capabilities: { proAvailable: false } });
  const xhigh = resolveChatGptAccountPreparation({ ...turn, reasoning: "xhigh", capabilities: { ...base, extraHighAvailable: false } },
    { accountKey: "b".repeat(64), planType: "plus" });
  expect(xhigh).toMatchObject({ modelFamily: "6", reasoning: "high" });
});

test("account transport recompiles multipart losslessly with the actual account composer bound", () => {
  const input: CodexParsedRequest = { modelId: turn.modelId, _chatgptModelFamily: "6", stream: true,
    options: { reasoning: "high" }, context: { messages: Array.from({ length: 10 }, (_, i) =>
      ({ role: "user" as const, content: `record-${i} ${"word ".repeat(3200)}`, timestamp: i })) } };
  const source = structuredClone(input);
  for (const planType of ["pro", "plus"] as const) {
    const actual = resolveChatGptAccountPreparation(turn, { accountKey: "c".repeat(64), planType });
    const parts = resolveBiggerContextMultipartParts(input, actual.capabilities);
    const compiled = compileChatGptWebPrompt(input, { ...actual.capabilities, localToolsEnabled: false }, undefined,
      { experimentalMultipartParts: parts, preserveCompactionHistory: true });
    if (planType === "plus") {
      expect(compiled.multipart).toBeDefined();
      expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records)
        .map(record => record.message.content)).toEqual(input.context.messages.map(m => m.content));
      expect(compiled.multipart!.parts.every(part => part.length <= 60_000)).toBeTrue();
    } else {
      expect(compiled.multipart).toBeUndefined();
      expect(compiled.text.length).toBeLessThanOrEqual(500_000);
      expect(input.context.messages.every(m => compiled.text.includes(String(m.content)))).toBeTrue();
    }
  }
  expect(input).toEqual(source);
});

test("account evidence never grants unknown, contradictory or mismatched Free model capabilities", () => {
  const valid = resolveChatGptAccountPreparation(turn, { accountKey: "a".repeat(64), planType: "plus" });
  expect(isChatGptAccountPreparation(valid)).toBeTrue();
  for (const malformed of [null, { ...valid, planType: "enterprise" }, { ...valid, accountKey: "token" },
    { ...valid, capabilities: { ...base, proAvailable: true } }, { ...valid, reasoning: "max" }]) {
    expect(isChatGptAccountPreparation(malformed)).toBeFalse();
  }
  expect(() => resolveChatGptAccountPreparation(turn, { accountKey: "a".repeat(64), planType: "free" }))
    .toThrow("cannot run this model");
});
