# Owned ChatGPT turn rendering budget

The bridge leaves every conversation text node and stable turn identity intact. Older turn roots use `content-visibility:auto` with an intrinsic placeholder. Submitted user blocks of at least 32,768 characters receive the same treatment, including the large final multipart input. The two latest turn roots and the current assistant response keep normal rendering. Model/effort menus, composer, approval UI and the current answer's animations are outside the reduced-motion rules. Settled history and submitted user blocks use one very short animation/transition iteration, preserving completion events.

Electron's native `onBeforeRequest` listener applies only to an owned, running automatic turn on the ChatGPT root or conversation page. It blocks fonts/decorative images on two explicit static hosts, known analytics hosts and the exact GET sidebar-list endpoint. Auth/challenge frames, document navigations, unknown hosts/paths, app scripts/styles, conversation detail/streaming, uploads/user images, model/effort and connector traffic pass through. Chromium's HTTP cache stays enabled. Set `CODEX_WEB_GPT_REDUCE_TURN_RESOURCES=0` on the launcher process to disable optional request blocking. Per-tab logs contain reason counts and native renderer PIDs, without URLs, prompts or tokens.

Non-retained successful turns and fatal turns send their normal authenticated owned END before the final DOM diagnostic or transport cleanup. The result is reused once by the authoritative finally. Usage writes, prompt release and physical transport settlement remain awaited. Required retained/compaction continuations keep their existing document/URL contract; saved retained conversations park on the idle document. There is no forced ACK or cross-tab close.

## Offline measurement

`scripts/measure-render-budget.ts` starts an isolated Electron host and a loopback TLS fixture. Only the three fixture hostnames resolve to the loopback server; that isolated session accepts only its exact certificate. It creates identical 320,000/1,000,000-character transcripts, a 28-row optional sidebar, 16 decorative SVGs, one local font and one analytics script. Each scenario performs nine identical width invalidations and scalar DOM observations, then an 800ms idle window. OS samples measure the explicit renderer PID. The fixture closes through the real `BrowserHost.endTurn` / `removeTurnTab` path and verifies that renderer exits.

One sequential run on Electron Chromium 146.0.7680.216, 725×431/DPR1:

| Source characters | Policy | Renderer private MiB | CPU cores during sample | DOM median ms |
|---:|---|---:|---:|---:|
| 320,000 | Baseline | 114.7 | 0.094 | 1.408 |
| 320,000 | History + multipart | 65.6 | 0.026 | 1.045 |
| 320,000 | Resources + sidebar | 115.3 | 0.119 | 1.902 |
| 320,000 | Reduced motion | 114.8 | 0.098 | 1.222 |
| 320,000 | Combined | 83.8 | 0.038 | 1.116 |
| 1,000,000 | Baseline | 285.0 | 0.225 | 1.694 |
| 1,000,000 | History + multipart | 121.1 | 0.051 | 1.559 |
| 1,000,000 | Resources + sidebar | 280.5 | 0.236 | 1.568 |
| 1,000,000 | Reduced motion | 285.1 | 0.206 | 1.571 |
| 1,000,000 | Combined | 188.1 | 0.119 | 1.531 |

All ten transcripts preserved source hashes, user/assistant identities, the current response projection and five required offline transports. Resource-enabled cases blocked 19 optional requests and loaded no analytics script. All ten completed/failed documents released their renderer. The components are not additive: font fallback changes layout, memory is sampled after layout invalidations, and short CPU windows have coarse resolution. Request blocking and reduced motion alone did not consistently lower memory or CPU. These are synthetic measurements, not authenticated ChatGPT latency, worker recovery or a sustained memory-leak certificate. Earlier protocol-handler trials did not exercise native request blocking; their artifacts are retained as rejected measurement methods. Earlier 2,000-row sidebar stress runs are separate from this 28-row comparison.

Browser fixtures cover source and both compiled projections at both sizes, model/effort selection without Send, multipart acknowledgement, capture→observe→ACK before emission, completion controls, cancellation and retained continuation. AST overlays preserve all 34 compiled `runStage` argument lists and reverse every unowned byte. Native-host fixtures cover request allow/deny scope and terminal cleanup when contents have already been destroyed. Authenticated worker resumption remains the manager's responsibility.
