import { useMemo, useState } from "react";
import {
  combineImports,
  compareMonths,
  worstStatus,
  type BackupStatus,
  type Check,
  type CheckStatus,
  type ImportRecord,
  type RosterVersion,
} from "../lib/audit";
import { formatDate, formatMonth } from "../lib/dates";
import { money, moneyExact } from "../lib/format";
import type { MonthRow } from "../lib/members";
import { monthlyFor } from "../lib/useHistoryStore";
import type { Vault, VaultState } from "../lib/vault";

interface Props {
  state: VaultState;
  vault: Vault;
  nowMonths: MonthRow[];
  onRetryImportBackup: (r: ImportRecord) => Promise<void>;
  onRetryRosterBackup: (v: RosterVersion) => Promise<void>;
}

const STATUS: Record<CheckStatus, { label: string; tone: string; icon: string }> = {
  pass: { label: "All checks passed", tone: "good", icon: "●" },
  warn: { label: "Needs a look", tone: "warn", icon: "◆" },
  fail: { label: "Problems found", tone: "bad", icon: "▲" },
  info: { label: "Nothing to check", tone: "neutral", icon: "○" },
};
const CHECK_ICON: Record<CheckStatus, string> = { pass: "✓", warn: "!", fail: "✕", info: "–" };

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${formatDate(iso.slice(0, 10))}, ${d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`;
}

type Downloads = { save(r: { filename: string; data: Uint8Array }): Promise<unknown> };

async function saveOriginal(vault: Vault, record: ImportRecord): Promise<string | null> {
  const use = (window as unknown as { claude?: { use?: (n: string) => Promise<unknown> } }).claude?.use;
  const downloads = use ? ((await use("downloads").catch(() => null)) as Downloads | null) : null;
  if (!downloads) return "Saving files isn't available in this view.";
  const original = await vault.readOriginal(record);
  if (!original) return "The original file for this upload isn't stored.";
  try {
    await downloads.save({ filename: original.fileName, data: original.bytes });
    return null;
  } catch {
    return "The file wasn't saved.";
  }
}

function BackupPill({ backup, kind, onRetry }: { backup?: BackupStatus; kind: Vault["kind"]; onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  if (kind !== "cloud") return null;
  const retry = (
    <button
      className="link small"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await onRetry();
        setBusy(false);
      }}
    >
      {busy ? "Backing up…" : backup ? "Back up again" : "Back up now"}
    </button>
  );
  if (!backup) return <span className="small muted">Drive backup pending {retry}</span>;
  return (
    <span className="small">
      <span className={`pill ${backup.state === "done" ? "good" : "bad"}`} title={backup.detail}>
        {backup.state === "done" ? "Backed up to Drive" : "Drive backup failed"}
      </span>{" "}
      {backup.state === "failed" && (
        <>
          <span className="muted">{backup.detail}</span> {retry}
        </>
      )}
    </span>
  );
}

function CheckList({ checks }: { checks: Check[] }) {
  return (
    <ul className="checks">
      {checks.map((c) => (
        <li key={c.id} className={`check ${c.status}`}>
          <span className="check-icon" aria-hidden="true">
            {CHECK_ICON[c.status]}
          </span>
          <div>
            <strong>{c.label}</strong> <span className="muted">{c.detail}</span>
            {c.items && c.items.length > 0 && (
              <ul className="check-items">
                {c.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Comparison({ state, record, nowMonths }: { state: VaultState; record: ImportRecord; nowMonths: MonthRow[] }) {
  const rows = useMemo(() => {
    const then = monthlyFor(record.settings)(combineImports(state.imports, state.rows, record.id));
    return compareMonths(then, nowMonths);
  }, [state, record, nowMonths]);
  const changed = rows.filter((r) => r.changed && r.thenRevenue !== null);
  const fmt = (n: number | null) => (n === null ? "—" : money(n));
  return (
    <div className="comparison">
      <p className="small">
        {changed.length
          ? `${changed.length} month${changed.length === 1 ? "" : "s"} read differently now than right after this upload. Later uploads, reclassified payments or settings changes explain the difference; see the change log below.`
          : "Every month that existed after this upload reads the same now."}
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Month</th>
              <th className="num">Revenue then</th>
              <th className="num">Revenue now</th>
              <th className="num">Difference</th>
              <th className="num">Active then</th>
              <th className="num">Active now</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const diff = r.thenRevenue !== null && r.nowRevenue !== null ? r.nowRevenue - r.thenRevenue : null;
              return (
                <tr key={r.month} className={r.changed && r.thenRevenue !== null ? "row-changed" : undefined}>
                  <td>{formatMonth(r.month)}</td>
                  <td className="num">{fmt(r.thenRevenue)}</td>
                  <td className="num">{fmt(r.nowRevenue)}</td>
                  <td className="num">{diff === null ? (r.thenRevenue === null ? "new" : "—") : diff === 0 ? "" : `${diff > 0 ? "+" : "−"}${money(Math.abs(diff))}`}</td>
                  <td className="num">{r.thenActive ?? "—"}</td>
                  <td className="num">{r.nowActive ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function HistoryTab({ state, vault, nowMonths, onRetryImportBackup, onRetryRosterBackup }: Props) {
  const [open, setOpen] = useState<{ id: string; view: "checks" | "compare" } | null>(null);
  const [fileMessage, setFileMessage] = useState<string | null>(null);
  const imports = [...state.imports].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  const versions = [...state.rosterVersions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const changes = [...state.changes].sort((a, b) => b.at.localeCompare(a.at));
  const toggle = (id: string, view: "checks" | "compare") =>
    setOpen((o) => (o?.id === id && o.view === view ? null : { id, view }));

  return (
    <div className="settings history">
      <section className="card">
        <h2>Where this is kept</h2>
        <p className="small">
          {vault.kind === "cloud"
            ? "Every statement, member-list version and change is saved with this page on claude.ai, so it's the same on any device you sign in on. Nothing here is ever overwritten: each upload is added alongside the earlier ones, and each is copied to a \"Flamingo Members backups\" folder in your Google Drive. The Back up button at the top sends anything not yet copied, plus one file holding the whole history."
            : "Saved in this browser only. Open the page on claude.ai to keep the history across devices and back it up to Google Drive."}
        </p>
      </section>

      <section className="card">
        <h2>Statement uploads</h2>
        {fileMessage && <p className="ask-error">{fileMessage}</p>}
        {imports.length === 0 ? (
          <p className="muted">No statements uploaded yet.</p>
        ) : (
          <ul className="history-list">
            {imports.map((r) => {
              const status = STATUS[worstStatus(r.checks)];
              const isOpen = open?.id === r.id;
              return (
                <li key={r.id} className="history-item">
                  <div className="history-head">
                    <div className="history-title">
                      <strong>{r.fileName}</strong>
                      <span className="muted small">
                        {formatDate(r.periodFrom)} – {formatDate(r.periodTo)} · uploaded {formatDateTime(r.uploadedAt)}
                        {r.origin === "migrated" ? " · moved from browser storage" : ""}
                      </span>
                      <span className="muted small">
                        {r.rowCount} transactions, {r.newRowCount} new
                        {r.summary ? ` · closing balance ${moneyExact(r.summary.closing)}` : ""}
                      </span>
                    </div>
                    <span className={`pill ${status.tone}`}>
                      <span aria-hidden="true">{status.icon}</span> {status.label}
                    </span>
                  </div>
                  <div className="row history-actions">
                    <button className="link small" onClick={() => toggle(r.id, "checks")}>
                      {isOpen && open?.view === "checks" ? "Hide checks" : "Show checks"}
                    </button>
                    <button className="link small" onClick={() => toggle(r.id, "compare")}>
                      {isOpen && open?.view === "compare" ? "Hide comparison" : "Compare with now"}
                    </button>
                    {r.fileAssetId && (
                      <button
                        className="link small"
                        onClick={async () => setFileMessage(await saveOriginal(vault, r))}
                      >
                        Save original file
                      </button>
                    )}
                    <BackupPill backup={r.backup} kind={vault.kind} onRetry={() => onRetryImportBackup(r)} />
                  </div>
                  {isOpen && open?.view === "checks" && <CheckList checks={r.checks} />}
                  {isOpen && open?.view === "compare" && <Comparison state={state} record={r} nowMonths={nowMonths} />}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Member list versions</h2>
        {versions.length === 0 ? (
          <p className="muted">No member list saved yet. Add names in the Member list tab.</p>
        ) : (
          <ul className="history-list">
            {versions.map((v) => (
              <li key={v.id} className="history-item">
                <div className="history-head">
                  <div className="history-title">
                    <strong>{v.note}</strong>
                    <span className="muted small">
                      {formatDateTime(v.createdAt)} · {v.entries.length} names
                    </span>
                  </div>
                  <BackupPill backup={v.backup} kind={vault.kind} onRetry={() => onRetryRosterBackup(v)} />
                </div>
                {(v.added.length > 0 || v.removed.length > 0) && (
                  <details className="small">
                    <summary>
                      {v.added.length > 0 && `+${v.added.length} added`}
                      {v.added.length > 0 && v.removed.length > 0 && ", "}
                      {v.removed.length > 0 && `−${v.removed.length} removed`}
                    </summary>
                    {v.added.length > 0 && <p>Added: {v.added.join(", ")}</p>}
                    {v.removed.length > 0 && <p>Removed: {v.removed.join(", ")}</p>}
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Change log</h2>
        <p className="muted small">Reclassified payments, corrected matches, renamed members and settings changes, newest first.</p>
        {changes.length === 0 ? (
          <p className="muted">No manual changes yet.</p>
        ) : (
          <ul className="history-list">
            {changes.map((c) => (
              <li key={c.id} className="change">
                <span className="muted small">{formatDateTime(c.at)}</span>
                <ul className="check-items">
                  {c.lines.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
