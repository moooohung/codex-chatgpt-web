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
