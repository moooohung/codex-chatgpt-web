import { createHash, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
export { externalTokenPath, loadExternalToken } from "./external-token";
import { readJsonRequestBody } from "./http-body";
import { formatErrorResponse } from "./bridge";

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

type Item = Record<string, unknown>;
const isRecord = (value: unknown): value is Item => !!value && typeof value === "object" && !Array.isArray(value);
const isUserMessage = (value: unknown): value is Item => isRecord(value) && value.type === "message" && value.role === "user";
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function messageText(item: Item): string {
  if (typeof item.content === "string") return item.content;
  return Array.isArray(item.content)
    ? item.content.map(part => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n") : "";
}

/** The client's working directory, from the `Cwd:` line of its runtime context (Mixdog's Session section).
 * Mixdog lowers that context to a system, developer or user item depending on the route, so instructions and
 * system/developer items are searched first, then the rest. */
function clientCwd(body: Item, input: unknown[]): string {
  const messages = input.filter((item): item is Item => isRecord(item) && item.type === "message");
  const system = (item: Item) => item.role === "system" || item.role === "developer";
  const texts = [typeof body.instructions === "string" ? body.instructions : "",
    ...messages.filter(system).map(messageText), ...messages.filter(item => !system(item)).map(messageText)];
  for (const text of texts) {
    // Mixdog writes `- Cwd: D:\project — the active Project root; ...`; the path ends before the dash note.
    const cwd = /^[\s>*#-]*Cwd:\s*`?(.+?)`?(?:\s+[—–]\s.*)?\s*$/m.exec(text)?.[1];
    if (cwd && isAbsolute(cwd)) return cwd;
  }
  // A request without tools (a provider connection test, a plain chat) runs no command, so it needs no
  // project root; tool-carrying requests still must name theirs.
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (!tools.length) return homedir();
  throw new Error(`External request has no absolute \`Cwd:\` line (message roles: ${messages.map(item => item.role).join(",") || "none"})`);
}

/**
 * External clients (Mixdog) run through the native Codex route, so ChatGPT calls the client's tools
 * through the Codex connector inside one continuing ChatGPT response instead of a fresh chat per step.
 * This supplies what native Codex sends itself: thread/turn identity, a full-access environment
 * context before the turn's user message, and per-item turn tags. The thread is the client's session
 * key; a turn starts at a user message that follows no pending tool output. User messages appended
 * after that (client reminders) are the same turn's context, not new human turns.
 */
export function nativeShapedExternalBody(raw: unknown, generations: ReadonlyMap<string, number> = new Map()): Item {
  return shapeExternal(raw, generations).body;
}

function shapeExternal(raw: unknown, generations: ReadonlyMap<string, number>): { body: Item; turnKey: string } {
  if (!isRecord(raw)) throw new Error("External request body must be a JSON object");
  if (raw.previous_response_id !== undefined) throw new Error("External clients must send complete input without previous_response_id");
  const source = typeof raw.input === "string" ? [{ role: "user", content: [{ type: "input_text", text: raw.input }] }] : raw.input;
  if (!Array.isArray(source)) throw new Error("External request input must be a string or an array");
  const input = source.map(item => (isRecord(item) && typeof item.role === "string" && item.type === undefined
    ? { type: "message", ...item } : item));
  // The turn anchor is the first user message of the run that opened the turn. A new turn's trailing run
  // may end with an ephemeral client reminder that is gone from the next request, so anchoring on a later
  // message would give the tool-result request a different turn and strand the pending ChatGPT response.
  // A user run opens a turn only when it follows a message (a final answer or the system prompt), never a
  // tool output: the client appends reminders after tool results, and those stay inside the open turn even
  // after later tool rounds move them into the middle of the history.
  let userIndex = -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (!isUserMessage(input[index]) || isUserMessage(input[index - 1])) continue;
    const before = input[index - 1];
    if (index === 0 || (isRecord(before) && before.type === "message")) { userIndex = index; break; }
  }
  if (userIndex < 0) throw new Error("External request has no user message");
  const cwd = clientCwd(raw, input);
  // The ChatGPT conversation lives as long as the client's history keeps its opening message. A client
  // compaction replaces that message with its summary, so the summarized history opens a new, small
  // ChatGPT conversation instead of resuming one that still holds every turn the summary replaced.
  const opening = digest(JSON.stringify((input.find(isUserMessage) as Item | undefined)?.content ?? null)).slice(0, 16);
  const threadId = typeof raw.prompt_cache_key === "string" && raw.prompt_cache_key
    ? `${raw.prompt_cache_key}:${opening}` : digest(JSON.stringify([raw.instructions ?? null, input.find(isUserMessage) ?? null]));
  const turnKey = digest(JSON.stringify([threadId, userIndex, (input[userIndex] as Item).content]));
  // A turn whose browser session was retired (a tool result came back too late) continues as a new
  // native turn generation over the same history instead of replaying the retired turn's failure.
  const generation = generations.get(turnKey) ?? 0;
  const turnId = generation ? digest(`${turnKey}:${generation}`) : turnKey;
  const tag = { turn_id: turnId };
  const environment = `<environment_context>\n  <cwd>${xml(cwd)}</cwd>\n  <filesystem><workspace_roots><root>${xml(cwd)}</root></workspace_roots>`
    + `<permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>\n</environment_context>`;
  const shaped: unknown[] = [];
  input.forEach((item, index) => {
    if (index === userIndex) {
      shaped.push({ type: "message", role: "user", content: [{ type: "input_text", text: environment }], internal_chat_message_metadata_passthrough: tag });
      shaped.push({ ...(item as Item), internal_chat_message_metadata_passthrough: tag });
    } else if (index > userIndex && isUserMessage(item)) {
      shaped.push({ ...item, role: "developer", internal_chat_message_metadata_passthrough: tag });
    } else shaped.push(item);
  });
  console.info(`[codex-chatgpt-web] external turn thread=${digest(threadId).slice(0, 8)} turn=${turnId.slice(0, 8)} anchor=${userIndex}/${input.length}`);
  const metadata = isRecord(raw.client_metadata) ? raw.client_metadata : {};
  return { turnKey, body: { ...raw, input: shaped, prompt_cache_key: threadId,
    client_metadata: { ...metadata, "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }) } } };
}

// A turn the bridge already ended: its tool result came after the tool deadline, or its client
// disconnected (an app restart) and the browser turn was cancelled. The client's next request for that
// history is a continuation, so it opens a new turn generation instead of replaying the tombstone.
const TOOL_TIMEOUT = /"codex_tool_timeout"|did not return a result within|"client_cancelled"/;
const FIRST_OUTPUT = /"type":"response\.(output_item\.added|output_text\.delta|completed|incomplete)"/;
/** A retired turn answers a late tool result immediately; a live turn takes far longer to produce output. */
export const EXTERNAL_RETIRED_TURN_PROBE_MS = 3_000;
const turnGenerations = new Map<string, number>();

/**
 * Hold the start of the native response briefly. When it is a retired turn's tool-timeout failure
 * (the client's tool result arrived after the bridge's tool deadline), report it so the caller can
 * continue the same history as a new turn; otherwise replay the held bytes and stream the rest.
 */
async function retiredTurnFailure(response: Response, probeMs: number): Promise<{ retired: boolean; response: Response }> {
  if (!response.body) return { retired: false, response };
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const text = await response.text();
    return { retired: !response.ok && TOOL_TIMEOUT.test(text),
      response: new Response(text, { status: response.status, headers: response.headers }) };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const held: Uint8Array[] = [];
  let text = "";
  let pending: ReturnType<typeof reader.read> | undefined;
  let done = false;
  const deadline = Date.now() + probeMs;
  while (!done && Date.now() < deadline && !FIRST_OUTPUT.test(text)) {
    pending ??= reader.read();
    const next = await Promise.race([pending, Bun.sleep(Math.max(0, deadline - Date.now())).then(() => undefined)]);
    if (!next) break;
    pending = undefined;
    if (next.done) { done = true; break; }
    held.push(next.value);
    text += decoder.decode(next.value, { stream: true });
    if (/"type":"response\.failed"/.test(text) && TOOL_TIMEOUT.test(text)) {
      await reader.cancel().catch(() => {});
      return { retired: true, response };
    }
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of held) controller.enqueue(chunk);
      if (done) controller.close();
    },
    async pull(controller) {
      const next = await (pending ?? reader.read());
      pending = undefined;
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return { retired: false, response: new Response(stream, { status: response.status, headers: response.headers }) };
}

export async function externalNativeRequest(req: Request, runNative: (native: Request) => Promise<Response>,
  probeMs = EXTERNAL_RETIRED_TURN_PROBE_MS): Promise<Response> {
  let raw: unknown;
  let shaped: ReturnType<typeof shapeExternal>;
  try {
    raw = await readJsonRequestBody(req);
    shaped = shapeExternal(raw, turnGenerations);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[codex-chatgpt-web] external request rejected: ${message.slice(0, 300)}`);
    return formatErrorResponse(400, "invalid_request_error", message);
  }
  const send = (body: Item) => runNative(new Request(req.url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: req.signal }));
  const first = await retiredTurnFailure(await send(shaped.body), probeMs);
  if (!first.retired) return logRejection(first.response, shaped.turnKey);
  turnGenerations.set(shaped.turnKey, (turnGenerations.get(shaped.turnKey) ?? 0) + 1);
  console.info(`[codex-chatgpt-web] external turn ${shaped.turnKey.slice(0, 8)} retired by a late tool result; continuing as a new turn`);
  return logRejection(await send(shapeExternal(raw, turnGenerations).body), shaped.turnKey);
}

/** Admission refusals return plain JSON without a browser trace; record which rule refused the turn. */
async function logRejection(response: Response, turnKey: string): Promise<Response> {
  if (response.ok) return response;
  const text = await response.text();
  console.warn(`[codex-chatgpt-web] external turn ${turnKey.slice(0, 8)} refused status=${response.status} body=${text.slice(0, 400)}`);
  return new Response(text, { status: response.status, headers: response.headers });
}
