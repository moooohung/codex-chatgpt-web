import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import {
  CHATGPT_UNUSUAL_ACTIVITY_MESSAGE_PREFIX,
  DEFAULT_CHATGPT_UNUSUAL_ACTIVITY_COOLDOWN_MINUTES,
  chatGptPageRequestRejectionUiState,
  resolveChatGptUnusualActivityCooldownMinutes,
  throwIfChatGptPageRequestRejected,
  unusualActivityProviderWaitMs,
} from "../src/adapters/chatgpt-web/page-rejection";

const UNUSUAL_ACTIVITY = "Our systems have detected unusual activity coming from your system. Please try again later.";

function pageWithRejection(
  rejection: { kind: "unusual_activity" | "request_rejected"; text: string } | undefined,
  options: { localHistoryUnavailable?: boolean } = {},
): Page {
  const textLocator = {
    filter() { return this; },
    last() { return this; },
    isVisible: async () => options.localHistoryUnavailable === true,
  };
  return {
    url: () => options.localHistoryUnavailable ? "https://chatgpt.com/c/local-chatgpt:packet157" : "https://chatgpt.com/",
    locator: () => ({ evaluateAll: async () => rejection }),
    getByText: () => textLocator,
  } as unknown as Page;
}

test("unusual activity is a non-retryable 429 with a 3 minute local retry check", async () => {
  const before = Date.now();
  await expect(throwIfChatGptPageRequestRejected(
    pageWithRejection({ kind: "unusual_activity", text: UNUSUAL_ACTIVITY }, { localHistoryUnavailable: true }),
    "trace-packet157",
  )).rejects.toMatchObject({
    status: 429,
    errorType: "rate_limit_error",
    code: "chatgpt_unusual_activity",
    retryable: false,
    retryAfterSeconds: 3 * 60,
    localCooldown: true,
  });
  try {
    await throwIfChatGptPageRequestRejected(
      pageWithRejection({ kind: "unusual_activity", text: UNUSUAL_ACTIVITY }),
      "trace-packet157",
    );
    throw new Error("expected unusual activity rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(UNUSUAL_ACTIVITY);
    expect((error as Error).message).toContain("Local retry check after 3 minutes");
    expect((error as Error).message).toStartWith(CHATGPT_UNUSUAL_ACTIVITY_MESSAGE_PREFIX);
    expect((error as { retryAt?: number }).retryAt).toBeGreaterThanOrEqual(before + 3 * 60_000);
  }
});

test("other rejected-request toasts fail fast without starting an account cooldown", async () => {
  await expect(throwIfChatGptPageRequestRejected(pageWithRejection({
    kind: "request_rejected",
    text: "Something went wrong. Please try again.",
  }))).rejects.toMatchObject({
    status: 502,
    code: "chatgpt_submission_failed",
    retryable: false,
  });
});

test("an unrelated page alert does not trigger the rejection path", async () => {
  await expect(throwIfChatGptPageRequestRejected(pageWithRejection(undefined))).resolves.toBeUndefined();
  await expect(throwIfChatGptPageRequestRejected(
    pageWithRejection(undefined, { localHistoryUnavailable: true }),
  )).resolves.toBeUndefined();
});

test("page-level classification excludes transcript, hidden and unrelated alerts", () => {
  const { createWindow } = require("@mixmark-io/domino");
  const window = createWindow(`<body>
    <div data-turn-key="old"><div class="markdown"><aside id="quoted" role="alert">${UNUSUAL_ACTIVITY}<button>Retry</button></aside></div></div>
    <div data-testid="conversation-turn-1"><aside role="alert">${UNUSUAL_ACTIVITY}<button>Retry</button></aside></div>
    <div data-turn-key="user"><div data-user-message-bubble><aside role="alert">${UNUSUAL_ACTIVITY}<button>Retry</button></aside></div></div>
    <aside id="hidden" role="alert" hidden>${UNUSUAL_ACTIVITY}<button>Retry</button></aside>
    <aside id="unrelated" role="alert">Projects could not be loaded<button>Retry</button></aside>
    <div data-turn-key="current"><aside id="rejected" role="alert">Something went wrong. Please try again.<button>Retry</button></aside></div>
  </body>`);
  const originalConnected = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "isConnected");
  const originalBounds = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "getBoundingClientRect");
  const originalComputedStyle = Object.getOwnPropertyDescriptor(window, "getComputedStyle");
  Object.defineProperty(window.HTMLElement.prototype, "isConnected", { configurable: true, get() { return true; } });
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", { configurable: true,
    value() { return { width: this.closest("[hidden]") ? 0 : 100, height: this.closest("[hidden]") ? 0 : 20 }; } });
  Object.defineProperty(window, "getComputedStyle", {
    configurable: true,
    value: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  });
  try {
    const alerts = Array.from(window.document.querySelectorAll('[role="alert"]')) as unknown as Element[];
    expect(chatGptPageRequestRejectionUiState(alerts)).toEqual({
      kind: "request_rejected",
      text: "Something went wrong. Please try again.Retry",
    });
    window.document.querySelector("#rejected")?.remove();
    expect(chatGptPageRequestRejectionUiState(
      Array.from(window.document.querySelectorAll('[role="alert"]')) as unknown as Element[],
    )).toBeUndefined();
    const unusual = window.document.createElement("aside");
    unusual.setAttribute("role", "alert");
    unusual.textContent = UNUSUAL_ACTIVITY;
    window.document.querySelector('[data-turn-key="current"]').appendChild(unusual);
    expect(chatGptPageRequestRejectionUiState(
      Array.from(window.document.querySelectorAll('[role="alert"]')) as unknown as Element[],
    )).toEqual({ kind: "unusual_activity", text: UNUSUAL_ACTIVITY });
  } finally {
    for (const [target, name, original] of [
      [window.HTMLElement.prototype, "isConnected", originalConnected],
      [window.HTMLElement.prototype, "getBoundingClientRect", originalBounds],
      [window, "getComputedStyle", originalComputedStyle],
    ] as const) {
      if (original) Object.defineProperty(target, name, original);
      else delete target[name];
    }
  }
});

test("unusual activity cooldown configuration is bounded and defaults to 3 minutes", () => {
  expect(DEFAULT_CHATGPT_UNUSUAL_ACTIVITY_COOLDOWN_MINUTES).toBe(3);
  expect(resolveChatGptUnusualActivityCooldownMinutes({})).toBe(3);
  expect(resolveChatGptUnusualActivityCooldownMinutes({ CODEX_WEB_GPT_UNUSUAL_ACTIVITY_COOLDOWN_MINUTES: "45" })).toBe(45);
  for (const value of ["0", "1441", "1.5", "nope"]) {
    expect(() => resolveChatGptUnusualActivityCooldownMinutes({
      CODEX_WEB_GPT_UNUSUAL_ACTIVITY_COOLDOWN_MINUTES: value,
    })).toThrow("must be an integer from 1 to 1440");
  }
});

test("provider-specified waits are floors and remain distinct from a local estimate", async () => {
  expect(unusualActivityProviderWaitMs("Please try again in 30 minutes.")).toBe(30 * 60_000);
  expect(unusualActivityProviderWaitMs("Please wait for 2 hours.")).toBe(120 * 60_000);
  expect(unusualActivityProviderWaitMs("Please retry after 48 hours.")).toBe(48 * 60 * 60_000);
  expect(unusualActivityProviderWaitMs("Please wait for 2 days.")).toBe(48 * 60 * 60_000);
  expect(() => unusualActivityProviderWaitMs("Please wait for 999999999999999999 days.")).toThrow("unsupported retry time");
  expect(unusualActivityProviderWaitMs("10분 후 다시 시도하세요.")).toBe(10 * 60_000);
  expect(unusualActivityProviderWaitMs("Please try again later.")).toBeUndefined();
  await expect(throwIfChatGptPageRequestRejected(pageWithRejection({
    kind: "unusual_activity", text: UNUSUAL_ACTIVITY + " Please retry after 30 minutes.",
  }))).rejects.toMatchObject({ retryAfterSeconds: 30 * 60, localCooldown: false, retryable: false });
});
