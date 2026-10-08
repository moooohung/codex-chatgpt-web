import { expect, test } from "bun:test";
import { runWithChatGptPlusPreparation } from "../src/adapters/chatgpt-web/account-fallback";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import { compiledChatGptWebMessages } from "../src/adapters/chatgpt-web/input-tokens";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: true, extraHighAvailable: true };
const reprepare = (family = "56") => new ChatGptWebAdapterError("Confirmed Plus preparation required", {
  status: 409, errorType: "invalid_request_error", code: `chatgpt_plus_reprepare_${family}_high`, retryable: false,
});
const turn = (): BrowserTurn => ({ traceId: "fixture-plus", modelId: "gpt-5.6-sol", reasoning: "max", modelFamily: "6", capabilities,
  prepare: async () => ({ text: "original", images: [], release() {} }), onTextDelta() {},
});

test.each([ ["56", "5.6"], ["6", "6"] ] as const)("unsent Plus %s fallback rebuilds preparation once with family %s/High", async (code, family) => {
  const original = turn(); let runs = 0, preparations = 0;
  const result = await runWithChatGptPlusPreparation({ run: async current => {
    runs++;
    if (runs === 1) throw reprepare(code);
    expect(current.reasoning).toBe("high"); expect(current.modelFamily).toBe(family);
    expect(current.capabilities).toMatchObject({ proAvailable: false, extraHighAvailable: false });
    expect((await current.prepare()).text).toBe("rebuilt");
    return "done";
  } }, original, async (override, resume) => {
    preparations++; expect(resume).toBeFalse(); expect(override.modelFamily).toBe(family);
    return { text: "rebuilt", images: [], release() {} };
  });
  expect(result).toBe("done"); expect(runs).toBe(2); expect(preparations).toBe(1);
  expect(original.reasoning).toBe("max"); expect(original.modelFamily).toBe("6"); expect(original.capabilities).toBe(capabilities);
});

test.each(["activation", "ack"])("Plus preparation never replays after %s", async boundary => {
  let runs = 0; const original = turn(); let forwarded = 0;
  original.onSendActivated = () => { forwarded++; };
  original.onMultipartStageAcknowledged = index => { expect(index).toBe(1); forwarded++; };
  const error = reprepare();
  await expect(runWithChatGptPlusPreparation({ run: async current => {
    runs++;
    if (boundary === "activation") await current.onSendActivated?.();
    else await current.onMultipartStageAcknowledged?.(1);
    throw error;
  } }, original, async () => { throw new Error("must not reprepare"); })).rejects.toBe(error);
  expect(runs).toBe(1); expect(forwarded).toBe(1);
});

test("a second Plus preparation failure propagates without looping", async () => {
  let runs = 0; const error = reprepare();
  await expect(runWithChatGptPlusPreparation({ run: async () => { runs++; throw error; } }, turn(), async () => ({ text: "rebuilt", images: [], release() {} }))).rejects.toBe(error);
  expect(runs).toBe(2);
});

test("cancellation or an unrelated failure cannot start Plus preparation", async () => {
  for (const cancelled of [false, true]) {
    const original = turn(); const controller = new AbortController(); original.abortSignal = controller.signal;
    const error = cancelled ? reprepare() : new ChatGptWebAdapterError("Observation failed", {
      status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true,
    });
    let runs = 0;
    await expect(runWithChatGptPlusPreparation({ run: async () => {
      runs++; if (cancelled) controller.abort(); throw error;
    } }, original, async () => { throw new Error("must not reprepare"); })).rejects.toBeDefined();
    expect(runs).toBe(1);
  }
});

test("Plus recompile respects composer limits and preserves all multipart records", async () => {
  const source: CodexParsedRequest = { modelId: "gpt-5.6-sol", _chatgptModelFamily: "6", stream: true,
    options: { reasoning: "max" }, context: { messages: Array.from({ length: 12 }, (_, i) => ({ role: "user" as const, content: `record-${i} ${"word ".repeat(4000)}`, timestamp: i })) },
  };
  const original = structuredClone(source); let runs = 0;
  await runWithChatGptPlusPreparation({ run: async current => {
    if (++runs === 1) throw reprepare("56");
    const prepared = await current.prepare();
    expect(prepared.multipart).toBeDefined();
    expect(compiledChatGptWebMessages(prepared).every(text => text.length <= 60_000)).toBeTrue();
    expect(prepared.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content)).toEqual(source.context.messages.map(m => m.content));
    return "done";
  } }, turn(), async override => {
    const input = { ...source, _chatgptModelFamily: override.modelFamily, options: { ...source.options, reasoning: override.reasoning } };
    const parts = resolveBiggerContextMultipartParts(input, override.capabilities);
    const compiled = compileChatGptWebPrompt(input, override.capabilities, undefined, { experimentalMultipartParts: parts });
    return { ...compiled, release() {} };
  });
  expect(source).toEqual(original); expect(runs).toBe(2);
});
