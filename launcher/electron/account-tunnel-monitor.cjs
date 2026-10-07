// Account MCP relays have independent stdio transports. A healthy default relay says nothing
// about them; recover only a relay whose local diagnostics prove an internal transport failure.
class AccountTunnelMonitor {
  constructor({ readAccounts, probe, reconnect, write, intervalMs = 10_000, now = Date.now }) {
    Object.assign(this, { readAccounts, probe, reconnect, write, intervalMs, now });
    this.generation = 0;
    this.states = new Map();
    this.inFlight = null;
  }

  start() {
    this.stop();
    this.states.clear();
    this.timer = setInterval(() => { void this.poll(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.generation += 1;
  }

  poll() {
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    const current = () => generation === this.generation;
    const task = this.inspect(current).catch(error => {
      if (current()) this.write("observation_unavailable", { message: String(error) });
    }).finally(() => { if (this.inFlight === task) this.inFlight = null; });
    this.inFlight = task;
    return task;
  }

  async inspect(current) {
    const accounts = this.readAccounts();
    for (const name of this.states.keys()) if (!accounts[name]) this.states.delete(name);
    await Promise.all(Object.entries(accounts).map(async ([name, account]) => {
      let state = this.states.get(name);
      if (!state || state.identity !== account.tunnelId) {
        state = { identity: account.tunnelId, attempts: [], failures: 0, blocked: false };
        this.states.set(name, state);
      }
      if (state.blocked) return;
      let health;
      try { health = await this.probe(name, account); }
      catch { return; } // Missing observations do not authorize replacement.
      if (!current() || !health.observed || !health.fatal) return;
      state.attempts = state.attempts.filter(at => this.now() - at < 60_000);
      if (state.attempts.length >= 5 || state.failures >= 5) {
        state.blocked = true;
        this.write("recovery_exhausted", { account: name, message: health.detail });
        return;
      }
      state.attempts.push(this.now());
      this.write("recovering", { account: name, message: health.detail });
      try {
        if (!await this.reconnect(name, account, current)) throw new Error("Account MCP relay did not recover");
        if (current()) {
          state.failures = 0;
          this.write("recovered", { account: name });
        }
      } catch (error) {
        if (current()) {
          state.failures += 1;
          this.write("recovery_failed", { account: name, message: String(error) });
        }
      }
    }));
  }
}

module.exports = { AccountTunnelMonitor };
