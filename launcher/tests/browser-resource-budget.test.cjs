const test = require("node:test");
const assert = require("node:assert/strict");
const { resourceBudgetReason, bindBrowserResourceBudget, takeResourceBudgetCounts, takeContentsResourceBudgetCounts } = require("../electron/browser-resource-budget.cjs");
const owner = { status: "running", interactionMode: "automatic", documentUrl: "https://chatgpt.com/c/fixture" };
const request = (url, resourceType = "xhr", method = "GET") => ({ url, method, resourceType, webContentsId: 7 });

test("optional resources are denied by exact type/path/host, never by substring", () => {
  for (const [url, type, reason] of [
    ["https://cdn.oaistatic.com/assets/font.woff2", "font", "webfont"],
    ["https://cdn.oaistatic.com/assets/logo.png", "image", "decorative_image"],
    ["https://browser-intake-datadoghq.com/api/v2/rum", "script", "analytics"],
    ["https://chatgpt.com/backend-api/conversations?offset=0&limit=28", "xhr", "sidebar_list"],
  ]) assert.equal(resourceBudgetReason(request(url, type), owner), reason);
  assert.equal(resourceBudgetReason(request("https://browser-intake-datadoghq.com/api/v2/rum", "xhr", "POST"), owner), "analytics");
});

test("auth, challenge, app chunks, model/effort, multipart, uploads and response/tool transports pass", () => {
  for (const [url, type, method] of [
    ["https://auth.openai.com/login", "image", "GET"],
    ["https://challenges.cloudflare.com/turnstile/v0/api.js", "script", "GET"],
    ["https://cdn.oaistatic.com/cdn-cgi/challenge/image.png", "image", "GET"],
    ["https://cdn.oaistatic.com/assets/app.js", "script", "GET"],
    ["https://cdn.oaistatic.com/assets/app.css", "stylesheet", "GET"],
    ["https://chatgpt.com/backend-api/models", "xhr", "GET"],
    ["https://chatgpt.com/backend-api/settings/effort", "xhr", "GET"],
    ["https://chatgpt.com/backend-api/conversation", "xhr", "POST"],
    ["https://chatgpt.com/backend-api/conversations", "xhr", "POST"],
    ["https://chatgpt.com/backend-api/conversation/fixture", "xhr", "GET"],
    ["https://chatgpt.com/backend-api/conversations/fixture/stream", "xhr", "GET"],
    ["https://chatgpt.com/backend-api/files", "xhr", "POST"],
    ["https://files.oaiusercontent.com/fixture.png", "image", "GET"],
    ["https://chatgpt.com/backend-api/connectors/fixture", "xhr", "GET"],
    ["wss://chatgpt.com/stream", "webSocket", "GET"],
    ["https://cdn.oaistatic.com.example.org/logo.png", "image", "GET"],
  ]) assert.equal(resourceBudgetReason(request(url, type, method), owner), null, url);
});

test("manual/idle/sign-in/non-chat documents and security frames are outside the budget", () => {
  const image = request("https://cdn.oaistatic.com/logo.png", "image");
  for (const scoped of [null, { ...owner, status: "ready" }, { ...owner, interactionMode: "manual" },
    { ...owner, isSignInTab: true }, { ...owner, authenticationRequired: true },
    { ...owner, documentUrl: "https://chatgpt.com/auth/login" }, { ...owner, documentUrl: "about:blank" },
    { ...owner, documentUrl: "https://example.org/c/fixture" }]) assert.equal(resourceBudgetReason(image, scoped), null);
  for (const url of ["https://auth.openai.com/login", "https://challenges.cloudflare.com/fixture", "about:blank"])
    assert.equal(resourceBudgetReason({ ...image, frame: { url } }, owner), null);
  assert.equal(resourceBudgetReason({ ...image, resourceType: "mainFrame" }, owner), null);
});

test("one native listener rechecks live ownership, has an opt out, and returns only counters", () => {
  let listener, bound = 0, current = owner;
  const session = { webRequest: { onBeforeRequest: (_filter, callback) => { listener = callback; bound++; } } };
  bindBrowserResourceBudget(session, id => id === 7 ? current : null, {});
  bindBrowserResourceBudget(session, () => { throw Error("must not replace the listener"); }, {});
  const image = request("https://cdn.oaistatic.com/logo.png", "image"), verdicts = [];
  listener(image, result => verdicts.push(result.cancel));
  current = { ...owner, status: "ready" }; listener(image, result => verdicts.push(result.cancel));
  listener({ ...image, webContentsId: 8 }, result => verdicts.push(result.cancel));
  assert.equal(bound, 1); assert.deepEqual(verdicts, [true, false, false]);
  assert.deepEqual(takeResourceBudgetCounts(session, 7), { decorative_image: 1 });
  assert.deepEqual(takeResourceBudgetCounts(session, 7), {});
  bindBrowserResourceBudget({ webRequest: { onBeforeRequest: () => { throw Error("disabled"); } } }, () => owner,
    { CODEX_WEB_GPT_REDUCE_TURN_RESOURCES: "0" });
});

test("resource accounting cannot stop terminal release when Electron has already destroyed the contents", () => {
  const destroyed = { isDestroyed: () => true, get session() { throw Error("Object has been destroyed"); } };
  assert.deepEqual(takeContentsResourceBudgetCounts(destroyed), {});
  assert.deepEqual(takeContentsResourceBudgetCounts({ isDestroyed: () => false, get session() { throw Error("Object has been destroyed"); } }), {});
});
