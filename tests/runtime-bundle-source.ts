import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// CLI code can live in hashed chunks after command splitting. This is only an
// AST fixture: it is never evaluated as a concatenated JavaScript module.
export function readRuntimeBundleSource(root: string, relative: string): string {
  const entries = [relative];
  if (relative === "app/cli.js") {
    entries.push(...readdirSync(join(root, "app"))
      .filter(name => /^chunk-[\w-]+\.js$/.test(name)).sort()
      .map(name => `app/${name}`));
  }
  return entries.map(entry => readFileSync(join(root, entry), "utf8")).join("\n;\n");
}
