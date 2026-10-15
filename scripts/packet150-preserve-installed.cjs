// Preserve code-only local patches in the installed baseline while replacing Packet 150 scopes.
// Tool pin: acorn@8.19.0 (official registry and Context7 checked 2026-10-10).
const fs = require("node:fs"), path = require("node:path"), { createHash } = require("node:crypto");
const hash = text => createHash("sha256").update(text).digest("hex");

function preserve(baseline, installed, candidate, acorn) {
  const parse = code => {
    const tokens = [], scopes = [];
    const file = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", onToken: tokens });
    const wrap = n => ({ ...n, getStart: () => n.start, getText: () => code.slice(n.start, n.end),
      name: (n.key || n.id)?.name ? { getText: () => (n.key || n.id).name } : undefined, tokens });
    const visit = n => {
      if (!n || typeof n.type !== "string") return;
      if (n.type === "MethodDefinition" || n.type === "FunctionDeclaration") scopes.push(wrap(n));
      for (const v of Object.values(n)) { if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v === "object") visit(v); }
    };
    visit(file); return { file, scopes, code };
  };
  const a = parse(baseline), b = parse(installed), c = parse(candidate);
  if (a.scopes.length !== b.scopes.length) throw new Error("Installed baseline scope membership changed; review before packaging");
  const leaves = n => {
    let lo = 0, hi = n.tokens.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (n.tokens[mid].start < n.start) lo = mid + 1; else hi = mid; }
    const result = [];
    for (let i = lo; i < n.tokens.length && n.tokens[i].end <= n.end; i++) {
      const token = n.tokens[i]; if (token.start >= n.end) break;
      const code = n.getText();
      result.push({ kind: token.type.label, end: token.end, getStart: () => token.start,
        getText: () => code.slice(token.start - n.start, token.end - n.start) });
    }
    return result;
  };
  const isIdentifier = n => n.kind === "name";
  const signature = n => hash(leaves(n).map(x => x.kind + ":" + (isIdentifier(x) ? "identifier" : x.getText())).join("\n"));
  const candidates = new Map();
  for (const n of c.scopes) { const key = signature(n); candidates.set(key, [...(candidates.get(key) || []), n]); }
  const rewrite = (old, local, target) => {
    const before = leaves(old), after = leaves(target), mapping = new Map();
    if (before.length !== after.length) throw new Error("Unreviewed scope shape");
    for (let i = 0; i < before.length; i++) {
      if (!isIdentifier(before[i])) continue;
      const from = before[i].getText(), to = after[i].getText();
      if (mapping.has(from) && mapping.get(from) !== to) throw new Error(`Ambiguous identifier mapping: ${from}`);
      mapping.set(from, to);
    }
    let text = local.getText();
    const start = local.getStart();
    for (const n of leaves(local).filter(isIdentifier).reverse()) {
      const replacement = mapping.get(n.getText());
      if (replacement) text = text.slice(0, n.getStart() - start) + replacement + text.slice(n.end - start);
    }
    return text;
  };
  const differences = [], reconstruction = [], edits = [];
  for (let i = 0; i < a.scopes.length; i++) {
    const old = a.scopes[i], local = b.scopes[i];
    if (old.getText() === local.getText()) continue;
    const name = old.name?.getText();
    reconstruction.push({ start: old.getStart(), end: old.end, text: local.getText() });
    const owned = name === "selectModelAndEffort" || name === "assertSelectedEffort";
    differences.push({ baselineScope: i, name, installed_sha256: hash(local.getText()), disposition: owned ? "packet150" : "preserved" });
    if (owned) continue;
    const found = candidates.get(signature(old));
    if (found?.length !== 1) throw new Error(`Installed patch scope is no longer unchanged or unique: ${name}`);
    edits.push({ start: found[0].getStart(), end: found[0].end, text: rewrite(old, local, found[0]) });
  }
  const apply = (code, changes) => {
    const ordered = changes.sort((x, y) => y.start - x.start);
    let last = code.length;
    for (const e of ordered) { if (e.end > last) throw new Error("Overlapping preservation edits"); last = e.start; code = code.slice(0, e.start) + e.text + code.slice(e.end); }
    return code;
  };
  // This byte equality proves the inventory covers EVERY installed baseline edit.
  if (apply(baseline, reconstruction) !== installed) throw new Error("Installed baseline has unaccounted changes outside reviewed scopes");
  const assertMethod = c.scopes.filter(n => n.name?.getText() === "assertSelectedEffort");
  if (assertMethod.length !== 1) throw new Error("Expected exactly one Packet 150 effort verifier");
  const source = assertMethod[0].getText();
  // Keep the installed origin-only initial guard; Packet 150 still performs the
  // existing exact URL/closed-label check after its final picker verification.
  const guard = /([a-zA-Z_$][\w$]*)\.url\(\)!==([a-zA-Z_$][\w$]*)\.selection\.url/;
  const match = guard.exec(source);
  if (!match) throw new Error("Effort verifier URL guard changed");
  const start = assertMethod[0].getStart() + match.index;
  edits.push({ start, end: start + match[0].length,
    text: `new URL(${match[1]}.url()).origin!==new URL(${match[2]}.selection.url).origin` });
  const result = apply(candidate, edits);
  parse(result);
  return { code: result, evidence: { baseline_reconstruction_byte_identical: true, baseline_sha256: hash(baseline),
    installed_sha256: hash(installed), source_build_sha256: hash(candidate), packaged_sha256: hash(result), scopes: differences } };
}

function writeManifest(runtime) {
  const manifestPath = path.join(runtime, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const item of manifest.files) { const content = fs.readFileSync(path.join(runtime, item.path)); item.size = content.length; item.sha256 = hash(content); }
  const digest = createHash("sha256");
  for (const item of manifest.files) {
    digest.update(item.path); digest.update("\0"); digest.update(String(item.size)); digest.update("\0");
    digest.update(item.sha256); digest.update("\0");
  }
  manifest.bundleId = digest.digest("hex");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (require.main === module) {
  const [baselineRoot, installedRoot, candidateRoot, toolingRoot, receipt] = process.argv.slice(2);
  const acorn = require(path.join(toolingRoot, "acorn"));
  if (acorn.version !== "8.19.0") throw new Error("Use Acorn 8.19.0");
  const results = {};
  const expected = { "cli.js": "8b8f0f67c0d9a9b7f79b70deef69ea0b406a7af3f3837af4c2b23b897f6f8a7b",
    "browser-helper.cjs": "6f6feac549a30773dfd03c03a72d8f2ba09d81fd11443cbc046c45f10fba3d72" };
  for (const file of ["cli.js", "browser-helper.cjs"]) {
    const read = root => fs.readFileSync(path.join(root, "app", file), "utf8");
    if (hash(read(installedRoot)) !== expected[file]) throw new Error(`Installed ${file} changed; review its baseline before packaging`);
    const result = preserve(read(baselineRoot), read(installedRoot), read(candidateRoot), acorn);
    fs.writeFileSync(path.join(candidateRoot, "app", file), result.code);
    results[file] = result.evidence;
  }
  writeManifest(candidateRoot);
  fs.writeFileSync(receipt, `${JSON.stringify(results, null, 2)}\n`);
  console.log("Preserved installed patches; baseline reconstruction is byte-identical for both bundles");
}
module.exports = { preserve, writeManifest };
