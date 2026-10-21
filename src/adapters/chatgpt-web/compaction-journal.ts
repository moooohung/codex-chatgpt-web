import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../../config";
import { ChatGptWebAdapterError } from "./adapter-error";

export interface CompactionProgress {
  fragmentsProcessed: number;
  imagesProcessed: number;
  checkpoint: string;
}
interface Entry {
  version: 1;
  sourceHash: string;
  updatedAt: number;
  failures: number;
  consecutiveFailures: number;
  retryAt: number;
  failureCode?: string;
  sizeRejection?: { status: number; code: string };
  progress?: CompactionProgress;
  summary?: string;
}
const SERIAL = new Map<string, Promise<unknown>>();
const MAX_AGE = 7 * 24 * 60 * 60_000;
const CIRCUIT_PAUSE = 15 * 60_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Private local summaries only. No raw history, provider credentials or tool capabilities. */
export class CompactionJournal {
  constructor(private readonly directory: string, private readonly now = () => Date.now()) {}

  async run(owner: string, sourceHash: string, signal: AbortSignal,
    operation: (progress: CompactionProgress | undefined, save: (progress: CompactionProgress) => void) => Promise<string>,
  ): Promise<string> {
    const path = join(this.directory, `${hash(owner)}.json`);
    const previous = SERIAL.get(path);
    const pending = Promise.resolve(previous).catch(() => {}).then(async () => {
      signal.throwIfAborted();
      let entry = this.read(path);
      // A completed identical result needs no browser, even during a provider cooldown.
      if (entry?.sourceHash === sourceHash && entry.summary) return entry.summary;
      if (entry?.sourceHash === sourceHash && entry.sizeRejection) {
        throw new ChatGptWebAdapterError("This exact compaction source already exceeded its transport budget. Reduce the input or change the requested effort before retrying; no ChatGPT request was sent.",
          { ...entry.sizeRejection, errorType: "invalid_request_error", retryable: false });
      }
      if (entry && entry.retryAt > this.now()) {
        const exhausted = entry.consecutiveFailures >= 3 || entry.failures >= 5;
        throw new ChatGptWebAdapterError(
          `Context compaction is paused until ${new Date(entry.retryAt).toISOString()} after ${entry.failureCode ?? "an interrupted attempt"}. Saved source stages are retained; no new ChatGPT request was sent.`,
          { status: 429, errorType: "rate_limit_error", code: exhausted ? "compaction_retry_exhausted" : "compaction_cooldown",
            retryable: false, retryAt: entry.retryAt, retryAfterSeconds: Math.ceil((entry.retryAt - this.now()) / 1000) },
        );
      }
      if (entry && (entry.consecutiveFailures >= 3 || entry.failures >= 5)) {
        entry.failures = 0; entry.consecutiveFailures = 0; // One probe after the full circuit pause.
      }
      if (!entry) entry = { version: 1, sourceHash, updatedAt: this.now(), failures: 0, consecutiveFailures: 0, retryAt: 0 };
      if (entry.sourceHash !== sourceHash) {
        // A changed native turn/source cannot evade an owner's failure backoff.
        entry = { ...entry, sourceHash, progress: undefined, summary: undefined, sizeRejection: undefined };
      }
      const save = () => {
        entry!.updatedAt = this.now();
        atomicWriteFile(path, JSON.stringify(entry), { durable: true });
      };
      entry.retryAt = this.now() + 30_000; // A daemon restart must not immediately replay an in-flight summary.
      save();
      try {
        const summary = await operation(entry.progress, progress => {
          signal.throwIfAborted();
          entry!.progress = { ...progress };
          entry!.consecutiveFailures = 0;
          entry!.retryAt = this.now() + 30_000;
          save(); // Commit each validated answer before starting the next physical browser stage.
        });
        signal.throwIfAborted();
        // A very large authenticated latest-human appendix may exceed the cache
        // budget. Return it intact; keep the final stage cursor for reconstruction.
        entry.summary = Buffer.byteLength(JSON.stringify(summary)) <= 64_000 ? summary : undefined;
        entry.retryAt = 0; entry.failures = 0; entry.consecutiveFailures = 0;
        save();
        return summary;
      } catch (error) {
        const provider = error instanceof ChatGptWebAdapterError ? error : undefined;
        if (provider?.code === "context_length_exceeded" || provider?.code === "compaction_stage_too_large") {
          // Existing exact-run caching already rejects the identical oversized
          // input. Let a genuinely reduced input/account effort be corrected now.
          entry.sizeRejection = { status: provider.status, code: provider.code };
          entry.retryAt = 0; save(); throw error;
        }
        entry.failures++; entry.consecutiveFailures++;
        entry.failureCode = provider?.code ?? (signal.aborted ? "compaction_interrupted" : "compaction_failed");
        const delay = entry.consecutiveFailures >= 3 || entry.failures >= 5 ? CIRCUIT_PAUSE
          : Math.min(120_000, 30_000 * 2 ** (entry.consecutiveFailures - 1));
        entry.retryAt = Math.max(this.now() + delay, provider?.retryAt ?? 0,
          this.now() + (provider?.retryAfterSeconds ?? 0) * 1000);
        save();
        throw error;
      }
    });
    SERIAL.set(path, pending);
    try { return await pending; }
    finally { if (SERIAL.get(path) === pending) SERIAL.delete(path); }
  }

  private read(path: string): Entry | undefined {
    let raw: string;
    try { raw = readFileSync(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    try {
      if (Buffer.byteLength(raw) > 128_000) throw Error();
      const value = JSON.parse(raw) as Entry;
      if (value.version !== 1 || typeof value.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceHash)
        || ![value.updatedAt, value.retryAt, value.failures, value.consecutiveFailures].every(n => Number.isSafeInteger(n) && n >= 0)
        || value.summary !== undefined && (typeof value.summary !== "string" || value.summary.length > 64_000)
        || value.sizeRejection !== undefined && (!value.sizeRejection || ![400, 409].includes(value.sizeRejection.status)
          || !["context_length_exceeded", "compaction_stage_too_large"].includes(value.sizeRejection.code))
        || value.progress !== undefined && (!value.progress || typeof value.progress !== "object" || Array.isArray(value.progress)
          || !Number.isSafeInteger(value.progress.fragmentsProcessed) || value.progress.fragmentsProcessed < 0
          || !Number.isSafeInteger(value.progress.imagesProcessed) || value.progress.imagesProcessed < 0
          || typeof value.progress.checkpoint !== "string" || Buffer.byteLength(value.progress.checkpoint) > 24_000)) throw Error();
      return this.now() - value.updatedAt > MAX_AGE ? undefined : value;
    } catch {
      // Corrupt receipts must not silently trigger a complete replay of a large context.
      throw new ChatGptWebAdapterError("The saved compaction receipt is invalid. No ChatGPT request was sent; inspect the local compaction journal before retrying.",
        { status: 409, errorType: "invalid_request_error", code: "compaction_journal_invalid", retryable: false });
    }
  }
}
