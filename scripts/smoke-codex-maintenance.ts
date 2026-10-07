import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { bridgeToResponsesSSE, formatErrorResponse } from "../src/bridge";
import { bridgeMaintenanceResponse } from "../src/server";
import type { AdapterEvent } from "../src/types";

// Every request terminates at this isolated loopback fixture; no browser or real account is used.
const codex = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(codex)) throw new Error("Pass the exact installed Codex executable");
const bundled = spawnSync(codex, ["debug", "models", "--bundled"], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
});
if (bundled.status !== 0) throw new Error("Could not read the installed Codex bundled catalog");
const root = join(tmpdir(), `codex-maintenance-fixture-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });
const catalogPath = join(root, "models.json");
writeFileSync(catalogPath, bundled.stdout);
const cases: unknown[] = [];
for (const kind of ["old-overload", "maintenance-recovery"] as const) {
  const home = join(root, kind);
  mkdirSync(home);
  let requests = 0;
  async function* answer(): AsyncGenerator<AdapterEvent> {
    yield { type: "text_delta", text: "MAINTENANCE_RECOVERED" };
    yield { type: "done", endTurn: true };
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/models") return Response.json(JSON.parse(bundled.stdout));
    if (url.pathname !== "/v1/responses" || request.method !== "POST") return new Response("fixture only", { status: 404 });
    requests += 1;
    if (kind === "old-overload") return formatErrorResponse(503, "server_error",
      "codex-chatgpt-web is draining for a requested service operation");
    if (requests <= 2) return bridgeMaintenanceResponse();
    return new Response(bridgeToResponsesSSE(answer(), "gpt-6.1-sol"), {
      headers: { "content-type": "text/event-stream" },
    });
  } });
  writeFileSync(join(home, "config.toml"), [
    'model="gpt-6.1-sol"', 'model_provider="maintenance-fixture"',
    `model_catalog_json=${JSON.stringify(catalogPath)}`, "",
    "[model_providers.maintenance-fixture]", 'name="Isolated maintenance fixture"',
    `base_url="http://127.0.0.1:${server.port}/v1"`, 'wire_api="responses"',
    'env_key="OPENAI_API_KEY"', "supports_websockets=false", "",
  ].join("\n"));
  const child = Bun.spawn([codex, "exec", "--skip-git-repo-check", "--json",
    "--model", "gpt-6.1-sol", "Return the fixture answer without using tools."], {
    cwd: home, env: { ...process.env, CODEX_HOME: home, CODEX_SQLITE_HOME: home,
      OPENAI_API_KEY: "offline-maintenance-fixture" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 45_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    writeFileSync(join(home, "stdout.jsonl"), stdout);
    writeFileSync(join(home, "stderr.log"), stderr);
    const capacityShown = stdout.includes("Selected model is at capacity");
    const recovered = stdout.includes("MAINTENANCE_RECOVERED");
    cases.push({ kind, requests, exitCode, timedOut, capacityShown, recovered });
    if (timedOut || (kind === "old-overload" ? !capacityShown || exitCode === 0 :
      exitCode !== 0 || !recovered || capacityShown || requests !== 3)) {
      throw new Error(`Native maintenance fixture failed: ${JSON.stringify(cases.at(-1))}; evidence=${home}`);
    }
  } finally { clearTimeout(timer); await server.stop(true); }
}
const report = { passed: true, root, cases, productionRequests: 0, proTestMessagesSent: 0 };
writeFileSync(join(root, "result.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
