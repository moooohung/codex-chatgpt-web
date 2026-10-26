import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";

test("unsafe external credentials disable only reserved-prefix admission, never native startup", async () => {
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  const home = mkdtempSync(join(tmpdir(), "cgw-disabled-"));
  process.env.CODEX_CHATGPT_WEB_HOME = home;
  mkdirSync(join(home, "external-client"));
  // A directory in place of a token must fail even if the parent's ACL is owner-only.
  mkdirSync(join(home, "external-client", "token"));
  let native = 0;
  const server = startServer({ ...defaultConfig("browser-only"), port: 0 }, {
    adapterFactory: () => ({ name: "native", async runTurn(_parsed, _incoming, emit) {
      native++; emit({ type: "text_delta", text: "native" }); emit({ type: "done" });
    } }),
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    for (const path of ["/healthz", "/admin/drain", "/v1/models", "/v1/responses"]) {
      expect((await fetch(`${base}${path}`, { headers: { host: "rebind.example" } })).status).toBe(403);
    }
    const send = (authorization?: string) => fetch(`${base}/v1/responses`, { method: "POST",
      headers: authorization ? { authorization } : {}, body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", input: "OK" }) });
    expect((await send()).status).toBe(200);
    expect((await send(`Bearer cwext_${"a".repeat(64)}`)).status).toBe(503);
    expect(native).toBe(1);
  } finally {
    await server.stop(true);
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
