import { describe, expect, it } from "vitest";
import { analyse } from "./members";
import { matchRoster, mergeRoster, parseContactLabel, parseRosterText } from "./roster";
import { DEFAULT_SETTINGS } from "./settings";
import type { Dataset, Txn } from "./types";

let n = 0;
const credit = (date: string, name: string, vpa: string, amount: number, remark = "UPI"): Txn => ({
  id: `t${++n}`,
  date,
  narration: `UPI-${name}-${vpa}-HDFC0000076-${100000000000 + n}-${remark}`,
  ref: String(n),
  withdrawal: 0,
  deposit: amount,
  balance: null,
});

const data: Dataset = {
  accountHolder: "JANE OWNER",
  sources: [],
  txns: [
    credit("2026-01-05", "MEERA LAKSHMI VENKAT", "9800000001@superyes", 7500, "JIU JITSU"),
    credit("2026-01-06", "ROHANDESAI", "9800000002@upi", 4000),
    credit("2026-01-07", "VIKRAM NAIR", "vikramnair@okaxis", 4000, "TARA MENON"),
    credit("2026-01-08", "ANIL KULKARNI", "anilk2005@okhdfcbank", 3500, "ISHAAN"),
    credit("2026-01-09", "NEHA SHARMA", "nehajoshi@okicici", 4000),
    credit("2026-01-10", "ANITA RAO", "anita915@okhdfcbank", 5000),
    credit("2026-01-11", "KIRAN PATIL", "9876501234@ybl", 12000),
    credit("2026-01-12", "DEV MALHOTRA", "devmalhotra@oksbi", 7000, "GI"),
  ],
};
const members = analyse(data, DEFAULT_SETTINGS, "2026-01-31").members;
const byName = (list: ReturnType<typeof matchRoster>) => Object.fromEntries(list.map((m) => [m.entry.name, m]));

describe("parseRosterText", () => {
  it("reads names with optional numbering and phone numbers", () => {
    const r = parseRosterText("1. Meera Venkatesh\nKiran Patil +91 98765 01234\n\n  ---\nMeera", "t");
    expect(r.map((e) => [e.name, e.phone])).toEqual([
      ["Meera Venkatesh", null],
      ["Kiran Patil", "9876501234"],
      ["Meera", null],
    ]);
  });

  it("skips duplicates when merging", () => {
    const first = parseRosterText("Meera\nArjun", "t");
    expect(mergeRoster(first, parseRosterText("meera\nZoya", "t")).added).toBe(1);
  });
});

describe("parseContactLabel", () => {
  it.each([
    ["Rohit Flamingo", "Rohit", []],
    ["Karan Enquiry April 2026", "Karan", ["Enquiry", "April 2026"]],
    ["Nikhil Pooja Friend", "Nikhil", ["Friend of Pooja"]],
    ["Aditya 14yr Old", "Aditya", ["Age 14"]],
    ["Varun Morning flamingo Enquiry", "Varun", ["Enquiry", "Morning batch"]],
    ["Sameer Flamingo Jiu Jitsu", "Sameer", []],
    ["Harpreet (Harry)", "Harpreet", ["aka Harry"]],
    ["Jay Singh Mar 23 Enquiry", "Jay Singh", ["Enquiry", "Mar 23"]],
    ["Leo IJJ", "Leo", ["IJJ"]],
    ["May Flower", "May Flower", []],
  ])("%s", (label, name, tags) => {
    expect(parseContactLabel(label)).toEqual({ name, tags });
  });

  it("keeps same-name contacts as separate entries and ignores bullets and letter headers", () => {
    const r = parseRosterText("A\n\n* Karan\n* Karan May 26\n* Karan Enquiry April 2026", "t");
    expect(r.map((e) => e.name)).toEqual(["Karan", "Karan", "Karan"]);
    expect(new Set(r.map((e) => e.id)).size).toBe(3);
  });
});

describe("matchRoster", () => {
  const roster = parseRosterText(
    ["Meera Venkatesh", "Rohan Desai", "Tara Menon", "Vikram Nair", "Ishaan Kulkarni", "Neha Joshi", "Anita Bose", "Kiran P 9876501234", "Nobody Here"].join("\n"),
    "t",
  );
  const m = byName(matchRoster(roster, members));

  it("matches truncated, run-together and UPI-id names", () => {
    expect(m["Meera Venkatesh"].member?.name).toBe("Meera Lakshmi Venkat");
    expect(m["Rohan Desai"].confidence).toBe("exact");
    expect(m["Neha Joshi"].member?.name).toBe("Neha Sharma");
  });

  it("matches on phone number", () => {
    expect(m["Kiran P"]).toMatchObject({ confidence: "exact", score: 100 });
  });

  it("finds people paid for by someone else via payment notes", () => {
    expect(m["Tara Menon"]).toMatchObject({ paidBy: true });
    expect(m["Tara Menon"].member?.name).toBe("Vikram Nair");
    expect(m["Ishaan Kulkarni"].member?.name).toBe("Anil Kulkarni");
    // The payer can still be matched to their own list entry.
    expect(m["Vikram Nair"]).toMatchObject({ paidBy: false });
    expect(m["Vikram Nair"].member?.name).toBe("Vikram Nair");
  });

  it("doesn't match on a shared first name alone", () => {
    expect(m["Anita Bose"].member).toBeNull();
    expect(m["Nobody Here"].confidence).toBe("none");
  });

  it("flags first-name-only matches when several people on the list share the name", () => {
    const list = parseRosterText("Anil April Trial\nAnil Kumar Rao\nNeha Joshi Sharma", "t");
    const r = byName(matchRoster(list, members));
    expect(r["Anil"]).toMatchObject({ confidence: "possible" });
    expect(r["Anil"].note).toMatch(/2 people/);
    expect(r["Neha Joshi Sharma"].confidence).toBe("likely");
  });

  it("finds merch-only or drop-in-only payments for people who aren't fee-paying members", () => {
    const a = analyse(data, DEFAULT_SETTINGS, "2026-01-31");
    const [dev] = matchRoster(parseRosterText("Dev Malhotra", "t"), a.members, a.payments);
    expect(dev.member).toBeNull();
    expect(dev.otherPayments.map((p) => [p.category, p.amount])).toEqual([["merch", 7000]]);
  });

  it("lets manual links override automatic ones", () => {
    const anita = members.find((x) => x.name === "Anita Rao")!;
    const manual = roster.map((e) => (e.name === "Anita Bose" ? { ...e, linkedMemberId: anita.id } : e));
    expect(byName(matchRoster(manual, members))["Anita Bose"]).toMatchObject({ confidence: "manual" });
    const none = roster.map((e) => (e.name === "Meera Venkatesh" ? { ...e, linkedMemberId: null } : e));
    expect(byName(matchRoster(none, members))["Meera Venkatesh"].member).toBeNull();
  });
});
