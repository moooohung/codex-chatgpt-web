function resolveReleaseRepository(manifest) {
  const repository = manifest.codexWebGptReleaseRepository ?? "miuuyy/codex-chatgpt-web";
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Invalid packaged release repository");
  }
  return repository;
}
module.exports = { resolveReleaseRepository };
