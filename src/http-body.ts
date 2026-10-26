const MAX_ENCODED_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_REQUEST_BYTES = 128 * 1024 * 1024;

function assertWithinLimit(bytes: number, limit: number, label: string): void {
  if (bytes > limit) throw new Error(`${label} exceeds ${limit} bytes`);
}

export async function readJsonRequestBody(request: Request, limits: {
  encodedBytes?: number; decodedBytes?: number; signal?: AbortSignal;
} = {}): Promise<unknown> {
  const encodedLimit = limits.encodedBytes ?? MAX_ENCODED_REQUEST_BYTES;
  const decodedLimit = limits.decodedBytes ?? MAX_DECODED_REQUEST_BYTES;
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength)) {
    assertWithinLimit(declaredLength, encodedLimit, "Encoded request body");
  }

  const contentEncoding = (request.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  if (!["", "identity", "zstd"].includes(contentEncoding)) {
    throw new Error(`Unsupported Content-Encoding: ${contentEncoding}`);
  }
  const signal = limits.signal ? AbortSignal.any([request.signal, limits.signal]) : request.signal;
  signal.throwIfAborted();
  const reader = request.body?.getReader();
  const cancel = () => { void reader?.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let encodedBytes = 0, decodedBytes = 0;
  const chunks: Buffer[] = [];
  const source = Readable.from((async function* () {
    if (!reader) return;
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) return;
      encodedBytes += next.value.byteLength;
      assertWithinLimit(encodedBytes, encodedLimit, "Encoded request body");
      yield next.value;
    }
  })());
  const sink = new Writable({ write(chunk: Buffer, _encoding, callback) {
    try {
      decodedBytes += chunk.byteLength;
      assertWithinLimit(decodedBytes, decodedLimit, "Decoded request body");
      chunks.push(Buffer.from(chunk));
      callback();
    } catch (error) { callback(error as Error); }
  } });
  try {
    if (contentEncoding === "zstd") await pipeline(source, createZstdDecompress({ chunkSize: 16 * 1024 }), sink, { signal });
    else await pipeline(source, sink, { signal });
  } finally {
    signal.removeEventListener("abort", cancel);
    // A tee cancellation settles only after its sibling closes. Cleanup must not block
    // the rejection response while the caller still owns an unused native clone.
    void reader?.cancel().catch(() => {});
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, decodedBytes));
  return JSON.parse(text) as unknown;
}
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
