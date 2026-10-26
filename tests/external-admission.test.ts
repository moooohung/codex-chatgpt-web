import { expect, test } from "bun:test";
import { ExternalAdmission, waitExternal } from "../src/external-admission";

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
