import { describe, expect, test } from "bun:test";
import { decideTurnFollowUp, MAX_TURN_FOLLOW_UPS, turnFollowUpPrompt } from "../src/adapters/chatgpt-web/turn-follow-up";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { CodexParsedRequest } from "../src/types";

const state = { localTools: true, compaction: false, aborted: false, bindingPresent: true, toolBatchRevision: 4, toolVerificationSent: false };
const samples = [
  "현재 완료 조건(실제 카드/파워/유물 구현, DLL strict 비교 수치)은 아직 충족되지 않아 status는 completed로 변경하지 않았습니다.",
  "status: in_progress 유지\n남은 조건:\n- 추가 효과 실제 구현\n- 원본 DLL headless strict 비교",
  "남은 실제 작업:\n- 카드 런타임 구현\n- 최종 회귀 검증",
  "Saved the report. Next steps: implement the remaining cards.",
];

describe("completed response follow-ups", () => {
  test.each(samples)("recognizes observed premature ending: %s", text => {
    expect(decideTurnFollowUp(text, 0, state)).toBe("incomplete_report");
  });
  test.each([
    "보고서 저장 완료. 모든 단계 완료.", "패킷은 완료 상태이며 추가 진행할 남은 단계는 없습니다.",
    "남은 단계는 총괄 승인 후 진행하겠습니다.", "Next step: run tests; should I proceed?",
    "다음 단계: 수정. This tool call was blocked by OpenAI because we couldn't determine the safety status.",
    "남은 작업: 수정. OpenAI safety checks에 의해 차단되었습니다.",
    "다음 단계로 이어갑니다. This turn_token was issued for a turn which has already finished.",
    "로컬 도구가 없어 실행할 수 없습니다. MCP connection failed.",
  ])("stops for completion, authorization or real rejection: %s", text => {
    expect(decideTurnFollowUp(text, 0, state)).toBe("none");
  });
  test("does not send follow-ups on read-only, compaction, cancelled or unbound turns", () => {
    for (const override of [{localTools:false}, {compaction:true}, {aborted:true}, {bindingPresent:false}]) {
      expect(decideTurnFollowUp(samples[0]!, 0, {...state,...override})).toBe("none");
    }
  });
  test("false absence claims can verify the current catalog only once, without executed tools", () => {
    const missing = "현재 이 응답 환경에서는 Codex Native 실행 도구가 연결되어 있지 않아 로컬 파일 수정·검증을 실제로 수행할 수 없습니다.";
    expect(decideTurnFollowUp(missing, 0, {...state,toolBatchRevision:0})).toBe("verify_tools");
    expect(decideTurnFollowUp(missing, 1, {...state,toolBatchRevision:0,toolVerificationSent:true})).toBe("none");
    expect(decideTurnFollowUp(missing, 0, state)).toBe("none");
  });
  test("five response follow-ups share a single bounded budget", () => {
    for(let i=0;i<MAX_TURN_FOLLOW_UPS;i++) expect(decideTurnFollowUp(samples[0]!,i,state)).toBe("incomplete_report");
    expect(decideTurnFollowUp(samples[0]!,MAX_TURN_FOLLOW_UPS,state)).toBe("exhausted");
  });
});

describe("authoritative current capability", () => {
  const capabilities={localToolsEnabled:true,solAvailable:true,extraHighAvailable:true,proAvailable:true};
  const request:CodexParsedRequest={modelId:CHATGPT_WEB_MODEL_ID,stream:true,options:{reasoning:"high"},context:{messages:[
    {role:"assistant",content:[{type:"text",text:'<codex_native_binding_json>{"turn_token":"stale"}</codex_native_binding_json>'}],timestamp:1},
    {role:"user",content:"Finish the remaining implementation and tests.",timestamp:2},
  ]}};
  test("the follow-up uses structured compiled binding, never an old conversation token", () => {
    const compiled=compileChatGptWebPrompt(request,capabilities,"runtime_current_token");
    expect(compiled.nativeBinding).toEqual({turn_token:"runtime_current_token",token_chars:21});
    const prompt=turnFollowUpPrompt("incomplete_report",compiled.nativeBinding!);
    expect(prompt).toContain('"turn_token":"runtime_current_token"');
    expect(prompt).not.toContain('"turn_token":"stale"');
    expect(prompt).toContain("stop dependent work");
    expect(prompt).not.toContain("token stays valid until");
  });
  test("multipart transports supply the same metadata; compaction and read-only never do", () => {
    const multipart=compileChatGptWebPrompt(request,capabilities,"current",{experimentalMultipartParts:4});
    expect(multipart.nativeBinding?.turn_token).toBe("current");
    expect(compileChatGptWebPrompt({...request,_compactionRequest:true},capabilities).nativeBinding).toBeUndefined();
    expect(compileChatGptWebPrompt(request,{...capabilities,localToolsEnabled:false}).nativeBinding).toBeUndefined();
  });
  test("malformed metadata fails before any follow-up can be sent", () => {
    expect(()=>turnFollowUpPrompt("verify_tools",{turn_token:"current",token_chars:1})).toThrow();
  });
});
