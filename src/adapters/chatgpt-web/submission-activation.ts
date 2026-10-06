/** Observe acceptance during the one physical Send; an input acknowledgement is not acceptance. */
export async function observeSubmissionDuringActivation<T>(
  activate: (signal: AbortSignal) => Promise<void>,
  observe: (signal: AbortSignal) => Promise<T>,
  abortSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const signal = abortSignal
    ? AbortSignal.any([abortSignal, controller.signal])
    : controller.signal;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    // Both branches own their rejections even when the other branch wins. In particular, a
    // renderer may submit on keydown and stall before the keyboard transport acknowledges it.
    const activation = Promise.resolve().then(() => { signal.throwIfAborted(); return activate(signal); });
    const acceptance = Promise.resolve().then(() => { signal.throwIfAborted(); return observe(signal); });
    const activationFailure = activation.then(() => new Promise<never>(() => {}));
    return await Promise.race([acceptance, activationFailure, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    // Cancel outstanding observation/input work. Never issue a replacement Send or navigate.
    controller.abort();
  }
}
