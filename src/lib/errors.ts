export interface CodexErrorPayload {
  message: string;
  type: string;
  code: string | null;
  retryAt?: number;
  retryAfterSeconds?: number;
}

/** Only the two known account-cooldown notice families, not capacity or security UI. */
export function isChatGptRateLimitNoticeMessage(message: string): boolean {
  const text = message.replace(/\s+/g, " ").trim();
  return /^we['’]re doing a quick check to keep ChatGPT reliable\.\s*Try again\b/i.test(text)
    || /^(?:you['’]ve|you have) (?:reached|hit) (?:the|your) (?:hourly (?:message |usage )?limit|limit for messages in an hour|(?:message |usage )?limit for (?:this|the) hour)\b/i.test(text)
    || /^too many (?:requests|messages) in (?:1|one|an) hour\b/i.test(text);
}

function isSubscriptionGateMessage(text: string): boolean {
  return (
    text.includes("requires a subscription") ||
    text.includes("requires subscription") ||
    text.includes("subscription required") ||
    text.includes("upgrade for access") ||
    text.includes("upgrade to pro") ||
    text.includes("pro subscription") ||
    (text.includes("upgrade") && text.includes("subscription"))
  );
}

function isAuthenticationMessage(text: string): boolean {
  const accessDeniedWithCredentialCue = (
    text.includes("access denied") ||
    text.includes("accessdeniedexception")
  ) && (
    text.includes("authentication") ||
    text.includes("credential") ||
    text.includes("api key") ||
    text.includes("token") ||
    text.includes("signature")
  );
  return (
    text.includes("authentication failed") ||
    text.includes("authentication") ||
    text.includes("invalid_api_key") ||
    text.includes("invalid api key") ||
    text.includes("invalid token") ||
    text.includes("unauthorizedexception") ||
    text.includes("unrecognizedclientexception") ||
    text.includes("unrecognizedclient") ||
    text.includes("expired token") ||
    text.includes("expiredtoken") ||
    text.includes("unauthenticated") ||
    text.includes("unauthorized") ||
    accessDeniedWithCredentialCue
  );
}

function isPermissionMessage(text: string): boolean {
  return (
    text.includes("permission_denied") ||
    text.includes("permission denied") ||
    text.includes("forbidden") ||
    text.includes("access denied") ||
    text.includes("accessdeniedexception") ||
    text.includes("not allowed to use") ||
    text.includes("model access")
  );
}

/**
 * Client cancelled / closed the turn. Matches only explicit client-abort phrases
 * produced by request handlers and adapters. Deliberately narrow: bare "client closed"
 * would also swallow legitimate upstream failures like "upstream HTTP client
 * closed idle connection" and turn a real 502 into a 499.
 */
export function isClientClosedMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("client closed request") ||
    lower.includes("client cancelled request") ||
    lower.includes("client canceled request") ||
    lower.includes("request canceled by client") ||
    lower.includes("request cancelled by client")
  );
}

export function classifyError(status: number, type: string, message: string): CodexErrorPayload {
  const text = message.toLowerCase();
  // Preserve explicit cancel types; unify message-inferred client closes onto
  // client_closed_request for /api/logs.
  if (type === "client_cancelled") {
    return { message, type: "client_cancelled", code: "client_cancelled" };
  }
  if (
    status === 499 ||
    type === "client_closed_request" ||
    isClientClosedMessage(text)
  ) {
    return { message, type: "invalid_request_error", code: "client_closed_request" };
  }
  if (
    text.includes("context_length_exceeded") ||
    text.includes("context window") ||
    text.includes("context length") ||
    text.includes("maximum context") ||
    text.includes("too many tokens")
  ) {
    return { message, type: "invalid_request_error", code: "context_length_exceeded" };
  }
  if (
    text.includes("insufficient_quota") ||
    text.includes("exceeded your current quota") ||
    text.includes("quota exhausted") ||
    text.includes("account quota exceeded") ||
    text.includes("monthly quota exceeded") ||
    text.includes("daily quota exceeded")
  ) {
    return { message, type: "insufficient_quota", code: "insufficient_quota" };
  }
  if (
    status === 429 ||
    isChatGptRateLimitNoticeMessage(message) ||
    text.includes("rate limit") ||
    text.includes("rate limited") ||
    text.includes("too many requests") ||
    text.includes("resource_exhausted") ||
    text.includes("resource exhausted") ||
    text.includes("throttlingexception") ||
    text.includes("throttling")
  ) {
    return { message, type: "rate_limit_error", code: "rate_limit_exceeded" };
  }
  if (type === "origin_rejected") {
    return { message, type: "invalid_request_error", code: "origin_rejected" };
  }
  // HTTP 401 and explicit auth failures are authoritative even when provider text
  // also advertises an upgrade or subscription.
  if (
    status === 401 ||
    type === "authentication_error" ||
    isAuthenticationMessage(text)
  ) {
    return { message, type: "authentication_error", code: "invalid_api_key" };
  }
  // Subscription labels are valid only in a known permission context.
  if (
    (status === 403 || type === "permission_error") &&
    isSubscriptionGateMessage(text)
  ) {
    return { message, type: "permission_error", code: "subscription_required" };
  }
  if (
    status === 403 ||
    type === "permission_error" ||
    isPermissionMessage(text)
  ) {
    return { message, type: "permission_error", code: "permission_denied" };
  }
  if (
    status === 503 ||
    text.includes("overloaded") ||
    text.includes("server is busy") ||
    text.includes("temporarily unavailable")
  ) {
    // Codex recognizes "server_is_overloaded" and applies retry-after backoff
    // (responses.rs is_server_overloaded_error); generic "upstream_server_error" is not recognized.
    return { message, type: "server_error", code: "server_is_overloaded" };
  }
  if (
    text.includes("validationexception") ||
    text.includes("invalid request") ||
    text.includes("model unavailable") ||
    text.includes("model not found") ||
    text.includes("unsupported model")
  ) {
    return { message, type: "invalid_request_error", code: "invalid_request_error" };
  }
  if (status >= 500) {
    return { message, type: "server_error", code: "upstream_server_error" };
  }
  if (status === 400 || type === "invalid_request_error") {
    return { message, type: "invalid_request_error", code: "invalid_request_error" };
  }
  return { message, type, code: type || null };
}

function retryDurationSeconds(message: string): number | undefined {
  const cues = /(?:try\s+again\s+(?:in|after)|retry\s+after)\s+/gi;
  for (const cue of message.matchAll(cues)) {
    let rest = message.slice(cue.index! + cue[0].length), seconds = 0;
    const unit = /^\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i;
    let match: RegExpMatchArray | null;
    while ((match = rest.match(unit))) {
      const multiplier = { s: 1, m: 60, h: 3_600, d: 86_400 }[match[2]![0]!.toLowerCase()]!;
      seconds += Number(match[1]) * multiplier;
      rest = rest.slice(match[0].length).replace(/^\s*(?:,\s*|and\s+)/i, "");
    }
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  }
  // Keep the legacy integer Retry-After header behavior, including fractional headers.
  for (const match of message.matchAll(/retry[- ]after[:\s]+(\d+)/gi)) {
    const rest = message.slice(match.index! + match[0].length);
    if (/^\s*(?::|a\.?m\.?|p\.?m\.?|minutes?\b|mins?\b|hours?\b|hrs?\b|days?\b)/i.test(rest)) continue;
    const seconds = Number(match[1]);
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  }
  return undefined;
}

/** Clock notices use the host's local timezone; browser-locale conversion belongs to the caller. */
function retryClockAt(message: string, now: number): number | undefined {
  const text = message.normalize("NFKC").replace(/[\u200e\u200f\u202a-\u202e]/g, "");
  const englishCue = /(?:try\s+again|retry|come\s+back|available\s+again|resets?)\s*(?:at|after)\s*/gi;
  const starts = Array.from(text.matchAll(englishCue), match => match.index! + match[0].length);
  // Localized clocks may precede the retry instruction instead of following it.
  if (/다시\s*시도|재시도|再試|再试|お試し|試してください/.test(text)) {
    for (const match of text.matchAll(/(?:오전|오후|午前|午後|上午|下午)\s*\d{1,2}(?:\s*[:時시点點]\s*\d{1,2}(?:[분分])?)?|\d{1,2}\s*[:時시点點]\s*\d{1,2}(?:[분分])?/gi)) {
      starts.push(match.index!);
    }
  }
  const marker = "a\\.?m\\.?|p\\.?m\\.?|오전|오후|午前|午後|上午|下午";
  const clock = new RegExp(`^(?:(${marker})\\s*)?(\\d{1,2})(?:\\s*:\\s*(\\d{2})|\\s*[시時点點]\\s*(?:(\\d{1,2})\\s*[분分])?)?(?:\\s*(${marker}))?(?![\\d:])`, "i");
  for (const start of starts) {
    const match = text.slice(start).match(clock);
    if (!match) continue;
    const period = match[1] || match[5];
    if (match[1] && match[5] && match[1].toLowerCase() !== match[5].toLowerCase()) continue;
    let hour = Number(match[2]);
    const minute = Number(match[3] ?? match[4] ?? 0);
    if ((!period && match[3] === undefined && match[4] === undefined) || minute > 59) continue;
    if (period) {
      if (hour < 1 || hour > 12) continue;
      hour = hour % 12 + (/^(?:p|오후|午後|下午)/i.test(period) ? 12 : 0);
    } else if (hour > 23) continue;
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    // At the named minute the gate has already reached its reset time. Earlier minutes roll over.
    if (target.getTime() < now && now - target.getTime() < 60_000) return now;
    if (target.getTime() < now) target.setDate(target.getDate() + 1);
    if (Number.isFinite(target.getTime())) return target.getTime();
  }
  return undefined;
}

/** Best-effort explicit delay; unrelated text and notices without a valid time remain undefined. */
export function parseRetryAfterFromMessage(message: string, now: number = Date.now()): number | undefined {
  const retryAt = retryClockAt(message, now);
  return retryAt === undefined ? retryDurationSeconds(message) : Math.max(0, Math.ceil((retryAt - now) / 1_000));
}

/** Absolute local reset time. Call after classification; only missing/invalid times use 20 minutes. */
export function parseRetryAtFromMessage(message: string, now: number = Date.now()): number {
  return retryClockAt(message, now) ?? now + (retryDurationSeconds(message) ?? 20 * 60) * 1_000;
}

/** Infer HTTP status from adapter terminal error text (provider-agnostic keyword matching). */
export function inferHttpStatusFromAdapterMessage(message: string): number {
  const lower = message.toLowerCase();
  // Client aborts must not look like upstream 502s in /api/logs.
  if (isClientClosedMessage(lower)) return 499;
  if (
    lower.includes("resource_exhausted") ||
    lower.includes("resource exhausted") ||
    isChatGptRateLimitNoticeMessage(message) ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("throttling")
  ) return 429;
  // Strong authentication signals win when a message contains mixed auth and
  // subscription/permission wording.
  if (isAuthenticationMessage(lower)) return 401;
  if (isSubscriptionGateMessage(lower) || isPermissionMessage(lower)) return 403;
  if (
    lower.includes("unavailable") ||
    lower.includes("overloaded") ||
    lower.includes("temporarily") ||
    lower.includes("server is busy")
  ) return 503;
  if (
    lower.includes("invalid") ||
    lower.includes("not found") ||
    lower.includes("unsupported") ||
    lower.includes("malformed") ||
    lower.includes("unimplemented")
  ) return 400;
  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("etimedout") ||
    lower.includes("deadline")
  ) return 504;
  return 502;
}

/** Map an adapter terminal error message to HTTP status + classified Codex error payload. */
export function adapterFailureFromMessage(message: string, now: number = Date.now()): { httpStatus: number; error: CodexErrorPayload } {
  const httpStatus = inferHttpStatusFromAdapterMessage(message);
  let finalMessage = message;
  const explicitRetryAfterSeconds = parseRetryAfterFromMessage(message, now);
  const retryAt = httpStatus === 429 ? parseRetryAtFromMessage(message, now) : undefined;
  const retryAfterSeconds = retryAt === undefined
    ? explicitRetryAfterSeconds
    : Math.max(0, Math.ceil((retryAt - now) / 1_000));
  if (explicitRetryAfterSeconds && !isChatGptRateLimitNoticeMessage(message) && !/please try again in /i.test(message)) {
    finalMessage = `${message} Please try again in ${retryAfterSeconds}s.`;
  }
  const errorType = httpStatus === 499
    ? "client_closed_request"
    : httpStatus === 429
      ? "rate_limit_error"
      : httpStatus === 401
        ? "authentication_error"
        : httpStatus === 403
          ? "permission_error"
          : httpStatus === 503 || httpStatus === 504
            ? "server_error"
            : httpStatus === 400
              ? "invalid_request_error"
              : "upstream_error";
  return {
    httpStatus,
    error: {
      ...classifyError(httpStatus, errorType, finalMessage),
      ...(retryAt === undefined ? {} : { retryAt, retryAfterSeconds }),
    },
  };
}

/** Map a terminal Responses error object to the HTTP status we record in /api/logs. */
export function httpStatusFromTerminalError(error: {
  type?: string;
  code?: string | null;
  message?: string;
} | undefined): number {
  if (!error) return 502;
  if (error.code === "client_closed_request" || error.code === "client_cancelled") return 499;
  if (error.type === "rate_limit_error" || error.code === "rate_limit_exceeded") return 429;
  if (error.type === "authentication_error" || error.code === "invalid_api_key") return 401;
  if (
    error.type === "permission_error" ||
    error.code === "permission_denied" ||
    error.code === "subscription_required"
  ) return 403;
  if (error.type === "insufficient_quota" || error.code === "insufficient_quota") return 429;
  if (error.type === "server_error" && error.code === "server_is_overloaded") return 503;
  // Client-closed messages often arrive as invalid_request_error after classifyError; check message
  // before treating every invalid_request_error as HTTP 400.
  const message = error.message ?? "";
  if (message && isClientClosedMessage(message)) return 499;
  if (error.type === "invalid_request_error") return 400;
  if (error.type === "proxy_error") return 500;
  if (message) return inferHttpStatusFromAdapterMessage(message);
  return 502;
}
