const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveReleaseRepository } = require("../electron/release-repository.cjs");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
test("ordinary builds retain upstream while fork packages use their own release provenance", () => {
  assert.equal(resolveReleaseRepository({}), "miuuyy/codex-chatgpt-web");
  assert.equal(resolveReleaseRepository({ codexWebGptReleaseRepository: "moooohung/codex-chatgpt-web" }), "moooohung/codex-chatgpt-web");
});
test("a real fork updater validates only the configured repository's release assets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-fork-updater-"));
  try {
    fs.mkdirSync(path.join(root, "electron"));
    for (const file of ["update.cjs", "release-repository.cjs"]) fs.copyFileSync(path.join(__dirname, "../electron", file), path.join(root, "electron", file));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ codexWebGptReleaseRepository: "moooohung/codex-chatgpt-web" }));
    const updater = require(path.join(root, "electron/update.cjs"));
    const url = "https://github.com/moooohung/codex-chatgpt-web/releases/download/v6.1.5-fork.1.gabcdef123456/launcher.zip";
    assert.equal(updater.validateReleaseAssetUrl(url, "6.1.5-fork.1.gabcdef123456", "launcher.zip"), url);
    assert.throws(() => updater.validateReleaseAssetUrl(url.replace("moooohung", "miuuyy"), "6.1.5-fork.1.gabcdef123456", "launcher.zip"), /unexpected release asset URL/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("release repository metadata rejects URLs, traversal and malformed values", () => {
  for (const value of ["https://github.com/owner/repo", "owner/repo/extra", "owner/repo\n", "owner", 12, "owner/../../repo"]) {
    assert.throws(() => resolveReleaseRepository({ codexWebGptReleaseRepository: value }), /Invalid packaged release repository/);
  }
});
