/** Observed ChatGPT service UI; these states are neither answer content nor execution progress. */
export type ChatGptResponseWaitState = "connection_interrupted" | "service_thinking" | "connection_interrupted_and_service_thinking";

export const CHATGPT_RESPONSE_WAIT_LABELS = {
  connection: "Connection interrupted. Waiting for the complete answer",
  service: "Our systems are thinking a bit more about this request before responding.",
} as const;

export function isChatGptResponseWaitState(value: unknown): value is ChatGptResponseWaitState {
  return value === "connection_interrupted" || value === "service_thinking"
    || value === "connection_interrupted_and_service_thinking";
}
