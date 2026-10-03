# Launcher and request preparation performance

Request preparation shares one synchronous, request-scoped preparation between multipart
planning and final prompt compilation. Usage accounting also shares preparation between
planning, compilation and input token counting. The final browser preflight still checks
the actual transmitted messages, images and attachments. This adds no global history cache
and does not increase composer limits, token budgets or the multipart limit.

On Windows using the installed Bun 1.4.2, a deterministic fixture with 24 user messages and
596,246 characters of English, Korean and emoji took 515.29 ms before this change and
275.79 ms afterwards (warm median, four measured runs after one cold run, about 46% less).
Each sample includes multipart planning, final prompt compilation and usage estimation.
The result stayed at 12 parts and 178,932 input tokens; the compiled prompt digest was
identical. The baseline was local source commit `3be8858821a50205b071d5c217674d9afc7fcdce`.
These are offline fixture measurements, not ChatGPT generation or network latency.

Launcher log batches go to a bounded external store with 300 records. Only the mounted
Activity surface subscribes. Background output therefore does not schedule a root/shell
render. Activity's clock can update elapsed task time without rebuilding unchanged log
rows. History, order, redaction, 100 ms batch timing and persistent diagnostic files keep
their existing behavior. A 500-record burst regression verifies zero launcher renders
and the complete last 300 records. This does not claim a measured end-to-end frame rate.
