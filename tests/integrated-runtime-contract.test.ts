import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError, chatGptBrowserTabClosedError } from "../src/adapters/chatgpt-web/adapter-error";
const ts = require("typescript");
const root = process.env.CHATGPT_STAGE_CALL_RUNTIME_ROOT;
const nodes = (root: any, predicate: (node: any) => boolean): any[] => {
  const result: any[] = [];
  const visit = (node: any) => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); };
  visit(root); return result;
};
const one = (items: any[], label: string) => {
  if (items.length !== 1) throw new Error(`${label}: expected one node, got ${items.length}`);
  return items[0];
};
const property = (node: any, name: string) => ts.isPropertyAccessExpression(node) && node.name.text === name;
function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(yes => { resolve = yes; }), resolve: () => resolve() };
}
const cases = ["app/cli.js", "app/browser-helper.cjs"].flatMap(relative =>
  ["failed", "cancelled", "handoff", "release-error", "completed", "retained"].map(kind => [relative, kind] as const));

test.skipIf(!root).each(cases)("integrated %s releases only the terminal lease before slow cleanup (%s)", async (relative, kind) => {
  const file = ts.createSourceFile(relative, readFileSync(join(root!, relative), "utf8"), ts.ScriptTarget.Latest, true);
  const browser = one(nodes(file, node => ts.isMethodDeclaration(node) && node.name.getText(file) === "runBrowserTurn"), "browser method");
  const exclusive = one(browser.parent.members.filter((node: any) => ts.isMethodDeclaration(node) && node.name.getText(file) === "runExclusive"), "exclusive lease");
  expect(browser.parameters).toHaveLength(7);
  const outer = one(nodes(exclusive, node => ts.isTryStatement(node) && node.catchClause && node.finallyBlock
    && node.tryBlock.getText(file).includes("this.runBrowserTurn(")), "lease lifecycle");
  const inner = one(browser.body.statements.filter((node: any) => ts.isTryStatement(node) && node.catchClause && node.finallyBlock), "browser lifecycle");
  const end = one(nodes(outer.finallyBlock, node => ts.isCallExpression(node) && node.arguments.some((arg: any) =>
    ts.isObjectLiteralExpression(arg) && arg.properties.some((p: any) => p.name?.getText(file) === "phase" && p.initializer?.getText(file) === '"end"'))), "end notification");
  const terminal = one(nodes(exclusive, node => ts.isConditionalExpression(node) && node.whenTrue.getText(file) === '"completed"'
    && ts.isBinaryExpression(node.condition) && node.condition.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword), "handoff class");
  const heartbeat = one(nodes(exclusive, node => ts.isArrowFunction(node) && node.body.getText(file).includes('phase:"heartbeat"')), "heartbeat");
  const capture = one(nodes(inner.catchClause, node => ts.isCallExpression(node) && property(node.expression, "capture")
    && node.arguments[1]?.getText(file) === '"turn-failed"'), "failure diagnostic");
  const rejection = one(nodes(inner.catchClause, node => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && node.right.getText(file).endsWith(".signal.reason")), "rejection reason");
  const originalSignal = one(nodes(inner.catchClause, node => property(node, "aborted") && node.questionDotToken), "original signal");
  const observer = one(nodes(inner.catchClause, node => ts.isCallExpression(node) && property(node.expression, "failure")), "rejection observer");
  const log = one(nodes(inner.catchClause, node => ts.isCallExpression(node) && node.expression.getText(file) === "console.error"), "failure log");
  const redactor = one(nodes(log, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && ts.isConditionalExpression(node.arguments[0])), "redactor");
  const all = one(nodes(inner.finallyBlock, node => ts.isCallExpression(node) && node.expression.getText(file) === "Promise.all"), "usage settlement");
  const release = one(nodes(inner.finallyBlock, node => ts.isCallExpression(node) && property(node.expression, "release")), "prompt release");
  const closes = nodes(inner.finallyBlock, node => ts.isCallExpression(node) && property(node.expression, "close"));
  expect(closes).toHaveLength(2);
  const adapter = nodes(inner.catchClause, node => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
    && node.right.getText(file) !== "DOMException")[0].right.getText(file);
  const completed = kind === "completed" || kind === "retained";
  const diagnostic = deferred(), diagnosticReached = deferred(), usage = deferred(), transport = deferred(), transportReached = deferred();
  const controller = new AbortController();
  const verdict = kind === "handoff" ? new ChatGptCompactionHandoffAccepted()
    : kind === "cancelled" ? chatGptBrowserTabClosedError() : new Error("fixture DOM failure");
  let promptReleased = false, physicallySettled = false;
  const messages: any[] = [], logs: string[] = [];
  const scope: any = { Error, DOMException, AbortController, setInterval, clearInterval, process: { pid: 777 },
    console: { info() {}, warn() {}, error: (line: string) => logs.push(line) }, fixtureError: verdict, fixtureDiagnostic: async () => { diagnosticReached.resolve(); await diagnostic.promise; } };
  Object.assign(scope, {
    [end.expression.getText(file)]: async (_descriptor: string, message: any) => {
      messages.push(message);
      if (message.phase === "end" && kind === "release-error") throw new Error("fixture control unavailable");
      return message.phase === "start" ? { surfaceId: "a".repeat(32), reused: false, connectorBound: false } : { cancelledByUser: false };
    },
    [terminal.condition.right.getText(file)]: ChatGptCompactionHandoffAccepted,
    [adapter]: ChatGptWebAdapterError,
    [one(nodes(exclusive, node => ts.isCallExpression(node) && node.expression.getText(file) === "setInterval"), "interval").arguments[1].getText(file)]: 100_000,
    [one(nodes(heartbeat, node => ts.isCallExpression(node) && node.expression.getText(file) === end.expression.getText(file)), "heartbeat notification").arguments[2].getText(file)]: 1000,
    [originalSignal.expression.getText(file)]: controller.signal,
    [rejection.right.expression.expression.getText(file)]: new AbortController(),
    [observer.expression.expression.getText(file)]: { failure: async () => undefined, dispose() {} },
    [redactor.expression.getText(file)]: (message: string) => message,
    [capture.expression.expression.getText(file)]: { capture: scope.fixtureDiagnostic },
    [capture.arguments[0].getText(file)]: { isClosed: () => false },
    [all.arguments[0].getText(file)]: [usage.promise],
    [release.expression.expression.getText(file)]: { release: () => { promptReleased = true; } },
    [closes[0].expression.expression.getText(file)]: { close: async () => { transportReached.resolve(); await transport.promise; } },
    [closes[1].expression.expression.getText(file)]: undefined,
  });
  vm.createContext(scope);
  const success = one(nodes(browser, node => ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(file) === browser.parameters[6].name.getText(file)), "completion callback");
  const completionCapture = one(nodes(browser, node => ts.isCallExpression(node) && property(node.expression, "capture")
    && node.arguments[1]?.getText(file) === '"turn-completed"'), "completion capture");
  expect(success.pos).toBeLessThan(completionCapture.pos);
  const observedBody = completed ? `${success.getText(file)};await fixtureDiagnostic();return "answer";` : "throw fixtureError;";
  vm.runInContext(`class Worker { ${exclusive.getText(file)} };globalThis.worker=new Worker();
    globalThis.observed=async function(${browser.parameters[0].name.getText(file)},${browser.parameters[5].name.getText(file)},${browser.parameters[6].name.getText(file)}){try{${observedBody}}
      ${inner.catchClause.getText(file)}finally ${inner.finallyBlock.getText(file)}};`, scope);
  scope.worker.config = { browserHost: "launcher", browserHostDescriptorPath: "offline-descriptor", appName: "Codex Native2" };
  scope.worker.runBrowserTurn = (turn: any, surface: string, maintenance: any, reused: boolean, trackUsage: boolean, onFailure: any, onComplete: any) => {
    expect([surface, maintenance, reused, trackUsage]).toEqual(["a".repeat(32), undefined, false, false]);
    if (kind === "handoff") { controller.abort(verdict); scope.fixtureError = new DOMException("aborted", "AbortError"); }
    return scope.observed(turn, onFailure, onComplete);
  };
  const outcome = scope.worker.runExclusive({ traceId: "offline_integrated_owner", capabilities: { localToolsEnabled: false },
    conversationKey: "b".repeat(64), retainConversation: kind === "handoff" || kind === "retained", abortSignal: controller.signal })
    .then((value: string) => { physicallySettled = true; return value; }, (error: unknown) => { physicallySettled = true; return error; });
  try {
    await Promise.race([diagnosticReached.promise, outcome.then((error: unknown) => { throw error ?? new Error("diagnostic skipped"); })]);
    const early = kind === "handoff" || kind === "retained" ? 0 : 1;
    const ends = () => messages.filter(message => message.phase === "end");
    expect(ends()).toHaveLength(early);
    if (early) expect(ends()[0]).toMatchObject({ traceId: "offline_integrated_owner", helperPid: 777,
      status: kind === "cancelled" ? "aborted" : completed ? "completed" : "failed" });
    expect(promptReleased).toBeFalse(); expect(physicallySettled).toBeFalse();
    diagnostic.resolve(); await Bun.sleep(1); expect(promptReleased).toBeFalse();
    usage.resolve(); await transportReached.promise;
    expect(promptReleased).toBeTrue(); expect(physicallySettled).toBeFalse(); expect(ends()).toHaveLength(early);
    transport.resolve(); expect(await outcome).toBe(completed ? "answer" : verdict);
    expect(ends()).toHaveLength(1);
    expect(ends()[0].retain).toBe(early ? undefined : true);
    expect(logs.filter(line => line.includes("turn-end notification failed"))).toHaveLength(kind === "release-error" ? 1 : 0);
  } finally { diagnostic.resolve(); usage.resolve(); transport.resolve(); await outcome; }
});
