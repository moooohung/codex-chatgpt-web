import { ChatGptWebAdapterError } from "./adapter-error";
import type { ChatGptTurnProgressReader } from "./turn-progress";

// Leave 15s of the Native2 MCP deadline for ACK propagation/emission after a
// large-page capture (at most 60s). Capture failures still revoke the turn.
export const CHATGPT_TOOL_BOUNDARY_ACK_TIMEOUT_MS = 75_000;

interface BoundaryTracker {
  needsToolBatchObservation(revision: number): boolean;
  observeToolBatch(revision: number, text: string): boolean;
}

const captures = new WeakMap<BoundaryTracker, Map<number, Promise<void>>>();
const traces = new WeakMap<BoundaryTracker, string>();

export type ChatGptBrowserProbe = "response_probe" | "session_alert" | "rate_limit_dialog"
  | "terminal_error" | "turn_state" | "response_projection" | "delivery_timeout"
  | "tool_confirmation" | "diagnostic_capture" | "boundary_turn_state" | "boundary_response_projection";

/** Slow/failing observations carry only the operation name and timing, never DOM content. */
export function logChatGptBrowserObservation(
  tracker: BoundaryTracker | undefined,
  probe: ChatGptBrowserProbe,
  details: { elapsedMs: number; timeoutMs: number; failed: boolean; errorCode?: string },
): void {
  if (!details.failed && details.elapsedMs < 1_000) return;
  const traceId = tracker ? traces.get(tracker) : undefined;
  const shortId = /^[a-f0-9]{12,}$/i.test(traceId ?? "") ? traceId!.slice(0, 12) : "untracked";
  console.info(`[chatgpt-web] browser_observation ${JSON.stringify({ traceId: shortId, probe, ...details })}`);
}

export function setChatGptToolBoundaryTrace(tracker: BoundaryTracker, traceId: string): void {
  traces.set(tracker, traceId);
}

/** Diagnostics deliberately exclude capability tokens, prompt text and tool arguments. */
export function logChatGptToolBoundary(
  stage: string,
  traceId: string | undefined,
  revision: number,
  details: { elapsedMs?: number; timeoutMs?: number; textChars?: number; toolCount?: number; code?: string } = {},
): void {
  const shortId = /^[a-f0-9]{12,}$/i.test(traceId ?? "") ? traceId!.slice(0, 12) : "untracked";
  console.info(`[chatgpt-web] tool_boundary ${JSON.stringify({ stage, traceId: shortId, revision, ...details })}`);
}

export function chatGptToolBoundaryError(code: string, cause?: unknown): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `ChatGPT tool boundary failed (${code}). Tools were not released; check the browser before resuming.`,
    { status: 502, errorType: "server_error", code, retryable: false, ...(cause === undefined ? {} : { cause }) },
  );
}

/** Budget the whole operation, including projections that cannot cancel their underlying CDP read.
 * The owned signal still fences every subsequent observe/ACK, even if that read settles late. */
async function withBoundaryBudget<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  timeoutCode: string | (() => string),
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid ChatGPT boundary budget");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const ownedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(ownedSignal.reason);
    ownedSignal.addEventListener("abort", onAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(chatGptToolBoundaryError(typeof timeoutCode === "string" ? timeoutCode : timeoutCode())), timeoutMs);
  try {
    return await Promise.race([Promise.resolve().then(() => {
      ownedSignal.throwIfAborted();
      return operation(ownedSignal);
    }), aborted]);
  } finally {
    clearTimeout(timer);
    ownedSignal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

export function captureChatGptToolBoundary(options: {
  tracker: BoundaryTracker;
  revision: number;
  capture: (signal: AbortSignal) => Promise<string>;
  acknowledge: () => Promise<void>;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<void> {
  const { tracker, revision } = options;
  // Recovery reconciliation can run while the ordinary observer is still capturing this revision.
  // Join its complete capture->observe->ACK promise, including a cached failure, before trusting it.
  let batches = captures.get(tracker);
  const previous = batches?.get(revision);
  if (previous) return previous;
  if (!tracker.needsToolBatchObservation(revision)) return Promise.resolve();
  if (!batches) captures.set(tracker, batches = new Map());
  const traceId = traces.get(tracker);
  const started = Date.now();
  let phase = "capture";
  const promise = withBoundaryBudget(async signal => {
    logChatGptToolBoundary("capture_begin", traceId, revision, { timeoutMs: options.timeoutMs });
    const text = await options.capture(signal);
    signal.throwIfAborted();
    tracker.observeToolBatch(revision, text);
    logChatGptToolBoundary("capture_observed", traceId, revision, { textChars: text.length, elapsedMs: Date.now() - started });
    phase = "ack";
    signal.throwIfAborted();
    await options.acknowledge();
    signal.throwIfAborted();
    logChatGptToolBoundary("ack_complete", traceId, revision, { elapsedMs: Date.now() - started });
  }, options.signal, options.timeoutMs, () => phase === "capture" ? "chatgpt_tool_boundary_observation_timeout" : "chatgpt_tool_boundary_ack_timeout").catch(error => {
    const failure = options.signal?.aborted ? options.signal.reason
      : error instanceof ChatGptWebAdapterError && !error.retryable ? error
      : chatGptToolBoundaryError(phase === "capture" ? "chatgpt_tool_boundary_observation_failed" : "chatgpt_tool_boundary_ack_failed", error);
    logChatGptToolBoundary("capture_failed", traceId, revision, {
      elapsedMs: Date.now() - started,
      code: failure instanceof ChatGptWebAdapterError ? failure.code : "cancelled",
    });
    throw failure;
  });
  batches.set(revision, promise);
  return promise;
}

export async function waitForChatGptToolBoundaryAck(options: {
  traceId: string;
  revision: number;
  wait: (signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<void> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? CHATGPT_TOOL_BOUNDARY_ACK_TIMEOUT_MS;
  logChatGptToolBoundary("ack_wait", options.traceId, options.revision, { timeoutMs });
  try {
    await withBoundaryBudget(options.wait, options.signal, timeoutMs, "chatgpt_tool_boundary_ack_timeout");
    logChatGptToolBoundary("ack_released", options.traceId, options.revision, { elapsedMs: Date.now() - started });
  } catch (error) {
    logChatGptToolBoundary("ack_wait_failed", options.traceId, options.revision, {
      elapsedMs: Date.now() - started,
      code: error instanceof ChatGptWebAdapterError ? error.code : "cancelled",
    });
    throw error;
  }
}

/** A batch arriving during a slow UI probe must enter capture before that probe finishes.
 * This never acknowledges progress alone: capture retains the existing observe/ACK contract. */
export async function observeChatGptToolBoundaryDuring<T>(options: {
  progress?: ChatGptTurnProgressReader;
  signal?: AbortSignal;
  observe: (signal: AbortSignal) => Promise<T>;
  capture: (signal: AbortSignal) => Promise<void>;
}): Promise<T> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    signal.throwIfAborted();
    if (!options.progress) return await options.observe(signal);
    let revision = options.progress.snapshot().revision;
    await options.capture(signal);
    // Convert both outcomes to values so a probe rejection cannot become unhandled
    // while the concurrent boundary capture is still finishing.
    const observation = Promise.resolve().then(() => options.observe(signal)).then(
      value => ({ kind: "observed" as const, value }),
      error => ({ kind: "failed" as const, error }),
    );
    for (;;) {
      const waitAbort = new AbortController();
      let next;
      try {
        next = await Promise.race([
          observation,
          options.progress.waitForChange(revision, AbortSignal.any([signal, waitAbort.signal])).then(
            snapshot => ({ kind: "progress" as const, snapshot }),
            error => ({ kind: "failed" as const, error }),
          ),
        ]);
      } finally {
        waitAbort.abort();
      }
      signal.throwIfAborted();
      await options.capture(signal);
      if (next.kind === "failed") throw next.error;
      if (next.kind === "observed") return next.value;
      revision = next.snapshot.revision;
    }
  } finally {
    controller.abort();
  }
}
