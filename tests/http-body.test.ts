import { expect, test } from "bun:test";
import { readJsonRequestBody } from "../src/http-body";

test("decodes Codex zstd-compressed JSON request bodies", async () => {
  const body = { model: "chatgpt-web/pro", reasoning: { effort: "ultra" }, input: [{ role: "user", content: "hello" }] };
  const compressed = Bun.zstdCompressSync(Buffer.from(JSON.stringify(body)));
  const encoded = new ArrayBuffer(compressed.byteLength);
  new Uint8Array(encoded).set(compressed);
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "zstd" },
    body: encoded,
  });

  expect(await readJsonRequestBody(request)).toEqual(body);
});

test("rejects unsupported request content encodings", async () => {
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "br" },
    body: "{}",
  });

  await expect(readJsonRequestBody(request)).rejects.toThrow("Unsupported Content-Encoding: br");
});

test("streaming encoded limits cancel the source before consuming the complete request", async () => {
  let pulls = 0, cancelled = false;
  const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024)); },
    cancel() { cancelled = true; } });
  const request = new Request("http://localhost", { method: "POST", body, duplex: "half" } as RequestInit);
  await expect(readJsonRequestBody(request, { encodedBytes: 2048 })).rejects.toThrow("Encoded request body");
  expect(pulls).toBeLessThan(10);
  expect(cancelled).toBeTrue();
});

test("streaming zstd decoded limits stop expansion of compressed oversized JSON", async () => {
  const body = Bun.zstdCompressSync(Buffer.from(JSON.stringify("x".repeat(1024 * 1024))));
  const request = new Request("http://localhost", { method: "POST", headers: { "content-encoding": "zstd" }, body });
  await expect(readJsonRequestBody(request, { decodedBytes: 4096 })).rejects.toThrow("Decoded request body");
});

test("a stalled body reader is cancelled by its deadline", async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const request = new Request("http://localhost", { method: "POST", body, duplex: "half" } as RequestInit);
  await expect(readJsonRequestBody(request, { signal: AbortSignal.timeout(20) })).rejects.toThrow();
  expect(cancelled).toBeTrue();
});
