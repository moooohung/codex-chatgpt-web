import type { Page } from "playwright-core";
import { ChatGptWebAdapterError } from "./adapter-error";

export const DEFAULT_CHATGPT_UNUSUAL_ACTIVITY_COOLDOWN_MINUTES = 3;
export const CHATGPT_UNUSUAL_ACTIVITY_MESSAGE_PREFIX = "ChatGPT unusual activity detected: ";

export type ChatGptPageRequestRejection = {
  kind: "unusual_activity" | "request_rejected";
  text: string;
};

export function resolveChatGptUnusualActivityCooldownMinutes(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.CODEX_WEB_GPT_UNUSUAL_ACTIVITY_COOLDOWN_MINUTES?.trim();
  if (!raw) return DEFAULT_CHATGPT_UNUSUAL_ACTIVITY_COOLDOWN_MINUTES;
  const minutes = Number(raw);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
    throw new Error("CODEX_WEB_GPT_UNUSUAL_ACTIVITY_COOLDOWN_MINUTES must be an integer from 1 to 1440");
  }
  return minutes;
}

/** Runs inside the ChatGPT page. Keep all selectors and matchers self-contained. */
export function chatGptPageRequestRejectionUiState(alerts: Element[]): ChatGptPageRequestRejection | undefined {
  const prose = [
    // New ChatGPT places product error cards inside the conversation group.
    // Exclude actual message prose, not the entire owning turn container.
    "[data-user-message-bubble]",
    "[data-message-author-role]",
    ".markdown",
    "[data-markdown-text-style]",
    "pre",
    "code",
    "blockquote",
    '[data-testid^="cot-v5"]',
  ].join(", ");
  const visible = (element: Element): boolean => {
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return element.isConnected
      && style?.display !== "none"
      && style?.visibility !== "hidden"
      && style?.visibility !== "collapse"
      && style?.opacity !== "0"
      && (bounds.width > 0 || bounds.height > 0);
  };
  const normalize = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
  for (const alert of alerts) {
    if (!visible(alert) || alert.closest(prose)) continue;
    // A retained conversation may still contain the error from an earlier request.
    // Keep global banners, but never turn a historical turn's card into a new block.
    const turns = '[data-testid^="conversation-turn-"], [data-turn-key]';
    const owner = alert.closest(turns);
    if (owner) {
      const all = Array.from(alert.ownerDocument.querySelectorAll(turns));
      if (all.some(turn => turn !== owner && !owner.contains(turn)
        && Boolean(owner.compareDocumentPosition(turn) & 4))) continue;
    }
    const text = normalize(alert.textContent);
    if (!text) continue;
    if (/detected unusual activity/i.test(text)) return { kind: "unusual_activity", text };
    const retry = Array.from(alert.querySelectorAll("button")).some(button => visible(button)
      && /^(?:Retry|다시 시도)$/i.test(normalize(button.textContent)));
    if (retry && /^(?:Unknown error|Something went wrong|알 수 없는 오류|오류가 발생)/i.test(text)) {
      return { kind: "request_rejected", text };
    }
  }
  return undefined;
}

export function unusualActivityProviderWaitMs(text: string): number | undefined {
  const matches = [...text.matchAll(/(?:try again|retry|wait)\s+(?:(?:in|after|for)\s+)?(\d+)\s*(seconds?|minutes?|hours?)\b/gi)];
  for (const match of text.matchAll(/(\d+)\s*(초|분|시간)\s*(?:후|뒤)/g)) matches.push(match);
  const waits = matches.map(match => Number(match[1])
    * (/^(?:hour|시간)/i.test(match[2]!) ? 3_600_000 : /^(?:minute|분)/i.test(match[2]!) ? 60_000 : 1000))
    .filter(wait => Number.isSafeInteger(wait) && wait > 0 && wait <= 24 * 60 * 60_000);
  return waits.length ? Math.max(...waits) : undefined;
}

async function localHistoryUnavailable(page: Page): Promise<boolean> {
  if (!/\/c\/local-chatgpt:/i.test(page.url())) return false;
  return page.getByText("Unable to load history", { exact: true })
    .filter({ visible: true })
    .last()
    .isVisible()
    .catch(() => false);
}

export async function throwIfChatGptPageRequestRejected(
  page: Page,
  traceId = "untracked",
  cooldownMinutes = resolveChatGptUnusualActivityCooldownMinutes(),
): Promise<void> {
  const rejection = await page.locator('[role="alert"]').evaluateAll(chatGptPageRequestRejectionUiState);
  if (!rejection || (rejection.kind !== "unusual_activity" && rejection.kind !== "request_rejected")) return;
  if (rejection.kind === "request_rejected") {
    throw new ChatGptWebAdapterError(
      `${rejection.text} ChatGPT rejected the current request before an answer was created.`,
      { status: 502, errorType: "server_error", code: "chatgpt_submission_failed", retryable: false },
    );
  }
  const providerWait = unusualActivityProviderWaitMs(rejection.text);
  const waitMs = Math.max(cooldownMinutes * 60_000, providerWait ?? 0);
  const retryAt = Date.now() + waitMs;
  const supportingEvidence = await localHistoryUnavailable(page);
  console.warn(`[chatgpt-web] unusual_activity_detected ${JSON.stringify({
    traceId,
    retryAt,
    localCooldown: providerWait === undefined,
    supportingEvidence: supportingEvidence ? "local_history_unavailable" : undefined,
  })}`);
  throw new ChatGptWebAdapterError(
    `${CHATGPT_UNUSUAL_ACTIVITY_MESSAGE_PREFIX}${rejection.text} Local retry check after ${Math.ceil(waitMs / 60_000)} minutes.`,
    {
      status: 429,
      errorType: "rate_limit_error",
      code: "chatgpt_unusual_activity",
      retryable: false,
      retryAt,
      retryAfterSeconds: Math.ceil(waitMs / 1000),
      localCooldown: providerWait === undefined,
    },
  );
}
