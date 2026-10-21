// Retry scheduling only; never sends a model prompt or changes account identity.
const DELAYS_MS = [3, 5, 10, 30].map(minutes => minutes * 60_000);
const HISTORY_WINDOW_MS = 60 * 60_000;

function sanitizeUnusualActivityHistory(raw) {
  const result = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  for (const [name, entry] of Object.entries(raw)) {
    if (!(name === "@primary" || /^[a-zA-Z0-9_-]+$/.test(name))
      || !entry || typeof entry !== "object" || Array.isArray(entry)
      || !Number.isSafeInteger(entry.failures) || entry.failures < 1 || entry.failures > DELAYS_MS.length
      || !Number.isSafeInteger(entry.lastFailureAt) || entry.lastFailureAt < 0
      || !Number.isSafeInteger(entry.retryAt) || entry.retryAt <= entry.lastFailureAt) continue;
    result[name] = { failures: entry.failures, lastFailureAt: entry.lastFailureAt, retryAt: entry.retryAt };
  }
  return result;
}

function nextUnusualActivityBackoff(previous, active, requestedRetryAt, localCooldown, now = Date.now()) {
  if (!Number.isSafeInteger(requestedRetryAt) || requestedRetryAt <= now) throw new Error("Invalid unusual activity retry time");
  // Multiple in-flight tabs can report the same block. Do not count these as retries
  // or continually push the local deadline forward. Explicit provider waits are floors.
  if (active && previous && previous.retryAt > now) {
    return { ...previous, retryAt: localCooldown ? Math.max(active.retryAt, previous.retryAt)
      : Math.max(active.retryAt, previous.retryAt, requestedRetryAt) };
  }
  const recent = previous && now >= previous.lastFailureAt
    && now - previous.lastFailureAt < HISTORY_WINDOW_MS;
  const failures = Math.min(DELAYS_MS.length, recent ? previous.failures + 1 : 1);
  return { failures, lastFailureAt: now,
    retryAt: Math.max(requestedRetryAt, active?.retryAt || 0, now + DELAYS_MS[failures - 1]) };
}

module.exports = { sanitizeUnusualActivityHistory, nextUnusualActivityBackoff };
