import { expect, test } from "bun:test";
import { launcherPageHeapReclaimPolicy, reclaimLauncherPageHeap } from "../src/launcher-browser-host";

test("page heap reclaim policy defaults to 768 MB once a minute and can be disabled", () => {
  expect(launcherPageHeapReclaimPolicy({})).toEqual({ thresholdBytes: 768 * 1024 * 1024, intervalMs: 60_000 });
  expect(launcherPageHeapReclaimPolicy({ CODEX_WEB_GPT_PAGE_GC_MB: "0" }).thresholdBytes).toBe(0);
  expect(launcherPageHeapReclaimPolicy({ CODEX_WEB_GPT_PAGE_GC_MB: "1024" }).thresholdBytes).toBe(1024 * 1024 * 1024);
  expect(launcherPageHeapReclaimPolicy({ CODEX_WEB_GPT_PAGE_GC_MB: "abc" }).thresholdBytes).toBe(768 * 1024 * 1024);
});

test("page heap reclaim collects only above the threshold and reads nothing else", async () => {
  for (const [used, expected] of [[100, "below_threshold"], [900, "collected"]] as const) {
    const calls: string[] = [];
    const session = { send: async (method: string) => {
      calls.push(method);
      return method === "Runtime.getHeapUsage" ? { usedSize: used * 1024 * 1024, totalSize: 0 } : {};
    } } as never;
    expect(await reclaimLauncherPageHeap(session, 768 * 1024 * 1024)).toBe(expected);
    expect(calls).toEqual(expected === "collected" ? ["Runtime.getHeapUsage", "HeapProfiler.collectGarbage"] : ["Runtime.getHeapUsage"]);
  }
});
