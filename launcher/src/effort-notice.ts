import type { Language, LauncherState } from "./types";

export function effortCeilingNotice(ceiling: NonNullable<LauncherState["effortCeilings"]>[number], language: Language): string {
  const labels = ["Instant", "Medium", "High", "Extra High", "Pro"];
  const change = `${labels[ceiling.requestedPosition - 1]} → ${labels[ceiling.actualPosition - 1]}`;
  return language === "ko" ? `생각 강도 제한 중: ${change} (자동 복구 대기)`
    : `Thinking effort limited: ${change} (waiting for automatic recovery)`;
}
