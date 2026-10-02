const { readAccountConfig, validateAccountName, writeAccountConfig } = require("./account-policy.cjs");

class AccountRemoval {
  constructor({ filePath, host, supervisor, logger, cleanup = async () => {}, retryMs = 1000 }) {
    Object.assign(this, { filePath, host, supervisor, logger, cleanup, retryMs });
    this.inFlight = new Map();
    this.timer = null;
  }

  async request(name) {
    validateAccountName(name);
    const data = readAccountConfig(this.filePath);
    if (!data.accounts[name]) throw new Error("Account does not exist");
    data.accounts[name].pendingRemoval = true;
    writeAccountConfig(this.filePath, data);
    this.host.pendingRemovalAccounts ??= new Set();
    this.host.pendingRemovalAccounts.add(name);
    try {
      const removed = await this.finish(name);
      if (!removed) this.schedule();
      return { ok: true, deferred: !removed, name };
    } catch (error) {
      this.schedule();
      throw error;
    }
  }

  finish(name) {
    if (this.inFlight.has(name)) return this.inFlight.get(name);
    const promise = (async () => {
      if (this.host.isAccountBusy(name)) return false;
      await this.host.removeAccountFromPool(name);
      if (this.host.isAccountBusy(name)) return false;
      const stopped = await this.supervisor.stopAccountTunnel(name);
      if (!stopped) throw new Error(`Account ${name} tunnel stop failed; removal remains pending`);
      const data = readAccountConfig(this.filePath);
      if (data.accounts[name]?.pendingRemoval) {
        await this.cleanup(name, data.accounts[name]);
        delete data.accounts[name];
        writeAccountConfig(this.filePath, data);
      }
      this.host.pendingRemovalAccounts?.delete(name);
      return true;
    })().finally(() => this.inFlight.delete(name));
    this.inFlight.set(name, promise);
    return promise;
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      let retry = false;
      let accounts;
      try { accounts = readAccountConfig(this.filePath).accounts; }
      catch (error) { this.logger?.warn?.("account.removal_config_invalid", { error: String(error) }); return; }
      for (const [name, account] of Object.entries(accounts)) {
        if (!account.pendingRemoval) continue;
        try { if (!await this.finish(name)) retry = true; }
        catch (error) { retry = true; this.logger?.warn?.("account.removal_pending", { name, error: String(error) }); }
      }
      if (retry) this.schedule();
    }, this.retryMs);
    this.timer.unref?.();
  }
}

module.exports = { AccountRemoval };
