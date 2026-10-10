const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const crypto = require("node:crypto");
const workerThreads = require("node:worker_threads");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runtimeInvocation, runtimeInvocationAsync } = require("../electron/runtime-command.cjs");
const {
  ensurePackagedRuntime,
  exportRuntimeVerificationCache,
  importRuntimeVerificationCache,
  validateRuntimeBundle,
  waitForPackagedRuntimeSource,
} = require("../electron/runtime-install.cjs");
const { verifyRuntimeInWorker } = require("../electron/runtime-verification.cjs");

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function manifestFiles(source) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => comparePaths(left.name, right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(source, absolutePath).split(path.sep).join("/");
      if (relativePath === "manifest.json") continue;
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      const content = fs.readFileSync(absolutePath);
      files.push({
        path: relativePath,
        size: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  };
  visit(source);
  return files.sort((left, right) => comparePaths(left.path, right.path));
}

function bundleIdFor(files) {
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(String(file.size));
    digest.update("\0");
    digest.update(file.sha256);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function writeRuntimeManifest(source, version = "0.2.0") {
  const files = manifestFiles(source);
  fs.writeFileSync(path.join(source, "manifest.json"), `${JSON.stringify({
    schemaVersion: 2,
    appVersion: version,
    bundleId: bundleIdFor(files),
    bunVersion: "1.4.0",
    platform: process.platform,
    arch: process.arch,
    launcher: `bin/${process.platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web"}`,
    entrypoint: "app/cli.js",
    playwright: "1.62.0",
    files,
  })}\n`);
}

function runtimeFixture(root, version = "0.2.0") {
  const source = path.join(root, "resources", "runtime");
  const executable = path.join(source, "runtime", process.platform === "win32" ? "bun.exe" : "bun");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(path.join(source, "app"), { recursive: true });
  fs.writeFileSync(executable, "bun");
  if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
  fs.writeFileSync(path.join(source, "app", "cli.js"), "cli");
  fs.writeFileSync(path.join(source, "app", "browser-helper.cjs"), "helper");
  fs.mkdirSync(path.join(source, "app", "node_modules", "zod", "v4"), { recursive: true });
  fs.writeFileSync(path.join(source, "app", "node_modules", "zod", "v4", "index.js"), "zod-v4");
  if (process.platform !== "win32") {
    fs.mkdirSync(path.join(source, "app", "node_modules", ".bin"), { recursive: true });
    fs.symlinkSync("../zod/v4/index.js", path.join(source, "app", "node_modules", ".bin", "zod-v4"));
  }
  fs.mkdirSync(path.join(source, "app", "node_modules", "nested-dependency", "dist", "runtime"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "app", "node_modules", "nested-dependency", "dist", "runtime", "worker.js"),
    "nested-worker",
  );
  fs.mkdirSync(path.join(source, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "bin", process.platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web"),
    "launcher",
  );
  writeRuntimeManifest(source, version);
  return path.join(root, "resources");
}

test("packaged runtime is installed once into a durable versioned directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-install-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    assert.equal(installed, path.join(coreHome, "versions", `0.2.0-${process.platform}-${process.arch}`));
    assert.equal(fs.readFileSync(path.join(installed, "app", "cli.js"), "utf8"), "cli");
    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), installed);

    const invocation = runtimeInvocation({
      app,
      sourceRoot: root,
      installedRuntimeRoot: installed,
      args: ["serve"],
    });
    assert.equal(invocation.cwd, installed);
    assert.equal(invocation.args[0], path.join(installed, "app", "cli.js"));
    assert.equal(invocation.args[1], "serve");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cached dependency corruption of the same size is detected at validation and process start", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-hash-cache-"));
  try {
    const resourcesPath = runtimeFixture(root);
    const app = { isPackaged: true, getVersion: () => "0.2.0" };
    const coreHome = path.join(root, "home");
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    const manifest = JSON.parse(fs.readFileSync(path.join(installed, "manifest.json"), "utf8"));
    fs.writeFileSync(path.join(path.dirname(installed), ".codex-runtime-verification.json"), JSON.stringify({
      [path.basename(installed)]: { bundleId: manifest.bundleId, fileCount: manifest.files.length, verifiedAt: Date.now() },
    }));
    const dependency = path.join(installed, "app/node_modules/zod/v4/index.js");
    fs.writeFileSync(dependency, "BAD-V4");
    assert.throws(() => validateRuntimeBundle(installed, { version: "0.2.0", platform: process.platform, arch: process.arch }), /checksum mismatch/);
    assert.throws(() => runtimeInvocation({ app, sourceRoot: root, installedRuntimeRoot: installed, args: ["serve"] }), /checksum mismatch/);
    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), installed);
    assert.equal(fs.readFileSync(dependency, "utf8"), "zod-v4");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a parent-directory junction escaping the runtime is rejected despite matching file hashes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-junction-"));
  try {
    const resourcesPath = runtimeFixture(root);
    const source = path.join(resourcesPath, "runtime");
    const original = path.join(source, "app/node_modules/zod");
    const outside = path.join(root, "outside-zod");
    fs.renameSync(original, outside);
    fs.symlinkSync(outside, original, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => validateRuntimeBundle(source, { version: "0.2.0", platform: process.platform, arch: process.arch }), /escapes the bundle/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("packaged runtime installation rejects a platform or version mismatch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-mismatch-"));
  const resourcesPath = runtimeFixture(root, "0.1.0");
  try {
    assert.throws(
      () => ensurePackagedRuntime({
        app: { isPackaged: true, getVersion: () => "0.2.0" },
        coreHome: path.join(root, "core-home"),
        resourcesPath,
      }),
      /identity mismatch/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime rejects a missing executable before creating durable state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-missing-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const executable = path.join(
    resourcesPath,
    "runtime",
    "runtime",
    process.platform === "win32" ? "bun.exe" : "bun",
  );
  fs.rmSync(executable);
  try {
    assert.throws(
      () => ensurePackagedRuntime({
        app: { isPackaged: true, getVersion: () => "0.2.0" },
        coreHome,
        resourcesPath,
      }),
      /Runtime bundle file is missing/,
    );
    assert.equal(fs.existsSync(coreHome), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const relativePath of [
  ["app", "node_modules", "zod", "v4", "index.js"],
  ["app", "node_modules", "nested-dependency", "dist", "runtime", "worker.js"],
]) {
  test(`packaged runtime rejects a missing nested dependency: ${relativePath.join("/")}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-dependency-"));
    const resourcesPath = runtimeFixture(root);
    const coreHome = path.join(root, "core-home");
    fs.rmSync(path.join(resourcesPath, "runtime", ...relativePath));
    try {
      assert.throws(
        () => ensurePackagedRuntime({
          app: { isPackaged: true, getVersion: () => "0.2.0" },
          coreHome,
          resourcesPath,
        }),
        /Runtime bundle file is missing/,
      );
      assert.equal(fs.existsSync(coreHome), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("packaged runtime rejects same-count content corruption", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-corrupt-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const dependency = path.join(resourcesPath, "runtime", "app", "node_modules", "zod", "v4", "index.js");
  fs.writeFileSync(dependency, "bad-v4");
  try {
    assert.throws(
      () => ensurePackagedRuntime({
        app: { isPackaged: true, getVersion: () => "0.2.0" },
        coreHome,
        resourcesPath,
      }),
      /checksum mismatch/,
    );
    assert.equal(fs.existsSync(coreHome), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime source wait accepts a delayed final dependency within its bound", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-delayed-"));
  const resourcesPath = runtimeFixture(root);
  const delayed = path.join(
    resourcesPath,
    "runtime",
    "app",
    "node_modules",
    "nested-dependency",
    "dist",
    "runtime",
    "worker.js",
  );
  const content = fs.readFileSync(delayed);
  fs.rmSync(delayed);
  const materialize = setTimeout(() => fs.writeFileSync(delayed, content), 40);
  try {
    assert.equal(
      await waitForPackagedRuntimeSource({
        app: { isPackaged: true, getVersion: () => "0.2.0" },
        resourcesPath,
        timeoutMs: 500,
        intervalMs: 10,
      }),
      path.join(resourcesPath, "runtime"),
    );
  } finally {
    clearTimeout(materialize);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime source wait fails closed when materialization exceeds its bound", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-timeout-"));
  const resourcesPath = runtimeFixture(root);
  fs.rmSync(path.join(resourcesPath, "runtime", "app", "node_modules", "zod", "v4", "index.js"));
  try {
    await assert.rejects(
      waitForPackagedRuntimeSource({
        app: { isPackaged: true, getVersion: () => "0.2.0" },
        resourcesPath,
        timeoutMs: 30,
        intervalMs: 5,
      }),
      /did not fully materialize within 30ms.*Runtime bundle file is missing/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime transactionally repairs an incomplete installed bundle", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-repair-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    const dependency = path.join(
      installed,
      "app",
      "node_modules",
      "nested-dependency",
      "dist",
      "runtime",
      "worker.js",
    );
    fs.rmSync(dependency);
    fs.writeFileSync(path.join(installed, "corrupt.partial"), "interrupted copy");

    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), installed);
    assert.equal(fs.readFileSync(dependency, "utf8"), "nested-worker");
    assert.equal(fs.existsSync(path.join(installed, "corrupt.partial")), false);
    assert.deepEqual(
      fs.readdirSync(path.dirname(installed)).filter(name => name.includes(".previous-") || name.includes(".tmp-")),
      [],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed candidate validation preserves the previous validated runtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-preserve-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  const originalCopy = fs.cpSync;
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    const source = path.join(resourcesPath, "runtime");
    fs.writeFileSync(path.join(source, "app", "cli.js"), "new cli");
    writeRuntimeManifest(source);

    fs.cpSync = (from, to, options) => {
      originalCopy(from, to, options);
      fs.rmSync(path.join(to, "app", "node_modules", "zod", "v4", "index.js"));
    };
    assert.throws(
      () => ensurePackagedRuntime({ app, coreHome, resourcesPath }),
      /Runtime bundle file is missing/,
    );
    assert.equal(fs.readFileSync(path.join(installed, "app", "cli.js"), "utf8"), "cli");
    assert.equal(
      validateRuntimeBundle(installed, {
        version: "0.2.0",
        platform: process.platform,
        arch: process.arch,
      }),
      installed,
    );
    assert.deepEqual(
      fs.readdirSync(path.dirname(installed)).filter(name => name.includes(".previous-") || name.includes(".tmp-")),
      [],
    );
  } finally {
    fs.cpSync = originalCopy;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime replaces stale files when a release is refreshed under the same version", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-refresh-"));
  const resourcesPath = runtimeFixture(root, "0.2.0");
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    fs.writeFileSync(path.join(installed, "old-release-marker"), "old");

    const source = path.join(resourcesPath, "runtime");
    fs.writeFileSync(path.join(source, "app", "cli.js"), "new cli");
    writeRuntimeManifest(source);

    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), installed);
    assert.equal(fs.readFileSync(path.join(installed, "app", "cli.js"), "utf8"), "new cli");
    assert.equal(fs.existsSync(path.join(installed, "old-release-marker")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("worker verification keeps the event loop live and rejects same-size corruption with changed metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-worker-"));
  const resourcesPath = runtimeFixture(root), source = path.join(resourcesPath, "runtime");
  const dependency = path.join(source, "app", "dependency.js");
  fs.writeFileSync(dependency, "original");
  writeRuntimeManifest(source);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    await verifyRuntimeInWorker("validate", { root: source, identity: { version: "0.2.0", platform: process.platform, arch: process.arch } });
    assert.ok(ticks > 0, "verification must not block the launcher event loop");
    fs.writeFileSync(dependency, "tampered");
    await assert.rejects(verifyRuntimeInWorker("validate", { root: source, identity: { version: "0.2.0", platform: process.platform, arch: process.arch } }), /checksum mismatch/);
  } finally { clearInterval(timer); fs.rmSync(root, { recursive: true, force: true }); }
});

function verificationSpies(t, roots) {
  const counts = { fileReads: 0, manifestReads: 0, hashes: 0, stats: 0 };
  const originalRead = fs.readFileSync, originalHash = crypto.createHash, originalStat = fs.statSync;
  const belongs = filename => roots.some(root => path.resolve(String(filename)).startsWith(`${path.resolve(root)}${path.sep}`));
  t.mock.method(fs, "readFileSync", (filename, ...args) => {
    if (belongs(filename)) counts[path.basename(String(filename)) === "manifest.json" ? "manifestReads" : "fileReads"]++;
    return originalRead(filename, ...args);
  });
  t.mock.method(crypto, "createHash", (...args) => {
    counts.hashes++;
    return originalHash(...args);
  });
  t.mock.method(fs, "statSync", (filename, ...args) => {
    if (belongs(filename)) counts.stats++;
    return originalStat(filename, ...args);
  });
  return { counts, reset: () => Object.keys(counts).forEach(key => { counts[key] = 0; }) };
}

const fixtureIdentity = { version: "0.2.0", platform: process.platform, arch: process.arch };

test("first validation reads and hashes every file; second reads only the manifest and stats", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-process-cache-"));
  try {
    const source = path.join(runtimeFixture(root), "runtime");
    const n = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8")).files.length;
    const { counts, reset } = verificationSpies(t, [source]);
    validateRuntimeBundle(source, fixtureIdentity);
    assert.deepEqual(counts, { fileReads: n, manifestReads: 1, hashes: n + 1, stats: n });
    reset();
    validateRuntimeBundle(source, fixtureIdentity);
    assert.deepEqual(counts, { fileReads: 0, manifestReads: 1, hashes: 0, stats: n });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const field of ["size", "mtimeMs", "mtimeNs", "ino", "dev", "mode"]) {
  test(`a changed ${field} fingerprint triggers a complete hash pass`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-fingerprint-"));
    try {
      const source = path.join(runtimeFixture(root), "runtime");
      const n = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8")).files.length;
      validateRuntimeBundle(source, fixtureIdentity);
      const { counts } = verificationSpies(t, [source]);
      const originalStat = fs.statSync;
      let changed = false;
      // Inject a metadata difference in the cache comparison, then return the real
      // metadata for the full pass. No content or manifest change can mask this trigger.
      t.mock.method(fs, "statSync", (filename, ...args) => {
        const metadata = originalStat(filename, ...args);
        if (!changed && String(filename).endsWith(`${path.sep}cli.js`)) {
          changed = true;
          metadata[field]++;
        }
        return metadata;
      });
      validateRuntimeBundle(source, fixtureIdentity);
      assert.ok(changed);
      assert.equal(counts.fileReads, n);
      assert.equal(counts.hashes, n + 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("an actual mtime-only change triggers a complete hash pass", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-mtime-"));
  try {
    const source = path.join(runtimeFixture(root), "runtime"), cli = path.join(source, "app", "cli.js");
    const n = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8")).files.length;
    validateRuntimeBundle(source, fixtureIdentity);
    const metadata = fs.statSync(cli);
    fs.utimesSync(cli, metadata.atime, new Date(metadata.mtimeMs + 2000));
    const { counts } = verificationSpies(t, [source]);
    validateRuntimeBundle(source, fixtureIdentity);
    assert.equal(counts.fileReads, n);
    assert.equal(counts.hashes, n + 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const mutation of ["size", "added", "removed", "manifest"]) {
  test(`a valid ${mutation} change invalidates the cache and hashes the entire new bundle`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-cache-change-"));
    try {
      const source = path.join(runtimeFixture(root), "runtime");
      validateRuntimeBundle(source, fixtureIdentity);
      if (mutation === "size") fs.writeFileSync(path.join(source, "app", "cli.js"), "new cli");
      if (mutation === "added") fs.writeFileSync(path.join(source, "app", "extra.js"), "extra");
      if (mutation === "removed") fs.rmSync(path.join(source, "app", "node_modules", "nested-dependency", "dist", "runtime", "worker.js"));
      if (mutation !== "manifest") writeRuntimeManifest(source);
      else fs.appendFileSync(path.join(source, "manifest.json"), "\n");
      const n = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8")).files.length;
      const { counts, reset } = verificationSpies(t, [source]);
      validateRuntimeBundle(source, fixtureIdentity);
      assert.equal(counts.fileReads, n);
      assert.equal(counts.hashes, n + 1);
      reset();
      validateRuntimeBundle(source, fixtureIdentity);
      assert.equal(counts.fileReads, 0);
      assert.equal(counts.hashes, 0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

for (const mutation of ["added", "removed"]) {
  test(`an unmanifested ${mutation} file fails full verification and evicts its previous grant`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-cache-tree-"));
    try {
      const source = path.join(runtimeFixture(root), "runtime");
      validateRuntimeBundle(source, fixtureIdentity);
      const filename = path.join(source, "app", mutation === "added" ? "extra.js" : "cli.js");
      const content = mutation === "removed" ? fs.readFileSync(filename) : null;
      mutation === "added" ? fs.writeFileSync(filename, "extra") : fs.rmSync(filename);
      const { counts, reset } = verificationSpies(t, [source]);
      assert.throws(() => validateRuntimeBundle(source, fixtureIdentity), mutation === "added" ? /unmanifested file/ : /file is missing/);
      assert.equal(counts.hashes, 1, "full verification validates the manifest before rejecting tree membership");
      assert.deepEqual(exportRuntimeVerificationCache([source]), []);
      mutation === "added" ? fs.rmSync(filename) : fs.writeFileSync(filename, content);
      reset();
      validateRuntimeBundle(source, fixtureIdentity);
      assert.ok(counts.fileReads > 0, "restoring the tree must not restore the evicted grant");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("a symlink escape introduced after verification is rejected and evicts the grant", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-cached-escape-"));
  try {
    const source = path.join(runtimeFixture(root), "runtime");
    validateRuntimeBundle(source, fixtureIdentity);
    const original = path.join(source, "app", "node_modules", "zod"), outside = path.join(root, "outside");
    fs.renameSync(original, outside);
    fs.symlinkSync(outside, original, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => validateRuntimeBundle(source, fixtureIdentity), /escapes the bundle/);
    assert.deepEqual(exportRuntimeVerificationCache([source]), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("install hashes the source and copied tree once each and reuses the renamed candidate", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-install-counts-"));
  try {
    const resourcesPath = runtimeFixture(root), source = path.join(resourcesPath, "runtime");
    const n = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8")).files.length;
    const app = { isPackaged: true, getVersion: () => "0.2.0" }, coreHome = path.join(root, "home");
    const { counts, reset } = verificationSpies(t, [source, path.join(coreHome, "versions")]);
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    assert.equal(counts.fileReads, 2 * n);
    assert.equal(counts.hashes, 2 * (n + 1));
    reset();
    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), installed);
    runtimeInvocation({ app, sourceRoot: root, installedRuntimeRoot: installed, args: ["doctor"] });
    assert.equal(counts.fileReads, 0);
    assert.equal(counts.hashes, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function workerVerificationSpies(t) {
  const results = [];
  const OriginalWorker = workerThreads.Worker;
  t.mock.method(workerThreads, "Worker", class extends OriginalWorker {
    constructor(filename, options) {
      super(filename, { ...options, execArgv: ["--require", path.join(__dirname, "fixtures", "runtime-verification-spy.cjs")] });
      this.on("message", message => results.push(message.verificationCounts));
    }
  });
  return results;
}

test("fresh workers share the main process cache with synchronous validation and concurrent requests", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-worker-counts-"));
  try {
    const source = path.join(runtimeFixture(root), "runtime");
    const n = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8")).files.length;
    const results = workerVerificationSpies(t);
    const options = { root: source, identity: fixtureIdentity };
    await Promise.all([verifyRuntimeInWorker("validate", options), verifyRuntimeInWorker("validate", options)]);
    assert.equal(results[0].fileReads, n);
    assert.equal(results[0].hashes, n + 1);
    assert.deepEqual(results[1], { fileReads: 0, manifestReads: 1, hashes: 0, stats: n });
    const { counts } = verificationSpies(t, [source]);
    validateRuntimeBundle(source, fixtureIdentity);
    assert.equal(counts.fileReads, 0);
    assert.equal(counts.hashes, 0);
    const cli = path.join(source, "app", "cli.js"), metadata = fs.statSync(cli);
    fs.utimesSync(cli, metadata.atime, new Date(metadata.mtimeMs + 2000));
    await verifyRuntimeInWorker("validate", options);
    assert.equal(results[2].fileReads, n);
    validateRuntimeBundle(source, fixtureIdentity);
    assert.equal(counts.fileReads, 0, "a worker's refreshed fingerprint must reach the main process");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("worker startup wait and install pass their cache to later runtime commands", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-worker-startup-"));
  try {
    const resourcesPath = runtimeFixture(root), source = path.join(resourcesPath, "runtime");
    const n = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8")).files.length;
    const results = workerVerificationSpies(t);
    await verifyRuntimeInWorker("wait", { version: "0.2.0", resourcesPath });
    const installed = await verifyRuntimeInWorker("install", { version: "0.2.0", resourcesPath, coreHome: path.join(root, "home") });
    const invocation = await runtimeInvocationAsync({ app: { isPackaged: true, getVersion: () => "0.2.0" }, installedRuntimeRoot: installed, args: ["doctor"] });
    assert.equal(invocation.cwd, installed);
    assert.equal(invocation.args[1], "doctor");
    assert.equal(results[0].fileReads, n);
    assert.equal(results[1].fileReads, n, "only the new copied tree needs hashing at install");
    assert.equal(results[2].fileReads, 0);
    assert.equal(results[2].hashes, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("changed bundle identity cannot reuse a verification grant", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-cache-identity-"));
  try {
    const source = path.join(runtimeFixture(root), "runtime");
    for (const identity of [
      { ...fixtureIdentity, version: "other" },
      { ...fixtureIdentity, platform: "other" },
      { ...fixtureIdentity, arch: "other" },
      { ...fixtureIdentity, bundleId: "0".repeat(64) },
    ]) {
      validateRuntimeBundle(source, fixtureIdentity);
      assert.throws(() => validateRuntimeBundle(source, identity), /identity mismatch/);
      assert.deepEqual(exportRuntimeVerificationCache([source]), []);
    }
    const { counts } = verificationSpies(t, [source]);
    validateRuntimeBundle(source, fixtureIdentity);
    assert.ok(counts.fileReads > 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a changed realpath within the bundle triggers a complete hash pass", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-cache-realpath-"));
  try {
    const source = path.join(runtimeFixture(root), "runtime");
    const n = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8")).files.length;
    validateRuntimeBundle(source, fixtureIdentity);
    const { counts } = verificationSpies(t, [source]);
    const originalRealpath = fs.realpathSync.native;
    let changed = false;
    t.mock.method(fs.realpathSync, "native", (filename, ...args) => {
      const result = originalRealpath(filename, ...args);
      if (!changed && String(filename).endsWith(`${path.sep}cli.js`)) {
        changed = true;
        return path.join(source, "app", "browser-helper.cjs");
      }
      return result;
    });
    validateRuntimeBundle(source, fixtureIdentity);
    assert.equal(counts.fileReads, n);
    assert.equal(counts.hashes, n + 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("worker failure evicts the main process grant and leaves the verification queue usable", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-cache-worker-failure-"));
  try {
    const source = path.join(runtimeFixture(root), "runtime"), cli = path.join(source, "app", "cli.js");
    const n = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8")).files.length;
    validateRuntimeBundle(source, fixtureIdentity);
    const results = workerVerificationSpies(t);
    const options = { root: source, identity: fixtureIdentity };
    await verifyRuntimeInWorker("validate", options);
    assert.equal(results[0].fileReads, 0, "sync cache must be handed to a fresh worker");
    fs.rmSync(cli);
    await assert.rejects(verifyRuntimeInWorker("validate", options), /file is missing/);
    assert.deepEqual(exportRuntimeVerificationCache([source]), []);
    fs.writeFileSync(cli, "cli");
    await verifyRuntimeInWorker("validate", options);
    assert.equal(results[2].fileReads, n);
    await assert.rejects(verifyRuntimeInWorker("unknown", {}), /Unknown runtime verification operation/);
    await verifyRuntimeInWorker("validate", options);
    assert.equal(results[3].fileReads, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a stale worker snapshot cannot overwrite a newer synchronous verification", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-cache-stale-worker-"));
  try {
    const source = path.join(runtimeFixture(root), "runtime"), cli = path.join(source, "app", "cli.js");
    validateRuntimeBundle(source, fixtureIdentity);
    const previous = exportRuntimeVerificationCache([source]);
    const metadata = fs.statSync(cli);
    fs.utimesSync(cli, metadata.atime, new Date(metadata.mtimeMs + 2000));
    validateRuntimeBundle(source, fixtureIdentity);
    importRuntimeVerificationCache([source], previous, previous);
    const { counts } = verificationSpies(t, [source]);
    validateRuntimeBundle(source, fixtureIdentity);
    assert.equal(counts.fileReads, 0);
    assert.equal(counts.hashes, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("same-size edits with preserved mtime are accepted only until the next process start", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-cache-limit-"));
  try {
    const source = path.join(runtimeFixture(root), "runtime"), cli = path.join(source, "app", "cli.js");
    validateRuntimeBundle(source, fixtureIdentity);
    const metadata = fs.statSync(cli, { bigint: true });
    fs.writeFileSync(cli, "BAD");
    const originalStat = fs.statSync;
    // Avoid utimes rounding on filesystems whose timestamp precision exceeds JS Date.
    t.mock.method(fs, "statSync", (filename, ...args) => {
      const result = originalStat(filename, ...args);
      if (filename === cli) {
        result.mtimeMs = metadata.mtimeMs;
        result.mtimeNs = metadata.mtimeNs;
      }
      return result;
    });
    const { counts } = verificationSpies(t, [source]);
    assert.equal(validateRuntimeBundle(source, fixtureIdentity), source);
    assert.equal(counts.fileReads, 0);
    const script = `require(${JSON.stringify(path.resolve(__dirname, "../electron/runtime-install.cjs"))}).validateRuntimeBundle(${JSON.stringify(source)}, ${JSON.stringify(fixtureIdentity)});`;
    const child = require("node:child_process").spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /checksum mismatch/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("packaged runtime uses fast cache on subsequent calls and repairs critical binary tampering", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-fastcache-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    // Second invocation hits fast cache
    const second = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    assert.equal(second, installed);

    // Tampering with critical binary (app/cli.js) fails validation and triggers repair
    const cli = path.join(installed, "app", "cli.js");
    fs.writeFileSync(cli, "tampered-cli");
    const repaired = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    assert.equal(repaired, installed);
    assert.equal(fs.readFileSync(cli, "utf8"), "cli");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
