import { expect, test } from "bun:test";
import { clampChatGptEffort, chatGptEffortMetadata, isChatGptEffortSelection } from "../src/adapters/chatgpt-web/effort-ceiling";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import type { AdapterEvent } from "../src/types";
import { effortCeilingNotice } from "../launcher/src/effort-notice";

const caps = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const mode = (effort: string) => resolveChatGptWebModelMode("gpt-5.6-sol", effort, caps);

test("fewer positions clamp High to the highest unlocked tick", () => {
  expect(clampChatGptEffort(mode("high"), [true, true])).toMatchObject({ effort: "medium", uiEffortIndex: 1 });
  expect(clampChatGptEffort(mode("xhigh"), [true, true])).toMatchObject({ effort: "medium" });
});
test("a locked tick uses the nearest lower unlocked one without upgrading", () => {
  expect(clampChatGptEffort(mode("high"), [true, true, false, true])).toMatchObject({ effort: "medium" });
  expect(clampChatGptEffort(mode("high"), [true, false, false, true])).toMatchObject({ effort: "low" });
  expect(clampChatGptEffort(mode("medium"), [true, true, true, true])).toEqual(mode("medium"));
});
test("Pro remains an error when missing or locked, even with other unlocked ticks", () => {
  for (const available of [[true, true], [true, true, true, true, false]]) {
    expect(() => clampChatGptEffort(mode("max"), available)).toThrow("requested model family and mode");
  }
  expect(() => clampChatGptEffort(mode("high"), [false, false])).toThrow("This part was not sent");
});
test("actual effort crosses JSON and streaming Responses metadata", async () => {
  const selection = { family: "5.6" as const, requestedEffort: "high" as const, actualEffort: "medium" as const,
    requestedPosition: 3, actualPosition: 2 };
  expect(isChatGptEffortSelection(selection)).toBe(true);
  expect(isChatGptEffortSelection({ ...selection, actualPosition: 3 })).toBe(false);
  expect(isChatGptEffortSelection({ ...selection, requestedPosition: 5, requestedEffort: "max" })).toBe(false);
  const metadata = chatGptEffortMetadata(selection);
  const events: AdapterEvent[] = [{ type: "response_metadata", metadata }, { type: "text_delta", text: "OK" }, { type: "done" }];
  expect(buildResponseJSON(events, "fixture")).toMatchObject({ metadata });
  const stream = bridgeToResponsesSSE((async function* () { yield* events; })(), "fixture");
  const output = await new Response(stream).text();
  const completed = output.split('\n').filter(v => v.startsWith('data: {')).map(v => JSON.parse(v.slice(6)))
    .find(v => v.type === 'response.completed');
  expect(completed.response.metadata).toEqual(metadata);
});
test("launcher notice uses the requested Korean copy and names both positions", () => {
  expect(effortCeilingNotice({ account: "fixture", family: "5.6", requestedPosition: 3, actualPosition: 2,
    observedAt: 1, lastCheckedAt: 1 }, "ko")).toBe("생각 강도 제한 중: High → Medium (자동 복구 대기)");
});
