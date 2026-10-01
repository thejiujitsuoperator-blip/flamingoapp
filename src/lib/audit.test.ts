import { describe, expect, it } from "vitest";
import {
  combineImports,
  compareMonths,
  describeSettingsChange,
  findDuplicate,
  rosterDiff,
  runChecks,
  sha256Hex,
  worstStatus,
  type ImportRecord,
} from "./audit";
import { analyse, monthly } from "./members";
import { DEFAULT_SETTINGS } from "./settings";
import type { Dataset, StatementSource, Txn } from "./types";

/** A statement whose rows carry a correct running balance, plus a matching bank summary. */
function statement(opening: number, rows: [string, string, number, number][], periodFrom: string, periodTo: string) {
  let bal = opening;
  const txns: Txn[] = rows.map(([date, name, wd, dep], i) => {
    bal = bal + dep - wd;
    const narration = dep ? `UPI-${name}-${name.toLowerCase().replace(/ /g, "")}@okaxis-HDFC0000076-${500000000000 + i}-UPI` : `UPI-${name}-shop@ybl-HDFC0000076-${600000000000 + i}-UPI`;
    return { id: `${date}|r${date}${i}|${dep || -wd}`, date, narration, ref: `r${date}${i}`, withdrawal: wd, deposit: dep, balance: bal };
  });
  const credits = txns.filter((t) => t.deposit);
  const debits = txns.filter((t) => t.withdrawal);
  const source: StatementSource = {
    fileName: `${periodFrom}.xls`,
    accountHolder: "JANE OWNER",
    from: txns[0].date,
    to: txns[txns.length - 1].date,
    rows: txns.length,
    periodFrom,
    periodTo,
    summary: {
      opening,
      credits: credits.reduce((a, t) => a + t.deposit, 0),
      debits: debits.reduce((a, t) => a + t.withdrawal, 0),
      closing: bal,
      creditCount: credits.length,
      debitCount: debits.length,
    },
  };
  return { source, txns };
}

let seq = 0;
function record(s: ReturnType<typeof statement>): ImportRecord {
  seq++;
  return {
    id: `imp${seq}`,
    origin: "upload",
    fileName: s.source.fileName,
    fileHash: `hash${seq}`,
    fileAssetId: null,
    uploadedAt: `2026-0${seq}-01T00:00:00Z`,
    uploadedBy: null,
    accountHolder: s.source.accountHolder,
    periodFrom: s.source.periodFrom!,
    periodTo: s.source.periodTo!,
    summary: s.source.summary!,
    rowCount: s.txns.length,
    newRowCount: s.txns.length,
    checks: [],
    settings: DEFAULT_SETTINGS,
    parserVersion: 2,
  };
}

const monthlyOf = (d: Dataset) => monthly(analyse(d, DEFAULT_SETTINGS, d.txns[d.txns.length - 1]?.date ?? "2026-01-01"));
const byId = (checks: ReturnType<typeof runChecks>) => Object.fromEntries(checks.map((c) => [c.id, c]));

const jan = statement(
  10000,
  [
    ["2026-01-05", "MEERA RAO", 0, 4000],
    ["2026-01-10", "ROHAN DESAI", 0, 6000],
    ["2026-01-20", "SHOP", 500, 0],
  ],
  "2026-01-01",
  "2026-01-31",
);
const janRec = record(jan);
const earlier = { imports: [janRec], rows: { [janRec.id]: jan.txns } };

describe("runChecks", () => {
  it("passes a first statement whose rows match the bank's totals", () => {
    const c = byId(runChecks(jan, { imports: [], rows: {} }, monthlyOf));
    expect(c.summary.status).toBe("pass");
    expect(c.balance.status).toBe("pass");
    expect(c.continuity.status).toBe("info");
    expect(c.overlap.status).toBe("info");
  });

  it("passes the next month when it continues from the previous closing balance", () => {
    const feb = statement(19500, [["2026-02-03", "MEERA RAO", 0, 4000]], "2026-02-01", "2026-02-28");
    const c = byId(runChecks(feb, earlier, monthlyOf));
    expect(c.continuity.status).toBe("pass");
    expect(c.drift.status).toBe("pass");
    expect(worstStatus(Object.values(c))).toBe("pass");
  });

  it("flags a gap between statements", () => {
    const mar = statement(19500, [["2026-03-03", "MEERA RAO", 0, 4000]], "2026-03-01", "2026-03-31");
    const c = byId(runChecks(mar, earlier, monthlyOf));
    expect(c.continuity.status).toBe("warn");
    expect(c.continuity.detail).toContain("1 Feb 2026 – 28 Feb 2026");
  });

  it("flags an opening balance that doesn't match the previous closing balance", () => {
    const feb = statement(18000, [["2026-02-03", "MEERA RAO", 0, 4000]], "2026-02-01", "2026-02-28");
    expect(byId(runChecks(feb, earlier, monthlyOf)).continuity.status).toBe("fail");
  });

  it("flags rows the bank's summary says are missing", () => {
    const short = { ...jan, txns: jan.txns.slice(0, 2) };
    const c = byId(runChecks(short, { imports: [], rows: {} }, monthlyOf));
    expect(c.summary.status).toBe("fail");
    expect(c.summary.items?.join(" ")).toContain("Bank lists 1 debits; 0 were read");
  });

  it("flags a final balance that doesn't match the bank's closing balance", () => {
    const edited = { ...jan, txns: jan.txns.map((t, i) => (i === 0 ? { ...t, deposit: t.deposit + 500 } : t)).map((t) => ({ ...t, balance: t.balance! + 500 })) };
    const c = byId(runChecks(edited, { imports: [], rows: {} }, monthlyOf));
    expect(c.balance.status).toBe("fail");
    expect(c.balance.items?.join(" ")).toContain("closing balance");
    expect(c.summary.status).toBe("fail");
  });

  it("flags a running-balance jump where a row is missing", () => {
    const gap = { ...jan, txns: [jan.txns[0], jan.txns[2]] };
    const c = byId(runChecks(gap, { imports: [], rows: {} }, monthlyOf));
    expect(c.balance.status).toBe("fail");
    expect(c.balance.detail).toContain("1 row");
  });

  it("lists differences with an earlier upload of the same dates, and the revenue they change", () => {
    const changed = statement(
      10000,
      [
        ["2026-01-05", "MEERA RAO", 0, 4500],
        ["2026-01-20", "SHOP", 500, 0],
      ],
      "2026-01-01",
      "2026-01-31",
    );
    // Same refs as the January file except the dropped row.
    changed.txns[1].ref = jan.txns[2].ref;
    changed.txns[0].ref = jan.txns[0].ref;
    const c = byId(runChecks(changed, earlier, monthlyOf));
    expect(c.overlap.status).toBe("fail");
    expect(c.overlap.items?.some((i) => i.startsWith("Amount changed from ₹4,000.00 to ₹4,500.00"))).toBe(true);
    expect(c.overlap.items?.some((i) => i.startsWith("Missing now"))).toBe(true);
    expect(c.drift.status).toBe("warn");
    expect(c.drift.items?.[0]).toContain("Jan 2026: revenue ₹10,000.00 → ₹4,500.00");
  });
});

describe("combineImports", () => {
  it("lets the newest statement replace older rows for its own period", () => {
    const redo = statement(10000, [["2026-01-05", "MEERA RAO", 0, 4000]], "2026-01-01", "2026-01-31");
    const redoRec = record(redo);
    const d = combineImports([janRec, redoRec], { [janRec.id]: jan.txns, [redoRec.id]: redo.txns });
    expect(d.txns).toHaveLength(1);
    // Rebuilding as of the first upload still shows the original rows.
    expect(combineImports([janRec, redoRec], { [janRec.id]: jan.txns, [redoRec.id]: redo.txns }, janRec.id).txns).toHaveLength(3);
  });
});

describe("helpers", () => {
  it("fingerprints files and finds re-uploads", async () => {
    const h = await sha256Hex(new TextEncoder().encode("abc").buffer as ArrayBuffer);
    expect(h).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(findDuplicate(janRec.fileHash!, [janRec])).toBe(janRec);
  });

  it("describes settings changes in plain language", () => {
    const after = {
      ...DEFAULT_SETTINGS,
      minFee: 3000,
      categoryOverrides: { "2026-01-19|0001|7000": "membership" as const },
      memberNames: { m1: "Meera Venkatesh" },
    };
    expect(describeSettingsChange(DEFAULT_SETTINGS, after, (id) => `txn ${id}`)).toEqual([
      "Smallest membership fee: 2500 → 3000.",
      "txn 2026-01-19|0001|7000: type automatic → Membership fees.",
      'Member renamed to "Meera Venkatesh".',
    ]);
  });

  it("compares months and diffs member lists", () => {
    const then = monthlyOf(combineImports([janRec], { [janRec.id]: jan.txns }));
    const cmp = compareMonths(then, then);
    expect(cmp.every((m) => !m.changed)).toBe(true);
    const a = [{ id: "1", name: "Meera", phone: null, source: "t" }];
    const b = [{ id: "2", name: "Rohan", label: "Rohan Trial", phone: null, source: "t" }];
    expect(rosterDiff(a, b)).toEqual({ added: ["Rohan Trial"], removed: ["Meera"] });
  });
});
