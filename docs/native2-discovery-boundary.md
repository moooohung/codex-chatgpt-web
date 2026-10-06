# Native2 registry and deferred discovery

`codex_tool_inventory` searches only the tool registry supplied by the current outer turn.
An unmatched filtered query now includes `registry` metadata with the registered tool count,
the exact JavaScript gateway wire (or `null`), the deferred loader count, and confirmation
that inventory did not execute deferred discovery. `discovery_tools` retains the loader's
exact wire and schema. This is diagnostic evidence, not a promise that a missing tool exists
elsewhere.

`exec_command` is a structured shell/PTY tool. It cannot run a `functions.exec` JavaScript
program. Nested discovery requires an actually advertised freeform `exec` gateway and its
actual `ALL_TOOLS` registry. Nested inventory's permissive parameter wrapper is not an exact
native JSON schema: use the declaration in the native description. Direct and loaded outer
function tools retain the exact parameter schema supplied by Responses.

Deferred loading crosses an outer runtime boundary. Call only the advertised `tool_search`
wire using its schema, then inventory the tools supplied in the subsequent outer request
with that request's current capability. The Responses parser merges `tool_search_output`
and `additional_tools` specs without inventing goal or app tools. An empty loader result
does not add a JavaScript gateway or goal/report capability. Never borrow another worker's
turn token, guess app wire names, or store goal state through a shell as a substitute for an
actual goal receipt. Report sends preserve the recipient's selected model by omitting
`model` and `thinking` unless the user explicitly requests a switch.

## Observed failure boundary, 2026-10-07 KST

Worker `01a11181-42a8-70a2-9f8e-9fc2e0f6d516`, turn
`01a1121c-32f4-7e93-a4f8-b2f438fcb657`, ended with a 90-second `tool_search` timeout.
The native snapshot contains no assistant or tool marker. Timing correlates that turn with
broker trace `adb9afdebc80`: queued at 2026-10-06 16:49:06.669 UTC, delivered 16 ms later,
and retired at 16:50:36.673 with one delivered pending call and no completion commit.
This establishes a delivered call without a result, not the deferred backend's root cause,
no-execution proof, child process exit, or absence of an approval. Another trace's later
searches must not be attributed to this failed turn.

Worker 5's saved inventory reported `exec_command`, no JavaScript gateway, and only
`tool_search` for the goal/report search. Current source and installed model catalog use
`tool_mode: null`; the parser already normalizes the default `functions` namespace. No
evidence justifies changing model routing, fabricating missing registrations, retrying the
retired turn, or extending the 90-second deadline. Parent runtime registration and deferred
loader completion remain the boundary requiring further investigation if they recur.

## Offline verification and staged scope

`tests/native2-discovery.test.ts` uses a private synthetic broker and a real MCP stdio
client. It verifies PTY-only rejection of guessed JavaScript/goal/report calls, the exact
loader schema and dispatch, loaded goal/get/create/update/report wires and schemas, token
retirement isolation, nested gateway dispatch, and polling the same PTY session with a
bounded wait. Goal and report implementations are fixtures; no real goal, message recipient,
account, worker token or Web model is contacted. `CODEX_NATIVE2_DISCOVERY_CLI` selects a
compiled candidate for the same fixture.

The discovery addition changes only filtered miss output. MCP tool names, descriptions,
input schemas, annotations, token handling, deadlines, model selection and worker execution
remain under their existing contracts. A candidate adds this output to the reviewed v4
CLI while preserving all other v4 bytes and the existing launcher archive. The original v4
package remains available. Installation verifies exact candidate and original hashes,
backs up the seven reviewed targets, and replaces files only after the owned runtime is
quiescent. Normal shutdown/replacement/restart is authorized by the user's subsequent
instruction; active work and ambiguous sends must be recorded and coordinated first.

Installed hashes and a healthy new PID prove deployment, not recovery of a previously
failed Web turn. Any actual session continuation is recorded separately by its owner.
