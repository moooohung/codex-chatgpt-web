import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";

test.each([false, true])("actual fresh/resumed lease plan reaches preparation before any browser Send (resumed=%s)", async reused => {
  const root = mkdtempSync(join(tmpdir(), "account-context-worker-"));
  const events: string[] = [];
  let lease = 0;
  const plans = ["pro", "plus"] as const;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { phase: string };
    if (body.phase === "start") return Response.json({ surfaceId: "a".repeat(32), reused, connectorBound: false,
      accountContext: { accountKey: (lease ? "b" : "a").repeat(64), planType: plans[lease++] } });
    events.push(body.phase);
    return Response.json({ cancelledByUser: false });
  } });
  const descriptor = join(root, "host.json");
  const endpoint = `http://127.0.0.1:${server.port}`;
  writeFileSync(descriptor, JSON.stringify({ version: 3, kind: "codex-web-gpt-launcher", profile: "production", pid: process.pid,
    endpoint, control: { endpoint, token: "t".repeat(43) }, partition: "persist:codex-web-gpt-chatgpt",
    helper: { executable: process.execPath, script: import.meta.path }, idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "a".repeat(32), surfaceTargets: {}, createdAt: new Date().toISOString() }));
  const caps = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: false };
  const prepare = async (account: any) => {
    events.push(`prepare:${account.planType}:${account.capabilities.proAvailable}`);
    return { text: account.planType, images: [], release() {} };
  };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "launcher", browserHostDescriptorPath: descriptor },
    async runBrowserTurn(turn: any) {
      const prompt = await (reused ? turn.prepareResume : turn.prepare)();
      expect(turn.capabilities.proAvailable).toBe(prompt.text === "pro");
      events.push(`browser:${prompt.text}`);
      return prompt.text;
    },
  });
  try {
    const turn = { traceId: "tier-fixture", modelId: "gpt-5.6-sol", modelFamily: "6", reasoning: "high", capabilities: caps,
      prepare, prepareResume: prepare, onAccountSelected: (account: any) => { events.push(`selected:${account.planType}`); } };
    expect(await worker.runLauncherTurn(turn, () => {})).toBe("pro");
    expect(await worker.runLauncherTurn(turn, () => {})).toBe("plus");
    expect(events.filter(e => /^(selected|prepare|browser):/.test(e))).toEqual([
      "selected:pro", "prepare:pro:true", "browser:pro", "selected:plus", "prepare:plus:false", "browser:plus",
    ]);
    expect(caps.proAvailable).toBeFalse();
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test("missing actual account proof releases the exact lease without preparing or sending", async () => {
  const root = mkdtempSync(join(tmpdir(), "account-context-missing-"));
  const phases: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { phase: string };
    phases.push(body.phase);
    return Response.json(body.phase === "start" ? { surfaceId: "a".repeat(32), reused: false, connectorBound: false }
      : { cancelledByUser: false });
  } });
  const descriptor = join(root, "host.json");
  const endpoint = `http://127.0.0.1:${server.port}`;
  writeFileSync(descriptor, JSON.stringify({ version: 3, kind: "codex-web-gpt-launcher", profile: "production", pid: process.pid,
    endpoint, control: { endpoint, token: "t".repeat(43) }, partition: "persist:codex-web-gpt-chatgpt",
    helper: { executable: process.execPath, script: import.meta.path }, idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "a".repeat(32), surfaceTargets: {}, createdAt: new Date().toISOString() }));
  let prepares = 0;
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "launcher", browserHostDescriptorPath: descriptor },
    runBrowserTurn() { throw new Error("must not run"); },
  });
  try {
    await expect(worker.runLauncherTurn({ traceId: "missing-tier", capabilities: { proAvailable: true },
      prepare() { prepares++; throw new Error("must not prepare"); } }, () => {}))
      .rejects.toBeInstanceOf(ChatGptWebAdapterError);
    expect(prepares).toBe(0);
    expect(phases).toEqual(["start", "end"]);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
