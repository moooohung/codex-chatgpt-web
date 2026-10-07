import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker, chatGptTurnIsComplete } from "../src/adapters/chatgpt-web/browser-worker";

const fixture = readFileSync(new URL("./fixtures/chatgpt-response-wait.html", import.meta.url), "utf8");

for (const chars of [320_000, 1_000_000]) {
  test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`${chars} chars: real DOM wait notices gate completion and recover without sending`, async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
    try {
      const page = await browser.newPage();
      let requests = 0;
      await page.route("**/*", route => { requests++; return route.abort(); });
      await page.setContent(fixture);
      await page.locator("[data-user-message-bubble]").evaluate((element, size) => {
        element.textContent = "Synthetic context. ".repeat(Math.ceil(size / 19)).slice(0, size);
      }, chars);
      const worker: any = Object.create(ChatGptBrowserWorker.prototype);
      const current = page.locator("#turn");
      const cache = {};
      const observe = () => worker.responseDomSnapshot(current, cache);
      const complete = (snapshot: any) => chatGptTurnIsComplete({ ...snapshot, currentText: snapshot.visibleText, running: false });
      const started = performance.now();
      const waiting = await observe();
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(waiting.responseWaitState).toBe("connection_interrupted_and_service_thinking");
      expect(waiting.visibleText).toBe("Partial answer.");
      expect(waiting.traceBlocks.some((block: any) => /Connection interrupted|Our systems are thinking/.test(block.text))).toBeFalse();
      expect(complete(waiting)).toBeFalse();

      await current.evaluate(element => { (element as HTMLElement).style.visibility = "hidden"; });
      expect((await observe()).responseWaitState).toBeUndefined();
      await current.evaluate(element => { (element as HTMLElement).style.visibility = "visible"; });
      expect((await observe()).responseWaitState).toBe("connection_interrupted_and_service_thinking");

      await page.locator("#service-wait").evaluate(element => { element.remove(); });
      expect((await observe()).responseWaitState).toBe("connection_interrupted");
      await page.locator("#connection-wait").evaluate(element => { element.remove(); });
      const recovered = await observe();
      expect(recovered.responseWaitState).toBeUndefined();
      expect(complete(recovered)).toBeTrue();

      await page.locator("[data-markdown-text-style]").evaluate(element => {
        element.innerHTML = '<div role="status">Our systems are thinking a bit more about this request before responding.</div>';
      });
      expect((await observe()).responseWaitState).toBeUndefined();
      expect(await page.locator("[data-user-message-bubble]").textContent()).toHaveLength(chars);
      expect(requests).toBe(0);
    } finally { await browser.close(); }
  }, 15_000);
}
