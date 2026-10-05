import type { CompiledChatGptWebPrompt } from "./prompt";

export const MAX_TURN_FOLLOW_UPS = 5;
export const TURN_FOLLOW_UP_BACKOFF_MS = 1500;
export type TurnFollowUp = "incomplete_report" | "verify_tools" | "exhausted" | "none";

const pending = [
  /다음\s*(?:단계|작업)(?:로|는|를|에서|:|\s*[-—])/,
  /(?:계속|이어서|이어)\s*진행(?:하겠습니다|합니다|할\s*예정|예정)/,
  /남은\s*(?:실제\s*)?(?:작업|단계|조건)(?:은|는|:|\s*[-—]|\s*\d)/,
  /완료\s*조건[^.\n]{0,120}(?:미충족|충족되지|충족하지|충족하지\s*못|충족\s*전)/,
  /(?:아직|현재)[^.\n]{0,120}(?:충족되지|미충족)/,
  /이어(?:가겠습니다|갑니다)/,
  /\b(?:next steps?|remaining (?:steps|work|tasks|requirements))\b/i,
];
const stop = [
  /승인|허락|허가|원하시면|알려\s*주세요|말씀해\s*주/,
  /(?:결정|확인)[^.\n]{0,25}(?:필요|부탁|요청|해\s*주)/,
  /(?:대기|기다리)(?:합니다|하겠습니다|겠습니다|는\s*중|중입니다|중)/,
  /(?:정지|중단|멈춤)(?:했습니다|합니다|확인)/,
  /(?:남은|추가)\s*[^.\n]{0,25}(?:없습니다|없음|없어)/,
  /(?:status[^.\n]{0,20}이미[^.\n]{0,15}완료|모든\s*단계\s*완료)/,
  /\?\s*$/,
  /\b(?:awaiting|waiting for) (?:approval|confirmation|your)|\blet me know|\bshould I\b/i,
];
const failure = [
  /invalid.{0,20}expired|revoked|already finished|토큰[^.\n]{0,40}(?:종료|만료|거부)/i,
  /(?:blocked|차단|거부)[^.\n]{0,80}(?:OpenAI|safety|승인|안전)|(?:OpenAI|safety|승인|안전)[^.\n]{0,80}(?:blocked|차단|거부)/i,
  /couldn't determine the safety status|unusual activity|api_tool unavailable/i,
  /(?:오류|error|실패|failed)[^.\n]{0,50}(?:MCP|도구|tool)|(?:MCP|도구|tool)[^.\n]{0,50}(?:오류|error|실패|failed)/i,
];
const missingTools = /(?:실행\s*도구|로컬\s*도구|Codex[^.\n]{0,25}도구)[^.\n]{0,80}(?:연결되어\s*있지|연결되지|노출되지|노출되어\s*있지|제공되지|없어)|(?:local|Codex Native)[^.\n]{0,35}tools?[^.\n]{0,45}(?:unavailable|not (?:connected|exposed|available))/i;

export function decideTurnFollowUp(text: string, count: number, state: {
  localTools: boolean; compaction: boolean; aborted: boolean; bindingPresent: boolean;
  toolBatchRevision: number; toolVerificationSent: boolean;
}): TurnFollowUp {
  if (!state.localTools || state.compaction || state.aborted || !state.bindingPresent) return "none";
  const tail = text.replaceAll("\\_", "_").trim().slice(-900);
  // An actual tool/platform rejection is never a reason to rephrase or resend the action.
  if (failure.some(pattern => pattern.test(text)) || stop.some(pattern => pattern.test(tail))) return "none";
  if (missingTools.test(tail)) {
    if (state.toolBatchRevision !== 0 || state.toolVerificationSent) return "none";
    return count < MAX_TURN_FOLLOW_UPS ? "verify_tools" : "exhausted";
  }
  if (!pending.some(pattern => pattern.test(tail))) return "none";
  return count < MAX_TURN_FOLLOW_UPS ? "incomplete_report" : "exhausted";
}

export function turnFollowUpPrompt(reason: "incomplete_report" | "verify_tools", binding: NonNullable<CompiledChatGptWebPrompt["nativeBinding"]>): string {
  if (!binding.turn_token || binding.token_chars !== binding.turn_token.length) {
    throw new Error("Browser follow-up has no valid current runtime binding");
  }
  return [
    "[브리지 자동 이어가기] This is a follow-up inside the still-open Codex turn, not a new task or context-compaction request.",
    reason === "verify_tools"
      ? "No current Codex tool execution was observed. For the local work required by the latest active request, verify the tool catalog once using codex_tool_inventory with a focused query, include_schema=true and the current binding below. If the connector or tool is actually unavailable, report the exact result and stop dependent work. Do not invent tool names or results."
      : "The response reports unfinished steps. Continue the remaining work already authorized by the latest active request, using actual tool results. Do not stop at another plan or status report, and do not mark work completed without verification.",
    "Use only this runtime-issued binding; earlier token errors and compaction notices concern their original turns. Never invent or reactivate a token. If this current binding is rejected, report the exact error and stop dependent work.",
    "Preserve the original model, reasoning effort, requested output format and all approval and safety rules. Stop if the task is complete, cancelled, awaiting authorization or blocked by a tool/platform rejection. Do not retry rejected actions through another route.",
    "<codex_native_binding_json>",
    JSON.stringify(binding),
    "</codex_native_binding_json>",
  ].join("\n");
}
