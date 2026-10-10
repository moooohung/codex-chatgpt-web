const { accountNameForTab, accountUnavailable } = require("./account-policy.cjs");
const { PRIMARY_ACCOUNT } = require("./account-cooldown-store.cjs");

function resolveCooldownRoute({ pool, statuses = new Map(), disabled = new Set(), pending = new Set(),
  preferred, cooldowns, tabs = [], roundRobin = 0, now = Date.now() }) {
  const eligible = pool.filter(name => !disabled.has(name) && !pending.has(name)
    && !statuses.get(name)?.securityCheckRequired);
  const available = eligible.filter(name => {
    const status = statuses.get(name);
    return status?.routingAuthenticated === true && status?.authenticated !== false
      && !(status?.cooldownUntil > now) && !cooldowns.get(name);
  });
  if (available.includes(preferred)) return preferred;
  if (available.length) {
    const counts = new Map(available.map(name => [name, 0]));
    for (const tab of tabs) {
      const name = accountNameForTab(tab) || PRIMARY_ACCOUNT;
      if (counts.has(name) && (tab.status === "running" || tab.loading === true)) counts.set(name, counts.get(name) + 1);
    }
    const minimum = Math.min(...counts.values());
    const candidates = available.filter(name => counts.get(name) === minimum);
    return candidates[roundRobin % candidates.length];
  }
  const waiting = eligible.filter(name => statuses.get(name)?.authenticated !== false)
    .map(name => ({ name, cooldown: cooldowns.get(name) })).filter(item => item.cooldown);
  if (waiting.length) {
    waiting.sort((a, b) => a.cooldown.retryAt - b.cooldown.retryAt);
    const { name, cooldown } = waiting[0];
    const error = new Error(`ChatGPT account ${name === PRIMARY_ACCOUNT ? "(primary)" : `[${name}]`} is temporarily limited. `
      + `No other signed-in account is available. Try again after ${new Date(cooldown.retryAt).toISOString()}. ${cooldown.message}`);
    Object.assign(error, { code: "chatgpt_account_cooldown", retryAt: cooldown.retryAt,
      retryAfterSeconds: Math.max(1, Math.ceil((cooldown.retryAt - now) / 1000)) });
    throw error;
  }
  throw accountUnavailable(["no verified signed-in account"]);
}

module.exports = { resolveCooldownRoute };
