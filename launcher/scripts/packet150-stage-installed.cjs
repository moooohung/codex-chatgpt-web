// Code-only staging. Never open profiles, backups, cookies, tokens, or browser storage.
// Tool pin: @electron/asar@4.3.1, current stable registry check 2026-10-10.
const fs = require("node:fs"), path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");
const { validateRuntimeBundle } = require("../electron/runtime-install.cjs");
const hash = data => createHash("sha256").update(data).digest("hex");
const sha = file => hash(fs.readFileSync(file));
const modules = ["runtime-install.cjs", "runtime-verification.cjs", "runtime-verification-worker.cjs",
  "main.cjs", "control-server.cjs", "state.cjs", "effort-ceiling.cjs"];

async function stage(installedRoot, sourceRoot, runtime, output, asarModule) {
  installedRoot = fs.realpathSync(installedRoot); output = path.resolve(output);
  const inside = (p, root) => p.toLowerCase() === root.toLowerCase() || p.toLowerCase().startsWith(root.toLowerCase() + path.sep);
  if (inside(output, installedRoot) || inside(output, path.join(process.env.APPDATA, "Codex Web GPT")) || fs.existsSync(output)) {
    throw new Error("Use a new output directory outside the installed app and profiles");
  }
  const asar = await import(pathToFileURL(asarModule).href);
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(asarModule), "..", "package.json"), "utf8"));
  if (pkg.version !== "4.3.1" || pkg.name !== "@electron/asar") throw new Error("Use pinned @electron/asar 4.3.1");
  fs.mkdirSync(output, { recursive: true });
  const baseline = path.join(output, "installed-app.asar"), installed = path.join(installedRoot, "resources", "app.asar");
  const installedSha = sha(installed);
  fs.copyFileSync(installed, baseline);
  const names = archive => asar.listPackage(archive).map(f => f.replace(/^[/\\]/, "").replaceAll("\\", "/")).sort();
  const key = f => f.split("/").join(path.sep);
  const files = archive => names(archive).filter(f => !asar.statFile(archive, key(f)).files);
  if (files(baseline).some(f => asar.statFile(baseline, key(f)).unpacked || asar.statFile(baseline, key(f)).link)) {
    throw new Error("Review unpacked entries/links before packaging");
  }
  const appCode = path.join(output, "app-code");
  asar.extractAll(baseline, appCode);
  const localeSource = fs.readFileSync(path.join(sourceRoot, "launcher/electron/browser-host.cjs"));
  if (!localeSource.equals(asar.extractFile(baseline, key("electron/browser-host.cjs")))) throw new Error("Packet 146 locale guard source differs from installed");
  const main = fs.readFileSync(path.join(sourceRoot, "launcher/electron/main.cjs"), "utf8");
  if (!main.includes('appendSwitch("disable-http-cache")')) throw new Error("Packet 146 cache mitigation is missing");
  for (const file of modules) fs.copyFileSync(path.join(sourceRoot, "launcher/electron", file), path.join(appCode, "electron", file));
  // Renderer baseline was independently rebuilt and matched all five installed files.
  const dist = path.resolve(appCode, "dist");
  if (!inside(dist, appCode)) throw new Error("Renderer path escaped the staged archive");
  fs.rmSync(dist, { recursive: true, force: true });
  fs.cpSync(path.join(sourceRoot, "launcher/dist"), dist, { recursive: true });
  const unpacked = path.join(output, "win-unpacked"), resources = path.join(unpacked, "resources");
  fs.mkdirSync(resources, { recursive: true });
  // Installed directories also contain passkey/profile backups. Only these Electron
  // distribution files and locales are eligible; never copy the installed root wholesale.
  const electronFiles = ["Codex Web GPT.exe", "chrome_100_percent.pak", "chrome_200_percent.pak", "d3dcompiler_47.dll",
    "dxcompiler.dll", "dxil.dll", "ffmpeg.dll", "icudtl.dat", "libEGL.dll", "libGLESv2.dll", "LICENSE.electron.txt",
    "LICENSES.chromium.html", "resources.pak", "snapshot_blob.bin", "v8_context_snapshot.bin", "vk_swiftshader.dll",
    "vk_swiftshader_icd.json", "vulkan-1.dll"];
  for (const file of electronFiles) fs.copyFileSync(path.join(installedRoot, file), path.join(unpacked, file));
  fs.cpSync(path.join(installedRoot, "locales"), path.join(unpacked, "locales"), { recursive: true });
  if (fs.existsSync(path.join(installedRoot, "resources/elevate.exe"))) {
    fs.copyFileSync(path.join(installedRoot, "resources/elevate.exe"), path.join(resources, "elevate.exe"));
  }
  const candidate = path.join(resources, "app.asar");
  await asar.createPackageWithOptions(appCode, candidate, {});
  fs.cpSync(runtime, path.join(resources, "runtime"), { recursive: true });
  const identity = { version: "6.1.7", platform: "win32", arch: "x64" };
  validateRuntimeBundle(path.join(resources, "runtime"), identity);
  validateRuntimeBundle(path.join(installedRoot, "resources/runtime"), identity);
  const before = files(baseline), after = files(candidate), differences = [];
  for (const file of [...new Set([...before, ...after])].sort()) {
    const x = before.includes(file) ? asar.extractFile(baseline, key(file)) : null;
    const y = after.includes(file) ? asar.extractFile(candidate, key(file)) : null;
    if (x && y && x.equals(y)) continue;
    if (!modules.map(f => `electron/${f}`).includes(file) && !/^dist\/(?:index\.html|assets\/index-[\w-]+\.js)$/.test(file)) {
      throw new Error(`Unexpected ASAR difference: ${file}`);
    }
    differences.push({ file, before_sha256: x ? hash(x) : null, after_sha256: y ? hash(y) : null,
      before_size: x?.length ?? null, after_size: y?.length ?? null });
  }
  const installedRuntime = path.join(installedRoot, "resources/runtime");
  const manifest = JSON.parse(fs.readFileSync(path.join(resources, "runtime/manifest.json"), "utf8"));
  const oldManifest = JSON.parse(fs.readFileSync(path.join(installedRuntime, "manifest.json"), "utf8"));
  if (JSON.stringify(manifest.files.map(f => f.path)) !== JSON.stringify(oldManifest.files.map(f => f.path))) throw new Error("Runtime membership changed");
  const runtimeDiff = [];
  for (const entry of manifest.files) {
    const x = sha(path.join(installedRuntime, entry.path)), y = sha(path.join(resources, "runtime", entry.path));
    if (x === y) continue;
    if (!["app/cli.js", "app/browser-helper.cjs"].includes(entry.path)) throw new Error(`Unexpected runtime difference: ${entry.path}`);
    runtimeDiff.push({ file: entry.path, before_sha256: x, after_sha256: y });
  }
  runtimeDiff.push({ file: "manifest.json", before_sha256: sha(path.join(installedRuntime, "manifest.json")),
    after_sha256: sha(path.join(resources, "runtime/manifest.json")) });
  if (sha(installed) !== installedSha) throw new Error("Installed archive changed during staging");
  const receipt = { installed_archive: installed, installed_sha256: installedSha, packaged_asar: candidate,
    packaged_sha256: sha(candidate), packaged_app: unpacked, runtime_bundle_id: manifest.bundleId,
    asar_files_compared: new Set([...before, ...after]).size,
    asar_baseline_file_count: before.length, asar_candidate_file_count: after.length,
    asar_differences: differences,
    runtime_files_compared: manifest.files.length, runtime_differences: runtimeDiff,
    preserved_electron_files: electronFiles, packet146_locale_byte_identical: true, packet146_disable_http_cache_present: true,
    installed_archive_preserved: true, app_installed: false, running_app_stopped: false };
  fs.writeFileSync(path.join(output, "package-diff.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
  return receipt;
}
if (require.main === module) stage(...process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { stage };
