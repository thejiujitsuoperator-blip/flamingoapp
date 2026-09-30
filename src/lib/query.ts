import { addDays, addMonths, formatDate, formatMonth, monthKey } from "./dates";
import { money } from "./format";
import { activeMembers, dueForRenewal, monthly, renewingSoon, type Analysis } from "./members";
import { CATEGORY_LABELS, REVENUE_CATEGORIES, type Category, type Member, type Payment } from "./types";

export interface QueryTable {
  columns: string[];
  rows: (string | number)[][];
}

export interface QueryResult {
  answer: string;
  table?: QueryTable | null;
  /** Member ids the answer is about, so the UI can link to their profiles. */
  memberIds?: string[];
  engine: "local" | "claude";
}

interface Range {
  from: string;
  to: string;
  label: string;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s*'?(\d{2,4}))?\b/g;
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fourteen: 14, fifteen: 15, thirty: 30,
};

function num(s: string | undefined): number | null {
  if (!s) return null;
  if (NUMBER_WORDS[s]) return NUMBER_WORDS[s];
  const n = Number(s.replace(/[,₹]/g, "").replace(/k$/, "000"));
  return Number.isFinite(n) ? n : null;
}

function monthBounds(year: number, monthIdx: number): Range {
  const from = `${year}-${String(monthIdx + 1).padStart(2, "0")}-01`;
  return { from, to: addDays(addMonths(from, 1), -1), label: formatMonth(from.slice(0, 7)) };
}

/** Finds a date range in the question: "jan 2026", "march", "last 3 months", "in 2025", "this month". */
export function parseRange(q: string, a: Analysis): Range | null {
  const ref = a.asOf;
  const refYear = Number(ref.slice(0, 4));

  const lastN = q.match(/\b(?:last|past|previous)\s+(\w+)\s+(day|week|month)s?\b/);
  if (lastN) {
    const n = num(lastN[1]) ?? 1;
    const from =
      lastN[2] === "month" ? addMonths(ref, -n) : addDays(ref, -(lastN[2] === "week" ? n * 7 : n));
    return { from: addDays(from, 1), to: ref, label: `the last ${n} ${lastN[2]}${n > 1 ? "s" : ""}` };
  }
  if (/\bthis month\b/.test(q)) {
    const r = monthBounds(refYear, Number(ref.slice(5, 7)) - 1);
    return { ...r, to: ref };
  }
  if (/\blast month\b/.test(q)) {
    const d = addMonths(ref.slice(0, 7) + "-01", -1);
    return monthBounds(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1);
  }

  const months = [...q.matchAll(MONTH_RE)].filter((m) => !(m[1] === "may" && /\bmay (i|we|you)\b/.test(q)));
  if (months.length) {
    const toRange = (m: RegExpMatchArray): Range => {
      const idx = MONTHS.indexOf(m[1]);
      let year = m[2] ? Number(m[2].length === 2 ? "20" + m[2] : m[2]) : refYear;
      // Without a year, pick the most recent such month on or before the as-of date.
      if (!m[2] && `${year}-${String(idx + 1).padStart(2, "0")}` > ref.slice(0, 7)) year--;
      return monthBounds(year, idx);
    };
    const first = toRange(months[0]);
    if (months.length > 1 && /\b(to|through|till|until|and|-)\b/.test(q)) {
      const last = toRange(months[months.length - 1]);
      return { from: first.from, to: last.to, label: `${first.label} – ${last.label}` };
    }
    return first;
  }

  const year = q.match(/\b(20\d{2})\b/);
  if (year) return { from: `${year[1]}-01-01`, to: `${year[1]}-12-31`, label: year[1] };
  const fy = q.match(/\bfy\s*'?(\d{2})(?:\s*-\s*'?(\d{2}))?\b/);
  if (fy) {
    const start = 2000 + Number(fy[1]);
    return { from: `${start}-04-01`, to: `${start + 1}-03-31`, label: `FY ${start}–${String(start + 1).slice(2)}` };
  }
  return null;
}

const inRange = (p: { date: string }, r: Range | null) => !r || (p.date >= r.from && p.date <= r.to);

function findMember(q: string, members: Member[]): Member | null {
  const words = q.replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  let best: { m: Member; score: number } | null = null;
  for (const m of members) {
    const nameWords = m.name.toLowerCase().split(/\s+/);
    const full = m.name.toLowerCase();
    let score = q.includes(full) ? 10 : 0;
    for (const w of words) if (nameWords.includes(w)) score += w.length > 3 ? 2 : 1;
    if (score > (best?.score ?? 0)) best = { m, score };
  }
  return best && best.score >= 2 ? best.m : null;
}

function memberRows(list: Member[]): QueryTable {
  return {
    columns: ["Member", "Plan", "Expiry", "Days left", "Total paid"],
    rows: list.map((m) => [m.name, m.currentPlan ?? "—", formatDate(m.expiry), m.daysLeft ?? "—", money(m.totalPaid)]),
  };
}

function paymentRows(list: Payment[], members: Member[]): QueryTable {
  const byId = new Map(members.map((m) => [m.id, m]));
  return {
    columns: ["Date", "Paid by", "Category", "Amount", "Note"],
    rows: list.map((p) => [
      formatDate(p.date),
      (p.memberId && byId.get(p.memberId)?.name) || p.payer?.name || "—",
      CATEGORY_LABELS[p.category],
      money(p.amount),
      p.payer?.remark ?? "",
    ]),
  };
}

function categoryFrom(q: string): Category[] {
  if (/drop.?in/.test(q)) return ["dropin"];
  if (/merch|shorts|gi\b|shop/.test(q)) return ["merch"];
  if (/membership|fee|subscription/.test(q)) return ["membership"];
  if (/interest/.test(q)) return ["interest"];
  if (/dividend|investment/.test(q)) return ["investment"];
  return REVENUE_CATEGORIES;
}

/**
 * Answers common questions without an AI model, using keyword and pattern matching.
 * Returns null when the question isn't understood.
 */
export function localQuery(question: string, a: Analysis, renewSoonDays = 7): QueryResult | null {
  const q = question.toLowerCase().trim();
  const range = parseRange(q, a);
  const members = a.members;
  const result = (answer: string, table?: QueryTable, ids?: string[]): QueryResult => ({
    answer,
    table,
    memberIds: ids,
    engine: "local",
  });

  // Renewals in the next N days
  const soon = q.match(/(?:next|coming|within|in)\s+(\w+)\s+(day|week)s?/);
  if (/renew|expir|due/.test(q) && (soon || /this week|soon|upcoming/.test(q))) {
    const n = soon ? (num(soon[1]) ?? renewSoonDays) * (soon[2] === "week" ? 7 : 1) : /this week/.test(q) ? 7 : renewSoonDays;
    const list = renewingSoon(members, n);
    return result(
      list.length
        ? `${list.length} member${list.length > 1 ? "s" : ""} renew in the next ${n} days (as of ${formatDate(a.asOf)}).`
        : `No memberships expire in the next ${n} days (as of ${formatDate(a.asOf)}).`,
      memberRows(list),
      list.map((m) => m.id),
    );
  }
  if (/overdue|due for renewal|\bdue\b|expired|not renewed|pending renewal/.test(q)) {
    const list = dueForRenewal(members);
    return result(
      `${list.length} member${list.length === 1 ? " is" : "s are"} due for renewal — their membership has expired within the last grace window and they haven't paid again.`,
      memberRows(list),
      list.map((m) => m.id),
    );
  }
  if (/lapsed|inactive|churn|left|stopped/.test(q)) {
    const list = members.filter((m) => m.status === "lapsed");
    return result(`${list.length} former members have lapsed (expired and past the due window).`, memberRows(list), list.map((m) => m.id));
  }
  if (/new (member|join|sign)|joined|signed up/.test(q)) {
    const list = members.filter((m) => {
      const first = m.payments.find((p) => p.category === "membership");
      return first && inRange(first, range);
    });
    return result(
      `${list.length} new member${list.length === 1 ? "" : "s"} joined${range ? ` in ${range.label}` : ""}.`,
      { columns: ["Member", "Joined", "First payment"], rows: list.map((m) => {
        const f = m.payments.find((p) => p.category === "membership")!;
        return [m.name, formatDate(f.date), money(f.amount)];
      }) },
      list.map((m) => m.id),
    );
  }
  if (/\bactive\b|current members|how many members/.test(q)) {
    const list = activeMembers(members);
    return result(`${list.length} active member${list.length === 1 ? "" : "s"} as of ${formatDate(a.asOf)}.`, memberRows(list), list.map((m) => m.id));
  }

  // Top payers
  const top = q.match(/\btop\s+(\w+)/);
  if (top || /highest|most|biggest|best/.test(q)) {
    const n = (top && num(top[1])) || 5;
    const totals = members
      .map((m) => ({ m, total: m.payments.filter((p) => inRange(p, range)).reduce((s, p) => s + p.amount, 0) }))
      .filter((x) => x.total > 0)
      .sort((x, y) => y.total - x.total)
      .slice(0, n);
    return result(
      `Top ${totals.length} members by amount paid${range ? ` in ${range.label}` : ""}.`,
      { columns: ["Member", "Paid", "Status"], rows: totals.map(({ m, total }) => [m.name, money(total), m.status]) },
      totals.map((x) => x.m.id),
    );
  }

  // A specific member
  const member = findMember(q, members);
  if (member) {
    const pays = member.payments.filter((p) => inRange(p, range));
    const statusText =
      member.status === "active"
        ? `active until ${formatDate(member.expiry)} (${member.daysLeft} days left)`
        : `${member.status === "due" ? "due for renewal" : "lapsed"} — expired ${formatDate(member.expiry)}`;
    return result(
      `${member.name} has paid ${money(pays.reduce((s, p) => s + p.amount, 0))} across ${pays.length} payment${pays.length === 1 ? "" : "s"}${range ? ` in ${range.label}` : ""}. Membership is ${statusText}.`,
      paymentRows(pays, members),
      [member.id],
    );
  }

  // Revenue / totals
  const byMonth = /month.?wise|by month|per month|monthly|each month|breakdown|split/.test(q);
  if (/revenue|income|earn|collect|made|total|sales|how much/.test(q) || byMonth) {
    const cats = categoryFrom(q);
    if (byMonth) {
      const rows = monthly(a).filter((r) => !range || (r.month >= monthKey(range.from) && r.month <= monthKey(range.to)));
      return result(
        `Month-wise ${cats.length === 1 ? CATEGORY_LABELS[cats[0]].toLowerCase() : "revenue"}${range ? ` for ${range.label}` : ""}.`,
        {
          columns: ["Month", ...cats.map((c) => CATEGORY_LABELS[c]), ...(cats.length > 1 ? ["Total"] : [])],
          rows: rows.map((r) => [
            formatMonth(r.month),
            ...cats.map((c) => money(r.byCategory[c])),
            ...(cats.length > 1 ? [money(cats.reduce((s, c) => s + r.byCategory[c], 0))] : []),
          ]),
        },
      );
    }
    const pays = a.payments.filter((p) => cats.includes(p.category) && inRange(p, range));
    const total = pays.reduce((s, p) => s + p.amount, 0);
    const split = cats
      .map((c) => [CATEGORY_LABELS[c], pays.filter((p) => p.category === c).reduce((s, p) => s + p.amount, 0)] as const)
      .filter(([, v]) => v > 0);
    return result(
      `${cats.length === 1 ? CATEGORY_LABELS[cats[0]] : "Revenue"}${range ? ` in ${range.label}` : " (all data)"}: ${money(total)} from ${pays.length} payment${pays.length === 1 ? "" : "s"}.`,
      split.length > 1 ? { columns: ["Category", "Amount"], rows: split.map(([k, v]) => [k, money(v)]) } : undefined,
    );
  }

  // Payment lists with optional amount filter
  const over = q.match(/(?:more than|over|above|greater than|>)\s*₹?\s*([\d,]+k?)/);
  const under = q.match(/(?:less than|under|below|<)\s*₹?\s*([\d,]+k?)/);
  if (/pay|paid|payment|transaction|who/.test(q) || over || under) {
    const cats = categoryFrom(q);
    const min = num(over?.[1]) ?? -Infinity;
    const max = num(under?.[1]) ?? Infinity;
    const pays = a.payments.filter((p) => cats.includes(p.category) && inRange(p, range) && p.amount > min && p.amount < max);
    return result(
      `${pays.length} payment${pays.length === 1 ? "" : "s"} totalling ${money(pays.reduce((s, p) => s + p.amount, 0))}${range ? ` in ${range.label}` : ""}.`,
      paymentRows(pays, members),
    );
  }

  if (/average|avg|mean/.test(q)) {
    const pays = a.payments.filter((p) => p.category === "membership" && inRange(p, range));
    const avg = pays.length ? pays.reduce((s, p) => s + p.amount, 0) / pays.length : 0;
    return result(`Average membership payment${range ? ` in ${range.label}` : ""}: ${money(avg)} over ${pays.length} payments.`);
  }

  return null;
}

export const EXAMPLE_QUESTIONS = [
  "Who is up for renewal in the next 7 days?",
  "Revenue in January 2026",
  "Month-wise revenue split",
  "Top 5 members",
  "New members in February",
  "Payments over 10000",
];
