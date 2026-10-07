import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { chatGptSessionFailureUiState } from "../src/adapters/chatgpt-web/session-ui";
import { throwIfChatGptSessionFailureAlert } from "../src/adapters/chatgpt-web/browser-worker";

const projections = [{ name: "source", project: chatGptSessionFailureUiState }];
if (process.env.CHATGPT_RENDER_CANDIDATE_ROOT) for (const relative of ["app/cli.js", "app/browser-helper.cjs"]) {
  const file = ts.createSourceFile(relative, readFileSync(join(process.env.CHATGPT_RENDER_CANDIDATE_ROOT, relative), "utf8"), ts.ScriptTarget.Latest, true);
  const functions = file.statements.filter(ts.isFunctionDeclaration).filter(node => {
    const text = node.getText(file);
    return text.includes("Your session has expired") && text.includes("Failed to load subscription") && text.includes("new WeakMap");
  });
  if (functions.length !== 1) throw Error("Exactly one compiled session-error projection is required");
  projections.push({ name: relative, project: vm.runInNewContext(`(${functions[0]!.getText(file)})`) });
}
const measurements: unknown[] = [];
for (const { name, project } of projections) for (const chars of [320_000, 1_000_000]) {
  test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`${name}: session alerts ignore ${chars} chars of quoted context and detect real errors`, async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
    let requests = 0;
    try {
      const page = await browser.newPage();
      await page.route("**/*", route => { requests++; return route.abort(); });
      await page.setContent('<aside role="alert" id="outer"><article data-turn-key="history"><div data-user-message-bubble></div><div class="markdown"><pre></pre></div></article><div id="real"></div></aside><div role="dialog" id="other">Account</div>');
      await page.evaluate(chars => {
        const bubble = document.querySelector('[data-user-message-bubble]')!;
        let current = bubble;
        for (let i = 0; i < 160; i++) { const node = document.createElement("div"); current.appendChild(node); current = node; }
        current.textContent = "Your session has expired. Failed to load subscription. ".repeat(Math.ceil(chars / 53)).slice(0, chars);
        document.querySelector('.markdown pre')!.textContent = "Your session has expired. Failed to load subscription.";
      }, chars);
      const roles = page.locator('[role="alert"], [role="dialog"]');
      const originalText = await page.locator('[data-user-message-bubble]').textContent();
      // The old hasText selector mistakes a large quoted prompt for account-error UI.
      expect(await roles.filter({ hasText: /Your session has expired/i }).count()).toBe(1);
      const started = performance.now();
      expect(await roles.evaluateAll(project)).toBeUndefined();
      const elapsedMs = performance.now() - started;
      expect(elapsedMs).toBeLessThan(1_000);
      await throwIfChatGptSessionFailureAlert(page);
      await page.locator("#real").evaluate(node => { node.innerHTML = '<div role="alert"><span>Your session </span><strong>has expired</strong><button>Log in</button></div>'; });
      expect(await roles.evaluateAll(project)).toBe("expired");
      await expect(throwIfChatGptSessionFailureAlert(page)).rejects.toMatchObject({ code: "chatgpt_session_expired", status: 401, retryable: false });
      for (const copy of ["你的工作階段已過期", "您的会话已过期", "Your session has expired"]) {
        await page.locator("#real").evaluate((node, copy) => { node.textContent = copy; }, copy);
        expect(await roles.evaluateAll(project)).toBe("expired");
      }
      await page.locator("#real").evaluate(node => { node.innerHTML = '<div role="alert"><span>Failed to load </span><b>subscription</b></div>'; });
      expect(await roles.evaluateAll(project)).toBe("subscription");
      await expect(throwIfChatGptSessionFailureAlert(page)).rejects.toMatchObject({ code: "chatgpt_subscription_unavailable", status: 503, retryable: true });
      for (const hidden of ['hidden', 'style="display:none"', 'style="visibility:hidden"']) {
        await page.locator("#real").evaluate((node, hidden) => { node.innerHTML = `<section ${hidden}><span>Your session has expired</span></section>`; }, hidden);
        expect(await roles.evaluateAll(project)).toBeUndefined();
      }
      await page.locator("#real").evaluate(node => { node.innerHTML = '<code role="alert">Your session has expired</code><blockquote>Failed to load subscription</blockquote>'; });
      expect(await roles.evaluateAll(project)).toBeUndefined();
      expect(await page.locator('[data-user-message-bubble]').textContent()).toBe(originalText);
      expect(requests).toBe(0);
      measurements.push({ name, chars, elapsedMs, requests, liveWorkerSends: 0, proTestSends: 0 });
      if (process.env.CHATGPT_SESSION_FIXTURE_REPORT) writeFileSync(process.env.CHATGPT_SESSION_FIXTURE_REPORT, JSON.stringify(measurements, null, 2));
    } finally { await browser.close(); }
  }, 20_000);
}
