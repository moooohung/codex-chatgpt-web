import { expect, test } from "bun:test";
import { externalAuthorization, externalResponseRequest } from "../src/external-client";
import { defaultConfig } from "../src/config";
import { externalTokenPath } from "../src/external-client";
import { startServer } from "../src/server";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const token = `cwext_${"a".repeat(64)}`;
test("external mode requires the reserved bearer token; native Codex headers stay unchanged", () => {
  const request = (authorization?: string) => new Request("http://localhost/v1/responses", { headers: authorization ? { authorization } : {} });
  expect(externalAuthorization(request(), "127.0.0.1", token)).toBe("native");
  expect(externalAuthorization(request("Bearer codex-placeholder"), "127.0.0.1", token)).toBe("native");
  expect(externalAuthorization(request(`Bearer ${token}wrong`), "127.0.0.1", token)).toBe(401);
  expect(externalAuthorization(request(`Bearer ${token}`), "192.168.1.1", token)).toBe(403);
  expect(externalAuthorization(request(`Bearer ${token}`), undefined, token)).toBe(403);
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(externalAuthorization(request(`Bearer ${token}`), ip, token)).toBe("external");
});

test("external function round trip uses Responses calls and accepts function_call_output without native authority", async () => {
  const config = defaultConfig("full");
  const tools = [{ type: "function", name: "lookup", description: "Lookup", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } }];
  const request = (input: unknown, stream = false) => new Request("http://localhost/v1/responses", { method: "POST",
    body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", input, tools, stream }) });
  const first = await externalResponseRequest(request("lookup hello"), config, async turn => {
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
  const second = await externalResponseRequest(continuation, config, async turn => {
    expect((await turn.prepare()).text).toContain('"output":"world"');
    return '{"text":"world","calls":[]}';
  });
  const sse = await second.text();
  expect(sse).toContain("response.output_text.delta");
  expect(sse).toContain("response.completed");
  expect(sse).toContain("world");
  const streamed = await externalResponseRequest(request("lookup", true), config,
    async () => '{"text":"","calls":[{"name":"lookup","arguments":{"key":"x"}}]}');
  const events = await streamed.text();
  for (const name of ["response.output_item.added", "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.output_item.done", "response.completed"]) expect(events).toContain(name);
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
