/** Retry rejected native HTTP requests before any response stream is returned to Codex. */
export const NATIVE_CAPACITY_MAX_RETRIES = 3;
export const NATIVE_CAPACITY_RETRY_BUDGET_MS = 30_000;

export interface NativeCapacityRetryEvent {
  source: "native_upstream";
  status: 503;
  attempt: number;
  delayMs?: number;
  exhausted?: "attempts" | "budget";
}

export interface NativeCapacityRetryOptions {
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onEvent?: (event: NativeCapacityRetryEvent) => void;
}

export function nativeCapacityRetryAfterMs(value: string | null, now: number): number | undefined {
  if (!value?.trim()) return undefined;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const ms = Number(text) * 1_000;
    return Number.isFinite(ms) ? Math.ceil(ms) : undefined;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

export async function waitForNativeCapacityRetry(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function fetchWithNativeCapacityRetry(
  makeRequest: () => Request,
  fetchUpstream: (request: Request) => Promise<Response>,
  options: NativeCapacityRetryOptions = {},
): Promise<Response> {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? waitForNativeCapacityRetry;
  const startedAt = now();
  for (let attempt = 0; ; attempt += 1) {
    const request = makeRequest();
    request.signal.throwIfAborted();
    // A transport exception could follow acceptance. Do not replay it here.
    const response = await fetchUpstream(request);
    if (response.status !== 503) return response;
    const baseDelayMs = 2_000 * 2 ** attempt;
    const delayMs = Math.max(
      Math.ceil(baseDelayMs * (1 + 0.25 * random())),
      nativeCapacityRetryAfterMs(response.headers.get("retry-after"), now()) ?? 0,
    );
    const exhausted = attempt >= NATIVE_CAPACITY_MAX_RETRIES ? "attempts" :
      now() - startedAt + delayMs > NATIVE_CAPACITY_RETRY_BUDGET_MS ? "budget" : undefined;
    options.onEvent?.({ source: "native_upstream", status: 503, attempt: attempt + 1,
      ...(exhausted ? { exhausted } : { delayMs }) });
    // Preserve the final upstream body and Retry-After, including waits beyond our budget.
    if (exhausted) return response;
    await response.body?.cancel();
    await sleep(delayMs, request.signal);
  }
}
