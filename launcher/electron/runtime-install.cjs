const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { renameAtomicFile } = require("./atomic-file.cjs");
const { runtimeBundlePaths } = require("./runtime-command.cjs");

const DEFAULT_SOURCE_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_SOURCE_WAIT_INTERVAL_MS = 50;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
// Process-only verification: unchanged manifest bytes, tree membership, stat metadata and
// realpaths reuse a successful hash pass. An in-place edit preserving size and mtime
// goes undetected until the next launcher start. Never persist these grants to disk.
const verificationCache = new Map();

function cacheKey(runtimeRoot) {
  const resolved = path.resolve(runtimeRoot);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function exportRuntimeVerificationCache(roots) {
  return roots.flatMap(root => {
    const key = cacheKey(root);
    return verificationCache.has(key) ? [[key, verificationCache.get(key)]] : [];
  });
}

function importRuntimeVerificationCache(roots, entries, previousEntries) {
  const incoming = new Map(entries);
  const previous = previousEntries && new Map(previousEntries);
  for (const root of roots) {
    const key = cacheKey(root);
    // A synchronous validation may have changed this root while the worker ran.
    if (previous && verificationCache.get(key) !== previous.get(key)) continue;
    verificationCache.delete(key);
    if (incoming.has(key)) verificationCache.set(key, incoming.get(key));
  }
}

function moveRuntimeVerificationCache(from, to) {
  const cached = verificationCache.get(cacheKey(from));
  verificationCache.delete(cacheKey(from));
  verificationCache.delete(cacheKey(to));
  if (!cached) return;
  const canonicalRoot = (fs.realpathSync.native ?? fs.realpathSync)(to);
  verificationCache.set(cacheKey(to), {
    ...cached,
    canonicalRoot,
    fingerprints: cached.fingerprints.map(file => ({
      ...file,
      realpath: path.join(canonicalRoot, path.relative(cached.canonicalRoot, file.realpath)),
    })),
  });
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bundleIdFor(files) {
  const digest = crypto.createHash("sha256");
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

function validateManifestPath(relativePath) {
  if (typeof relativePath !== "string"
    || relativePath.length === 0
    || relativePath === "manifest.json"
    || relativePath.includes("\\")
    || path.posix.isAbsolute(relativePath)
    || path.posix.normalize(relativePath) !== relativePath
    || relativePath.split("/").some(segment => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Runtime manifest contains an unsafe file path: ${JSON.stringify(relativePath)}`);
  }
  return relativePath;
}

function readRuntimeManifest(runtimeRoot, { version, platform, arch, bundleId }, manifestText) {
  const manifestPath = path.join(runtimeRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Runtime manifest is missing: ${manifestPath}`);
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(
      `Runtime manifest is invalid: ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const expectedLauncher = `bin/${platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web"}`;
  if (manifest?.schemaVersion !== 2
    || manifest.appVersion !== version
    || manifest.platform !== platform
    || manifest.arch !== arch
    || manifest.launcher !== expectedLauncher
    || manifest.entrypoint !== "app/cli.js"
    || typeof manifest.bunVersion !== "string"
    || typeof manifest.playwright !== "string"
    || !SHA256_PATTERN.test(manifest.bundleId)
    || (bundleId && manifest.bundleId !== bundleId)
    || !Array.isArray(manifest.files)
    || manifest.files.length === 0) {
    const received = manifest && typeof manifest === "object" ? {
      schemaVersion: manifest.schemaVersion,
      appVersion: manifest.appVersion,
      bundleId: manifest.bundleId,
      bunVersion: manifest.bunVersion,
      platform: manifest.platform,
      arch: manifest.arch,
      launcher: manifest.launcher,
      entrypoint: manifest.entrypoint,
      playwright: manifest.playwright,
      fileCount: Array.isArray(manifest.files) ? manifest.files.length : null,
    } : manifest;
    throw new Error(
      `Runtime bundle identity mismatch: expected ${version} ${platform}/${arch}, received ${JSON.stringify(received)}`,
    );
  }

  let previousPath = null;
  const files = manifest.files.map((file, index) => {
    if (!file || typeof file !== "object"
      || !Number.isSafeInteger(file.size)
      || file.size < 0
      || !SHA256_PATTERN.test(file.sha256)) {
      throw new Error(`Runtime manifest contains an invalid file record at index ${index}`);
    }
    const relativePath = validateManifestPath(file.path);
    if (previousPath !== null && comparePaths(previousPath, relativePath) >= 0) {
      throw new Error(`Runtime manifest file paths are not unique and sorted: ${relativePath}`);
    }
    previousPath = relativePath;
    return { path: relativePath, size: file.size, sha256: file.sha256 };
  });
  if (bundleIdFor(files) !== manifest.bundleId) {
    throw new Error(`Runtime manifest bundleId does not match its file records: ${manifestPath}`);
  }
  return { ...manifest, files };
}

function runtimeFilePaths(runtimeRoot) {
  const paths = [];
  const realpaths = new Map();
  const canonicalRoot = (fs.realpathSync.native ?? fs.realpathSync)(runtimeRoot);
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => comparePaths(left.name, right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(runtimeRoot, absolutePath).split(path.sep).join("/");
      let target;
      try { target = (fs.realpathSync.native ?? fs.realpathSync)(absolutePath); }
      catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") {
          throw new Error(`Runtime bundle file is missing: ${absolutePath}`);
        }
        throw error;
      }
      if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${path.sep}`)) {
        throw new Error(`Runtime bundle symlink escapes the bundle: ${absolutePath}`);
      }
      if (relativePath === "manifest.json" || relativePath === ".verified") continue;
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      paths.push(relativePath);
      realpaths.set(relativePath, target);
    }
  };
  visit(runtimeRoot);
  return { paths: paths.sort(comparePaths), canonicalRoot, realpaths };
}

function runtimeFileFingerprint(runtimeRoot, file, realpath) {
  const absolutePath = path.join(runtimeRoot, ...file.path.split("/"));
  let metadata;
  try {
    // Windows file IDs can exceed Number's safe integer range. Preserve exact IDs
    // and sub-millisecond mtimes in the fingerprint without extra stat operations.
    metadata = fs.statSync(absolutePath, { bigint: true });
  } catch {
    throw new Error(`Runtime bundle file is missing: ${absolutePath}`);
  }
  if (!metadata.isFile()) throw new Error(`Runtime bundle entry is not a file: ${absolutePath}`);
  return { size: Number(metadata.size), mtimeMs: metadata.mtimeMs, mtimeNs: metadata.mtimeNs,
    ino: metadata.ino, dev: metadata.dev, mode: Number(metadata.mode), realpath };
}

function validateRuntimeFile(runtimeRoot, file, fingerprint) {
  const absolutePath = path.join(runtimeRoot, ...file.path.split("/"));
  if (fingerprint.size !== file.size) {
    throw new Error(`Runtime bundle file size mismatch: ${absolutePath}`);
  }
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
  if (sha256 !== file.sha256) {
    throw new Error(`Runtime bundle file checksum mismatch: ${absolutePath}`);
  }
}

function inspectRuntimeBundle(runtimeRoot, identity) {
  const key = cacheKey(runtimeRoot);
  const cached = verificationCache.get(key);
  try {
    const manifestPath = path.join(runtimeRoot, "manifest.json");
    if (!fs.existsSync(manifestPath)) throw new Error(`Runtime manifest is missing: ${manifestPath}`);
    const manifestText = fs.readFileSync(manifestPath, "utf8");
    if (cached && cached.manifestText === manifestText
      && cached.manifest.appVersion === identity.version
      && cached.manifest.platform === identity.platform
      && cached.manifest.arch === identity.arch
      && (!identity.bundleId || cached.manifest.bundleId === identity.bundleId)) {
      try {
        const tree = runtimeFilePaths(runtimeRoot);
        const expected = cached.manifest.files;
        if (tree.canonicalRoot === cached.canonicalRoot && tree.paths.length === expected.length
          && tree.paths.every((relativePath, index) => relativePath === expected[index].path)
          && expected.every((file, index) => {
            const fingerprint = runtimeFileFingerprint(runtimeRoot, file, tree.realpaths.get(file.path));
            return Object.keys(fingerprint).every(field => fingerprint[field] === cached.fingerprints[index][field]);
          })) {
          return { manifest: cached.manifest, runtimeRoot };
        }
      } catch {
        // Retry through the full verifier so missing files and realpath escapes fail closed.
      }
    }
    verificationCache.delete(key);
    return inspectRuntimeBundleFully(runtimeRoot, identity, manifestText);
  } catch (error) {
    verificationCache.delete(key);
    throw error;
  }
}

function inspectRuntimeBundleFully(runtimeRoot, identity, manifestText) {
  const manifest = readRuntimeManifest(runtimeRoot, identity, manifestText);
  const paths = runtimeBundlePaths(runtimeRoot, identity.platform);

  const expectedPaths = manifest.files.map(file => file.path);
  const expectedSet = new Set(expectedPaths);
  for (const required of [
    paths.executable,
    paths.entrypoint,
    path.join(runtimeRoot, "app", "browser-helper.cjs"),
    path.join(runtimeRoot, ...manifest.launcher.split("/")),
  ]) {
    const relativePath = path.relative(runtimeRoot, required).split(path.sep).join("/");
    if (!expectedSet.has(relativePath)) {
      throw new Error(`Runtime manifest does not declare required file: ${required}`);
    }
  }

  const { paths: actualPaths, canonicalRoot, realpaths } = runtimeFilePaths(runtimeRoot);
  const actualSet = new Set(actualPaths);
  const missing = expectedPaths.find(relativePath => !actualSet.has(relativePath));
  if (missing) throw new Error(`Runtime bundle file is missing: ${path.join(runtimeRoot, ...missing.split("/"))}`);
  const unexpected = actualPaths.find(relativePath => !expectedSet.has(relativePath));
  if (unexpected) {
    throw new Error(`Runtime bundle contains an unmanifested file: ${path.join(runtimeRoot, ...unexpected.split("/"))}`);
  }
  if (actualPaths.length !== expectedPaths.length) {
    throw new Error(`Runtime bundle file count mismatch: expected ${expectedPaths.length}, received ${actualPaths.length}`);
  }

  const fingerprints = manifest.files.map(file => {
    const fingerprint = runtimeFileFingerprint(runtimeRoot, file, realpaths.get(file.path));
    validateRuntimeFile(runtimeRoot, file, fingerprint);
    return fingerprint;
  });
  const executableIndex = expectedPaths.indexOf(path.relative(runtimeRoot, paths.executable).split(path.sep).join("/"));
  if (identity.platform !== "win32" && (fingerprints[executableIndex].mode & 0o111) === 0) {
    throw new Error(`Bundled Bun runtime is not executable: ${paths.executable}`);
  }

  verificationCache.set(cacheKey(runtimeRoot), { manifestText, manifest, canonicalRoot, fingerprints });
  return { manifest, runtimeRoot: paths.runtimeRoot };
}

function validateRuntimeBundle(runtimeRoot, identity) {
  return inspectRuntimeBundle(runtimeRoot, identity).runtimeRoot;
}

async function waitForPackagedRuntimeSource({
  app,
  resourcesPath,
  timeoutMs = DEFAULT_SOURCE_WAIT_TIMEOUT_MS,
  intervalMs = DEFAULT_SOURCE_WAIT_INTERVAL_MS,
}) {
  if (!app.isPackaged) return null;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Packaged runtime source wait requires non-negative timeoutMs and positive intervalMs");
  }
  const source = path.join(resourcesPath, "runtime");
  const identity = {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      return validateRuntimeBundle(source, identity);
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Packaged runtime did not fully materialize within ${timeoutMs}ms: ${detail}`);
}

function ensurePackagedRuntime({ app, coreHome, resourcesPath }) {
  if (!app.isPackaged) return null;
  const identity = {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
  const source = path.join(resourcesPath, "runtime");
  const sourceBundle = inspectRuntimeBundle(source, identity);
  const expectedIdentity = { ...identity, bundleId: sourceBundle.manifest.bundleId };
  const versionsRoot = path.join(coreHome, "versions");
  const destination = path.join(
    versionsRoot,
    `${identity.version}-${identity.platform}-${identity.arch}`,
  );
  if (fs.existsSync(destination)) {
    try {
      return validateRuntimeBundle(destination, expectedIdentity);
    } catch {
      // A terminated installer or external cleanup can leave a version directory present but
      // incomplete. Rebuild the launcher-owned bundle transactionally from the signed package.
    }
  }

  fs.mkdirSync(versionsRoot, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  const previous = `${destination}.previous-${process.pid}-${Date.now()}`;
  let previousMoved = false;
  try {
    fs.cpSync(source, temporary, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    validateRuntimeBundle(temporary, expectedIdentity);
    if (fs.existsSync(destination)) {
      renameAtomicFile(destination, previous);
      previousMoved = true;
    }
    try {
      renameAtomicFile(temporary, destination);
      // Rename preserves the verified files' metadata. Rebase realpaths, then stat-check
      // the destination instead of hashing the same copied tree again.
      moveRuntimeVerificationCache(temporary, destination);
      validateRuntimeBundle(destination, expectedIdentity);
    } catch (error) {
      verificationCache.delete(cacheKey(destination));
      fs.rmSync(destination, { recursive: true, force: true });
      if (previousMoved) {
        try {
          renameAtomicFile(previous, destination);
          previousMoved = false;
        } catch (restoreError) {
          throw new Error(
            `Runtime replacement failed: ${error instanceof Error ? error.message : String(error)}`
            + `; previous runtime restoration failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          );
        }
      }
      throw error;
    }
    if (previousMoved) {
      fs.rmSync(previous, { recursive: true, force: true });
      previousMoved = false;
    }
  } finally {
    verificationCache.delete(cacheKey(temporary));
    fs.rmSync(temporary, { recursive: true, force: true });
    if (previousMoved && fs.existsSync(previous) && !fs.existsSync(destination)) {
      renameAtomicFile(previous, destination);
      previousMoved = false;
    }
  }
  try { fs.chmodSync(destination, 0o700); } catch {}
  return destination;
}

module.exports = {
  ensurePackagedRuntime,
  exportRuntimeVerificationCache,
  importRuntimeVerificationCache,
  validateRuntimeBundle,
  waitForPackagedRuntimeSource,
};
