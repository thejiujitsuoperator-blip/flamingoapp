import * as XLSX from "xlsx";
import type { StatementSource, Txn } from "./types";

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
  for (const row of rows.slice(cols.headerRow + 1)) {
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
  return {
    txns,
    source: { fileName, accountHolder, from: dates[0], to: dates[dates.length - 1], rows: txns.length },
  };
}

/** Merges newly parsed transactions into an existing list, dropping duplicates. */
export function mergeTxns(existing: Txn[], incoming: Txn[]): { txns: Txn[]; added: number } {
  const ids = new Set(existing.map((t) => t.id));
  const fresh = incoming.filter((t) => !ids.has(t.id));
  const txns = [...existing, ...fresh].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return { txns, added: fresh.length };
}
