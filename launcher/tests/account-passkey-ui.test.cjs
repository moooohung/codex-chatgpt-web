const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const root = path.resolve(__dirname, "..");
const transpile = (source, fileName) => ts.transpileModule(source, { fileName, compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
} }).outputText;
const translated = { exports: {} };
vm.runInNewContext(transpile(fs.readFileSync(path.join(root, "src/i18n.ts"), "utf8"), "i18n.ts"), translated);
const copy = translated.exports.copyFor("en");
const visit = tree => Array.isArray(tree) ? tree.flatMap(visit) : React.isValidElement(tree)
  ? [tree, ...visit(tree.props.children)] : [];
const textOf = tree => Array.isArray(tree) ? tree.map(textOf).join("") : React.isValidElement(tree)
  ? textOf(tree.props.children) : typeof tree === "string" || typeof tree === "number" ? String(tree) : "";
const flush = () => new Promise(resolve => setImmediate(resolve));
const accountItems = [
  { name: "alpha", authenticated: true, enabled: true, activeTabs: 1 },
  { name: "beta", authenticated: false, enabled: true, activeTabs: 0 },
];

// Run the actual TSX with controlled hook scheduling, as in renderer-wiring.test.cjs.
// No DOM, Electron, authentication or browser process is started.
function harness(kind, api, overrides = {}) {
  const hooks = [], effects = [];
  let cursor = 0;
  const useState = initial => {
    const index = cursor++;
    if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
    return [hooks[index], next => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next; }];
  };
  const useEffect = (effect, dependencies) => {
    const index = cursor++;
    const previous = hooks[index];
    if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
      effects.push(() => { previous?.cleanup?.(); hooks[index] = { dependencies, cleanup: effect() }; });
    }
  };
  const errors = [];
  const context = vm.createContext({ React, exports: {}, useState, useEffect, api, URL,
    messageOf: String, formatBrowserAddress: () => "chatgpt.com", isIdleBrowserSurface: () => false,
    browserTabTitleFromTitle: title => title || "ChatGPT",
    browserTabTone: () => "muted",
    window: { codexWebLauncher: api, confirm: () => true }, setInterval: () => 1, clearInterval() {},
    require(name) {
      if (name === "react") return { useState, useEffect };
      if (name === "./icons") return { Icon: () => null };
      if (name === "./accounts.css") return {};
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  for (const name of ["Icon", "BrandMark", "ManualTurnGuide", "StateDot"]) context[name] = () => null;
  for (const name of ["IconButton", "PrimaryButton", "SecondaryButton"]) context[name] = "button";
  let source = fs.readFileSync(path.join(root, kind === "accounts" ? "src/AccountsSurface.tsx" : "src/App.tsx"), "utf8");
  if (kind === "browser") source = source.slice(source.indexOf("function BrowserSurface("), source.indexOf("function ManualTurnGuide("));
  vm.runInContext(transpile(source, "surface.tsx") + `\nglobalThis.render = ${kind === "accounts" ? "exports.AccountsSurface" : "BrowserSurface"};`, context);
  const props = { browser: { authenticated: true, visible: true, tabs: [], status: "ready" }, copy,
    operation: null, platform: "win32", interactionMode: "automatic", browserSlotRef() {},
    snapshot: { platform: "win32", state: { browserInteractionMode: "automatic" }, urls: {} },
    setError: error => { if (error) errors.push(error); }, ...overrides };
  return { props, errors, render() {
    cursor = 0;
    const tree = context.render(props);
    while (effects.length) effects.shift()();
    return tree;
  } };
}
function chromeButton(tree, label = copy.passkeySignIn) {
  return visit(tree).find(node => node.type === "button" && textOf(node) === label);
}
function card(tree, name) {
  return visit(tree).find(node => String(node.props.className || "").split(" ").includes("account-card")
    && visit(node).some(child => child.props.className === "account-card-name" && textOf(child) === name));
}
async function accountsHarness(api = {}, overrides) {
  const h = harness("accounts", { listAccounts: async () => ({ accounts: accountItems }), ...api }, overrides);
  h.render();
  await flush();
  return h;
}

test("account cards render normal Chrome login even while another account is authenticated on all supported platforms", async () => {
  const h = await accountsHarness();
  for (const platform of ["win32", "darwin", "linux"]) {
    h.props.snapshot.platform = platform;
    const tree = h.render();
    for (const name of ["alpha", "beta"]) assert.equal(chromeButton(card(tree, name)).props.disabled, false);
    assert.match(renderToStaticMarkup(tree), /Chrome/);
  }
  h.props.snapshot.state.browserInteractionMode = "manual";
  assert.equal(chromeButton(h.render()), undefined);
  h.props.snapshot.state.browserInteractionMode = "automatic";
  h.props.snapshot.platform = "freebsd";
  assert.equal(chromeButton(h.render()), undefined);
});

test("signed-out account displays sign-in required before an auth retry delay or saved provider cooldown", async () => {
  const before = { name: "beta", authenticated: false, cooling: true, enabled: true, activeTabs: 0,
    retryAt: Date.now() + 30 * 60 * 1000 };
  const h = await accountsHarness({ listAccounts: async () => ({ accounts: [before] }) });
  const rendered = card(h.render(), "beta");
  const pill = visit(rendered).find(node => String(node.props.className || "").includes("account-status-pill"));
  assert.equal(textOf(pill), copy.accountStatusSignedOut);
  assert.match(pill.props.className, /status-signed-out/);
  assert.equal(chromeButton(rendered).props.disabled, false);
  assert.equal(before.cooling, true, "rendering must preserve the provider cooldown");
});

test("authenticated account still displays its real cooldown", async () => {
  const h = await accountsHarness({ listAccounts: async () => ({ accounts: [
    { name: "beta", authenticated: true, cooling: true, enabled: true, activeTabs: 0 },
  ] }) });
  const pill = visit(card(h.render(), "beta")).find(node => String(node.props.className || "").includes("account-status-pill"));
  assert.equal(textOf(pill), copy.accountStatusCooling);
  assert.match(pill.props.className, /status-cooling/);
});

test("disabled and pending-removal account labels retain priority over sign-in and cooldown", async () => {
  const h = await accountsHarness({ listAccounts: async () => ({ accounts: [
    { name: "alpha", authenticated: false, cooling: true, enabled: false, activeTabs: 0 },
    { name: "beta", authenticated: false, cooling: true, enabled: true, pendingRemoval: true, activeTabs: 0 },
  ] }) });
  const status = name => visit(card(h.render(), name)).find(node => String(node.props.className || "").includes("account-status-pill"));
  assert.equal(textOf(status("alpha")), copy.accountStatusDisabled);
  assert.equal(textOf(status("beta")), copy.accountRemovalPending);
});

test("account launch targets beta, locks neighbors, and Continue remains usable during the runtime operation", async () => {
  const calls = [];
  let finish;
  const h = await accountsHarness({
    openAccountPasskeyLogin: name => { calls.push(name); return new Promise(resolve => { finish = resolve; }); },
    openPasskeyLogin: () => assert.fail("must not change the primary session"),
    continuePasskeyLogin: async () => { calls.push("continue"); },
  });
  chromeButton(card(h.render(), "beta")).props.onClick();
  assert.deepEqual(calls, ["beta"]);
  assert.equal(chromeButton(card(h.render(), "beta"), copy.passkeyOpening).props.disabled, true);
  assert.ok(visit(card(h.render(), "alpha")).filter(node => node.type === "button").every(node => node.props.disabled));
  h.props.browser = { ...h.props.browser, passkeyPhase: "waiting", passkeyAccount: "beta" };
  h.props.operation = { status: "running", name: "account-passkey-login", message: "Waiting for Chrome" };
  const waiting = h.render();
  assert.match(textOf(card(waiting, "beta")), /beta/);
  assert.equal(chromeButton(card(waiting, "beta"), copy.passkeyContinue).props.disabled, false);
  assert.equal(chromeButton(card(waiting, "alpha"), copy.passkeyContinue), undefined);
  chromeButton(card(waiting, "beta"), copy.passkeyContinue).props.onClick();
  await flush();
  assert.deepEqual(calls, ["beta", "continue"]);
  assert.equal(chromeButton(card(h.render(), "beta"), copy.passkeyImporting).props.disabled, true);
  h.props.browser = { ...h.props.browser, passkeyPhase: null, passkeyAccount: null };
  h.props.operation = null;
  finish();
  await flush();
  assert.equal(chromeButton(card(h.render(), "beta")).props.disabled, false);
});

test("account import progress survives remount and locks pending removal or unrelated operations", async () => {
  const h = await accountsHarness({ openAccountPasskeyLogin: () => assert.fail("locked action ran") }, {
    browser: { authenticated: true, tabs: [], passkeyPhase: "importing", passkeyAccount: "beta" },
    operation: { status: "running", name: "account-passkey-login" },
  });
  assert.equal(chromeButton(card(h.render(), "beta"), copy.passkeyImporting).props.disabled, true);
  h.props.browser.passkeyPhase = null;
  h.props.operation = { status: "running", name: "doctor" };
  const locked = chromeButton(card(h.render(), "beta"));
  assert.equal(locked.props.disabled, true);
  locked.props.onClick();
  await flush();
  const pending = await accountsHarness({ listAccounts: async () => ({ accounts: [{ ...accountItems[1], pendingRemoval: true }] }) });
  assert.equal(chromeButton(card(pending.render(), "beta")).props.disabled, true);
});

test("Chrome launch failures restore the account action and expose the backend error", async () => {
  const h = await accountsHarness({ openAccountPasskeyLogin: async () => { throw new Error("Selected account has an active turn"); } });
  chromeButton(card(h.render(), "beta")).props.onClick();
  await flush();
  assert.match(h.errors[0], /Selected account has an active turn/);
  assert.equal(chromeButton(card(h.render(), "beta")).props.disabled, false);
});

test("browser toolbar routes manual named sign-in and reauth tabs to their account despite global authentication", async () => {
  for (const tab of [{ isSignInTab: true }, { authenticationRequired: true, isSignInTab: false }]) {
    const calls = [];
    const h = harness("browser", {
      openAccountPasskeyLogin: async name => { calls.push(name); },
      openPasskeyLogin: () => assert.fail("wrong global login route"),
    });
    h.props.browser.tabs = [{ id: "beta-signin", active: true, accountName: "beta", interactionMode: "manual", ...tab }];
    const tree = h.render();
    const button = chromeButton(tree);
    assert.ok(button, "button is visible on the actual authenticated browser surface");
    assert.equal(button.props.disabled, false);
    assert.match(button.props.title, /beta/);
    assert.match(renderToStaticMarkup(tree), /Chrome/);
    button.props.onClick();
    await flush();
    assert.deepEqual(calls, ["beta"]);
  }
});

test("toolbar keeps the active account target after tab changes and preserves the global login path", async () => {
  let continues = 0, global = 0;
  const h = harness("browser", { continuePasskeyLogin: async () => { continues++; },
    openPasskeyLogin: async () => { global++; }, openAccountPasskeyLogin: () => assert.fail("ordinary task is not a login tab") });
  h.props.browser = { authenticated: true, visible: true, tabs: [{ active: true, accountName: "alpha" }],
    passkeyPhase: "waiting", passkeyAccount: "beta" };
  h.props.operation = { status: "running", name: "account-passkey-login" };
  const tree = h.render();
  assert.ok(visit(tree).some(node => node.props.role === "status" && textOf(node).includes("beta")));
  const action = chromeButton(tree, copy.passkeyContinue);
  assert.equal(action.props.disabled, false);
  action.props.onClick();
  await flush();
  assert.equal(continues, 1);
  const regular = harness("browser", { openPasskeyLogin: async () => { global++; },
    openAccountPasskeyLogin: () => assert.fail("ordinary task is not a login tab") });
  regular.props.browser = { authenticated: false, visible: true, tabs: [{ active: true, accountName: "alpha" }] };
  chromeButton(regular.render()).props.onClick();
  await flush();
  assert.equal(global, 1);
  regular.props.browser.authenticated = true;
  assert.equal(chromeButton(regular.render()), undefined);
});
