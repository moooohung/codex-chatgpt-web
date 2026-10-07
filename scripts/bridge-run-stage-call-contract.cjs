const ts = require('typescript');

function nodes(root, predicate) {
  const result = [];
  const visit = node => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return result;
}

function inspectRunStageCalls(code, filename = 'runtime.js') {
  const source = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) throw new Error('Runtime source has parse diagnostics');
  const methods = nodes(source, node => ts.isMethodDeclaration(node) && node.name.getText(source) === 'runStage');
  if (methods.length !== 1 || !methods[0].parameters[4]?.initializer) throw new Error('One runStage clock contract is required');
  const clock = methods[0].parameters[4].initializer.getText(source);
  const boolean = node => node && (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword
    || ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken && ts.isNumericLiteral(node.operand));
  const label = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)
    || ts.isConditionalExpression(node) && label(node.whenTrue) && label(node.whenFalse));
  const absent = node => !node || node.getText(source) === 'undefined' || ts.isVoidExpression(node);
  const calls = nodes(source, node => ts.isCallExpression(node) && node.expression.getText(source) === 'this.runStage').map(node => {
    const args = node.arguments, failures = [];
    if (args.length < 4 || args.length > 6) failures.push('argument-count');
    if (!label(args[1])) failures.push('stage-label');
    if (!args[3] || !(ts.isArrowFunction(args[3]) || ts.isFunctionExpression(args[3]) || ts.isIdentifier(args[3]) || ts.isPropertyAccessExpression(args[3]))) failures.push('action-position');
    if (!absent(args[4]) && args[4].getText(source) !== clock) failures.push('clock-position');
    if (!absent(args[5]) && !boolean(args[5])) failures.push('settlement-position');
    return { start: node.getStart(source), end: node.end, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      argc: args.length, arguments: args.map(arg => arg.getText(source)), failures, node };
  });
  if (!calls.length) throw new Error('No runStage calls were inspected');
  return { source, clock, method: methods[0], calls };
}

function assertRunStageCalls(code, filename) {
  const result = inspectRunStageCalls(code, filename);
  const invalid = result.calls.filter(call => call.failures.length);
  if (invalid.length) throw new Error('Invalid runStage call: ' + JSON.stringify(invalid.map(({ line, argc, failures }) => ({ line, argc, failures }))));
  return result;
}

/** Repair only the observed R8 comma-expression argument spill; preserve all other bytes. */
function repairModelSelectionStageCall(code, filename) {
  const inspected = inspectRunStageCalls(code, filename);
  const matches = inspected.calls.filter(call => call.failures.includes('clock-position') && call.argc === 6
    && ts.isAwaitExpression(call.node.arguments[1]) && ts.isCallExpression(call.node.arguments[2])
    && call.node.arguments[2].expression.getText(inspected.source) === 'console.info'
    && ts.isConditionalExpression(call.node.arguments[3])
    && call.node.arguments[3].whenTrue.getText(inspected.source) === '"multipart_staging_effort_selection"'
    && call.node.arguments[3].whenFalse.getText(inspected.source) === '"effort_selection"');
  if (matches.length !== 1) throw new Error('Expected exactly one observed R8 argument spill');
  const call = matches[0], expression = call.node.expression.getText(inspected.source);
  const replacement = expression + '(' + [0, 3, 4, 5].map(index => call.arguments[index]).join(',') + ')';
  const original = code.slice(call.start, call.end);
  const patched = code.slice(0, call.start) + replacement + code.slice(call.end);
  const checked = assertRunStageCalls(patched, filename);
  if (checked.calls.length !== inspected.calls.length) throw new Error('Stage call count changed');
  if (patched.slice(0, call.start) + original + patched.slice(call.start + replacement.length) !== code) throw new Error('Unowned runtime bytes changed');
  return { code: patched, evidence: { line: call.line, beforeArgc: call.argc, afterArgc: 4, callsChecked: checked.calls.length,
    original, replacement, reverseRestoresOriginalBytes: true } };
}

/** Restore the source catch contract after R8 inserted a comma expression as an error argument. */
function repairModelSelectionStageCatch(code, filename) {
  const inspected = assertRunStageCalls(code, filename), source = inspected.source;
  const method = inspected.method, stage = method.parameters[1].name.getText(source);
  const catches = nodes(method, node => ts.isCatchClause(node) && node.block.statements.some(statement => ts.isThrowStatement(statement)));
  if (catches.length !== 1) throw new Error('Expected one stage failure catch');
  const statements = catches[0].block.statements;
  const thrown = statements[statements.length - 2], tail = statements[statements.length - 1];
  const wrappers = nodes(thrown, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'chatGptModelSelectionStageError');
  if (!ts.isThrowStatement(thrown) || !ts.isExpressionStatement(tail) || wrappers.length !== 1) throw new Error('Observed R8 stage catch changed');
  const wrapper = wrappers[0], args = wrapper.arguments;
  if (args.length !== 3 || !ts.isCallExpression(args[0]) || args[0].expression.getText(source) !== 'console.error'
    || !ts.isIdentifier(args[1]) || args[2].getText(source) !== stage) throw new Error('Observed R8 stage error arguments changed');
  const error = args[1].getText(source), log = args[0].getText(source);
  if (tail.expression.getText(source) !== log + ',' + error) throw new Error('Observed R8 unreachable failure log changed');
  const original = code.slice(thrown.getStart(source), tail.end);
  const replacement = error + '=' + wrapper.expression.getText(source) + '(' + error + ',' + stage + ');throw ' + log + ',' + error + ';';
  const start = thrown.getStart(source), patched = code.slice(0, start) + replacement + code.slice(tail.end);
  const checked = assertRunStageCalls(patched, filename);
  const corrected = nodes(checked.method, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'chatGptModelSelectionStageError');
  const logs = nodes(checked.method, node => ts.isCallExpression(node) && node.expression.getText(checked.source) === 'console.error');
  if (corrected.length !== 1 || corrected[0].arguments.length !== 2 || logs.length !== 1) throw new Error('Stage catch contract did not recover');
  if (patched.slice(0, start) + original + patched.slice(start + replacement.length) !== code) throw new Error('Unowned catch bytes changed');
  return { code: patched, evidence: { line: source.getLineAndCharacterOfPosition(start).line + 1,
    errorArgumentsBefore: 3, errorArgumentsAfter: 2, failureLogsAfter: 1, original, replacement, reverseRestoresOriginalBytes: true } };
}

module.exports = { inspectRunStageCalls, assertRunStageCalls, repairModelSelectionStageCall, repairModelSelectionStageCatch };
