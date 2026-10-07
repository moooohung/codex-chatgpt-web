import { resolveStallTimeoutSec } from "../../stall-timeout";
import { ChatGptWebAdapterError } from "./adapter-error";
import type { ChatGptExternalTurnProgressSnapshot } from "./turn-progress";
import type { ChatGptResponseWaitState } from "./response-wait";

/** Physical browser execution progress, independent of HTTP/helper keep-alive traffic. */
export class ChatGptResponseProgressTracker {
  readonly timeoutMs: number;
  private lastProgressAt?: number;
  private lastToolProgressAt?: number;
  private responseWaitState: ChatGptResponseWaitState | null = null;

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

  /** A status banner can explain a stall, but observing it must never extend the deadline. */
  observeResponseWait(state: ChatGptResponseWaitState | null): void {
    this.responseWaitState = state;
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
    if (this.responseWaitState) {
      const connection = this.responseWaitState !== "service_thinking";
      return new ChatGptWebAdapterError(
        (connection ? "ChatGPT's connection recovery did not produce a complete answer" : "ChatGPT's service is still holding this response")
        + (this.responseWaitState === "connection_interrupted_and_service_thinking" ? " while its service also reported additional processing" : "")
        + ` after ${this.timeoutMs / 1000} seconds without new response or Codex tool progress. `
        + "The accepted request was not resent. Check the tab and resume only unfinished work.",
        { status: 504, errorType: "server_error", code: connection ? "chatgpt_connection_recovery_timeout" : "chatgpt_service_wait_timeout", retryable: false },
      );
    }
    return new ChatGptWebAdapterError(
      `ChatGPT produced no new response or Codex tool progress for ${this.timeoutMs / 1000} seconds. `
      + "Its browser turn was stopped; transport heartbeats do not extend this deadline.",
      { status: 504, errorType: "server_error", code: "upstream_stall_timeout", retryable: false },
    );
  }
}
