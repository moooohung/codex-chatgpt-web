import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { chatGptSubmissionDomProjection } from "../src/adapters/chatgpt-web/submission-ui";
import { CHATGPT_USER_TURN_SELECTOR, CHATGPT_ASSISTANT_TURN_SELECTOR } from "../src/chatgpt-ui/turns";
import { CHATGPT_STOP_BUTTON_SELECTOR } from "../src/chatgpt-ui/composer";

const options = { userTurnSelector: CHATGPT_USER_TURN_SELECTOR, assistantTurnSelector: CHATGPT_ASSISTANT_TURN_SELECTOR,
  stopButtonSelector: CHATGPT_STOP_BUTTON_SELECTOR, attributeFilter: ["data-turn-key", "class", "aria-hidden"] };

for (const chars of [320_000, 1_000_000]) test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(
  `${chars} chars: unchanged projections skip transcript copying, DOM walks and attribute writes`, async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
    try {
      const page = await browser.newPage();
      await page.route("**/*", route => route.abort());
      await page.setContent('<main><article data-turn-key="old"><div data-user-message-bubble></div></article>'
        + '<article data-turn-key="current"><div data-user-message-bubble>new</div>'
        + '<div data-conversation-role="assistant">answer</div></article></main>');
      await page.locator("[data-user-message-bubble]").first().evaluate((node, chars) => { node.textContent = "x".repeat(chars); }, chars);
      await page.evaluate(chatGptSubmissionDomProjection, options);
      const full = await page.evaluate(chatGptSubmissionDomProjection, options);
      // Repeated cached reads must not rebuild a second copy of the payload or walk
      // the transcript. Guard the actual browser primitives, not a fake DOM.
      await page.evaluate(() => {
        Object.defineProperty(document.body, "textContent", { configurable: true, get() { throw Error("copied full body"); } });
        (globalThis as any).__walk = Document.prototype.querySelectorAll;
        Document.prototype.querySelectorAll = function () { throw Error("walked unchanged DOM"); };
        (globalThis as any).__write = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function () { throw Error("rewrote unchanged attributes"); };
      });
      for (let i = 0; i < 10; i++) {
        const cached = await page.evaluate(chatGptSubmissionDomProjection, { ...options, knownKey: full.key });
        expect(cached.snapshot).toBeUndefined();
        expect(cached.bodyTextChars).toBe(full.bodyTextChars);
        expect(cached.deferredInputNodes).toBe(full.deferredInputNodes);
      }
      await page.evaluate(() => {
        delete (document.body as any).textContent;
        Document.prototype.querySelectorAll = (globalThis as any).__walk;
        Element.prototype.setAttribute = (globalThis as any).__write;
      });
      // Changed budget cannot reuse old metrics or leave stale rendering attributes.
      const disabled = await page.evaluate(chatGptSubmissionDomProjection, { ...options, knownKey: full.key,
        renderBudget: { history: false, multipart: false, motion: false, sidebar: false } });
      expect(disabled.snapshot?.userTurnCount).toBe(2);
      expect(disabled.deferredInputNodes).toBe(0);
      expect(await page.locator('[data-codex-input-render-budget="auto"]').count()).toBe(0);
      // Boundary reads retain identities even when the caller has a current key.
      const boundary = await page.evaluate(chatGptSubmissionDomProjection, { ...options, knownKey: full.key, purpose: "tool_boundary" as const });
      expect(boundary.snapshot?.responseIdentities).toEqual(["group:assistant:current"]);
    } finally { await browser.close(); }
  }, 20_000,
);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("pending mutations invalidate cached identities before the observer callback", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.abort());
    await page.setContent('<article data-turn-key="first"><div data-user-message-bubble>user</div></article>');
    await page.evaluate(chatGptSubmissionDomProjection, options);
    const baseline = await page.evaluate(chatGptSubmissionDomProjection, options);
    const project = chatGptSubmissionDomProjection.toString();
    const duplicate = await page.evaluate(({ project, options, key }) => {
      const next = document.createElement("article"); next.dataset.turnKey = "first"; document.body.append(next);
      // Evaluation and mutation share the same task: takeRecords must invalidate
      // before MutationObserver gets its microtask, so duplicate identities fail.
      try { (0, eval)(`(${project})`)({ ...options, knownKey: key }); return "accepted"; }
      catch (error) { return (error as Error).message; }
    }, { project, options, key: baseline.key });
    expect(duplicate).toContain("duplicate conversation turn identities");
    await page.locator("article").last().evaluate(node => node.remove());
    const next = await page.evaluate(chatGptSubmissionDomProjection, options);
    const changed = await page.evaluate(({ project, options, key }) => {
      document.querySelector("article")!.setAttribute("data-turn-key", "renamed");
      return (0, eval)(`(${project})`)({ ...options, knownKey: key });
    }, { project, options, key: next.key });
    expect(changed.snapshot.userIdentities).toEqual(["group:user:renamed"]);
    const textChanged = await page.evaluate(({ project, options, key }) => {
      document.querySelector("[data-user-message-bubble]")!.firstChild!.textContent += " more";
      return (0, eval)(`(${project})`)({ ...options, knownKey: key });
    }, { project, options, key: changed.key });
    expect(textChanged.snapshot.userTurnCount).toBe(1);
    expect(textChanged.bodyTextChars).toBeGreaterThan(changed.bodyTextChars);
  } finally { await browser.close(); }
}, 20_000);
