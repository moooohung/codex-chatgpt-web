# Bounded multipart checkpoint batches

The installed 6.1.5 integration still summarized each 48,000-byte escaped source
fragment separately. One observed source (870,774 characters, 886,411 UTF-8 bytes)
required 28 consecutive checkpoints and 1,356,298 milliseconds of stage time.
Other adjacent runs carried almost the same source. Browser stage completion is
not proof that native Codex committed replacement history; the repeat cause is
not established by those logs alone. Native records then confirmed two interrupted
turns. Each parsed interruption adds 282 characters plus a JSON-array comma: the
exact 283-character increment between adjacent source plans. The old compaction
owner was allowed to finish every stage while its successor waited on that owner.

A subsequent checkpoint request now cancels unfinished compactions belonging to
exact prior native turn IDs that Codex marked as interrupted in that same thread.
It waits for physical cleanup before starting its own work. Quoted interruption
text, another thread, HTTP observer disconnects and committed checkpoints do not
revoke an owner or bypass its settlement gate.

When Bigger Context is enabled, checkpoint preparation now groups at most four
ordered fragments. Each fragment is its own semantic JSON record, so the existing
multipart partitioner can carry it without splitting a record. All parts still
require their normal transaction/hash acknowledgement before final execution.
The selected model and final effort are preserved. Inert uploads must fit Instant
or ordinary Thinking; Sol compaction never requires Pro uploads.

Preflight chooses the fewest messages that fit all of these bounds:

- 110,000 UTF-8 JSON bytes per physical message;
- the existing account/effort composer and token limits;
- the selected mode's ordinary auto-compaction input budget, without a Bigger
  Context multiplier, including images, hidden reserve and acknowledgement text;
- 320,000 aggregate prompt characters per temporary document;
- room for the next checkpoint before choosing a batch.

The actual cumulative checkpoint is checked again before submission. Unfitting
batches shrink; no history is discarded. Disabling Bigger Context retains single
fragment stages. Browser/helper physical settlement remains sequential and owned
through cancellation. Images remain ordered, real attachments after source text.

Offline synthetic input at the observed scale used 34 original fragments. Pro
account capability with Sol execution required 9 summaries; Plus required 10.
This measures planner decisions and complete compiled transport coverage, not
live model latency or semantic summary quality. No live or Pro test messages were
sent. The final latest-human-prompt appendix is still authenticated from the
original native request, independently of intermediate checkpoints.

Token-free logs now distinguish `compaction_plan`, each completed batch,
`compaction_handoff_returned` and `compaction_response_prepared`. The last event
means the server prepared replacement output; it does not claim client receipt
or a durable native `compacted` record.

The related Message delivery timed out UI detector no longer requires a visible
Retry button. Detection remains scoped to the currently bound assistant response
and excludes hidden banners, generated prose, code and user bubbles. Existing
continuation guards still require generation, tools and pending approvals to be
idle, preserve duplicate receipts and stop after three attempts. The submitted
screenshot could not be matched to a surviving live banner; this addresses the
button dependency, not all tool-boundary DOM timeouts observed in separate logs.
