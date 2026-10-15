// Exercise the packaged startup/command worker path using code-only fixture storage.
// Worker spies report operation counts; no command or app is launched.
const fs = require("node:fs");
const path = require("node:path");
const workerThreads = require("node:worker_threads");

async function measure(moduleDirectory, resourcesPath, coreHome, preload, outputFile) {
  coreHome = path.resolve(coreHome);
  const forbidden = [path.join(process.env.LOCALAPPDATA, "Programs", "Codex Web GPT"),
    path.join(process.env.APPDATA, "Codex Web GPT")];
  if (fs.existsSync(coreHome) || forbidden.some(root => coreHome.toLowerCase() === root.toLowerCase()
    || coreHome.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`))) throw new Error("Use a new isolated probe home");
  const manifest = JSON.parse(fs.readFileSync(path.join(resourcesPath, "runtime", "manifest.json"), "utf8"));
  const steps = [];
  const OriginalWorker = workerThreads.Worker;
  workerThreads.Worker = class extends OriginalWorker {
    constructor(filename, options) {
      super(filename, { ...options, execArgv: ["--require", preload] });
      this.on("message", message => steps.push({ task: options.workerData.task, ...message.verificationCounts }));
    }
  };
  try {
    const { verifyRuntimeInWorker } = require(path.join(moduleDirectory, "runtime-verification.cjs"));
    const { runtimeInvocationAsync } = require(path.join(moduleDirectory, "runtime-command.cjs"));
    await verifyRuntimeInWorker("wait", { version: manifest.appVersion, resourcesPath });
    const installedRuntimeRoot = await verifyRuntimeInWorker("install", { version: manifest.appVersion, resourcesPath, coreHome });
    const app = { isPackaged: true, getVersion: () => manifest.appVersion };
    for (const args of [["serve"], ["relay", "connect"], ["doctor"]]) {
      await runtimeInvocationAsync({ app, installedRuntimeRoot, args });
    }
  } finally { workerThreads.Worker = OriginalWorker; }
  const result = { module_directory: moduleDirectory, resources_path: resourcesPath, core_home: coreHome,
    runtime_file_count: manifest.files.length, steps,
    scope: "Real fresh worker startup wait/install and async invocation construction on actual runtime code in an isolated destination; no app/runtime process launched" };
  fs.writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
}
if (require.main === module) {
  if (process.argv.length !== 7) throw new Error("Usage: node packet148-count-workers.cjs MODULE_DIRECTORY RESOURCES_PATH NEW_CORE_HOME PRELOAD OUTPUT_JSON");
  measure(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { measure };
