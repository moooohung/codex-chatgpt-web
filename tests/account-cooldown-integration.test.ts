import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitLauncherAccount, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { buildResponseJSON } from "../src/bridge";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { parseRequest } from "../src/responses/parser";

function descriptor(root: string, endpoint: string) {
  const file = join(root, "browser-host.json");
  writeFileSync(file, JSON.stringify({ version: 3, kind: "codex-web-gpt-launcher", profile: "production", pid: process.pid,
    endpoint, control: { endpoint, token: "t".repeat(43) }, partition: "persist:codex-web-gpt-chatgpt",
    helper: { executable: process.execPath, script: import.meta.path },
    idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId: "a".repeat(32), surfaceTargets: {}, createdAt: new Date().toISOString() }), { mode: 0o600 });
  return file;
}

test("new HTTP admission retains account retry timestamp and delay without starting a turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "cooldown-client-"));
  const retryAt = Date.now() + 60_000;
  const paths: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    paths.push(new URL(request.url).pathname);
    return Response.json({ code: "chatgpt_account_cooldown", error: "Wait until the displayed time", retryAt, retry_after_seconds: 60 },
      { status: 429, headers: { "retry-after": "60" } });
  } });
  try {
    await expect(admitLauncherAccount(descriptor(root, `http://127.0.0.1:${server.port}`), { helperPid: process.pid }))
      .rejects.toMatchObject({ status: 429, code: "chatgpt_account_cooldown", retryAt, retryAfterSeconds: 60, retryable: false });
    expect(paths).toEqual(["/v1/account/admit"]);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test.each([false, true])("account fallback only replays a prompt that never activated Send (sent=%s)", async sent => {
  const root = mkdtempSync(join(tmpdir(), "cooldown-failover-"));
  const phases: string[] = [];
  const error = new ChatGptWebAdapterError("We're doing a quick check to keep ChatGPT reliable. Try again in 21 minutes.", {
    status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: false,
    retryAt: Date.now() + 1260_000, retryAfterSeconds: 1260,
  });
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { phase: string };
    phases.push(body.phase);
    return Response.json(body.phase === "start" ? { surfaceId: "a".repeat(32), reused: false, connectorBound: false }
      : body.phase === "cooldown" ? { ok: true, alternateAvailable: true } : { cancelledByUser: false });
  } });
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "launcher", browserHostDescriptorPath: descriptor(root, `http://127.0.0.1:${server.port}`) },
    async runBrowserTurn(turn: { onSendActivated(): Promise<void> }) {
      if (++calls === 1) { if (sent) await turn.onSendActivated(); throw error; }
      return "alternate-account-result";
    },
  });
  try {
    const result = worker.runExclusive({ traceId: "cooldown-fixture", capabilities: { localToolsEnabled: false } });
    if (sent) await expect(result).rejects.toBe(error);
    else await expect(result).resolves.toBe("alternate-account-result");
    expect(calls).toBe(sent ? 1 : 2);
    expect(phases.indexOf("cooldown")).toBeLessThan(phases.indexOf("end"));
    if (!sent) expect(phases.lastIndexOf("start")).toBeGreaterThan(phases.indexOf("end"));
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test("streamed and collected account errors retain retry metadata", () => {
  const retryAt = Date.now() + 60_000;
  const response = buildResponseJSON([{ type: "error", status: 429, errorType: "rate_limit_error",
    code: "chatgpt_account_cooldown", message: "Account temporarily limited", retryAt, retryAfterSeconds: 60, retryable: false }], "gpt-5.6-sol");
  expect(response.error).toMatchObject({ code: "chatgpt_account_cooldown", retryAt, retryAfterSeconds: 60 });
});

test("adapter preflight admits new executions but preserves reconnects owned by a separate helper PID", async () => {
  const root = mkdtempSync(join(tmpdir(), "cooldown-preflight-"));
  let admissions = 0;
  const retryAt = Date.now() + 60_000;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    admissions++;
    return Response.json({ code: "chatgpt_account_cooldown", error: "Wait until reset", retryAt, retry_after_seconds: 60 }, { status: 429 });
  } });
  const lookup = spyOn(chatGptTurnSessions, "find");
  try {
    const adapter = createChatGptWebAdapter({ adapter: "chatgpt-web", baseUrl: `browser://cooldown-preflight-${Date.now()}`,
      chatgptWeb: { localToolsEnabled: false, solAvailable: true, browserHost: "launcher",
        browserHostDescriptorPath: descriptor(root, `http://127.0.0.1:${server.port}`) } });
    const parsed = parseRequest({ model: CHATGPT_WEB_MODEL_ID, reasoning: { effort: "high" },
      prompt_cache_key: "cooldown-thread-fixture", client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "cooldown-thread-fixture", turn_id: "cooldown-turn-fixture" }),
      }, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Fixture input" }],
        internal_chat_message_metadata_passthrough: { turn_id: "cooldown-turn-fixture" } }] });
    lookup.mockReturnValue(undefined);
    await expect(adapter.prepareTurn!(parsed, { headers: new Headers() })).rejects.toMatchObject({ code: "chatgpt_account_cooldown", retryAt });
    // The execution registry, rather than a daemon/helper PID comparison, proves a reconnect.
    lookup.mockReturnValue({ touch() {} } as never);
    await adapter.prepareTurn!(parsed, { headers: new Headers() });
    expect(admissions).toBe(1);
  } finally { lookup.mockRestore(); server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
