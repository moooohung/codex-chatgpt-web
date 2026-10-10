import type { Page } from "playwright-core";
import { ChatGptWebAdapterError } from "./adapter-error";

export const DEFAULT_CHATGPT_UNUSUAL_ACTIVITY_COOLDOWN_MINUTES = 30;
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
    "[data-turn-key]",
    "[data-turn-id-container]",
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
  const retryAt = Date.now() + cooldownMinutes * 60_000;
  const supportingEvidence = await localHistoryUnavailable(page);
  console.warn(`[chatgpt-web] unusual_activity_detected ${JSON.stringify({
    traceId,
    retryAt,
    supportingEvidence: supportingEvidence ? "local_history_unavailable" : undefined,
  })}`);
  throw new ChatGptWebAdapterError(
    `${CHATGPT_UNUSUAL_ACTIVITY_MESSAGE_PREFIX}${rejection.text} Try again in ${cooldownMinutes} minutes.`,
    {
      status: 429,
      errorType: "rate_limit_error",
      code: "chatgpt_unusual_activity",
      retryable: false,
      retryAt,
      retryAfterSeconds: cooldownMinutes * 60,
    },
  );
}
