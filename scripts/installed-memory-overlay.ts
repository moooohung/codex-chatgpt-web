/** Preserve locally installed runtime patches while applying only the verified RAM policy. */
import ts from "typescript";
import { resolveMaxChatGptBrowserTabs, DEFAULT_MAX_CHATGPT_BROWSER_TABS, MAX_CHATGPT_BROWSER_TURN_SESSIONS } from "../src/adapters/chatgpt-web/concurrency";

type Edit = { start: number; end: number; replacement: string; kind: string };
export function memoryOverlay(code: string, filename: string, hasRegistry: boolean) {
  const source = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if ((source as any).parseDiagnostics.length) throw new Error(`Cannot parse installed ${filename}`);
  const classes: ts.ClassLikeDeclaration[] = [];
  const methods: ts.MethodDeclaration[] = [];
  function visit(node: ts.Node) {
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node))
      && node.getText(source).includes('"Invalid browser concurrency capacity"')) classes.push(node);
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === "getOrCreate"
      && node.getText(source).includes("simultaneous browser turns")) methods.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (classes.length !== 1 || methods.length !== (hasRegistry ? 1 : 0)) {
    throw new Error(`Unrecognized installed admission logic in ${filename}; refusing a guessed patch`);
  }
  const queue = classes[0]!;
  const ctor = queue.members.find(ts.isConstructorDeclaration)!;
  const parameter = ctor?.parameters[0]?.initializer;
  if (!parameter || parameter.getText(source) !== "8") throw new Error("Installed queue default is not the audited eight-tab baseline");
  const resolver = `(()=>{const DEFAULT_MAX_CHATGPT_BROWSER_TABS=${DEFAULT_MAX_CHATGPT_BROWSER_TABS};return (${resolveMaxChatGptBrowserTabs.toString()})();})()`;
  const edits: Edit[] = [{start: parameter.getStart(source), end: parameter.end, replacement: resolver, kind: "queue_default"}];
  if (hasRegistry) {
    const method = methods[0]!;
    const guard = method.body?.statements.find(statement => ts.isIfStatement(statement)
      && statement.thenStatement.getText(source).includes("simultaneous browser turns")) as ts.IfStatement | undefined;
    if (!guard || !ts.isBinaryExpression(guard.expression)
      || guard.expression.operatorToken.kind !== ts.SyntaxKind.GreaterThanEqualsToken) {
      throw new Error("Installed session admission guard differs from the audited baseline");
    }
    const limit = guard.expression.right;
    edits.push({start: limit.getStart(source), end: limit.end, replacement: String(MAX_CHATGPT_BROWSER_TURN_SESSIONS), kind: "session_limit"});
    const message = `ChatGPT Web supports at most ${MAX_CHATGPT_BROWSER_TURN_SESSIONS} active or queued turns; wait for a pending turn to finish before starting another`;
    let template: ts.TemplateExpression | undefined;
    const findTemplate = (node: ts.Node) => {
      if (ts.isTemplateExpression(node) && node.head.text.startsWith("ChatGPT Web supports at most ")) template = node;
      ts.forEachChild(node, findTemplate);
    };
    findTemplate(guard.thenStatement);
    if (!template) throw new Error("Installed backlog error message was not found");
    edits.push({start: template.getStart(source), end: template.end, replacement: JSON.stringify(message), kind: "session_limit_message"});
  }
  let patched = code;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    patched = patched.slice(0, edit.start) + edit.replacement + patched.slice(edit.end);
  }
  const parsed = ts.createSourceFile(filename, patched, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if ((parsed as any).parseDiagnostics.length) throw new Error(`Patched ${filename} does not parse`);
  // Prove that replacing precisely the declared spans reverses the overlay byte-for-byte.
  let reversed = patched;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    reversed = reversed.slice(0, edit.start) + code.slice(edit.start, edit.end) + reversed.slice(edit.start + edit.replacement.length);
  }
  if (reversed !== code) throw new Error("Overlay touched undeclared bytes");
  return { code: patched, edits: edits.map(e => ({...e, original: code.slice(e.start, e.end)})),
    queueClassName: queue.name?.text, registryMethodName: methods[0]?.name.getText(source) };
}
