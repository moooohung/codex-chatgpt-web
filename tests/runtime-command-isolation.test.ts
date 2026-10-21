import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

// Run against the shipped artifact, including its hashed chunks. Missing heavyweight packages
// make accidental eager imports a functional failure instead of relying on noisy RAM thresholds.
const runtime = process.env.CHATGPT_COMMAND_RUNTIME_ROOT;
(runtime ? test : test.skip)("packaged MCP executes the bound native tool without browser or tokenizer packages", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-command-isolation-"));
  const app = join(root, "app");
  mkdirSync(join(app, "node_modules", "@modelcontextprotocol"), { recursive: true });
  const source = join(resolve(runtime!), "app");
  for (const name of readdirSync(source).filter(name => name.endsWith(".js"))) {
    cpSync(join(source, name), join(app, name));
  }
  // SDK transitive dependencies resolve at their existing installation; the CLI itself can
  // resolve only these two packages. No browser/tokenizer packages are copied or downloaded.
  for (const name of ["@modelcontextprotocol/sdk", "zod"]) {
    symlinkSync(resolve(import.meta.dir, "../node_modules", name), join(app, "node_modules", name),
      process.platform === "win32" ? "junction" : "dir");
  }
  const home = join(root, "home"), endpoint = defaultBrokerEndpoint(home);
  const broker = TurnBroker.forSocket(endpoint);
  const token = await broker.register({ cwd: root, roots: [root], writableRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [
      { name: "exec_command", description: "Fixture command; never executed", parameters: { type: "object" } },
    ] });
  const client = new Client({ name: "packaged-command-isolation", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(app, "cli.js"), "--home", home, "mcp", "--broker-socket", endpoint],
    env: { ...process.env, CODEX_HOME: join(root, "codex") } as Record<string, string>,
    cwd: root, stderr: "pipe" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name)).toContain("codex_exec");
    const pending = client.callTool({ name: "codex_exec", arguments: { turn_token: token, cmd: "fixture-only" } });
    const [request] = await broker.nextToolBatch(token);
    expect(request).toMatchObject({ wireName: "exec_command", arguments: { cmd: "fixture-only" } });
    const content = [{ type: "text" as const, text: "bound fixture completed" }];
    broker.completeTool(token, request!.callId, { content });
    expect((await pending).content).toEqual(content);
    broker.revoke(token);
    const expired = await client.callTool({ name: "codex_exec", arguments: { turn_token: token, cmd: "must not run" } });
    expect(expired.isError).toBe(true);
    expect(expired.structuredContent).toMatchObject({ status: "notice", action_required: "conclude_summary" });
    expect(JSON.stringify(expired)).toContain("which has already finished");
  } finally {
    await client.close().catch(() => {});
    broker.revoke(token);
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
