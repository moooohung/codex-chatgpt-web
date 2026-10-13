import { expect, spyOn, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { resolveChatGptAccountPreparation } from "../src/adapters/chatgpt-web/account-context";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent } from "../src/types";
import { compiledChatGptWebMessages } from "../src/adapters/chatgpt-web/input-tokens";
import { COMPACTION_STAGE_PAGE_CHAR_BUDGET } from "../src/adapters/chatgpt-web/compaction-stage-transport";
import { planLargeContextCompaction } from "../src/adapters/chatgpt-web/large-context-compaction";
import { compactionStageData } from "./fixtures/compaction-stage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

test("adapter recomputes unsent Pro-to-Plus transport without changing the next lease's capabilities", async () => {
  const prepared: Array<{ plan: string; multipart: boolean }> = [];
  const run = spyOn(ChatGptBrowserWorker.prototype, "run").mockImplementation(async turn => {
    const initial = { ...turn.capabilities };
    for (const planType of ["pro", "plus"] as const) {
      const account = resolveChatGptAccountPreparation(turn, { accountKey: "a".repeat(64), planType });
      await turn.onAccountSelected?.(account);
      expect(turn.capabilities).toEqual(initial);
      expect(account.capabilities.extraHighAvailable).toBe(planType === "pro");
      const prompt = await turn.prepare(account);
      prepared.push({ plan: planType, multipart: !!prompt.multipart });
      if (prompt.multipart) expect(prompt.multipart.parts.every(part => part.length <= 60_000)).toBeTrue();
      prompt.release();
    }
    turn.onTextDelta?.("offline fixture complete");
    return "offline fixture complete";
  });
  const adapter = createChatGptWebAdapter({ adapter: "chatgpt-web", baseUrl: `browser://account-context-adapter-${Date.now()}`,
    chatgptWeb: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false,
      experimentalBiggerContext: true, experimentalMinimalContextTransport: true } });
  const parsed = parseRequest({ model: "gpt-5.6-sol", reasoning: { effort: "high" },
    input: Array.from({ length: 8 }, (_, index) => ({ type: "message", role: "user",
      content: [{ type: "input_text", text: `${index}: ` + "word ".repeat(3_200) }],
      internal_chat_message_metadata_passthrough: { turn_id: "account-context-turn" } })),
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "account-context-adapter", turn_id: "account-context-turn" }) } });
  parsed._chatgptModelFamily = "6";
  const events: AdapterEvent[] = [];
  try {
    await adapter.runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
    expect(events.filter(event => event.type === "error")).toHaveLength(0);
    expect(prepared).toEqual([{ plan: "pro", multipart: false }, { plan: "plus", multipart: true }]);
    expect(events.filter(event => event.type === "response_metadata").at(-1)).toMatchObject({
      metadata: { chatgpt_account_plan: "plus", chatgpt_context_window: "120000", chatgpt_auto_compact_token_limit: "110000" },
    });
  } finally { run.mockRestore(); }
});

test.each(["plus", "pro"] as const)("actual %s account preserves complete bounded staged compaction transport", async planType => {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-account-stage-"));
  const brokerSocketPath = defaultBrokerEndpoint(root);
  const fragments: Array<{ offset: number; text: string }> = [];
  let multipartStages = 0;
  const run = spyOn(ChatGptBrowserWorker.prototype, "run").mockImplementation(async turn => {
    const account = resolveChatGptAccountPreparation(turn, { accountKey: "a".repeat(64), planType });
    await turn.onAccountSelected?.(account);
    const prompt = await turn.prepare(account);
    const messages = compiledChatGptWebMessages(prompt);
    expect(messages.reduce((sum, text) => sum + text.length, 0)).toBeLessThanOrEqual(COMPACTION_STAGE_PAGE_CHAR_BUDGET);
    expect(messages.every(text => Buffer.byteLength(JSON.stringify(text)) <= 110_000)).toBeTrue();
    expect(prompt.trimmedCompactionMessages).toBeUndefined();
    fragments.push(...compactionStageData(prompt).fragments);
    if (prompt.multipart) multipartStages++;
    prompt.release();
    return "Verified cumulative checkpoint";
  });
  const parsed = parseRequest({ model: "gpt-5.6-sol", reasoning: { effort: "high" },
    input: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "state ".repeat(40_000) }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Continue the original task." }],
        internal_chat_message_metadata_passthrough: { turn_id: `account-stage-${planType}` } }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: `account-stage-${planType}`, turn_id: `account-stage-${planType}` }) } });
  parsed._compactionRequest = true;
  parsed._chatgptModelFamily = "5.6";
  const plan = planLargeContextCompaction(parsed)!;
  const adapter = createChatGptWebAdapter({ adapter: "chatgpt-web", baseUrl: `browser://account-stage-${planType}-${Date.now()}`,
    chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath, localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: false,
      experimentalBiggerContext: true, experimentalStagedCompaction: true } });
  const events: AdapterEvent[] = [];
  try {
    await adapter.runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
    expect(events.filter(event => event.type === "error")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(multipartStages).toBeGreaterThan(0);
    expect(fragments.map(fragment => fragment.text).join("")).toBe(plan.fragments.map(fragment => fragment.text).join(""));
    let offset = 0;
    for (const fragment of fragments) { expect(fragment.offset).toBe(offset); offset += fragment.text.length; }
    expect(offset).toBe(plan.sourceChars);
  } finally {
    run.mockRestore();
    await TurnBroker.forSocket(brokerSocketPath).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  ["pro", "max", "max", "6"], ["pro", "xhigh", "xhigh", "6"],
  ["plus", "max", "high", "5.6"], ["plus", "xhigh", "high", "6"],
] as const)("actual %s lease resolves %s despite a conservative primary setup", async (planType, effort, selectedEffort, family) => {
  let prepared = false;
  const run = spyOn(ChatGptBrowserWorker.prototype, "run").mockImplementation(async turn => {
    const account = resolveChatGptAccountPreparation(turn, { accountKey: "a".repeat(64), planType });
    expect(account.reasoning).toBe(selectedEffort);
    expect(account.modelFamily).toBe(family);
    await turn.onAccountSelected?.(account);
    const prompt = await turn.prepare(account);
    prepared = true;
    prompt.release();
    turn.onTextDelta?.("offline tier validation complete");
    return "offline tier validation complete";
  });
  const id = `account-validation-${planType}-${effort}`;
  const adapter = createChatGptWebAdapter({ adapter: "chatgpt-web", baseUrl: `browser://${id}`,
    chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: join(tmpdir(), `${id}-inert.json`),
      localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false,
      experimentalBiggerContext: true } });
  const parsed = parseRequest({ model: "gpt-5.6-sol", reasoning: { effort },
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue the task" }],
      internal_chat_message_metadata_passthrough: { turn_id: id } }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: id, turn_id: id }) } });
  parsed._chatgptModelFamily = "6";
  const events: AdapterEvent[] = [];
  try {
    await adapter.runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
    expect(prepared).toBeTrue();
    expect(events.filter(event => event.type === "error")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  } finally { run.mockRestore(); }
});
