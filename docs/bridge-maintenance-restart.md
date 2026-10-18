Launcher maintenance must use `scripts/schedule-bridge-maintenance.ps1`. It reserves and verifies a Windows Task Scheduler action **before** any drain or quit. If Windows denies task registration, it starts an independent hidden PowerShell guardian, verifies its process identity, and waits for its readiness acknowledgement instead. The reserved process owns the entire transaction, so loss of GPT or the calling shell does not remove its restart step. Do not reuse the historical `scratch/.../apply-and-restart-r*.ps1` controllers.

Pass the reviewed plan and installer paths and their SHA256 values, `-Action Reserve`, `-Operation Restart|Install|Rollback`, and `-ShutdownAuthorized`. This authorization flag describes the already approved maintenance window. Registration returns `armed.json` and the task's next run time; the task starts five seconds later. The reservation contains no control tokens or browser credentials.

The task requests normal launcher quit only after rechecking the reserved owner and idle browser state. It invokes the existing reviewed installer for a requested overlay change. Its `finally` recovery starts the launcher and checks for a healthy daemon accepting turns, including when installation fails. It waits for owned processes and any surviving installer, verifies a complete reviewed runtime, and uses the same installer to roll back a partial known installation before restarting. It never starts a duplicate or force terminates a process.

Before arming a non-probe reservation, and again immediately before drain/quit,
the worker validates the Codex route using the installed original CLI. A healthy
daemon alone does not prove the next launcher startup will accept `config.toml`.
The reservation pins the checker CLI/Bun hashes and Codex home. The check copies
only `config.toml` and the two integration journals into a disposable private
snapshot, retargets the snapshot journals to the snapshot config, and invokes
`route status` with isolated homes and a 15-second deadline. Original status can
repair journal copies, so it must not run against live files as a supposedly
read-only maintenance check. No raw config, previous URL or CLI diagnostics enter
receipts. Source hashes must remain unchanged throughout the check.

Require valid JSON, `installed: true`, a boolean `active`, an empty `errors` array
and the reviewed bridge endpoint. Exit zero alone is insufficient. A consistent
active route, deliberately disconnected route, or runtime-recovery route is
allowed. An inactive journal with manually restored bridge URL lines is not.
Never bypass upstream route protection or manually reinsert/remove URL lines to
make a guardian proceed; reconcile the conflicting route separately first.

A failed reservation preflight arms nothing. A failed pre-quit recheck records
`phase: preflight_rejected`, leaves the current launcher running, performs no
drain/quit/install/relaunch, and terminates the reservation without recovery
retries. This is not installation success and must have no new `healthyAt`.
Old reservations without a pinned checker are rejected before quit; prepare a
new reservation with the current script. Existing sealed worker copies are not
rewritten. The offline tests are `test-bridge-maintenance-route-preflight.ps1`
and `test-bridge-maintenance-active-turns.ps1` alongside the restart fixtures.

When the user has already authorized replacing the bridge while its turns are active, pass `-AllowActiveBrowserTurns` with `-ShutdownAuthorized`. The sealed reservation records that choice and the observed active count. Owner identity, acknowledged drain, independent restart, and zero processes before file replacement still apply. The default requires an idle browser; the explicit option records the count at normal quit for the manager to reconcile interrupted turns. It does not resend a prompt or authorize work in any other application.

The scheduler or guardian retries a failed recovery up to three times, one minute apart. A retry resumes recovery; it does not resend Browser.close or repeat the original installation. An unknown runtime hash remains an explicit failure with its receipt. Success removes the one-shot task or exits the guardian; receipts and logs remain under `.codex-chatgpt-web/runtime/restart-reservations/`. Task expiry bounds unfinished scheduler reservations to 30 minutes. The guardian does not forcibly end a transaction or a surviving installer.

Use `-Action Probe` with the same reviewed paths and hashes to verify actual reservation and independent execution without stopping, installing, or starting the launcher. `armed.json` records the selected backend and any actual scheduler error. An installer failure followed by successful launcher recovery is recorded as `operationSucceeded: false`, not a successful deployment.
