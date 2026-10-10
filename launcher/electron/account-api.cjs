const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { accountNameForTab, accountPaths, readAccountConfig, validateAccountName, writeAccountConfig } = require("./account-policy.cjs");
const { AccountRemoval } = require("./account-removal.cjs");

function createAccountApi({ profile, getHost, getSupervisor, logger }) {
  const paths = accountPaths({ coreHome: profile.coreHome, userData: profile.userData, partition: profile.browserPartition });
  const lastAudit = new Map();
  let removal;
  function removals() {
    return removal ??= new AccountRemoval({ filePath: paths.config, host: getHost(), supervisor: getSupervisor(), logger,
      cleanup: async (name, account) => {
        await getHost().clearAccountSession(name);
        const keyFile = path.resolve(account.keyFile || path.join(paths.secrets, `tunnel-runtime-${name}.key`));
        const secrets = path.resolve(paths.secrets);
        if (keyFile.startsWith(secrets + path.sep) && fs.existsSync(keyFile)) fs.unlinkSync(keyFile);
      },
    });
  }
  function nameFrom(input) {
    return validateAccountName((typeof input === "string" ? input : String(input?.name || "")).trim());
  }
  return {
    resume() { if (Object.values(readAccountConfig(paths.config).accounts).some(account => account.pendingRemoval)) removals().schedule(); },
    async list() {
      const host = getHost();
      const data = readAccountConfig(paths.config);
      const accounts = await Promise.all(Object.entries(data.accounts).map(async ([name, account]) => {
        if (Date.now() - (lastAudit.get(name) || 0) > 15_000 && !host?.isAccountBusy(name)) {
          lastAudit.set(name, Date.now());
          await host?.auditAccountCookie(name);
        }
        const status = host?.accountStatuses?.get(name);
        const cooldown = host?.accountCooldowns?.get(name);
        return { name, email: account.email || "", tunnelId: account.tunnelId || "",
          cooling: Boolean(cooldown || status?.cooldownUntil > Date.now()), authenticated: status?.authenticated === true,
          ...(cooldown ? { retryAt: cooldown.retryAt } : {}),
          enabled: account.enabled !== false, pendingRemoval: account.pendingRemoval === true,
          partition: paths.partition(name),
          activeTabs: [...(host?.turnTabs?.values() || [])].filter(tab => accountNameForTab(tab) === name).length };
      }));
      return { accounts };
    },
    async add(input) {
      const name = nameFrom(input);
      const data = readAccountConfig(paths.config);
      if (data.accounts[name]) throw new Error("Account already exists");
      const email = String(input?.email || "").trim();
      const tunnelId = String(input?.tunnelId || "").trim();
      const runtimeKey = String(input?.runtimeKey || "").trim();
      if (!tunnelId || !runtimeKey) throw new Error("Tunnel ID and runtime API key are required");
      const keyFile = path.join(paths.secrets, `tunnel-runtime-${name}.key`);
      writePrivateFileAtomic(keyFile, runtimeKey + "\n");
      data.accounts[name] = { email, tunnelId, keyFile, enabled: true };
      writeAccountConfig(paths.config, data);
      const host = getHost();
      host.addAccountToPool(name);
      if (!await getSupervisor().startAccountTunnel(name, data.accounts[name])) {
        throw new Error(`Account ${name} was saved, but its tunnel failed to start`);
      }
      let loginDeferred = false;
      try { host.openAccountLoginTab(name); }
      catch (error) { if (error.code !== "browser_tab_limit") throw error; loginDeferred = true; }
      return { ok: true, name, loginDeferred };
    },
    remove(input) { return removals().request(nameFrom(input)); },
    login(input) { getHost().openAccountLoginTab(nameFrom(input)); return { ok: true }; },
    toggle(input) {
      const name = nameFrom(input);
      const data = readAccountConfig(paths.config);
      if (!data.accounts[name]) throw new Error("Account does not exist");
      if (data.accounts[name].pendingRemoval) throw new Error("Account removal is pending");
      const enabled = input?.enabled === true;
      data.accounts[name].enabled = enabled;
      writeAccountConfig(paths.config, data);
      getHost().setAccountEnabled(name, enabled);
      return { ok: true, name, enabled };
    },
  };
}

module.exports = { createAccountApi };
