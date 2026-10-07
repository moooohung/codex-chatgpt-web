import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { bridgeToResponsesSSE } from "../src/bridge";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent } from "../src/types";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TurnBroker, type BrokerToolRequest, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

const codex = resolve(process.argv[2] ?? "");
const output = process.argv[3];
if (!existsSync(codex) || !output) throw new Error("Pass the exact Codex executable and evidence path");
const root = mkdtempSync(join(tmpdir(), "codex-computer-use-fixture-"));
const home = join(root, "home");
mkdirSync(home);
const repl = (Bun.TOML.parse(readFileSync(join(homedir(), ".codex", "config.toml"), "utf8")) as any).mcp_servers?.node_repl;
if (!repl) throw new Error("node_repl is not registered");
const catalog = spawnSync(codex, ["debug", "models", "--bundled"], { encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
if (catalog.status !== 0) throw new Error("Could not read bundled model catalog");
writeFileSync(join(home, "models.json"), catalog.stdout);
let requests = 0;
let screenshotCount = 0;
const failures: string[] = [];
const native2 = process.argv[4] === "--native2";
const broker = native2 ? TurnBroker.forSocket(defaultBrokerEndpoint(root, process.platform)) : undefined;
const bridgeClient = native2 ? new Client({ name: "computer-use-active-runtime-fixture", version: "1.0.0" }) : undefined;
let token: string | undefined;
let dispatched: BrokerToolRequest | undefined;
let native2Pending: Promise<any> | undefined;
const evidence: Record<string, unknown> = { at: new Date().toISOString(), root, modelRequestsToProduction: 0,
  proRequests: 0, gameInputs: 0, userJobsChanged: 0, rawTokensRetained: 0, toolCatalog: [] };
const code = [
  'if (!globalThis.sky) { const { sky } = await import("@oai/sky"); globalThis.sky = sky; }',
  'globalThis.fixtureCandidates = (await sky.list_windows()).filter(window => window.title === "Codex Computer Use Fixture 01a1119c");',
  'if (fixtureCandidates.length !== 1) throw new Error("Expected exactly one returned fixture window");',
  'globalThis.fixtureWindow = await sky.get_window({id:fixtureCandidates[0].id,app:fixtureCandidates[0].app});',
  'globalThis.fixtureState = await sky.get_window_state({window:fixtureWindow,include_screenshot:true,include_text:false});',
].join("\n");
const program = `const r = await tools.mcp__node_repl__js(${JSON.stringify({ code, title: "Computer Use fixture only", timeout_ms: 20000 })});\nfor (const c of r.content ?? []) { if (c.type === "image") image(c); else if (c.type === "text") text(c.text); }`;
async function* answer(): AsyncGenerator<AdapterEvent> {
  yield { type: "text_delta", text: "COMPUTER_USE_FIXTURE_FINISHED" };
  yield { type: "done", endTurn: true };
}
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/v1/models") return Response.json(JSON.parse(catalog.stdout));
  if (url.pathname !== "/v1/responses" || request.method !== "POST") return new Response("Isolated fixture only", { status: 404 });
  requests++;
  const body = await request.json() as Record<string, any>;
  if (failures.length) return new Response(bridgeToResponsesSSE(answer(), "gpt-6.1-sol"), { headers: { "content-type": "text/event-stream" } });
  const parsed = parseRequest(body);
  const tools = parsed.context.tools ?? [];
  const namespaces = new Map(tools.filter(tool => tool.namespace).map(tool => [`${tool.namespace}__${tool.name}`, { namespace: tool.namespace!, name: tool.name }]));
  const freeform = new Set(tools.filter(tool => tool.freeform).map(tool => tool.name));
  if (native2) {
    if (requests === 1) {
      evidence.toolCatalog = tools.map(tool => ({ name: tool.name, namespace: tool.namespace, freeform: Boolean(tool.freeform) }));
      token = await broker!.register({ cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" }, tools }, 60_000);
      await bridgeClient!.connect(new StdioClientTransport({ command: process.execPath, args: [process.env.CODEX_NATIVE2_DISCOVERY_CLI ?? "src/cli.ts", "mcp", "--broker-socket", defaultBrokerEndpoint(root, process.platform)],
        cwd: process.cwd(), env: { CODEX_CHATGPT_WEB_HOME: join(root, "bridge") }, stderr: "pipe" }));
      native2Pending = bridgeClient!.callTool({ name: "codex_tool_inventory", arguments: { turn_token: token, query: "computer use", include_schema: true } });
    } else {
      const message = parsed.context.messages.findLast(item => item.role === "toolResult" && item.toolCallId === dispatched!.callId);
      if (!message || message.role !== "toolResult") throw new Error("Active runtime omitted the fixture broker's tool result");
      if (requests === 2) {
        const text = typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        evidence.nativeCatalogEnvelopeHead = text.replaceAll(token!, "[fixture capability]").slice(0, 220);
      }
      const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content.map(part => {
        if (part.type === "text") return { type: "text", text: part.text };
        const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(part.imageUrl);
        if (!match) throw new Error("Fixture screenshot is not an inline native image");
        return { type: "image", mimeType: match[1], data: match[2] };
      });
      broker!.completeTool(token!, dispatched!.callId, { content, isError: message.isError } as BrokerToolResult);
      const result = await native2Pending;
      if (requests === 2) {
        const available = result.structuredContent?.tools ?? [];
        evidence.native2Discovery = { isError: Boolean(result.isError), registry: result.structuredContent?.registry,
          tools: available.map((tool: any) => ({ wire: tool.wire_name, kind: tool.kind })),
          ...(result.isError ? { error: result.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n").replaceAll(token!, "[fixture capability]").slice(0, 1600) } : {}) };
        if (available.length !== 1 || available[0].wire_name !== "mcp__node_repl__js") {
          failures.push("Active Native2 gateway did not discover the exact Computer Use wire");
          return new Response(bridgeToResponsesSSE(answer(), "gpt-6.1-sol"), { headers: { "content-type": "text/event-stream" } });
        }
        evidence.native2Wire = available[0].wire_name;
        native2Pending = bridgeClient!.callTool({ name: "codex_tool_call", arguments: { turn_token: token,
          wire_name: available[0].wire_name, arguments: { code, title: "Computer Use fixture only", timeout_ms: 20000 } } });
      } else {
        screenshotCount = result.content.filter((item: any) => item.type === "image").length;
        evidence.native2ImageReturned = screenshotCount > 0;
        if (result.isError) failures.push("Native2 Computer Use returned an error");
        return new Response(bridgeToResponsesSSE(answer(), "gpt-6.1-sol"), { headers: { "content-type": "text/event-stream" } });
      }
    }
    [dispatched] = await broker!.nextToolBatch(token!);
    async function* dispatch(): AsyncGenerator<AdapterEvent> {
      yield { type: "tool_call_start", id: dispatched!.callId, name: dispatched!.wireName };
      yield { type: "tool_call_delta", arguments: JSON.stringify(dispatched!.freeform ? { input: dispatched!.input } : dispatched!.arguments) };
      yield { type: "tool_call_end" };
      yield { type: "done", endTurn: false, stopReason: "tool_use" };
    }
    return new Response(bridgeToResponsesSSE(dispatch(), "gpt-6.1-sol", namespaces, freeform), { headers: { "content-type": "text/event-stream" } });
  }
  if (requests === 1) {
    evidence.toolCatalog = tools.map(tool => ({ name: tool.name, namespace: tool.namespace, freeform: Boolean(tool.freeform) }));
    const exec = tools.find(tool => tool.name === "exec" && !tool.namespace && tool.freeform);
    const direct = tools.find(tool => `${tool.namespace}__${tool.name}` === "mcp__node_repl__js" || tool.name === "mcp__node_repl__js");
    if (!exec && !direct) { failures.push("Active native turn advertised neither exec nor node_repl"); return new Response(bridgeToResponsesSSE(answer(), "gpt-6.1-sol")); }
    const name = exec ? exec.name : direct!.namespace ? `${direct!.namespace}__${direct!.name}` : direct!.name;
    async function* call(): AsyncGenerator<AdapterEvent> {
      yield { type: "tool_call_start", id: "call_computer_use_fixture", name };
      yield { type: "tool_call_delta", arguments: JSON.stringify(exec ? { input: program } : { code, title: "Computer Use fixture only", timeout_ms: 20000 }) };
      yield { type: "tool_call_end" };
      yield { type: "done", endTurn: false, stopReason: "tool_use" };
    }
    return new Response(bridgeToResponsesSSE(call(), "gpt-6.1-sol", namespaces, freeform), { headers: { "content-type": "text/event-stream" } });
  }
  const inspect = (item: any) => {
    if (!item || typeof item !== "object") return;
    if (item.type === "input_image" || item.type === "image") screenshotCount++;
    if (typeof item.text === "string" || typeof item.output === "string") {
      const text = item.text ?? item.output;
      for (const marker of ["kernel exited unexpectedly", "trusted Node process exited", "helper_unknown_error", "Cannot find package", "not listed in this turn", "Expected exactly one returned fixture window"])
        if (text.includes(marker) && !failures.includes(marker)) failures.push(marker);
    }
    for (const value of Object.values(item)) if (Array.isArray(value)) for (const child of value) inspect(child);
  };
  for (const item of body.input ?? []) inspect(item);
  return new Response(bridgeToResponsesSSE(answer(), "gpt-6.1-sol"), { headers: { "content-type": "text/event-stream" } });
} });
writeFileSync(join(home, "config.toml"), [
  'model="gpt-6.1-sol"', 'model_provider="cu-fixture"', 'sandbox_mode="danger-full-access"', 'approval_policy="never"', 'notify=[]',
  `model_catalog_json=${JSON.stringify(join(home, "models.json"))}`, '[model_providers.cu-fixture]',
  'name="Isolated Computer Use fixture"', `base_url="http://127.0.0.1:${server.port}/v1"`,
  'wire_api="responses"', 'env_key="OPENAI_API_KEY"', 'supports_websockets=false',
  '[mcp_servers.node_repl]', `command=${JSON.stringify(repl.command)}`, `args=${JSON.stringify(repl.args ?? [])}`,
  'startup_timeout_sec=30', '[mcp_servers.node_repl.env]',
  ...Object.entries(repl.env as Record<string, string>).map(([key, value]) => `${key}=${JSON.stringify(key === "CODEX_HOME" ? home : value)}`),
].join("\n"));
const env: Record<string, string | undefined> = { ...process.env, CODEX_HOME: home, CODEX_SQLITE_HOME: home, OPENAI_API_KEY: "offline-computer-use-fixture" };
delete env.CODEX_WINDOWS_REGISTERED_CORE;
const child = Bun.spawn([codex, "exec", "--skip-git-repo-check", "--json", "--model", "gpt-6.1-sol",
  "Observe only the isolated Computer Use test window. Do not interact with the game or user jobs."],
  { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
const timer = setTimeout(() => child.kill(), 55_000);
try {
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  writeFileSync(join(root, "stdout.jsonl"), stdout);
  writeFileSync(join(root, "stderr.log"), stderr);
  Object.assign(evidence, { exitCode, requests, screenshotCount, failures,
    passed: exitCode === 0 && requests === (native2 ? 3 : 2) && screenshotCount > 0 && failures.length === 0 });
  if (!evidence.passed) process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await server.stop(true);
  if (bridgeClient) await bridgeClient.close();
  if (token) broker!.revoke(token);
  if (broker) await broker.close();
  writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
}
