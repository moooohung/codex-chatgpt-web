# Fork integration of upstream 6.1.6

Upstream tag `v6.1.6` resolves to `388fca546553921cfc3b695930bd7140ce99d486`.
The first parent of this integration is fork commit `be5bd25723d31aa78709d9cf1ca5d48325ea0196`.
This is an integration of the upstream source into the maintained fork; installing the stock upstream package would replace local bridge changes.

## Resolved behavior

- GPT-6 Sol and Instant use the literal requested family. Existing GPT-5.6 routes remain GPT-5.6. Pro multipart staging explicitly uses GPT-5.6 at low effort before restoring the requested Pro family.
- Keep bounded model/effort probes, stage-specific errors, cancellation clocks, and the capture/observe/ACK tool boundary. Upstream response-node identities coexist with observer cleanup and active-root tracking.
- Keep the measured Plus composer limit at 60,000 characters. Pro reasoning has a separate 500,000-character limit; upstream's larger limit is not applied to Plus without account-specific validation.
- Preserve minimal compaction transport while enforcing upstream's total context budget and Bigger Context eligibility.
- Native2 discovery accepts catalog frames split across multiple MCP text blocks. Fresh nonce framing and duplicate/stale catalog rejection remain enforced.
- Keep owned-target CDP isolation, eight browser slots, resource/render budgets, tab release, restart guardians, and fork release workflows.

## Verification boundaries

The pre-integration candidate passed both typechecks, compiled entrypoint validation, 55 isolated browser fixture cases, and 229 focused launcher cases (one Linux-only skip). The Native2 split-output fix passed 13 affected focused cases. These fixtures send no ChatGPT, Pro, or worker messages.

The earlier broad candidate run timed out and was not a complete pass. During formal integration, the broker lifecycle and trusted environment suites passed together: 92 passes, one platform skip, zero failures. The four Windows namespace combinations are separate tests so that each retains its own assertion and timeout rather than sharing one five-second budget.

Automated packaging and static fixtures do not establish authenticated GPT-6 availability, Pro quota behavior, or a real worker's successful completion. Stable release promotion still requires the documented manual gates; automatic fork builds are prereleases.

The formal Windows integration passed `bun run verify` with pinned Bun 1.4.0: dependency audits, both typechecks, 1,154 bridge tests (120 optional/platform skips, zero failures), the complete launcher suite, renderer build, full runtime build, notices generation, and relocatable-runtime smoke. No production model message was sent by this verification.
