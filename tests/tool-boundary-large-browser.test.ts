import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker, ChatGptCompletionTracker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { chatGptSubmissionDomProjection } from "../src/adapters/chatgpt-web/submission-ui";
import { CHATGPT_ASSISTANT_TURN_SELECTOR, CHATGPT_USER_TURN_SELECTOR, CHATGPT_STOP_BUTTON_SELECTOR } from "../src/chatgpt-session";

for (const chars of [320_000, 1_000_000]) test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(
  `${chars} chars: boundary capture does not wait for input layout and still observes before ACK`, async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
    try {
      const page = await browser.newPage();
      await page.route("**/*", route => route.abort());
      await page.setContent('<main><article data-turn-key="current"><div data-user-message-bubble><pre></pre></div>'
        + '<div data-content-search-unit-key="assistant_current"><div data-conversation-role="assistant">'
        + '<div class="markdown"><p>Exact answer before tool release.</p></div>'
        + '<button data-testid="copy-turn-action-button">Copy</button></div></div></article></main>'
        + '<button data-testid="stop-button">Stop</button>');
      await page.evaluate(chars => {
        document.querySelector("pre")!.textContent = "source line\n".repeat(Math.ceil(chars / 12)).slice(0, chars);
        const bounds = HTMLElement.prototype.getBoundingClientRect;
        HTMLElement.prototype.getBoundingClientRect = function () {
          if (this.matches('[data-testid="stop-button"]')) throw new Error("huge input layout would stall here");
          return bounds.call(this);
        };
      }, chars);
      // The old complete submission probe forces the problematic layout before answer capture.
      await expect(page.evaluate(chatGptSubmissionDomProjection, {
        userTurnSelector: CHATGPT_USER_TURN_SELECTOR, assistantTurnSelector: CHATGPT_ASSISTANT_TURN_SELECTOR,
        stopButtonSelector: CHATGPT_STOP_BUTTON_SELECTOR, attributeFilter: [],
      })).rejects.toThrow("huge input layout would stall here");
      // Reading the full transcript only to refresh the size hint also scales
      // with old multipart input. The boundary must retain identities and answer
      // text without touching this unrelated, expensive body serialization.
      await page.evaluate(() => {
        Object.defineProperty(document.body, "textContent", {
          configurable: true,
          get() { throw new Error("boundary serialized the full body"); },
        });
      });
      const worker: any = Object.create(ChatGptBrowserWorker.prototype);
      const tracker = new ChatGptCompletionTracker();
      const progress = new ChatGptExternalTurnProgress();
      const revision = progress.recordToolBatch(1);
      const order: string[] = [];
      const observe = tracker.observeToolBatch.bind(tracker);
      tracker.observeToolBatch = (batch, text) => {
        expect(text).toBe("Exact answer before tool release.");
        order.push("observe");
        return observe(batch, text);
      };
      const acknowledge = progress.acknowledgeToolBatch.bind(progress);
      progress.acknowledgeToolBatch = async batch => {
        expect(order).toEqual(["observe"]);
        order.push("ack");
        return acknowledge(batch);
      };
      await worker.observeSubmissionToolBoundary(page, { initialTurnIdentities: [] }, undefined, progress, tracker);
      await progress.waitForToolBatchObservation(revision);
      order.push("emission");
      expect(order).toEqual(["observe", "ack", "emission"]);
      expect(await page.locator("pre").textContent()).toHaveLength(chars);
      expect(tracker.needsToolBatchObservation(revision)).toBeFalse();
    } finally { await browser.close(); }
  }, 30_000,
);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("boundary identity reads still reject duplicate groups", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.abort());
    await page.setContent('<article data-turn-key="same"></article><article data-turn-key="same"></article>');
    await expect(page.evaluate(chatGptSubmissionDomProjection, {
      userTurnSelector: CHATGPT_USER_TURN_SELECTOR, assistantTurnSelector: CHATGPT_ASSISTANT_TURN_SELECTOR,
      stopButtonSelector: CHATGPT_STOP_BUTTON_SELECTOR, attributeFilter: [], purpose: "tool_boundary" as const,
    })).rejects.toThrow("duplicate conversation turn identities");
  } finally { await browser.close(); }
});
