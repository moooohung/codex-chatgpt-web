# Current-turn capabilities and unfinished browser responses

A rejected Native token is an error before execution, not proof of compaction. The MCP error result has `code: turn_token_rejected`, `executed: false`, and the original error detail. A call may be retried once only when the current transport supplies a different runtime-issued binding. A rejected current binding requires stopping dependent work; retired capabilities cannot be revived.

The compiler supplies `nativeBinding` as private, request-scoped metadata. The browser helper receives it through IPC. A browser follow-up copies that current binding directly instead of looking up a token in old conversation text. Historical token errors and compaction notices concern their original turns.

On a settled tool-capable response, the browser checks for an explicit unfinished report before committing the broker completion fence. It rechecks the activity revision before sending a follow-up, resets the response trackers, and waits for a new assistant identity. Up to five follow-ups share one turn and one execution owner. A claim that tools are absent can trigger a catalog verification once only if no current tool batch executed.

Actual tool/platform rejections, authorization requests, cancellation, completion, read-only requests and compaction do not trigger follow-ups. The bridge never splits or rephrases an action to evade a denial. Luna retains its single-response rolling-checkpoint contract. Classification is deliberately bounded and cannot prove that the user's entire task is complete; final work evidence remains separate from transport completion.

Diagnostics record only trace, follow-up reason and count. Bindings, prompt bodies and credentials are not logged. Models, reasoning effort, accounts and the eight-tab limit are preserved.
