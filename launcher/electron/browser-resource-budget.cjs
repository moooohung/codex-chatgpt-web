// Only automatic leased turn documents participate. Login, idle/manual views and
// unknown requests pass through. Keep Chromium's HTTP cache (no Playwright route).
const bindings = new WeakMap();
const ANALYTICS_HOSTS = new Set([
  "browser-intake-datadoghq.com", "browser-intake-us3-datadoghq.com",
  "browser-intake-us5-datadoghq.com", "cdn.segment.com", "api.segment.io",
  "www.google-analytics.com", "www.googletagmanager.com", "static.hotjar.com",
]);

function resourceBudgetReason(details, owner) {
  if (!owner || owner.status !== "running" || owner.interactionMode !== "automatic"
    || owner.authenticationRequired || owner.isSignInTab) return null;
  let url, documentUrl;
  try { url = new URL(details.url); documentUrl = new URL(owner.documentUrl); } catch { return null; }
  if (documentUrl.origin !== "https://chatgpt.com"
    || !/^\/(?:c\/[^/]+\/?|)$/.test(documentUrl.pathname)) return null;
  if (details.frame?.url) {
    let frameUrl;
    try { frameUrl = new URL(details.frame.url); } catch { return null; }
    if (frameUrl.origin !== documentUrl.origin || !/^\/(?:c\/[^/]+\/?|)$/.test(frameUrl.pathname)) return null;
  }
  // Security frames and streaming transports bypass optional blocking.
  if (["mainFrame", "subFrame", "webSocket"].includes(details.resourceType)) return null;
  if (url.protocol !== "https:" || /\/(?:auth|api\/auth|cdn-cgi|challenge|captcha|login|signin)(?:\/|$)/i.test(url.pathname)
    || /(?:^|\.)(?:auth\.openai\.com|challenges\.cloudflare\.com)$/.test(url.hostname)) return null;
  if (ANALYTICS_HOSTS.has(url.hostname)) return "analytics";
  if (details.method !== "GET") return null;
  if (url.origin === "https://chatgpt.com" && url.pathname === "/backend-api/conversations") return "sidebar_list";
  const staticHost = url.hostname === "cdn.oaistatic.com" || url.hostname === "persistent.oaistatic.com";
  if (staticHost && details.resourceType === "font") return "webfont";
  // Never block user uploads/generated images, auth avatars/challenges, CSS, app
  // chunks, current conversation fetches, model/plan/effort or connector requests.
  if (staticHost && details.resourceType === "image") return "decorative_image";
  return null;
}

function bindBrowserResourceBudget(browserSession, ownerForContents, env = process.env) {
  if (!browserSession?.webRequest?.onBeforeRequest || /^(0|false|off)$/i.test(env.CODEX_WEB_GPT_REDUCE_TURN_RESOURCES ?? "")) return;
  if (bindings.has(browserSession)) return;
  const counters = new Map();
  browserSession.webRequest.onBeforeRequest({ urls: ["https://*/*"] }, (details, callback) => {
    let reason = null;
    try { reason = resourceBudgetReason(details, ownerForContents(details.webContentsId)); } catch {}
    if (reason) {
      const counts = counters.get(details.webContentsId) ?? {};
      counts[reason] = (counts[reason] ?? 0) + 1;
      counters.set(details.webContentsId, counts);
    }
    callback({ cancel: reason !== null });
  });
  bindings.set(browserSession, counters);
}

function takeResourceBudgetCounts(browserSession, contentsId) {
  const counters = bindings.get(browserSession), counts = counters?.get(contentsId) ?? {};
  counters?.delete(contentsId);
  return counts;
}
function takeContentsResourceBudgetCounts(contents) {
  try {
    if (!contents || contents.isDestroyed?.()) return {};
    return takeResourceBudgetCounts(contents.session, contents.id);
  } catch { return {}; }
}
module.exports = { resourceBudgetReason, bindBrowserResourceBudget, takeResourceBudgetCounts, takeContentsResourceBudgetCounts };
