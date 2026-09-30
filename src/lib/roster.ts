import { normaliseName } from "./classify";
import type { Member, Payment, RosterEntry } from "./types";

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
  /** For people with no membership match: drop-in, merch or other payments they made. */
  otherPayments: Payment[];
  /** Why a match needs checking, when it does. */
  note?: string;
}

export function cleanPhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

const letters = (s: string) => normaliseName(s).replace(/[^A-Z]/g, "");
const tokens = (s: string) => normaliseName(s).split(" ").filter((t) => /[A-Z]/.test(t));

function tokenMatches(a: string, b: string): boolean {
  if (a === b) return true;
  // Statement names are truncated ("VENKAT" for "VENKATESH"); allow prefixes of 4+ letters.
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
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
  let best = rosterLetters.length >= 6 && member.vpas.some((v) => letters(v.split("@")[0]) === rosterLetters) ? 92 : 0;

  const candidates = [member.name, ...member.payments.map((p) => p.payer?.name ?? "")].filter(Boolean);
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
      pool.some((p) => tokenMatches(t, p)) || (t.length >= 6 && letters(name).includes(t));
    const rosterHits = rt.filter((t) => hit(t, mt)).length;
    const memberHits = mt.filter((t) => t.length > 1 && (rt.some((r) => tokenMatches(t, r)) || (t.length >= 6 && a.includes(t)))).length;
    const memberSig = mt.filter((t) => t.length > 1).length || 1;
    // The list's first name should be the payer's first name (initials like "R" skipped).
    const firstHit = tokenMatches(rt[0], mt.find((t) => t.length > 1) ?? "") ? 1 : 0;
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
export function matchRoster(roster: RosterEntry[], members: Member[], payments: Payment[] = []): RosterMatch[] {
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
    results.set(entry.id, {
      entry,
      member,
      paidBy,
      score: member ? 100 : 0,
      confidence: member ? "manual" : "none",
      candidates,
      otherPayments: [],
    });
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
      otherPayments: [],
    });
  }

  // A match resting on a first name that several people on the list share needs a human check.
  const firstNames = roster.map((e) => tokens(e.name)[0] ?? "");
  const sameFirstName = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 5 && tokenMatches(a, b));
  for (const r of results.values()) {
    // Only single-name entries ("Anil") rest on the first name alone.
    if (!r.member || r.confidence === "manual" || r.paidBy || tokens(r.entry.name).length > 1) continue;
    const first = tokens(r.entry.name)[0] ?? "";
    const namesakes = firstNames.filter((f) => sameFirstName(f, first)).length;
    if (namesakes > 1) {
      r.confidence = "possible";
      r.note = `${namesakes} people on your list are called ${first[0]}${first.slice(1).toLowerCase()}`;
    }
  }

  // Payers who never paid a membership fee (drop-ins, merch), grouped per payer.
  const nonMembers = new Map<string, Payment[]>();
  for (const p of payments) {
    if (p.memberId || !p.payer || !["dropin", "merch", "other"].includes(p.category)) continue;
    const key = p.payer.vpa ?? p.payer.name;
    nonMembers.set(key, [...(nonMembers.get(key) ?? []), p]);
  }
  const otherPaymentsFor = (entry: RosterEntry): Payment[] => {
    for (const list of nonMembers.values()) {
      const pseudo = { name: list[0].payer!.name, vpas: list[0].payer!.vpa ? [list[0].payer!.vpa] : [], payments: list } as Member;
      if (nameScore(entry, pseudo) >= 75) return list;
    }
    return [];
  };

  return scored.map(({ entry, candidates }) => {
    const r = results.get(entry.id);
    if (r) return { ...r, otherPayments: [] };
    return {
      entry,
      member: null,
      paidBy: false,
      score: 0,
      confidence: "none" as const,
      candidates,
      otherPayments: otherPaymentsFor(entry),
    };
  });
}

const MONTH = "jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december";
/** Gym names, places and other notes people add to contact names. Lower case. */
const NOTE_WORDS = ["kia kaha", "grapplers inc", "ijj", "takeoff", "wcp", "judo", "mentalist", "entrepreneur", "mumbai", "erode", "bangalore", "bengaluru"];

/**
 * Splits a contact-list label into the person's name and tags, e.g.
 * "Nikhil Pooja Friend" → Nikhil + "Friend of Pooja", "Aditya 14yr Old" → Aditya + "Age 14",
 * "Karan Enquiry April 2026" → Karan + "Enquiry", "April 2026".
 */
export function parseContactLabel(label: string): { name: string; tags: string[] } {
  const tags: string[] = [];
  let rest = ` ${label.replace(/\s+/g, " ").trim()} `;
  const take = (re: RegExp, tag: (m: RegExpMatchArray) => string | null) => {
    const m = rest.match(re);
    if (!m) return;
    const t = tag(m);
    if (t && !tags.includes(t)) tags.push(t);
    rest = rest.replace(m[0], " ").replace(/\s+/g, " ");
  };
  const title = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

  take(/\(([^)]*)\)/, (m) => (m[1].trim() ? `aka ${m[1].trim()}` : null));
  take(/ flamingo( jiu ?jitsu)?(?= )/i, () => null);
  take(/ enquiry( call)?(?= )/i, () => "Enquiry");
  take(/ trial(?= )/i, () => "Trial");
  take(/ (\d{1,2}) ?(?:yrs?|yo|y0|y)( old)?(?= )/i, (m) => `Age ${m[1]}`);
  take(/ (\S+) friend(?= )/i, (m) => `Friend of ${title(m[1])}`);
  take(/ morning(?= )/i, () => "Morning batch");
  // A month (optionally with a year or day), but never as the first word of the name.
  take(new RegExp(`(?<=\\S) (${MONTH})( \\d{1,4})?(?= )`, "i"), (m) => title(m[1]) + (m[2] ?? ""));
  for (const note of NOTE_WORDS) take(new RegExp(`(?<=\\S) ${note}(?= )`, "i"), (m) => m[0].trim());
  take(/(?<=\S) new(?= )/i, () => "New");
  rest = rest.replace(/(?<=\S) \d{1,2}(?= )/g, " "); // stray numbers like "Karan 2"

  const name = rest.replace(/\s+/g, " ").trim();
  return name ? { name, tags } : { name: label.trim(), tags };
}

/**
 * Parses pasted text: one person per line, optionally with a phone number anywhere on the line.
 * Bullets, list numbering and single-letter section headers ("A", "B") are ignored.
 */
export function parseRosterText(text: string, source: string): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const phoneMatch = line.match(/(?:\+?91[\s-]?)?\d[\d\s-]{8,}\d/);
    const phone = cleanPhone(phoneMatch?.[0]);
    const label = line
      .replace(phoneMatch?.[0] ?? "", " ")
      .replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, "") // bullets and list numbering
      .replace(/[,;\t|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!/[a-z]{2}/i.test(label)) continue;
    const { name, tags } = parseContactLabel(label);
    out.push({
      id: rosterId(label, phone),
      name,
      ...(label !== name ? { label } : {}),
      ...(tags.length ? { tags } : {}),
      phone,
      source,
    });
  }
  return out;
}

/** Stable id from the original label, so two different "Karan …" contacts stay separate. */
export function rosterId(label: string, phone: string | null): string {
  return phone ? `p:${phone}` : `n:${letters(label)}`;
}

/** Adds entries, skipping ones already on the roster (same phone, or same label). */
export function mergeRoster(existing: RosterEntry[], incoming: RosterEntry[]): { roster: RosterEntry[]; added: number } {
  const ids = new Set(existing.map((e) => e.id));
  const fresh: RosterEntry[] = [];
  for (const e of incoming) {
    if (ids.has(e.id)) continue;
    ids.add(e.id);
    fresh.push(e);
  }
  return { roster: [...existing, ...fresh], added: fresh.length };
}
