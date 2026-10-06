import { afterAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import type { CodexTool } from "../src/types";

// Every capability in this fixture is minted by its own broker. No real account, goal,
// message recipient, worker token, browser or deferred backend is contacted.
const testRoot = mkdtempSync(join(tmpdir(), "native2-discovery-fixture-"));
afterAll(() => {
  if (dirname(resolve(testRoot)) !== resolve(tmpdir())) throw new Error("Unexpected fixture cleanup path");
  rmSync(testRoot, { recursive: true, force: true });
});

const searchSchema = {
  type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } },
  required: ["query"], additionalProperties: false,
};
const commandTools: CodexTool[] = [
  {
    name: "exec_command", description: "Run a shell command, returning a PTY session when still running",
    parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
  },
  { name: "write_stdin", description: "Poll a PTY session", parameters: { type: "object" } },
  { name: "tool_search", description: "Load deferred tools", parameters: searchSchema, toolSearch: true },
];
const goalSpecs = [
  { type: "function", name: "get_goal", description: "Get the fixture goal", parameters: { type: "object", additionalProperties: false } },
  {
    type: "function", name: "create_goal", description: "Create the fixture goal",
    parameters: { type: "object", properties: { objective: { type: "string" } }, required: ["objective"], additionalProperties: false },
  },
  {
    type: "function", name: "update_goal", description: "Update the fixture goal",
    parameters: { type: "object", properties: { status: { enum: ["complete", "blocked", "paused"] } }, required: ["status"], additionalProperties: false },
  },
];
const reportSchema = {
  type: "object", properties: { threadId: { type: "string" }, prompt: { type: "string" } },
  required: ["threadId", "prompt"], additionalProperties: false,
};
const reportSpec = {
  type: "namespace", name: "mcp__codex_app", tools: [{
    type: "function", name: "send_message_to_thread", description: "Deliver a fixture report", parameters: reportSchema,
  }],
};

function environment(tools: CodexTool[]): ChatGptTurnEnvironment {
  return { cwd: testRoot, roots: [testRoot], writableRoots: [testRoot], sandboxPolicy: { type: "dangerFullAccess" }, tools };
}

function toolResult(value: Record<string, unknown>): BrokerToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

async function fixture(name: string) {
  const home = join(testRoot, name);
  const socket = process.platform === "win32" ? defaultBrokerEndpoint(home, "win32") : `${home}.sock`;
  const broker = TurnBroker.forSocket(socket);
  const tokens: string[] = [];
  const register = async (tools: CodexTool[]) => {
    const token = await broker.register(environment(tools), 60_000);
    tokens.push(token);
    return token;
  };
  // Start the broker listener before connecting the real MCP stdio client.
  await register([]);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [process.env.CODEX_NATIVE2_DISCOVERY_CLI ?? "src/cli.ts", "mcp", "--broker-socket", socket],
    cwd: process.cwd(), env: { CODEX_CHATGPT_WEB_HOME: home }, stderr: "pipe",
  });
  const client = new Client({ name: "native2-offline-discovery", version: "1.0.0" });
  await client.connect(transport);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  return { broker, register, call, close: async () => {
    await client.close();
    for (const token of tokens) broker.revoke(token);
    await broker.close();
  } };
}

test("a PTY registry miss exposes the exact loader and cannot dispatch guessed JavaScript", async () => {
  const f = await fixture("pty");
  try {
    const token = await f.register(commandTools);
    const missing = await f.call("codex_tool_inventory", { turn_token: token, query: "goal", include_schema: true });
    expect(missing.structuredContent).toMatchObject({
      tools: [], total: 0, next_offset: null,
      registry: { status: "no_match_in_current_turn", direct_tool_count: 3, javascript_gateway: null, deferred_loader_count: 1, deferred_discovery_executed: false },
      discovery_tools: [{ wire_name: "tool_search", kind: "tool_search", parameters: searchSchema }],
    });
    for (const input of [
      { wire_name: "exec", input: "text(ALL_TOOLS)" },
      { wire_name: "get_goal", arguments: {} },
      { wire_name: "mcp__codex_app__send_message_to_thread", arguments: { threadId: "fixture-recipient", prompt: "fixture" } },
    ]) {
      const response = await f.call("codex_tool_call", { turn_token: token, ...input });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response.content)).toContain("not available in this turn");
    }
    const inventory = await f.call("codex_tool_inventory", { turn_token: token, query: "exec", include_schema: true });
    expect(inventory.structuredContent).toMatchObject({ tools: [{ wire_name: "exec_command", kind: "function", parameters: commandTools[0]!.parameters }], total: 1 });
    const pending = f.call("codex_tool_call", { turn_token: token, wire_name: "exec_command", arguments: { cmd: "fixture-only" } });
    const batch = await f.broker.nextToolBatch(token);
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ wireName: "exec_command", freeform: false, arguments: { cmd: "fixture-only" } });
    f.broker.completeTool(token, batch[0]!.callId, toolResult({ session_id: 741, output: "still running" }));
    expect((await pending).structuredContent).toEqual({ session_id: 741, output: "still running" });
    const poll = f.call("codex_write_stdin", { turn_token: token, session_id: 741, chars: "", yield_time_ms: 300_000 });
    const [request] = await f.broker.nextToolBatch(token);
    expect(request).toMatchObject({ wireName: "write_stdin", arguments: { session_id: 741, chars: "", yield_time_ms: 30_000 } });
    f.broker.completeTool(token, request!.callId, toolResult({ session_id: 741, exit_code: 0, output: "done" }));
    expect((await poll).structuredContent).toMatchObject({ session_id: 741, exit_code: 0 });
  } finally { await f.close(); }
}, 15_000);

test("deferred outer specs preserve exact goal/report schemas and dispatch through a fresh turn", async () => {
  const f = await fixture("deferred");
  try {
    const first = await f.register(commandTools);
    const search = f.call("codex_tool_call", { turn_token: first, wire_name: "tool_search", arguments: { query: "goal report", limit: 4 } });
    const [request] = await f.broker.nextToolBatch(first);
    expect(request).toMatchObject({ wireName: "tool_search", arguments: { query: "goal report", limit: 4 } });
    f.broker.completeTool(first, request!.callId, toolResult({ status: "completed", tools: [...goalSpecs, reportSpec] }));
    expect((await search).structuredContent).toMatchObject({ status: "completed" });

    // This is the actual outer Responses parser boundary, not a bridge-invented registry.
    const parsed = parseRequest({ model: "chatgpt-web/gpt-5.6-sol", tools: [], input: [{
      type: "tool_search_output", call_id: "fixture-search", status: "completed", tools: [...goalSpecs, reportSpec],
    }] });
    const current = await f.register(parsed.context.tools ?? []);
    f.broker.revoke(first);
    const stale = await f.call("codex_tool_inventory", { turn_token: first, query: "goal" });
    expect(stale.structuredContent).toMatchObject({ status: "notice", action_required: "conclude_summary" });
    expect(JSON.stringify(stale.content)).toContain("already finished");
    const goals = await f.call("codex_tool_inventory", { turn_token: current, query: "goal", include_schema: true });
    expect(goals.structuredContent).toMatchObject({ tools: goalSpecs.map(spec => ({ wire_name: spec.name, kind: "function", parameters: spec.parameters })), total: 3 });
    const report = await f.call("codex_tool_inventory", { turn_token: current, query: "send_message_to_thread", include_schema: true });
    expect(report.structuredContent).toMatchObject({ tools: [{ wire_name: "mcp__codex_app__send_message_to_thread", parameters: reportSchema }], total: 1 });
    for (const [wire, args] of [
      ["get_goal", {}], ["create_goal", { objective: "fixture only" }], ["update_goal", { status: "complete" }],
      ["mcp__codex_app__send_message_to_thread", { threadId: "fixture-recipient", prompt: "Fixture completion report" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const pending = f.call("codex_tool_call", { turn_token: current, wire_name: wire, arguments: args });
      const batch = await f.broker.nextToolBatch(current);
      expect(batch).toHaveLength(1);
      expect(batch[0]).toMatchObject({ wireName: wire, freeform: false, arguments: args });
      expect(batch[0]!.arguments).not.toHaveProperty("model");
      expect(batch[0]!.arguments).not.toHaveProperty("thinking");
      f.broker.completeTool(current, batch[0]!.callId, toolResult({ fixtureReceipt: wire }));
      expect((await pending).structuredContent).toEqual({ fixtureReceipt: wire });
    }
    const empty = parseRequest({ model: "chatgpt-web/gpt-5.6-sol", tools: [], input: [{ type: "tool_search_output", call_id: "fixture-empty", status: "completed", tools: [] }] });
    expect(empty.context.tools ?? []).toEqual([]);
  } finally { await f.close(); }
}, 15_000);

test("an advertised JavaScript gateway dispatches only its registered nested goal/report wires", async () => {
  const f = await fixture("gateway");
  try {
    const token = await f.register([{ name: "exec", description: "Run JavaScript with ALL_TOOLS", parameters: {}, freeform: true }, commandTools[2]!]);
    const wires = [...goalSpecs.map(spec => spec.name), "mcp__codex_app__send_message_to_thread"];
    const calls: Array<{ name: string; args: unknown }> = [];
    const implementations = Object.fromEntries(wires.map(name => [name, async (args: unknown) => {
      calls.push({ name, args });
      return { fixtureReceipt: name };
    }]));
    const nestedArgs = [
      {}, { objective: "fixture only" }, { status: "complete" },
      { threadId: "fixture-recipient", prompt: "Fixture completion report" },
    ];
    const execute = async (program: string) => {
      const content: Array<{ type: "text"; text: string }> = [];
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      await new AsyncFunction("tools", "ALL_TOOLS", "text", program)(implementations,
        wires.map((name, index) => ({ name, description: `${name} fixture only; input schema: ${JSON.stringify(index < 3 ? goalSpecs[index]!.parameters : reportSchema)}` })),
        (value: unknown) => content.push({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }));
      return { content };
    };
    const pending = f.call("codex_tool_inventory", { turn_token: token, query: "goal", include_schema: true });
    const [catalogRequest] = await f.broker.nextToolBatch(token);
    expect(catalogRequest).toMatchObject({ wireName: "exec", freeform: true });
    f.broker.completeTool(token, catalogRequest!.callId, await execute(catalogRequest!.input!));
    expect((await pending).structuredContent).toMatchObject({ total: 3, tools: goalSpecs.map(spec => ({ wire_name: spec.name, kind: "gateway" })) });
    expect(calls).toEqual([]);
    const reportInventory = f.call("codex_tool_inventory", { turn_token: token, query: "send_message_to_thread", include_schema: true });
    const [reportRequest] = await f.broker.nextToolBatch(token);
    f.broker.completeTool(token, reportRequest!.callId, await execute(reportRequest!.input!));
    expect((await reportInventory).structuredContent).toMatchObject({ total: 1, tools: [{ wire_name: wires[3], kind: "gateway" }] });
    for (const [index, wire] of wires.entries()) {
      const invocation = f.call("codex_tool_call", { turn_token: token, wire_name: wire, arguments: nestedArgs[index] });
      const [request] = await f.broker.nextToolBatch(token);
      f.broker.completeTool(token, request!.callId, await execute(request!.input!));
      expect((await invocation).isError).not.toBe(true);
    }
    expect(calls).toEqual(wires.map((name, index) => ({ name, args: nestedArgs[index] })));
    const missing = f.call("codex_tool_call", { turn_token: token, wire_name: "unregistered_goal", arguments: {} });
    const [missingRequest] = await f.broker.nextToolBatch(token);
    await expect(execute(missingRequest!.input!)).rejects.toThrow("not listed in this turn");
    f.broker.completeTool(token, missingRequest!.callId, { content: [{ type: "text", text: "not available" }], isError: true });
    expect((await missing).isError).toBe(true);
    expect(calls).toHaveLength(wires.length);
  } finally { await f.close(); }
}, 15_000);
