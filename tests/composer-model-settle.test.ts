import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { formatChatGptWebMultipartStage } from "../src/adapters/chatgpt-web/prompt";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("multipart replacement clears the editor model before the next complete draft", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<form data-chatgpt-composer><div role="textbox" data-composer-markdown contenteditable="true" style="min-height:60px"></div><button type="submit" disabled>Send</button></form>`);
    // Controlled rich editors can restore a multiline draft while reconciling a
    // DOM-only deletion. Keyboard deletion commits the empty model synchronously.
    await page.locator('[contenteditable]').evaluate(editor => {
      let committed = "", keyboardDelete = false;
      editor.addEventListener("keydown", event => {
        if ((event as KeyboardEvent).key === "Backspace") { keyboardDelete = true; committed = ""; }
      });
      editor.addEventListener("input", () => {
        if (editor.textContent === "" && committed && !keyboardDelete) {
          queueMicrotask(() => { editor.textContent = committed; });
        } else { committed = editor.textContent ?? ""; }
        keyboardDelete = false;
        (document.querySelector('button') as HTMLButtonElement).disabled = !committed;
      });
    });
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { config: { appName: "Codex Native2" } }) as any;
    for (const count of [30, 3_000, 16_500]) {
      const payload = JSON.stringify({ records: [{ content: "synthetic 0123456789 ".repeat(count) }] });
      const prompt = formatChatGptWebMultipartStage(payload, "ctx_" + "a".repeat(32), 1, 2).text;
      await worker.attachPrompt(page, prompt, false);
      expect(await worker.attachedPromptText(page)).toBe(prompt);
      expect(await page.locator('button[type="submit"]').isEnabled()).toBeTrue();
    }
  } finally { await browser.close(); }
}, 45_000);
