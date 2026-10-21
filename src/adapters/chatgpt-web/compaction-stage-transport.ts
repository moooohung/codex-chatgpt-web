import type { CodexParsedRequest } from "../../types";
import { ChatGptWebAdapterError } from "./adapter-error";
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

/** A fresh direct handoff must fit without trimming any historical record. */
export function directCompactionFits(
  parsed: CodexParsedRequest, capabilities: ChatGptWebCapabilities, multipart: boolean,
): boolean {
  try {
    return prepareCompactionStageTransport(parsed, capabilities, { reserveCheckpoint: false, multipart }) !== undefined;
  } catch (error) {
    if (error instanceof ChatGptWebAdapterError && error.code === "context_length_exceeded") return false;
    throw error;
  }
}

/**
 * A staged compaction sizes later stages with the capabilities of the account the first
 * stage leased. A Plus lease has no Extra High or Pro, so the native thread's requested
 * effort must be clamped the same way the lease clamps the actual turn; throwing here
 * failed the whole handoff after stage 1 and Codex restarted the compaction forever
 * (tower 2026-10-21 21:4x).
 */
export function compactionStageReasoning(
  reasoning: CodexParsedRequest["options"]["reasoning"], capabilities: ChatGptWebCapabilities,
): CodexParsedRequest["options"]["reasoning"] {
  if (reasoning === "max" && !capabilities.proAvailable) reasoning = "xhigh";
  if (reasoning === "xhigh" && !capabilities.extraHighAvailable) reasoning = "high";
  return reasoning;
}

export function prepareCompactionStageTransport(
  requested: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  options: { reserveCheckpoint: boolean; multipart: boolean },
): CompiledChatGptWebPrompt | undefined {
  const reasoning = compactionStageReasoning(requested.options.reasoning, capabilities);
  const stage: CodexParsedRequest = reasoning === requested.options.reasoning ? requested
    : { ...requested, options: { ...requested.options, reasoning } };
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
