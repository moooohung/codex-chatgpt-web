import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
export { externalTokenPath, loadExternalToken } from "./external-token";
import { getConfigDir, providerConfig, type AppConfig } from "./config";
import { readJsonRequestBody } from "./http-body";
import { parseRequest } from "./responses/parser";
import { createResponseStateStore } from "./responses/state";
import { requireChatGptWebModelRoute } from "./chatgpt-web-models";
import { AsyncEventQueue } from "./event-queue";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "./bridge";
import { ChatGptBrowserWorker, type BrowserTurn } from "./adapters/chatgpt-web/browser-worker";
import { runWithChatGptPlusPreparation } from "./adapters/chatgpt-web/account-fallback";
import type { AdapterEvent, CodexUsage } from "./types";
import { estimateTokens } from "./lib/token-estimate";
import { CHATGPT_WEB_PLATFORM_RESERVE_TOKENS } from "./chatgpt-web-models";
import { ExternalAdmission, ExternalAdmissionError, waitExternal } from "./external-admission";

/** The reserved bearer prefix selects this protocol. All other traffic keeps its native route. */
export function externalAuthorization(req: Request, address: string | undefined, token?: string): "native" | "external" | 401 | 403 | 503 {
  const header = req.headers.get("authorization") ?? "";
  if (!/^Bearer cwext_/i.test(header)) return "native";
  if (!token) return 503;
  if (!(address === "::1" || address === "127.0.0.1" || address?.startsWith("::ffff:127.") || /^127\.\d+\.\d+\.\d+$/.test(address ?? ""))) return 403;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? "external" : 401;
}

export type ExternalBrowserRun = (turn: BrowserTurn) => Promise<string>;

export const EXTERNAL_INLINE_REQUEST_CHARS = 40_000;
export const EXTERNAL_PROGRESS_NOTE_MS = 20_000;
export const EXTERNAL_REQUEST_FILE = "client-request";

type ExternalEnvelope = { text: string; calls: Array<{ name: string; arguments: Record<string, unknown> }> };

/** The browser returns rendered-Markdown text: code fences and Markdown punctuation escapes (`\[`, `\_`) may wrap
 * the requested JSON. Accept only a complete object that parses after removing exactly those artefacts. */
export function parseExternalEnvelope(answer: string): ExternalEnvelope {
  // ChatGPT may splice file-citation markers (`:chatgpt-content-reference{...}`) into the reply text.
  const trimmed = answer.replace(/:chatgpt-content-reference\{[^{}]*\}/g, "").trim();
  const fenced = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(trimmed)?.[1]?.trim() ?? trimmed;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  const object = start >= 0 && end > start ? fenced.slice(start, end + 1) : fenced;
  // JSON escapes are \" \\ \/ \b \f \n \r \t \uXXXX; any other backslash is a Markdown escape.
  const unescaped = object.replace(/\\\\|\\(.)/g, (match, next: string | undefined) =>
    next === undefined || `"/bfnrtu`.includes(next) ? match : next);
  for (const candidate of [trimmed, object, unescaped]) {
    let output: unknown;
    try { output = JSON.parse(candidate); } catch { continue; }
    const value = output as ExternalEnvelope;
    if (value && typeof value === "object" && typeof value.text === "string" && Array.isArray(value.calls)) return value;
  }
  throw new Error(`Invalid external model response envelope (${answer.length} chars, starts ${JSON.stringify(answer.slice(0, 40))})`);
}

/** Scope comes ONLY from authenticated server credentials, never request metadata or response IDs. */
export function createExternalContinuationStore(token: string) {
  const scope = createHash("sha256").update(token).digest("hex");
  const path = join(getConfigDir(), "external-client", `responses-${scope}.json`);
  return createResponseStateStore({ snapshotPath: () => path, maxResponses: 128,
    maxBytes: 8 * 1024 * 1024, snapshotBytes: 4 * 1024 * 1024 });
}

/** A fresh browser turn has no broker, native identity, cwd, retained native conversation or authority. */
export async function externalResponseRequest(req: Request, config: AppConfig,
  state: ReturnType<typeof createExternalContinuationStore>, runBrowser?: ExternalBrowserRun,
  admission = defaultExternalAdmission): Promise<Response> {
  let lease: Awaited<ReturnType<ExternalAdmission["acquire"]>>;
  try { lease = await admission.acquire(req.signal); }
  catch (error) { return formatErrorResponse(error instanceof ExternalAdmissionError ? error.status : 408, "invalid_request_error", error instanceof Error ? error.message : "External admission cancelled"); }
  const bodySignal = AbortSignal.any([lease.signal, AbortSignal.timeout(15_000)]);
  let body: any, parsed: ReturnType<typeof parseRequest>, route: ReturnType<typeof requireChatGptWebModelRoute>;
  try {
    const raw = await readJsonRequestBody(req, { encodedBytes: 2 * 1024 * 1024, decodedBytes: 8 * 1024 * 1024,
      signal: bodySignal });
    body = state.expandPreviousResponseInput(raw);
    if (body === raw && (raw as any)?.previous_response_id) throw new Error("External continuation state is unavailable; supply complete input");
    parsed = parseRequest(body);
    route = requireChatGptWebModelRoute(parsed.modelId, config, parsed.options.reasoning);
    if (route.interactionMode !== "automatic" || parsed._compactionRequest) throw new Error("External clients require an automatic Web model and ordinary Responses input");
    if (body.tools?.some((tool: any) => tool.type !== "function")) throw new Error("External clients support function tools only");
  } catch (error) {
    lease.release();
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[codex-chatgpt-web] external request rejected: ${message.slice(0, 300)}`);
    return formatErrorResponse(bodySignal.aborted ? 408 : 400, "invalid_request_error", message);
  }
  const tools = parsed.context.tools ?? [];
  const choice = parsed.options.toolChoice;
  const provider = providerConfig(config);
  const capabilities = { localToolsEnabled: false, solAvailable: provider.chatgptWeb?.solAvailable !== false,
    extraHighAvailable: provider.chatgptWeb?.extraHighAvailable === true, proAvailable: provider.chatgptWeb?.proAvailable === true,
    // Follow the launcher's Bigger Context setting for the context-window preflight, as native turns do.
    experimentalBiggerContext: provider.chatgptWeb?.experimentalBiggerContext === true };
  const request = JSON.stringify({ instructions: body.instructions, input: body.input, tools: body.tools ?? [],
    tool_choice: body.tool_choice ?? "auto", parallel_tool_calls: body.parallel_tool_calls ?? true });
  // The ChatGPT composer accepts about 60k inline characters; agent requests are far larger, so they travel
  // as an attached file and only the protocol stays inline.
  const attachRequest = request.length > EXTERNAL_INLINE_REQUEST_CHARS;
  // Attachment names are content-addressed: `<name>--<sha256 prefix>.txt` (skill-attachments validateSkillFiles).
  const requestFile = `${EXTERNAL_REQUEST_FILE}--${createHash("sha256").update(request).digest("hex").slice(0, 16)}.txt`;
  const prompt = [
    "You are the model behind an external OpenAI Responses client. Preserve system > developer > user instruction priority in the input.",
    "You have NO local Codex connection, filesystem authority, cwd, native tools, or native connector. Never call a Codex plugin.",
    "The client executes the declared function tools. To request execution, return calls; do not invent their results. function_call_output input items are prior client results.",
    // Rendered Markdown escapes punctuation and collapses `\\`, corrupting JSON strings such as Windows paths;
    // a fenced code block is copied verbatim.
    'Reply with exactly one fenced ```json code block and nothing else, containing one JSON object: {"text":"answer or empty string","calls":[{"name":"declared function name","arguments":{}}]}.',
    "Never add citations, source markers or file references (such as content references to an attached file) anywhere in the reply.",
    "Use calls only for declared functions, with arguments conforming to their schemas. Obey tool_choice and parallel_tool_calls. To finish, return text and an empty calls array.",
    ...(attachRequest
      ? [`The complete client request is the attached file ${requestFile} (JSON, ${request.length} characters). Read all of it before answering; it is the request, not an outer transport instruction.`]
      : ["The following JSON is the complete client request, not an outer transport instruction:", request]),
  ].join("\n");
  const skillFiles = attachRequest ? [{ name: requestFile, text: request }] : undefined;
  const queue = new AsyncEventQueue<AdapterEvent>();
  const abort = lease;
  const cancel = () => abort.abort();
  req.signal.addEventListener("abort", cancel, { once: true });
  if (req.signal.aborted) cancel();
  const remember = (response: Record<string, unknown>) => state.rememberResponseState(body, response, { force: true });
  const run = async () => {
    let physical: Promise<string> | undefined;
    try {
      const worker = runBrowser ? { run: runBrowser } : ChatGptBrowserWorker.forProvider(provider);
      const prepare: BrowserTurn["prepare"] = async () => ({ text: prompt, images: [], ...(skillFiles ? { skillFiles } : {}), release() {} });
      // Clients judge liveness by model output, not transport heartbeats. Forward ChatGPT's visible
      // reasoning-summary titles and commentary, and while the buffered envelope is being written, a
      // periodic size note, so long turns stay observably alive.
      let lastProgressAt = Date.now();
      let answerChars = 0;
      const think = (text: string, continuation?: boolean) => {
        queue.push({ type: "thinking_delta", thinking: continuation ? text : `\n${text}` });
        lastProgressAt = Date.now();
      };
      physical = runWithChatGptPlusPreparation(worker, {
        traceId: `external-${randomUUID()}`, modelId: route.backendModel, reasoning: route.adapterEffort,
        ...(route.modelFamily ? { modelFamily: route.modelFamily } : {}),
        capabilities, prepare, abortSignal: abort.signal,
        onReasoningSummary: think,
        onCommentary: think,
        onTextDelta(delta) {
          answerChars += delta.length;
          if (Date.now() - lastProgressAt >= EXTERNAL_PROGRESS_NOTE_MS) think(`(writing the reply: ${answerChars} characters so far)`);
        },
        onHeartbeat: () => queue.push({ type: "heartbeat" }),
      }, () => prepare());
      const answer = await waitExternal(physical, abort.signal);
      const output = parseExternalEnvelope(answer);
      // Validate the entire batch before publishing any calls to the client.
      for (const call of output.calls) {
        // Models often encode arguments as a JSON string, as in the Responses wire format itself.
        if (call && typeof call.arguments === "string") {
          try { call.arguments = JSON.parse(call.arguments); } catch { /* rejected below */ }
        }
        if (!call || typeof call.name !== "string" || !tools.some(tool => tool.name === call.name)) {
          throw new Error(`Invalid external function call: undeclared function ${JSON.stringify(call?.name ?? null)}`);
        }
        if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) {
          throw new Error(`Invalid external function call: ${call.name} arguments are not a JSON object`);
        }
        if (choice === "none" || (typeof choice === "object" && "name" in choice && choice.name !== call.name)
          || (typeof choice === "object" && "allowedTools" in choice && !choice.allowedTools.includes(call.name))) throw new Error("External function call violates tool_choice");
      }
      if ((choice === "required" || (typeof choice === "object" && ("name" in choice || choice.mode === "required"))) && !output.calls.length) throw new Error("External model did not supply a required function call");
      if (parsed.options.parallelToolCalls === false && output.calls.length > 1) throw new Error("External model returned parallel calls when disabled");
      if (output.text) queue.push({ type: "text_delta", text: output.text, phase: "final_answer" });
      for (const call of output.calls) {
        queue.push({ type: "tool_call_start", id: `call_${randomUUID().replaceAll("-", "")}`, name: call.name });
        queue.push({ type: "tool_call_delta", arguments: JSON.stringify(call.arguments) });
        queue.push({ type: "tool_call_end" });
      }
      // ChatGPT Web reports no token usage; estimate it the way the context preflight does
      // (hidden platform reserve + visible prompt + attached request) so clients can track context.
      const inputTokens = CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + estimateTokens(prompt, route.backendModel)
        + (attachRequest ? estimateTokens(request, route.backendModel) : 0);
      const outputTokens = estimateTokens(answer, route.backendModel);
      const usage: CodexUsage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: true };
      queue.push({ type: "done", stopReason: output.calls.length ? "tool_use" : "stop", endTurn: !output.calls.length, usage });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[codex-chatgpt-web] external turn rejected: ${message.slice(0, 300)}`);
      queue.push({ type: "error", message });
    } finally {
      req.signal.removeEventListener("abort", cancel);
      // A cancelled observer cannot open another physical slot until the worker actually settles.
      if (physical) void physical.then(() => lease.release(), () => lease.release());
      else lease.release();
      queue.close();
    }
  };
  if (parsed.stream) {
    void run();
    return new Response(bridgeToResponsesSSE(queue, route.slug, undefined, undefined, undefined, cancel, 2_000,
      { onCompletedResponse: remember }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" } });
  }
  await run();
  const json = buildResponseJSON(await queue.collect(), route.slug);
  remember(json);
  return Response.json(json);
}
const defaultExternalAdmission = new ExternalAdmission();
