const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const {
  sanitizeUserAgent,
  applyStealthHeaders,
  STEALTH_DOM_SCRIPT,
  injectDomStealth,
} = require("../electron/stealth.cjs");

test("sanitizeUserAgent strips Electron and Codex brand tokens while keeping Chrome tokens", () => {
  const electronUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Codex Web GPT/6.1.4 Chrome/134.0.6998.35 Electron/41.10.7 Safari/537.36";
  const cleanUa = sanitizeUserAgent(electronUa);
  assert.equal(cleanUa, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.35 Safari/537.36");
  assert.equal(sanitizeUserAgent(""), "");
  assert.equal(sanitizeUserAgent(null), null);
  assert.equal(sanitizeUserAgent(undefined), undefined);
});

test("applyStealthHeaders intercepts ChatGPT domains and injects Chrome Client Hints", () => {
  let registeredFilter = null;
  let registeredListener = null;

  const session = {
    webRequest: {
      onBeforeSendHeaders: (filter, listener) => {
        registeredFilter = filter;
        registeredListener = listener;
      },
    },
  };

  applyStealthHeaders(session);
  assert.ok(registeredFilter);
  assert.ok(Array.isArray(registeredFilter.urls));
  assert.ok(registeredFilter.urls.includes("https://*.chatgpt.com/*"));

  // Check header transformation
  let resultingHeaders = null;
  registeredListener(
    {
      requestHeaders: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Codex Web GPT/6.1.4 Electron/41.10.7",
      },
    },
    (result) => {
      resultingHeaders = result.requestHeaders;
    },
  );

  assert.ok(resultingHeaders);
  assert.equal(resultingHeaders["User-Agent"], "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  assert.ok(resultingHeaders["Sec-CH-UA"]);
  assert.match(resultingHeaders["Sec-CH-UA"], /Google Chrome/);
  assert.equal(resultingHeaders["Sec-CH-UA-Mobile"], "?0");
  assert.equal(resultingHeaders["Sec-CH-UA-Platform"], '"Windows"');

  // Idempotency: second call does not re-register
  let secondCallRegistered = false;
  session.webRequest.onBeforeSendHeaders = () => { secondCallRegistered = true; };
  applyStealthHeaders(session);
  assert.equal(secondCallRegistered, false);
});

test("STEALTH_DOM_SCRIPT executes cleanly in context and overrides navigator.webdriver and window.chrome", () => {
  const context = {
    navigator: { webdriver: true, plugins: [] },
    window: {},
    Notification: { permission: "default" },
    Date,
    performance: { now: () => 100 },
  };
  vm.createContext(context);
  vm.runInContext(STEALTH_DOM_SCRIPT, context);

  assert.equal(context.navigator.webdriver, false);
  assert.ok(context.window.chrome);
  assert.ok(context.window.chrome.runtime);
  assert.equal(typeof context.window.chrome.loadTimes, "function");
});

test("injectDomStealth safely invokes executeJavaScript without crashing on errors or nulls", () => {
  let executed = null;
  const webContents = {
    isDestroyed: () => false,
    executeJavaScript: (code) => { executed = code; return Promise.resolve(); },
  };

  injectDomStealth(webContents);
  assert.equal(executed, STEALTH_DOM_SCRIPT);

  // Destroyed webContents does not execute
  let destroyedExecuted = false;
  injectDomStealth({ isDestroyed: () => true, executeJavaScript: () => { destroyedExecuted = true; } });
  assert.equal(destroyedExecuted, false);

  // Missing webContents does not crash
  assert.doesNotThrow(() => injectDomStealth(null));
  assert.doesNotThrow(() => injectDomStealth({}));
});
