import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";

for (const family of ["5.6", "6"] as const)
test(`multipart preflight checks requested ${family} Extra High before any staging upload and captures before lease release`, async () => {
  const root = mkdtempSync(join(tmpdir(), "multipart-account-preflight-"));
  const calls: string[] = [];
  let closed = false, released = false;
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => closed,
    evaluate: async () => { if (closed) throw new Error("page was closed"); return {}; },
  });
  const unavailable = new ChatGptWebAdapterError("Extra High is unavailable in the current browser account", {
    status: 400, errorType: "invalid_request_error", code: "chatgpt_effort_unavailable", retryable: false,
  });
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserDiagnosticsPath: root },
    prepareChatSurface: async () => {},
    selectModelAndEffort: async (_page: unknown, _model: string, effort: string, _caps: unknown, _diagnostic: unknown, _usage: boolean, selectedFamily: string) => {
      calls.push(`selection:${selectedFamily}:${effort}`);
      throw unavailable;
    },
    attachPrompt: async () => { calls.push("attachment"); },
    sendAttachedPrompt: async () => { calls.push("send"); },
  }) as any;
  try {
    await expect(worker.runBrowserTurn({
      traceId: "account_preflight", modelId: "gpt-5.6-sol", modelFamily: family, reasoning: "xhigh",
      capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true, experimentalBiggerContext: true },
      prepare: async () => ({ text: "Summarize", images: [], multipart: { parts: ['{"part":1}', '{"part":2}'], commit: "Summarize" }, release: () => { released = true; } }),
      onTextDelta() {},
    }, undefined, page, false, false, async () => {
      const dir = join(root, readdirSync(root)[0]!);
      const failed = readdirSync(dir).find(file => file.endsWith("turn-failed.json"));
      expect(failed).toBeDefined();
      const evidence = JSON.parse(readFileSync(join(dir, failed!), "utf8"));
      expect(evidence.captureErrors).toBeUndefined();
      calls.push("release"); closed = true;
    })).rejects.toMatchObject({ code: "chatgpt_effort_unavailable", message: expect.stringContaining("No multipart part was sent.") });
    expect(calls).toEqual([`selection:${family}:xhigh`, "release"]);
    expect(released).toBeTrue();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
