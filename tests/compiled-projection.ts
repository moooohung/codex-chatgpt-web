import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

/** Follow the entry's static and literal dynamic imports, never unrelated bundles. */
export function compiledSubmissionProjection(runtime: string, entry: string): string {
  const app = resolve(runtime, "app");
  const pending = [resolve(runtime, entry)];
  const seen = new Set<string>();
  const projections: string[] = [];
  while (pending.length) {
    const path = pending.pop()!;
    const within = relative(app, path);
    if (within.startsWith("..") || resolve(app, within) !== path) throw Error("Compiled import escapes its app");
    if (seen.has(path)) continue;
    seen.add(path);
    const source = readFileSync(path, "utf8");
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const statement of tree.statements) {
      if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
        && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        && statement.moduleSpecifier.text.startsWith(".")) {
        pending.push(resolve(dirname(path), statement.moduleSpecifier.text));
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
        && node.arguments[0].text.startsWith(".")) {
        pending.push(resolve(dirname(path), node.arguments[0].text));
      }
      if (ts.isFunctionDeclaration(node) && node.body) {
        const body = node.body.getText(tree);
        if (body.includes("duplicate conversation turn identities") && body.includes("bodyTextChars")) {
          projections.push(node.getText(tree));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  if (projections.length !== 1) throw Error(`Expected one compiled submission projection for ${entry}, found ${projections.length}`);
  return projections[0]!;
}
