import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, saveConfig, updateToolApprovalConfig } from "../src/config";
import { startServer } from "../src/server";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cgw-live-settings-"));
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") throw new Error("No test port");
      probe.close(error => error ? reject(error) : resolve(address.port));
    });
  });
  saveConfig({ ...defaultConfig("browser-only"), port, autoApproveToolCalls: false });
  const config = loadConfig();
  return { root, config, path: join(root, "config.json"), cleanup() {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  } };
}

test("authenticated live approvals preserve an active turn and apply only to new adapters", async () => {
  const f = await fixture();
  const snapshots: boolean[] = [];
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let first = true;
  const server = startServer(f.config, { adapterFactory: provider => {
    snapshots.push(provider.chatgptWeb!.autoApproveToolCalls === true);
    return { name: "offline-live-settings", async runTurn(_parsed, _incoming, emit) {
      if (first) { first = false; ready(); await pending; }
      emit({ type: "text_delta", text: "offline complete", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: true } });
    } };
  } });
  const base = `http://127.0.0.1:${server.port}`;
  const send = () => fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", input: "offline fixture", stream: false }) });
  const update = (enabled: boolean, expectedValue: boolean) => fetch(`${base}/admin/tool-approvals`, {
    method: "POST", headers: { authorization: `Bearer ${f.config.controlToken}`, "content-type": "application/json" },
    body: JSON.stringify({ enabled, expectedValue, expectedPid: process.pid }),
  });
  try {
    const active = send();
    await started;
    const before = await (await fetch(`${base}/healthz`)).json() as any;
    expect(before.active_http_turns).toBe(1);
    const changed = await update(true, false);
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ pid: before.pid, autoApproveToolCalls: true,
      active_http_turns: 1, applies_to: "new_turns" });
    expect(loadConfig().autoApproveToolCalls).toBeTrue();
    // A lost control response can be retried without restarting or duplicating work.
    expect((await update(true, false)).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(snapshots).toEqual([false, true]);
    finish();
    expect(await (await active).text()).toContain("offline complete");
    expect((await update(false, true)).status).toBe(200);
    expect(loadConfig().autoApproveToolCalls).toBeFalse();
    expect((await (await fetch(`${base}/healthz`)).json() as any).pid).toBe(before.pid);
  } finally { finish(); await server.stop(true); f.cleanup(); }
});

test("live settings reject unauthorized, browser-originated, malformed and stale-PID requests", async () => {
  const f = await fixture();
  const server = startServer(f.config);
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: `Bearer ${f.config.controlToken}`, "content-type": "application/json" };
  const body = { enabled: true, expectedValue: false, expectedPid: process.pid };
  const original = readFileSync(f.path, "utf8");
  try {
    for (const [extraHeaders, payload, status] of [
      [{ authorization: "Bearer wrong" }, body, 401],
      [{ origin: base }, body, 403],
      [{}, { ...body, enabled: "true" }, 400],
      [{}, { ...body, extra: true }, 400],
      [{}, { ...body, expectedPid: process.pid + 1 }, 409],
      [{}, { ...body, expectedValue: true }, 409],
    ] as const) {
      const response = await fetch(`${base}/admin/tool-approvals`, { method: "POST",
        headers: { ...headers, ...extraHeaders }, body: JSON.stringify(payload) });
      expect(response.status).toBe(status);
      await response.text();
      expect(readFileSync(f.path, "utf8")).toBe(original);
      expect(f.config.autoApproveToolCalls).toBeFalse();
    }
    await fetch(`${base}/admin/drain`, { method: "POST", headers });
    expect((await fetch(`${base}/admin/tool-approvals`, { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(409);
    expect(readFileSync(f.path, "utf8")).toBe(original);
  } finally { await server.stop(true); f.cleanup(); }
});

test("live settings never overwrite config drift or claim success after persistence failure", async () => {
  const f = await fixture();
  try {
    const drifted = { ...f.config, contextWindow: f.config.contextWindow + 1000 };
    saveConfig(drifted);
    const original = readFileSync(f.path, "utf8");
    expect(() => updateToolApprovalConfig(f.config, f.path, true, false)).toThrow("configuration changed");
    expect(readFileSync(f.path, "utf8")).toBe(original);
    expect(f.config.autoApproveToolCalls).toBeFalse();
    writeFileSync(f.path, "malformed private fixture");
    expect(() => updateToolApprovalConfig(f.config, f.path, true, false)).toThrow();
    expect(readFileSync(f.path, "utf8")).toBe("malformed private fixture");
    expect(f.config.autoApproveToolCalls).toBeFalse();
  } finally { f.cleanup(); }
});

test("live approval commit preserves BOM, unknown settings and all unrelated values", async () => {
  const f = await fixture();
  try {
    const raw = { ...f.config, futureSetting: { retained: true } };
    writeFileSync(f.path, `\uFEFF${JSON.stringify(raw)}`);
    const config = loadConfig();
    updateToolApprovalConfig(config, f.path, true, false);
    const saved = readFileSync(f.path, "utf8");
    expect(saved.startsWith("\uFEFF")).toBeTrue();
    expect(JSON.parse(saved.slice(1))).toEqual({ ...raw, autoApproveToolCalls: true });
    expect(config.autoApproveToolCalls).toBeTrue();
  } finally { f.cleanup(); }
});

test("manual runtime refuses automatic approval changes without touching its config", async () => {
  const f = await fixture();
  const config = { ...f.config, browserInteractionMode: "manual" as const };
  const server = startServer(config);
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/admin/tool-approvals`, { method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
      body: JSON.stringify({ enabled: true, expectedValue: false, expectedPid: process.pid }) });
    expect(response.status).toBe(409);
    expect(loadConfig().autoApproveToolCalls).toBeFalse();
  } finally { await server.stop(true); f.cleanup(); }
});

test("acknowledged daemon shutdown cannot be undone by a late resume before cleanup starts", async () => {
  const f = await fixture();
  const server = startServer(f.config);
  const request = (action: string) => new Request(`http://127.0.0.1:${server.port}/admin/${action}`, {
    method: "POST", headers: { authorization: `Bearer ${f.config.controlToken}`, host: `127.0.0.1:${server.port}` },
  });
  try {
    expect((await server.fetch(request("drain"))).status).toBe(200);
    expect((await server.fetch(request("shutdown"))).status).toBe(200);
    expect((await server.fetch(request("resume"))).status).toBe(409);
    expect((await server.fetch(new Request(`http://127.0.0.1:${server.port}/healthz`, { headers: { host: `127.0.0.1:${server.port}` } }))).status).toBe(200);
    // Let the scheduled cleanup settle inside this fixture, before restoring its home.
    await Bun.sleep(10);
  } finally { await server.stop(true); f.cleanup(); }
});
