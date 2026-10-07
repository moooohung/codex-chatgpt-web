# Computer Use through Native2

Baseline: integrated 6.1.5, `3f09e0dc25239bcb679bb4548b162abc9c9d3216`.

## Cause and scope

The installed Windows Computer Use skill uses `node_repl` and the official
`@oai/sky` package. Native calls can be nested inside the freeform `exec`
gateway. Counting only standalone `cua_*` calls misses those calls. The native
plugin job `task-muyej12u-j4ahig` actually invoked `node_repl` 29 times, including
window observation, a click and a key press. Its thread is
`01a1177b-8b36-7500-b5ce-87169f914d0f`. This is evidence of actual native use,
not evidence that every plugin job used the skill correctly.

The current plugin-style app-server initialization (`experimentalApi=false`)
registered `node_repl` in an independent `mcpServerStatus/list` probe. A visible
skill alone does not establish registration or backend health; neither should
the absence of a standalone Computer Use tool name establish unavailability.

A separate Native2 discovery bug was reproduced through the actual native
runtime. Codex's `exec` result includes `Script completed`, timing and `Output:`
labels before its output. Native2 parsed the whole response as JSON and returned
`Native nested tool inventory returned invalid JSON`. This prevented discovery
of nested tools, including the Computer Use JavaScript entry point.

## Change

Each nested catalog request now prints its JSON inside a frame with a fresh
random nonce. Native2 extracts exactly that frame, rejects missing, duplicate
or stale frames, and retains catalog/schema/name validation. It still invokes
only tools registered in the current runtime and uses the current turn's broker
capability. The frame nonce is not a capability and does not grant tool access.

The descriptions of registered `mcp__node_repl__js` / `node_repl__js` entries
now contain Computer Use search terms. Queries for `computer use`,
`computer-use`, `node_repl` and `@oai/sky` can find the existing entry. No entry
is fabricated when the runtime lacks it. Tool-capable Web prompts explain the
installed skill path, exact inventory/call flow, deferred-loader discovery and
how to report an actual registration or backend failure. Read-only and
compaction contracts remain unchanged.

## Verification

- Focused inventory/prompt fixtures check schemas, nested output envelopes,
  missing registrations, stale catalog frames, input arguments and screenshot
  image preservation.
- The desktop's official `@oai/sky` runtime observed a dedicated WinForms
  fixture, typed a test string and clicked its Record button. The receipt
  contains the expected text. One explicit click API action produced a counter
  of two; the cause is unresolved. This verifies delivery, not exactly-once
  input semantics.
- `scripts/smoke-codex-computer-use.ts` runs an isolated native Codex turn
  against a loopback fixture provider. It copies only the local `node_repl`
  registration into its own temporary Codex home, removes any inherited
  desktop core registration, and receives an actual fixture-window screenshot.
- The same script with `--native2` exercises Native2 MCP inventory, the native
  `exec` catalog, the exact discovered wire, the native runtime's `node_repl`,
  `@oai/sky`, and the returned screenshot image. This path failed on the old
  catalog parser and passed after the framed parser change.

The GUI fixture auto-closes after ten minutes. Build it with the system C#
compiler, then launch and select it through the documented Computer Use API.
Do not substitute direct helper protocol calls or a standalone MCP invocation
outside its supported native tool runtime. Such contextless probes failed here
even though both actual native and Native2 tool execution succeeded.

These checks use no production model request, Pro allowance, game input or
STS2 job mutation. They establish the tool transport and installed backend,
not a real Web model's autonomous skill selection or every game interaction.

## Plugin-side guidance and remaining limits

No unconditional change to the tower-owned plugin cache is required by this
evidence. Its existing app-server initialization already registers `node_repl`.
Keep the resolver, LIVE_STREAM and PRUNE_THREADS patches. For diagnostics the
tower can query `mcpServerStatus/list` with `serverName="node_repl"` and
`detail="toolsAndAuthOnly"` on the job's own initialized app-server, then check
actual nested tool calls in its rollout. Do not inject guessed `cua_*` tools,
borrow another session's capability/core registration, or drive a helper's
private protocol.

Official Windows Computer Use still shares the physical desktop and input.
Installing or discovering it does not isolate the mouse from the user or other
jobs. Coordinate interactive actions and select a freshly returned target
window before acting. Closed-source helper behavior, a genuinely missing
runtime registration, and future runtime envelope changes remain separate
failure possibilities.

## Deferred installation guard

The previous capacity reservation completed without invoking the installer or
stopping the launcher: a five-second health request timed out while it was
waiting for idle. Its `healthyAt` proved recovery of the old runtime, not a
successful upgrade. The idle guard now treats a failed health sample as unknown,
resets its consecutive idle count, records the error and retries within the
bounded waiting budget. It never drains or quits on an unknown sample. Protected
jobs must be terminal and two successful samples must report zero HTTP and
browser turns before installation. Seven isolated guard fixtures cover this
behavior. A fresh independently armed reservation is required for the combined
candidate; the old immutable reservation is not reused.
