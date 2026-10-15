const { randomBytes } = require("node:crypto");
const { accountNameForTab, readAccountConfig, validateAccountName } = require("./account-policy.cjs");
const { readChatGptAuthSession } = require("./chatgpt-auth-session.cjs");
const { validatePasskeyLoginState } = require("./passkey-login-state.cjs");

const ORIGIN = "https://chatgpt.com";
const CHAT_URL = `${ORIGIN}/?temporary-chat=true`;

function accountIdentity(account) {
  return JSON.stringify([String(account.email || "").trim().toLowerCase(), account.tunnelId || "", account.keyFile || ""]);
}

function assertTarget(host, operation) {
  const { accountName } = operation;
  if (host.destroyed || host.accountPasskeyLogin !== operation
    || !host.accountPool?.includes(accountName) || host.pendingRemovalAccounts?.has(accountName)) {
    throw new Error("The account selected for Chrome sign-in is no longer available");
  }
  const account = readAccountConfig(host.accountPaths.config).accounts[accountName];
  if (!account || account.pendingRemoval || accountIdentity(account) !== operation.identity) {
    throw new Error("The account selected for Chrome sign-in changed; start sign-in again");
  }
  if ([...host.turnTabs.values()].some(tab => accountNameForTab(tab) === accountName && tab.status === "running")) {
    throw new Error("Finish the selected account's active turns before signing in with Chrome");
  }
  return account;
}

async function readIdentity(browserSession) {
  let email = "";
  const result = await readChatGptAuthSession(async (...args) => {
    const response = await browserSession.fetch(...args);
    return { ok: response.ok, status: response.status, headers: response.headers, json: async () => {
      const payload = await response.json();
      email = typeof payload?.user?.email === "string" ? payload.user.email.trim().toLowerCase() : "";
      return payload;
    } };
  }, ORIGIN, 5_000);
  if (!result.sessionAuthenticated || !email) {
    throw new Error(result.sessionCheckError || "Chrome sign-in did not return a verified ChatGPT account");
  }
  return email;
}

async function applyCookies(browserSession, state) {
  for (const cookie of state.cookies) await browserSession.cookies.set(cookie);
  browserSession.flushStorageData();
  await browserSession.cookies.flushStore();
}

async function clearTarget(host, operation, browserSession, idleUrl) {
  assertTarget(host, operation);
  const tabs = [...host.turnTabs.values()].filter(tab => accountNameForTab(tab) === operation.accountName);
  for (const tab of tabs) {
    const contents = tab.view?.webContents;
    if (!contents || contents.isDestroyed()) continue;
    if (contents.session !== browserSession) throw new Error("Account sign-in partition ownership changed");
    await contents.loadURL(idleUrl);
  }
  assertTarget(host, operation);
  await browserSession.clearStorageData();
  browserSession.flushStorageData();
  await browserSession.cookies.flushStore();
  for (const tab of tabs) if (tab !== operation.tab) host.removeTurnTab(tab, false);
}

async function importAccount(host, operation, sessionApi, options) {
  let transfer;
  let preflight;
  let targetSession;
  let mutated = false;
  let failure;
  try {
    await host.ready();
    assertTarget(host, operation);
    operation.tab = host.openAccountLoginTab(operation.accountName);
    targetSession = sessionApi.fromPartition(host.accountPaths.partition(operation.accountName));
    const contents = operation.tab.view?.webContents;
    if (!contents || contents.isDestroyed() || contents.session !== targetSession
      || targetSession === host.view?.webContents?.session) {
      throw new Error("Account sign-in does not own an isolated browser partition");
    }
    host.setState({ passkeyAccount: operation.accountName, passkeyPhase: "opening" });
    transfer = await host.loginWithPasskey(phase => {
      if (host.accountPasskeyLogin === operation && !host.destroyed) host.setState({ passkeyPhase: phase });
    });
    if (!transfer || typeof transfer.cleanup !== "function") throw new Error("Chrome sign-in returned an invalid transfer handle");
    const state = validatePasskeyLoginState(transfer.storageState);
    assertTarget(host, operation);
    host.setState({ passkeyPhase: "importing" });
    // Verify the signed-in identity in memory before touching the selected account.
    preflight = sessionApi.fromPartition(`codex-web-gpt-login-check-${randomBytes(16).toString("hex")}`);
    if (preflight === targetSession || preflight === host.view?.webContents?.session) {
      throw new Error("Chrome sign-in verification partition is not isolated");
    }
    await applyCookies(preflight, state);
    const email = await readIdentity(preflight);
    const account = assertTarget(host, operation);
    if (String(account.email || "").trim() && email !== String(account.email).trim().toLowerCase()) {
      throw new Error("The Chrome account does not match the selected account. Sign in with the selected account's email");
    }
    if (contents.isDestroyed() || host.turnTabs.get(operation.tab.id) !== operation.tab) {
      throw new Error("The selected account's sign-in tab was closed");
    }
    mutated = true;
    await clearTarget(host, operation, targetSession, options.idleUrl);
    await applyCookies(targetSession, state);
    await contents.loadURL(CHAT_URL);
    if (state.localStorage.length) {
      const entries = JSON.stringify(state.localStorage).replace(/</g, "\\u003c");
      await contents.executeJavaScript(`(() => {
        if (location.origin !== ${JSON.stringify(ORIGIN)}) throw new Error("Unexpected account sign-in origin");
        for (const entry of ${entries}) localStorage.setItem(entry.name, entry.value);
      })()`, true);
      await contents.loadURL(CHAT_URL);
    }
    assertTarget(host, operation);
    if (await readIdentity(targetSession) !== email) throw new Error("The imported ChatGPT account identity could not be verified");
    const deadline = Date.now() + (options.readyTimeoutMs ?? 60_000);
    let ready = false;
    while (Date.now() < deadline) {
      assertTarget(host, operation);
      if (contents.isDestroyed()) throw new Error("The selected account's sign-in tab was closed");
      ready = await contents.executeJavaScript(`(() => {
        const url = new URL(location.href);
        const composer = document.querySelector(${JSON.stringify(options.composerSelector)});
        return url.origin === ${JSON.stringify(ORIGIN)} && url.pathname === "/"
          && url.searchParams.get("temporary-chat") === "true"
          && Boolean(composer && composer.getClientRects().length);
      })()`, true);
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error("The selected account's ChatGPT composer did not become ready");
  } catch (error) {
    failure = error;
  }
  // Temporary capture cleanup remains a completion gate, as in upstream login.
  try { await transfer?.cleanup?.(); } catch {
    failure ||= new Error("Removing temporary Chrome sign-in state failed");
  }
  try {
    if (preflight && preflight !== targetSession && preflight !== host.view?.webContents?.session) {
      await preflight.clearStorageData();
      await preflight.cookies.flushStore();
    }
  } catch { failure ||= new Error("Removing temporary Chrome verification state failed"); }
  if (!failure) {
    try {
      assertTarget(host, operation);
      const contents = operation.tab?.view?.webContents;
      if (!contents || contents.isDestroyed() || host.turnTabs.get(operation.tab.id) !== operation.tab
        || contents.session !== targetSession) throw new Error("The selected account's sign-in tab was closed or changed");
    } catch (error) { failure = error; }
  }
  if (failure) {
    if (mutated) {
      try { await clearTarget(host, operation, targetSession, options.idleUrl); }
      catch { failure = new Error(`${failure.message}; the selected account's partial session could not be cleared`); }
      const previous = host.accountStatuses.get(operation.accountName);
      host.accountStatuses.set(operation.accountName, { ...previous, authenticated: false, routingAuthenticated: false,
        routingAuthCheckedAt: 0, routingAuthRevision: (previous?.routingAuthRevision || 0) + 1 });
    }
    if (operation.tab && host.turnTabs.get(operation.tab.id) === operation.tab) {
      operation.tab.status = "error";
      operation.tab.loading = false;
      operation.tab.message = failure.message;
    }
    throw failure;
  }
  const previous = host.accountStatuses.get(operation.accountName);
  host.accountStatuses.set(operation.accountName, { ...previous, authenticated: true, routingAuthenticated: true,
    routingAuthCheckedAt: Date.now(), routingAuthRevision: (previous?.routingAuthRevision || 0) + 1, cooldownUntil: 0 });
  Object.assign(operation.tab, { status: "ready", loading: false, authenticationRequired: false,
    url: CHAT_URL, message: `Account [${operation.accountName}] signed in. ChatGPT is ready.` });
  // The primary account and every other account keep their own storage and state.
  host.authenticationRevision = (host.authenticationRevision ?? 0) + 1;
  if (!host.disabledAccounts?.has(operation.accountName) && !previous?.securityCheckRequired) {
    host.reauthenticationRequired = false;
    host.setState({ authenticated: true });
  }
  host.selectTab(operation.tab.id);
  host.show();
  host.logger.info("browser.account_chrome_login_imported", { account: operation.accountName });
  return host.snapshot();
}

function startAccountPasskeyLogin(host, name, sessionApi, options) {
  host.requireAutomaticBrowserInspection("Automated ChatGPT account session import");
  const accountName = validateAccountName(name);
  if (host.accountPasskeyLogin) {
    if (host.accountPasskeyLogin.accountName === accountName) return host.accountPasskeyLogin.promise;
    throw new Error("Finish the current account's Chrome sign-in first");
  }
  if (host.loginOperation || host.manualOperation) throw new Error("Finish the current browser operation before signing in with Chrome");
  if (host.isAccountBusy(accountName)) throw new Error("Finish the selected account's active turns before signing in with Chrome");
  const account = readAccountConfig(host.accountPaths.config).accounts[accountName];
  if (!account || account.pendingRemoval || !host.accountPool?.includes(accountName)
    || host.pendingRemovalAccounts?.has(accountName)) throw new Error("Account is unavailable for Chrome sign-in");
  const operation = { accountName, identity: accountIdentity(account), tab: null, promise: null };
  host.accountPasskeyLogin = operation;
  host.accountLoginReservations ??= new Set();
  host.accountLoginReservations.add(accountName);
  operation.promise = Promise.resolve().then(() => importAccount(host, operation, sessionApi, options)).finally(() => {
    if (host.accountPasskeyLogin !== operation) return;
    host.accountPasskeyLogin = null;
    host.accountLoginReservations.delete(accountName);
    if (!host.destroyed) {
      host.setState({ passkeyPhase: null, passkeyAccount: null });
      host.writeDescriptor?.();
    }
  }).then(() => host.snapshot());
  return operation.promise;
}

module.exports = { startAccountPasskeyLogin };
