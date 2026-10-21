import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

type BrowserInternals = {
  runExclusive(turn: BrowserTurn): Promise<string>;
  runBrowserTurn(turn: BrowserTurn, surface?: string, page?: unknown, reused?: boolean,
    trackUsage?: boolean, onFailure?: (error: unknown) => Promise<void>, onCompleted?: () => Promise<void>): Promise<string>;
};

function fixture(options: { failurePart?: number; activation?: BrowserTurn["onSendActivated"]; signal?: AbortSignal } = {}) {
  const root = mkdtempSync(join(tmpdir(), "account-context-multipart-send-"));
  const phases: string[] = [];
  const actions: string[] = [];
  const plans: string[] = [];
  let leases = 0;
  let preparations = 0;
  let releases = 0;
  let physicalSends = 0;
  let acknowledgedParts = 0;
  let activations = 0;
  let stage = "";
  const rateLimit = new ChatGptWebAdapterError("Offline timed account limit", {
    status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: false,
    retryAt: Date.now() + 60_000, retryAfterSeconds: 60,
  });
  // Only an inert loopback launcher control endpoint is used. An alternate is always available.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { phase: string };
    phases.push(body.phase);
    if (body.phase === "start") {
      const planType = leases++ === 0 ? "pro" : "plus";
      return Response.json({ surfaceId: "a".repeat(32), reused: false, connectorBound: false,
        accountContext: { accountKey: (planType === "pro" ? "a" : "b").repeat(64), planType } });
    }
    return Response.json(body.phase === "cooldown" ? { ok: true, alternateAvailable: true } : { cancelledByUser: false });
  } });
  const descriptor = join(root, "host.json");
  const endpoint = `http://127.0.0.1:${server.port}`;
  writeFileSync(descriptor, JSON.stringify({ version: 3, kind: "codex-web-gpt-launcher", profile: "production",
    pid: process.pid, endpoint, control: { endpoint, token: "t".repeat(43) },
    partition: "persist:codex-web-gpt-chatgpt", helper: { executable: process.execPath, script: import.meta.path },
    idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId: "a".repeat(32), surfaceTargets: {}, createdAt: new Date().toISOString() }), { mode: 0o600 });
  const page = Object.assign(new EventEmitter(), {
    evaluateHandle: async () => ({ evaluate: async () => false, dispose: async () => {} }),
    evaluate: async () => ({}), isClosed: () => false, mainFrame: () => ({}),
  });
  const realBrowserTurn = (ChatGptBrowserWorker.prototype as unknown as BrowserInternals).runBrowserTurn;
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "Offline multipart fixture", browserHost: "launcher", browserHostDescriptorPath: descriptor,
      browserDiagnosticsPath: join(root, "diagnostics") },
    runBrowserTurn(turn: BrowserTurn, surface?: string, _page?: unknown, reused?: boolean, trackUsage?: boolean,
      onFailure?: (error: unknown) => Promise<void>, onCompleted?: () => Promise<void>) {
      // Keep real launcher failover and real multipart orchestration; replace only the browser surface.
      return realBrowserTurn.call(this, turn, surface, page, reused, trackUsage, onFailure, onCompleted);
    },
    async runStage(_trace: string, name: string, _timeout: number, action: (signal: AbortSignal) => Promise<unknown>) {
      stage = name;
      return action(new AbortController().signal);
    },
    prepareChatSurface: async () => {},
    selectModelAndEffort: async (_page: unknown, model: string, effort: string, capabilities: BrowserTurn["capabilities"]) =>
      resolveChatGptWebModelMode(model, effort, capabilities),
    captureSubmissionBaseline: async () => ({}),
    attachPrompt: async () => {},
    async sendAttachedPrompt(_page: unknown, _baseline: unknown, _capture: unknown, signal: AbortSignal,
      _progress: unknown, lifecycle: Pick<BrowserTurn, "onSendActivated" | "onSubmitted">) {
      expect(stage).toMatch(/^multipart_stage_\d+_send$/);
      expect(lifecycle.onSubmitted).toBeUndefined();
      // Invoke the actual callback constructed by runBrowserTurn before simulated physical Send.
      await lifecycle.onSendActivated?.();
      signal.throwIfAborted();
      physicalSends++;
      actions.push(`send:${physicalSends}`);
      return "user_turn";
    },
    async waitForNewAssistantTurn() {
      if (physicalSends >= (options.failurePart ?? 1)) {
        // A timed 429 arrives after physical activation but before the exact assistant ACK.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        throw rateLimit;
      }
      return {};
    },
    waitForMultipartAcknowledgement: async () => ({ identity: `inert-ack-${physicalSends}` }),
  }) as BrowserInternals;
  const turn: BrowserTurn = {
    traceId: "multipart_activation_fixture", modelId: "gpt-5.6-sol", modelFamily: "6", reasoning: "high",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    abortSignal: options.signal,
    onAccountSelected: account => { plans.push(account.planType); },
    prepare: async () => {
      preparations++;
      return { text: "Inert final prompt", images: [], multipart: {
        parts: Array.from({ length: 4 }, (_, i) => JSON.stringify({ part: i + 1, records: [] })), commit: "Inert commit",
      }, release: () => { releases++; } };
    },
    onSendActivated: async () => {
      activations++;
      actions.push(`activate:${activations}`);
      await options.activation?.();
    },
    onMultipartStageAcknowledged: () => { acknowledgedParts++; },
    onTextDelta() {},
  };
  return {
    rateLimit, actions, phases, plans, run: () => worker.runExclusive(turn),
    snapshot: () => ({ leases, preparations, releases, physicalSends, acknowledgedParts, activations }),
    close() { server.stop(true); rmSync(root, { recursive: true, force: true }); },
  };
}

test.each([1, 2, 3])("real early multipart part %s activation prevents timed-429 account replay before ACK", async failurePart => {
  const f = fixture({ failurePart });
  try {
    await expect(f.run()).rejects.toBe(f.rateLimit);
    expect(f.snapshot()).toEqual({ leases: 1, preparations: 1, releases: 1, physicalSends: failurePart,
      acknowledgedParts: failurePart - 1, activations: failurePart });
    expect(f.actions).toEqual(Array.from({ length: failurePart }, (_, i) => [`activate:${i + 1}`, `send:${i + 1}`]).flat());
    expect(f.plans).toEqual(["pro"]);
    expect(f.phases.filter(phase => phase === "start")).toHaveLength(1);
    expect(f.phases).toContain("cooldown");
    expect(f.phases).toContain("end");
  } finally { f.close(); }
});

test("early multipart physical Send waits for the activation ACK", async () => {
  const entered = deferred();
  const ack = deferred();
  const f = fixture({ activation: async () => { entered.resolve(); await ack.promise; } });
  const running = f.run();
  void running.catch(() => {});
  try {
    await entered.promise;
    expect(f.snapshot()).toMatchObject({ leases: 1, preparations: 1, activations: 1, physicalSends: 0, acknowledgedParts: 0 });
    ack.resolve();
    await expect(running).rejects.toBe(f.rateLimit);
    expect(f.snapshot()).toMatchObject({ leases: 1, preparations: 1, physicalSends: 1, releases: 1 });
  } finally { ack.resolve(); await running.catch(() => {}); f.close(); }
});

test.each(["cancel", "handoff"] as const)("%s during an in-flight activation ACK cannot Send or replay", async reason => {
  const entered = deferred();
  const ack = deferred();
  const controller = new AbortController();
  const failure = reason === "handoff" ? new ChatGptCompactionHandoffAccepted() : new DOMException("Offline cancellation", "AbortError");
  const f = fixture({ signal: controller.signal, activation: async () => { entered.resolve(); await ack.promise; } });
  const running = f.run();
  void running.catch(() => {});
  try {
    await entered.promise;
    controller.abort(failure);
    ack.resolve();
    if (reason === "handoff") await expect(running).rejects.toBe(failure);
    else await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(f.snapshot()).toEqual({ leases: 1, preparations: 1, releases: 1, physicalSends: 0, acknowledgedParts: 0, activations: 1 });
    expect(f.plans).toEqual(["pro"]);
    expect(f.phases).not.toContain("cooldown");
  } finally { ack.resolve(); await running.catch(() => {}); f.close(); }
});
