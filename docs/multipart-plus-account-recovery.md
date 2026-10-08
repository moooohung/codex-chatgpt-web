# Multipart selection across account changes

The 2026-10-08 diagnostics export shows a multipart stage accepted and acknowledged
before final Extra High selection failed. The owned browser account had a three-position
Plus picker (Instant, Medium, High), while saved setup capabilities still advertised Pro
and Extra High. Medium in the initial stage is the inert context transport, not proof
that the final requested effort is available.

Multipart now verifies the requested family and effort before its first physical Send.
After each stage ACK, it discards the previous picker proof and verifies the next part
against the current UI. An explicitly checked GPT-6 family row can identify an effort-only
header; an unversioned Latest row still cannot prove GPT-6.

On positive Plus account evidence and a structurally unavailable or locked requested
effort, the user-authorized mapping is:

| Requested | Effective |
| --- | --- |
| GPT-5.6 Sol Extra High | GPT-5.6 Sol High |
| GPT-6 Sol Extra High | GPT-6 Sol High |
| GPT-5.6 Pro Max | GPT-5.6 Sol High |
| GPT-6 Pro Max | GPT-5.6 Sol High |

High must pass the ordinary family/effort verification. Unknown account state, Pro
accounts, unrelated DOM failures and usage/capacity errors do not authorize this mapping.
The session's configured model and effort stay unchanged.

A prompt prepared with stale Pro limits is validated again with Plus limits. Before
any submission, an internal typed result permits exactly one recompilation from the
canonical request with the effective family, High effort and Plus capabilities. This
retains the compiler's context limits and existing history policy; it does not promise
that arbitrary large contexts fit. GPT-6 Sol on Plus still uses standard context.
Send activation, a multipart ACK or cancellation prohibits that fresh preparation.

Known unavailable efforts report the actual picker range. Other model-control failures
write a bounded, redacted local reason. Failure diagnostics are captured before the
launcher releases the tab, so cleanup no longer destroys the page before capture.

The second exported failure occurred after an ACK and a reused Medium proof, but its
original inner observation cause was not retained. Cache invalidation and better
failure capture cover this path; a live worker round trip remains separate validation.
Tests use offline fixtures and unsent UI selection. No Pro test request is submitted.
