import { extractPayer, classify, isMaskedName } from "./classify";
import { addDays, addMonths, diffDays, monthKey, monthRange } from "./dates";
import { titleCase } from "./format";
import { planFor } from "./settings";
import { REVENUE_CATEGORIES, type Category, type Dataset, type Member, type Payment, type Settings } from "./types";

/** Strips app-added suffixes so "neha525-1@okhdfcbank" and "neha525@okaxis" match. */
function vpaKey(vpa: string): string {
  return "vpa:" + vpa.split("@")[0].replace(/-\d+$/, "");
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    const p = this.parent.get(x)!;
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

export interface Analysis {
  payments: Payment[];
  members: Member[];
  asOf: string;
  dataFrom: string | null;
  dataTo: string | null;
}

/** Classifies every credit, groups payers into members and works out membership coverage. */
export function analyse(data: Dataset, settings: Settings, asOf: string): Analysis {
  const payments: Payment[] = data.txns
    .filter((t) => t.deposit > 0)
    .map((t) => ({
      txnId: t.id,
      date: t.date,
      amount: t.deposit,
      category: classify(t, settings, data.accountHolder),
      payer: extractPayer(t.narration),
      memberId: null,
    }));

  // Identify people: the same person may pay from several UPI ids or under slightly different names.
  const uf = new UnionFind();
  const keysOf = (p: Payment): string[] => {
    if (!p.payer) return [];
    const keys: string[] = [];
    if (p.payer.vpa) keys.push(vpaKey(p.payer.vpa));
    if (p.payer.name && !isMaskedName(p.payer.name)) keys.push("name:" + p.payer.name);
    return keys;
  };
  const people = payments.filter((p) => p.payer && ["membership", "dropin", "merch"].includes(p.category));
  for (const p of people) {
    const keys = keysOf(p);
    for (const k of keys.slice(1)) uf.union(keys[0], k);
  }

  const groups = new Map<string, Payment[]>();
  for (const p of people) {
    const keys = keysOf(p);
    if (!keys.length) continue;
    const root = uf.find(keys[0]);
    p.memberId = root;
    groups.set(root, [...(groups.get(root) ?? []), p]);
  }

  const members: Member[] = [];
  for (const [id, list] of groups) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    const fees = list.filter((p) => p.category === "membership");
    if (!fees.length) {
      for (const p of list) p.memberId = null; // walk-in / shop customer, not a member
      continue;
    }

    let expiry: string | null = null;
    for (const p of fees) {
      const plan = planFor(p.amount, settings);
      // Paying early or shortly after expiry extends the existing membership; otherwise it restarts.
      const continues = expiry && diffDays(p.date, expiry) <= settings.renewalGraceDays;
      const from = continues ? addDays(expiry!, 1) : p.date;
      p.coverFrom = from;
      p.coverTo = addDays(addMonths(from, plan.months), -1);
      p.planLabel = plan.label;
      expiry = p.coverTo;
    }

    const names = list.map((p) => p.payer!.name).filter((n) => !isMaskedName(n));
    const commonest = names.sort(
      (a, b) => names.filter((n) => n === b).length - names.filter((n) => n === a).length,
    )[0];
    const daysLeft = expiry ? diffDays(expiry, asOf) : null;
    const status =
      daysLeft !== null && daysLeft >= 0 ? "active" : daysLeft !== null && -daysLeft <= settings.dueWindowDays ? "due" : "lapsed";

    members.push({
      id,
      name: settings.memberNames[id] ?? titleCase(commonest ?? list[0].payer!.name),
      vpas: [...new Set(list.map((p) => p.payer!.vpa).filter((v): v is string => !!v))],
      payments: list,
      totalPaid: list.reduce((s, p) => s + p.amount, 0),
      membershipPaid: fees.reduce((s, p) => s + p.amount, 0),
      firstPaid: list[0].date,
      lastPaid: list[list.length - 1].date,
      expiry,
      status,
      daysLeft,
      currentPlan: fees[fees.length - 1].planLabel ?? null,
    });
  }
  members.sort((a, b) => a.name.localeCompare(b.name));

  const dates = data.txns.map((t) => t.date).sort();
  return { payments, members, asOf, dataFrom: dates[0] ?? null, dataTo: dates[dates.length - 1] ?? null };
}

export function renewingSoon(members: Member[], days: number): Member[] {
  return members
    .filter((m) => m.daysLeft !== null && m.daysLeft >= 0 && m.daysLeft <= days)
    .sort((a, b) => a.daysLeft! - b.daysLeft!);
}

export function dueForRenewal(members: Member[]): Member[] {
  return members.filter((m) => m.status === "due").sort((a, b) => b.daysLeft! - a.daysLeft!);
}

export function activeMembers(members: Member[]): Member[] {
  return members.filter((m) => m.status === "active").sort((a, b) => a.daysLeft! - b.daysLeft!);
}

export interface MonthRow {
  month: string;
  byCategory: Record<Category, number>;
  revenue: number;
  newMembers: number;
  activeAtMonthEnd: number;
}

/** Month-wise revenue split by category, plus member counts. */
export function monthly(analysis: Analysis): MonthRow[] {
  const { payments, members, dataFrom, dataTo } = analysis;
  if (!dataFrom || !dataTo) return [];
  const rows = new Map<string, MonthRow>();
  for (const month of monthRange(dataFrom, dataTo)) {
    rows.set(month, {
      month,
      byCategory: Object.fromEntries(
        (["membership", "dropin", "merch", "other", "refund", "interest", "investment", "owner", "expense"] as Category[]).map((c) => [c, 0]),
      ) as Record<Category, number>,
      revenue: 0,
      newMembers: 0,
      activeAtMonthEnd: 0,
    });
  }
  for (const p of payments) {
    const row = rows.get(monthKey(p.date));
    if (!row) continue;
    row.byCategory[p.category] += p.amount;
    if (REVENUE_CATEGORIES.includes(p.category)) row.revenue += p.amount;
  }
  for (const m of members) {
    const firstFee = m.payments.find((p) => p.category === "membership");
    if (firstFee) {
      const row = rows.get(monthKey(firstFee.date));
      if (row) row.newMembers++;
    }
  }
  for (const row of rows.values()) {
    // The current month is counted up to the as-of date rather than its (future) last day.
    const monthEnd = addDays(addMonths(row.month + "-01", 1), -1);
    const end = monthEnd < analysis.asOf ? monthEnd : analysis.asOf;
    row.activeAtMonthEnd = members.filter((m) =>
      m.payments.some((p) => p.coverFrom && p.coverFrom <= end && p.coverTo! >= end),
    ).length;
  }
  return [...rows.values()];
}
