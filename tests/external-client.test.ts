import { expect, test } from "bun:test";
import { externalAuthorization, externalNativeRequest, externalTokenPath, nativeShapedExternalBody } from "../src/external-client";
import { boundedNativePollArguments, externalShellArguments } from "../src/adapters/chatgpt-web/mcp-server";

test("external blocking waits return before the MCP deadline", () => {
  expect(boundedNativePollArguments("task", { action: "wait", task_id: "t" })).toEqual({ action: "wait", task_id: "t", timeout_ms: 60_000 });
  expect(boundedNativePollArguments("task", { action: "wait", timeout_ms: 1_200_000 }).timeout_ms).toBe(60_000);
  expect(boundedNativePollArguments("task", { action: "wait", timeout_ms: 20_000 }).timeout_ms).toBe(20_000);
  expect(boundedNativePollArguments("task", { action: "read" })).toEqual({ action: "read" });
  expect(boundedNativePollArguments("shell", { command: "x", wait_ms: 600_000 }).wait_ms).toBe(60_000);
  expect(boundedNativePollArguments("shell", { command: "x" })).toEqual({ command: "x" });
});
import { defaultConfig } from "../src/config";
import { chatGptToolTimeoutError } from "../src/adapters/chatgpt-web/adapter-error";
import { startServer } from "../src/server";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const token = `cwext_${"a".repeat(64)}`;
const cwd = process.cwd();
const system = { role: "system", content: `# Session\nCwd: ${cwd}\nModel: x` };
const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
const shape = (input: unknown[]) => nativeShapedExternalBody({ model: "chatgpt-web/gpt-5.6-sol", prompt_cache_key: "sess-1", input }) as any;
const turnOf = (body: any) => JSON.parse(body.client_metadata["x-codex-turn-metadata"]);

test("external mode requires the reserved bearer token; native Codex headers stay unchanged", () => {
  const request = (authorization?: string) => new Request("http://localhost/v1/responses", { headers: authorization ? { authorization } : {} });
  expect(externalAuthorization(request(), "127.0.0.1", token)).toBe("native");
  expect(externalAuthorization(request("Bearer codex-placeholder"), "127.0.0.1", token)).toBe("native");
  expect(externalAuthorization(request(`Bearer ${token}wrong`), "127.0.0.1", token)).toBe(401);
  expect(externalAuthorization(request(`Bearer ${token}`), "192.168.1.1", token)).toBe(403);
  expect(externalAuthorization(request(`Bearer ${token}`), undefined, token)).toBe(403);
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(externalAuthorization(request(`Bearer ${token}`), ip, token)).toBe("external");
});

test("a new external turn gets native identity, a full-access environment before its user message, and reminders as context", () => {
  const body = shape([system, user("do it"), user("<system-reminder>note</system-reminder>")]);
  const { thread_id, turn_id } = turnOf(body);
  expect(thread_id).toStartWith("sess-1:");
  expect(body.prompt_cache_key).toBe(thread_id);
  const [, environment, instruction, reminder] = body.input;
  expect(environment.role).toBe("user");
  expect(environment.content[0].text).toContain(`<cwd>${cwd}</cwd>`);
  expect(environment.content[0].text).toContain('<permission_profile type="disabled"><file_system type="unrestricted" />');
  expect(instruction.content[0].text).toBe("do it");
  expect(reminder.role).toBe("developer");
  for (const item of [environment, instruction, reminder]) expect(item.internal_chat_message_metadata_passthrough.turn_id).toBe(turn_id);
});

test("tool continuations stay in the same turn; a user message after a final answer starts a new one", () => {
  const first = turnOf(shape([system, user("do it"), user("reminder 1")])).turn_id;
  const call = { type: "function_call", call_id: "c1", name: "read", arguments: "{}" };
  const output = { type: "function_call_output", call_id: "c1", output: "x" };
  const continued = shape([system, user("do it"), call, output, user("reminder 2")]);
  expect(turnOf(continued).turn_id).toBe(first);
  expect(continued.input.at(-1).role).toBe("developer");
  const next = shape([system, user("do it"), call, output, { role: "assistant", content: [{ type: "output_text", text: "done" }] }, user("next")]);
  expect(turnOf(next).turn_id).not.toBe(first);
  expect(next.input.at(-2).content[0].text).toContain("<environment_context>");
  expect(next.input.at(-1).content[0].text).toBe("next");
});

test("reminders after tool results stay in the open turn after later tool rounds move them mid-history", () => {
  const call = (id: string) => ({ type: "function_call", call_id: id, name: "shell", arguments: "{}" });
  const output = (id: string) => ({ type: "function_call_output", call_id: id, output: "x" });
  const opened = turnOf(shape([system, user("go"), user("note")])).turn_id;
  const first = shape([system, user("go"), user("note"), call("a"), output("a"), user("reminder A")]);
  const second = shape([system, user("go"), user("note"), call("a"), output("a"), user("reminder A"), call("b"), output("b"), user("reminder B")]);
  expect(turnOf(first).turn_id).toBe(opened);
  expect(turnOf(second).turn_id).toBe(opened);
  expect(second.input.filter((item: any) => item.role === "developer").map((item: any) => item.content[0].text)).toEqual(["note", "reminder A", "reminder B"]);
});

test("a client compaction opens a new ChatGPT conversation; later turns of one history keep theirs", () => {
  const answer = { role: "assistant", content: [{ type: "output_text", text: "done" }] };
  const thread = (input: unknown[]) => turnOf(shape(input)).thread_id;
  const original = thread([system, user("brief"), answer, user("next")]);
  expect(thread([system, user("brief"), answer, user("next"), answer, user("more")])).toBe(original);
  expect(thread([system, user("<compact-state>summary</compact-state>"), user("next")])).not.toBe(original);
});

test("Mixdog's environment-tier Cwd bullet supplies the working directory without its trailing note", () => {
  const environment = { role: "system", content: `- Cwd: ${cwd} — the active Project root; relative paths resolve here.\n- Shell: PowerShell.` };
  const body = nativeShapedExternalBody({ prompt_cache_key: "s", input: [{ role: "system", content: "rules" }, environment, user("hi")] }) as any;
  expect(body.input.find((item: any) => item.content?.[0]?.text?.startsWith("<environment_context>")).content[0].text).toContain(`<cwd>${cwd}</cwd>`);
});

test("a turn opened by a context message, the request and a reminder keeps its identity in the tool-result request", () => {
  const opened = shape([system, user("<context>agents</context>"), user("do it"), user("reminder")]);
  const call = { type: "function_call", call_id: "c1", name: "read", arguments: "{}" };
  const output = { type: "function_call_output", call_id: "c1", output: "x" };
  const continued = shape([system, user("<context>agents</context>"), user("do it"), call, output]);
  expect(turnOf(continued).turn_id).toBe(turnOf(opened).turn_id);
  expect(continued.input.filter((item: any) => item.role === "user").length).toBe(2);
});

test("a late tool result for a retired turn continues as a new turn; live streams pass through byte for byte", async () => {
  const sse = (...events: object[]) => new Response(events.map(event => `event: ${(event as any).type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
  const call = { type: "function_call", call_id: "c9", name: "grep", arguments: "{}" };
  const output = { type: "function_call_output", call_id: "c9", output: "late" };
  const request = () => new Request("http://localhost/v1/responses", { method: "POST",
    body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", prompt_cache_key: "sess-retire", stream: true, input: [system, user("go"), call, output] }) });
  const turns: string[] = [];
  const retired = await externalNativeRequest(request(), async native => {
    turns.push(turnOf(await native.json()).turn_id);
    return turns.length === 1
      ? sse({ type: "response.created" }, { type: "response.failed", response: { error: { code: "codex_tool_timeout", message: "Codex tool grep did not return a result within 90 seconds." } } })
      : sse({ type: "response.created" }, { type: "response.output_item.added", item: { type: "message" } }, { type: "response.completed" });
  }, 1_000);
  expect(turns.length).toBe(2);
  expect(turns[1]).not.toBe(turns[0]);
  const text = await retired.text();
  expect(text).toContain("response.completed");
  expect(text).not.toContain("codex_tool_timeout");
  // The retired turn's generation sticks for later requests of the same turn.
  let later = "";
  await externalNativeRequest(request(), async native => { later = turnOf(await native.json()).turn_id; return sse({ type: "response.completed" }); }, 1_000);
  expect(later).toBe(turns[1]);
  // A turn cancelled because the client disconnected (app restart) continues the same way.
  const cancelledTurns: string[] = [];
  const resumed = await externalNativeRequest(new Request("http://localhost/v1/responses", { method: "POST",
    body: JSON.stringify({ model: "m", prompt_cache_key: "sess-cancelled", input: [system, user("go"), call, output, user("continue")] }) }), async native => {
    cancelledTurns.push(turnOf(await native.json()).turn_id);
    return cancelledTurns.length === 1
      ? Response.json({ error: { type: "client_closed_request", code: "client_cancelled", message: "observer disconnected" } }, { status: 400 })
      : sse({ type: "response.created" }, { type: "response.completed" });
  }, 1_000);
  expect(resumed.status).toBe(200);
  expect(cancelledTurns.length).toBe(2);
  expect(cancelledTurns[1]).not.toBe(cancelledTurns[0]);
  const live = sse({ type: "response.created" }, { type: "response.output_text.delta", delta: "hi" }, { type: "response.completed" });
  const expected = await live.clone().text();
  const passed = await externalNativeRequest(new Request("http://localhost/v1/responses", { method: "POST",
    body: JSON.stringify({ model: "m", prompt_cache_key: "sess-live", input: [system, user("go")] }) }), async () => live, 1_000);
  expect(await passed.text()).toBe(expected);
});

test("codex_exec maps onto an external client's shell tool, keeping the working directory", () => {
  const shell = { name: "shell", parameters: { type: "object", properties: { command: { type: "string" }, wait_ms: { type: "integer" } } } } as any;
  expect(externalShellArguments(shell, "git status", undefined, undefined, "win32")).toEqual({ command: "git status" });
  expect(externalShellArguments(shell, "git status", "D:\\it's", 500, "win32"))
    .toEqual({ command: "Set-Location -LiteralPath 'D:\\it''s'; git status", wait_ms: 1_000 });
  expect(externalShellArguments(shell, "ls", "/tmp/a'b", 5_000, "linux")).toEqual({ command: "cd '/tmp/a'\\''b' && ls", wait_ms: 5_000 });
  expect(externalShellArguments({ name: "shell", parameters: { type: "object", properties: { cmd: {} } } } as any, "ls")).toBeUndefined();
});

test("external requests without a working directory or with server-side continuation are refused", () => {
  const tools = [{ type: "function", name: "shell", parameters: { type: "object", properties: {} } }];
  expect(() => nativeShapedExternalBody({ prompt_cache_key: "s", tools, input: [user("hi")] })).toThrow("Cwd:");
  // A tool-less request (a provider connection test) needs no project root and runs in the home folder.
  const probe = shape([user("hi")]);
  expect(probe.input[0].content[0].text).toContain(`<cwd>${homedir()}</cwd>`);
  expect(() => nativeShapedExternalBody({ previous_response_id: "r", input: [system, user("hi")] })).toThrow("previous_response_id");
});

test("HTTP admission routes authenticated external requests through the native adapter and persists a private token", async () => {
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  const home = mkdtempSync(join(tmpdir(), "cgw-external-"));
  process.env.CODEX_CHATGPT_WEB_HOME = home;
  const seen: any[] = [];
  let retiredOnce = false;
  const server = startServer({ ...defaultConfig("browser-only"), port: 0 }, {
    adapterFactory: () => ({ name: "native-fixture", async runTurn(parsed, _incoming, emit) {
      seen.push(parsed._rawBody);
      if ((parsed._rawBody as any).prompt_cache_key?.startsWith("sess-retired:") && !retiredOnce) {
        retiredOnce = true;
        throw chatGptToolTimeoutError("grep", 90_000);
      }
      emit({ type: "text_delta", text: "native" });
      emit({ type: "done" });
    } }),
  });
  try {
    const secret = readFileSync(externalTokenPath(), "utf8").trim();
    expect(secret).toMatch(/^cwext_[a-f0-9]{64}$/);
    if (process.platform === "win32") {
      const proof = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "$a=[IO.File]::GetAccessControl($env:CGW_TOKEN_TEST); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if(@($a.Access | Where-Object {$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid}).Count){exit 1}"], {
        env: { ...process.env, CGW_TOKEN_TEST: externalTokenPath() }, stdio: "pipe",
      });
      expect(proof.length).toBe(0);
    } else expect(statSync(externalTokenPath()).mode & 0o777).toBe(0o600);
    const base = `http://127.0.0.1:${server.port}`;
    const send = (authorization?: string, input: unknown = "OK") => fetch(`${base}/v1/responses`, { method: "POST",
      headers: authorization ? { authorization } : {}, body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", input }) });
    expect((await send()).status).toBe(200);
    expect((await send("Bearer codex-placeholder")).status).toBe(200);
    expect(seen.length).toBe(2);
    expect((await send(`Bearer ${secret}wrong`)).status).toBe(401);
    const toolsWithoutCwd = await fetch(`${base}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", tools: [{ type: "function", name: "shell", parameters: { type: "object", properties: {} } }], input: [user("no cwd")] }) });
    expect(toolsWithoutCwd.status).toBe(400);
    expect((await send(`Bearer ${secret}`, [system, user("hi")])).status).toBe(200);
    expect(seen.length).toBe(3);
    expect(JSON.parse(seen[2].client_metadata["x-codex-turn-metadata"]).turn_id).toBeString();
    // A late tool result for a retired turn continues over HTTP as a new native turn, not a refusal.
    const call = { type: "function_call", call_id: "c7", name: "grep", arguments: "{}" };
    const late = await fetch(`${base}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", prompt_cache_key: "sess-retired", stream: true,
        input: [system, user("go"), call, { type: "function_call_output", call_id: "c7", output: "late" }] }) });
    const lateText = await late.text();
    expect(late.status).toBe(200);
    expect(lateText).not.toContain("codex_tool_timeout");
    expect(lateText).toContain("native");
    expect(seen.length).toBe(5);
    const turnIds = seen.slice(3).map(body => JSON.parse(body.client_metadata["x-codex-turn-metadata"]).turn_id);
    expect(turnIds[1]).not.toBe(turnIds[0]);
    const catalog = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${secret}` } });
    expect((await catalog.json() as any).data[0].id).toBe("chatgpt-web/gpt-5.6-sol");
  } finally {
    await server.stop(true);
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
