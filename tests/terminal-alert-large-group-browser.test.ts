import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { throwIfChatGptTerminalErrorAlert } from "../src/adapters/chatgpt-web/browser-worker";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("terminal error probe stays bounded on a large grouped prompt and preserves short error detection", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.abort());
    await page.setContent('<article><div data-user-message-bubble></div><div data-conversation-role="assistant"><div class="markdown">PART_ACCEPTED</div><div id="alert"></div></div></article>');
    await page.locator('[data-user-message-bubble]').evaluate(element => { element.textContent = "Something went wrong ".repeat(15_500); });
    const scope = page.locator("article");
    const started = performance.now();
    await throwIfChatGptTerminalErrorAlert(scope);
    expect(performance.now() - started).toBeLessThan(1_000);
    await page.locator("#alert").evaluate(element => {
      element.innerHTML = '<span>Something went wrong.</span><span> Please contact our help center at </span><a href="#help">help.openai.com</a>.';
    });
    await expect(throwIfChatGptTerminalErrorAlert(scope)).rejects.toMatchObject({ code: "upstream_server_error", retryable: true });
    await page.locator("#alert").evaluate(element => { element.textContent = "Something went wrong. If this persists, please\ncontact help.openai.com."; });
    await expect(throwIfChatGptTerminalErrorAlert(scope)).rejects.toMatchObject({ code: "upstream_server_error", retryable: true });
    await page.locator("#alert").evaluate(element => { element.textContent = ""; });
    // A complete error quote in a user prompt or answer is content, not ChatGPT's error UI.
    const quote = "Something went wrong. Please contact help.openai.com.";
    await page.locator('[data-user-message-bubble]').evaluate((element, quote) => {
      element.innerHTML = '<div>'.repeat(160) + '</div>'.repeat(160);
      let deepest: Element = element; while (deepest.firstElementChild) deepest = deepest.firstElementChild;
      deepest.textContent = (quote + " ").repeat(6_000);
    }, quote);
    await page.locator(".markdown").evaluate((element, quote) => { element.textContent = quote; }, quote);
    const quotedStarted = performance.now();
    await throwIfChatGptTerminalErrorAlert(scope);
    expect(performance.now() - quotedStarted).toBeLessThan(1_000);
    await page.locator("#alert").evaluate((element, quote) => { element.innerHTML = '<span hidden></span>'; element.firstElementChild!.textContent = quote; }, quote);
    await throwIfChatGptTerminalErrorAlert(scope);
    await page.locator("#alert").evaluate((element, quote) => { element.textContent = quote; }, quote);
    await expect(throwIfChatGptTerminalErrorAlert(scope)).rejects.toMatchObject({ code: "upstream_server_error" });
  } finally { await browser.close(); }
}, 10_000);
