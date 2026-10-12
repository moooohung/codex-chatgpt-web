import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { withoutRetiredTurnHandles } from "../src/adapters/chatgpt-web/prompt";

async function removeOwnedProfile(directory: string) {
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("context-regexp-")) {
    throw new Error(`Refusing to remove a profile outside this fixture: ${directory}`);
  }
  // Chromium utility processes can release their profile handles after the main process exits.
  // Retry explicitly: Bun's rmSync retry options do not reliably wait on Windows EBUSY.
  const deadline = Date.now() + 10_000;
  while (true) {
    try { rmSync(directory, { recursive: true, force: true }); return; }
    catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '') || Date.now() >= deadline) throw error;
      await Bun.sleep(100);
    }
  }
}

test.skipIf(!process.env.LAUNCHER_TEST_ELECTRON)("actual Chromium link regex stalls before encoding and remains responsive after lossless encoding", async () => {
  const original = JSON.stringify([{ type: "input_text", text: "```a``` ".repeat(12) }]);
  const userData = mkdtempSync(join(tmpdir(), "context-regexp-"));
  const env: NodeJS.ProcessEnv = { ...process.env, CHATGPT_LINK_TEST_INPUT: withoutRetiredTurnHandles(original) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.env.LAUNCHER_TEST_ELECTRON!, [
    resolve(import.meta.dir, "../launcher/tests/fixtures/context-markdown-regexp.cjs"), `--user-data-dir=${userData}`,
  ], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  // Do not wait for pipe EOF to establish process exit. Chromium children can retain
  // an inherited pipe briefly after Electron's main process has already exited.
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", code => resolve(code));
    child.once("error", reject);
  });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failure: unknown;
  try {
    const code = await Promise.race([exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Electron regexp fixture did not exit within 20 seconds: ${stderr.slice(-2000)}`)), 20_000);
    })]);
    clearTimeout(timer);
    await Promise.race([closed, Bun.sleep(1_000)]);
    if (code !== 0) throw new Error(`Electron regexp fixture exited ${code}: ${stderr.slice(-2000)}`);
    const line = stdout.split("\n").find(line => line.startsWith("CONTEXT_REGEXP_RESULT "));
    if (!line) throw new Error(`Missing result: ${stderr.slice(-2000)}`);
    const result = JSON.parse(line.slice("CONTEXT_REGEXP_RESULT ".length));
    expect(result.before).toBe("timeout");
    expect(result.roundTrip).toBe(true);
    expect(result.afterMs).toBeLessThan(500);
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(); // Only the exact Electron child created by this test.
      await Promise.race([exited.catch(() => {}), Bun.sleep(5_000)]);
    }
    child.stdout.destroy();
    child.stderr.destroy();
    try { await removeOwnedProfile(userData); }
    catch (error) { failure = failure ? new AggregateError([failure, error], "Fixture failed and its owned profile could not be removed") : error; }
  }
  if (failure) throw failure;
}, 40_000);
