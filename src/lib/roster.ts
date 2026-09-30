import { normaliseName } from "./classify";
import type { Member, RosterEntry } from "./types";

export type MatchConfidence = "manual" | "exact" | "likely" | "possible" | "none";

export interface RosterMatch {
  entry: RosterEntry;
  member: Member | null;
  /** Set when someone else pays for this person, found via the name in their UPI payment notes. */
  paidBy: boolean;
  score: number;
  confidence: MatchConfidence;
  /** Best candidates, for the manual picker. */
  candidates: { member: Member; score: number }[];
}

export function cleanPhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

const letters = (s: string) => normaliseName(s).replace(/[^A-Z]/g, "");
const tokens = (s: string) => normaliseName(s).split(" ").filter((t) => /[A-Z]/.test(t));

function tokenMatches(a: string, b: string): boolean {
  if (a === b) return true;
  // Statement names are truncated ("VENKAT" for "VENKATESH"); allow prefixes of 3+ letters.
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short);
}

/**
 * How strongly a roster person is named in a member's payment notes, e.g. a parent paying
 * with the note "ISHAAN" or a partner paying with "TARA MENON JIU".
 */
function remarkScore(entry: RosterEntry, member: Member): number {
  const rt = tokens(entry.name);
  if (!rt.length) return 0;
  let best = 0;
  for (const p of member.payments) {
    const remark = tokens(p.payer?.remark ?? "");
    if (!remark.length) continue;
    const found = rt.filter((t) => t.length >= 3 && remark.some((r) => tokenMatches(t, r)));
    if (!found.length || !tokenMatches(rt[0], remark.find((r) => tokenMatches(rt[0], r)) ?? "")) continue;
    if (found.length === rt.length) best = Math.max(best, rt.length > 1 ? 90 : 70);
    else {
      // First name in the note and surname shared with the payer: likely family.
      const surname = rt[rt.length - 1];
      const familySurname = tokens(member.name).some((t) => tokenMatches(surname, t));
      best = Math.max(best, familySurname ? 80 : 55);
    }
  }
  return best;
}

/** 0–100 similarity between a roster name and a member (name + UPI ids). */
export function matchScore(entry: RosterEntry, member: Member): number {
  return Math.max(nameScore(entry, member), remarkScore(entry, member));
}

function nameScore(entry: RosterEntry, member: Member): number {
  if (entry.phone && member.vpas.some((v) => cleanPhone(v.split("@")[0]) === entry.phone)) return 100;
  // UPI ids are often just the name run together: "nehajoshi@okicici".
  const rosterLetters = letters(entry.name);
  if (rosterLetters.length >= 6 && member.vpas.some((v) => letters(v.split("@")[0]) === rosterLetters)) return 92;

  const candidates = [member.name, ...member.payments.map((p) => p.payer?.name ?? "")].filter(Boolean);
  let best = 0;
  for (const name of new Set(candidates)) {
    const a = letters(entry.name);
    const b = letters(name);
    if (!a || !b) continue;
    if (a === b) return 95; // same letters, e.g. "Rohan Desai" vs "ROHANDESAI"
    const shorter = Math.min(a.length, b.length);
    if (shorter >= 8 && (a.startsWith(b) || b.startsWith(a))) best = Math.max(best, 85);

    const rt = tokens(entry.name);
    const mt = tokens(name);
    if (!rt.length || !mt.length) continue;
    const hit = (t: string, pool: string[]) =>
      pool.some((p) => tokenMatches(t, p)) || (t.length >= 4 && letters(name).includes(t));
    const rosterHits = rt.filter((t) => hit(t, mt)).length;
    const memberHits = mt.filter((t) => t.length > 1 && (rt.some((r) => tokenMatches(t, r)) || (t.length >= 4 && a.includes(t)))).length;
    const memberSig = mt.filter((t) => t.length > 1).length || 1;
    const firstHit = hit(rt[0], mt) ? 1 : 0;
    let score = 50 * (rosterHits / rt.length) + 30 * (memberHits / memberSig) + 15 * firstHit;
    // Both have a surname and they differ ("Anita Bose" vs "Anita Rao"): different people.
    const sig = mt.filter((t) => t.length > 1);
    const last = rt[rt.length - 1];
    if (rt.length > 1 && sig.length > 1 && !hit(last, mt) && !rt.some((t) => tokenMatches(t, sig[sig.length - 1]))) {
      score = Math.min(score, 50);
    }
    best = Math.max(best, Math.round(score));
  }
  return Math.min(best, 94);
}

const confidenceFor = (score: number): MatchConfidence =>
  score >= 95 ? "exact" : score >= 75 ? "likely" : score >= 55 ? "possible" : "none";

/**
 * Pairs roster entries with statement members. Manual links win; the rest are assigned
 * greedily by score so that each member is matched to at most one roster entry.
 */
export function matchRoster(roster: RosterEntry[], members: Member[]): RosterMatch[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  const taken = new Set<string>();
  const results = new Map<string, RosterMatch>();

  const scored = roster.map((entry) => ({
    entry,
    candidates: members
      .map((member) => ({ member, score: matchScore(entry, member) }))
      .filter((c) => c.score >= 40)
      .sort((x, y) => y.score - x.score)
      .slice(0, 5),
  }));

  for (const { entry, candidates } of scored) {
    if (entry.linkedMemberId === undefined) continue;
    const member = entry.linkedMemberId ? (byId.get(entry.linkedMemberId) ?? null) : null;
    if (member) taken.add(member.id);
    const paidBy = !!member && remarkScore(entry, member) > nameScore(entry, member);
    results.set(entry.id, { entry, member, paidBy, score: member ? 100 : 0, confidence: member ? "manual" : "none", candidates });
  }

  const pairs = scored
    .filter(({ entry }) => entry.linkedMemberId === undefined)
    .flatMap(({ entry, candidates }) => candidates.map((c) => ({ entry, ...c })))
    .filter((p) => confidenceFor(p.score) !== "none")
    .sort((x, y) => y.score - x.score);
  for (const p of pairs) {
    // One payer can pay for several people, so "paid on behalf" matches don't use up the member.
    const paidBy = remarkScore(p.entry, p.member) > nameScore(p.entry, p.member);
    if (results.has(p.entry.id) || (!paidBy && taken.has(p.member.id))) continue;
    if (!paidBy) taken.add(p.member.id);
    results.set(p.entry.id, {
      entry: p.entry,
      member: p.member,
      paidBy,
      score: p.score,
      confidence: confidenceFor(p.score),
      candidates: scored.find((s) => s.entry.id === p.entry.id)!.candidates,
    });
  }

  return scored.map(
    ({ entry, candidates }) =>
      results.get(entry.id) ?? { entry, member: null, paidBy: false, score: 0, confidence: "none" as const, candidates },
  );
}

/** Parses pasted text: one person per line, optionally with a phone number anywhere on the line. */
export function parseRosterText(text: string, source: string): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const phoneMatch = line.match(/(?:\+?91[\s-]?)?\d[\d\s-]{8,}\d/);
    const phone = cleanPhone(phoneMatch?.[0]);
    const name = line
      .replace(phoneMatch?.[0] ?? "", " ")
      .replace(/^\s*\d+[.)]\s*/, "") // list numbering
      .replace(/[,;\t|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!/[a-z]{2}/i.test(name)) continue;
    out.push({ id: rosterId(name, phone), name, phone, source });
  }
  return out;
}

export function rosterId(name: string, phone: string | null): string {
  return phone ? `p:${phone}` : `n:${letters(name)}`;
}

/** Adds entries, skipping people already on the roster (same phone, or same name). */
export function mergeRoster(existing: RosterEntry[], incoming: RosterEntry[]): { roster: RosterEntry[]; added: number } {
  const ids = new Set(existing.map((e) => e.id));
  const names = new Set(existing.map((e) => letters(e.name)));
  const fresh: RosterEntry[] = [];
  for (const e of incoming) {
    if (ids.has(e.id) || names.has(letters(e.name))) continue;
    ids.add(e.id);
    names.add(letters(e.name));
    fresh.push(e);
  }
  return { roster: [...existing, ...fresh], added: fresh.length };
}
