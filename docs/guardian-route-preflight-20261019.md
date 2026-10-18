# Guardian route preflight incident (2026-10-19 KST)

## Cause and recovery attribution

The 6.1.10 guardian did not write `openai_base_url`. It shut down a live daemon
without first validating the route state needed by the next startup. Health and
artifact hashes alone did not expose the inconsistency.

The route journal was version 10, `active: false`, `reconnectOnStartup: true`,
with both previous Responses and realtime assignments absent. The Codex config
contained manually restored bridge Responses and realtime URL assignments.
Upstream correctly refused that changed disconnected route rather than
overwriting newer configuration. Launcher startup therefore failed while Codex
clients kept reconnecting. The guardian's existing-owner protection also
correctly refused to kill or duplicate the failed launcher.

Evidence on 2026-10-18 UTC:

- 14:01:12: guardian requested normal quit after observing zero active turns.
- 14:02:10: upgrade preflight rejected `openai_base_url` changed while
  disconnected; 14:02:14 recorded `runtime.startup_failed`.
- 16:56:36: Claude tower inspected the inactive journal and absent baselines.
- 16:56:53: tower backed up config and removed the two manually added lines.
- 16:57:02: tower restarted the launcher. At 16:57:26 the 6.1.10 daemon started;
  the launcher subsequently reconnected through its normal managed route.
- 17:00:53: our later observer confirmed the already recovered process healthy.
  This was not successful recovery by the original guardian.

Sources: local launcher JSONL, reservation
`a62b14414a334d7bb9d659619af7ac11`, and the Claude project session
`872e26cf-f981-463d-803a-118bb5678ec3` (lines 157990, 158018, 158039,
158040). The tower's diagnosis records that the URL lines had been restored by
hand on October 16. It repaired configuration, not the upstream bridge source.

## Prevention

The standalone maintenance script now checks route consistency before arming
and again before drain/quit. It uses the pinned installed CLI/Bun against an
isolated config/journal snapshot, since upstream `route status` can repair
journal copies. It validates JSON errors even when the CLI exits zero,
endpoint, Codex-home identity, checker hashes, and unchanged source hashes.

Mismatch before arming creates no guardian. Mismatch before quit records
`preflight_rejected` and performs no drain, quit, installer invocation or
relaunch. The guardian retires that rejected transaction without retrying or
claiming `complete`/`healthyAt`. It does not edit live routes or relax upstream
route ownership. A configuration change after the final check remains an
external race; do not run competing route editors during maintenance.

## Executed verification

- Original-CLI route preflight fixtures: 21 cases, including the incident,
  active/disconnected/recovery states, hook/marker drift, mismatched home,
  journal repair isolation, exit-zero errors, timeout and concurrent writer.
- Active-turn/drain guards: 7 cases, including pre-quit checker drift and old
  reservations without a route checker.
- Idle-window guards: 7 cases. Reviewed engine/hash guards: 13 cases.
- Independent restart/rollback fixtures: 7 cases, including terminal route
  rejection while preserving the healthy fixture owner.
- Existing upstream route integration suite: 47 passed, 0 failed.
- Live read-only check and actual reservation constructor: 6.1.10 accepting
  turns, launcher PID 2244 and daemon PID 65164 unchanged; config and both
  journals byte-for-byte unchanged. Constructor was not armed.

Only maintenance code/tests/docs changed. No runtime/launcher rebuild,
installation, production restart or provider test prompt was performed for
this fix. Future reservations must use the corrected source script; sealed
workers in historical reservations remain untouched. The update skill was
amended to require the check and accurate recovery attribution.
