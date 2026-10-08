const fs = require("node:fs");
const path = require("node:path");
const FORK = "moooohung/codex-chatgpt-web";
const UPSTREAM = "miuuyy/codex-chatgpt-web";

function releasePlan(baseVersion, env) {
  if (!/^\d+\.\d+\.\d+$/.test(baseVersion)) throw new Error("Source must have a stable base version");
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || "")) throw new Error("Release needs the exact source SHA");
  if (![FORK, UPSTREAM].includes(env.GITHUB_REPOSITORY)) throw new Error("Unreviewed release repository");
  let version = baseVersion;
  const tagged = (env.GITHUB_REF || "").startsWith("refs/tags/");
  if (tagged) {
    if (env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF !== `refs/tags/v${baseVersion}`) throw new Error("Release tag must match the source version");
  } else {
    if (env.GITHUB_REPOSITORY !== FORK || env.GITHUB_REF !== "refs/heads/main"
      || !["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME)) throw new Error("Automatic releases require a trusted fork main event");
    if (!/^[1-9]\d*$/.test(env.GITHUB_RUN_NUMBER || "")) throw new Error("Release needs a positive run number");
    version = `${baseVersion}-fork.${env.GITHUB_RUN_NUMBER}.g${env.GITHUB_SHA.slice(0, 12)}`;
  }
  return { schemaVersion: 1, repository: env.GITHUB_REPOSITORY, sourceSha: env.GITHUB_SHA,
    baseVersion, version, tag: `v${version}`, automatic: !tagged };
}

function applyReleasePlan(root, plan) {
  const files = new Map();
  const replace = (relative, before, after) => {
    const text = files.get(relative) ?? fs.readFileSync(path.join(root, relative), "utf8");
    if (!text.includes(before)) throw new Error(`Release synchronization input changed: ${relative}`);
    files.set(relative, text.split(before).join(after));
  };
  for (const relative of ["package.json", "launcher/package.json"]) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
    if (pkg.version !== plan.baseVersion) throw new Error(`Release source version changed: ${relative}`);
    pkg.version = plan.version;
    if (plan.repository === FORK && relative === "launcher/package.json") pkg.codexWebGptReleaseRepository = FORK;
    files.set(relative, JSON.stringify(pkg, null, 2) + "\n");
  }
  replace("src/version.ts", `export const VERSION = "${plan.baseVersion}";`, `export const VERSION = "${plan.version}";`);
  replace("scripts/install.sh", `VERSION="\${CODEX_CHATGPT_WEB_VERSION:-${plan.baseVersion}}"`, `VERSION="\${CODEX_CHATGPT_WEB_VERSION:-${plan.version}}"`);
  for (const relative of ["README.md", "README.zh-CN.md", "README.ja.md", "README.ko.md"]) {
    replace(relative, plan.baseVersion, plan.version);
    if (plan.repository === FORK) {
      replace(relative, `https://github.com/${UPSTREAM}/releases`, `https://github.com/${FORK}/releases`);
      replace(relative, `/releases/latest/download/`, `/releases/download/${plan.tag}/`);
    }
  }
  if (plan.repository === FORK) {
    for (const relative of ["scripts/install.sh", "scripts/install-launcher.sh", "scripts/install-launcher.ps1"]) {
      replace(relative, UPSTREAM, FORK);
    }
    replace("scripts/install-launcher.sh", 'VERSION="${CODEX_WEB_GPT_VERSION:-}"', `VERSION="\${CODEX_WEB_GPT_VERSION:-${plan.version}}"`);
    replace("scripts/install-launcher.ps1", '$Version = $env:CODEX_WEB_GPT_VERSION', `$Version = if ($env:CODEX_WEB_GPT_VERSION) { $env:CODEX_WEB_GPT_VERSION } else { "${plan.version}" }`);
  }
  // Validate the entire input set before touching the disposable Actions checkout.
  for (const [relative, text] of files) fs.writeFileSync(path.join(root, relative), text);
  fs.writeFileSync(path.join(root, "release-plan.json"), JSON.stringify(plan, null, 2) + "\n");
  return [...files.keys()];
}

module.exports = { releasePlan, applyReleasePlan };
if (require.main === module) {
  const root = path.resolve(__dirname, "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const plan = releasePlan(pkg.version, process.env);
  if (process.argv.includes("--apply")) applyReleasePlan(root, plan);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
    `version=${plan.version}\ntag=${plan.tag}\nsource_sha=${plan.sourceSha}\n`);
  console.log(JSON.stringify(plan));
}
