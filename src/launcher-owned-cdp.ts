import type { ConnectOverCDPTransport } from "playwright-core";

type Message = {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { code: number; message: string };
};

// A normal browser-wide Playwright connection auto-attaches to every worker tab
// and waits for every renderer to initialize. One stalled navigation then holds
// up unrelated workers. Explicitly attach only the host-issued target instead;
// owned-page child-frame/worker auto-attachment remains unchanged.
export function createOwnedTargetCdpTransport(
  endpoint: string,
  targetId: string,
  abortSignal?: AbortSignal,
): ConnectOverCDPTransport {
  const url = new URL(endpoint);
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !url.port
    || url.username || url.password || url.search || url.hash) {
    throw new Error("Owned browser transport requires a loopback CDP WebSocket");
  }
  if (!targetId.trim()) throw new Error("Owned browser transport requires a target id");
  if (abortSignal?.aborted) throw new DOMException("Launcher browser connection aborted", "AbortError");
  const socket = new WebSocket(endpoint);
  const queued: Message[] = [];
  const autoAttachCommands = new Set<number>();
  const targetListCommands = new Set<number>();
  const sessions = new Set<string>();
  const childTargets = new Set<string>();
  let attached = false;
  let closed = false;
  let notified = false;

  const forward = (message: Message) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    else if (!closed) queued.push(message);
  };
  const reply = (message: Message, error?: string) => queueMicrotask(() => {
    if (!closed) transport.onmessage?.({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), ...(error
      ? { error: { code: -32000, message: error } }
      : { result: {} }) });
  });
  const notifyClosed = (reason: string) => {
    if (notified) return;
    notified = true;
    closed = true;
    queued.length = 0;
    abortSignal?.removeEventListener("abort", closeOnAbort);
    transport.onclose?.(reason);
  };
  const transport: ConnectOverCDPTransport = {
    send(value) {
      const message = value as Message;
      if (closed) return;
      if (message.sessionId) {
        if (!sessions.has(message.sessionId)) {
          reply(message, "CDP session is outside the owned browser surface");
          return;
        }
        forward(message);
        return;
      }
      if (message.method === "Target.setAutoAttach") {
        if (!message.params?.autoAttach || attached) { reply(message); return; }
        attached = true;
        autoAttachCommands.add(message.id!);
        forward({ id: message.id, method: "Target.attachToTarget", params: { targetId, flatten: true } });
        return;
      }
      if (message.method === "Target.createTarget" || message.method === "Browser.close"
        || (message.params?.targetId && message.params.targetId !== targetId
          && !childTargets.has(message.params.targetId))) {
        reply(message, "CDP command is outside the owned browser surface");
        return;
      }
      if (message.method === "Target.getTargets") targetListCommands.add(message.id!);
      forward(message);
    },
    close() {
      if (closed) return;
      closed = true;
      queued.length = 0;
      abortSignal?.removeEventListener("abort", closeOnAbort);
      socket.close(); // Disconnect only; never close the launcher or its tabs.
    },
  };
  const closeOnAbort = () => {
    transport.close();
    notifyClosed("Launcher browser connection aborted");
  };
  abortSignal?.addEventListener("abort", closeOnAbort, { once: true });
  socket.addEventListener("open", () => {
    if (closed) { socket.close(); return; }
    for (const message of queued.splice(0)) forward(message);
  });
  socket.addEventListener("message", event => {
    if (closed) return;
    let message: Message;
    try { message = JSON.parse(String(event.data)) as Message; }
    catch { transport.close(); notifyClosed("Invalid CDP response"); return; }
    if (message.method === "Target.attachedToTarget") {
      if (message.sessionId ? !sessions.has(message.sessionId) : message.params?.targetInfo?.targetId !== targetId) return;
      sessions.add(message.params!.sessionId);
      childTargets.add(message.params!.targetInfo.targetId);
    } else if (message.method === "Target.detachedFromTarget") {
      if (!sessions.has(message.params?.sessionId)) return;
      sessions.delete(message.params!.sessionId);
    } else if (message.sessionId && !sessions.has(message.sessionId)) {
      return;
    } else if (message.method?.startsWith("Target.") && message.params?.targetInfo
      && message.params.targetInfo.targetId !== targetId && !childTargets.has(message.params.targetInfo.targetId)) {
      return;
    }
    if (message.id !== undefined && autoAttachCommands.delete(message.id) && !message.error) message.result = {};
    if (message.id !== undefined && targetListCommands.delete(message.id) && message.result?.targetInfos) {
      message.result.targetInfos = message.result.targetInfos.filter((info: { targetId: string }) => info.targetId === targetId);
    }
    transport.onmessage?.(message);
  });
  socket.addEventListener("close", event => notifyClosed(event.reason || "CDP transport disconnected"));
  socket.addEventListener("error", () => { transport.close(); notifyClosed("CDP WebSocket connection failed"); });
  return transport;
}
