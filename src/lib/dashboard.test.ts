import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { classify, extractPayer } from "./classify";
import { addMonths } from "./dates";
import { analyse, dueForRenewal, monthly, renewingSoon } from "./members";
import { mergeTxns, parseStatement } from "./parseStatement";
import { localQuery, parseRange } from "./query";
import { DEFAULT_SETTINGS } from "./settings";
import type { Dataset, Txn } from "./types";

/** Builds a small statement laid out like an HDFC .xls export. */
function statementFile(rows: [string, string, number, number][]): ArrayBuffer {
  const aoa: (string | number)[][] = [
    ["HDFC BANK Ltd.        Statement of accounts"],
    [],
    ["MS.     JANE OWNER"],
    ["Statement From  :  01/01/2026         To  :  31/03/2026"],
    [],
    ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
    ["********", "****", "****", "****", "****", "****", "****"],
    ...rows.map(([date, narration, wd, dep], i) => [date, narration, String(1000 + i), date, wd || "", dep || "", 50000]),
    [],
    ["STATEMENT SUMMARY  :-"],
    ["Opening Balance", "", "", "", "Debits", "Credits", "Closing Bal"],
    [50000, "", "", "", 700, 99666, 148966],
    [],
    ["", "", "", "", "Dr Count", "Cr Count", ""],
    ["", "", "", "", 1, 11, ""],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Sheet 1");
  return XLSX.write(wb, { type: "array", bookType: "biff8" });
}

const upi = (name: string, vpa: string, remark = "UPI") => `UPI-${name}-${vpa}-HDFC0000076-123456789012-${remark}`;

const FILE = statementFile([
  ["05/01/26", upi("ALICE  SMITH", "alice-1@okaxis"), 0, 4000],
  ["06/01/26", upi("BOB KUMAR", "9876543210@ybl"), 0, 12000],
  ["07/01/26", upi("CAROL D", "carol@oksbi", "BJJ SHORTS"), 0, 1500],
  ["08/01/26", upi("XXXPGN KOTAK 811 SAV", "dan@okaxis", "DROP IN CLASS"), 0, 450],
  ["10/01/26", upi("MARK OWNER", "mark@oksbi"), 0, 20000],
  ["11/01/26", "INTEREST PAID TILL 31-DEC-2025", 0, 900],
  ["12/01/26", "ACH C- TCS FIN DIV-1734663", 0, 120],
  ["15/01/26", upi("SOME SHOP", "shop@ybl"), 700, 0],
  ["03/02/26", upi("ALICE SMITH", "alice@okhdfcbank"), 0, 4000],
  ["20/02/26", upi("ERIN LEE", "erin@okicici"), 0, 4696],
  ["25/02/26", upi("FRANK M", "frank@okicici", "PAYMENT FROM PHONE"), 0, 6000],
  ["01/03/26", upi("GINA R", "gina@okicici"), 0, 42000],
]);

function load(): Dataset {
  const { txns, source } = parseStatement(FILE, "test.xls");
  return { txns, sources: [source], accountHolder: source.accountHolder };
}

describe("parseStatement", () => {
  it("reads transactions and the account holder", () => {
    const d = load();
    expect(d.accountHolder).toBe("JANE OWNER");
    expect(d.txns).toHaveLength(12);
    expect(d.txns[0]).toMatchObject({ date: "2026-01-05", deposit: 4000, withdrawal: 0 });
    expect(d.sources[0]).toMatchObject({ from: "2026-01-05", to: "2026-03-01", periodFrom: "2026-01-01", periodTo: "2026-03-31" });
    expect(d.sources[0].summary).toEqual({
      opening: 50000,
      debits: 700,
      credits: 99666,
      closing: 148966,
      debitCount: 1,
      creditCount: 11,
    });
  });

  it("de-duplicates when the same statement is merged twice", () => {
    const d = load();
    const { txns, added } = mergeTxns(d.txns, parseStatement(FILE, "again.xls").txns);
    expect(added).toBe(0);
    expect(txns).toHaveLength(12);
  });

  it("rejects files without a transaction table", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["hello"]]), "S");
    expect(() => parseStatement(XLSX.write(wb, { type: "array", bookType: "xlsx" }), "x.xlsx")).toThrow(/transaction table/);
  });
});

describe("classify", () => {
  const d = load();
  const cat = (i: number) => classify(d.txns[i], DEFAULT_SETTINGS, d.accountHolder);

  it("separates fees, merch, drop-ins and non-revenue credits", () => {
    expect(cat(0)).toBe("membership");
    expect(cat(2)).toBe("merch");
    expect(cat(3)).toBe("dropin");
    expect(cat(4)).toBe("owner"); // shares the account holder's surname
    expect(cat(5)).toBe("interest");
    expect(cat(6)).toBe("investment");
    expect(cat(7)).toBe("expense");
    expect(cat(9)).toBe("merch"); // odd amount, not a fee
  });

  it("honours manual overrides", () => {
    const settings = { ...DEFAULT_SETTINGS, categoryOverrides: { [d.txns[9].id]: "membership" as const } };
    expect(classify(d.txns[9], settings, d.accountHolder)).toBe("membership");
  });

  it("parses UPI narrations whose ids contain dashes", () => {
    expect(extractPayer("UPI-ANNA GEORGE-ANNA.4421-7@WAICICI-ICIC0000071-509860767795-NA")).toEqual({
      name: "ANNA GEORGE",
      vpa: "anna.4421-7@waicici",
      remark: "",
    });
  });
});

describe("analyse", () => {
  const d = load();

  it("merges one person's payments from different UPI ids", () => {
    const a = analyse(d, DEFAULT_SETTINGS, "2026-03-01");
    const alice = a.members.find((m) => m.name === "Alice Smith")!;
    expect(alice.payments).toHaveLength(2);
    expect(alice.vpas).toEqual(["alice-1@okaxis", "alice@okhdfcbank"]);
    // Renewed within the grace period, so the second month continues from the first.
    expect(alice.expiry).toBe("2026-03-04");
  });

  it("maps amounts to plans and computes statuses", () => {
    const a = analyse(d, DEFAULT_SETTINGS, "2026-03-01");
    const byName = Object.fromEntries(a.members.map((m) => [m.name, m]));
    expect(Object.keys(byName).sort()).toEqual(["Alice Smith", "Bob Kumar", "Frank M", "Gina R"]);
    expect(byName["Bob Kumar"]).toMatchObject({ currentPlan: "Quarterly", expiry: "2026-04-05", status: "active" });
    expect(byName["Gina R"]).toMatchObject({ currentPlan: "Annual", expiry: "2027-02-28" });
    expect(renewingSoon(a.members, 7).map((m) => m.name)).toEqual(["Alice Smith"]);

    const later = analyse(d, DEFAULT_SETTINGS, "2026-04-10");
    expect(dueForRenewal(later.members).map((m) => m.name)).toEqual(["Bob Kumar", "Frank M"]);
    expect(later.members.find((m) => m.name === "Alice Smith")!.status).toBe("lapsed");
  });

  it("splits revenue by month and excludes non-revenue credits", () => {
    const rows = monthly(analyse(d, DEFAULT_SETTINGS, "2026-03-01"));
    expect(rows.map((r) => r.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(rows[0].byCategory).toMatchObject({ membership: 16000, merch: 1500, dropin: 450, owner: 20000, interest: 900 });
    expect(rows[0].revenue).toBe(17950);
    expect(rows[1].revenue).toBe(4000 + 4696 + 6000);
    expect(rows[0].newMembers).toBe(2);
  });
});

describe("localQuery", () => {
  const a = analyse(load(), DEFAULT_SETTINGS, "2026-03-01");

  it("answers renewal questions", () => {
    const r = localQuery("who is up for renewal in the next 7 days?", a)!;
    expect(r.table?.rows.map((row) => row[0])).toEqual(["Alice Smith"]);
  });

  it("answers revenue questions for a month", () => {
    expect(localQuery("revenue in january 2026", a)!.answer).toContain("₹17,950");
    expect(localQuery("how much did we make in Feb", a)!.answer).toContain("₹14,696");
  });

  it("answers month-wise breakdowns", () => {
    expect(localQuery("month wise revenue split", a)!.table?.rows).toHaveLength(3);
  });

  it("finds a member by name", () => {
    const r = localQuery("show payments by alice", a)!;
    expect(r.memberIds).toHaveLength(1);
    expect(r.answer).toContain("₹8,000");
  });

  it("filters payments by amount", () => {
    expect(localQuery("payments over 10000", a)!.table?.rows).toHaveLength(2);
  });

  it("returns null for questions it can't parse", () => {
    expect(localQuery("what's the weather like", a)).toBeNull();
  });

  it("parses relative date ranges against the as-of date", () => {
    expect(parseRange("last month", a)).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
    expect(parseRange("december", a)).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
  });
});

describe("addMonths", () => {
  it("clamps to the end of shorter months", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
  });
});

// Keep the fixture type-checked against Txn.
export type _Check = Txn;
