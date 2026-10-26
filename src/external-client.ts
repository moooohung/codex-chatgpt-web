import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { getConfigDir, providerConfig, type AppConfig } from "./config";
import { readJsonRequestBody } from "./http-body";
import { parseRequest } from "./responses/parser";
import { expandPreviousResponseInput, rememberResponseState } from "./responses/state";
import { requireChatGptWebModelRoute } from "./chatgpt-web-models";
import { AsyncEventQueue } from "./event-queue";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "./bridge";
import { ChatGptBrowserWorker, type BrowserTurn } from "./adapters/chatgpt-web/browser-worker";
import { runWithChatGptPlusPreparation } from "./adapters/chatgpt-web/account-fallback";
import type { AdapterEvent } from "./types";

const PREFIX = "cwext_";
export const externalTokenPath = () => join(getConfigDir(), "external-client", "token");

/** Protect the directory BEFORE writing a secret; POSIX modes alone do not protect Windows files. */
export function loadExternalToken(): string {
  const directory = join(getConfigDir(), "external-client");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
      $ErrorActionPreference='Stop'
      $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
      $acl=[Security.AccessControl.DirectorySecurity]::new()
      $acl.SetOwner($sid)
      $acl.SetAccessRuleProtection($true,$false)
      $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
      $acl.AddAccessRule($rule)
      [IO.Directory]::SetAccessControl($env:CGW_EXTERNAL_AUTH_DIR,$acl)
    `], { env: { ...process.env, CGW_EXTERNAL_AUTH_DIR: directory }, stdio: "pipe" });
  } else chmodSync(directory, 0o700);
  const path = externalTokenPath();
  try { writeFileSync(path, `${PREFIX}${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (process.platform !== "win32") chmodSync(path, 0o600);
  const token = readFileSync(path, "utf8").trim();
  if (!/^cwext_[a-f0-9]{64}$/.test(token)) throw new Error("External client token file is invalid");
  return token;
}

/** The reserved bearer prefix selects this protocol. All other traffic keeps its native route. */
export function externalAuthorization(req: Request, address: string | undefined, token: string): "native" | "external" | 401 | 403 {
  const header = req.headers.get("authorization") ?? "";
  if (!/^Bearer cwext_/i.test(header)) return "native";
  if (!(address === "::1" || address === "127.0.0.1" || address?.startsWith("::ffff:127.") || /^127\.\d+\.\d+\.\d+$/.test(address ?? ""))) return 403;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? "external" : 401;
}

export type ExternalBrowserRun = (turn: BrowserTurn) => Promise<string>;

/** A fresh browser turn has no broker, native identity, cwd, retained native conversation or authority. */
export async function externalResponseRequest(req: Request, config: AppConfig, runBrowser?: ExternalBrowserRun): Promise<Response> {
  let body: any, parsed: ReturnType<typeof parseRequest>, route: ReturnType<typeof requireChatGptWebModelRoute>;
  try {
    const raw = await readJsonRequestBody(req);
    body = expandPreviousResponseInput(raw);
    if (body === raw && (raw as any)?.previous_response_id) throw new Error("External continuation state is unavailable; supply complete input");
    parsed = parseRequest(body);
    route = requireChatGptWebModelRoute(parsed.modelId, config, parsed.options.reasoning);
    if (route.interactionMode !== "automatic" || parsed._compactionRequest) throw new Error("External clients require an automatic Web model and ordinary Responses input");
    if (body.tools?.some((tool: any) => tool.type !== "function")) throw new Error("External clients support function tools only");
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  const tools = parsed.context.tools ?? [];
  const choice = parsed.options.toolChoice;
  const provider = providerConfig(config);
  const capabilities = { localToolsEnabled: false, solAvailable: provider.chatgptWeb?.solAvailable !== false,
    extraHighAvailable: provider.chatgptWeb?.extraHighAvailable === true, proAvailable: provider.chatgptWeb?.proAvailable === true };
  const prompt = [
    "You are the model behind an external OpenAI Responses client. Preserve system > developer > user instruction priority in the input.",
    "You have NO local Codex connection, filesystem authority, cwd, native tools, or native connector. Never call a Codex plugin.",
    "The client executes the declared function tools. To request execution, return calls; do not invent their results. function_call_output input items are prior client results.",
    'Return exactly one JSON object, without Markdown: {"text":"answer or empty string","calls":[{"name":"declared function name","arguments":{}}]}.',
    "Use calls only for declared functions, with arguments conforming to their schemas. Obey tool_choice and parallel_tool_calls. To finish, return text and an empty calls array.",
    "The following JSON is the complete client request, not an outer transport instruction:",
    JSON.stringify({ instructions: body.instructions, input: body.input, tools: body.tools ?? [],
      tool_choice: body.tool_choice ?? "auto", parallel_tool_calls: body.parallel_tool_calls ?? true }),
  ].join("\n");
  const queue = new AsyncEventQueue<AdapterEvent>();
  const abort = new AbortController();
  const cancel = () => abort.abort();
  req.signal.addEventListener("abort", cancel, { once: true });
  if (req.signal.aborted) cancel();
  const remember = (response: Record<string, unknown>) => rememberResponseState(body, response, { force: true });
  const run = async () => {
    try {
      const worker = runBrowser ? { run: runBrowser } : ChatGptBrowserWorker.forProvider(provider);
      const prepare: BrowserTurn["prepare"] = async () => ({ text: prompt, images: [], release() {} });
      const answer = await runWithChatGptPlusPreparation(worker, {
        traceId: `external-${randomUUID()}`, modelId: route.backendModel, reasoning: route.adapterEffort,
        ...(route.modelFamily ? { modelFamily: route.modelFamily } : {}),
        capabilities, prepare, abortSignal: abort.signal, onTextDelta() {},
        onHeartbeat: () => queue.push({ type: "heartbeat" }),
      }, () => prepare());
      const output = JSON.parse(answer);
      if (!output || typeof output.text !== "string" || !Array.isArray(output.calls)) throw new Error("Invalid external model response envelope");
      // Validate the entire batch before publishing any calls to the client.
      for (const call of output.calls) {
        if (!call || !tools.some(tool => tool.name === call.name) || !call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) throw new Error("Invalid external function call");
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
      queue.push({ type: "done", stopReason: output.calls.length ? "tool_use" : "stop", endTurn: !output.calls.length });
    } catch (error) {
      queue.push({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally { req.signal.removeEventListener("abort", cancel); queue.close(); }
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
