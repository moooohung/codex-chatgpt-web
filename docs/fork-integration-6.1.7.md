# Fork integration of 6.1.7

Upstream tag `v6.1.7` resolves to `f9ad4ae83a579287105ad822dd0c3e0029b04ef6`.
The fork integration starts from `28332a2a6663d29fa8456079268d6e4ec98eb2a2`.

Conflict resolutions follow upstream's model picker, final response alignment,
viewport sizing, failed-tab inspection, cancellation, permission recovery and
Luna Bigger Context behavior. Luna retains upstream's 1/2/6 partition choice.
The fork retains its bounded DOM probes, tool boundary capture/observe/ACK,
large-context transport, account isolation, rendering reductions, eight tab
slots, Plus fallback and independent restart guardian. Experimental staged
Sol compaction remains opt-in; normal compaction uses the upstream limit.

## Environment continuation (issue 812)

A root thread can receive only a date/time environment delta after compaction.
Recover authority from that thread's canonical native rollout rather than
requiring a child-thread lineage. Date-only deltas require exact native user
message IDs and content after the current `task_started` boundary. The current
instruction is authenticated too. An explicit malformed or contradictory
current start envelope still fails; cached authority, altered deltas, another
task's boundary and unsupported permission changes cannot authorize recovery.

## Runtime and maintenance

Bun and its type declarations are pinned to 1.4.2, Playwright Core to 1.64.0,
and Electron to 44.7.0. Workflow pins and license inputs agree with the runtime.
Packet 131 CI, automatic fork releases and Dependabot remain enabled.

The maintenance guardian can additionally pin the reviewed launcher executable
and engine files in a `full-launcher-upgrade` plan. Recovery accepts only the
original or reviewed candidate executable hash. Missing newly added files
represent an original installation; unknown content fails closed. Existing
seven-file runtime plans remain supported. Engine path, duplicate, source and
hash checks run before reserving shutdown. Idle waiting and the independent
guardian readiness handshake still precede any normal quit.

## Local verification (Windows)

- Core suite: 1,206 passed, 125 skipped.
- Launcher suite: 480 passed, 9 skipped; both TypeScript checks passed.
- Root and launcher dependency audits passed; renderer/runtime builds and
  relocatable runtime smoke passed.
- Synthetic picker fixtures cover 16 current cases; a separate Electron 44.7
  fixture verifies concurrent tab completion, zoom, visibility and open menus.
- Maintenance fixtures exercise engine identity/path rejection, active-turn
  refusal, idle waiting and independent recovery after installer/controller
  failure. Production launcher stop requests in these fixtures: zero.
- A separate full-install clone validates 6,038 runtime files and 72 engine
  files through install, explicit rollback, and failures after the runtime or
  complete engine swap. No production files change in this test.

This is fixture and package evidence. It does not assert a successful live Pro
request, a completed real compaction, or Linux/macOS runtime behavior. No live
ChatGPT prompts are sent by the local validation.
