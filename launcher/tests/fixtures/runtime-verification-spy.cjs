// Loaded only by tests into a real verification worker. Count operations, never contents.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { parentPort, workerData } = require("node:worker_threads");
const counts = { fileReads: 0, manifestReads: 0, hashes: 0, stats: 0 };
// The fallback also instruments the installed baseline worker, which predates cache IPC.
const requestedRoots = workerData.roots ?? (workerData.task === "validate"
  ? [workerData.options.root] : [path.join(workerData.options.resourcesPath, "runtime")]);
const roots = workerData.task === "install"
  ? [requestedRoots[0], path.join(workerData.options.coreHome, "versions")] : requestedRoots;
const belongs = filename => roots.some(root => path.resolve(String(filename)).startsWith(`${path.resolve(root)}${path.sep}`));
const originalRead = fs.readFileSync, originalStat = fs.statSync, originalHash = crypto.createHash;
fs.readFileSync = (filename, ...args) => {
  if (belongs(filename)) counts[path.basename(String(filename)) === "manifest.json" ? "manifestReads" : "fileReads"]++;
  return originalRead(filename, ...args);
};
fs.statSync = (filename, ...args) => {
  if (belongs(filename)) counts.stats++;
  return originalStat(filename, ...args);
};
crypto.createHash = (...args) => {
  counts.hashes++;
  return originalHash(...args);
};
const originalPost = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = message => originalPost({ ...message, verificationCounts: counts });
