# Context transport and effort preparation

`experimentalMinimalContextTransport` defaults to `true`. With Bigger Context enabled, the bridge
chooses one complete inline message or the smallest even multipart count that fits. Compaction
no longer starts at six messages regardless of size. Inline compaction also checks the UTF-8
JSON byte budget; its planner never trims records to make the candidate fit. Whole-record order,
attachment reserves, per-message limits, and the existing total context ceiling still apply.
Set this flag to `false` in the profile's `config.json` to restore threshold-based planning.

Compaction still retires its old conversation and tool capabilities. Keeping the old ChatGPT
transcript would defeat compaction and retain obsolete instructions. A new epoch receives full
canonical context; a same-epoch retained conversation receives its canonical suffix. Multipart
stages still require their exact transaction-bound acknowledgements before execution. Uploading
history as a file is not equivalent to proving that the model ingested every record.

`experimentalReuseVerifiedEffort` defaults to `true`. A successful model/effort selection can be
reused on the same physical page and document while the closed control, label, URL, requested
family/effort and editable composer remain unchanged. This stores UI evidence only. Every Send
still opens the owned picker and verifies its actual family, slider value and availability.
Navigation, changed controls, a different effort, or absent proof takes the ordinary selection
path. Set the flag to `false` to restore preparation through the menu on every stage.

Neither optimization changes account selection, requested execution effort, model routes, usage
accounting, CAPTCHA handling, or task authority. Both flags take effect on daemon restart.

Measure completed requests by pairing `browser.turn_started` and `browser.turn_ended` for the
same trace. Classify fresh/reused from tab allocation and temporary-chat preparation. Measure
acknowledgements and effort preparation from completed `stage=... durationMs=...` events. Keep
offline fixture timing separate from live request timing, failed requests and truncated windows.

When rebuilding a directly patched installation, compare both the CLI and browser-helper against
the source build before replacement. DEV context/compaction telemetry now uses the bundled CoS
dashboard instead of loading `patcher/lib/cos-runtime.js` from the user's home. This telemetry
cannot start goals, mark a pending compaction complete, or change usage accounting.

The source keeps response consistency, exact connector identity, owned-document URL checks,
response-bound Fiber evidence, current-turn environment validation and requested-effort failure
semantics. A live patch that bypasses these checks is not part of the performance optimizations.

## Observer disconnect and execution progress

An automatic browser turn allows five seconds for an exact Responses observer reconnect after
the last observer disconnects. A reconnect reuses the same execution and journal. If none arrives,
the bridge cancels that turn, revokes its MCP capability, and waits for physical helper cleanup and
retained-conversation release before allowing a replacement. A terminal journal prevents a late
reconnect from sending the task again. Normal completion of a tool-result round does not arm this
disconnect timer; native tool execution continues between rounds. Explicit native interruption
keeps its immediate cancellation contract. Manual Zero Risk keeps its existing cancellation policy.

Automatic execution also has an independent `stallTimeoutSec` progress budget, starting when the
browser accepts the final submission or proves current-turn tool activity. Only newly emitted
answer/reasoning/commentary or a new native tool batch/result advances it. HTTP/helper heartbeats,
Stop-button presence, repeated progress snapshots and capability-retirement revisions do not.
At expiry the bridge cancels the browser with error status 504 `upstream_stall_timeout`,
`retryable=false`. An already-open SSE response emits `response.failed`; its original HTTP status
does not change. Already-submitted work must not be automatically resent. A configured value of 600
allows ten minutes of silent reasoning or tool work. The transport watchdog remains separate,
including during preparation. Diagnostic events contain trace/stage/counts, never conversation
text or tokens. `response_observer_detached`, `orphaned_browser_turn_cancelled` and
`browser_progress_stalled` distinguish lost observers, cleanup and stalled execution.

## Completed-turn memory

The terminal session registry keeps exact final outcomes and round journals for reconnects.
Once both the browser outcome and physical cleanup settle, all already-admitted observers finish,
and capability retirement is attempted, the session releases its complete native input and
execution/progress callbacks. A retained-conversation release callback carries only the launcher
descriptor and conversation key. Final text, reasoning, tool call/result IDs and replay events stay
available under the existing retention policy; active or physically unsettled turns keep their
execution state.

Response DOM tracking has one active observer per document. Moving to another assistant response
disconnects the old observer and clears its cached element references. The conversation DOM and
current response consistency checks remain intact. Heap retention fixtures measure references
that become reclaimable, not an immediate reduction in operating-system working set; allocator
capacity and ChatGPT's own page memory must be measured separately.

## Local browser bootstrap

Manifest verification resolves physical paths through `realpathSync.native` when available.
It still enumerates the exact inventory and reads every file to calculate SHA-256 on each check.
The fallback remains available for hosts without that function; size or timestamp caches never
replace content verification. Native path resolution also applies to directory escape checks.

The launcher tab allocator, browser FIFO and native execution registry share an eight-turn cap.
An additional request waits for physical browser release or returns the existing capacity error;
it cannot evict a running tab. The UI reads the cap from the launcher snapshot. Eight occupied
tabs do not imply eight simultaneous Sends or establish latency under eight live conversations.

Local idle documents have a 60-second readiness budget inside the existing 120-second pending-tab
lease. The control client allows 90 seconds for allocation, readiness and ownership marking.
An exact local idle URL with `dom-ready` can proceed without waiting for the full-load promise;
remote login pages keep full-load validation. Other URLs never satisfy local readiness.
An aborted acquisition stops its pending load, removes listeners and destroys only its owned tab.
No replacement task is submitted by this readiness check.

Before any task submission, an exhausted readiness budget returns HTTP 503
`browser_surface_not_ready` with `retryable=true`, rather than HTTP 400. Existing cancellation,
identity and renderer-failure contracts stay separate. Diagnostic timing and booleans distinguish
an uncommitted URL from a committed document with delayed readiness; no document text, query,
control token or credentials are recorded. `browser.tab_initialized` records the readiness signal
and elapsed milliseconds. This budget does not extend a live ChatGPT turn's progress timeout.
