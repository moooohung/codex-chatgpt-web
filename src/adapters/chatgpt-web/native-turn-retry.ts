import { getCodexHome } from "../../codex-integration-shared";
import type { CodexParsedRequest } from "../../types";
import {
  CHATGPT_TURN_REVISION_CONFLICT_MESSAGE, chatGptTurnUserRevisionHistory, extractChatGptRootThreadMetadata, extractChatGptThreadSpawnLineage,
  extractChatGptTurnIdentity, rememberVerifiedNativeRetry,
} from "./environment";
import { NativeSnapshotPendingError, verifyCurrentCodexFailedTurnRetry } from "./codex-rollout-environment";
import { prepareNativeSnapshotRead } from "./native-compaction-admission";

/** Replay only an exact failed/unfinished native instruction; never rewrite arbitrary turn ids. */
export function authenticateNativeFailedTurnRetry(parsed: CodexParsedRequest, codexHome = getCodexHome()): boolean {
  const identity = extractChatGptTurnIdentity(parsed);
  const source = chatGptTurnUserRevisionHistory(parsed).at(-1);
  const lineage = extractChatGptThreadSpawnLineage(parsed) ?? extractChatGptRootThreadMetadata(parsed);
  if (parsed._compactionRequest || !lineage || !identity.turnId || !source?.turnId || source.turnId === identity.turnId) return false;
  try {
    const verified = verifyCurrentCodexFailedTurnRetry({
      codexHome, lineage, turnId: identity.turnId, source, retryConflictMessage: CHATGPT_TURN_REVISION_CONFLICT_MESSAGE,
      instruction: item => chatGptTurnUserRevisionHistory({ ...parsed, _rawBody: {
        ...parsed._rawBody as object, input: [item],
      } }).at(-1),
    });
    if (verified) rememberVerifiedNativeRetry(parsed, source);
    return verified;
  } catch (error) {
    if (error instanceof NativeSnapshotPendingError) throw error;
    return false;
  }
}

export function prepareNativeFailedTurnRetry(
  parsed: CodexParsedRequest,
  options: { codexHome?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<boolean> {
  return prepareNativeSnapshotRead(() => authenticateNativeFailedTurnRetry(parsed, options.codexHome), options);
}
