import { expect, test } from "bun:test";
import { ExternalAdmission, externalBrowserCapacity, waitExternal } from "../src/external-admission";
import { ChatGptBrowserRunQueue, resolveMaxChatGptBrowserTabs } from "../src/adapters/chatgpt-web/concurrency";

test("external outstanding requests and queue deadlines are bounded", async () => {
  const gate = new ExternalAdmission({ active: 1, outstanding: 2, queueMs: 20, turnMs: 500 });
  const signal = new AbortController().signal;
  const first = await gate.acquire(signal);
  const queued = gate.acquire(signal);
  await expect(gate.acquire(signal)).rejects.toThrow("capacity exceeded");
  await expect(queued).rejects.toThrow("queue deadline");
  first.release();
  (await gate.acquire(signal)).release();
});

test("turn deadlines release observers but not physically unsettled owners", async () => {
  const gate = new ExternalAdmission({ active: 1, outstanding: 1, queueMs: 20, turnMs: 20 });
  const lease = await gate.acquire(new AbortController().signal);
  await expect(waitExternal(new Promise(() => {}), lease.signal)).rejects.toThrow("turn deadline");
  await expect(gate.acquire(new AbortController().signal)).rejects.toThrow("capacity exceeded");
  lease.release();
  (await gate.acquire(new AbortController().signal)).release();
});

for (const [configuredTabs, expectedExternal] of [[1, 0], [2, 0], [4, 2], [8, 4]] as const) {
  test(`${configuredTabs} shared browser slots reserve native capacity under saturated external admission`, async () => {
    const tabs = resolveMaxChatGptBrowserTabs(String(configuredTabs));
    const capacity = externalBrowserCapacity(tabs);
    expect(capacity).toBe(expectedExternal);
    expect(tabs - capacity).toBeGreaterThanOrEqual(1);
    const gate = new ExternalAdmission({ active: capacity, outstanding: 8, queueMs: 100, turnMs: 1_000 });
    const scheduler = new ChatGptBrowserRunQueue<void>(tabs);
    const signal = new AbortController().signal;
    let releasePhysical!: () => void;
    const held = new Promise<void>(resolve => { releasePhysical = resolve; });
    const external: Promise<void>[] = [];
    try {
      if (!capacity) await expect(gate.acquire(signal)).rejects.toThrow("reserved for native");
      for (let i = 0; i < capacity; i++) {
        const lease = await gate.acquire(signal);
        external.push(scheduler.run(() => held, lease.signal).finally(() => lease.release()));
      }
      let nativeStarted = false;
      await scheduler.run(async () => { nativeStarted = true; });
      expect(nativeStarted).toBeTrue();
    } finally {
      releasePhysical();
      await Promise.all(external);
      scheduler.cancelPending();
    }
  });
}
