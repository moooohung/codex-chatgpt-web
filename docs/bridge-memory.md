# Browser memory policy

The launcher owns one `WebContentsView` per admitted automatic browser turn.
`BrowserHost.beginTurn` reuses a keyed ready tab or creates a new one. Non-retained
terminal turns already close their views. Previously, retained views could remain
loaded for 30 minutes. The daemon's `ChatGptBrowserRunQueue` holds its permit until
the physical browser operation settles, and keeps queued request heartbeats alive.
The logical session registry admits up to 32 active-or-waiting jobs independently
of the physical tab cap, so the fifth job reaches the queue instead of failing.

The memory policy closes a completed, hidden automatic tab after 60 seconds idle
(the existing lease sweep runs every five seconds). The next request receives a
fresh surface and uses the complete Codex request/checkpoint through `prepare()`,
not the incremental `prepareResume()` prompt. Account assignment remains keyed by
the same Codex conversation, and model/effort continue to come from that request.
It never reloads an assumed recoverable temporary-chat URL, saves a temporary chat,
or changes account settings. Required-retained compaction already falls back to
the full source context when the retained tab has been evicted.

Running tabs, including active tool calls and compaction, are not memory-evicted.
Turn-count and memory thresholds also recycle a ready tab immediately before its
next normal turn, even when turns arrive faster than the idle grace period.
Required-retained compaction bypasses this next-turn recycling check.
A completed selected tab stays loaded while its browser surface is visible.
Duplicate end notifications do not increment the turn count or restart the idle
clock. Normal reuse clears the idle marker synchronously. The existing 30-minute
retention expiry, orphan cleanup, and admission eviction rules still apply.

## Configuration

Set these environment variables for the launcher and daemon before launching.
All defaults work without writing account, model, effort, or application config.
The launcher propagates its environment to its supervised daemon. Independent
daemon launches must use the same maximum tab setting.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CODEX_WEB_GPT_RELEASE_IDLE_TAB_MEMORY` | `true` | Close completed hidden automatic tabs after the idle grace period. |
| `CODEX_WEB_GPT_IDLE_TAB_TIMEOUT_MS` | `60000` | Idle grace, 0–1800000 ms; next-turn threshold recycling does not wait for idle. |
| `CODEX_WEB_GPT_RECYCLE_AFTER_TURNS` | `8` | Recycle a retained renderer after N completed turns, at a safe idle boundary; 0 disables. |
| `CODEX_WEB_GPT_RECYCLE_RENDERER_MB` | `512` | Recycle above this process-memory threshold; 0 disables. Values are MiB. |
| `CODEX_WEB_GPT_MAX_BROWSER_TABS` | `4` | Daemon FIFO admission and launcher physical-tab cap, 1–8. |
| `CODEX_WEB_GPT_DISABLE_BFCACHE` | `true` | Add `BackForwardCache` to existing disabled Chromium features before app readiness. |
| `CODEX_WEB_GPT_DISABLE_GPU` | `false` | Optional hardware-acceleration disable; not enabled by default. |
| `CODEX_WEB_GPT_RENDERER_JS_HEAP_MB` | `0` | Optional V8 old-space limit; 0 leaves it unchanged. Existing explicit heap flags win. |
| `CODEX_WEB_GPT_THROTTLE_IDLE_TABS` | `true` | Throttle completed tabs. Active automation remains unthrottled. |

Turn-count and memory recycling still work with ordinary idle release disabled.
To opt out of every new retention/cap change, disable idle release, set both recycle
thresholds to 0, and set the maximum to 8. Chromium controls are independently
switchable. Invalid values use the documented defaults.

`browser.tab_memory_sample` records completed-turn renderer PID, working set and
private memory. `browser.tab_memory_released` records reason, completed-turn count,
idle age and the preceding memory sample. Electron reports its `getAppMetrics()`
memory fields in KiB; the policy converts them to MiB and matches
`webContents.getOSProcessId()`. Private bytes are preferred on Windows, with working
set as a fallback. Missing metrics are unknown, never a zero measurement.

## Expected effect and tradeoffs

Closing a tab releases its renderer/document ownership; Chromium may share some
resources across tabs. The tower's supplied baseline was 510–630 MB working set per
busy renderer. That is a per-tab opportunity, not a measured saving from this patch.
Reducing five simultaneously active browser turns to four can avoid approximately
one such renderer at the cost of queueing. Reopening a cold tab reloads ChatGPT and
replays the full Codex context, increasing latency and potentially input tokens.
GPU savings and heap-limit effects require separate post-install evaluation.

The isolated Electron smoke and unit tests do not replace a live authenticated
ChatGPT automation check. Keep GPU acceleration and the default V8 limit unchanged
until that check passes on the target machine.

## API references

- https://www.electronjs.org/docs/latest/api/app#appgetappmetrics
- https://www.electronjs.org/docs/latest/api/structures/memory-info
- https://www.electronjs.org/docs/latest/api/web-contents#contentsgetosprocessid
- https://www.electronjs.org/docs/latest/api/command-line-switches
- https://help.openai.com/en/articles/8914046-temporary-chat-in-chatgpt
