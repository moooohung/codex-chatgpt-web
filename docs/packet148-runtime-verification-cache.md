# Packet 148: process-lifetime runtime verification cache

The launcher hashes each runtime tree once per process and bundle identity. Later
calls compare the exact manifest text, tree membership, canonical root and every
manifest file's size, mtime, inode, device, mode and realpath. Differences discard
the cached verification and enter the full verifier. Invalid tree membership or
an escaping symlink still fails before content hashing, as in the original verifier.

Inodes and devices use exact BigInt values because Windows file IDs can exceed
JavaScript's safe integer range. Nanosecond mtimes supplement `mtimeMs` without a
second stat call. The accepted limit is an in-place edit that preserves size and
mtime: it is undetected until the next launcher start. Cache entries never go to disk.

`runtime-install.cjs` owns the shared cache in the launcher main process.
`runtime-verification.cjs` serializes verification jobs, supplies relevant cache
entries to each fresh worker, and imports the worker's successful or invalidated
entries. A newer synchronous validation takes precedence over a stale worker
snapshot. A rejected job does not prevent later jobs from running.

During installation, a successfully verified temporary tree carries its
fingerprints through the atomic rename. The destination still receives a manifest,
tree, stat and realpath check. It is not hashed again when the files are unchanged.
Packet 146's per-session locale promise guard and Windows `disable-http-cache`
switch are carried into source byte-for-byte from the installed application.

## Validation

The final launcher suite ran with `bun run launcher:test`: 531 passed, 9 platform
skips, 0 failed (540 tests). Its runtime-install file contains 38 passing tests,
including spies for first/second hash passes, size/mtime/inode/device/mode/realpath
changes, additions/removals, manifest changes, bundle identity, cached symlink
escapes, rename reuse, main/worker cache exchange, concurrent workers, worker
failure recovery, stale snapshots and the documented restart limit.

The root suite ran with `bun run test`: 1,313 passed, 125 skipped, 0 failed
(1,438 tests across 128 files). Root and launcher typechecks passed. Syntax checks
and `git diff --check` passed. Logs are under
`D:\Download\codex-chatgpt-web\output\packet148\`.

The actual installed runtime has 6,038 manifest files and 169,535,494 content
bytes. Fresh Node processes counted calls against the installed baseline code
and candidate code, using isolated code-only destinations. No runtime command
or application was launched. Each full pass makes 6,039 `createHash` calls: one
for the manifest file-record identity and 6,038 for file contents.

| Verification scenario | Content reads/hashes before | After | `statSync` before | After | `createHash` before | After |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Startup, existing destination | 18,114 | 12,076 | 18,114 | 18,114 | 18,117 | 12,078 |
| Startup, new destination | 30,190 | 12,076 | 30,190 | 24,152 | 30,195 | 12,078 |
| Five subsequent invocation constructions | 30,190 | 0 | 30,190 | 30,190 | 30,195 | 0 |

These counts imply 33.3% fewer startup content reads/hashes with an existing
destination and 60% fewer with a new destination. Subsequent unchanged
invocations avoid all runtime content reads/hashes while retaining stat checks.
One manifest read per validation remains. Realpath calls also fall: existing
startup 38,358 to 20,241; new startup 63,930 to 26,989; five later invocations
63,930 to 33,735.

Separate fresh-worker probes used the packaged candidate code and actual bundle
for startup wait/install plus async `serve`, relay-connect and doctor invocation
construction. They confirm the cache survives worker replacement. Their counters
are in `counts-workers-baseline.json` and `counts-workers-candidate.json`.
The counts support an expected IO reduction; live application startup duration,
IO operations per second and RAM effects remain unmeasured by this packet.

## Packaged artifact and installation

`D:\Download\codex-chatgpt-web\output\packet148\package\app.asar`

SHA-256: `1d1631892e3d6527e4f7836517b7b7afa5afdc3d796964b01ca52634c56082ce`

The baseline installed archive SHA-256 is
`212531f22089519c243aa1e5b99c0db94d2898c3e3bf6a2dabe3b6d977963567`.
All 1,059 archive file contents and 1,213 entries were compared. Only
`electron/runtime-install.cjs`, `electron/runtime-verification.cjs` and
`electron/runtime-verification-worker.cjs` differ. Membership, executable flags
and unpacked flags are unchanged; the archive contains no unpacked entries.
Packet 146's two mitigation files are byte-identical to the installed archive.
The installed archive remained unchanged throughout validation.

The tower owns installation:

1. Verify the candidate and current installed archive hashes above. If the
   installed hash differs, compare that new baseline before replacing it.
2. Use the tower's existing watchdog procedure to stop app restart and exit the
   launcher. Preserve a backup of the current `resources\app.asar`.
3. Copy this candidate to `%LOCALAPPDATA%\Programs\Codex Web GPT\resources\app.asar`
   and read back its SHA-256. No runtime directory or profile migration is needed.
4. Resume the tower's existing watchdog/start procedure. A new launcher process
   performs the first full verification; measure startup IO/RAM and relay recovery
   under the tower's observation.
5. For rollback, stop the launcher using the same procedure, restore the backed-up
   archive, verify its baseline hash, and resume the watchdog.

This worker staged the archive and did not install or launch it. It did not read
browser cookies, tokens or storage. `scratch/` was left alone.

## Tools and dependency boundary

Use Node's built-in worker structured cloning and filesystem metadata to avoid a
new launcher dependency or a persistent verification database. Official npm
registry checks on 2026-10-10 returned `@electron/asar@4.3.1`, `electron@44.7.0`,
`node@26.11.1` and `bun@1.4.3`. Packaging uses the exact latest `@electron/asar@4.3.1`
pin in the isolated output tooling directory; counter scripts use Node 26.11.1.
Electron 44.7.0 and the bundled runtime are externally pinned by the installed
6.1.7 layout and manifest, which this app-only patch must preserve. Repository
test scripts use the declared Bun 1.4.2 engine; no project dependencies or update
automation were changed.

Context7 was consulted for current Node filesystem/worker APIs and the ASAR API:
[Node filesystem](https://github.com/nodejs/node/blob/main/doc/api/fs.md),
[Node workers](https://github.com/nodejs/node/blob/main/doc/api/worker_threads.md),
[ASAR API](https://github.com/electron/asar/blob/main/_autodocs/api-reference/asar.md).

## Reproduction

The committed `launcher/scripts/packet148-stage-installed.cjs` snapshots the
installed code archive into a new output directory, checks the Packet 146 source,
replaces only the three runtime files, repacks and writes `asar-diff.json`.
It requires the pinned ASAR module path as its last argument.

`packet148-count-verification.cjs` takes a baseline/candidate Electron module
directory, the installed resources directory, a new isolated core home, the
`existing` or `fresh` scenario, and an output JSON path. It constructs invocations
without spawning them. `packet148-count-workers.cjs` takes the same module/resources
and isolated home paths, the test spy preload path, and an output JSON path to
exercise the real worker route. Each probe must run in a fresh Node process.
