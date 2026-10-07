import type { CodexParsedRequest } from "../../types";
import {
  CHATGPT_WEB_BACKEND_MODEL, resolveChatGptWebContextLimits,
  resolveChatGptWebTransportLimits, resolveChatGptWebStagingTokenBudget,
} from "../../chatgpt-web-models";
import { estimateTokens } from "../../lib/token-estimate";
import { compiledChatGptWebMessages, estimateCompiledChatGptWebInputTokens } from "./input-tokens";
import { resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import {
  CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET, compileChatGptWebPrompt,
  type CompiledChatGptWebPrompt, type ChatGptWebMultipartPartCount,
} from "./prompt";

// Bound the whole temporary document as well as each physical Send. More parts do
// not expand the selected model's ordinary context window for a checkpoint.
export const COMPACTION_STAGE_PAGE_CHAR_BUDGET = 320_000;
const CHECKPOINT_JSON_RESERVE = 24_000;
const CHECKPOINT_TOKEN_RESERVE = 8_000;

export function prepareCompactionStageTransport(
  stage: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  options: { reserveCheckpoint: boolean; multipart: boolean },
): CompiledChatGptWebPrompt | undefined {
  const mode = resolveChatGptWebModelMode(stage.modelId, stage.options.reasoning, capabilities);
  const { autoCompactTokenLimit } = resolveChatGptWebContextLimits(
    CHATGPT_WEB_BACKEND_MODEL, mode.effort, { ...capabilities, experimentalBiggerContext: false },
  );
  const jsonReserve = options.reserveCheckpoint ? CHECKPOINT_JSON_RESERVE : 0;
  const tokenReserve = options.reserveCheckpoint ? CHECKPOINT_TOKEN_RESERVE : 0;
  const parts: (ChatGptWebMultipartPartCount | undefined)[] = options.multipart ? [undefined, 2, 4, 6, 8] : [undefined];
  for (const count of parts) {
    const compiled = compileChatGptWebPrompt(stage, capabilities, undefined, {
      preserveCompactionHistory: true, ...(count ? { experimentalMultipartParts: count } : {}),
    });
    const messages = compiledChatGptWebMessages(compiled);
    if (messages.reduce((sum, text) => sum + text.length, 0) + jsonReserve > COMPACTION_STAGE_PAGE_CHAR_BUDGET) continue;
    const reserveFor = (text: string) => text.includes("previous_checkpoint") ? jsonReserve : 0;
    if (messages.some(text => Buffer.byteLength(JSON.stringify(text), "utf8") + reserveFor(text)
      > CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET)) continue;
    // Inert uploads must fit Instant or ordinary Thinking. Never require Pro to
    // transport a checkpoint whose selected execution mode is Sol.
    if (messages.some((text, index) => {
      const efforts = index === messages.length - 1 ? [mode.effort] : ["low", "medium"] as const;
      return !efforts.some(effort => {
        const limits = resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, effort, capabilities);
        return text.length + reserveFor(text) <= (limits.browserComposerCharLimit ?? Infinity)
          && estimateTokens(text, stage.modelId) + tokenReserve
            <= resolveChatGptWebStagingTokenBudget(CHATGPT_WEB_BACKEND_MODEL, effort, capabilities);
      });
    })) continue;
    if (estimateCompiledChatGptWebInputTokens(compiled, stage.modelId) + tokenReserve >= autoCompactTokenLimit) continue;
    return compiled;
  }
  return undefined;
}
