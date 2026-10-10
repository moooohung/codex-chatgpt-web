import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Page } from "playwright-core";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { throwIfChatGptRateLimitNotice } from "../src/adapters/chatgpt-web/rate-limit-notice";

// Only the provided sanitized notice, never the saved page or account/transcript data.
const savedNotice = "We're doing a quick check to keep ChatGPT reliable. Try again after 8:27 PM.";
const { createWindow } = require("@mixmark-io/domino") as { createWindow(html: string): { document: Document } };
let noticeClock: ReturnType<typeof spyOn>;
beforeEach(() => { noticeClock = spyOn(Date, "now").mockReturnValue(new Date(2026, 9, 10, 20, 0).getTime()); });
afterEach(() => { noticeClock.mockRestore(); });

function fixture(html: string) {
  const window = createWindow(html), document = window.document;
  for (const element of Array.from(document.querySelectorAll("*"))) {
    Object.defineProperty(element, "isConnected", { value: true, configurable: true });
    element.getBoundingClientRect = () => ({ width: 100, height: 20 }) as DOMRect;
  }
  const selectors: string[] = [];
  const page = { locator: (selector: string) => {
    selectors.push(selector);
    return { evaluateAll: async (project: (roots: Element[]) => unknown) =>
      project(Array.from(document.querySelectorAll(selector))) };
  } } as unknown as Page;
  return { page, document, selectors };
}

async function cooldownError(page: Page): Promise<ChatGptWebAdapterError> {
  try { await throwIfChatGptRateLimitNotice(page); }
  catch (error) {
    expect(error).toBeInstanceOf(ChatGptWebAdapterError);
    return error as ChatGptWebAdapterError;
  }
  throw new Error("Expected an account cooldown notice");
}

test("the exact saved aside[role=status] div.description notice throws the original 429", async () => {
  const f = fixture(`<aside role="status"><div class="description">${savedNotice}</div></aside>`);
  const before = Date.now(), error = await cooldownError(f.page), after = Date.now();
  expect(error).toMatchObject({ status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded",
    retryable: false, message: savedNotice });
  expect(error.retryAt).toBeNumber();
  const retryAt = error.retryAt!, target = new Date(retryAt);
  expect([target.getHours(), target.getMinutes(), target.getSeconds(), target.getMilliseconds()]).toEqual([20, 27, 0, 0]);
  expect(retryAt).toBeGreaterThanOrEqual(before);
  expect(error.retryAfterSeconds!).toBeGreaterThanOrEqual(Math.max(0, Math.ceil((retryAt - after) / 1_000)));
  expect(error.retryAfterSeconds!).toBeLessThanOrEqual(Math.ceil((retryAt - before) / 1_000));
  expect(f.selectors).toHaveLength(1);
});

test.each(["status", "alert", "banner"])("short notices also work in role=%s", async role => {
  const error = await cooldownError(fixture(`<section role="${role}"><div class="description">${savedNotice}</div></section>`).page);
  expect(error.message).toBe(savedNotice);
});

test.each([
  "You've reached your hourly limit. Try again in 5 minutes.",
  "You have reached the limit for messages in an hour. Please try again later.",
  "You've hit your hourly message limit. Try again later.",
  "Too many requests in 1 hour. Try again later.",
])("hourly notices carry a duration or the 20-minute fallback: %s", async message => {
  const before = Date.now();
  const error = await cooldownError(fixture(`<aside role="status"><div class="description">${message}</div></aside>`).page);
  const after = Date.now(), delay = message.includes("5 minutes") ? 300 : 1_200;
  expect(error.message).toBe(message);
  expect(error.retryAfterSeconds).toBe(delay);
  expect(error.retryAt!).toBeGreaterThanOrEqual(before + delay * 1_000);
  expect(error.retryAt!).toBeLessThanOrEqual(after + delay * 1_000);
});

test("split inline notice text preserves its clock and ignores hidden unrelated children", async () => {
  const f = fixture(`<aside role="status"><div class="description"><span>We're doing a quick check </span><strong>to keep ChatGPT reliable.</strong><span> Try again after 8:27 PM.</span></div><span hidden>Capacity</span></aside>`);
  expect((await cooldownError(f.page)).message).toBe(savedNotice);
});

test("an inline clock uses the full description instead of a partial notice or close label", async () => {
  const f = fixture('<aside role="status"><div class="description"><span>We\'re doing a quick check to keep ChatGPT reliable. Try again after </span><strong>8:27 PM.</strong></div><button>Close</button></aside>');
  const error = await cooldownError(f.page);
  expect(error.message).toBe(savedNotice);
  expect(new Date(error.retryAt!).getHours()).toBe(20);
  expect(new Date(error.retryAt!).getMinutes()).toBe(27);
});

test("a notice at its exact reset time is ignored instead of emitting an expired cooldown", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(new Date(2026, 9, 10, 20, 27, 0, 0).getTime());
  try {
    await throwIfChatGptRateLimitNotice(fixture(`<aside role="status"><div class="description">${savedNotice}</div></aside>`).page);
  } finally { clock.mockRestore(); }
});

test("a notice remains expired throughout its displayed reset minute", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(new Date(2026, 9, 10, 20, 27, 30).getTime());
  try {
    await throwIfChatGptRateLimitNotice(fixture(`<aside role="status"><div class="description">${savedNotice}</div></aside>`).page);
  } finally { clock.mockRestore(); }
});

test.each(["hidden", 'aria-hidden="true"', 'style="display:none"', 'style="visibility:hidden"'])(
  "hidden inline children do not suppress the visible account notice: %s", async attribute => {
    const f = fixture(`<aside role="status"><div class="description">We're doing a quick check <span ${attribute}>unrelated</span>to keep ChatGPT reliable. Try again after 8:27 PM.</div></aside>`);
    expect((await cooldownError(f.page)).message).toBe(savedNotice);
  },
);

test("legacy visibility-only mocks are skipped only when evaluateAll is absent", async () => {
  const page = { locator: () => ({ isVisible: async () => true }) } as unknown as Page;
  await throwIfChatGptRateLimitNotice(page);
});

test("real observation failures propagate instead of looking like a cleared cooldown", async () => {
  const failure = new Error("Browser observation failed");
  const page = { locator: () => ({ evaluateAll: async () => { throw failure; } }) } as unknown as Page;
  await expect(throwIfChatGptRateLimitNotice(page)).rejects.toBe(failure);
});

test.each([
  '<form><div id="prompt-textarea" contenteditable="true"></div><span aria-live="polite">NOTICE</span></form>',
  '<form data-chatgpt-composer><div data-composer-markdown role="textbox" contenteditable="true"></div><span aria-live="assertive">NOTICE</span></form>',
  '<div data-testid="composer-status">NOTICE</div>',
])("composer status is scoped to the actual composer: %s", async html => {
  expect((await cooldownError(fixture(html.replace("NOTICE", savedNotice)).page)).message).toBe(savedNotice);
});

test.each([
  '<div class="description">NOTICE</div>',
  '<div class="banner">NOTICE</div>',
  '<form><input placeholder="Search"><span aria-live="polite">NOTICE</span></form>',
  '<div role="dialog"><div role="status">NOTICE</div></div>',
  '<form><div id="prompt-textarea" role="status" contenteditable="true">NOTICE</div></form>',
  '<div data-message-author-role="user"><aside role="status">NOTICE</aside></div>',
  '<div data-message-author-role="assistant"><aside role="alert">NOTICE</aside></div>',
  '<article data-testid="conversation-turn-0"><aside role="status">NOTICE</aside></article>',
  '<article data-turn-key="old"><aside role="banner">NOTICE</aside></article>',
  '<aside role="status"><div data-message-author-role="user">NOTICE</div></aside>',
  '<aside role="status"><div class="markdown">NOTICE</div></aside>',
  '<aside role="banner"><pre>NOTICE</pre></aside>',
  '<aside role="status"><blockquote>NOTICE</blockquote></aside>',
])("generic elements, dialogs and transcript notices do not trigger: %s", async html => {
  await throwIfChatGptRateLimitNotice(fixture(html.replace("NOTICE", savedNotice)).page);
});

test.each(["hidden", 'aria-hidden="true"', 'style="display:none"', 'style="visibility:hidden"', 'style="visibility:collapse"'])(
  "hidden notice roots, children and ancestors do not trigger: %s", async attribute => {
    for (const html of [
      `<aside role="status" ${attribute}><div class="description">${savedNotice}</div></aside>`,
      `<aside role="status"><div class="description" ${attribute}>${savedNotice}</div></aside>`,
      `<section ${attribute}><aside role="status"><div class="description">${savedNotice}</div></aside></section>`,
    ]) await throwIfChatGptRateLimitNotice(fixture(html).page);
  },
);

test("zero-size and detached notices are ignored", async () => {
  for (const detached of [false, true]) {
    const f = fixture(`<aside role="status"><div class="description">${savedNotice}</div></aside>`);
    for (const element of Array.from(f.document.querySelectorAll("*"))) {
      if (detached) Object.defineProperty(element, "isConnected", { value: false });
      else element.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
    }
    await throwIfChatGptRateLimitNotice(f.page);
  }
});

test.each([
  "ChatGPT is at capacity. Try again later.", "Security check. Try again after 8:27 PM.",
  "Complete a CAPTCHA to continue.", "Verify you are human. Try again later.",
  "We're doing a quick check to verify you are human. Try again later.",
  "We're doing a quick check to keep ChatGPT reliable. Complete a CAPTCHA to continue.",
  `The user quoted: ${savedNotice}`,
])("unrelated status/alert/banner UI is not a rate-limit notice: %s", async message => {
  for (const role of ["status", "alert", "banner"]) {
    await throwIfChatGptRateLimitNotice(fixture(`<aside role="${role}"><div class="description">${message}</div></aside>`).page);
  }
});

test("a large transcript is pruned before text reads while a real description remains detectable", async () => {
  const f = fixture(`<aside role="status"><article data-testid="conversation-turn-0"><div data-message-author-role="user"></div></article><div class="description">${savedNotice}</div></aside>`);
  const transcript = f.document.querySelector('[data-message-author-role="user"]')!;
  transcript.appendChild(f.document.createTextNode(savedNotice.repeat(20_000)));
  Object.defineProperty(transcript.firstChild!, "data", { get: () => { throw new Error("Transcript text was read"); } });
  Object.defineProperty(f.document.body, "textContent", { get: () => { throw new Error("Whole-page text was read"); } });
  expect((await cooldownError(f.page)).message).toBe(savedNotice);
});

test("oversized text and excessive nesting stop within the DOM read budget", async () => {
  for (const html of [
    `<aside role="status">${"x".repeat(1_025)}${savedNotice}</aside>`,
    `<aside role="status">${"<span>".repeat(70)}${savedNotice}${"</span>".repeat(70)}</aside>`,
    `<aside role="status">${"<span>x</span>".repeat(600)}<div>${savedNotice}</div></aside>`,
  ]) await throwIfChatGptRateLimitNotice(fixture(html).page);
});
