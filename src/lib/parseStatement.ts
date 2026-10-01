import * as XLSX from "xlsx";
import type { StatementSource, StatementSummary, Txn } from "./types";

type Cell = string | number | boolean | null | undefined;

const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;

function toIsoDate(cell: Cell): string | null {
  if (typeof cell === "number" && cell > 20000 && cell < 80000) {
    // Excel serial date
    const d = XLSX.SSF.parse_date_code(cell);
    return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  const m = String(cell ?? "").trim().match(DATE_RE);
  if (!m) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${year}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

function toNumber(cell: Cell): number {
  if (typeof cell === "number") return cell;
  const n = parseFloat(String(cell ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

const norm = (c: Cell) => String(c ?? "").trim().toLowerCase();

/** Locates the transaction header row and maps its columns by name. */
function findColumns(rows: Cell[][]) {
  for (let r = 0; r < Math.min(rows.length, 60); r++) {
    const cells = rows[r].map(norm);
    const date = cells.findIndex((c) => c === "date" || c === "txn date" || c === "transaction date");
    const narration = cells.findIndex((c) => c.startsWith("narration") || c === "description" || c === "particulars");
    if (date < 0 || narration < 0) continue;
    const find = (...keys: string[]) => cells.findIndex((c) => keys.some((k) => c.includes(k)));
    return {
      headerRow: r,
      date,
      narration,
      ref: find("ref", "chq"),
      withdrawal: find("withdrawal", "debit"),
      deposit: find("deposit", "credit"),
      balance: find("balance"),
    };
  }
  return null;
}

export interface ParsedStatement {
  txns: Txn[];
  source: StatementSource;
}

/** Parses an HDFC-style bank statement (.xls / .xlsx / .csv) into transactions. */
export function parseStatement(data: ArrayBuffer, fileName: string): ParsedStatement {
  const wb = XLSX.read(data, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Cell[]>(sheet, { header: 1, raw: true, defval: "" });

  const cols = findColumns(rows);
  if (!cols) {
    throw new Error("Couldn't find the transaction table (a header row with Date and Narration columns).");
  }

  let accountHolder: string | null = null;
  for (const row of rows.slice(0, cols.headerRow)) {
    const m = String(row[0] ?? "").trim().match(/^(?:MR|MS|MRS|DR|M\/S)\.?\s+(.+)$/i);
    if (m) {
      accountHolder = m[1].replace(/\s+/g, " ").trim().toUpperCase();
      break;
    }
  }

  const txns: Txn[] = [];
  const seen = new Map<string, number>();
  const body = rows.slice(cols.headerRow + 1);
  // The transaction table ends where the bank's summary block starts.
  const summaryAt = body.findIndex((row) => /statement summary|opening balance/i.test(String(row[0] ?? "")));
  for (const row of summaryAt >= 0 ? body.slice(0, summaryAt) : body) {
    const date = toIsoDate(row[cols.date]);
    if (!date) continue;
    const narration = String(row[cols.narration] ?? "").replace(/\s+/g, " ").trim();
    const ref = cols.ref >= 0 ? String(row[cols.ref] ?? "").trim() : "";
    const withdrawal = cols.withdrawal >= 0 ? toNumber(row[cols.withdrawal]) : 0;
    const deposit = cols.deposit >= 0 ? toNumber(row[cols.deposit]) : 0;
    const balance = cols.balance >= 0 && row[cols.balance] !== "" ? toNumber(row[cols.balance]) : null;
    if (!withdrawal && !deposit) continue;

    // Same statement re-uploaded must produce the same ids so merges de-duplicate.
    const base = `${date}|${ref}|${deposit || -withdrawal}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    txns.push({ id: n ? `${base}|${n}` : base, date, narration, ref, withdrawal, deposit, balance });
  }

  if (!txns.length) throw new Error("No transactions found in this file.");

  const dates = txns.map((t) => t.date).sort();
  const period = findPeriod(rows.slice(0, cols.headerRow));
  return {
    txns,
    source: {
      fileName,
      accountHolder,
      from: dates[0],
      to: dates[dates.length - 1],
      rows: txns.length,
      periodFrom: period?.from ?? null,
      periodTo: period?.to ?? null,
      summary: summaryAt >= 0 ? findSummary(body.slice(summaryAt)) : null,
    },
  };
}

/** "Statement From : 01/04/2025 To : 01/03/2026" in the header block. */
function findPeriod(header: Cell[][]): { from: string; to: string } | null {
  for (const row of header) {
    for (const cell of row) {
      const m = String(cell ?? "").match(/From\s*:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s+To\s*:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
      if (m) {
        const from = toIsoDate(m[1]);
        const to = toIsoDate(m[2]);
        if (from && to) return { from, to };
      }
    }
  }
  return null;
}

/**
 * The STATEMENT SUMMARY block: a label row ("Opening Balance … Debits, Credits, Closing Bal")
 * with the values on the next row, and optionally "Dr Count / Cr Count" the same way.
 */
function findSummary(rows: Cell[][]): StatementSummary | null {
  const valueBelow = (r: number, label: RegExp): number | null => {
    const col = rows[r].findIndex((c) => label.test(String(c ?? "").trim()));
    if (col < 0 || r + 1 >= rows.length) return null;
    const v = rows[r + 1][col];
    return v === "" || v == null || !Number.isFinite(toNumber(v)) ? null : toNumber(v);
  };
  let summary: StatementSummary | null = null;
  for (let r = 0; r < rows.length; r++) {
    const opening = valueBelow(r, /^opening balance$/i);
    const debits = valueBelow(r, /^debits$/i);
    const credits = valueBelow(r, /^credits$/i);
    const closing = valueBelow(r, /^closing bal(ance)?$/i);
    if (opening !== null && debits !== null && credits !== null && closing !== null) {
      summary = { opening, debits, credits, closing, debitCount: null, creditCount: null };
    }
    const dr = valueBelow(r, /^dr count$/i);
    const cr = valueBelow(r, /^cr count$/i);
    if (summary && dr !== null && cr !== null) {
      summary.debitCount = dr;
      summary.creditCount = cr;
    }
  }
  return summary;
}

/** Merges newly parsed transactions into an existing list, dropping duplicates. */
export function mergeTxns(existing: Txn[], incoming: Txn[]): { txns: Txn[]; added: number } {
  const ids = new Set(existing.map((t) => t.id));
  const fresh = incoming.filter((t) => !ids.has(t.id));
  const txns = [...existing, ...fresh].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return { txns, added: fresh.length };
}
