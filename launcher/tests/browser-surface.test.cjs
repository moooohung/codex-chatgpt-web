const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { IDLE_BROWSER_URL } = require("../electron/browser-host.cjs");
const source = fs.readFileSync(path.join(__dirname, "../src/browser-surface.ts"), "utf8");
const compiledExports = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
  { exports: compiledExports, URL });

test("only the owned idle/bootstrap surface gets an empty-state UI instead of native white paint", () => {
  for (const url of [undefined, "about:blank", IDLE_BROWSER_URL]) {
    assert.equal(compiledExports.isIdleBrowserSurface(url), true);
  }
  for (const url of ["https://chatgpt.com/c/saved", "https://chatgpt.com/?temporary-chat=true",
    "https://auth.openai.com/", "data:text/html,another-document", "not a URL"]) {
    assert.equal(compiledExports.isIdleBrowserSurface(url), false, url);
  }
});

test("the actual browser panel renders preparation, retry and normal page states without exposing the idle HTML URL", () => {
  const appPath = path.join(__dirname, "../src/App.tsx");
  const appSource = fs.readFileSync(appPath, "utf8");
  const tree = ts.createSourceFile("App.tsx", appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const panelSource = tree.statements.filter(node => ts.isFunctionDeclaration(node)
    && ["BrowserSurface", "formatBrowserAddress"].includes(node.name?.text)).map(node => node.getText(tree)).join("\n");
  const button = ({ disabled, children, label }) => React.createElement("button", { disabled }, children ?? label);
  const context = vm.createContext({ React, URL, isIdleBrowserSurface: compiledExports.isIdleBrowserSurface,
    useState: value => [value, () => {}], useEffect() {}, api: {},
    Icon: () => null, BrandMark: () => null, IconButton: button, PrimaryButton: button, SecondaryButton: button });
  vm.runInContext(ts.transpileModule(panelSource, { fileName: "panel.tsx", compilerOptions:
    { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText
    + "\nglobalThis.panel = BrowserSurface;", context);
  const copy = { browserAddress: "ChatGPT browser", loading: "Loading", noActiveTask: "No active task",
    noActiveTaskBody: "Open ChatGPT", openChatgpt: "Open ChatGPT", hideBrowser: "Hide ChatGPT", zoomReset: "Reset zoom" };
  const browser = { visible: true, authenticated: true, url: IDLE_BROWSER_URL, status: "running", tabs: [] };
  const render = state => renderToStaticMarkup(context.panel({ browser: state, copy, interactionMode: "automatic",
    platform: "win32", browserSlotRef() {}, setError() {}, operation: null }));
  const preparing = render(browser);
  assert.match(preparing, /class="browser-empty"/);
  assert.match(preparing, /<h1>Loading<\/h1>/);
  assert.match(preparing, /<button disabled="">Open ChatGPT<\/button>/, "cannot reload a running turn");
  assert.doesNotMatch(preparing, /charset=utf-8|doctype/);
  const retry = render({ ...browser, status: "error", message: "Could not restore. Retry." });
  assert.match(retry, /Could not restore. Retry./);
  assert.match(retry, /<button>Open ChatGPT<\/button>/);
  const ready = render({ ...browser, status: "ready", url: "https://chatgpt.com/c/saved" });
  assert.match(ready, /class="browser-underlay"/);
  assert.doesNotMatch(ready, /class="browser-empty"/);
  assert.match(ready, /chatgpt.com\/c\/saved/);
});
