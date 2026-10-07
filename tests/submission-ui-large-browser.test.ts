import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { chatGptSubmissionDomProjection } from "../src/adapters/chatgpt-web/submission-ui";
import { CHATGPT_ASSISTANT_TURN_SELECTOR, CHATGPT_USER_TURN_SELECTOR, CHATGPT_STOP_BUTTON_SELECTOR } from "../src/chatgpt-session";
import { writeFileSync } from "node:fs";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("1.2M-character synthetic transcript retains all DOM text/identities and fully renders the current boundary", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  let networkRequests = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 800 } });
    await page.route("**/*", route => { networkRequests++; return route.abort(); });
    await page.setContent('<main></main>');
    await page.evaluate(() => {
      const main = document.querySelector("main")!;
      for (let i = 0; i < 12; i++) {
        const group = document.createElement("article"); group.setAttribute("data-turn-key", `fixture_${i}`);
        group.innerHTML = '<div data-user-message-bubble></div><div data-conversation-role="assistant"><div class="markdown"></div></div>';
        group.querySelector('[data-user-message-bubble]')!.textContent = "x".repeat(99998);
        group.querySelector('.markdown')!.textContent = "OK"; main.appendChild(group);
      }
    });
    const before = await page.evaluate(() => document.body.textContent!);
    expect(before.length).toBe(1200000);
    const started = performance.now();
    const state = await page.evaluate(chatGptSubmissionDomProjection, { userTurnSelector: CHATGPT_USER_TURN_SELECTOR,
      assistantTurnSelector: CHATGPT_ASSISTANT_TURN_SELECTOR, stopButtonSelector: CHATGPT_STOP_BUTTON_SELECTOR, attributeFilter: [] });
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(1000); expect(state.bodyTextChars).toBe(1200000); expect(state.deferredHistoryNodes).toBe(10);
    expect(state.snapshot?.userTurnCount).toBe(12); expect(state.snapshot?.assistantTurnCount).toBe(12);
    expect(await page.evaluate(() => document.body.textContent!)).toBe(before);
    expect(await page.locator('[data-turn-key="fixture_11"]').getAttribute("data-codex-history-render-budget")).toBeNull();
    expect(await page.locator('[data-turn-key="fixture_11"] .markdown').innerText()).toBe("OK");
    await page.evaluate(() => { const node = document.createElement("article"); node.setAttribute("data-turn-key", "fixture_12"); node.innerHTML='<div data-user-message-bubble>new source</div><div data-conversation-role="assistant"><div class="markdown">new answer</div></div>'; document.querySelector("main")!.appendChild(node); });
    const next = await page.evaluate(chatGptSubmissionDomProjection, { userTurnSelector: CHATGPT_USER_TURN_SELECTOR,
      assistantTurnSelector: CHATGPT_ASSISTANT_TURN_SELECTOR, stopButtonSelector: CHATGPT_STOP_BUTTON_SELECTOR, attributeFilter: [] });
    expect(next.snapshot?.responseIdentities).toContain("group:assistant:fixture_12");
    expect(await page.locator('[data-turn-key="fixture_12"]').getAttribute("data-codex-history-render-budget")).toBeNull();
    const cached = await page.evaluate(chatGptSubmissionDomProjection, { userTurnSelector: CHATGPT_USER_TURN_SELECTOR,
      assistantTurnSelector: CHATGPT_ASSISTANT_TURN_SELECTOR, stopButtonSelector: CHATGPT_STOP_BUTTON_SELECTOR, attributeFilter: [], knownKey: next.key });
    expect(cached.bodyTextChars).toBe(next.bodyTextChars);
    if (process.env.CHATGPT_LARGE_RENDER_FIXTURE_REPORT) writeFileSync(process.env.CHATGPT_LARGE_RENDER_FIXTURE_REPORT,
      JSON.stringify({ at: new Date().toISOString(), bodyTextChars: state.bodyTextChars, elapsedMs, inPageProjectionMs: state.projectionElapsedMs,
        deferredHistoryNodes: state.deferredHistoryNodes, totalTurns: 12, allTextAndIdentitiesPreserved: true, currentResponseRendered: true, networkRequests, liveWorkerSends: 0, proTestSends: 0 }, null, 2));
  } finally { await browser.close(); }
}, 15000);
