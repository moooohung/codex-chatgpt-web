// Stage application code from app.asar; never read browser profiles or install/launch.
// Packaging tool pin: @electron/asar 4.3.1 (latest stable registry check, 2026-10-10).
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");

const replacements = ["runtime-install.cjs", "runtime-verification.cjs", "runtime-verification-worker.cjs"];
const mitigations = ["browser-host.cjs", "main.cjs"];
const hash = content => createHash("sha256").update(content).digest("hex");

async function stage(installedArchive, sourceRoot, output, asarModule) {
  output = path.resolve(output);
  const forbidden = [
    path.join(process.env.LOCALAPPDATA, "Programs", "Codex Web GPT"),
    path.join(process.env.APPDATA, "Codex Web GPT"),
  ];
  const inside = (candidate, root) => candidate.toLowerCase() === root.toLowerCase()
    || candidate.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`);
  if (forbidden.some(root => inside(output, root)) || fs.existsSync(output)) {
    throw new Error("Output must be a new directory outside the installed app and userData");
  }
  if (path.basename(installedArchive) !== "app.asar") throw new Error("Input must be the installed code archive app.asar");
  const toolPackage = JSON.parse(fs.readFileSync(path.join(path.dirname(asarModule), "..", "package.json"), "utf8"));
  if (toolPackage.name !== "@electron/asar" || toolPackage.version !== "4.3.1") throw new Error("Use pinned @electron/asar 4.3.1");
  const asar = await import(pathToFileURL(asarModule).href);
  const archivePath = file => file.split("/").join(path.sep);
  const installedSha256 = hash(fs.readFileSync(installedArchive));
  fs.mkdirSync(output, { recursive: true });
  const baseline = path.join(output, "installed-app.asar");
  fs.copyFileSync(installedArchive, baseline);
  if (fs.existsSync(`${installedArchive}.unpacked`)) fs.cpSync(`${installedArchive}.unpacked`, `${baseline}.unpacked`, { recursive: true });
  if (hash(fs.readFileSync(baseline)) !== installedSha256) throw new Error("Installed archive changed during snapshot");
  const baselineFiles = asar.listPackage(baseline).map(file => file.replace(/^[/\\]/, "").replaceAll("\\", "/")).sort();
  const unpacked = baselineFiles.filter(file => asar.statFile(baseline, archivePath(file)).unpacked && !asar.statFile(baseline, archivePath(file)).files);
  if (baselineFiles.some(file => asar.statFile(baseline, archivePath(file), false).link)) throw new Error("Review archive links before staging");
  if (unpacked.some(file => !/^[a-zA-Z0-9/._-]+$/.test(file))) throw new Error("Review unpacked glob names before staging");
  const code = path.join(output, "app-code");
  asar.extractAll(baseline, code);
  for (const file of mitigations) {
    const installed = fs.readFileSync(path.join(code, "electron", file));
    const source = fs.readFileSync(path.join(sourceRoot, "launcher", "electron", file));
    if (!installed.equals(source)) throw new Error(`Packet 146 source differs from installed code: ${file}`);
  }
  for (const file of replacements) {
    const destination = path.join(code, "electron", file);
    fs.copyFileSync(path.join(sourceRoot, "launcher", "electron", file), destination);
    execFileSync(process.execPath, ["--check", destination], { stdio: "pipe" });
  }
  const candidate = path.join(output, "app.asar");
  await asar.createPackageWithOptions(code, candidate, unpacked.length
    ? { unpack: unpacked.length === 1 ? unpacked[0] : `{${unpacked.join(",")}}` } : {});
  const candidateFiles = asar.listPackage(candidate).map(file => file.replace(/^[/\\]/, "").replaceAll("\\", "/")).sort();
  if (JSON.stringify(baselineFiles) !== JSON.stringify(candidateFiles)) throw new Error("Archive membership changed");
  const differences = [];
  for (const file of baselineFiles) {
    const before = asar.statFile(baseline, archivePath(file)), after = asar.statFile(candidate, archivePath(file));
    if (Boolean(before.unpacked) !== Boolean(after.unpacked)
      || Boolean(before.executable) !== Boolean(after.executable)) throw new Error(`Archive layout changed: ${file}`);
    if (before.files) continue;
    const beforeHash = hash(asar.extractFile(baseline, archivePath(file))), afterHash = hash(asar.extractFile(candidate, archivePath(file)));
    if (beforeHash !== afterHash) differences.push({ file, before_sha256: beforeHash, after_sha256: afterHash,
      before_size: before.size, after_size: after.size });
  }
  if (JSON.stringify(differences.map(entry => entry.file).sort()) !== JSON.stringify(replacements.map(file => `electron/${file}`).sort())) {
    throw new Error("Archive differences exceed the three intended runtime files");
  }
  if (hash(fs.readFileSync(installedArchive)) !== installedSha256) throw new Error("Installed baseline changed while staging");
  const receipt = { installed_archive: installedArchive, installed_sha256: installedSha256,
    packaged_asar: candidate, packaged_sha256: hash(fs.readFileSync(candidate)),
    packaging_tool: "@electron/asar@4.3.1", entry_count: baselineFiles.length,
    file_count: baselineFiles.filter(file => !asar.statFile(baseline, archivePath(file)).files).length,
    unpacked_files: unpacked, differences, packet146_mitigations_byte_identical: mitigations,
    installed_archive_preserved: true, app_launched: false };
  fs.writeFileSync(path.join(output, "asar-diff.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (require.main === module) {
  if (process.argv.length !== 6) throw new Error("Usage: node packet148-stage-installed.cjs INSTALLED_APP_ASAR SOURCE_ROOT NEW_OUTPUT ASAR_LIB_JS");
  stage(...process.argv.slice(2)).then(receipt => console.log(JSON.stringify(receipt, null, 2))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
module.exports = { stage };
