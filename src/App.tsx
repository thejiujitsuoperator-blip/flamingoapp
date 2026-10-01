import { useEffect, useMemo, useRef, useState } from "react";
import { AskPanel } from "./components/AskPanel";
import { MemberProfile } from "./components/MemberProfile";
import { MembersTab } from "./components/MembersTab";
import { RosterTab } from "./components/RosterTab";
import { Overview } from "./components/Overview";
import { SettingsTab } from "./components/SettingsTab";
import { TransactionsTab } from "./components/TransactionsTab";
import logo from "./assets/logo.svg";
import { formatDate, todayIso } from "./lib/dates";
import { demoDataset } from "./lib/demo";
import { analyse } from "./lib/members";
import { matchRoster } from "./lib/roster";
import { EMPTY_DATASET, loadDataset, loadRoster, loadSettings, saveDataset, saveRoster, saveSettings } from "./lib/storage";
import type { Dataset, RosterEntry, Settings } from "./lib/types";

type Tab = "overview" | "members" | "roster" | "transactions" | "settings";
type AsOfMode = "data" | "today" | "custom";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "members", label: "Members" },
  { id: "roster", label: "Member list" },
  { id: "transactions", label: "Transactions" },
  { id: "settings", label: "Settings" },
];

export default function App() {
  // First visit: open on made-up demo data so the dashboard shows what it does.
  const [data, setData] = useState<Dataset>(() => {
    const stored = loadDataset();
    return stored.txns.length || stored.sources.length ? stored : demoDataset();
  });
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [roster, setRoster] = useState<RosterEntry[]>(loadRoster);
  const [tab, setTab] = useState<Tab>("overview");
  const [asOfMode, setAsOfMode] = useState<AsOfMode>("data");
  const [customDate, setCustomDate] = useState(todayIso());
  const [profileId, setProfileId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => saveDataset(data), [data]);
  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => saveRoster(roster), [roster]);

  const dataTo = data.txns.length ? data.txns[data.txns.length - 1].date : todayIso();
  const asOf = asOfMode === "data" ? dataTo : asOfMode === "today" ? todayIso() : customDate;
  const { analysis, rosterMatches } = useMemo(() => {
    // Match the member list against statement names, then show list names across the dashboard.
    const base = analyse(data, settings, asOf);
    const matches = matchRoster(roster, base.members, base.payments);
    const listNames = Object.fromEntries(
      matches.filter((m) => m.member && !m.paidBy && m.confidence !== "possible").map((m) => [m.member!.id, m.entry.name]),
    );
    if (!Object.keys(listNames).length) return { analysis: base, rosterMatches: matches };
    const named = analyse(data, { ...settings, memberNames: { ...listNames, ...settings.memberNames } }, asOf);
    const byId = new Map(named.members.map((m) => [m.id, m]));
    return {
      analysis: named,
      rosterMatches: matches.map((m) => ({ ...m, member: m.member ? (byId.get(m.member.id) ?? m.member) : null })),
    };
  }, [data, settings, asOf, roster]);
  const profile = analysis.members.find((m) => m.id === profileId) ?? null;

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    // The spreadsheet library is large, so it only loads when a file is uploaded.
    const { mergeTxns, parseStatement } = await import("./lib/parseStatement");
    let next = data;
    const messages: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const parsed = parseStatement(await file.arrayBuffer(), file.name);
        const base = next.sources.some((s) => s.fileName === "Demo data") ? EMPTY_DATASET : next;
        const { txns, added } = mergeTxns(base.txns, parsed.txns);
        next = {
          txns,
          sources: [...base.sources, parsed.source],
          accountHolder: base.accountHolder ?? parsed.source.accountHolder,
        };
        messages.push(`${file.name}: ${added} new transactions (${parsed.txns.length - added} already loaded)`);
      } catch (err) {
        setNotice({ kind: "error", text: `${file.name}: ${(err as Error).message}` });
        return;
      }
    }
    setData(next);
    setAsOfMode("data");
    setNotice({ kind: "ok", text: messages.join(" · ") });
    if (fileInput.current) fileInput.current.value = "";
  }

  const hasData = data.txns.length > 0;
  const isDemo = data.sources.some((src) => src.fileName === "Demo data");

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
          <button className="primary" onClick={() => fileInput.current?.click()}>
            Upload statement
          </button>
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
          <span>{notice.text}</span>
          <button className="ghost" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {isDemo && (
        <div className="notice warn demo-banner">
          <span>
            <strong>Demo data.</strong> These members and payments are made up. Upload your bank statement to see your
            gym's numbers; the demo data is replaced.
          </span>
          <button className="primary" onClick={() => fileInput.current?.click()}>
            Upload statement
          </button>
        </div>
      )}

      {!hasData ? (
        <section className="empty">
          <h2>Upload a bank statement to get started</h2>
          <p className="muted">
            Drop your HDFC account statement (.xls) anywhere on this page. It's read in your browser and kept in this
            browser's storage — upload more months later and they're merged automatically.
          </p>
          <div className="row">
            <button className="primary" onClick={() => fileInput.current?.click()}>
              Choose statement file
            </button>
            <button onClick={() => setData(demoDataset())}>Try with demo data</button>
          </div>
        </section>
      ) : (
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
                setRoster={setRoster}
                onOpenMember={setProfileId}
              />
            )}
            {tab === "transactions" && (
              <TransactionsTab analysis={analysis} settings={settings} setSettings={setSettings} />
            )}
            {tab === "settings" && (
              <SettingsTab
                settings={settings}
                setSettings={setSettings}
                data={data}
                onClear={() => {
                  setData(EMPTY_DATASET);
                  setNotice({ kind: "ok", text: "All statement data cleared from this browser." });
                }}
              />
            )}
          </main>
        </>
      )}

      {profile && (
        <MemberProfile
          member={profile}
          asOf={analysis.asOf}
          onClose={() => setProfileId(null)}
          onRename={(name) =>
            setSettings((s) => ({ ...s, memberNames: { ...s.memberNames, [profile.id]: name } }))
          }
        />
      )}
    </div>
  );
}
