import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { assertChatGptModelFamily, chatGptModelSelectionStageError, chatGptSelectionFamily } from "../src/adapters/chatgpt-web/model-selection";

test("explicit GPT-6 selection keeps its version at all efforts; staging is chosen separately", () => {
  expect(chatGptSelectionFamily("6", "low")).toBe("6");
  expect(chatGptSelectionFamily("6", "xhigh")).toBe("6");
  expect(chatGptSelectionFamily("6", "max")).toBe("6");
  expect(chatGptSelectionFamily("5.6", "max")).toBe("5.6");
});

test.each([
  ["5.6 High, 3 of 5.", "2", "false", "chatgpt_model_verification_failed", "family-not-checked"],
  ["5.6 High, 3 of 5.", "1", "true", "chatgpt_effort_verification_failed", "effort-position-mismatch"],
  ["7 Pro, 5 of 5.", "2", "true", "chatgpt_model_verification_failed", "model-evidence-mismatch"],
] as const)("verification distinguishes proof failures: %s / %s / %s", async (announcement, value, checked, code, reason) => {
  const menu: any = { menu: { getByRole: () => ({count: async () => 1, getAttribute: async () => checked}) },
    slider: {getAttribute: async (name: string) => ({"aria-valuemin":"0","aria-valuemax":"4","aria-valuenow":value}[name]), evaluate: async () => [announcement]} };
  let failure: any;
  try { await assertChatGptModelFamily(menu, "5.6", "high", 2); } catch(error) {failure=error;}
  expect(failure).toMatchObject({code,retryable:false});expect(failure.message).toContain(reason);
});

test("multipart stage messages preserve the original failure and accepted earlier-part uncertainty", async () => {
  const worker: any = Object.create(ChatGptBrowserWorker.prototype);
  const original = new ChatGptWebAdapterError("model/effort verification failed. This part was not sent.", {
    status:400,errorType:"invalid_request_error",code:"chatgpt_model_verification_failed",retryable:false,
  });
  let failure: any;
  try { await worker.runStage("81c69197ed5b", "multipart_stage_2_send", 500, async () => {throw original;}); }catch(error){failure=error;}
  expect(failure).toMatchObject({code:original.code,retryable:false,cause:original});
  expect(failure.message).toContain("multipart_stage_2_send");
  expect(failure.message).toContain("Earlier multipart parts may already have been accepted");
  const ordinary: any=chatGptModelSelectionStageError(original,"effort_selection");
  expect(ordinary.message).not.toContain("Earlier multipart");
  const other=new Error("network");expect(chatGptModelSelectionStageError(other,"send")).toBe(other);
});
