import { expect, test } from "bun:test";
import vm from "node:vm";
import { compiledSubmissionProjection } from "./compiled-projection";
import { chromium } from "playwright-core";
import { CHATGPT_ASSISTANT_TURN_SELECTOR, CHATGPT_USER_TURN_SELECTOR } from "../src/chatgpt-ui/turns";
import { CHATGPT_STOP_BUTTON_SELECTOR } from "../src/chatgpt-ui/composer";
const runtime = process.env.CHATGPT_STAGE_CALL_RUNTIME_ROOT;

test.skipIf(!runtime || !process.env.CHATGPT_DOM_TEST_BROWSER)("both installed bundle projections preserve a 1.2M transcript without serializing its body at a boundary", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  let requests = 0;
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => { requests++; return route.abort(); });
    for (const relative of ["app/cli.js", "app/browser-helper.cjs"]) {
      const projection = vm.runInNewContext(`(${compiledSubmissionProjection(runtime!, relative)})`);
      await page.setContent('<main><article data-turn-key="current"><div data-user-message-bubble><pre></pre></div>'
        + '<div data-content-search-unit-key="assistant_current"><div data-conversation-role="assistant">'
        + '<div class="markdown">Observed answer</div></div></div></article></main>');
      await page.locator("pre").evaluate(element => { element.textContent = "x".repeat(1_200_000); });
      const options = { userTurnSelector: CHATGPT_USER_TURN_SELECTOR, assistantTurnSelector: CHATGPT_ASSISTANT_TURN_SELECTOR,
        stopButtonSelector: CHATGPT_STOP_BUTTON_SELECTOR, attributeFilter: [] };
      const normal: any = await page.evaluate(projection, options);
      expect(normal.bodyTextChars).toBeGreaterThanOrEqual(1_200_000);
      await page.evaluate(() => Object.defineProperty(document.body, "textContent", {
        configurable: true, get() { throw new Error("full-body serialization was attempted"); },
      }));
      const boundary: any = await page.evaluate(projection, { ...options, purpose: "tool_boundary", knownKey: normal.key });
      expect(boundary.bodyTextChars).toBeUndefined();
      expect(boundary.snapshot.turnIdentities).toEqual(normal.snapshot.turnIdentities);
      expect(boundary.snapshot.responseIdentities).toEqual(normal.snapshot.responseIdentities);
      expect(boundary.snapshot.responseIdentities).toHaveLength(1);
      expect(await page.locator("pre").textContent()).toHaveLength(1_200_000);
      await page.evaluate(() => { delete (document.body as any).textContent; });
    }
    expect(requests).toBe(0);
  } finally { await browser.close(); }
}, 15_000);
