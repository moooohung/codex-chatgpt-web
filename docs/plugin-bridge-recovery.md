# Plugin bridge recovery

Two independent failures stopped plugin jobs around 2026-10-07 15:00 UTC.

The native midnight environment update omitted unchanged cwd and shell, but repeated
workspace roots alongside the unrestricted filesystem profile. The calendar recovery
recognizer previously accepted only the profile, rejecting the repeated roots. Recovery
now recognizes both observed forms. It still reads the exact current native rollout,
requires the same unrestricted policy and equal declared roots, and never uses the cache
to grant authority to an incomplete or contradictory update.

The active account's tunnel repeatedly returned `client_internal` HTTP 502 for MCP
`initialize` and `tools/call`, with `upstream_response_received=false`. The first recorded
failure followed the tunnel's command response deadline. The local `ready` inventory
remained green. The launcher's default tunnel remained healthy, hiding the account failure
from the existing monitor. The logs establish an unusable account MCP relay; they do not
establish the tunnel client's internal reason for permanently rejecting subsequent calls.

The launcher now independently inspects each configured account relay's local MCP
diagnostics. Only a recent internal 502 with no upstream response triggers normal stop
and reconnect of that account alias. Healthy accounts, the Responses daemon, and broker
execution authority stay in place. Commands are not replayed. The originating job retains
its existing reconnect/resume behavior. Recovery rechecks account identity and removal
before reconnecting; shutdown invalidates pending work. Attempts are bounded to five
per minute and five consecutive failed recoveries. Unknown observations and ordinary
tool/application errors do not authorize replacement. Endpoint discovery is cached by
verified alias file; the loopback URL is reread because it changes on replacement.

Offline checks cover midnight roots, conflicting/relative/duplicate roots, absent or
wrong native authority, independent account failures, observation uncertainty, coalescing,
shutdown, retry budgets, alias endpoint ownership, and removal during recovery. No actual
worker prompts or Pro test messages are needed for these checks. The upstream tunnel's
command deadline and remote capacity remain separate risks.

The installed candidate also contains the retained-tab presentation recovery described in
[browser-idle-presentation.md](browser-idle-presentation.md).
