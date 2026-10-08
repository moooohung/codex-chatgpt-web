import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { resolveChatGptPlusFallback } from "../src/adapters/chatgpt-web/model-selection";

test("Plus fallback keeps Sol's family and routes GPT-6 Pro to GPT-5.6 High only", () => {
  for (const family of ["5.6", "6"] as const) {
    expect(resolveChatGptPlusFallback(family, "xhigh", "plus")).toEqual({ family, effort: "high" });
    expect(resolveChatGptPlusFallback(family, "max", "plus")).toEqual({ family: "5.6", effort: "high" });
    for (const effort of ["low", "medium", "high"] as const) expect(resolveChatGptPlusFallback(family, effort, "plus")).toBeUndefined();
    for (const plan of ["pro", "prolite", "free", "", "unknown"]) expect(resolveChatGptPlusFallback(family, "max", plan)).toBeUndefined();
  }
});

test.each([ ["5.6", "xhigh", "5.6"], ["6", "xhigh", "6"], ["6", "max", "5.6"] ] as const)(
  "Plus %s/%s unavailability verifies %s/High without Send or reload", async (family, effort, effectiveFamily) => {
  const selections: unknown[][] = [];
  const capabilities = { solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const page = {
    keyboard: { press: async (key: string) => expect(key).toBe("Escape") },
    evaluate: async () => ({ userId: "fixture-user", accountId: "fixture-account", planType: "plus", structure: "personal", needsAttention: false }),
    url: () => "https://chatgpt.com/?temporary-chat=true",
    reload: async () => { throw new Error("A supported fallback must not reload the owned conversation"); },
  };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    selectModelAndEffort: async (...args: unknown[]) => {
      selections.push(args);
      if (selections.length === 1) throw new ChatGptWebAdapterError("Requested effort is unavailable", {
        status: 400, errorType: "invalid_request_error", code: "chatgpt_effort_unavailable", retryable: false,
      });
      expect(args[2]).toBe("high"); expect(args[6]).toBe(effectiveFamily);
      expect(args[3]).toMatchObject({ proAvailable: false, extraHighAvailable: false });
      return { effort: "high", modelFamily: effectiveFamily, selection: { url: page.url(), label: "High" } };
    },
  });
  const result = await worker.selectModelAndEffortWithRecovery(page, "gpt-5.6-sol", effort, capabilities, undefined, false, family);
  expect(result).toMatchObject({ effort: "high", modelFamily: effectiveFamily, accountFallback: { capabilities: { proAvailable: false } } });
  expect(selections).toHaveLength(2);
});

test.each([
  new ChatGptWebAdapterError("Selected model is unavailable", {
    status: 400, errorType: "invalid_request_error", code: "model_version_unavailable", retryable: false,
  }),
  new DOMException("Selection was cancelled", "AbortError"),
])("model recovery preserves terminal rejection without reloading: %s", async original => {
  let attempts = 0;
  let reloads = 0;
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    selectModelAndEffort: async () => { attempts++; throw original; },
  });
  await expect(worker.selectModelAndEffortWithRecovery(
    { reload: async () => { reloads++; } }, "gpt-5.6-sol", "high", {},
  )).rejects.toBe(original);
  expect(attempts).toBe(1);
  expect(reloads).toBe(0);
});

test("selectModelAndEffortWithRecovery reloads page and retries on transient control error", async () => {
  let attempts = 0;
  let reloads = 0;
  let surfacesPrepared = 0;
  const diagnostics: string[] = [];
  const selections: unknown[][] = [];

  const page = {
    reload: async () => {
      reloads += 1;
    },
  };

  const capabilities = { solAvailable: true, extraHighAvailable: true, proAvailable: true };

  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { useSavedChats: true },
    selectModelAndEffort: async (...args: unknown[]) => {
      selections.push(args);
      attempts += 1;
      if (attempts === 1) {
        throw new ChatGptWebAdapterError("ChatGPT model controls are unavailable. Reload ChatGPT and retry the task.", {
          status: 502,
          errorType: "server_error",
          code: "upstream_server_error",
          retryable: true,
        });
      }
      return { model: "chatgpt-5.6", effort: "high", displayLabel: "High" };
    },
    prepareChatSurface: async () => {
      surfacesPrepared += 1;
    },
  });

  const select = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffortWithRecovery: Function;
  }).selectModelAndEffortWithRecovery;

  const result = await select.call(
    worker,
    page,
    "chatgpt-5.6",
    "high",
    capabilities,
    async (checkpoint: string) => { diagnostics.push(checkpoint); },
    false,
    "5.6",
    false,
  );

  expect(attempts).toBe(2);
  expect(reloads).toBe(1);
  expect(surfacesPrepared).toBe(1);
  expect(result.effort).toBe("high");
  expect(selections.every(args => args[1] === "chatgpt-5.6" && args[2] === "high" && args[6] === "5.6")).toBe(true);
  expect(diagnostics).toContain("model-controls-recovery-reload-attempted");
  expect(diagnostics).toContain("model-controls-recovery-reloaded");
});

test("selectModelAndEffortWithRecovery does NOT reload on explicit usage limit error", async () => {
  let attempts = 0;
  let reloads = 0;

  const page = {
    reload: async () => {
      reloads += 1;
    },
  };

  const capabilities = { solAvailable: true, extraHighAvailable: true, proAvailable: true };

  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { useSavedChats: true },
    selectModelAndEffort: async () => {
      attempts += 1;
      throw new ChatGptWebAdapterError(
        "ChatGPT effort slider does not expose item index 4 (min=0; max=3) ChatGPT may have temporarily hidden Pro because you reached its usage limit.",
        {
          status: 502,
          errorType: "server_error",
          code: "upstream_server_error",
          retryable: false,
        },
      );
    },
  });

  const select = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffortWithRecovery: Function;
  }).selectModelAndEffortWithRecovery;

  await expect(
    select.call(
      worker,
      page,
      "chatgpt-5.6",
      "max",
      capabilities,
      undefined,
      false,
      "5.6",
      false,
    ),
  ).rejects.toThrow("usage limit");

  expect(attempts).toBe(1);
  expect(reloads).toBe(0);
});

test("selectModelAndEffortWithRecovery rethrows original error if reload fails", async () => {
  let attempts = 0;
  let reloads = 0;

  const page = {
    reload: async () => {
      reloads += 1;
      throw new Error("Navigation timeout during reload");
    },
  };

  const capabilities = { solAvailable: true, extraHighAvailable: true, proAvailable: true };

  const originalError = new ChatGptWebAdapterError("ChatGPT model controls are unavailable.", {
    status: 502,
    errorType: "server_error",
    code: "upstream_server_error",
    retryable: true,
  });

  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { useSavedChats: true },
    selectModelAndEffort: async () => {
      attempts += 1;
      throw originalError;
    },
  });

  const select = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffortWithRecovery: Function;
  }).selectModelAndEffortWithRecovery;

  await expect(
    select.call(
      worker,
      page,
      "chatgpt-5.6",
      "high",
      capabilities,
      undefined,
      false,
      "5.6",
      false,
    ),
  ).rejects.toThrow("ChatGPT model controls are unavailable.");

  expect(attempts).toBe(1);
  expect(reloads).toBe(1);
});
