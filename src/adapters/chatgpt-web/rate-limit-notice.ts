import type { Page } from "playwright-core";
import { isChatGptRateLimitNoticeMessage, parseRetryAtFromMessage } from "../../lib/errors";
import { ChatGptWebAdapterError } from "./adapter-error";

/** Read only short account notices; never search generic divs or conversation text. */
export async function throwIfChatGptRateLimitNotice(page: Page): Promise<void> {
  const scope = page.locator(
    '[role="status"], [role="alert"], [role="banner"], '
    + '[data-testid="composer-status"], form [aria-live="polite"], form [aria-live="assertive"]',
  );
  // Legacy worker fixtures model only visibility; real observation errors must still propagate.
  if (typeof scope.evaluateAll !== "function") return;
  const notices = await scope.evaluateAll(roots => {
    const excluded = '[data-message-author-role], [data-conversation-role], [data-user-message-bubble], '
      + '[data-testid^="conversation-turn"], [data-turn-key], [data-turn-id-container], '
      + '.markdown, [data-markdown-text-style], pre, code, blockquote, '
      + '[contenteditable="true"], textarea, script, style, template, [role="dialog"]';
    const snippets: Array<{ text: string; description: boolean }> = [];
    const seen = new WeakMap<Node, string | null>();
    let remainingNodes = 512;
    const hidden = (element: Element): boolean => {
      const style = element.ownerDocument.defaultView?.getComputedStyle(element);
      return element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true"
        || style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse";
    };
    const read = (node: Node, depth: number): string | null => {
      if (seen.has(node)) return seen.get(node)!;
      if (--remainingNodes < 0 || depth > 64) return null;
      if (node.nodeType === 3) return (node as Text).data.length <= 1_024 ? (node as Text).data : null;
      if (node.nodeType !== 1) return "";
      const element = node as Element;
      if (hidden(element)) return "";
      if (element.matches(excluded)) return null;
      let text: string | null = "";
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (remainingNodes <= 0) { text = null; break; }
        const part = read(child, depth + 1);
        text = text === null || part === null || text.length + part.length > 1_024 ? null : text + part;
      }
      seen.set(node, text);
      if (text !== null && snippets.length < 64 && /hour|ChatGPT reliable/i.test(text)) {
        const bounds = element.getBoundingClientRect();
        if (element.isConnected && (bounds.width > 0 || bounds.height > 0)) {
          // Parents follow their children in this scan; prefer their complete inline text.
          snippets.unshift({ text: text.trim(), description: element.matches(".description") });
        }
      }
      return text;
    };
    for (const root of roots.slice(0, 32)) {
      if (remainingNodes <= 0) break;
      if (root.closest(excluded)) continue;
      // aria-live is accepted only in the actual composer form, not arbitrary forms.
      if (!root.matches('[role="status"], [role="alert"], [role="banner"], [data-testid="composer-status"]')
        && !root.closest("form")?.querySelector('#prompt-textarea, [data-testid="prompt-textarea"], [data-composer-markdown][role="textbox"]')) continue;
      let ancestor: Element | null = root, depth = 0;
      while (ancestor && depth++ < 64 && !hidden(ancestor)) ancestor = ancestor.parentElement;
      if (ancestor) continue;
      read(root, 0);
    }
    return snippets;
  });
  if (!Array.isArray(notices)) return;
  const notice = (notices.find(item => item.description && isChatGptRateLimitNoticeMessage(item.text))
    ?? notices.find(item => isChatGptRateLimitNoticeMessage(item.text)))?.text;
  if (notice === undefined) return;
  const now = Date.now();
  const retryAt = parseRetryAtFromMessage(notice, now);
  if (retryAt <= now) return;
  throw new ChatGptWebAdapterError(notice, {
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: false,
    retryAt,
    retryAfterSeconds: Math.max(0, Math.ceil((retryAt - now) / 1_000)),
  });
}
