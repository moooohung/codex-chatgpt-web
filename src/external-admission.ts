export class ExternalAdmissionError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function waitExternal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

interface Lease {
  signal: AbortSignal;
  abort(): void;
  release(): void;
}

/** Counts body readers, queued turns and physically unsettled browser owners, not just HTTP observers. */
export class ExternalAdmission {
  private active = 0;
  private readonly pending: { start(): void; reject(error: unknown): void }[] = [];
  constructor(private readonly limits = { active: 4, outstanding: 8, queueMs: 30_000, turnMs: 600_000 }) {}

  acquire(signal: AbortSignal): Promise<Lease> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.active + this.pending.length >= this.limits.outstanding) return Promise.reject(new ExternalAdmissionError("External request capacity exceeded", 429));
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      let released = false;
      const cancel = () => {
        const index = this.pending.indexOf(entry);
        if (index >= 0) { this.pending.splice(index, 1); clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(controller.signal.reason); }
      };
      const entry = { reject, start: () => {
        clearTimeout(timer);
        this.active++;
        timer = setTimeout(() => controller.abort(new ExternalAdmissionError("External turn deadline exceeded", 504)), this.limits.turnMs);
        resolve({ signal: controller.signal, abort: () => controller.abort(new DOMException("External observer disconnected", "AbortError")),
          release: () => {
            if (released) return;
            released = true; clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            this.active--; this.drain();
          } });
      } };
      const onAbort = () => { controller.abort(signal.reason); cancel(); };
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        controller.abort(new ExternalAdmissionError("External queue deadline exceeded", 504));
        cancel();
        signal.removeEventListener("abort", onAbort);
      }, this.limits.queueMs);
      this.pending.push(entry);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.limits.active && this.pending.length) this.pending.shift()!.start();
  }
}
