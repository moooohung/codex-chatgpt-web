# Account cooldown routing

Automatic Launcher browser turns recognize the short ChatGPT hourly-limit and
"We're doing a quick check to keep ChatGPT reliable" notices. Observation stays
within visible status/banner/composer surfaces and excludes transcript text,
security challenges and generic capacity errors. Clock notices use the browser
host's local time, including midnight rollover; only missing/invalid reset times
use the existing 20-minute fallback.

The Launcher persists each observed account's absolute `retryAt` and notice in
`account-cooldowns.json` under its profile user-data directory. Native Codex auth
files and browser cookies are never copied or replaced. The store survives a
Launcher restart and preserves malformed files instead of silently repairing them.

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
