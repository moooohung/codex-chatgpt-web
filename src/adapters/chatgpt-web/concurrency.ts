export const DEFAULT_MAX_CHATGPT_BROWSER_TABS = 4;
// Keep bounded request/observer ownership while extra turns wait for a physical browser slot.
export const MAX_CHATGPT_REGISTERED_TURNS = 8;

export function resolveMaxChatGptBrowserTabs(
  raw = process.env.CODEX_WEB_GPT_MAX_BROWSER_TABS,
): number {
  if (raw === undefined || raw === "") return DEFAULT_MAX_CHATGPT_BROWSER_TABS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 8
    ? parsed
    : DEFAULT_MAX_CHATGPT_BROWSER_TABS;
}

/**
 * ChatGPT Web concurrency is deliberately bounded. Every active Codex turn owns a real
 * browser document in the signed-in account. Extra turns remain in ChatGptBrowserRunQueue
 * until a physical browser slot settles.
 */
export const MAX_CHATGPT_BROWSER_TABS = resolveMaxChatGptBrowserTabs();

interface PendingBrowserRun<T> {
  action: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  cleanup: () => void;
}

/** FIFO admission; a permit is held until the physical browser action settles. */
export class ChatGptBrowserRunQueue<T> {
  private readonly pending: PendingBrowserRun<T>[] = [];
  private running = 0;
  private closed = false;

  constructor(private readonly capacity = MAX_CHATGPT_BROWSER_TABS) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Invalid browser concurrency capacity");
  }

  run(action: () => Promise<T>, signal?: AbortSignal, heartbeat?: () => void): Promise<T> {
    if (this.closed) return Promise.reject(new DOMException("Browser worker is closing", "AbortError"));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Browser turn aborted", "AbortError"));
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setInterval> | undefined;
      const entry: PendingBrowserRun<T> = { action: async () => {
        signal?.throwIfAborted();
        return action();
      }, resolve, reject, cleanup: () => {
        if (timer) clearInterval(timer);
        signal?.removeEventListener("abort", onAbort);
      } };
      const cancel = (reason: unknown) => {
        const index = this.pending.indexOf(entry);
        if (index < 0) return;
        this.pending.splice(index, 1);
        entry.cleanup();
        reject(reason);
      };
      const onAbort = () => cancel(signal?.reason ?? new DOMException("Browser turn aborted", "AbortError"));
      this.pending.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (heartbeat) {
        timer = setInterval(() => {
          try { heartbeat(); } catch (error) { cancel(error); }
        }, 1_000);
        timer.unref?.();
      }
      if (signal?.aborted) onAbort();
      this.drain();
    });
  }

  cancelPending(reason = new DOMException("Browser worker is closing", "AbortError")): void {
    this.closed = true;
    for (const entry of this.pending.splice(0)) {
      entry.cleanup();
      entry.reject(reason);
    }
  }

  private drain(): void {
    while (!this.closed && this.running < this.capacity && this.pending.length) {
      const entry = this.pending.shift()!;
      entry.cleanup();
      this.running++;
      const settle = () => { this.running--; this.drain(); };
      Promise.resolve().then(entry.action).then(
        value => { settle(); entry.resolve(value); },
        error => { settle(); entry.reject(error); },
      );
    }
  }
}
