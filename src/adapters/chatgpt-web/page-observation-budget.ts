/** Existing diagnostic character counts are hints about renderer work, never Send evidence. */
export const CHATGPT_PAGE_OBSERVATION_BASE_MS = 5_000;
export const CHATGPT_PAGE_OBSERVATION_MAX_MS = 20_000;
const CHARS_PER_OBSERVATION_STEP = 250_000;
const observedPageSizes = new WeakMap<object, number>();

export function chatGptObservationBudgetForSize(chars: number): number {
  if (!Number.isFinite(chars) || chars < 0) return CHATGPT_PAGE_OBSERVATION_BASE_MS;
  const steps = Math.max(1, Math.min(4, Math.ceil(chars / CHARS_PER_OBSERVATION_STEP)));
  return Math.min(CHATGPT_PAGE_OBSERVATION_MAX_MS, steps * CHATGPT_PAGE_OBSERVATION_BASE_MS);
}

export function recordChatGptPageObservationSize(page: object, chars: number): void {
  if (!Number.isFinite(chars) || chars < 0) return;
  // Keep only a bounded numeric high-water hint. SPA URL changes must not erase
  // the hint exactly when a large submission starts its conversation.
  observedPageSizes.set(page, Math.max(observedPageSizes.get(page) ?? 0, Math.min(chars, 1_000_000)));
}

export function chatGptPageObservationTimeoutMs(page: object): number {
  return chatGptObservationBudgetForSize(observedPageSizes.get(page) ?? 0);
}

export function inheritChatGptPageObservationBudget(previousPage: object, nextPage: object): void {
  recordChatGptPageObservationSize(nextPage, observedPageSizes.get(previousPage) ?? 0);
}
