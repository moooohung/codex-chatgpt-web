import { createHash, timingSafeEqual } from "node:crypto";
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

/** The client's working directory, from the `Cwd:` line of its system prompt (Mixdog's Session section). */
function clientCwd(body: Item, input: unknown[]): string {
  const texts = [typeof body.instructions === "string" ? body.instructions : "",
    ...input.filter(item => isRecord(item) && item.type === "message" && (item.role === "system" || item.role === "developer"))
      .map(item => messageText(item as Item))];
  for (const text of texts) {
    const cwd = /^\s*Cwd:\s*(.+?)\s*$/m.exec(text)?.[1];
    if (cwd && isAbsolute(cwd)) return cwd;
  }
  throw new Error("External request has no absolute `Cwd:` line in its system prompt");
}

/**
 * External clients (Mixdog) run through the native Codex route, so ChatGPT calls the client's tools
 * through the Codex connector inside one continuing ChatGPT response instead of a fresh chat per step.
 * This supplies what native Codex sends itself: thread/turn identity, a full-access environment
 * context before the turn's user message, and per-item turn tags. The thread is the client's session
 * key; a turn starts at a user message that follows no pending tool output. User messages appended
 * after that (client reminders) are the same turn's context, not new human turns.
 */
export function nativeShapedExternalBody(raw: unknown): Item {
  if (!isRecord(raw)) throw new Error("External request body must be a JSON object");
  if (raw.previous_response_id !== undefined) throw new Error("External clients must send complete input without previous_response_id");
  const source = typeof raw.input === "string" ? [{ role: "user", content: [{ type: "input_text", text: raw.input }] }] : raw.input;
  if (!Array.isArray(source)) throw new Error("External request input must be a string or an array");
  const input = source.map(item => (isRecord(item) && typeof item.role === "string" && item.type === undefined
    ? { type: "message", ...item } : item));
  let tail = input.length;
  while (tail > 0 && isUserMessage(input[tail - 1])) tail -= 1;
  const before = input[tail - 1];
  const pendingTools = isRecord(before) && before.type !== "message";
  let userIndex = tail < input.length && !pendingTools ? tail : -1;
  for (let index = tail - 1; userIndex < 0 && index >= 0; index -= 1) if (isUserMessage(input[index])) userIndex = index;
  if (userIndex < 0) throw new Error("External request has no user message");
  const cwd = clientCwd(raw, input);
  const threadId = typeof raw.prompt_cache_key === "string" && raw.prompt_cache_key
    ? raw.prompt_cache_key : digest(JSON.stringify([raw.instructions ?? null, input.find(isUserMessage) ?? null]));
  const turnId = digest(JSON.stringify([threadId, userIndex, (input[userIndex] as Item).content]));
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
  const metadata = isRecord(raw.client_metadata) ? raw.client_metadata : {};
  return { ...raw, input: shaped, prompt_cache_key: threadId,
    client_metadata: { ...metadata, "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }) } };
}

export async function externalNativeRequest(req: Request, runNative: (native: Request) => Promise<Response>): Promise<Response> {
  let body: Item;
  try { body = nativeShapedExternalBody(await readJsonRequestBody(req)); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[codex-chatgpt-web] external request rejected: ${message.slice(0, 300)}`);
    return formatErrorResponse(400, "invalid_request_error", message);
  }
  return runNative(new Request(req.url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: req.signal }));
}
