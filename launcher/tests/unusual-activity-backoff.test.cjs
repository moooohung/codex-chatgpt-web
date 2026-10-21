const test = require("node:test");
const assert = require("node:assert/strict");
const { nextUnusualActivityBackoff, sanitizeUnusualActivityHistory } = require("../electron/unusual-activity-backoff.cjs");

test("actual retries escalate 3/5/10/30 minutes and are bounded", () => {
  let now = 1_000_000, previous;
  for (const minutes of [3, 5, 10, 30, 30]) {
    const entry = nextUnusualActivityBackoff(previous, null, now + 3 * 60_000, true, now);
    assert.equal(entry.retryAt - now, minutes * 60_000);
    previous = entry;
    now = entry.retryAt;
  }
});

test("parallel tab reports neither escalate nor continually extend the local wait", () => {
  const now = 1_000_000;
  const previous = nextUnusualActivityBackoff(undefined, null, now + 180_000, true, now);
  const active = { retryAt: previous.retryAt };
  const repeated = nextUnusualActivityBackoff(previous, active, now + 200_000, true, now + 20_000);
  assert.deepEqual(repeated, previous);
  const provider = nextUnusualActivityBackoff(previous, active, now + 600_000, false, now + 20_000);
  assert.equal(provider.retryAt, now + 600_000);
  assert.equal(provider.failures, 1);
});

test("provider/configured waits and inherited active blocks cannot be shortened", () => {
  const now = 1_000_000;
  assert.equal(nextUnusualActivityBackoff(undefined, null, now + 3_600_000, false, now).retryAt, now + 3_600_000);
  assert.equal(nextUnusualActivityBackoff(undefined, { retryAt: now + 1_800_000 }, now + 180_000, true, now).retryAt,
    now + 1_800_000);
  assert.throws(() => nextUnusualActivityBackoff(undefined, null, now, true, now), /retry time/);
});

test("one hour without a rejection resets history; backward clocks do not escalate", () => {
  const previous = { failures: 4, lastFailureAt: 1_000_000, retryAt: 2_800_000 };
  for (const now of [previous.lastFailureAt + 3_600_000, previous.lastFailureAt - 1]) {
    assert.equal(nextUnusualActivityBackoff(previous, null, now + 180_000, true, now).failures, 1);
  }
});

test("persisted history keeps only bounded scheduling metadata", () => {
  const good = { failures: 2, lastFailureAt: 1, retryAt: 300_001, accessToken: "synthetic-unused" };
  const result = sanitizeUnusualActivityHistory({ alpha: good, bad: { ...good, failures: 5 },
    invalid: { ...good, retryAt: 0 }, nan: { ...good, lastFailureAt: NaN } });
  assert.deepEqual(Object.keys(result), ["alpha"]);
  assert.deepEqual(result.alpha, { failures: 2, lastFailureAt: 1, retryAt: 300_001 });
  assert.equal(Object.getPrototypeOf(result), null);
  assert.deepEqual(Object.keys(sanitizeUnusualActivityHistory([])), []);
});
