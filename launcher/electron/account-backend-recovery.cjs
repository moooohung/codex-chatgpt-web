const ORIGIN = "https://chatgpt.com";

const isTestEnv = Boolean(
  typeof process !== "undefined" && (
    process.env.npm_lifecycle_event === "test"
    || process.env.NODE_ENV === "test"
    || (process.execArgv && process.execArgv.includes("--test"))
  ),
);

const DEFAULT_CHALLENGE_GRACE_PERIOD_MS = isTestEnv ? 0 : 45_000;

function headerIncludes(headers, name, value) {
  return Object.entries(headers || {}).some(([key, values]) => key.toLowerCase() === name
    && (Array.isArray(values) ? values : [values]).some(item => String(item).toLowerCase().split(/[;,]/).some(part => part.trim() === value)));
}

function handleAccountBackendResponse(host, details) {
  let url;
  try { url = new URL(details.url); } catch { return false; }
  if (url.origin !== ORIGIN) return false;
  const tab = [...host.turnTabs.values()].find(candidate => candidate.accountName
    && !candidate.view.webContents.isDestroyed() && candidate.view.webContents.id === details.webContentsId);
  if (!tab) return false;
  const challenge = details.statusCode === 403 && headerIncludes(details.responseHeaders, "cf-mitigated", "challenge");
  const authenticatedResponse = url.pathname === "/api/auth/session" && details.statusCode === 200
    && headerIncludes(details.responseHeaders, "content-type", "application/json");
  if (!challenge && !authenticatedResponse) return false;
  const status = host.accountStatuses.get(tab.accountName) || {};
  host.accountStatuses.set(tab.accountName, { ...status, securityCheckRequired: challenge });
  tab.securityCheckRequired = challenge;
  if (!challenge) {
    if (tab.isSignInTab && tab.status === "error") tab.status = "ready";
    if (tab.isSignInTab) tab.message = `Sign in to ChatGPT for [${tab.accountName}]`;
    host.publishState?.(host.snapshot());
    return true;
  }
  const busy = [...host.turnTabs.values()].some(candidate => candidate.accountName === tab.accountName && candidate.status === "running");
  if (tab.isSignInTab && !busy) tab.status = "error";
  tab.message = "ChatGPT security check is blocking this account. Complete the check in this tab, then resume the task.";
  host.logger.warn("browser.account_security_check", { account: tab.accountName, tabId: tab.id });
  host.publishState?.(host.snapshot());
  // Only an idle sign-in surface may refresh. A submitted task, retained conversation,
  // or another running tab on this account must never be navigated or resubmitted.
  if (!tab.isSignInTab || busy || tab.challengeReloadAttempted) return true;
  tab.challengeReloadAttempted = true;
  tab.challengeRecovery = (async () => {
    // The primary surface's 500 ms reload delay is a different lifecycle. It must
    // not truncate this account page's browser-verification grace period.
    const graceMs = host.accountChallengeRecoveryDelayMs ?? DEFAULT_CHALLENGE_GRACE_PERIOD_MS;
    if (graceMs > 0) {
      const start = Date.now();
      while (Date.now() - start < graceMs) {
        await new Promise(resolve => setTimeout(resolve, Math.min(1000, graceMs - (Date.now() - start))));
        if (!tab.securityCheckRequired) return;
        if (host.turnTabs.get(tab.id) !== tab) return;
        const currentBusy = [...host.turnTabs.values()].some(candidate => candidate.accountName === tab.accountName && candidate.status === "running");
        if (currentBusy) return;
      }
    } else {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const contents = tab.view.webContents;
    if (host.turnTabs.get(tab.id) !== tab || contents.isDestroyed()) return;
    if ([...host.turnTabs.values()].some(candidate => candidate.accountName === tab.accountName && candidate.status === "running")) return;
    const current = new URL(contents.getURL());
    if (current.origin !== ORIGIN || current.pathname !== "/") return;
    tab.loading = true;
    await host.loadAccountSignInSurface(contents, current.toString());
    tab.loading = false;
    if (tab.securityCheckRequired) tab.status = "error";
  })().catch(() => {
    if (host.turnTabs.get(tab.id) === tab && !tab.view.webContents.isDestroyed()) {
      tab.loading = false;
      tab.status = "error";
      host.logger.warn("browser.account_security_refresh_failed", { account: tab.accountName, tabId: tab.id });
    }
  }).finally(() => host.publishState?.(host.snapshot()));
  return true;
}

function bindAccountBackendRecovery(host, browserSession) {
  if (!browserSession?.webRequest?.onCompleted) return;
  host.accountBackendSessions ??= new WeakSet();
  if (host.accountBackendSessions.has(browserSession)) return;
  host.accountBackendSessions.add(browserSession);
  browserSession.webRequest.onCompleted({ urls: [`${ORIGIN}/*`] }, details => handleAccountBackendResponse(host, details));
}

module.exports = { bindAccountBackendRecovery, handleAccountBackendResponse };
