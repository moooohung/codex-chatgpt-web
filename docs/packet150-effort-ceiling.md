# Packet 150: account effort ceilings

Automatic ChatGPT browser turns now select the highest unlocked position at or
below the requested effort in the selected model family. Pro remains a separate
mode: a missing or locked Pro position errors before Send. The old Plus recovery
path that changed Pro to High or changed GPT-6 to GPT-5.6 is no longer invoked.
The existing capability routing, including `extraHighAvailable` and xhigh-to-high
routing, runs before this picker-based clamp.

Selection and the final physical Send check both read the owned picker. A newly
locked tick at that final check reselects and replaces the caller's effort proof.
Keyboard movement may pass through locked ticks or skip them; it must move toward
the verified target without overshooting it. Family verification still runs on
the resulting selection. The actual mode's context limits are checked before Send.
Intentional Pro multipart staging is preserved; it is not treated as a clamp.

The launcher control channel binds observations to the exact running trace and
helper PID and derives the account from that lease, rather than trusting an account
name supplied by the helper. `launcher-state.json` stores `effortCeilings`, with
only the local account slot, family, requested/actual positions, `observedAt` and
`lastCheckedAt`. No browser storage or account credentials are persisted there.
A lower multipart staging request cannot erase a remembered higher request.
An unlocked original position removes the ceiling immediately on the next picker
observation. A ceiling never suppresses a picker read. A reused selection proof
expires after ten minutes, and a clamped proof cannot satisfy the original higher
request's reuse shortcut. Reuse also requires the same original request, so an
explicit Medium request cannot inherit a previous High request and later upgrade. Restarting the helper also discards selection proofs.
Idle accounts are observed when they next submit; no idle browser Send is created.

The launcher logs `effort_clamped` and `effort_restored`, including account, family,
requested position and actual position. Its existing status-notice layout displays
`생각 강도 제한 중: High → Medium (자동 복구 대기)` in Korean, with the account and
family underneath. The notice comes from persisted state and survives restarts.

Physical Send evidence crosses the helper protocol and the response journal.
Both streaming terminal Responses and JSON Responses include string metadata:

```json
{
  "chatgpt_model_family": "5.6",
  "chatgpt_requested_effort": "high",
  "chatgpt_actual_effort": "medium",
  "chatgpt_requested_effort_position": "3",
  "chatgpt_actual_effort_position": "2"
}
```

Positions in metadata, state and logs are one based. The reported requested
effort is after capability routing. Manual Zero Risk turns remain outside this
automatic browser path and do not invent picker evidence.

## Validation and packaging

The full root suite passes with 1,316 passed, 126 skipped, zero failed. The launcher
suite passes with 535 passed, nine platform skips, zero failed. Both typechecks
pass. Explicit headless browser fixtures test a reduced picker, lock changes at
the Send check, restoration, the ten-minute proof limit, skipped locked ticks,
exact family retention, and missing/locked Pro. State/control tests cover atomic
persistence across restart, restoration, lower staging requests and foreign helper
rejection and restoration when a picker widens during confirmation. JSON and streaming metadata and Korean notice copy are covered.

The rebuilt, relocated runtime passes the existing release smoke test and the
launcher's full manifest/hash verifier. These are isolated local/fixture checks;
this packet does not claim live ChatGPT account recovery or production installation.
Logs and artifacts are under `D:\Download\codex-chatgpt-web\output\packet150`.

The installed runtime has local code edits absent from source commit `4560f08`.
`scripts/packet150-preserve-installed.cjs` inventories them at function/method
boundaries. Reconstructing both installed bundles from the baseline source build
is byte-identical, proving the inventory accounts for every installed edit.
Unchanged scopes are transplanted into the candidate with checked identifier
mapping. Packet 150 owns the selector and final effort verifier; the latter also
retains the installed initial origin-only URL guard. A changed installed bundle
hash, ambiguous mapping, changed preservation scope, or unaccounted byte fails
packaging. The preservation receipt is `runtime-preservation.json`.

All five baseline renderer files independently rebuilt byte-identical to the
installed archive. `launcher/scripts/packet150-stage-installed.cjs` preserves the
installed archive's dependencies and code outside the allowed files. It replaces
the three Packet 148 verification files, Packet 150's main/control/state files,
new ceiling module and renderer JavaScript/index. Packet 146's locale guard is
byte-identical to the installed archive, and `disable-http-cache` remains present.
The runtime compares all 6,038 manifest files: only `app/cli.js`,
`app/browser-helper.cjs` and the regenerated `manifest.json` differ.

The stage script copies only named Electron distribution binaries and locales.
It deliberately excludes the installed directory's profile/passkey backups and
other historical artifacts. The installer is built from that staged app using
`electron-builder --prepackaged --win --x64 --publish never` with
`--config.nsis.runAfterFinish=false`. It is extracted for payload verification;
it is not executed or installed by this worker.

The final application is `output\packet150\package-release\win-unpacked`; its
file-level comparisons are in `package-release\package-diff.json`. The complete
installer is `output\packet150\installer-release\codex-web-gpt-6.1.7-win-x64.exe`.
SHA-256 values and installer payload verification are recorded in the tower inbox
result rather than inferred from a successful builder exit.

## Install and rollback (tower owned)

1. Verify the inbox result's artifact hashes and the current installed ASAR hash
   `212531f22089519c243aa1e5b99c0db94d2898c3e3bf6a2dabe3b6d977963567`.
   If the installed code or runtime differs from the recorded baseline, compare
   it again before replacing anything.
2. Pause the tower's existing restart watchdog, exit the launcher, and verify it
   is stopped. Back up both `resources\app.asar` and the entire `resources\runtime`
   code directory. Preserve their baseline hashes and manifest together.
3. Install the final installer, or replace the ASAR and runtime as a pair from
   `package-release\win-unpacked\resources`. For a manual replacement, copy runtime
   to a new sibling directory, verify it, and rename only after the launcher exits.
   Do not mix a new bundle with the old manifest. No browser profile migration is
   required.
4. Read back the installed ASAR/runtime hashes and validate the new runtime manifest.
   Resume the watchdog and start the launcher. The first new process hashes the
   bundle; Packet 148 caches later unchanged checks within that process.
5. Observe an ordinary restricted account turn: it should Send at the unlocked
   ceiling and report actual effort. When the picker exposes the original request,
   confirm `effort_restored` and the notice disappearing. This live gate belongs
   to the tower.
6. Roll back by pausing the watchdog and exiting the launcher, restoring both
   backed-up code artifacts, validating their original manifest/hashes, then
   restarting. The added state field is optional and requires no profile deletion.

## Dependency boundary

Official registry checks on 2026-10-10 found Playwright 1.64.0, React 19.3.0,
Electron 44.7.0, electron-builder 26.15.3, Bun 1.4.3, ASAR 4.3.1 and Acorn 8.19.0.
The installed 6.1.7 manifest hard-pins Bun 1.4.2 and its runtime dependency tree;
this packet must preserve those bytes. The root/launcher typechecks use the
repository's existing compiler lock. Isolated packaging tools pin
`@electron/asar@4.3.1` and `acorn@8.19.0`; Acorn provides current ECMAScript parsing
without depending on TypeScript's changed compiler API. Context7 was consulted
for Playwright, Node filesystem/hash APIs and Acorn parse/token ranges. Dependency
update automation is unchanged.

This worker left the running app and installed files untouched. It did not read
cookies, tokens or browser-storage contents. `scratch/` was not modified or staged.
