// Read-only runtime verification measurements plus an isolated code-only install.
// Run in a new Node process per baseline/candidate scenario; never launch the app.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");

async function measure(moduleDirectory, resourcesPath, coreHome, scenario, outputFile) {
  if (!["existing", "fresh"].includes(scenario)) throw new Error("Use existing or fresh scenario");
  const source = path.join(resourcesPath, "runtime");
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
  const destination = path.join(coreHome, "versions", `${manifest.appVersion}-${process.platform}-${process.arch}`);
  const forbidden = [path.join(process.env.LOCALAPPDATA, "Programs", "Codex Web GPT"),
    path.join(process.env.APPDATA, "Codex Web GPT")];
  if (forbidden.some(root => coreHome.toLowerCase() === root.toLowerCase()
    || coreHome.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`))) throw new Error("Probe destination must be outside installed app and userData");
  if (fs.existsSync(coreHome)) throw new Error("Probe home must be a new directory");
  if (scenario === "existing") {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
  }
  const counts = { manifest_reads: 0, file_reads: 0, file_bytes: 0, hash_calls: 0, stat_calls: 0, realpath_calls: 0 };
  const originalRead = fs.readFileSync, originalStat = fs.statSync,
    originalRealpath = fs.realpathSync.native, originalHash = crypto.createHash;
  const inside = filename => [source, coreHome].some(root => String(filename).startsWith(`${root}${path.sep}`));
  fs.readFileSync = (filename, ...args) => {
    const result = originalRead(filename, ...args);
    if (inside(filename)) {
      if (path.basename(String(filename)) === "manifest.json") counts.manifest_reads++;
      else { counts.file_reads++; counts.file_bytes += Buffer.byteLength(result); }
    }
    return result;
  };
  fs.statSync = (filename, ...args) => {
    if (inside(filename)) counts.stat_calls++;
    return originalStat(filename, ...args);
  };
  fs.realpathSync.native = (filename, ...args) => {
    if (inside(filename) || String(filename) === source || String(filename) === coreHome) counts.realpath_calls++;
    return originalRealpath(filename, ...args);
  };
  crypto.createHash = (...args) => { counts.hash_calls++; return originalHash(...args); };
  const installer = require(path.join(moduleDirectory, "runtime-install.cjs"));
  const { runtimeInvocation } = require(path.join(moduleDirectory, "runtime-command.cjs"));
  const app = { isPackaged: true, getVersion: () => manifest.appVersion };
  const steps = [];
  const step = async (name, operation) => {
    for (const key of Object.keys(counts)) counts[key] = 0;
    const started = performance.now();
    const value = await operation();
    steps.push({ name, ...counts, elapsed_ms: Number((performance.now() - started).toFixed(3)) });
    return value;
  };
  try {
    await step("startup_wait", () => installer.waitForPackagedRuntimeSource({ app, resourcesPath }));
    const installedRuntimeRoot = await step("startup_install", () => installer.ensurePackagedRuntime({ app, resourcesPath, coreHome }));
    // Construct invocations only; no runtime command is spawned.
    for (const args of [["serve"], ["tunnel", "connect"], ["relay", "connect"], ["doctor"], ["cancel-turns"]]) {
      await step(`invocation_${args.join("_")}`, () => runtimeInvocation({ app, installedRuntimeRoot, args }));
    }
  } finally {
    fs.readFileSync = originalRead;
    fs.statSync = originalStat;
    fs.realpathSync.native = originalRealpath;
    crypto.createHash = originalHash;
  }
  const sum = selected => Object.fromEntries(Object.keys(counts).map(key => [key, selected.reduce((total, item) => total + item[key], 0)]));
  const result = { module_directory: moduleDirectory, resources_path: resourcesPath, core_home: coreHome,
    scenario, runtime_file_count: manifest.files.length, runtime_content_bytes: manifest.files.reduce((total, file) => total + file.size, 0),
    bundle_id: manifest.bundleId, steps, startup_total: sum(steps.slice(0, 2)), command_total: sum(steps.slice(2)),
    scope: "Node synchronous verification functions on actual installed runtime code, with an isolated destination; invocation construction only; no app or runtime process launched" };
  fs.writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ scenario, startup: result.startup_total, commands: result.command_total }));
}

if (require.main === module) {
  if (process.argv.length !== 7) throw new Error("Usage: node packet148-count-verification.cjs MODULE_DIRECTORY RESOURCES_PATH NEW_CORE_HOME existing|fresh OUTPUT_JSON");
  measure(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { measure };
