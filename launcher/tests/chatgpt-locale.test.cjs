const test = require("node:test");
const assert = require("node:assert/strict");
const { configureChatGptLocale } = require("../electron/chatgpt-locale.cjs");

test("ChatGPT locale sets English before navigation and persists only its language cookie", async () => {
  const calls = [];
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const browserSession = {
    getUserAgent: () => "existing-agent",
    setUserAgent: (...args) => calls.push(["userAgent", ...args]),
    cookies: {
      set: async cookie => { calls.push(["cookie", cookie]); await gate; },
      flushStore: async () => { calls.push(["flush"]); },
    },
  };
  const pending = configureChatGptLocale(browserSession);
  assert.deepEqual(calls[0], ["userAgent", "existing-agent", "en-US,en"]);
  assert.equal(calls[1][1].name, "oai-locale");
  assert.equal(calls[1][1].value, "en-US");
  assert.equal(calls[1][1].domain, ".chatgpt.com");
  assert.equal(calls[1][1].secure, true);
  assert.ok(calls[1][1].expirationDate > Date.now() / 1000 + 300 * 24 * 60 * 60);
  assert.equal(calls.length, 2);
  finish(); await pending;
  assert.deepEqual(calls[2], ["flush"]);
});

test("locale persistence failure remains observable", async () => {
  const browserSession = {
    getUserAgent: () => "agent", setUserAgent: () => {},
    cookies: { set: async () => { throw new Error("cookie write failed"); }, flushStore: async () => assert.fail("must not flush a failed write") },
  };
  await assert.rejects(configureChatGptLocale(browserSession), /cookie write failed/);
});
