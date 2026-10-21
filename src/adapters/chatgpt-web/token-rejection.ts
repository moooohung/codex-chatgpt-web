// Keep the shared MCP error classifier independent of prompt compilation and its tokenizer.
export const TOKEN_REJECTION_PATTERNS: readonly RegExp[] = [
  /turn token is invalid,\s*expired,\s*or revoked/i,
  /request id is invalid,\s*expired,\s*or revoked/i,
  /runtime turn token[^\n]*invalid,\s*expired,\s*or revoked/i,
  /(?:turn_token|request_id)\s+was issued for\s+[^,]+,\s*which has already finished/i,
  /turn token is invalid or expired/i,
];

export function isChatGptTokenRejection(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  return TOKEN_REJECTION_PATTERNS.some(pattern => pattern.test(text));
}
