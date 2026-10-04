import { resolveStallTimeoutSec } from "../../stall-timeout";
import { ChatGptWebAdapterError } from "./adapter-error";
import type { ChatGptExternalTurnProgressSnapshot } from "./turn-progress";

/** Physical browser execution progress, independent of HTTP/helper keep-alive traffic. */
export class ChatGptResponseProgressTracker {
  readonly timeoutMs: number;
  private lastProgressAt?: number;
  private lastToolProgressAt?: number;

  constructor(timeoutSec?: number) {
    this.timeoutMs = resolveStallTimeoutSec(timeoutSec) * 1000;
  }

  accepted(now = Date.now()): void {
    this.lastProgressAt ??= now;
  }

  /** Call only for newly emitted answer or reasoning/commentary content, never heartbeats. */
  emittedContent(now = Date.now()): void {
    if (this.lastProgressAt !== undefined) this.lastProgressAt = Math.max(this.lastProgressAt, now);
  }

  check(toolProgress?: ChatGptExternalTurnProgressSnapshot, now = Date.now()): ChatGptWebAdapterError | undefined {
    const at = toolProgress?.lastProgressAt;
    // Re-reading an active call/revision is not new activity. Retirement revisions deliberately
    // retain the old timestamp; future or stale frames cannot buy another full budget.
    if (at !== undefined && Number.isFinite(at) && at <= now + 5000
      && (this.lastToolProgressAt === undefined || at > this.lastToolProgressAt)) {
      this.lastToolProgressAt = at;
      const observedAt = Math.min(at, now);
      this.lastProgressAt = Math.max(this.lastProgressAt ?? observedAt, observedAt);
    }
    if (this.lastProgressAt === undefined || now - this.lastProgressAt < this.timeoutMs) return;
    return new ChatGptWebAdapterError(
      `ChatGPT produced no new response or Codex tool progress for ${this.timeoutMs / 1000} seconds. `
      + "Its browser turn was stopped; transport heartbeats do not extend this deadline.",
      { status: 504, errorType: "server_error", code: "upstream_stall_timeout", retryable: false },
    );
  }
}
