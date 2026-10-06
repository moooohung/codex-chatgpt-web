import type { Locator, Page, Request } from "playwright-core";

export type SubmissionRecoveryDecision<T> =
  | { state: "accepted"; evidence: T }
  | { state: "not_dispatched" }
  | { state: "ambiguous" | "approval_pending" };

export interface SubmissionRecoveryEvent {
  identity: string;
  event: "activate" | "reconcile" | "retry" | "accepted" | "exhausted";
  activations: number;
  reconciliations: number;
  state?: string;
}

export class ChatGptSubmissionRecoveryExhausted extends Error {
  constructor(readonly state: string) {
    super(state === "not_dispatched"
      ? "ChatGPT Send recovery exhausted its bounded retries before input was dispatched. Resume the failed turn after checking the tab."
      : "ChatGPT Send recovery could not establish acceptance. Check the tab before resuming; the ambiguous prompt was not resent.");
    this.name = "ChatGptSubmissionRecoveryExhausted";
  }
}

interface RecoveryOptions<T> {
  key: object;
  identity: string;
  signal?: AbortSignal;
  prepare?: (signal: AbortSignal) => Promise<void>;
  dispose?: () => void;
  activate: (signal: AbortSignal) => Promise<void>;
  observe: (signal: AbortSignal) => Promise<T>;
  reconcile: (signal: AbortSignal) => Promise<SubmissionRecoveryDecision<T>>;
  onAccepted?: () => void | Promise<void>;
  onEvent?: (event: SubmissionRecoveryEvent) => void;
  checkpointMs?: number;
  backoffMs?: number;
}

const submissionRecoveries = new WeakMap<object, { identity: string; promise: Promise<unknown> }>();
const NEVER = new Promise<never>(() => {});

function recoverableObservation(error: unknown): boolean {
  return error instanceof Error && (error.name === "ChatGptBrowserObservationTimeoutError"
    || error.cause instanceof Error && error.cause.name === "ChatGptBrowserObservationTimeoutError");
}

function recoveryPause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Keep the original turn capability and draft. A settled input and explicit non-dispatch proof
 * are both required before another activation; absence of DOM/HTTP acknowledgement is insufficient. */
export function recoverChatGptSubmission<T>(options: RecoveryOptions<T>): Promise<T> {
  const previous = submissionRecoveries.get(options.key);
  if (previous) {
    if (previous.identity !== options.identity) return Promise.reject(new Error("ChatGPT submission recovery ownership changed"));
    return previous.promise as Promise<T>;
  }
  const promise = runSubmissionRecovery(options);
  submissionRecoveries.set(options.key, { identity: options.identity, promise });
  return promise;
}

async function runSubmissionRecovery<T>(options: RecoveryOptions<T>): Promise<T> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  let activations = 0, reconciliations = 0;
  let activationSettled = true;
  let activationFailure: Promise<{ kind: "activation_error"; error: unknown }> = NEVER;
  let observation: Promise<{ kind: "accepted"; evidence: T } | { kind: "observation_error"; error: unknown }> = NEVER;
  const report = (event: SubmissionRecoveryEvent["event"], state?: string) =>
    options.onEvent?.({ identity: options.identity, event, activations, reconciliations, ...(state ? { state } : {}) });
  const observe = () => {
    observation = Promise.resolve().then(() => { signal.throwIfAborted(); return options.observe(signal); })
      .then(evidence => ({ kind: "accepted" as const, evidence }), error => ({ kind: "observation_error" as const, error }));
  };
  const activate = () => {
    signal.throwIfAborted();
    activations++; activationSettled = false; report("activate");
    activationFailure = Promise.resolve().then(() => { signal.throwIfAborted(); return options.activate(signal); })
      .then(() => { activationSettled = true; return NEVER; }, error => {
        activationSettled = true; return { kind: "activation_error" as const, error };
      });
  };
  const accepted = async (evidence: T) => {
    signal.throwIfAborted(); report("accepted", "accepted"); await options.onAccepted?.(); return evidence;
  };
  try {
    signal.throwIfAborted(); await options.prepare?.(signal); signal.throwIfAborted();
    let initial: SubmissionRecoveryDecision<T>;
    try { initial = await Promise.race([options.reconcile(signal), aborted]); }
    catch (error) { signal.throwIfAborted(); if (!recoverableObservation(error)) throw error; initial = { state: "ambiguous" }; }
    signal.throwIfAborted();
    if (initial.state === "accepted") return await accepted(initial.evidence);
    if (initial.state === "not_dispatched") activate();
    observe();
    let lastState = "ambiguous";
    while (reconciliations < 3) {
      const checkpoint = new AbortController();
      const checkpointSignal = AbortSignal.any([signal, checkpoint.signal]);
      let result: Awaited<typeof observation> | { kind: "checkpoint" } | { kind: "activation_error"; error: unknown };
      try {
        result = await Promise.race([observation, activationFailure, aborted,
          recoveryPause(options.checkpointMs ?? 3_000, checkpointSignal).then(() => ({ kind: "checkpoint" as const }))]);
      } finally { checkpoint.abort(); }
      signal.throwIfAborted();
      if (result.kind === "accepted") return await accepted(result.evidence);
      if (result.kind === "observation_error" && !recoverableObservation(result.error)) throw result.error;
      if (result.kind === "activation_error" && result.error instanceof Error && result.error.name === "ChatGptWebAdapterError") throw result.error;
      if (result.kind === "activation_error") activationFailure = NEVER;
      if (result.kind === "observation_error") observation = NEVER;
      reconciliations++;
      let decision: SubmissionRecoveryDecision<T>;
      try { decision = await Promise.race([options.reconcile(signal), aborted]); }
      catch (error) { signal.throwIfAborted(); if (!recoverableObservation(error)) throw error; decision = { state: "ambiguous" }; }
      // Acceptance may arrive while the DOM reconciliation runs; never discard that evidence.
      const latest = await Promise.race([observation, Promise.resolve(undefined)]);
      if (latest?.kind === "accepted") return await accepted(latest.evidence);
      lastState = decision.state; report("reconcile", lastState);
      if (decision.state === "accepted") return await accepted(decision.evidence);
      if (decision.state === "not_dispatched" && activationSettled && activations < 3) {
        await recoveryPause((options.backoffMs ?? 250) * activations, signal);
        // A late request/response or a user action during backoff invalidates the retry proof.
        let fresh: SubmissionRecoveryDecision<T>;
        try { fresh = await Promise.race([options.reconcile(signal), aborted]); }
        catch (error) { signal.throwIfAborted(); if (!recoverableObservation(error)) throw error; fresh = { state: "ambiguous" }; }
        signal.throwIfAborted();
        const afterBackoff = await Promise.race([observation, Promise.resolve(undefined)]);
        if (afterBackoff?.kind === "accepted") return await accepted(afterBackoff.evidence);
        if (fresh.state === "accepted") return await accepted(fresh.evidence);
        lastState = fresh.state;
        if (fresh.state === "not_dispatched") { report("retry", fresh.state); activate(); }
      }
      if (result.kind === "observation_error") observe();
    }
    signal.throwIfAborted(); report("exhausted", lastState);
    throw new ChatGptSubmissionRecoveryExhausted(lastState);
  } finally {
    signal.removeEventListener("abort", abort);
    controller.abort();
    options.dispose?.();
  }
}

interface AuditState { identity: string; document: number; url: string; keydowns: number; submits: number }

/** Browser evidence for retrying a keyboard action which never reached this document. */
export async function createChatGptSubmissionAudit(page: Page, composer: Locator, identity: string) {
  let requestSeen = false;
  const onRequest = (request: Request) => {
    if (request.method() === "POST" && request.url() === "https://chatgpt.com/backend-api/f/conversation"
      && request.frame() === page.mainFrame()) requestSeen = true;
  };
  const initialDraft = await composer.evaluate(element => element.innerHTML);
  const initial = await page.evaluate(id => {
    type Audit = AuditState & { dispose: () => void };
    const scope = globalThis as typeof globalThis & { __CODEX_SUBMISSION_RECOVERY_AUDIT__?: Audit };
    scope.__CODEX_SUBMISSION_RECOVERY_AUDIT__?.dispose();
    const state: Audit = { identity: id, document: performance.timeOrigin, url: location.href, keydowns: 0, submits: 0, dispose() {} };
    const key = (event: KeyboardEvent) => { if (event.isTrusted && event.key === "Enter") state.keydowns++; };
    const submit = () => { state.submits++; };
    document.addEventListener("keydown", key, true); document.addEventListener("submit", submit, true);
    state.dispose = () => { document.removeEventListener("keydown", key, true); document.removeEventListener("submit", submit, true); };
    scope.__CODEX_SUBMISSION_RECOVERY_AUDIT__ = state;
    const { dispose: _, ...snapshot } = state; return snapshot;
  }, identity);
  page.on("request", onRequest);
  return {
    async notDispatched(): Promise<boolean> {
      if (requestSeen || page.isClosed()) return false;
      const current = await page.evaluate(() => {
        const scope = globalThis as typeof globalThis & { __CODEX_SUBMISSION_RECOVERY_AUDIT__?: AuditState };
        const state = scope.__CODEX_SUBMISSION_RECOVERY_AUDIT__;
        return state ? { identity: state.identity, document: state.document, url: state.url, keydowns: state.keydowns, submits: state.submits } : undefined;
      });
      const draft = await composer.evaluate(element => element.innerHTML);
      return !requestSeen && !!current && current.identity === identity && current.document === initial.document
        && current.url === initial.url && current.keydowns === 0 && current.submits === 0 && draft === initialDraft;
    },
    dispose() {
      page.off("request", onRequest);
      void page.evaluate(id => {
        const scope = globalThis as typeof globalThis & { __CODEX_SUBMISSION_RECOVERY_AUDIT__?: AuditState & { dispose(): void } };
        if (scope.__CODEX_SUBMISSION_RECOVERY_AUDIT__?.identity === id) {
          scope.__CODEX_SUBMISSION_RECOVERY_AUDIT__.dispose(); delete scope.__CODEX_SUBMISSION_RECOVERY_AUDIT__;
        }
      }, identity).catch(() => {});
    },
  };
}
