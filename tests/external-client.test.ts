import { expect, test } from "bun:test";
import { externalAuthorization, externalTokenPath, nativeShapedExternalBody } from "../src/external-client";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
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
  expect(thread_id).toBe("sess-1");
  expect(body.prompt_cache_key).toBe("sess-1");
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

test("external requests without a working directory or with server-side continuation are refused", () => {
  expect(() => shape([user("hi")])).toThrow("Cwd:");
  expect(() => nativeShapedExternalBody({ previous_response_id: "r", input: [system, user("hi")] })).toThrow("previous_response_id");
});

test("HTTP admission routes authenticated external requests through the native adapter and persists a private token", async () => {
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  const home = mkdtempSync(join(tmpdir(), "cgw-external-"));
  process.env.CODEX_CHATGPT_WEB_HOME = home;
  const seen: any[] = [];
  const server = startServer({ ...defaultConfig("browser-only"), port: 0 }, {
    adapterFactory: () => ({ name: "native-fixture", async runTurn(parsed, _incoming, emit) {
      seen.push(parsed._rawBody);
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
    expect((await send(`Bearer ${secret}`, [user("no cwd")])).status).toBe(400);
    expect((await send(`Bearer ${secret}`, [system, user("hi")])).status).toBe(200);
    expect(seen.length).toBe(3);
    expect(JSON.parse(seen[2].client_metadata["x-codex-turn-metadata"]).turn_id).toBeString();
    const catalog = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${secret}` } });
    expect((await catalog.json() as any).data[0].id).toBe("chatgpt-web/gpt-5.6-sol");
  } finally {
    await server.stop(true);
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
