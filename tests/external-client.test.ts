import { expect, test } from "bun:test";
import { createExternalContinuationStore, EXTERNAL_INLINE_REQUEST_CHARS, EXTERNAL_REQUEST_FILE, externalAuthorization,
  externalResponseRequest, parseExternalEnvelope } from "../src/external-client";
import { createResponseStateStore } from "../src/responses/state";
import { validateSkillFiles } from "../src/adapters/chatgpt-web/skill-attachments";
import { defaultConfig } from "../src/config";
import { externalTokenPath } from "../src/external-client";
import { startServer } from "../src/server";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const token = `cwext_${"a".repeat(64)}`;
test("external envelopes survive rendered-Markdown fences, escapes and prose; invalid text is rejected", () => {
  const plain = { text: "OK", calls: [] };
  expect(parseExternalEnvelope(JSON.stringify(plain))).toEqual(plain);
  expect(parseExternalEnvelope('{"text":"OK","calls":\\[\\]}')).toEqual(plain);
  expect(parseExternalEnvelope("```json\n{\"text\":\"OK\",\"calls\":[]}\n```")).toEqual(plain);
  expect(parseExternalEnvelope('Here you go:\n{"text":"a\\_b \\"q\\" \\\\ line\\nnext","calls":\\[\\]}')).toEqual(
    { text: "a_b \"q\" \\ line\nnext", calls: [] });
  expect(parseExternalEnvelope('{"text":"","calls":\\[{"name":"read","arguments":{"path":"a\\\\b"}}\\]}')).toEqual(
    { text: "", calls: [{ name: "read", arguments: { path: "a\\b" } }] });
  expect(parseExternalEnvelope('```\n{"text":":chatgpt-content-reference{"ref":"turn0file0"}done","calls":[]}\n```')).toEqual(
    { text: "done", calls: [] });
  expect(() => parseExternalEnvelope("OK")).toThrow("Invalid external model response envelope");
  expect(() => parseExternalEnvelope('{"text":1,"calls":[]}')).toThrow("Invalid external model response envelope");
});
test("external mode requires the reserved bearer token; native Codex headers stay unchanged", () => {
  const request = (authorization?: string) => new Request("http://localhost/v1/responses", { headers: authorization ? { authorization } : {} });
  expect(externalAuthorization(request(), "127.0.0.1", token)).toBe("native");
  expect(externalAuthorization(request("Bearer codex-placeholder"), "127.0.0.1", token)).toBe("native");
  expect(externalAuthorization(request(`Bearer ${token}wrong`), "127.0.0.1", token)).toBe(401);
  expect(externalAuthorization(request(`Bearer ${token}`), "192.168.1.1", token)).toBe(403);
  expect(externalAuthorization(request(`Bearer ${token}`), undefined, token)).toBe(403);
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(externalAuthorization(request(`Bearer ${token}`), ip, token)).toBe("external");
});

test("string-encoded function arguments are accepted; undeclared functions are rejected by name", async () => {
  const config = defaultConfig("full");
  const state = createExternalContinuationStore(token);
  const tools = [{ type: "function", name: "lookup", parameters: { type: "object", properties: { key: { type: "string" } } } }];
  const call = (answer: string) => externalResponseRequest(new Request("http://localhost/v1/responses", { method: "POST",
    body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", input: "go", tools }) }), config, state, async () => answer);
  const ok = await (await call('{"text":"","calls":[{"name":"lookup","arguments":"{\\"key\\":\\"x\\"}"}]}')).json() as any;
  expect(ok.status).toBe("completed");
  expect(JSON.parse(ok.output.find((item: any) => item.type === "function_call").arguments)).toEqual({ key: "x" });
  // ChatGPT Web reports no usage; the estimate must still let clients track context.
  expect(ok.usage.input_tokens).toBeGreaterThan(0);
  expect(ok.usage.output_tokens).toBeGreaterThan(0);
  expect(ok.usage.total_tokens).toBe(ok.usage.input_tokens + ok.usage.output_tokens);
  const bad = await (await call('{"text":"","calls":[{"name":"nope","arguments":{}}]}')).json() as any;
  expect(bad.status).toBe("failed");
  expect(JSON.stringify(bad.error)).toContain("undeclared function");
});

test("visible ChatGPT reasoning summaries stream to external clients as reasoning progress", async () => {
  const config = defaultConfig("full");
  const state = createExternalContinuationStore(token);
  const response = await externalResponseRequest(new Request("http://localhost/v1/responses", { method: "POST",
    body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", input: "hi", stream: true }) }), config, state, async turn => {
    turn.onReasoningSummary?.("Reading the request");
    turn.onCommentary?.("Checking the tools");
    turn.onTextDelta('{"text":"ok","calls":[]}');
    return '{"text":"ok","calls":[]}';
  });
  const sse = await response.text();
  expect(sse).toContain("response.reasoning_summary_text.delta");
  expect(sse).toContain("Reading the request");
  expect(sse).toContain("Checking the tools");
  expect(sse).toContain("response.completed");
});

test("large external requests travel as an attached file and keep the inline prompt small", async () => {
  const config = defaultConfig("full");
  const state = createExternalContinuationStore(token);
  const big = "x".repeat(EXTERNAL_INLINE_REQUEST_CHARS * 3);
  const small = "hello";
  const call = (input: string) => externalResponseRequest(new Request("http://localhost/v1/responses", { method: "POST",
    body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", input }) }), config, state, async turn => {
    const prepared = await turn.prepare();
    if (input === big) {
      expect(prepared.text.length).toBeLessThan(EXTERNAL_INLINE_REQUEST_CHARS);
      expect(prepared.text).toContain(EXTERNAL_REQUEST_FILE);
      expect(prepared.skillFiles).toHaveLength(1);
      expect(() => validateSkillFiles(prepared.skillFiles)).not.toThrow();
      expect(prepared.skillFiles![0]!.name.startsWith(`${EXTERNAL_REQUEST_FILE}--`)).toBeTrue();
      expect(prepared.text).toContain(prepared.skillFiles![0]!.name);
      expect(JSON.parse(prepared.skillFiles![0]!.text).input).toBe(big);
    } else {
      expect(prepared.skillFiles).toBeUndefined();
      expect(prepared.text).toContain('"input":"hello"');
    }
    return '{"text":"ok","calls":[]}';
  });
  expect((await (await call(big)).json() as any).status).toBe("completed");
  expect((await (await call(small)).json() as any).status).toBe("completed");
});

test("external function round trip uses Responses calls and accepts function_call_output without native authority", async () => {
  const config = defaultConfig("full");
  const state = createExternalContinuationStore(token);
  const tools = [{ type: "function", name: "lookup", description: "Lookup", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } }];
  const request = (input: unknown, stream = false) => new Request("http://localhost/v1/responses", { method: "POST",
    body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", input, tools, stream }) });
  const first = await externalResponseRequest(request("lookup hello"), config, state, async turn => {
    expect(turn.capabilities.localToolsEnabled).toBeFalse();
    expect(turn.nativeConnector).toBeUndefined();
    expect(turn.conversationKey).toBeUndefined();
    expect((await turn.prepare()).text).toContain('"name":"lookup"');
    return JSON.stringify({ text: "", calls: [{ name: "lookup", arguments: { key: "hello" } }] });
  });
  const result = await first.json() as any;
  expect(result.status).toBe("completed");
  const call = result.output.find((item: any) => item.type === "function_call");
  expect(call.name).toBe("lookup");
  expect(JSON.parse(call.arguments)).toEqual({ key: "hello" });
  const continuation = new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({
    model: "chatgpt-web/gpt-5.6-sol", previous_response_id: result.id, tools, stream: true,
    input: [{ type: "function_call_output", call_id: call.call_id, output: "world" }],
  }) });
  const second = await externalResponseRequest(continuation, config, state, async turn => {
    expect((await turn.prepare()).text).toContain('"output":"world"');
    return '{"text":"world","calls":[]}';
  });
  const sse = await second.text();
  expect(sse).toContain("response.output_text.delta");
  expect(sse).toContain("response.completed");
  expect(sse).toContain("world");
  const streamed = await externalResponseRequest(request("lookup", true), config, state,
    async () => '{"text":"","calls":[{"name":"lookup","arguments":{"key":"x"}}]}');
  const events = await streamed.text();
  for (const name of ["response.output_item.added", "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.output_item.done", "response.completed"]) expect(events).toContain(name);
});

test("continuations isolate native and authenticated external histories, persistence and eviction", () => {
  const home = mkdtempSync(join(tmpdir(), "cgw-state-scope-"));
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = home;
  try {
    const native = createResponseStateStore({ snapshotPath: () => join(home, "responses-state.json") });
    const external = createExternalContinuationStore(token);
    const other = createExternalContinuationStore(`cwext_${"b".repeat(64)}`);
    const remember = (store: typeof native, id: string, text: string) =>
      store.rememberResponseState({ input: text }, { id, output: [], status: "completed" });
    remember(native, "native-id", "PRIVATE NATIVE");
    remember(external, "external-id", "external");
    native.flushResponseState(); external.flushResponseState();
    const probe = (id: string) => ({ previous_response_id: id, input: "next" });
    const nativeProbe = probe("native-id"), externalProbe = probe("external-id");
    expect(external.expandPreviousResponseInput(nativeProbe)).toBe(nativeProbe);
    expect(native.expandPreviousResponseInput(externalProbe)).toBe(externalProbe);
    expect(other.expandPreviousResponseInput(externalProbe)).toBe(externalProbe);
    const reloaded = createExternalContinuationStore(token);
    expect(reloaded.expandPreviousResponseInput(nativeProbe)).toBe(nativeProbe);
    expect((reloaded.expandPreviousResponseInput(externalProbe) as any).input).toEqual([{ role: "user", content: "external" }, { role: "user", content: "next" }]);
    for (let i = 0; i < 129; i++) remember(external, `ext-${i}`, "bounded");
    expect(external.expandPreviousResponseInput(externalProbe)).toBe(externalProbe);
    expect(native.expandPreviousResponseInput(nativeProbe)).not.toBe(nativeProbe);
    external.flushResponseState();
  } finally {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("HTTP admission preserves native traffic, rejects bad external tokens and persists a private token", async () => {
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  const home = mkdtempSync(join(tmpdir(), "cgw-external-"));
  process.env.CODEX_CHATGPT_WEB_HOME = home;
  let native = 0, external = 0;
  const server = startServer({ ...defaultConfig("browser-only"), port: 0 }, {
    adapterFactory: () => ({ name: "native-fixture", async runTurn(_parsed, _incoming, emit) {
      native++;
      emit({ type: "text_delta", text: "native" });
      emit({ type: "done" });
    } }),
    externalBrowserRun: async () => { external++; return '{"text":"external","calls":[]}'; },
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
    const send = (authorization?: string) => fetch(`${base}/v1/responses`, { method: "POST",
      headers: authorization ? { authorization } : {}, body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", input: "OK" }) });
    expect((await send()).status).toBe(200);
    expect((await send("Bearer codex-placeholder")).status).toBe(200);
    expect(native).toBe(2);
    expect(external).toBe(0);
    expect((await send(`Bearer ${secret}wrong`)).status).toBe(401);
    expect((await send(`Bearer ${secret}`)).status).toBe(200);
    expect(external).toBe(1);
    const catalog = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${secret}` } });
    expect((await catalog.json() as any).data[0].id).toBe("chatgpt-web/gpt-5.6-sol");
  } finally {
    await server.stop(true);
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
