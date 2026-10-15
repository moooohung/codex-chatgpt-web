import { ChatGptWebAdapterError } from "./adapter-error";
import type { ChatGptWebModelMode } from "./model";

export const EFFORT_RECHECK_MS = 10 * 60 * 1_000;
export const EFFORT_LABELS = ["Instant", "Medium", "High", "Extra High", "Pro"] as const;
const efforts = ["low", "medium", "high", "xhigh", "max"] as const;

/** Positions are zero based here, one based in logs/state/response metadata. */
export function clampChatGptEffort(mode: ChatGptWebModelMode, available: readonly boolean[]): ChatGptWebModelMode {
  const requested = mode.uiEffortIndex;
  if (requested === null || available[requested]) return mode;
  // Pro is a distinct mode. Its absence never authorizes Sol or a different family.
  if (requested !== 4) {
    for (let position = Math.min(requested - 1, available.length - 1, 3); position >= 0; position--) {
      if (available[position]) return { ...mode, uiEffortIndex: position as 0 | 1 | 2 | 3,
        effort: efforts[position]!, displayLabel: EFFORT_LABELS[position]! };
    }
  }
  throw new ChatGptWebAdapterError(
    `ChatGPT ${mode.displayLabel} is ${requested >= available.length ? "unavailable" : "locked"} in this account. `
      + "No available position in the requested model family and mode can be selected. This part was not sent.",
    { status: 400, errorType: "invalid_request_error", code: requested >= available.length
      ? "chatgpt_effort_unavailable" : "chatgpt_effort_locked", retryable: false },
  );
}

export interface ChatGptEffortSelection {
  family: "5.6" | "6";
  requestedEffort: ChatGptWebModelMode["effort"];
  actualEffort: ChatGptWebModelMode["effort"];
  requestedPosition: number;
  actualPosition: number;
}

export function isChatGptEffortSelection(value: unknown): value is ChatGptEffortSelection {
  const v = value as ChatGptEffortSelection | null;
  return !!v && (v.family === "5.6" || v.family === "6")
    && Number.isInteger(v.requestedPosition) && v.requestedPosition >= 1 && v.requestedPosition <= 5
    && Number.isInteger(v.actualPosition) && v.actualPosition >= 1 && v.actualPosition <= v.requestedPosition
    && efforts[v.requestedPosition - 1] === v.requestedEffort && efforts[v.actualPosition - 1] === v.actualEffort
    && (v.requestedPosition !== 5 || v.actualPosition === 5);
}

export function chatGptEffortMetadata(selection: ChatGptEffortSelection): Record<string, string> {
  return { chatgpt_model_family: selection.family, chatgpt_requested_effort: selection.requestedEffort,
    chatgpt_actual_effort: selection.actualEffort, chatgpt_requested_effort_position: String(selection.requestedPosition),
    chatgpt_actual_effort_position: String(selection.actualPosition) };
}
