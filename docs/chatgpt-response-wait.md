# ChatGPT response wait notices

Read-only production inspection on 2026-10-07 16:44Z found both notices in short
`role=status` UI. The affected DOM responded in 7–13ms, and native tool batches had
continued after the original response stream became interrupted. A notice alone
therefore does not authorize another Send, Stop/Regenerate, or navigation of an
active tool turn. The cause of the service's additional-processing hold is unknown.

The bridge now projects these notices only from the bound assistant turn, excludes
quoted prose and hidden status UI, and prevents partial-answer completion while a
notice remains. It reports a diagnostic wait state across the helper IPC without
treating a repeated banner as reasoning or execution progress. The existing finite
stall budget (300 seconds by default, measured from the last new answer or native
tool activity) remains in force. Its terminal error distinguishes connection recovery
from a service processing hold. Accepted requests are not automatically resent.

This changes completion and stall classification. It does not force the ChatGPT
service to finish a held response, repair the remote response stream, or promise that
another attempt succeeds. Temporary DOM absence does not clear the last observed
wait reason; a successful fresh projection without the notice does.

Verification covers the synthetic captured structure, 320k/1M-character status and
prompt quotes, hidden UI, final-answer quotes, helper IPC, finite timeout, actual new
tool/content progress, and native reconnect without a duplicate Send. Production
inspection sends no test prompts, including Pro prompts.

The user's eight-tab request changes both the physical browser queue and launcher
allocation default from four to eight. Overrides remain bounded to 1–8. This admits
the fifth job without waiting for one of the first four browser documents to finish;
it does not remove the ChatGPT service's connection or processing waits.
