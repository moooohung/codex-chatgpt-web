import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError, chatGptBrowserTabClosedError } from "../src/adapters/chatgpt-web/adapter-error";
const ts = require("typescript");
const { patchFailedTabRuntime, patchRendererOwnershipHost } = require("../scripts/bridge-failed-tab-release-runtime-overlay.cjs");
const { patchRenderBudgetRuntime, patchResourceBudgetHost } = require("../scripts/bridge-render-budget-runtime-overlay.cjs");
const base = process.env.CHATGPT_FAILED_TAB_BASE_ROOT;
const candidate = process.env.CHATGPT_STAGE_CALL_RUNTIME_ROOT;
const nodes = (root: any, predicate: (node: any) => boolean): any[] => {
  const result: any[] = [];
  const visit = (node: any) => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); };
  visit(root); return result;
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

test.skipIf(!base || !candidate)("failed-tab candidates reproduce guarded edits and reverse to every R12 byte", () => {
  for (const relative of ["app/cli.js", "app/browser-helper.cjs", "launcher/electron/browser-host.cjs"]) {
    const original = readFileSync(join(base!, relative), "utf8");
    const patch = relative.startsWith("app/") ? patchFailedTabRuntime : patchRendererOwnershipHost;
    let result = patch(original);
    if (process.env.CHATGPT_RENDER_CANDIDATE_ROOT) {
      const followup = relative.startsWith("app/") ? patchRenderBudgetRuntime : patchResourceBudgetHost;
      const rendered = followup(result.code);
      expect(rendered.evidence.reverseRestoresOriginalBytes).toBeTrue();
      result = { ...result, code: rendered.code };
    }
    expect(result.code).toBe(readFileSync(join(candidate!, relative), "utf8"));
    expect(result.evidence.reverseRestoresOriginalBytes).toBeTrue();
    expect(() => patch(result.code)).toThrow("already present");
    if (relative.startsWith("app/")) expect(result.evidence.runStageCallsPreserved).toBe(17);
  }
});

const cases = ["app/cli.js", "app/browser-helper.cjs"].flatMap(relative => [false, true].flatMap(patched =>
  ["failed", "cancelled", "handoff", "release-error"].map(kind => [relative, patched ? "candidate" : "R12-base", kind] as const)));
test.skipIf(!base || !candidate).each(cases)(
  "compiled lease/catch/finally reproduces diagnostic and cleanup retention (%s, %s, %s)", async (relative, version, kind) => {
    const patched = version === "candidate";
    const original = readFileSync(join(base!, relative), "utf8");
    const bindings = patchFailedTabRuntime(original).evidence.bindings;
    const code = readFileSync(join(patched ? candidate! : base!, relative), "utf8");
    const file = ts.createSourceFile(relative, code, ts.ScriptTarget.Latest, true);
    const browser = nodes(file, node => ts.isMethodDeclaration(node) && node.name.getText(file) === "runBrowserTurn")[0];
    const exclusive = browser.parent.members.find((node: any) => ts.isMethodDeclaration(node) && node.name.getText(file) === "runExclusive");
    const lifecycle = browser.body.statements.find((node: any) => ts.isTryStatement(node) && node.catchClause && node.finallyBlock);
    const diagnostic = deferred(), diagnosticReached = deferred(), usage = deferred(), transport = deferred(), transportReached = deferred();
    const controller = new AbortController();
    const verdict = kind === "handoff" ? new ChatGptCompactionHandoffAccepted()
      : kind === "cancelled" ? chatGptBrowserTabClosedError() : new Error("fixture DOM observation failed");
    let promptReleased = false, physicallySettled = false;
    const messages: Array<Record<string, unknown>> = [], logs: string[] = [];
    const scope: Record<string, any> = { Error, DOMException, AbortController, setInterval, clearInterval, process: { pid: 777 },
      console: { info() {}, warn() {}, error: (line: string) => logs.push(line) }, fixtureError: verdict };
    Object.assign(scope, {
      [bindings.notify]: async (_descriptor: string, message: Record<string, unknown>) => {
        messages.push(message);
        if (message.phase === "end" && kind === "release-error") throw new Error("fixture control unavailable");
        return message.phase === "start" ? { surfaceId: "a".repeat(32), reused: false, connectorBound: false }
          : { cancelledByUser: false };
      },
      [bindings.compaction]: ChatGptCompactionHandoffAccepted,
      [bindings.adapterError]: ChatGptWebAdapterError,
      [bindings.heartbeatInterval]: 100_000, [bindings.heartbeatTimeout]: 1_000,
      [bindings.originalSignal]: controller.signal,
      [bindings.rejectionAbort]: new AbortController(),
      [bindings.observer]: { failure: async () => undefined, dispose() {} },
      [bindings.redactor]: (message: string) => message,
      [bindings.diagnostic]: { capture: async () => { diagnosticReached.resolve(); await diagnostic.promise; } },
      [bindings.page]: { isClosed: () => false },
      [bindings.usageWrites]: [usage.promise],
      [bindings.prepared]: { release: () => { promptReleased = true; } },
      [bindings.connection]: { close: async () => { transportReached.resolve(); await transport.promise; } },
      [bindings.managedPage]: undefined,
    });
    vm.createContext(scope);
    // Execute the actual compiled lease method and terminal catch/finally blocks. Only the
    // browser action, DOM diagnostic and physical transport are isolated offline fixtures.
    vm.runInContext(`class Worker { ${exclusive.getText(file)} };globalThis.worker=new Worker();
      globalThis.observed=async function(${bindings.turn},__codexOnTerminalFailure){try{throw fixtureError;}
        ${lifecycle.catchClause.getText(file)}finally ${lifecycle.finallyBlock.getText(file)}};`, scope);
    scope.worker.config = { browserHost: "launcher", browserHostDescriptorPath: "offline-descriptor", appName: "Codex Native2" };
    scope.worker.runBrowserTurn = (turn: unknown, surface: string, maintenance: unknown, reused: boolean, usage: boolean, onFailure: unknown) => {
      expect([surface, maintenance, reused, usage]).toEqual(["a".repeat(32), undefined, false, false]);
      if (kind === "handoff") { controller.abort(verdict); scope.fixtureError = new DOMException("observation aborted", "AbortError"); }
      return scope.observed(turn, onFailure);
    };
    const outcome = scope.worker.runExclusive({ traceId: "offline_failed_owner", capabilities: { localToolsEnabled: false },
      conversationKey: "b".repeat(64), retainConversation: true, abortSignal: controller.signal })
      .then(() => { physicallySettled = true; }, (error: unknown) => { physicallySettled = true; return error; });
    try {
      await Promise.race([diagnosticReached.promise, outcome.then((error: unknown) => { throw error ?? new Error("diagnostic was skipped"); })]);
      const early = patched && kind !== "handoff" ? 1 : 0;
      const ends = () => messages.filter(message => message.phase === "end");
      expect(ends()).toHaveLength(early);
      if (early) expect(ends()[0]).toMatchObject({ traceId: "offline_failed_owner", helperPid: 777,
        status: kind === "cancelled" ? "aborted" : "failed" });
      expect(promptReleased).toBeFalse(); expect(physicallySettled).toBeFalse();
      diagnostic.resolve();
      await Bun.sleep(1);
      expect(promptReleased).toBeFalse(); // The unchanged finally still owns usage settlement.
      usage.resolve(); await transportReached.promise;
      expect(promptReleased).toBeTrue(); expect(physicallySettled).toBeFalse(); expect(ends()).toHaveLength(early);
      transport.resolve(); expect(await outcome).toBe(verdict);
      expect(ends()).toHaveLength(1);
      if (kind === "handoff") expect(ends()[0]).toMatchObject({ status: "completed", retain: true });
      else expect(ends()[0].retain).toBeUndefined();
      expect(logs.filter(line => line.includes("turn-end notification failed"))).toHaveLength(kind === "release-error" ? 1 : 0);
    } finally {
      diagnostic.resolve(); usage.resolve(); transport.resolve(); await outcome;
    }
  },
);

test.skipIf(!base || !candidate)("staged native snapshots map home and task renderers independently with no DOM evaluation", () => {
  const code = readFileSync(join(candidate!, "launcher/electron/browser-host.cjs"), "utf8");
  const file = ts.createSourceFile("host.cjs", code, ts.ScriptTarget.Latest, true);
  const getter = nodes(file, node => ts.isFunctionDeclaration(node) && node.name?.text === "rendererPidFor")[0];
  const methods = nodes(file, node => ts.isMethodDeclaration(node) && ["tabSnapshot", "snapshot"].includes(node.name.getText(file)));
  const scope: Record<string, any> = { accountNameForTab: () => null, browserInteractionModeFor: () => "automatic",
    resolveBrowserMemoryPolicy: () => ({ maxTabs: 4 }), readBrowserNavigationState: (_contents: unknown, state: unknown) => state };
  vm.createContext(scope);
  vm.runInContext(getter.getText(file) + `;class Host{${methods.map(method => method.getText(file)).join("\n")}};globalThis.host=new Host();`, scope);
  const contents = (pid: number) => ({ getOSProcessId: () => pid, isDestroyed: () => false,
    executeJavaScript: () => { throw new Error("DOM evaluation forbidden"); } });
  const task = { id: "task", traceId: "owned_trace", label: "ChatGPT", status: "running", view: { webContents: contents(42364) } };
  Object.assign(scope.host, { view: { webContents: contents(42360) }, activeView: () => ({ webContents: contents(42368) }),
    selectedTabId: "home", selectedTurnTab: () => null, state: { title: "ChatGPT", status: "ready" }, turnTabs: new Map([[task.id, task]]) });
  expect(scope.host.snapshot().tabs.map((tab: any) => [tab.id, tab.traceId, tab.rendererPid]))
    .toEqual([["home", null, 42360], ["task", "owned_trace", 42364]]);
});
