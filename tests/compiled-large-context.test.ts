import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { chromium } from "playwright-core";
import { compileChatGptWebPrompt, createChatGptWebPromptPreparation } from "../src/adapters/chatgpt-web/prompt";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { canonicalizeCompactionHandoff } from "../src/adapters/chatgpt-web/compaction-handoff";
import { planLargeContextCompaction } from "../src/adapters/chatgpt-web/large-context-compaction";
import { COMPACT_PROMPT } from "../src/responses/compaction";
import { CHATGPT_USER_TURN_SELECTOR, CHATGPT_ASSISTANT_TURN_SELECTOR, CHATGPT_STOP_BUTTON_SELECTOR } from "../src/chatgpt-session";
import type { CodexParsedRequest } from "../src/types";
const ts = require("typescript");
const nodes = (node: any, predicate: (n: any) => boolean): any[] => {
  const found: any[] = []; function visit(n: any) { if (predicate(n)) found.push(n); ts.forEachChild(n, visit); } visit(node); return found;
};
const one = (items: any[], label: string): any => { expect(items.length, label).toBe(1); return items[0]; };
const base = process.env.CHATGPT_LARGE_CONTEXT_BASE_RUNTIME_ROOT;
const candidate = process.env.CHATGPT_STAGE_CALL_RUNTIME_ROOT;
const patch = require("../scripts/bridge-large-context-runtime-overlay.cjs");

test.skipIf(!base || !candidate)("the R12 overlay reproduces actual staged bundles and reverses to every original R11 byte", () => {
  for (const relative of ["app/cli.js", "app/browser-helper.cjs"]) {
    const result = patch(readFileSync(join(base!, relative), "utf8"), relative);
    expect(result.evidence.reverseRestoresOriginalBytes).toBeTrue();
    const staged = readFileSync(join(candidate!, relative), "utf8");
    expect(result.code).toBe(staged); expect(() => patch(staged, relative)).toThrow("R12 already present");
  }
});

test.skipIf(!base || !candidate)("actual compiled compaction/prepare closures stage a 1.2M context without multipart, model changes or premature settlement", async () => {
  const relative = "app/cli.js", code = readFileSync(join(candidate!, relative), "utf8");
  const f = ts.createSourceFile(relative, code, ts.ScriptTarget.Latest, true);
  const bindings = patch(readFileSync(join(base!, relative), "utf8"), relative).evidence.runtimeBindings;
  const adapter = one(nodes(f, n => ts.isFunctionDeclaration(n) && n.name?.text === bindings.adapter), "compiled adapter");
  const startup = one(nodes(adapter, n => ts.isVariableDeclaration(n) && n.name.getText(f) === bindings.startup && ts.isArrowFunction(n.initializer)), "startup");
  const compile = one(nodes(startup, n => ts.isVariableDeclaration(n) && n.name.getText(f) === bindings.compileOptions && ts.isArrowFunction(n.initializer)), "compile options");
  const prepare = one(nodes(startup, n => ts.isPropertyAssignment(n) && n.name.getText(f) === "prepare" && n.initializer.getText(f).includes("compaction_stage_too_large")), "prepare");
  const fresh = one(nodes(adapter, n => ts.isVariableDeclaration(n) && n.name.getText(f) === bindings.fresh && n.initializer.getText(f).includes("compaction_stage")), "fresh closure");
  const factory = one(nodes(f, n => ts.isFunctionDeclaration(n) && n.name?.text === "__codexLargeContext20261007"), "planner factory");
  const parsed: CodexParsedRequest = { modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "xhigh" }, _compactionRequest: true,
    context: { messages: [{ role: "user", timestamp: 0, content: "fixture evidence\n".repeat(75000) }] },
    _rawBody: { input: [{ type: "message", role: "user", content: "continue", internal_chat_message_metadata_passthrough: { turn_id: "fixture_source" } }],
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "fixture_thread", turn_id: "fixture_compact" }) } } };
  const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: false };
  for (const freshMode of [false, true]) {
    const context: Record<string, any> = { Buffer, AbortSignal, Error, Date, console: { info() {}, warn() {} },
      [bindings.hash]: createHash, [bindings.compactPrompt]: COMPACT_PROMPT, [bindings.errorAlias]: ChatGptWebAdapterError };
    vm.createContext(context); vm.runInContext(factory.getText(f), context);
    const planner = vm.runInContext("__codexLargeContext20261007()", context);
    const plan = planner.planLargeContextCompaction(parsed);
    expect(plan.sourceHash).toBe(planLargeContextCompaction(parsed)!.sourceHash);
    let starts = 0, releases = 0, rearmed = 0, maxPromptBytes = 0, active = 0, maxActive = 0;
    const traces = new Set<string>();
    const start = (input: CodexParsedRequest, environment: unknown, trace: string, caps: unknown, hooks: any) => {
      expect(environment).toBeUndefined(); expect(caps).toBe(capabilities); expect(hooks.boundedCompactionStage).toBeTrue();
      expect(input.modelId).toBe(parsed.modelId); expect(input.options).toBe(parsed.options);
      expect(traces.has(trace)).toBeFalse(); traces.add(trace); starts++; maxActive = Math.max(maxActive, ++active);
      const stageContext: Record<string, any> = { Buffer, [bindings.errorAlias]: ChatGptWebAdapterError };
      const cb = bindings.compileBindings, pb = bindings.prepareBindings;
      Object.assign(stageContext, { [cb.manualRequest]: false, [cb.hooks]: hooks, [cb.createChatGptWebPromptPreparation]: createChatGptWebPromptPreparation,
        [cb.experimentalBiggerContext]: true, [cb.resolveBiggerContextMultipartParts]: () => { throw Error("Unexpected multipart"); },
        [cb.turnCapabilities]: capabilities, [cb.experimentalSkillAttachments]: true, [cb.captureLunaCheckpoint]: false, [cb.minimalTransport]: true,
        [pb.checkpointInput]: { parsed: input }, [pb.compileChatGptWebPrompt]: compileChatGptWebPrompt });
      vm.createContext(stageContext);
      stageContext[pb.compileOptionsFor] = vm.runInContext("(" + compile.initializer.getText(f) + ")", stageContext);
      const prepareStage = vm.runInContext("(" + prepare.initializer.getText(f) + ")", stageContext);
      let release!: () => void;
      const physicalSettlement = new Promise<void>(resolve => { release = resolve; });
      const browser = (async () => {
        const prepared = await prepareStage();
        expect(prepared.multipart).toBeUndefined(); expect(prepared.trimmedCompactionMessages).toBeUndefined();
        const bytes = Buffer.byteLength(JSON.stringify(prepared.text)); maxPromptBytes = Math.max(maxPromptBytes, bytes);
        expect(bytes).toBeLessThan(110000); prepared.release();
        await Bun.sleep(1); active--; releases++; release(); return "Cumulative fixture evidence";
      })();
      return { browser, physicalSettlement, cancel: () => release() };
    };
    const values: Record<string, any> = { handoffPhase: "source_settlement", freshConversationPerTurn: freshMode,
      armHandoffDeadline: () => { rearmed++; }, manualRequest: false, startRuntime: start, parsed, environment: undefined,
      freshCompactionTraceId: "aabbccddeeff_fixture", turnCapabilities: capabilities, retainOwnershipUntil: () => {},
      withAbort: (value: Promise<any>) => value, operationSignal: new AbortController().signal,
      canonicalizeCompactionHandoff, compactionTraceId: "aabbccddeeff", largeCompaction: plan };
    for (const [name, value] of Object.entries(values)) context[bindings.freshBindings[name]] = value;
    const run = vm.runInContext("(" + fresh.initializer.getText(f) + ")", context);
    const result = await run("large_context_bounded_stages");
    expect(starts).toBe(plan.fragments.length); expect(starts).toBeGreaterThan(20); expect(releases).toBe(starts);
    expect(maxActive).toBe(1); expect(rearmed).toBeGreaterThan(starts); expect(maxPromptBytes).toBeLessThan(110000);
    expect(result).toContain('CODEX_LATEST_USER_PROMPT_JSON\n"continue"');
    // The same compiled prepare closure rejects oversized input before the browser gets it.
    const overflowContext: Record<string, any> = { Buffer, [bindings.errorAlias]: ChatGptWebAdapterError,
      [bindings.prepareBindings.hooks]: { boundedCompactionStage: true }, [bindings.prepareBindings.checkpointInput]: { parsed },
      [bindings.prepareBindings.turnCapabilities]: capabilities, [bindings.prepareBindings.compileOptionsFor]: () => ({}),
      [bindings.prepareBindings.compileChatGptWebPrompt]: () => ({ text: "x".repeat(110001) }) };
    vm.createContext(overflowContext);
    await expect(vm.runInContext("(" + prepare.initializer.getText(f) + ")", overflowContext)()).rejects.toMatchObject({ code: "compaction_stage_too_large", retryable: false });
  }
});

test.skipIf(!candidate || !process.env.CHATGPT_DOM_TEST_BROWSER)("actual CLI/helper projections retain every identity and current response on a synthetic 1.2M-character browser page", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  const results: unknown[] = []; let networkRequests = 0;
  try {
    const page = await browser.newPage(); await page.route("**/*", route => { networkRequests++; return route.abort(); });
    for (const relative of ["app/cli.js", "app/browser-helper.cjs"]) {
      const f = ts.createSourceFile(relative, readFileSync(join(candidate!, relative), "utf8"), ts.ScriptTarget.Latest, true);
      const node = one(nodes(f, n => ts.isFunctionDeclaration(n) && n.name?.text === "__codexSubmissionUi20261007"), "projection");
      const projection = vm.runInNewContext(node.getText(f) + ";__codexSubmissionUi20261007");
      await page.setContent("<main></main>");
      await page.evaluate(() => { for (let i = 0; i < 12; i++) {
        const article = document.createElement("article"); article.setAttribute("data-turn-key", "offline_" + i);
        article.innerHTML = '<div data-user-message-bubble></div><div data-conversation-role="assistant"><div class="markdown">OK</div></div>';
        article.querySelector('[data-user-message-bubble]')!.textContent = "x".repeat(99998); document.querySelector("main")!.appendChild(article);
      } });
      const start = performance.now();
      const result: any = await page.evaluate(projection, { userTurnSelector: CHATGPT_USER_TURN_SELECTOR, assistantTurnSelector: CHATGPT_ASSISTANT_TURN_SELECTOR,
        stopButtonSelector: CHATGPT_STOP_BUTTON_SELECTOR, attributeFilter: [] });
      const elapsedMs = performance.now() - start;
      expect(result.bodyTextChars).toBe(1200000); expect(result.snapshot.userTurnCount).toBe(12); expect(result.snapshot.assistantTurnCount).toBe(12);
      expect(result.deferredHistoryNodes).toBe(10); expect(elapsedMs).toBeLessThan(1000);
      expect(await page.evaluate(() => document.body.textContent!.length)).toBe(1200000);
      expect(await page.locator('[data-turn-key="offline_11"] .markdown').innerText()).toBe("OK");
      results.push({ relative, bodyTextChars: result.bodyTextChars, elapsedMs, projectionMs: result.projectionElapsedMs, deferredHistoryNodes: result.deferredHistoryNodes });
    }
    if (process.env.CHATGPT_COMPILED_LARGE_FIXTURE_REPORT) writeFileSync(process.env.CHATGPT_COMPILED_LARGE_FIXTURE_REPORT,
      JSON.stringify({ at: new Date().toISOString(), results, networkRequests, liveWorkerSends: 0, proTestSends: 0 }, null, 2));
  } finally { await browser.close(); }
}, 15000);
