# Integrated 6.1.13 settings recovery

The launcher log at 2026-10-21 16:52:09Z records successful setup preflight
followed by a daemon shutdown timeout. Compensation attempted tunnel startup
while the supervisor was still stopping; its stop guard rejected the startup.
The drained daemon then lacked matching health evidence and finally exited at
16:52:49Z with code 1. The proxy remained unavailable. This establishes a
shutdown/compensation failure, rather than proving that active turns exceeded
the idle-drain budget. No sensitive log contents are included here.

Production automatic tool approvals now use an authenticated loopback control
request. The daemon checks the expected PID, strict boolean payload, Automatic
mode, lifecycle state, and matching persisted configuration. It atomically and
durably commits only the preference, preserving unrelated keys and a UTF-8 BOM,
before updating its live configuration. Already admitted response and compact
requests keep their configuration snapshots. New adapters receive the new value.
The mutable approval preference is excluded from execution identity; reconnects,
tool-result requests and compaction sharing retain the existing physical runtime
and its original policy instead of starting duplicate browser work.
The launcher verifies the acknowledgement and disk readback. It does not drain,
rewrite the Codex route, restart the daemon, or restart tunnels for this setting.
DEV keeps its isolated setup path. Authentication, tool ACK, Codex permissions,
model selection and completion checks remain upstream contracts.

Settings that still require setup retain the original idle drain. A per-child
shutdown intent is recorded before sending shutdown, including ambiguous
delivery. Such a child cannot be resumed or adopted by daemon startup. Recovery
waits for child exit, PID exit, and port release before starting a replacement.
It settles the daemon before restoring tunnels and explicitly permits only this
compensation startup through the stopping guard. Unsettled shutdown retains its
ownership evidence and failed status; it never claims readiness. Stale-owner
cleanup also avoids resume after sending shutdown. The server rejects a late
resume as soon as it acknowledges shutdown, before asynchronous cleanup starts.

Offline checks cover an active synthetic response surviving a preference change
with the same PID, subsequent adapter policy, persistence/readback, idempotent
retry, authentication/Origin/input/PID guards, config drift, invalid persistence,
manual-mode refusal, delayed shutdown, replacement ordering and failed ownership
retention. These checks use no provider requests. Installed hashes, route
preflight and guardian health evidence belong to the candidate package report;
they do not prove an actual ChatGPT turn or automatic approval click.

Toolchains retain upstream release pins: Bun 1.4.2 and Electron 44.9.0. Local
Node tests use v26.11.1. No dependency changes are needed for this repair.
