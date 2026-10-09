import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const { releasePlan, applyReleasePlan } = require("../scripts/prepare-fork-release.cjs");
const source = resolve(import.meta.dir, "..");
const env = { GITHUB_REPOSITORY: "moooohung/codex-chatgpt-web", GITHUB_SHA: "a".repeat(40),
  GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "push", GITHUB_RUN_NUMBER: "123" };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cgw-fork-release-"));
  const sourceVersion = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
  for (const relative of ["package.json", "launcher/package.json", "src/version.ts",
    "src/adapters/chatgpt-web/mcp-server.ts", "scripts/install.sh", "scripts/install-launcher.sh", "scripts/install-launcher.ps1",
    "scripts/check-version.ts", "scripts/generate-third-party-notices.ts", "scripts/prepare-windows-baseline-bun.ps1",
    ".github/workflows/ci.yml", ".github/workflows/release.yml", "README.md", "README.zh-CN.md", "README.ja.md", "README.ko.md"]) {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    cpSync(join(source, relative), join(root, relative));
  }
  // Release builds run these tests after transforming their disposable checkout.
  // Restore the fixture's stable input contract without changing that checkout.
  for (const relative of ["package.json", "launcher/package.json", "src/version.ts",
    "scripts/install.sh", "scripts/install-launcher.sh", "scripts/install-launcher.ps1",
    "README.md", "README.zh-CN.md", "README.ja.md", "README.ko.md"]) {
    const file = join(root, relative);
    let text = readFileSync(file, "utf8").split(sourceVersion).join("6.1.5");
    text = text.replaceAll("moooohung/codex-chatgpt-web", "miuuyy/codex-chatgpt-web");
    if (relative.startsWith("README")) {
      text = text.replaceAll("/releases/download/v6.1.5/install-launcher.", "/releases/latest/download/install-launcher.");
    }
    if (relative === "scripts/install-launcher.sh") {
      text = text.replace('VERSION="${CODEX_WEB_GPT_VERSION:-6.1.5}"', 'VERSION="${CODEX_WEB_GPT_VERSION:-}"');
    }
    if (relative === "scripts/install-launcher.ps1") {
      text = text.replace('$Version = if ($env:CODEX_WEB_GPT_VERSION) { $env:CODEX_WEB_GPT_VERSION } else { "6.1.5" }', '$Version = $env:CODEX_WEB_GPT_VERSION');
    }
    writeFileSync(file, text);
  }
  return root;
}

test("fork main pushes and manual runs produce commit-specific prereleases; retries retain the same version", () => {
  const plan = releasePlan("6.1.5", env);
  expect(plan).toMatchObject({ version: "6.1.5-fork.123.gaaaaaaaaaaaa", tag: "v6.1.5-fork.123.gaaaaaaaaaaaa", automatic: true, sourceSha: env.GITHUB_SHA });
  expect(releasePlan("6.1.5", { ...env, GITHUB_EVENT_NAME: "workflow_dispatch" })).toEqual(plan);
  expect(releasePlan("6.1.5", { ...env, GITHUB_RUN_ATTEMPT: "2" })).toEqual(plan);
  expect(releasePlan("6.1.5", { ...env, GITHUB_RUN_NUMBER: "124" }).tag).not.toBe(plan.tag);
});

test("upstream and fork matching version tags retain the official release contract", () => {
  for (const repository of ["miuuyy/codex-chatgpt-web", env.GITHUB_REPOSITORY]) {
    expect(releasePlan("6.1.5", { ...env, GITHUB_REPOSITORY: repository, GITHUB_REF: "refs/tags/v6.1.5" }))
      .toMatchObject({ version: "6.1.5", tag: "v6.1.5", automatic: false });
  }
});

test("untrusted events, branches, version tags and output injection cannot publish", () => {
  for (const change of [{ GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_REF: "refs/heads/codex/test" },
    { GITHUB_REF: "refs/tags/v6.1.4" }, { GITHUB_REPOSITORY: "attacker/codex-chatgpt-web" },
    { GITHUB_REPOSITORY: "miuuyy/codex-chatgpt-web" }, { GITHUB_RUN_NUMBER: "123\ntag=evil" }, { GITHUB_SHA: "abcdef" }]) {
    expect(() => releasePlan("6.1.5", { ...env, ...change })).toThrow();
  }
});

test("automatic package, source, installers and README downloads share one verified release identity", () => {
  const root = fixture();
  try {
    const plan = releasePlan("6.1.5", env); applyReleasePlan(root, plan);
    for (const relative of ["package.json", "launcher/package.json"]) expect(JSON.parse(readFileSync(join(root, relative), "utf8")).version).toBe(plan.version);
    expect(JSON.parse(readFileSync(join(root, "launcher/package.json"), "utf8")).codexWebGptReleaseRepository).toBe(env.GITHUB_REPOSITORY);
    expect(readFileSync(join(root, "scripts/install-launcher.ps1"), "utf8")).toContain(`else { "${plan.version}" }`);
    expect(readFileSync(join(root, "scripts/install-launcher.sh"), "utf8")).toContain(`CODEX_WEB_GPT_VERSION:-${plan.version}`);
    for (const relative of ["README.md", "README.zh-CN.md", "README.ja.md", "README.ko.md"]) {
      const readme = readFileSync(join(root, relative), "utf8");
      expect(readme).toContain(`https://github.com/${env.GITHUB_REPOSITORY}/releases/download/${plan.tag}/codex-web-gpt-${plan.version}-win-x64.exe`);
      expect(readme).not.toContain("/releases/latest/download/");
    }
    const check = spawnSync(process.execPath, ["run", join(root, "scripts/check-version.ts")], { encoding: "utf8" });
    expect(check.stderr).toBe(""); expect(check.status).toBe(0);
    expect(check.stdout).toContain(`VERSION_SYNC_OK ${plan.version} bun@1.4.2`);
    expect(JSON.parse(readFileSync(join(root, "release-plan.json"), "utf8"))).toEqual(plan);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a missing synchronization marker fails before any package file changes", () => {
  const root = fixture();
  try {
    const original = readFileSync(join(root, "package.json"), "utf8");
    writeFileSync(join(root, "README.ko.md"), "download layout changed");
    expect(() => applyReleasePlan(root, releasePlan("6.1.5", env))).toThrow("README.ko.md");
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
