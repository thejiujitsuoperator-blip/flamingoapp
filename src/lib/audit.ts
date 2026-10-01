import { addDays, diffDays, formatDate, formatMonth, monthKey } from "./dates";
import { money as moneyRounded, moneyExact as money } from "./format";
import type { MonthRow } from "./members";
import { CATEGORY_LABELS, type Category, type Dataset, type RosterEntry, type Settings, type StatementSource, type StatementSummary, type Txn } from "./types";

/** Bump when parsing rules change, so each import records which rules read it. */
export const PARSER_VERSION = 2;

export type CheckStatus = "pass" | "warn" | "fail" | "info";

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  items?: string[];
}

export interface BackupStatus {
  state: "done" | "failed";
  at: string;
  detail: string;
}

/** One uploaded statement. Never edited after it is written, except for its backup status. */
export interface ImportRecord {
  id: string;
  origin: "upload" | "migrated";
  fileName: string;
  fileHash: string | null;
  /** Asset holding the original file, when stored. */
  fileAssetId: string | null;
  uploadedAt: string;
  uploadedBy: string | null;
  accountHolder: string | null;
  /** The period this statement speaks for: its printed period, else its first and last transaction. */
  periodFrom: string;
  periodTo: string;
  summary: StatementSummary | null;
  rowCount: number;
  /** Rows not already present in earlier uploads. */
  newRowCount: number;
  checks: Check[];
  /** Settings in force when it was uploaded, so the dashboard of that day can be rebuilt. */
  settings: Settings;
  parserVersion: number;
  backup?: BackupStatus;
}

/** One saved version of the member list. */
export interface RosterVersion {
  id: string;
  createdAt: string;
  createdBy: string | null;
  note: string;
  entries: RosterEntry[];
  added: string[];
  removed: string[];
  backup?: BackupStatus;
}

/** One manual change: a reclassified payment, a corrected match, a settings edit. */
export interface ChangeEntry {
  id: string;
  at: string;
  by: string | null;
  kind: "settings" | "match" | "roster" | "migration";
  lines: string[];
}

export function newId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}-${rand}`;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function statementPeriod(source: StatementSource): { from: string; to: string } {
  return { from: source.periodFrom ?? source.from!, to: source.periodTo ?? source.to! };
}

const byUpload = (a: ImportRecord, b: ImportRecord) => a.uploadedAt.localeCompare(b.uploadedAt);

/**
 * The transactions the dashboard uses: imports applied oldest first, each one replacing whatever
 * earlier imports said about its own period, so the newest statement is the bank's last word.
 * `upToImportId` rebuilds the data as it stood right after that import.
 */
export function combineImports(imports: ImportRecord[], rows: Record<string, Txn[]>, upToImportId?: string): Dataset {
  const ordered = [...imports].sort(byUpload);
  const stop = upToImportId ? ordered.findIndex((i) => i.id === upToImportId) : ordered.length - 1;
  let txns: Txn[] = [];
  const used = ordered.slice(0, stop + 1);
  for (const imp of used) {
    txns = txns.filter((t) => t.date < imp.periodFrom || t.date > imp.periodTo);
    txns.push(...(rows[imp.id] ?? []));
  }
  txns.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return {
    txns,
    accountHolder: used.length ? used[used.length - 1].accountHolder : null,
    sources: used.map((i) => ({
      fileName: i.fileName,
      accountHolder: i.accountHolder,
      from: i.periodFrom,
      to: i.periodTo,
      rows: i.rowCount,
      periodFrom: i.periodFrom,
      periodTo: i.periodTo,
      summary: i.summary,
    })),
  };
}

export function findDuplicate(hash: string, imports: ImportRecord[]): ImportRecord | null {
  return imports.find((i) => i.fileHash === hash) ?? null;
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
const rowLabel = (t: Txn) => `${formatDate(t.date)} · ${t.deposit ? `credit ${money(t.deposit)}` : `debit ${money(t.withdrawal)}`} · ${t.narration.slice(0, 48)}`;

export interface CheckInput {
  source: StatementSource;
  /** Rows in the order they appear in the file. */
  txns: Txn[];
}

/**
 * Checks a new statement against the bank's own totals and against everything uploaded before.
 * `monthlyOf` turns a dataset into month rows using the current settings.
 */
export function runChecks(
  input: CheckInput,
  earlier: { imports: ImportRecord[]; rows: Record<string, Txn[]> },
  monthlyOf: (d: Dataset) => MonthRow[],
): Check[] {
  const { source, txns } = input;
  const period = statementPeriod(source);
  const checks: Check[] = [];
  const s = source.summary;

  // 1. Rows read vs the bank's summary
  const credits = txns.filter((t) => t.deposit > 0);
  const debits = txns.filter((t) => t.withdrawal > 0);
  const creditTotal = credits.reduce((a, t) => a + t.deposit, 0);
  const debitTotal = debits.reduce((a, t) => a + t.withdrawal, 0);
  if (!s) {
    checks.push({ id: "summary", label: "Matches the bank's totals", status: "info", detail: "This file has no statement summary to compare against." });
  } else {
    const problems: string[] = [];
    if (s.creditCount !== null && s.creditCount !== credits.length) problems.push(`Bank lists ${s.creditCount} credits; ${credits.length} were read.`);
    if (s.debitCount !== null && s.debitCount !== debits.length) problems.push(`Bank lists ${s.debitCount} debits; ${debits.length} were read.`);
    if (!near(s.credits, creditTotal)) problems.push(`Bank's credit total is ${money(s.credits)}; rows read add up to ${money(creditTotal)}.`);
    if (!near(s.debits, debitTotal)) problems.push(`Bank's debit total is ${money(s.debits)}; rows read add up to ${money(debitTotal)}.`);
    checks.push(
      problems.length
        ? { id: "summary", label: "Matches the bank's totals", status: "fail", detail: "Some rows may be missing or misread.", items: problems }
        : {
            id: "summary",
            label: "Matches the bank's totals",
            status: "pass",
            detail: `${credits.length} credits (${money(creditTotal)}) and ${debits.length} debits (${money(debitTotal)}), as the bank reports.`,
          },
    );
  }

  // 2. Balances add up, overall and row by row
  const balanceProblems: string[] = [];
  if (s && !near(s.opening + s.credits - s.debits, s.closing)) {
    balanceProblems.push(`Opening ${money(s.opening)} + credits − debits ≠ closing ${money(s.closing)}.`);
  }
  let running: number | null = s ? s.opening : null;
  let mismatches = 0;
  for (const t of txns) {
    if (t.balance === null) {
      running = null;
      continue;
    }
    if (running !== null) {
      const expected = running + t.deposit - t.withdrawal;
      if (!near(expected, t.balance)) {
        mismatches++;
        if (balanceProblems.length < 6) balanceProblems.push(`${rowLabel(t)}: balance ${money(t.balance)}, expected ${money(expected)}`);
      }
    }
    running = t.balance;
  }
  const last = [...txns].reverse().find((t) => t.balance !== null);
  if (s && last && last.balance !== null && !near(last.balance, s.closing)) {
    balanceProblems.push(`The last row's balance is ${money(last.balance)} but the bank's closing balance is ${money(s.closing)}.`);
  }
  const withBalances = txns.some((t) => t.balance !== null);
  checks.push(
    balanceProblems.length
      ? {
          id: "balance",
          label: "Running balance adds up",
          status: "fail",
          detail: mismatches
            ? `${mismatches} row${mismatches === 1 ? "" : "s"} where the balance jumps; a transaction is probably missing just before.`
            : "The balances don't reconcile with the bank's opening and closing figures.",
          items: balanceProblems,
        }
      : withBalances || s
        ? { id: "balance", label: "Running balance adds up", status: "pass", detail: "Every row's balance follows from the one before." }
        : { id: "balance", label: "Running balance adds up", status: "info", detail: "This file has no balance column to check." },
  );

  // 3. Continuity with the previous statement
  const before = earlier.imports.filter((i) => i.periodTo < period.from).sort((a, b) => a.periodTo.localeCompare(b.periodTo));
  const prev = before[before.length - 1];
  if (!prev) {
    checks.push({ id: "continuity", label: "Follows the previous statement", status: "info", detail: "No earlier statement ends before this one starts." });
  } else {
    const gap = diffDays(period.from, prev.periodTo) - 1;
    if (gap > 0) {
      checks.push({
        id: "continuity",
        label: "Follows the previous statement",
        status: "warn",
        detail: `No statement covers ${formatDate(addDays(prev.periodTo, 1))} – ${formatDate(addDays(period.from, -1))} (${gap} day${gap === 1 ? "" : "s"}). Upload it to fill the gap.`,
      });
    } else if (prev.summary && s && !near(prev.summary.closing, s.opening)) {
      checks.push({
        id: "continuity",
        label: "Follows the previous statement",
        status: "fail",
        detail: `The previous statement closed at ${money(prev.summary.closing)} but this one opens at ${money(s.opening)}.`,
      });
    } else {
      checks.push({
        id: "continuity",
        label: "Follows the previous statement",
        status: "pass",
        detail: `Continues straight on from "${prev.fileName}"${prev.summary && s ? `, opening at its closing balance of ${money(s.opening)}` : ""}.`,
      });
    }
  }

  // 4. Overlap with earlier uploads
  const key = (t: Txn) => `${t.date}|${t.ref}|${t.deposit ? "C" : "D"}`;
  const overlapping = earlier.imports.filter((i) => i.periodFrom <= period.to && i.periodTo >= period.from);
  if (!overlapping.length) {
    checks.push({ id: "overlap", label: "Agrees with earlier uploads", status: "info", detail: "Doesn't overlap any earlier upload." });
  } else {
    const items: string[] = [];
    let differences = 0;
    for (const imp of overlapping) {
      const from = imp.periodFrom > period.from ? imp.periodFrom : period.from;
      const to = imp.periodTo < period.to ? imp.periodTo : period.to;
      const inRange = (t: Txn) => t.date >= from && t.date <= to;
      const oldRows = new Map((earlier.rows[imp.id] ?? []).filter(inRange).map((t) => [key(t), t]));
      const newRows = new Map(txns.filter(inRange).map((t) => [key(t), t]));
      for (const [k, t] of oldRows) {
        const n = newRows.get(k);
        if (!n) {
          differences++;
          items.push(`Missing now (was in "${imp.fileName}"): ${rowLabel(t)}`);
        } else if (!near(n.deposit, t.deposit) || !near(n.withdrawal, t.withdrawal)) {
          differences++;
          items.push(`Amount changed from ${money(t.deposit || t.withdrawal)} to ${money(n.deposit || n.withdrawal)}: ${rowLabel(n)}`);
        }
      }
      for (const [k, t] of newRows) {
        if (!oldRows.has(k)) {
          differences++;
          items.push(`New in this file (not in "${imp.fileName}"): ${rowLabel(t)}`);
        }
      }
    }
    checks.push(
      differences
        ? {
            id: "overlap",
            label: "Agrees with earlier uploads",
            status: "fail",
            detail: `${differences} difference${differences === 1 ? "" : "s"} with earlier uploads for the same dates. This file's version is now used for its period.`,
            items: items.slice(0, 20),
          }
        : { id: "overlap", label: "Agrees with earlier uploads", status: "pass", detail: "Every overlapping transaction matches earlier uploads exactly." },
    );
  }

  // 5. Earlier months unchanged
  if (earlier.imports.length) {
    const previousEnd = earlier.imports.reduce((m, i) => (i.periodTo > m ? i.periodTo : m), "");
    const tempId = "__new__";
    const withNew = [
      ...earlier.imports,
      { id: tempId, periodFrom: period.from, periodTo: period.to, uploadedAt: "￿", accountHolder: source.accountHolder } as ImportRecord,
    ];
    const beforeRows = monthlyOf(combineImports(earlier.imports, earlier.rows));
    const afterRows = new Map(monthlyOf(combineImports(withNew, { ...earlier.rows, [tempId]: txns })).map((r) => [r.month, r]));
    const lastFullMonth = monthKey(addDays(previousEnd, 1)) > monthKey(previousEnd) ? monthKey(previousEnd) : monthKey(addDays(monthKey(previousEnd) + "-01", -1));
    const drift = beforeRows
      .filter((r) => r.month <= lastFullMonth)
      .map((r) => ({ r, after: afterRows.get(r.month) }))
      .filter(({ r, after }) => !after || !near(after.revenue, r.revenue))
      .map(({ r, after }) => `${formatMonth(r.month)}: revenue ${money(r.revenue)} → ${money(after?.revenue ?? 0)}`);
    checks.push(
      drift.length
        ? { id: "drift", label: "Earlier months unchanged", status: "warn", detail: "This upload changes revenue for months you had already closed.", items: drift }
        : { id: "drift", label: "Earlier months unchanged", status: "pass", detail: "Revenue for months already covered stays the same." },
    );
  }

  // 6. Same account
  const holders = new Set(earlier.imports.map((i) => i.accountHolder).filter(Boolean));
  if (holders.size && source.accountHolder && !holders.has(source.accountHolder)) {
    checks.push({
      id: "account",
      label: "Same bank account",
      status: "warn",
      detail: `This statement is for ${source.accountHolder}; earlier ones are for ${[...holders].join(", ")}.`,
    });
  }

  return checks;
}

export function worstStatus(checks: Check[]): CheckStatus {
  for (const s of ["fail", "warn", "pass"] as const) if (checks.some((c) => c.status === s)) return s;
  return "info";
}

/** Plain-language lines describing what changed between two settings snapshots, for the change log. */
export function describeSettingsChange(before: Settings, after: Settings, describeTxn: (id: string) => string): string[] {
  const lines: string[] = [];
  const tiers = (s: Settings) =>
    [...s.planTiers]
      .sort((a, b) => a.minAmount - b.minAmount)
      .map((t) => `${t.label} from ${moneyRounded(t.minAmount)} = ${t.months} month${t.months === 1 ? "" : "s"}`)
      .join("; ");
  if (tiers(before) !== tiers(after)) lines.push(`Plans changed from "${tiers(before)}" to "${tiers(after)}".`);
  const numbers: [keyof Settings, string][] = [
    ["minFee", "Smallest membership fee"],
    ["dropInMax", "Drop-in limit"],
    ["renewalGraceDays", "Renewal grace days"],
    ["dueWindowDays", "Due-for-renewal window"],
    ["renewSoonDays", "Renewing-soon window"],
  ];
  for (const [k, label] of numbers) if (before[k] !== after[k]) lines.push(`${label}: ${before[k]} → ${after[k]}.`);

  const label = (c: Category | undefined) => (c ? CATEGORY_LABELS[c] : "automatic");
  for (const id of new Set([...Object.keys(before.categoryOverrides), ...Object.keys(after.categoryOverrides)])) {
    const a = before.categoryOverrides[id];
    const b = after.categoryOverrides[id];
    if (a !== b) lines.push(`${describeTxn(id)}: type ${label(a)} → ${label(b)}.`);
  }
  for (const id of new Set([...Object.keys(before.memberNames), ...Object.keys(after.memberNames)])) {
    const a = before.memberNames[id];
    const b = after.memberNames[id];
    if (a !== b) lines.push(b ? `Member renamed${a ? ` from "${a}"` : ""} to "${b}".` : `Member name "${a}" reset.`);
  }
  const added = after.ownerPayers.filter((p) => !before.ownerPayers.includes(p));
  const removed = before.ownerPayers.filter((p) => !after.ownerPayers.includes(p));
  if (added.length) lines.push(`Treated as owner transfers: ${added.join(", ")}.`);
  if (removed.length) lines.push(`No longer treated as owner transfers: ${removed.join(", ")}.`);
  return lines;
}

/** "Payment of ₹7,000 on 19 Jan 2026" from a transaction id (`date|ref|amount`). */
export function describeTxnId(id: string): string {
  const [date, , amount] = id.split("|");
  const n = Number(amount);
  return `${n < 0 ? "Debit" : "Payment"} of ${moneyRounded(Math.abs(n))} on ${formatDate(date)}`;
}

export interface MonthComparison {
  month: string;
  thenRevenue: number | null;
  nowRevenue: number | null;
  thenActive: number | null;
  nowActive: number | null;
  changed: boolean;
}

/** Month-by-month comparison of the dashboard as it stood after an import with the dashboard now. */
export function compareMonths(then: MonthRow[], now: MonthRow[]): MonthComparison[] {
  const months = [...new Set([...then.map((r) => r.month), ...now.map((r) => r.month)])].sort();
  const t = new Map(then.map((r) => [r.month, r]));
  const n = new Map(now.map((r) => [r.month, r]));
  return months.map((month) => {
    const a = t.get(month);
    const b = n.get(month);
    return {
      month,
      thenRevenue: a?.revenue ?? null,
      nowRevenue: b?.revenue ?? null,
      thenActive: a?.activeAtMonthEnd ?? null,
      nowActive: b?.activeAtMonthEnd ?? null,
      changed: !a || !b || !near(a.revenue, b.revenue) || a.activeAtMonthEnd !== b.activeAtMonthEnd,
    };
  });
}

/** Names added and removed between two member-list versions. */
export function rosterDiff(before: RosterEntry[], after: RosterEntry[]): { added: string[]; removed: string[] } {
  const label = (e: RosterEntry) => e.label ?? e.name;
  const a = new Set(before.map((e) => e.id));
  const b = new Set(after.map((e) => e.id));
  return {
    added: after.filter((e) => !a.has(e.id)).map(label),
    removed: before.filter((e) => !b.has(e.id)).map(label),
  };
}
