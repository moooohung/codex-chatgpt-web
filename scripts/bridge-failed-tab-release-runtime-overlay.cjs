const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { assertRunStageCalls } = require("./bridge-run-stage-call-contract.cjs");

const marker = "__codexFailedTab20261007";
const parse = (code) => ts.createSourceFile("runtime.js", code, ts.ScriptTarget.Latest, true);
const nodes = (root, predicate) => {
  const result = [];
  const visit = (node) => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return result;
};
const one = (items, label) => {
  if (items.length !== 1) throw new Error(`${label}: expected one node, got ${items.length}`);
  return items[0];
};
const property = (node, name) => ts.isPropertyAccessExpression(node) && node.name.text === name;
function applyEdits(code, edits) {
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  let next = code, offset = 0;
  for (let i = 0; i < ordered.length; i++) {
    const edit = ordered[i];
    if (i && edit.start < ordered[i - 1].end) throw new Error("Overlapping failed-tab edits");
    edit.original = code.slice(edit.start, edit.end);
    edit.changedStart = edit.start + offset;
    offset += edit.value.length - (edit.end - edit.start);
  }
  for (const edit of [...ordered].reverse()) next = next.slice(0, edit.start) + edit.value + next.slice(edit.end);
  let restored = next;
  for (const edit of [...ordered].reverse()) {
    restored = restored.slice(0, edit.changedStart) + edit.original + restored.slice(edit.changedStart + edit.value.length);
  }
  if (restored !== code || parse(next).parseDiagnostics.length) throw new Error("Failed-tab reverse-byte proof or parse failed");
  return { code: next, evidence: { reverseRestoresOriginalBytes: true, edits: edits.map(edit => edit.label) } };
}
function patchFailedTabRuntime(code) {
  if (code.includes(marker)) throw new Error("Failed-tab overlay already present");
  if (!code.includes("__codexSubmissionUi20261007")) throw new Error("Expected reviewed R12 runtime");
  const file = parse(code), edits = [];
  const insert = (start, value, label) => edits.push({ start, end: start, value, label });
  const replace = (node, value, label) => edits.push({ start: node.getStart(file), end: node.end, value, label });
  const browser = one(nodes(file, node => ts.isMethodDeclaration(node) && node.name.getText(file) === "runBrowserTurn"), "browser worker");
  const exclusive = one(browser.parent.members.filter(node => ts.isMethodDeclaration(node) && node.name.getText(file) === "runExclusive"),
    "browser exclusive lease");
  if (exclusive.parameters.length !== 1 || browser.parameters.length !== 5) throw new Error("Unreviewed browser parameter contract");
  const outer = one(nodes(exclusive, node => ts.isTryStatement(node) && node.catchClause && node.finallyBlock
    && node.tryBlock.getText(file).includes("this.runBrowserTurn(")), "exclusive lifecycle");
  const error = outer.catchClause.variableDeclaration.name.getText(file);
  const status = one(nodes(outer.catchClause, node => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && node.right.getText(file).includes('"completed"') && node.right.getText(file).includes('"failed"')), "terminal status");
  const message = one(nodes(outer.catchClause, node => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && node.right.getText(file).includes(".message.slice(0,500)")), "terminal message");
  const compaction = one(nodes(status.right, node => ts.isConditionalExpression(node) && node.whenTrue.getText(file) === '"completed"'),
    "accepted handoff guard").condition.right.getText(file);
  const heartbeat = one(nodes(exclusive, node => ts.isArrowFunction(node) && node.body.getText(file).includes('phase:"heartbeat"')),
    "lease heartbeat");
  const finished = heartbeat.body.statements[0];
  if (!ts.isIfStatement(finished) || !ts.isIdentifier(finished.expression)) throw new Error("Unreviewed heartbeat stop guard");
  const timer = one(nodes(outer.finallyBlock, node => ts.isCallExpression(node) && node.expression.getText(file) === "clearInterval"),
    "heartbeat timer").arguments[0].getText(file);
  const end = one(nodes(outer.finallyBlock, node => ts.isCallExpression(node) && node.arguments.some(arg =>
    ts.isObjectLiteralExpression(arg) && arg.properties.some(p => p.name?.getText(file) === "phase" && p.initializer?.getText(file) === '"end"'))),
    "owned turn end");
  const renameError = (node) => {
    const transform = ts.transform(node, [context => {
      const visit = n => ts.isIdentifier(n) && n.text === error ? ts.factory.createIdentifier("__fatal") : ts.visitEachChild(n, visit, context);
      return n => ts.visitNode(n, visit);
    }]);
    const result = ts.createPrinter().printNode(ts.EmitHint.Unspecified, transform.transformed[0], file);
    transform.dispose(); return result;
  };
  insert(outer.getStart(file), `let ${marker};const __codexReleaseFailedTab=async(__fatal)=>{
    if(__fatal instanceof ${compaction})return;
    if(!${marker}){${status.left.getText(file)}=${renameError(status.right)};${message.left.getText(file)}=${renameError(message.right)};
      ${finished.expression.text}=true;if(${timer})clearInterval(${timer});${marker}=${end.getText(file)};}
    await ${marker}.catch(()=>{});
  };`, "release exact failed lease before diagnostics and cleanup");
  const run = one(nodes(outer.tryBlock, node => ts.isCallExpression(node) && property(node.expression, "runBrowserTurn")), "owned browser invocation");
  if (run.arguments.length !== 5) throw new Error("Unreviewed browser invocation contract");
  insert(run.arguments.end, ",__codexReleaseFailedTab", "pass terminal callback without moving prior arguments");
  replace(end, `(${marker}??${end.getText(file)})`, "reuse one end result in authoritative finally");
  insert(browser.parameters.end, ",__codexOnTerminalFailure", "optional private terminal callback");
  const inner = one(browser.body.statements.filter(node => ts.isTryStatement(node) && node.catchClause && node.finallyBlock), "browser lifecycle");
  const terminalLog = one(nodes(inner.catchClause, node => ts.isCallExpression(node) && node.expression.getText(file) === "console.error"
    && node.getText(file).includes("failed:")), "fatal browser log");
  if (!ts.isBinaryExpression(terminalLog.parent) || terminalLog.parent.operatorToken.kind !== ts.SyntaxKind.CommaToken) {
    throw new Error("Unreviewed terminal diagnostic condition");
  }
  insert(terminalLog.end, `,await __codexOnTerminalFailure?.(${inner.catchClause.variableDeclaration.name.getText(file)})`,
    "notify after fatal verdict and before final DOM diagnostic");
  const result = applyEdits(code, edits);
  const before = assertRunStageCalls(code), after = assertRunStageCalls(result.code);
  if (JSON.stringify(before.calls.map(call => call.arguments)) !== JSON.stringify(after.calls.map(call => call.arguments))) {
    throw new Error("Failed-tab patch moved a runStage argument");
  }
  const capture = one(nodes(inner.catchClause, node => ts.isCallExpression(node) && property(node.expression, "capture")
    && node.arguments[1]?.getText(file) === '"turn-failed"'), "fatal capture");
  const rejection = one(nodes(inner.catchClause, node => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && node.right.getText(file).endsWith(".signal.reason")), "rejection abort reason");
  const originalSignal = one(nodes(inner.catchClause, node => property(node, "aborted") && node.questionDotToken), "original abort signal");
  const observer = one(nodes(inner.catchClause, node => ts.isCallExpression(node) && property(node.expression, "failure")), "submission rejection");
  const redactor = one(nodes(terminalLog, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && ts.isConditionalExpression(node.arguments[0])), "diagnostic redactor");
  const all = one(nodes(inner.finallyBlock, node => ts.isCallExpression(node) && node.expression.getText(file) === "Promise.all"), "usage writes");
  const release = one(nodes(inner.finallyBlock, node => ts.isCallExpression(node) && property(node.expression, "release")), "prompt release");
  const closes = nodes(inner.finallyBlock, node => ts.isCallExpression(node) && property(node.expression, "close"));
  if (closes.length !== 2) throw new Error("Unreviewed physical cleanup");
  return { ...result, evidence: { ...result.evidence, runStageCallsPreserved: after.calls.length,
    bindings: { notify: end.expression.getText(file), compaction,
      adapterError: nodes(status.right, node => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword).at(-1).right.getText(file),
      heartbeatInterval: one(nodes(exclusive, node => ts.isCallExpression(node) && node.expression.getText(file) === "setInterval"), "heartbeat interval").arguments[1].getText(file),
      heartbeatTimeout: one(nodes(heartbeat, node => ts.isCallExpression(node) && node.expression.getText(file) === end.expression.getText(file)), "heartbeat notification").arguments[2].getText(file),
      turn: browser.parameters[0].name.getText(file), diagnostic: capture.expression.expression.getText(file), page: capture.arguments[0].getText(file),
      rejectionAbort: rejection.right.expression.expression.getText(file), originalSignal: originalSignal.expression.getText(file),
      observer: observer.expression.expression.getText(file), redactor: redactor.expression.getText(file), usageWrites: all.arguments[0].getText(file),
      prepared: release.expression.expression.getText(file), connection: closes[0].expression.expression.getText(file),
      managedPage: closes[1].expression.expression.getText(file) } } };
}
function patchRendererOwnershipHost(code) {
  if (code.includes("function rendererPidFor(")) throw new Error("Renderer ownership overlay already present");
  const file = parse(code), edits = [];
  const insert = (start, value, label) => edits.push({ start, end: start, value, label });
  const owned = parse(fs.readFileSync(path.join(__dirname, "../launcher/electron/browser-host.cjs"), "utf8"));
  const helper = one(owned.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === "rendererPidFor"), "owned PID getter");
  insert(code.length, "\n" + helper.getText(owned) + "\n", "native PID getter with exiting-renderer guard");
  for (const name of ["tabSnapshot", "snapshot"]) {
    const method = one(nodes(file, node => ts.isMethodDeclaration(node) && node.name.getText(file) === name), name);
    const object = one(nodes(method, node => ts.isObjectLiteralExpression(node) && node.properties.some(p =>
      p.name?.getText(file) === "traceId" && p.initializer?.getText(file) === (name === "snapshot" ? "null" : "tab.traceId"))), "tab identity");
    const title = one(object.properties.filter(p => p.name?.getText(file) === "title"), "tab title");
    insert(title.getStart(file), `rendererPid: rendererPidFor(${name === "snapshot" ? "this.view" : "tab.view"}?.webContents),\n      `,
      name + " publishes PID for this exact view");
  }
  for (const [event, contents] of [["browser.tab_created", "tab.view"], ["browser.tab_reused", "existing.view"], ["browser.tab_released", null]]) {
    const log = one(nodes(file, node => ts.isCallExpression(node) && node.arguments[0]?.getText(file) === JSON.stringify(event)), event);
    const trace = one(log.arguments[1].properties.filter(p => p.name?.getText(file) === "traceId"), "logged trace");
    insert(trace.getStart(file), contents ? `rendererPid: rendererPidFor(${contents}?.webContents), ` : "rendererPid, ", event + " maps native PID");
    if (!contents) {
      const method = one(nodes(file, node => ts.isMethodDeclaration(node) && node.name.getText(file) === "endTurn"), "owned end");
      const remove = one(nodes(method, node => ts.isCallExpression(node) && property(node.expression, "removeTurnTab")), "owned removal");
      insert(remove.parent.getStart(file), "const rendererPid = rendererPidFor(tab.view?.webContents);\n    ", "read PID before document destruction");
    }
  }
  return applyEdits(code, edits);
}
module.exports = { patchFailedTabRuntime, patchRendererOwnershipHost };
