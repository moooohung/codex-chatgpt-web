const { createHash } = require("node:crypto");

const ACCOUNT_CONTEXT_URL = "https://chatgpt.com/api/auth/session";
const ACCOUNT_CONTEXT_TIMEOUT_MS = 5_000;
const PLAN_TYPES = new Set(["plus", "pro", "prolite", "free"]);

function proofError(code, message) {
  const error = new Error(`ChatGPT account plan proof failed: ${message}`);
  error.code = `account_context_${code}`;
  return error;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function validateAccountContext(value) {
  if (!isObject(value) || Object.keys(value).length !== 2
    || typeof value.accountKey !== "string" || !/^[a-f0-9]{64}$/.test(value.accountKey)
    || !PLAN_TYPES.has(value.planType)) {
    throw proofError("invalid_proof", "expected only an account hash and a supported plan");
  }
  return { accountKey: value.accountKey, planType: value.planType };
}

function accountContextFromSession(payload) {
  if (!isObject(payload) || !isObject(payload.user) || !isObject(payload.account)) {
    throw proofError("invalid_session", "session, user and account must be objects");
  }
  if ((payload.error !== undefined && payload.error !== null && payload.error !== "")
    || (payload.errors !== undefined && payload.errors !== null)) {
    throw proofError("session_error", "authenticated endpoint reported a session error");
  }
  if (typeof payload.expires !== "string" || !Number.isFinite(Date.parse(payload.expires))) {
    throw proofError("invalid_expiry", "session expiry is missing or invalid");
  }
  if (Date.parse(payload.expires) <= Date.now()) {
    throw proofError("expired", "authenticated session has expired");
  }
  const { user, account } = payload;
  if (!isIdentity(user.id) || !isIdentity(account.id)) {
    throw proofError("invalid_identity", "user or account identity is missing or invalid");
  }
  if (account.structure !== "personal") {
    throw proofError("unsupported_structure", "a personal account is required");
  }
  if (typeof account.isDelinquent !== "boolean") {
    throw proofError("invalid_delinquency", "account delinquency evidence is missing or invalid");
  }
  if (account.isDelinquent) {
    throw proofError("delinquent", "account reports a subscription payment problem");
  }
  if (account.planType === undefined || account.planType === null || account.planType === "") {
    throw proofError("missing_plan", "account plan is missing");
  }
  if (!PLAN_TYPES.has(account.planType)) {
    throw proofError("unsupported_plan", "account plan is not plus, pro, prolite or free");
  }
  return {
    accountKey: createHash("sha256").update(`${user.id}\0${account.id}`, "utf8").digest("hex"),
    planType: account.planType,
  };
}

async function readAccountContext(browserSession, { signal } = {}) {
  if (signal?.aborted) throw proofError("aborted", "account proof was aborted");
  if (!browserSession || typeof browserSession.fetch !== "function") {
    throw proofError("session_unavailable", "the leased tab's Electron session.fetch is unavailable");
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(proofError("aborted", "account proof was aborted"));
  const timer = setTimeout(() => controller.abort(
    proofError("timeout", `account proof exceeded ${ACCOUNT_CONTEXT_TIMEOUT_MS}ms`),
  ), ACCOUNT_CONTEXT_TIMEOUT_MS);
  let rejectAbort;
  const aborted = new Promise((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // Race the whole read, including JSON, even if a fetch implementation ignores abort.
    return await Promise.race([aborted, (async () => {
      let response;
      try {
        response = await browserSession.fetch(ACCOUNT_CONTEXT_URL, {
          method: "GET", credentials: "include", cache: "no-store", redirect: "error",
          headers: { accept: "application/json" }, signal: controller.signal,
        });
      } catch {
        throw proofError("fetch_failed", "authenticated endpoint could not be fetched");
      }
      controller.signal.throwIfAborted();
      if (!response || !Number.isInteger(response.status)
        || response.status < 200 || response.status >= 300 || response.ok !== true) {
        throw proofError("http_error", Number.isInteger(response?.status)
          ? `authenticated endpoint returned HTTP ${response.status}` : "invalid HTTP response");
      }
      // Electron 44.7.0 creates a native Response with an empty URL. The fixed HTTPS
      // endpoint and redirect:error enforce origin/path there; validate any supplied URL too.
      if (response.url !== "" && response.url !== undefined) {
        let url;
        try { url = new URL(response.url); } catch {}
        if (!url || url.href !== ACCOUNT_CONTEXT_URL) {
          throw proofError("invalid_endpoint", "response origin or path is not the authenticated endpoint");
        }
      }
      if (response.redirected === true) {
        throw proofError("invalid_endpoint", "authenticated endpoint redirected");
      }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers?.get?.("content-type") ?? "")
        || typeof response.json !== "function") {
        throw proofError("invalid_response", "authenticated endpoint did not return JSON");
      }
      let payload;
      try { payload = await response.json(); }
      catch { throw proofError("invalid_json", "authenticated endpoint returned malformed JSON"); }
      controller.signal.throwIfAborted();
      return accountContextFromSession(payload);
    })()]);
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    controller.signal.removeEventListener("abort", rejectAbort);
  }
}

function ownsLease(host, tab, owner) {
  return host.turnTabs.get(tab.id) === tab && tab.interactionMode === "automatic"
    && tab.status === "running" && tab.failedAt === undefined
    && tab.traceId === owner.traceId && tab.helperPid === owner.helperPid
    && tab.conversationKey === owner.conversationKey && tab.connectorIdentity === owner.connectorIdentity;
}

async function readLeasedAccountContext(host, tab, owner, signal) {
  const view = tab.view;
  const contents = view?.webContents;
  const browserSession = contents?.session;
  const { surfaceId, accountName, partition } = tab;
  const assertLease = () => {
    if (!ownsLease(host, tab, owner) || !contents || contents === host.view?.webContents
      || typeof contents.isDestroyed !== "function" || contents.isDestroyed()
      || tab.view !== view || view.webContents !== contents
      || contents.session !== browserSession || tab.surfaceId !== surfaceId
      || tab.accountName !== accountName || tab.partition !== partition
      || host.userCancelledTurnOwners?.has(owner.traceId)) {
      throw proofError("lease_lost", "the exact automatic tab no longer owns this lease");
    }
  };
  try {
    assertLease();
    const context = await (host.readAccountContext ?? readAccountContext)
      .call(host, browserSession, { signal });
    assertLease();
    if (signal?.aborted) throw proofError("aborted", "account proof was aborted");
    return validateAccountContext(context);
  } catch (error) {
    // Use normal tab release, but never close a replacement tab or a transferred owner.
    try {
      if (ownsLease(host, tab, owner) && contents && tab.view === view && view?.webContents === contents
        && contents !== host.view?.webContents) host.removeTurnTab(tab, true);
    } catch {
      // Cleanup must not replace a precise proof error with an unrelated release error.
      if (error instanceof Error) error.tabReleaseFailed = true;
    }
    throw error;
  }
}

module.exports = { ACCOUNT_CONTEXT_TIMEOUT_MS, readAccountContext, readLeasedAccountContext };
