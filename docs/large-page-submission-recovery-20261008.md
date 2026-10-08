# Large-page submission recovery

PalAegis web turns showed repeated tool-boundary observation failures at about
20,001–20,002 ms. One later submission had a 1,023,022-character page and a
199,386-character composer, followed by a 20-second response probe timeout and
an old CDP page closing. Trace correlation with the client rollout is inferred
from start/failure times; the launcher logs do not directly identify the thread.

The send-recovery observer could reconnect to the same leased tab while its
reconciliation callback continued using the original `Page`. Both callbacks now
share the rebound connection. A read already in flight may retry once after that
owned recovery publishes the connection. Boundary/ACK errors remain terminal,
and a replacement connection cannot use the old input audit to authorize Send.
The original baseline object remains the receipt key. Cancellation fences late
recovery publication and acceptance.

Tool-boundary identity probes no longer serialize `document.body.textContent`
only to refresh a size hint. Submission and diagnostic probes retain size
accounting. Pages whose existing numeric size hint gives a 20-second ordinary
probe budget receive a 60-second total boundary capture budget. Ordinary probes
remain capped at 20 seconds. The broker's ACK wait is 75 seconds, below the
90-second Native2 MCP deadline. Capture, observe and ACK remain mandatory;
timeouts and late ACKs still revoke the turn. This adds headroom, not a guarantee
that every large page will respond.

Verification uses the actual send method, same-tab reconnect races, cancellation,
no duplicate Send, empty MCP boundary ordering, and isolated Chromium fixtures
with 320,000 and 1,000,000 characters. The fixtures make full-body serialization
and expensive stop-button layout throw while keeping assistant text and
identities available. An actual worker boundary with a delayed 21-second DOM
read completes capture, observe and ACK before emission. Regression coverage
includes model/effort selection, multipart acknowledgement, rendering and
compaction. No live ChatGPT message or Pro request is used for these checks.

Remaining limits: a renderer that stays unresponsive past the bounded capture
window still fails; the prompt transport still contains the full required
context; this change does not bypass tool approval or upstream service failures.
Real worker completion after deployment must be checked separately from fixtures.
