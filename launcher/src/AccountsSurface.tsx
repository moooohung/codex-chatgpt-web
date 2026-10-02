import { useEffect, useState } from "react";
import { Icon } from "./icons";
import type { Copy } from "./i18n";
import type { AccountItem, LauncherSnapshot } from "./types";
import "./accounts.css";

export function AccountsSurface({
  copy,
  snapshot,
  setError,
}: {
  copy: Copy;
  snapshot: LauncherSnapshot;
  setError: (error: string | null) => void;
}) {
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionBusyAccount, setActionBusyAccount] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "warning"; text: string } | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [tunnelId, setTunnelId] = useState("");
  const [runtimeKey, setRuntimeKey] = useState("");

  const loadAccounts = async () => {
    try {
      const res = await window.codexWebLauncher?.listAccounts();
      if (res?.accounts) {
        setAccounts(res.accounts);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAccounts();
    const timer = setInterval(() => {
      void loadAccounts();
    }, 10_000);
    return () => clearInterval(timer);
  }, []);

  const openExternal = async (url: string) => {
    try {
      await window.codexWebLauncher?.openExternal(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    const cleanEmail = email.trim();
    const cleanTunnel = tunnelId.trim();
    const cleanKey = runtimeKey.trim();

    if (!cleanName || !cleanTunnel || !cleanKey) {
      setError(copy.accountFillAllFields);
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(cleanName)) {
      setError("Account Identifier must only contain letters, numbers, dashes, and underscores.");
      return;
    }

    setSubmitting(true);
    setError(null);
    setNotice(null);

    try {
      await window.codexWebLauncher?.addAccount({
        name: cleanName,
        email: cleanEmail,
        tunnelId: cleanTunnel,
        runtimeKey: cleanKey,
      });

      setNotice({ tone: "success", text: copy.accountAddSuccess });
      setName("");
      setEmail("");
      setTunnelId("");
      setRuntimeKey("");
      setShowAddForm(false);
      await loadAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleOpenLogin = async (accName: string) => {
    setActionBusyAccount(accName);
    setError(null);
    try {
      await window.codexWebLauncher?.openAccountLogin(accName);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusyAccount(null);
    }
  };

  const handleRemove = async (accName: string) => {
    if (!window.confirm(copy.confirmRemoveAccount)) {
      return;
    }

    setActionBusyAccount(accName);
    setError(null);
    setNotice(null);

    try {
      const result = await window.codexWebLauncher?.removeAccount(accName);
      setNotice({ tone: "success", text: result?.deferred ? copy.accountRemovalPending : copy.accountRemoveSuccess });
      await loadAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusyAccount(null);
    }
  };

  const handleToggle = async (accName: string, currentlyEnabled: boolean) => {
    setActionBusyAccount(accName);
    setError(null);
    setNotice(null);
    try {
      await window.codexWebLauncher?.toggleAccount({ name: accName, enabled: !currentlyEnabled });
      await loadAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusyAccount(null);
    }
  };

  const totalCount = accounts.length;
  const enabledAccounts = accounts.filter(a => a.enabled !== false);
  const readyCount = enabledAccounts.filter(a => a.authenticated && !a.cooling).length;
  const coolingCount = enabledAccounts.filter(a => a.cooling).length;
  const allDisabled = totalCount > 0 && enabledAccounts.length === 0;

  return (
    <section className="content-surface">
      <div className="content-scroll">
        <header className="surface-header">
          <span>{copy.runtime}</span>
          <h1>{copy.accountsTitle}</h1>
          <p>{copy.accountsSubtitle}</p>
        </header>

        <div className="accounts-surface">
          {notice ? (
            <div className={`notice-row tone-${notice.tone}`}>
              <Icon name="check" />
              <span>{notice.text}</span>
            </div>
          ) : null}

          {/* Stat Summary Grid */}
          <div className="accounts-summary-grid">
            <div className="accounts-stat-card">
              <span className="accounts-stat-label">{copy.accountPoolTotal}</span>
              <span className="accounts-stat-value">{totalCount}</span>
            </div>
            <div className="accounts-stat-card">
              <span className="accounts-stat-label">{copy.accountPoolActive}</span>
              <span className="accounts-stat-value tone-success">
                <i style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--color-text-success)", display: "inline-block" }} />
                {readyCount}
              </span>
            </div>
            <div className="accounts-stat-card">
              <span className="accounts-stat-label">{copy.accountPoolCooling}</span>
              <span className={`accounts-stat-value ${coolingCount > 0 ? "tone-warning" : ""}`}>
                <i style={{ width: 8, height: 8, borderRadius: "50%", background: coolingCount > 0 ? "var(--color-text-warning)" : "var(--color-text-tertiary)", display: "inline-block" }} />
                {coolingCount}
              </span>
            </div>
          </div>

          {/* Action Toolbar */}
          <div className="accounts-toolbar">
            <button
              className="button-primary"
              disabled={submitting}
              onClick={() => setShowAddForm(prev => !prev)}
              type="button"
            >
              <Icon name={showAddForm ? "minus" : "plus"} />
              <span>{showAddForm ? copy.close : copy.addAccount}</span>
            </button>

            <div className="accounts-toolbar-links">
              <button
                className="button-secondary"
                onClick={() => void openExternal(snapshot.urls.tunnels)}
                title="OpenAI Settings > Tunnels"
                type="button"
              >
                <Icon name="external" />
                <span>{copy.openTunnels}</span>
              </button>
              <button
                className="button-secondary"
                onClick={() => void openExternal(snapshot.urls.keys)}
                title="OpenAI Settings > API Keys"
                type="button"
              >
                <Icon name="external" />
                <span>{copy.openKeys}</span>
              </button>
            </div>
          </div>

          {/* Add Account Form */}
          {showAddForm ? (
            <form className="accounts-form-card" onSubmit={handleAddSubmit}>
              <div className="accounts-form-header">
                <h3>{copy.addAccount}</h3>
                <p>{copy.addAccountDesc}</p>
              </div>

              <div className="accounts-form-fields">
                <div className="field-row">
                  <label htmlFor="account-name-input">{copy.accountName}</label>
                  <input
                    id="account-name-input"
                    autoCapitalize="none"
                    autoCorrect="off"
                    disabled={submitting}
                    onChange={e => setName(e.target.value)}
                    placeholder={copy.accountNamePlaceholder}
                    required
                    spellCheck={false}
                    value={name}
                  />
                </div>

                <div className="field-row">
                  <label htmlFor="account-email-input">{copy.accountEmail}</label>
                  <input
                    id="account-email-input"
                    autoCapitalize="none"
                    autoCorrect="off"
                    disabled={submitting}
                    onChange={e => setEmail(e.target.value)}
                    placeholder={copy.accountEmailPlaceholder}
                    spellCheck={false}
                    type="email"
                    value={email}
                  />
                </div>

                <div className="field-row">
                  <label htmlFor="account-tunnel-input">{copy.accountTunnelId}</label>
                  <input
                    id="account-tunnel-input"
                    autoCapitalize="none"
                    autoCorrect="off"
                    disabled={submitting}
                    onChange={e => setTunnelId(e.target.value)}
                    placeholder="tunnel_..."
                    required
                    spellCheck={false}
                    value={tunnelId}
                  />
                </div>

                <div className="field-row">
                  <label htmlFor="account-key-input">{copy.accountRuntimeKey}</label>
                  <input
                    id="account-key-input"
                    autoCapitalize="none"
                    autoCorrect="off"
                    disabled={submitting}
                    onChange={e => setRuntimeKey(e.target.value)}
                    placeholder="sk-..."
                    required
                    spellCheck={false}
                    type="password"
                    value={runtimeKey}
                  />
                </div>
              </div>

              <div className="accounts-form-actions">
                <button
                  className="button-secondary"
                  disabled={submitting}
                  onClick={() => setShowAddForm(false)}
                  type="button"
                >
                  {copy.close}
                </button>
                <button
                  className="button-primary"
                  disabled={submitting}
                  type="submit"
                >
                  <Icon name="check" />
                  <span>{submitting ? "..." : copy.addAccount}</span>
                </button>
              </div>
            </form>
          ) : null}

          {/* Accounts List */}
          <div className="accounts-list-section">
            {accounts.length === 0 && !loading ? (
              <div className="accounts-empty">
                <Icon name="user" style={{ width: 32, height: 32 }} />
                <p>No multi-login accounts configured yet.</p>
                <button
                  className="button-primary"
                  onClick={() => setShowAddForm(true)}
                  type="button"
                >
                  <Icon name="plus" />
                  <span>{copy.addAccount}</span>
                </button>
              </div>
            ) : null}

            {allDisabled ? (
              <div className="accounts-warning-banner">
                <Icon name="alert" />
                <span>{copy.allAccountsDisabledWarning}</span>
              </div>
            ) : null}

            {accounts.map(acc => {
              const isBusy = actionBusyAccount === acc.name;
              const isEnabled = acc.enabled !== false;
              let statusClass = "status-ready";
              let statusLabel = copy.accountStatusReady;

              if (acc.pendingRemoval) {
                statusClass = "status-disabled";
                statusLabel = copy.accountRemovalPending;
              } else if (!isEnabled) {
                statusClass = "status-disabled";
                statusLabel = copy.accountStatusDisabled;
              } else if (acc.cooling) {
                statusClass = "status-cooling";
                statusLabel = copy.accountStatusCooling;
              } else if (!acc.authenticated) {
                statusClass = "status-signed-out";
                statusLabel = copy.accountStatusSignedOut;
              }

              return (
                <div className={`account-card ${!isEnabled ? "is-disabled" : ""}`} key={acc.name}>
                  <div className="account-card-main">
                    <div className="account-card-icon">
                      <Icon name="user" />
                    </div>
                    <div className="account-card-info">
                      <div className="account-card-name-row">
                        <span className="account-card-name">{acc.name}</span>
                        {acc.email ? (
                          <span className="account-card-email">{acc.email}</span>
                        ) : null}
                      </div>
                      <div className="account-card-details">
                        <span>Tunnel: <span className="account-tunnel-id">{acc.tunnelId || "None"}</span></span>
                        <span>Partition: <code>{acc.partition || `codex-web-gpt-chatgpt-${acc.name}`}</code></span>
                      </div>
                    </div>
                  </div>

                  <div className="account-card-status-col">
                    <span className={`account-status-pill ${statusClass}`}>
                      <i />
                      {statusLabel}
                    </span>
                    {acc.activeTabs > 0 ? (
                      <span className="account-active-tabs">
                        ⚡ {acc.activeTabs} tab(s) active
                      </span>
                    ) : null}
                  </div>

                  <div className="account-card-actions">
                    <button
                      className={isEnabled ? "button-secondary" : "button-primary"}
                      disabled={isBusy || acc.pendingRemoval === true}
                      onClick={() => void handleToggle(acc.name, isEnabled)}
                      title={isEnabled ? copy.disableAccount : copy.enableAccount}
                      type="button"
                    >
                      <Icon name={isEnabled ? "pause" : "check"} />
                      <span>{isEnabled ? copy.disableAccount : copy.enableAccount}</span>
                    </button>
                    <button
                      className="button-secondary"
                      disabled={isBusy || acc.pendingRemoval === true}
                      onClick={() => void handleOpenLogin(acc.name)}
                      title={copy.openLoginTab}
                      type="button"
                    >
                      <Icon name="external" />
                      <span>{copy.openLoginTab}</span>
                    </button>
                    <button
                      className="button-danger"
                      disabled={isBusy || acc.pendingRemoval === true}
                      onClick={() => void handleRemove(acc.name)}
                      title={copy.removeAccount}
                      type="button"
                    >
                      <Icon name="close" />
                      <span>{copy.removeAccount}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
