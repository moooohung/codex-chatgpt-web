import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CompactionJournal } from "../src/adapters/chatgpt-web/compaction-journal";
import { compactionSourceHash, planLargeContextCompaction, runLargeContextCompaction } from "../src/adapters/chatgpt-web/large-context-compaction";
import { prepareCompactionStageTransport } from "../src/adapters/chatgpt-web/compaction-stage-transport";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import type { CodexParsedRequest } from "../src/types";
import { compactionStageData } from "./fixtures/compaction-stage";

function fixture(now = 1_800_000_000_000): CodexParsedRequest {
  return { modelId: "gpt-5.6-sol", stream: true, _compactionRequest: true, options: { reasoning: "xhigh" },
    context: { systemPrompt: ["Preserve original instructions and verified scope"], messages: [
      { role: "assistant", timestamp: now, content: [{ type: "text", text: 'evidence error=file:123 {"test":"failed"}\n'.repeat(22_000) }] },
      { role: "user", timestamp: now, content: "Continue the original work" },
    ] } };
}
const signal = () => new AbortController().signal;
function temporary(run: (directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "codex-compact-journal-"));
  return run(directory).finally(() => rmSync(directory, { recursive: true, force: true }));
}

test("parser receive time and native retry IDs do not alter exact source identity; real edits, images and priorities do", () => {
  const first = fixture(), next = fixture(1_800_000_003_000);
  next.previousResponseId = "new_transport_response";
  expect(compactionSourceHash(next)).toBe(compactionSourceHash(first));
  expect(planLargeContextCompaction(next)!.fragments).toEqual(planLargeContextCompaction(first)!.fragments);
  for (const change of [
    (p: CodexParsedRequest) => { p.context.systemPrompt!.push("Changed priority"); },
    (p: CodexParsedRequest) => { p.context.messages[1]!.content = "Changed task"; },
    (p: CodexParsedRequest) => { p.context.messages[1]!.content = [{ type: "image", imageUrl: "https://fixture.invalid/new.png" }]; },
    (p: CodexParsedRequest) => { p.context.messages[1]!.timestamp = 12; },
  ]) { const parsed = fixture(); change(parsed); expect(compactionSourceHash(parsed)).not.toBe(compactionSourceHash(first)); }
});

test("closed tab resumes the persisted exact suffix on a smaller account, then replays a complete handoff with no browser", () => temporary(async directory => {
  let now = 1_800_000_000_000, completed = 0, failed = false;
  const parsed = fixture(), plan = planLargeContextCompaction(parsed)!, sourceHash = compactionSourceHash(parsed);
  const observed: typeof plan.fragments = [], resumes: unknown[] = [];
  const capabilities = { solAvailable: true, extraHighAvailable: true, proAvailable: true, localToolsEnabled: false };
  const execute = (journal: CompactionJournal, input: CodexParsedRequest) => journal.run("thread-one", compactionSourceHash(input), signal(), (resume, save) => runLargeContextCompaction({
    parsed: input, plan: planLargeContextCompaction(input)!, signal: signal(), resume, onCheckpoint: save, onResume: event => resumes.push(event),
    prepare: (stage, options) => prepareCompactionStageTransport(stage, capabilities, { ...options, multipart: true }),
    run: async (_stage, prepared) => {
      if (completed === 2 && !failed) { failed = true; throw new ChatGptWebAdapterError("Tab closed", { status: 499, errorType: "client_closed_request", code: "client_cancelled", retryable: false }); }
      const data = compactionStageData(prepared!);
      expect(data.checkpoint).toBe(completed ? `Cumulative checkpoint ${completed}` : "");
      observed.push(...data.fragments);
      return `Cumulative checkpoint ${++completed}`;
    },
  }));
  await expect(execute(new CompactionJournal(directory, () => now), parsed)).rejects.toMatchObject({ code: "client_cancelled" });
  await expect(execute(new CompactionJournal(directory, () => now), fixture(now + 5000))).rejects.toMatchObject({ code: "compaction_cooldown" });
  expect(completed).toBe(2);
  now += 30_001;
  Object.assign(capabilities, { extraHighAvailable: false, proAvailable: false });
  const summary = await execute(new CompactionJournal(directory, () => now), fixture(now));
  expect(summary).toBe(`Cumulative checkpoint ${completed}`);
  expect(observed).toEqual(plan.fragments);
  expect(resumes.length).toBe(1);
  expect(completed).toBeGreaterThan(2);
  const before = completed;
  expect(await execute(new CompactionJournal(directory, () => now), fixture(now + 10))).toBe(summary);
  expect(completed).toBe(before);
  expect(sourceHash).toBe(compactionSourceHash(fixture(now)));
}), 30_000);

test("unusual activity honors the full provider cooldown across new turns, source changes, and daemon restarts", () => temporary(async directory => {
  let now = 1_800_000_000_000, sends = 0;
  const providerRetryAt = now + 30 * 60_000;
  const attempt = (source: string) => new CompactionJournal(directory, () => now).run("owner", source, signal(), async () => {
    sends++;
    throw new ChatGptWebAdapterError("Provider block", { status: 429, errorType: "rate_limit_error", code: "chatgpt_unusual_activity", retryable: false, retryAt: providerRetryAt });
  });
  await expect(attempt("a".repeat(64))).rejects.toMatchObject({ code: "chatgpt_unusual_activity" });
  now += 60_000;
  await expect(attempt("b".repeat(64))).rejects.toMatchObject({ code: "compaction_cooldown", retryAt: providerRetryAt, retryAfterSeconds: 1740 });
  expect(sends).toBe(1);
  now = providerRetryAt + 1;
  await expect(attempt("b".repeat(64))).rejects.toMatchObject({ code: "chatgpt_unusual_activity" });
  expect(sends).toBe(2);
}));

test("three consecutive failures open a 15 minute circuit without losing completed stages", () => temporary(async directory => {
  let now = 1_800_000_000_000, sends = 0;
  const attempt = () => new CompactionJournal(directory, () => now).run("owner", "a".repeat(64), signal(), async () => { sends++; throw Error("offline failure"); });
  for (const delay of [30_001, 60_001, 0]) { await expect(attempt()).rejects.toThrow("offline failure"); now += delay; }
  await expect(attempt()).rejects.toMatchObject({ code: "compaction_retry_exhausted", retryAfterSeconds: 900 });
  expect(sends).toBe(3);
}));

test("concurrent observers share the completed receipt and corrupt receipts fail closed", () => temporary(async directory => {
  let sends = 0;
  const attempt = () => new CompactionJournal(directory).run("owner", "a".repeat(64), signal(), async () => { sends++; await Bun.sleep(2); return "complete handoff"; });
  expect(await Promise.all([attempt(), attempt()])).toEqual(["complete handoff", "complete handoff"]);
  expect(sends).toBe(1);
  writeFileSync(join(directory, readdirSync(directory)[0]!), "{corrupt");
  await expect(attempt()).rejects.toMatchObject({ code: "compaction_journal_invalid" });
  expect(sends).toBe(1);
}));

test("admission-only budget rejection resizes a batch; provider rejections never automatically resend it", async () => {
  const parsed = fixture(), plan = planLargeContextCompaction(parsed)!;
  let attempts = 0, summaries = 0;
  const observed: typeof plan.fragments = [];
  const capabilities = { solAvailable: true, extraHighAvailable: true, proAvailable: true, localToolsEnabled: false };
  await runLargeContextCompaction({ parsed, plan, signal: signal(),
    prepare: (stage, options) => prepareCompactionStageTransport(stage, capabilities, { ...options, multipart: true }),
    run: async (_stage, prepared) => {
      attempts++;
      const data = compactionStageData(prepared!);
      if (!summaries && data.fragments.length > 4) throw new ChatGptWebAdapterError("No message was sent", { status: 409, errorType: "invalid_request_error", code: "compaction_stage_too_large", retryable: false });
      observed.push(...data.fragments); summaries++;
      return "Verified cumulative checkpoint";
    },
  });
  expect(observed).toEqual(plan.fragments);
  expect(attempts).toBeGreaterThan(summaries);
  attempts = 0;
  await expect(runLargeContextCompaction({ parsed, plan, signal: signal(), run: async () => {
    attempts++; throw new ChatGptWebAdapterError("Ambiguous Send", { status: 502, errorType: "server_error", code: "chatgpt_submission_failed", retryable: false });
  } })).rejects.toMatchObject({ code: "chatgpt_submission_failed" });
  expect(attempts).toBe(1);
}, 30_000);
