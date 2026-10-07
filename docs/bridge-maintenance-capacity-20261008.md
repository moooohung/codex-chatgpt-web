# Maintenance errors and tool boundary observation

Baseline: `361d6f0260dfd3b71abfda6a4d27e86af11a2ec4`, integrated 6.1.5.

## Evidence and cause

The 2026-10-07 failures at 13:27:34Z, 15:57:16Z and 17:15:58Z followed the
corresponding installation `quitSentAt` by about three seconds. Six requests for
Web Sol, Web Pro and native Sol failed together in the last incident. The
reservations recorded 3, 3 and 5 active browser turns at shutdown respectively.

At baseline, `src/server.ts:1057-1062` and `1113-1151` rejected every new route
while draining using HTTP 503. `src/lib/errors.ts:148-155` classified every HTTP
503 as `server_is_overloaded`. This happens before the native/web model branch
at `src/server.ts:513-518`. Therefore native requests using the same loopback
listener also received the misleading capacity classification. Historical HTTP
bodies are not retained; the timestamp correlation and an isolated native-client
reproduction establish the local failure path. These incidents do not establish
an upstream account concurrency limit.

The additional screenshot's job, `task-muydesfy-f7qoju`, failed at
17:43:33Z and 17:46:31Z. Traces `a4949d27badd` and `9398b7eb9bfe` captured
1,067,545 and 1,080,307 body characters. The instrumented failing probe was
`boundary_turn_state`; capture exhausted its 20-second budget before observation
and ACK. Failure diagnostics saying the page was closed were captured after
normal failed-turn cleanup and do not establish a prior browser crash.

## Changes

- Drain rejection is HTTP 502 with `bridge_maintenance`, `Retry-After: 5`,
  an explicit local-source header, and a health counter. Upstream overload
  classification remains intact. No model request starts while draining.
- A rejected native HTTP 503 on models/responses/compact gets at most three
  retries, with 2/4/8-second exponential delay plus jitter, respecting a longer
  Retry-After within a 30-second retry budget. The budget bounds retry decisions
  and waits; it does not replace the native transport's request timeout.
  Each request has independent state. Final upstream bodies and headers remain
  intact. Accepted streams, transport exceptions, quota/auth errors, standalone
  images and search are not replayed by this policy. Accepted Web turns are not
  resubmitted by this change.
- Tool boundary turn identification uses an independent DOM projection without
  rendering mutations, error-alert geometry or stop-button layout. Send
  acceptance, response text visibility, duplicate identity detection, multipart
  proof, completion and capture→observe→ACK retain their existing contracts.
  This removes a demonstrated layout dependency; renderer-wide hangs can still
  exhaust the observation budget.
- Default maintenance guards include native HTTP turns. Optional idle waiting
  protects exact plugin job records until they are terminal, then requires two
  samples with zero browser/HTTP turns. It never authorizes cancellation of active
  turns. The independent restart guardian is armed before any shutdown.

## Verification and operational limits

The native CLI 0.160.1 isolated loopback fixture reproduces the old capacity
error after five rejected requests. With two maintenance responses followed by
a synthetic answer, it reconnects and completes on request three. No production
account, Pro request or worker tool is used.

Focused tests cover native retry cancellation/budgets/body fidelity/independence,
all drained HTTP endpoints, native-only maintenance guards, protected jobs between
requests, and real headless-browser 320k/1M text fixtures. The latter inject a
failure into the old stop-button geometry dependency and exercise the production
boundary capture method through observe and ACK. Existing model/effort/multipart,
response completion and helper-to-daemon ACK fixtures are retained.

Keep the tower's current cap of five Web jobs and the user's eight-tab bridge
limit. Five jobs is an operational policy, not a proven upstream safe maximum;
there is no measured account concurrency threshold from these maintenance events.
Do not relaunch jobs into a reserved installation window until its `state.json`
reports `phase=complete`, `operationSucceeded=true` and `healthyAt`. A prolonged
outage may still exceed Codex's reconnect budget; changing the error label alone
does not make cancellation of an in-flight request safe.

Official references: [error codes](https://developers.openai.com/api/docs/guides/error-codes)
and [backoff guidance](https://developers.openai.com/api/docs/guides/rate-limits).
