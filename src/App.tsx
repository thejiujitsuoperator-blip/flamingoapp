import { useMemo, useRef, useState } from "react";
import { AskPanel } from "./components/AskPanel";
import { HistoryTab } from "./components/HistoryTab";
import { MemberProfile } from "./components/MemberProfile";
import { MembersTab } from "./components/MembersTab";
import { RosterTab } from "./components/RosterTab";
import { Overview } from "./components/Overview";
import { SettingsTab } from "./components/SettingsTab";
import { TransactionsTab } from "./components/TransactionsTab";
import logo from "./assets/logo.svg";
import { combineImports, worstStatus } from "./lib/audit";
import { formatDate, todayIso } from "./lib/dates";
import { demoDataset } from "./lib/demo";
import { analyse, monthly } from "./lib/members";
import { matchRoster } from "./lib/roster";
import { useHistoryStore } from "./lib/useHistoryStore";
import { currentRoster } from "./lib/vault";

type Tab = "overview" | "members" | "roster" | "transactions" | "history" | "settings";
type AsOfMode = "data" | "today" | "custom";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "members", label: "Members" },
  { id: "roster", label: "Member list" },
  { id: "transactions", label: "Transactions" },
  { id: "history", label: "History" },
  { id: "settings", label: "Settings" },
];

export default function App() {
  const store = useHistoryStore();
  const { state, vault } = store;
  const [tab, setTab] = useState<Tab>("overview");
  const [asOfMode, setAsOfMode] = useState<AsOfMode>("data");
  const [customDate, setCustomDate] = useState(todayIso());
  const [profileId, setProfileId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn" | "error"; text: string; toHistory?: boolean } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const demo = useMemo(() => demoDataset(), []);
  const isDemo = !!state && state.imports.length === 0;
  const data = useMemo(() => (!state || isDemo ? demo : combineImports(state.imports, state.rows)), [state, isDemo, demo]);
  const settings = state?.config.settings;
  const roster = useMemo(() => (state ? currentRoster(state) : []), [state]);
  const canEdit = !!vault?.canWrite && !isDemo;

  const dataTo = data.txns.length ? data.txns[data.txns.length - 1].date : todayIso();
  const asOf = asOfMode === "data" ? dataTo : asOfMode === "today" ? todayIso() : customDate;
  const { analysis, rosterMatches } = useMemo(() => {
    const s = state?.config.settings;
    if (!s) return { analysis: null, rosterMatches: [] };
    // Match the member list against statement names, then show list names across the dashboard.
    const base = analyse(data, s, asOf);
    const matches = matchRoster(roster, base.members, base.payments);
    const listNames = Object.fromEntries(
      matches.filter((m) => m.member && !m.paidBy && m.confidence !== "possible").map((m) => [m.member!.id, m.entry.name]),
    );
    if (!Object.keys(listNames).length) return { analysis: base, rosterMatches: matches };
    const named = analyse(data, { ...s, memberNames: { ...listNames, ...s.memberNames } }, asOf);
    const byId = new Map(named.members.map((m) => [m.id, m]));
    return {
      analysis: named,
      rosterMatches: matches.map((m) => ({ ...m, member: m.member ? (byId.get(m.member.id) ?? m.member) : null })),
    };
  }, [data, state?.config.settings, asOf, roster]);
  const nowMonths = useMemo(() => (analysis ? monthly(analysis) : []), [analysis]);
  const profile = analysis?.members.find((m) => m.id === profileId) ?? null;

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    const lines: string[] = [];
    let attention = false;
    try {
      for (const file of Array.from(files)) {
        try {
          const rec = await store.importStatement(file);
          const status = worstStatus(rec.checks);
          attention ||= status === "fail" || status === "warn";
          lines.push(
            `${file.name}: ${rec.newRowCount} new transactions. ${status === "fail" ? "Problems found in the checks." : status === "warn" ? "Some checks need a look." : "All checks passed."}`,
          );
        } catch (err) {
          lines.push(`${file.name}: ${(err as Error).message}`);
          attention = true;
        }
      }
      setAsOfMode("data");
      setNotice({ kind: attention ? "warn" : "ok", text: lines.join(" "), toHistory: true });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  if (store.loadError) {
    return (
      <div className="app">
        <section className="empty">
          <h2>Your history couldn't be loaded</h2>
          <p className="muted">{store.loadError}</p>
          <button className="primary" onClick={() => location.reload()}>
            Reload
          </button>
        </section>
      </div>
    );
  }
  if (!state || !vault || !analysis || !settings) {
    return (
      <div className="app">
        <p className="muted loading">Loading your statements and member list…</p>
      </div>
    );
  }

  const hasData = data.txns.length > 0;

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onFiles(e.dataTransfer.files);
      }}
    >
      <header className="topbar">
        <div className="brand">
          <img src={logo} alt="" width={28} height={28} />
          <div>
            <h1>Flamingo Members</h1>
            {hasData && (
              <p className="muted small">
                {data.accountHolder ? `${data.accountHolder} · ` : ""}
                {formatDate(analysis.dataFrom)} – {formatDate(analysis.dataTo)}
              </p>
            )}
          </div>
        </div>
        <div className="topbar-actions">
          {hasData && (
            <label className="asof">
              <span className="muted small">Status as of</span>
              <select value={asOfMode} onChange={(e) => setAsOfMode(e.target.value as AsOfMode)}>
                <option value="data">Last statement date ({formatDate(dataTo)})</option>
                <option value="today">Today ({formatDate(todayIso())})</option>
                <option value="custom">Pick a date…</option>
              </select>
              {asOfMode === "custom" && (
                <input type="date" value={customDate} onChange={(e) => e.target.value && setCustomDate(e.target.value)} />
              )}
            </label>
          )}
          {vault.canWrite && vault.kind === "cloud" && !isDemo && (
            <button
              onClick={async () => {
                setBackingUp(true);
                try {
                  const r = await store.backupAll();
                  setNotice({ kind: r.ok ? "ok" : "warn", text: r.message });
                } finally {
                  setBackingUp(false);
                }
              }}
              disabled={backingUp || uploading}
            >
              {backingUp ? "Backing up…" : "Back up"}
            </button>
          )}
          {vault.canWrite && (
            <button className="primary" onClick={() => fileInput.current?.click()} disabled={uploading}>
              {uploading ? "Checking statement…" : "Upload statement"}
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept=".xls,.xlsx,.csv"
            multiple
            hidden
            onChange={(e) => onFiles(e.target.files)}
          />
        </div>
      </header>

      {notice && (
        <div className={`notice ${notice.kind}`} role="status">
          <span>
            {notice.text}{" "}
            {notice.toHistory && (
              <button
                className="link"
                onClick={() => {
                  setTab("history");
                  setNotice(null);
                }}
              >
                See the checks in History
              </button>
            )}
          </span>
          <button className="ghost" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {store.saveError && <div className="notice error">{store.saveError}</div>}

      {store.legacy && vault.canWrite && (
        <div className="notice warn demo-banner">
          <span>
            <strong>Earlier uploads found in this browser.</strong> {store.legacy.txns.length} transactions and{" "}
            {store.legacy.roster.length} member-list names from before the history was added. Move them into the history
            so they're kept {vault.kind === "cloud" ? "on claude.ai and backed up to Drive" : "with every later upload"}.
          </span>
          <span className="row">
            <button
              className="primary"
              onClick={async () => {
                try {
                  await store.migrateLegacy();
                  setNotice({ kind: "ok", text: "Earlier uploads moved into the history.", toHistory: true });
                } catch (err) {
                  setNotice({ kind: "error", text: (err as Error).message });
                }
              }}
            >
              Move into history
            </button>
            <button onClick={store.dismissLegacy}>Not now</button>
          </span>
        </div>
      )}

      {isDemo && !store.legacy && (
        <div className="notice warn demo-banner">
          <span>
            <strong>Demo data.</strong> These members and payments are made up.{" "}
            {vault.canWrite
              ? "Upload your bank statement to see your gym's numbers; every statement you upload is kept in the History tab."
              : "The owner hasn't uploaded a statement yet."}
          </span>
          {vault.canWrite && (
            <button className="primary" onClick={() => fileInput.current?.click()} disabled={uploading}>
              Upload statement
            </button>
          )}
        </div>
      )}
      {vault.kind === "browser" && !isDemo && (
        <p className="muted small storage-note">Saved in this browser only. Open the page on claude.ai to keep it across devices.</p>
      )}

      {hasData && (
        <>
          <AskPanel analysis={analysis} settings={settings} roster={rosterMatches} onOpenMember={setProfileId} />

          <nav className="tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={tab === t.id ? "tab active" : "tab"}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <main>
            {tab === "overview" && <Overview analysis={analysis} settings={settings} onOpenMember={setProfileId} />}
            {tab === "members" && <MembersTab analysis={analysis} onOpenMember={setProfileId} />}
            {tab === "roster" && (
              <RosterTab
                matches={rosterMatches}
                analysis={analysis}
                roster={roster}
                onSaveVersion={store.saveRosterVersion}
                onLink={store.setRosterLink}
                canWrite={vault.canWrite}
                onOpenMember={setProfileId}
              />
            )}
            {tab === "transactions" && (
              <TransactionsTab analysis={analysis} settings={settings} setSettings={store.updateSettings} readOnly={!canEdit} />
            )}
            {tab === "history" && (
              <HistoryTab
                state={state}
                vault={vault}
                nowMonths={nowMonths}
                onRetryImportBackup={store.retryImportBackup}
                onRetryRosterBackup={store.retryRosterBackup}
              />
            )}
            {tab === "settings" && <SettingsTab settings={settings} setSettings={store.updateSettings} data={data} readOnly={!vault.canWrite} />}
          </main>
        </>
      )}

      {profile && (
        <MemberProfile
          member={profile}
          asOf={analysis.asOf}
          onClose={() => setProfileId(null)}
          onRename={
            canEdit ? (name) => store.updateSettings((s) => ({ ...s, memberNames: { ...s.memberNames, [profile.id]: name } })) : undefined
          }
        />
      )}
    </div>
  );
}
