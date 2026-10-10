const path = require("node:path");
const workerThreads = require("node:worker_threads");
const { exportRuntimeVerificationCache, importRuntimeVerificationCache } = require("./runtime-install.cjs");

// The main process owns the process-lifetime hash grants; fresh workers receive and
// return them. Unchanged manifest/stat/realpath fingerprints skip file-content reads.
// An in-place edit preserving size and mtime remains undetected until launcher restart.
let verificationQueue = Promise.resolve();

function verificationRoots(task, options) {
  if (task === "validate") return [options.root];
  if (task !== "wait" && task !== "install") throw new Error("Unknown runtime verification operation");
  const source = path.join(options.resourcesPath, "runtime");
  if (task === "wait") return [source];
  if (task === "install") return [source,
    path.join(options.coreHome, "versions", `${options.version}-${process.platform}-${process.arch}`)];
}

function verifyRuntimeInWorker(task, options) {
  // Only construct a worker after its predecessor returns its fingerprints. This also
  // prevents concurrent installation transactions and duplicate first-pass hashes.
  const operation = verificationQueue.then(() => runVerificationWorker(task, options, verificationRoots(task, options)));
  verificationQueue = operation.catch(() => {});
  return operation;
}

function runVerificationWorker(task, options, roots) {
  const cache = exportRuntimeVerificationCache(roots);
  return new Promise((resolve, reject) => {
    const worker = new workerThreads.Worker(path.join(__dirname, "runtime-verification-worker.cjs"), { workerData: { task, options, roots, cache } });
    let outcome;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      importRuntimeVerificationCache(roots, outcome?.cache ?? [], cache);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      void worker.terminate();
      finish(new Error("Runtime verification worker exceeded its two-minute budget"));
    }, 120_000);
    worker.once("message", message => { outcome = message; });
    worker.once("error", error => finish(error));
    worker.once("exit", code => {
      if (code !== 0 || !outcome) finish(new Error("Runtime verification worker did not complete"));
      else if (!outcome.ok) finish(new Error(outcome.error));
      else finish(null, outcome.value);
    });
  });
}

module.exports = { verifyRuntimeInWorker };
