# Account cooldown routing

Automatic Launcher browser turns recognize the short ChatGPT hourly-limit and
"We're doing a quick check to keep ChatGPT reliable" notices. Observation stays
within visible status/banner/composer surfaces and excludes transcript text,
security challenges and generic capacity errors. Clock notices use the browser
host's local time, including midnight rollover; only missing/invalid reset times
use the existing 20-minute fallback.

The browser worker also treats the page-level alert "Our systems have detected
unusual activity coming from your system. Please try again later." as a hard
request rejection. It checks this surface while waiting for submission acceptance,
every Bigger Context acknowledgement, the initial assistant turn, and the final
response. A `local-chatgpt:` URL paired with visible "Unable to load history" is
recorded only as supporting evidence; it never triggers a cooldown by itself.
The unusual-activity verdict is HTTP 429, code `chatgpt_unusual_activity`, and is
non-retryable by the immediate Codex loop. Its default cooldown is 30 minutes and
can be changed with `CODEX_WEB_GPT_UNUSUAL_ACTIVITY_COOLDOWN_MINUTES` (1-1440).

Visible page-level Retry alerts beginning with "Unknown error", "Something went
wrong", "알 수 없는 오류", or "오류가 발생" are also treated as rejected current
requests and fail immediately with `chatgpt_submission_failed`. Transcript/prose
copies, hidden alerts, unrelated Retry toasts such as "Projects could not be
loaded", and subscription-fetch errors do not enter this path. The bridge never
presses the page Retry button.

The Launcher persists each observed account's absolute `retryAt` and notice in
`account-cooldowns.json` under its profile user-data directory. Native Codex auth
files and browser cookies are never copied or replaced. The store survives a
Launcher restart and preserves malformed files instead of silently repairing them.
Unusual-activity cooldowns reuse this version-1 schema, so rollback to 6.1.7 can
still read the state file. While active, the launcher shows a short Korean notice
with the remaining minutes and logs `unusual_activity_detected` and
`unusual_activity_cooldown_ended` with the originating trace id.

New requests are admitted before starting an SSE stream or allocating a browser
tab. A cooling account is not probed. If no other enabled account has a verified
`/api/auth/session` response, admission returns HTTP 429 with `Retry-After`,
`retryAt`, and `retry_after_seconds`. Native API routes and Zero Risk manual mode
keep their existing behavior.
The additional session verification runs only while an observed cooldown is active;
ordinary requests preserve the existing account selection and authentication path.

If another configured account is signed in, the new physical turn uses that
account's existing isolated session partition. The conversation's original account
preference remains unchanged. After expiry the next new turn returns to the original
account if it is still eligible; an already running turn keeps its current account.
Ordinary cookie-presence checks cannot clear a usage cooldown or establish routing
proof. Recent authentication failures invalidate cached and in-flight proof.

A notice discovered during preparation can fail over automatically only before any
physical Send activation. Once Send has been activated, including for a multipart
part, the bridge records the cooldown and returns the error without replaying the
request on another account. Existing execution reconnects bypass new-request
admission and retain their execution ownership and tool acknowledgement contract.

Verification uses sanitized DOM fixtures, controlled clocks, local control HTTP
servers and fake browser workers. Those checks prove detection, persistence,
admission, expiry and no-replay contracts; they do not prove live ChatGPT account
availability or trigger any real model prompt.
