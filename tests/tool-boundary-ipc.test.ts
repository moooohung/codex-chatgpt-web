import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { waitForChatGptToolBoundaryAck } from "../src/adapters/chatgpt-web/tool-boundary";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

test("real helper capture sends a revision ACK through production IPC before the daemon releases tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-boundary-ipc-")), helper = join(root, "helper.ts"), descriptor = join(root, "host.json");
  writeFileSync(helper, `
    import { ChatGptBrowserWorker, ChatGptCompletionTracker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    import { setChatGptToolBoundaryTrace } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/tool-boundary.ts", import.meta.url).href)};
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      await turn.onPreparedSelected(false); await turn.prepare();
      const progress = turn.externalProgress;
      while (progress.snapshot().lastToolBatchRevision === 0) await progress.waitForChange(0, turn.abortSignal);
      const tracker = new ChatGptCompletionTracker(); setChatGptToolBoundaryTrace(tracker, turn.traceId);
      this.submissionDomState = async () => ({ responseIdentities: [] });
      await this.observeSubmissionToolBoundary({}, { initialTurnIdentities: [], domCache: {} }, turn.abortSignal, progress, tracker);
      return "boundary confirmed";
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `);
  writeFileSync(descriptor, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid,
    endpoint: "http://127.0.0.1:39001", control: { endpoint: "http://127.0.0.1:39002", token: "offline-fixture-control-0123456789abcdef" },
    helper: { executable: process.execPath, script: helper }, partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB", surfaceTargets: { launcher_surface_id_0123456789AB: "fixture-target" }, createdAt: new Date().toISOString() }), { mode: 0o600 });
  const client = new LauncherBrowserHelperClient({ appName: "Codex Native2", browserHost: "launcher", browserHostDescriptorPath: descriptor,
    browserHelperScriptPath: helper, storageStatePath: join(root, "unused.json"), chromeExecutablePath: join(root, "unused"),
    turnTimeoutMs: 1000, headed: true, autoApproveToolCalls: false, useSavedChats: true });
  const progress = new ChatGptExternalTurnProgress(), revision = progress.recordToolBatch(1);
  const gateLifetime = new AbortController();
  let gate: Promise<void> | undefined;
  let released = false;
  try {
    // The integration gate also includes cold helper process startup on shared runners.
    gate = waitForChatGptToolBoundaryAck({ traceId: "146b3b30d06b", revision, timeoutMs: 10_000, signal: gateLifetime.signal,
      wait: signal => progress.waitForToolBatchObservation(revision, signal) }).then(() => { released = true; });
    // Handle an early helper failure immediately, then still assert the gate below.
    void gate.catch(() => {});
    const result = await client.run({ traceId: "146b3b30d06b", modelId: "gpt-5.6-sol", reasoning: "high", externalProgress: progress,
      capabilities: { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false },
      prepare: async () => ({ text: "fixture", images: [], release() {} }), onTextDelta() {}, onReasoningSummary() {} });
    await gate;
    expect(result).toBe("boundary confirmed"); expect(released).toBe(true);
  } finally {
    gateLifetime.abort(new DOMException("Fixture cleanup", "AbortError"));
    await gate?.catch(() => {});
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
