const EFFORT_RECHECK_MS = 10 * 60 * 1000;

function sanitizeEffortCeilings(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(v => v && typeof v.account === "string" && v.account.length > 0 && v.account.length <= 128
    && ["5.6", "6"].includes(v.family) && Number.isInteger(v.requestedPosition)
    && v.requestedPosition >= 2 && v.requestedPosition <= 4 && Number.isInteger(v.actualPosition)
    && v.actualPosition >= 1 && v.actualPosition < v.requestedPosition
    && Number.isFinite(v.observedAt) && v.observedAt >= 0
    && Number.isFinite(v.lastCheckedAt) && v.lastCheckedAt >= v.observedAt)
    .map(v => ({ account: v.account, family: v.family, requestedPosition: v.requestedPosition,
      actualPosition: v.actualPosition, observedAt: v.observedAt, lastCheckedAt: v.lastCheckedAt }));
}

function effortRecheckDue(ceiling, now = Date.now()) {
  return now < ceiling.lastCheckedAt || now - ceiling.lastCheckedAt >= EFFORT_RECHECK_MS;
}

/** All writes use the launcher's existing atomic state store, never browser storage. */
function observeEffortCeiling(stateStore, account, observation, now = Date.now()) {
  const { family, requestedPosition, actualPosition, available } = observation;
  if (!["5.6", "6"].includes(family) || !Array.isArray(available) || available.length < 1 || available.length > 5
    || available.some(v => typeof v !== "boolean") || !Number.isInteger(requestedPosition)
    || requestedPosition < 1 || requestedPosition > 5 || !Number.isInteger(actualPosition)
    || actualPosition < 1 || actualPosition > requestedPosition || !available[actualPosition - 1]
    || (requestedPosition === 5 && actualPosition !== 5)) throw new Error("Effort observation is invalid");
  const ceilings = sanitizeEffortCeilings(stateStore.read().effortCeilings);
  const previous = ceilings.find(v => v.account === account && v.family === family);
  let next = previous;
  let event;
  if (previous && available[previous.requestedPosition - 1]) {
    next = undefined;
    event = { event: "effort_restored", account, family,
      requestedPosition: previous.requestedPosition, actualPosition: previous.requestedPosition };
  }
  // A picker can widen after selection but before its confirmation read. The
  // unlocked original tick proves the restriction lifted; do not create a
  // spurious requested==actual ceiling from that older, lower selection.
  if (actualPosition < requestedPosition && !available[requestedPosition - 1]) {
    // A lower multipart staging request must not forget the original higher request.
    const requested = Math.max(next?.requestedPosition || 0, requestedPosition);
    const highest = available.slice(0, requested).lastIndexOf(true) + 1;
    next = { account, family, requestedPosition: requested, actualPosition: highest,
      observedAt: next?.observedAt ?? now, lastCheckedAt: now };
    if (!previous || previous.actualPosition !== next.actualPosition || previous.requestedPosition !== requested) {
      event = { event: "effort_clamped", account, family, requestedPosition: requested, actualPosition: highest };
    }
  } else if (next) {
    // Fresh lower-effort observations still update the ceiling if an upper tick unlocks.
    const highest = available.slice(0, next.requestedPosition).lastIndexOf(true) + 1;
    next = { ...next, actualPosition: highest || next.actualPosition, lastCheckedAt: now };
  }
  const remaining = ceilings.filter(v => v.account !== account || v.family !== family);
  if (next) remaining.push(next);
  if (previous || next) stateStore.update({ effortCeilings: remaining });
  return { ceiling: next ?? null, event };
}

module.exports = { EFFORT_RECHECK_MS, sanitizeEffortCeilings, effortRecheckDue, observeEffortCeiling };
