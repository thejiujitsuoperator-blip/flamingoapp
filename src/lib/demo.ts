import { addDays, todayIso } from "./dates";
import type { Dataset, Txn } from "./types";

const FIRST = ["Aarav", "Diya", "Kabir", "Meera", "Rohan", "Isha", "Vikram", "Ananya", "Arjun", "Nisha", "Karan", "Pooja", "Siddharth", "Tara", "Nikhil", "Zoya", "Aditya", "Riya", "Farhan", "Kavya", "Manish", "Sneha", "Omar", "Lakshmi"];
const LAST = ["Rao", "Menon", "Iyer", "Shah", "Das", "Nair", "Kapoor", "Reddy", "Singh", "Joshi", "Bose", "Khan"];
const BANKS = ["okhdfcbank", "okaxis", "oksbi", "ybl", "okicici", "ptyes"];
const IFSC = ["HDFC0000076", "SBIN0003232", "UTIB0004632", "ICIC0000071", "KKBK0008507"];

/** Deterministic pseudo-random numbers so the demo looks the same every time. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

/** A year of made-up gym statement data ending today, for trying the dashboard. */
export function demoDataset(): Dataset {
  const rand = rng(42);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const end = todayIso();
  const start = addDays(end, -364);
  const txns: Txn[] = [];
  let ref = 500000000000;

  const credit = (date: string, name: string, vpa: string, amount: number, remark = "UPI") => {
    ref += Math.floor(rand() * 1000) + 1;
    txns.push({
      id: `${date}|${ref}|${amount}`,
      date,
      narration: `UPI-${name}-${vpa}-${pick(IFSC)}-${ref}-${remark}`,
      ref: String(ref),
      withdrawal: 0,
      deposit: amount,
      balance: null,
    });
  };

  for (let i = 0; i < 38; i++) {
    const name = `${FIRST[i % FIRST.length]} ${pick(LAST)}`.toUpperCase();
    const vpa = `${name.split(" ")[0].toLowerCase()}${Math.floor(rand() * 900 + 100)}@${pick(BANKS)}`;
    const [amount, months] = pick([[4000, 1], [4000, 1], [6000, 1], [11000, 3], [20000, 6], [36000, 12]] as const);
    let date = addDays(start, Math.floor(rand() * 330));
    const churnAfter = rand() < 0.35 ? Math.floor(rand() * 4) + 1 : 99;
    for (let n = 0; n < churnAfter && date <= end; n++) {
      credit(date, name, vpa, amount, n === 0 ? "JOINING FEE" : "UPI");
      date = addDays(date, Math.round(months * 30.4) + Math.floor(rand() * 9) - 4);
    }
    if (rand() < 0.2) credit(addDays(start, Math.floor(rand() * 360)), name, vpa, 1500, "BJJ SHORTS");
  }
  for (let i = 0; i < 14; i++) {
    credit(addDays(start, Math.floor(rand() * 364)), `${pick(FIRST)} ${pick(LAST)}`.toUpperCase(), `guest${i}@ybl`, 500, "DROP IN CLASS");
  }
  for (let m = 3; m <= 12; m += 3) {
    txns.push({ id: `interest-${m}`, date: addDays(start, m * 30), narration: "INTEREST PAID TILL QUARTER END", ref: "", withdrawal: 0, deposit: 2100, balance: null });
  }

  txns.sort((a, b) => a.date.localeCompare(b.date));
  return {
    txns: txns.filter((t) => t.date <= end),
    sources: [{ fileName: "Demo data", accountHolder: "DEMO OWNER", from: start, to: end, rows: txns.length }],
    accountHolder: "DEMO OWNER",
  };
}
