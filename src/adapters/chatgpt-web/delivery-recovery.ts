import type { Locator } from "playwright-core";

export async function chatGptMessageDeliveryTimeoutVisible(scope: Locator): Promise<boolean> {
  return scope.getByText(/^Message delivery timed out\. Please try again\.$/i).evaluateAll(elements => elements.some(element => {
    if (element.closest('.markdown, pre, code, [data-user-message-bubble], [data-message-author-role="user"]')) return false;
    const visible = (node: Element) => {
      const bounds = node.getBoundingClientRect(), style = getComputedStyle(node);
      return node.isConnected && style.display !== "none" && style.visibility !== "hidden" && (bounds.width > 0 || bounds.height > 0);
    };
    // The caller scopes this to the current bound assistant response. ChatGPT
    // also renders this exact UI error without a Retry control; quoted prose
    // and user bubbles are excluded above, regardless of nearby buttons.
    return visible(element);
  }));
}

export interface DeliveryRecoveryState {
  currentResponseIdentity: string;
  errorVisible: boolean;
  running: boolean;
  toolsInFlight: boolean;
  approvalPending: boolean;
  deadlineReached: boolean;
}

function abortableDeliveryRead<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true; signal.removeEventListener("abort", abort); action();
    };
    const abort = () => finish(() => reject(signal.reason));
    // Own late rejections even when cancellation was already requested.
    operation.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export class ChatGptDeliveryRecovery {
  private readonly attempts = new Map<string, Promise<unknown>>();
  private started = 0;
  constructor(private readonly traceId: string) {}

  recover<T>(errorIdentity: string, options: {
    signal?: AbortSignal;
    readState(): Promise<DeliveryRecoveryState>;
    continue(prompt: string, attempt: number): Promise<T>;
    onEvent?(event: { traceId: string; errorIdentity: string; event: string; attempt: number }): void;
    backoffMs?: number;
  }): Promise<{ kind: "continued"; result: T } | { kind: "wait" }> {
    const previous = this.attempts.get(errorIdentity);
    if (previous) return previous as Promise<{ kind: "continued"; result: T } | { kind: "wait" }>;
    const report = (event: string) => options.onEvent?.({ traceId: this.traceId, errorIdentity, event, attempt: this.started });
    const blocked = (state: DeliveryRecoveryState) => state.currentResponseIdentity !== errorIdentity || !state.errorVisible
      || state.running || state.toolsInFlight || state.approvalPending;
    const run = async () => {
      options.signal?.throwIfAborted();
      let state = await abortableDeliveryRead(options.readState(), options.signal); options.signal?.throwIfAborted();
      if (state.deadlineReached) throw new Error("ChatGPT web turn timed out");
      if (blocked(state)) { report("waiting"); return { kind: "wait" as const }; }
      if (this.started >= 3) {
        report("exhausted");
        throw Object.assign(new Error("ChatGPT message delivery recovery exhausted three continuations. Resume only unfinished work after checking the tab."), { name: "ChatGptDeliveryRecoveryExhausted" });
      }
      await new Promise<void>((resolve, reject) => {
        const signal = options.signal;
        const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
        const timer = setTimeout(finish, (options.backoffMs ?? 1_000) * 2 ** this.started);
        const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
        signal?.addEventListener("abort", abort, { once: true });
      });
      options.signal?.throwIfAborted();
      state = await abortableDeliveryRead(options.readState(), options.signal); options.signal?.throwIfAborted();
      if (state.deadlineReached) throw new Error("ChatGPT web turn timed out");
      if (blocked(state)) { report("waiting"); return { kind: "wait" as const }; }
      this.started++; report("continuation_started");
      const prompt = `Bridge recovery ${this.started} for response ${errorIdentity}: the previous response ended with Message delivery timed out after work may already have completed. Reconcile completed tool results and the current workspace, then continue only unfinished work in the current goal. Do not repeat completed commands, commits, messages, or the original request. Preserve user stop, goal budget, and pending approval constraints. If the goal is complete, give its final answer and limitations.`;
      const result = await options.continue(prompt, this.started);
      report("continuation_accepted"); return { kind: "continued" as const, result };
    };
    const promise = run();
    this.attempts.set(errorIdentity, promise);
    void promise.then(result => { if (result.kind === "wait" && this.attempts.get(errorIdentity) === promise) this.attempts.delete(errorIdentity); }, () => {});
    return promise;
  }
}
