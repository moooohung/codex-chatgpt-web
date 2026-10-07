import { expect, spyOn, test } from "bun:test";
import { fetchWithNativeCapacityRetry, nativeCapacityRetryAfterMs, waitForNativeCapacityRetry,
  type NativeCapacityRetryEvent } from "../src/native-capacity-retry";
import { forwardNativeCodexRequest } from "../src/native-passthrough";

function fixtureClock() {
  let elapsed = 0;
  const delays: number[] = [];
  const events: NativeCapacityRetryEvent[] = [];
  return { delays, events, options: {
    now: () => elapsed, random: () => 0,
    sleep: async (ms: number, signal: AbortSignal) => {
      signal.throwIfAborted(); delays.push(ms); elapsed += ms;
    },
    onEvent: (event: NativeCapacityRetryEvent) => events.push(event),
  } };
}

test("capacity backoff respects seconds and HTTP dates, adds jitter, and succeeds", async () => {
  const fixture = fixtureClock();
  let requests = 0;
  const response = await fetchWithNativeCapacityRetry(() => new Request("https://fixture/responses"), async () => {
    requests += 1;
    return requests === 1 ? new Response("busy", { status: 503, headers: { "retry-after": "5" } }) :
      requests === 2 ? new Response("busy", { status: 503, headers: { "retry-after": "Thu, 01 Jan 1970 00:00:12 GMT" } }) :
      new Response("accepted");
  }, { ...fixture.options, random: () => 1 });
  expect(await response.text()).toBe("accepted");
  expect(requests).toBe(3);
  expect(fixture.delays).toEqual([5_000, 7_000]);
  expect(fixture.events.map(event => event.source)).toEqual(["native_upstream", "native_upstream"]);
  expect(nativeCapacityRetryAfterMs("0.5", 0)).toBe(500);
  expect(nativeCapacityRetryAfterMs("garbage", 0)).toBeUndefined();
});

test("four rejected requests exhaust the retry budget and preserve the final response", async () => {
  const fixture = fixtureClock();
  let requests = 0;
  const response = await fetchWithNativeCapacityRetry(() => new Request("https://fixture/responses"), async () => {
    requests += 1;
    return Response.json({ error: { code: "server_is_overloaded", request: requests } }, {
      status: 503, headers: { "retry-after": "1", "x-request-id": "final-upstream" },
    });
  }, fixture.options);
  expect(requests).toBe(4);
  expect(fixture.delays).toEqual([2_000, 4_000, 8_000]);
  expect(response.headers.get("retry-after")).toBe("1");
  expect(response.headers.get("x-request-id")).toBe("final-upstream");
  expect(await response.json()).toEqual({ error: { code: "server_is_overloaded", request: 4 } });
  expect(fixture.events.at(-1)?.exhausted).toBe("attempts");
});

test("Retry-After beyond the time budget is passed through without shortening it", async () => {
  const fixture = fixtureClock();
  let requests = 0;
  const response = await fetchWithNativeCapacityRetry(() => new Request("https://fixture/responses"), async () => {
    requests += 1;
    return new Response("busy-original", { status: 503, headers: { "retry-after": "60" } });
  }, fixture.options);
  expect(requests).toBe(1);
  expect(fixture.delays).toEqual([]);
  expect(await response.text()).toBe("busy-original");
  expect(response.headers.get("retry-after")).toBe("60");
  expect(fixture.events.at(-1)?.exhausted).toBe("budget");
});

test("quota, auth, maintenance, and accepted response streams are never replayed", async () => {
  for (const status of [200, 400, 401, 403, 429, 502]) {
    let requests = 0;
    const fixture = fixtureClock();
    const body = status === 200 ? 'data: {"error":{"code":"server_is_overloaded"}}\n\n' : "original";
    const response = await fetchWithNativeCapacityRetry(() => new Request("https://fixture/responses"), async () => {
      requests += 1;
      return new Response(body, { status });
    }, fixture.options);
    expect(requests).toBe(1);
    expect(await response.text()).toBe(body);
    expect(fixture.delays).toEqual([]);
  }
});

test("uncertain transport failure and a truncated accepted stream are not replayed", async () => {
  let requests = 0;
  const request = () => new Request("https://fixture/responses");
  await expect(fetchWithNativeCapacityRetry(request, async () => {
    requests += 1;
    throw new Error("ECONNRESET after possible acceptance");
  })).rejects.toThrow("ECONNRESET");
  expect(requests).toBe(1);
  const response = await fetchWithNativeCapacityRetry(request, async () => {
    requests += 1;
    return new Response(new ReadableStream({ start(controller) { controller.error(new Error("truncated")); } }));
  });
  await expect(response.text()).rejects.toThrow("truncated");
  expect(requests).toBe(2);
});

test("cancellation interrupts the real wait and prevents another request", async () => {
  const abort = new AbortController();
  let requests = 0;
  const result = fetchWithNativeCapacityRetry(() => new Request("https://fixture/responses", { signal: abort.signal }), async () => {
    requests += 1;
    return new Response("busy", { status: 503 });
  }, { onEvent: () => setTimeout(() => abort.abort(new Error("fixture cancelled")), 0) });
  await expect(result).rejects.toThrow("fixture cancelled");
  expect(requests).toBe(1);
  await expect(waitForNativeCapacityRetry(60_000, abort.signal)).rejects.toThrow("fixture cancelled");
});

test("one request's capacity wait does not block an independent native request", async () => {
  let release!: () => void;
  let waiting!: () => void;
  const ready = new Promise<void>(resolve => { waiting = resolve; });
  let busyRequests = 0;
  const busy = fetchWithNativeCapacityRetry(() => new Request("https://fixture/responses"), async () => {
    busyRequests += 1;
    return new Response("busy", { status: 503 });
  }, { sleep: () => new Promise<void>(resolve => { release = resolve; waiting(); }) });
  await ready;
  let nativeRequests = 0;
  const native = await fetchWithNativeCapacityRetry(() => new Request("https://other-account/responses"), async () => {
    nativeRequests += 1;
    return new Response("independent-native");
  });
  expect(await native.text()).toBe("independent-native");
  expect(nativeRequests).toBe(1);
  expect(busyRequests).toBe(1);
  // Stop subsequent waits without involving any other request's state.
  for (let index = 0; index < 3; index += 1) { release(); await Bun.sleep(0); }
  expect((await busy).status).toBe(503);
});

test("native retries preserve compressed bytes, model, reasoning and incoming credentials", async () => {
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const endpoint of ["responses", "responses/compact"] as const) {
      const body = Bun.zstdCompressSync(Buffer.from(JSON.stringify({ model: "gpt-6.1-sol",
        reasoning: { effort: "high" }, input: [{ role: "user", content: "PRIVATE_PROMPT" }] })));
      const bytes = new Uint8Array(body).buffer;
      let requests = 0;
      const fixture = fixtureClock();
      const response = await forwardNativeCodexRequest(new Request("http://127.0.0.1/v1/" + endpoint, {
        method: "POST", headers: { authorization: "Bearer PRIVATE_TOKEN", "content-encoding": "zstd",
          "chatgpt-account-id": "PRIVATE_ACCOUNT" }, body: bytes,
      }), endpoint, async request => {
        requests += 1;
        expect(request.url).toBe("https://chatgpt.com/backend-api/codex/" + endpoint);
        expect(request.headers.get("authorization")).toBe("Bearer PRIVATE_TOKEN");
        expect(request.headers.get("chatgpt-account-id")).toBe("PRIVATE_ACCOUNT");
        expect(Buffer.from(await request.arrayBuffer())).toEqual(Buffer.from(body));
        return new Response(requests === 1 ? "busy" : "native-answer", { status: requests === 1 ? 503 : 200 });
      }, undefined, fixture.options);
      expect(requests).toBe(2);
      expect(await response.text()).toBe("native-answer");
    }
    expect(warnings.mock.calls.map(call => String(call[0])).join("\n")).not.toContain("PRIVATE_");
  } finally { warnings.mockRestore(); }
});

test("standalone image creation and search are not automatically replayed", async () => {
  for (const endpoint of ["images/generations", "images/edits", "alpha/search"] as const) {
    let requests = 0;
    const response = await forwardNativeCodexRequest(new Request("http://127.0.0.1/v1/" + endpoint, {
      method: "POST", headers: { authorization: "Bearer fixture" }, body: "{}",
    }), endpoint, async () => { requests += 1; return new Response("busy", { status: 503 }); });
    expect(requests).toBe(1);
    expect(await response.text()).toBe("busy");
  }
});
