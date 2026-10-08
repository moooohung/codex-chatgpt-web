import { expect, test } from "bun:test";
import { createOwnedTargetCdpTransport } from "../src/launcher-owned-cdp";

async function fixture(run: (transport: ReturnType<typeof createOwnedTargetCdpTransport>, sent: any[], received: any[]) => Promise<void>) {
  const sent: any[] = [], received: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response(null, { status: 400 }); },
    websocket: { message(socket, data) {
      const m = JSON.parse(String(data)); sent.push(m);
      if (m.method === "Target.attachToBrowserTarget") {
        socket.send(JSON.stringify({ id: m.id, result: { sessionId: "browser-session" } }));
      } else if (m.method === "Target.attachToTarget") {
        socket.send(JSON.stringify({ method: "Target.attachedToTarget", sessionId: m.sessionId, params: { sessionId: "owned-session", targetInfo: { targetId: "owned", type: "page" }, waitingForDebugger: false } }));
        socket.send(JSON.stringify({ id: m.id, sessionId: m.sessionId, result: { sessionId: "owned-session" } }));
      } else if (m.method === "Target.getTargets") {
        socket.send(JSON.stringify({ id: m.id, result: { targetInfos: [{ targetId: "owned" }, { targetId: "busy-other" }] } }));
      } else if (m.method === "Target.setAutoAttach" && m.sessionId) {
        socket.send(JSON.stringify({ method: "Target.attachedToTarget", sessionId: m.sessionId, params: { sessionId: "child-session", targetInfo: { targetId: "child", type: "iframe" }, waitingForDebugger: true } }));
        socket.send(JSON.stringify({ id: m.id, sessionId: m.sessionId, result: {} }));
      } else socket.send(JSON.stringify({ id: m.id, sessionId: m.sessionId, result: {} }));
    } },
  });
  const transport = createOwnedTargetCdpTransport(`ws://127.0.0.1:${server.port}/browser`, "owned");
  transport.onmessage = m => received.push(m);
  try { await run(transport, sent, received); } finally { transport.close(); server.stop(true); }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
  expect(check()).toBeTrue();
}

test("owned CDP replaces browser-wide debugger auto-attach with one exact host target", () => fixture(async (transport, sent, received) => {
  transport.send({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } });
  await until(() => received.some(m => m.id === 1));
  expect(sent).toEqual([{ id: 1, method: "Target.attachToTarget", params: { targetId: "owned", flatten: true } }]);
  expect(received.find(m => m.id === 1)).toEqual({ id: 1, result: {} });
  expect(received[0].params.waitingForDebugger).toBeFalse();
  transport.send({ id: 2, method: "Target.setAutoAttach", params: { autoAttach: true } });
  await until(() => received.some(m => m.id === 2));
  expect(sent.length).toBe(1);
}));

test("owned CDP retains child iframe and worker initialization", () => fixture(async (transport, sent, received) => {
  transport.send({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } });
  await until(() => received.some(m => m.id === 1));
  transport.send({ id: 2, sessionId: "owned-session", method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } });
  await until(() => received.some(m => m.id === 2));
  transport.send({ id: 3, sessionId: "child-session", method: "Runtime.runIfWaitingForDebugger" });
  await until(() => received.some(m => m.id === 3));
  expect(sent.at(-1).sessionId).toBe("child-session");
}));

test("owned CDP permits Playwright newCDPSession through its intermediate browser target", () => fixture(async (transport, sent, received) => {
  transport.send({ id: 1, method: "Target.attachToBrowserTarget" });
  await until(() => received.some(m => m.id === 1));
  transport.send({ id: 2, sessionId: "browser-session", method: "Target.attachToTarget", params: { targetId: "owned", flatten: true } });
  await until(() => received.some(m => m.id === 2));
  transport.send({ id: 3, sessionId: "owned-session", method: "Target.getTargetInfo" });
  transport.send({ id: 4, sessionId: "browser-session", method: "Target.attachToTarget", params: { targetId: "foreign", flatten: true } });
  await until(() => received.some(m => m.id === 3) && received.some(m => m.id === 4));
  expect(sent.map(m => m.id)).toEqual([1, 2, 3]);
  expect(received.find(m => m.id === 3).error).toBeUndefined();
  expect(received.find(m => m.id === 4).error.message).toContain("outside the owned");
  expect(received.find(m => m.id === 4).sessionId).toBe("browser-session");
}));

test("owned CDP hides other targets and rejects foreign sessions or tab creation", () => fixture(async (transport, sent, received) => {
  transport.send({ id: 1, method: "Target.getTargets" });
  transport.send({ id: 2, method: "Target.attachToTarget", params: { targetId: "busy-other", flatten: true } });
  transport.send({ id: 3, sessionId: "foreign", method: "Page.navigate", params: { url: "https://example.com" } });
  transport.send({ id: 4, method: "Target.createTarget", params: { url: "about:blank" } });
  transport.send({ id: 5, method: "Browser.close" });
  await until(() => received.length === 5);
  expect(sent.map(m => m.id)).toEqual([1]);
  expect(received.find(m => m.id === 1).result.targetInfos).toEqual([{ targetId: "owned" }]);
  for (const id of [2, 3, 4, 5]) expect(received.find(m => m.id === id).error.message).toContain("outside the owned");
  expect(received.find(m => m.id === 3).sessionId).toBe("foreign");
}));

test("owned CDP validates its loopback endpoint and supports pre-connect cancellation", () => {
  for (const endpoint of ["wss://127.0.0.1:1234/", "ws://example.com:1234/", "ws://user:password@127.0.0.1:1234/", "ws://127.0.0.1:1234/?token=secret"]) {
    expect(() => createOwnedTargetCdpTransport(endpoint, "owned")).toThrow("loopback");
  }
  const controller = new AbortController(); controller.abort();
  expect(() => createOwnedTargetCdpTransport("ws://127.0.0.1:1234/", "owned", controller.signal)).toThrow("aborted");
});

test("owned CDP closes the transport on cancellation without sending Browser.close", async () => {
  const controller = new AbortController();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) {
    if (server.upgrade(request)) return; return new Response(null, { status: 400 });
  }, websocket: { message() { throw new Error("No browser commands expected"); } } });
  const transport = createOwnedTargetCdpTransport(`ws://127.0.0.1:${server.port}/browser`, "owned", controller.signal);
  let closed = 0;
  transport.onclose = () => { closed++; };
  try { controller.abort(); await until(() => closed === 1); await Bun.sleep(10); expect(closed).toBe(1); }
  finally { transport.close(); server.stop(true); }
});
