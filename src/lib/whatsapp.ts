/**
 * Reads a WhatsApp group's "Export chat" file (and, optionally, a phone contacts export) and lists the people in
 * the group with their phone numbers.
 *
 * WhatsApp names people in an export the way they're saved in the exporting phone's contacts; people who aren't
 * saved appear as their phone number. So the numbers of saved contacts come from the contacts file (.vcf), matched
 * by name. Everything here runs in the browser; nothing is uploaded.
 */

import { formatDate } from "./dates";

export type GroupStatus = "member" | "left" | "removed";

export interface GroupPerson {
  /** The name WhatsApp showed (the saved contact name), or the contact name found for a number. */
  name: string | null;
  /** International format with a leading "+", e.g. "+919800000001". */
  phone: string | null;
  /** Where the phone number came from. */
  phoneFrom: "chat" | "contacts" | null;
  status: GroupStatus;
  messages: number;
  /** ISO dates. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** What the chat says about this person, e.g. "added by Rohan Desai", "joined via invite link". */
  notes: string[];
  /** Why no number could be found, or why it needs checking. */
  warning?: string;
}

export interface GroupExtract {
  groupName: string | null;
  people: GroupPerson[];
  /** Lines of the chat that were read as messages or group events. */
  linesRead: number;
  dateRange: { from: string; to: string } | null;
}

export interface Contact {
  name: string;
  phones: string[];
}

// Direction marks and isolates WhatsApp wraps around names and numbers.
const INVISIBLE = /[‎‏‪-‮⁦-⁩﻿]/g;
const clean = (s: string) => s.replace(INVISIBLE, "").replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();

/** Lower case, letters and digits only, for matching names across the chat and contacts. */
export const nameKey = (s: string) =>
  clean(s)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** A string that is just a phone number ("+91 98000 00001", "‪+1 (415) 555‑0100‬"). */
export function isPhone(s: string): boolean {
  const t = clean(s).replace(/[‐-―]/g, "-");
  return /^\+?[\d\s\-().]+$/.test(t) && t.replace(/\D/g, "").length >= 8;
}

/**
 * Puts a number in international format. Numbers without a country code are taken to be in `defaultCountry`
 * (dialling code, default India).
 */
export function normalisePhone(raw: string, defaultCountry = "91"): string | null {
  const t = clean(raw);
  let digits = t.replace(/\D/g, "");
  if (digits.length < 8) return null;
  if (t.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) return `+${defaultCountry}${digits}`;
  return `+${digits}`;
}

/** "+919800000001" → "+91 98000 00001"; other countries are left as they are. */
export function formatPhone(e164: string): string {
  const m = e164.match(/^\+91(\d{5})(\d{5})$/);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}

// ---------------------------------------------------------------------------------------------------------------
// Chat export

const DATE = String.raw`(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})`;
const TIME = String.raw`\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:\s?[apAP]\.?\s?[mM]\.?)?`;
// Android: "12/03/2026, 9:41 pm - Meera: Hi"     iOS: "[12/03/26, 9:41:07 PM] Meera: Hi"
const ANDROID_LINE = new RegExp(String.raw`^${DATE},?\s+${TIME}\s+[-–]\s+(.*)$`);
const IOS_LINE = new RegExp(String.raw`^\[${DATE},?\s+${TIME}\]\s+(.*)$`);

interface RawLine {
  d: [number, number, number];
  rest: string;
  /** iOS puts a direction mark before system messages and media. */
  marked: boolean;
}

function splitLines(text: string): RawLine[] {
  const out: RawLine[] = [];
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const marked = line.includes("‎");
    const l = line.replace(INVISIBLE, "").replace(/[  ]/g, " ");
    const m = l.match(IOS_LINE) ?? l.match(ANDROID_LINE);
    if (!m) continue; // continuation of a multi-line message
    out.push({ d: [Number(m[1]), Number(m[2]), Number(m[3])], rest: m[4], marked });
  }
  return out;
}

/** Works out whether dates are day-first or month-first from the whole file (day-first if it can't tell). */
function dateReader(lines: RawLine[]): (d: [number, number, number]) => string {
  const monthFirst = !lines.some((l) => l.d[0] > 12) && lines.some((l) => l.d[1] > 12);
  return ([a, b, y]) => {
    const [day, month] = monthFirst ? [b, a] : [a, b];
    const year = y < 100 ? 2000 + y : y;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };
}

// A name in a system message: anything without ": " (which would make it a "Sender: text" message).
const WHO = String.raw`((?:(?!: ).)+?)`;

type Event =
  | { kind: "in"; who: string[]; note: (actor: string) => string; actor?: string }
  | { kind: "left"; who: string[] }
  | { kind: "removed"; who: string[]; actor: string }
  | { kind: "renumber"; from: string; to: string }
  | { kind: "active"; who: string[] };

const SYSTEM: { re: RegExp; event: (m: RegExpMatchArray) => Event | null }[] = [
  { re: new RegExp(`^${WHO} joined using (?:this|a) (?:group|community)'s invite link$`), event: (m) => ({ kind: "in", who: [m[1]], note: () => "joined via invite link" }) },
  { re: new RegExp(`^${WHO} joined (?:from|via) (?:the|a) community$`), event: (m) => ({ kind: "in", who: [m[1]], note: () => "joined from the community" }) },
  { re: new RegExp(`^${WHO} joined$`), event: (m) => ({ kind: "in", who: [m[1]], note: () => "joined" }) },
  { re: new RegExp(`^${WHO}'s request to join was approved$`), event: (m) => ({ kind: "in", who: [m[1]], note: () => "join request approved" }) },
  { re: new RegExp(`^${WHO} added ${WHO}$`), event: (m) => ({ kind: "in", actor: m[1], who: splitNames(m[2]), note: (a) => `added by ${a}` }) },
  { re: new RegExp(`^${WHO} created (?:the )?group .*$`), event: (m) => ({ kind: "in", who: [m[1]], note: () => "created the group" }) },
  { re: new RegExp(`^${WHO} left$`), event: (m) => ({ kind: "left", who: [m[1]] }) },
  { re: new RegExp(`^${WHO} removed ${WHO}$`), event: (m) => ({ kind: "removed", actor: m[1], who: splitNames(m[2]) }) },
  { re: new RegExp(`^${WHO} changed to ${WHO}$`), event: (m) => (isPhone(m[1]) && isPhone(m[2]) ? { kind: "renumber", from: m[1], to: m[2] } : null) },
  {
    re: new RegExp(`^${WHO} (?:changed|deleted|pinned|turned|reset|updated|started|ended|shared|set) .*$`),
    event: (m) => ({ kind: "active", who: [m[1]] }),
  },
];

const NOT_PEOPLE = /^(?:messages and calls are end-to-end encrypted|this message was deleted|you deleted this message|waiting for this message|missed (?:voice|video) call)/i;

function splitNames(s: string): string[] {
  return s
    .split(/,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function systemEvent(text: string): Event | null {
  const t = clean(text);
  if (NOT_PEOPLE.test(t)) return { kind: "active", who: [] };
  for (const s of SYSTEM) {
    const m = t.match(s.re);
    if (m) return s.event(m);
  }
  return null;
}

/** "WhatsApp Chat with Flamingo BJJ.txt", "WhatsApp Chat - Flamingo BJJ.zip" → "Flamingo BJJ". */
export function groupNameFromFile(fileName: string): string | null {
  const m = fileName.match(/^WhatsApp Chat (?:with|-)\s*(.+?)(?:\s*\(\d+\))?\.(?:txt|zip)$/i);
  return m ? m[1].trim() : null;
}

const isSelf = (s: string) => /^(you|you were|you're)$/i.test(clean(s));

/** Reads a chat export (the .txt inside the .zip WhatsApp makes) into the people in the group. */
export function parseChatExport(text: string, opts: { groupName?: string | null; defaultCountry?: string } = {}): GroupExtract {
  const lines = splitLines(text);
  const toIso = dateReader(lines);
  const cc = opts.defaultCountry ?? "91";
  let groupName = opts.groupName ?? null;

  interface Rec extends GroupPerson {
    key: string;
    lastStatusAt: number;
  }
  const people = new Map<string, Rec>();
  const keyFor = (raw: string) => {
    const s = clean(raw).replace(/^~\s*/, "");
    return isPhone(s) ? `tel:${normalisePhone(s, cc)}` : `name:${nameKey(s)}`;
  };
  const person = (raw: string): Rec | null => {
    const s = clean(raw).replace(/^~\s*/, "");
    if (!s || isSelf(s) || /^you\b/i.test(s)) return null;
    if (groupName && nameKey(s) === nameKey(groupName)) return null;
    const key = keyFor(s);
    let p = people.get(key);
    if (!p) {
      const phone = isPhone(s) ? normalisePhone(s, cc) : null;
      p = { key, name: phone ? null : s, phone, phoneFrom: phone ? "chat" : null, status: "member", messages: 0, firstSeen: null, lastSeen: null, notes: [], lastStatusAt: -1 };
      people.set(key, p);
    }
    return p;
  };
  const seen = (p: Rec, date: string) => {
    if (!p.firstSeen || date < p.firstSeen) p.firstSeen = date;
    if (!p.lastSeen || date > p.lastSeen) p.lastSeen = date;
  };
  const setStatus = (p: Rec, status: GroupStatus, at: number) => {
    if (at >= p.lastStatusAt) {
      p.status = status;
      p.lastStatusAt = at;
    }
  };
  const note = (p: Rec, n: string) => {
    if (!p.notes.includes(n)) p.notes.push(n);
  };
  const display = (raw: string) => {
    const s = clean(raw).replace(/^~\s*/, "");
    return isSelf(s) ? "you" : isPhone(s) ? formatPhone(normalisePhone(s, cc) ?? s) : s;
  };

  // iOS writes group events as if the group sent them: "[…] Flamingo BJJ: ‎Rohan added Tara".
  if (!groupName) {
    for (const l of lines) {
      const m = l.rest.match(/^([^:]+): ‎?(.*)$/);
      const created = clean(l.rest).match(/created (?:the )?group ["“](.+)["”]$/) ?? clean(l.rest).match(/changed the (?:subject|group name) (?:from ["“].*["”] )?to ["“](.+)["”]$/);
      if (created) {
        groupName = created[1];
        break;
      }
      if (m && l.marked && systemEvent(m[2])) {
        groupName = clean(m[1]);
        break;
      }
    }
  }

  let first: string | null = null;
  let last: string | null = null;
  let read = 0;
  lines.forEach((l, i) => {
    const date = toIso(l.d);
    // A "Sender: text" message, unless it is an iOS system message (marked, and the text is a group event).
    const msg = l.rest.match(/^((?:(?!: ).)+?): (.*)$/);
    let event: Event | null = null;
    let sender: string | null = null;
    if (msg && l.marked && systemEvent(msg[2])) {
      event = systemEvent(msg[2]);
    } else if (msg && !systemEvent(l.rest)) {
      sender = msg[1];
    } else {
      event = systemEvent(l.rest);
      if (!event && msg) sender = msg[1];
    }
    if (!event && !sender) return;
    read++;
    first ??= date;
    last = date;

    if (sender) {
      const p = person(sender);
      if (p) {
        p.messages++;
        seen(p, date);
        if (p.status !== "member") setStatus(p, "member", i); // still posting, so back in the group
      }
      return;
    }
    if (!event) return;
    switch (event.kind) {
      case "in":
        for (const w of event.who) {
          const p = person(w);
          if (!p) continue;
          seen(p, date);
          setStatus(p, "member", i);
          note(p, event.note(event.actor ? display(event.actor) : ""));
        }
        if (event.actor) {
          const a = person(event.actor);
          if (a) seen(a, date);
        }
        break;
      case "left":
        for (const w of event.who) {
          const p = person(w);
          if (!p) continue;
          seen(p, date);
          setStatus(p, "left", i);
          note(p, `left on ${formatDate(date)}`);
        }
        break;
      case "removed":
        for (const w of event.who) {
          const p = person(w);
          if (!p) continue;
          seen(p, date);
          setStatus(p, "removed", i);
          note(p, `removed by ${display(event.actor)} on ${formatDate(date)}`);
        }
        break;
      case "renumber": {
        const old = person(event.from);
        const now = person(event.to);
        if (old && now) {
          seen(now, date);
          setStatus(old, "left", i);
          note(old, `changed number to ${display(event.to)}`);
          note(now, `new number for ${display(event.from)}`);
          setStatus(now, "member", i);
        }
        break;
      }
      case "active":
        for (const w of event.who) {
          const p = person(w);
          if (p) seen(p, date);
        }
        break;
    }
  });

  const list = [...people.values()].map(({ key: _k, lastStatusAt: _s, ...p }) => p);
  return { groupName, people: sortPeople(list), linesRead: read, dateRange: first && last ? { from: first, to: last } : null };
}

function sortPeople(list: GroupPerson[]): GroupPerson[] {
  const order: Record<GroupStatus, number> = { member: 0, left: 1, removed: 2 };
  return list.sort(
    (a, b) => order[a.status] - order[b.status] || (a.name ?? "￿").localeCompare(b.name ?? "￿") || (a.phone ?? "").localeCompare(b.phone ?? ""),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Contacts (.vcf from Google Contacts, iPhone or Android)

function decodeQuotedPrintable(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-F]{2}$/i.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...new TextEncoder().encode(s[i]));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const unescapeVcf = (s: string) => s.replace(/\\([,;\\])/g, "$1").replace(/\\n/gi, " ");

export function parseVcf(text: string, defaultCountry = "91"): Contact[] {
  // Unfold continuation lines, including quoted-printable soft line breaks.
  const raw = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const lines: string[] = [];
  for (const line of raw.split("\n")) {
    const prev = lines[lines.length - 1];
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] = prev + line.slice(1);
    else if (prev !== undefined && /ENCODING=QUOTED-PRINTABLE/i.test(prev.split(":")[0]) && prev.endsWith("=")) lines[lines.length - 1] = prev.slice(0, -1) + line;
    else lines.push(line);
  }

  const contacts: Contact[] = [];
  let fn: string | null = null;
  let n: string | null = null;
  let org: string | null = null;
  let phones: { phone: string; mobile: boolean }[] = [];
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const params = head.split(";");
    const prop = params[0].replace(/^item\d+\./i, "").toUpperCase();
    let value = line.slice(colon + 1);
    if (/ENCODING=QUOTED-PRINTABLE/i.test(head)) value = decodeQuotedPrintable(value);
    value = unescapeVcf(value).trim();

    if (prop === "BEGIN") {
      fn = n = org = null;
      phones = [];
    } else if (prop === "FN") fn = value;
    else if (prop === "N") {
      const [family = "", given = "", middle = "", prefix = "", suffix = ""] = line.slice(colon + 1).split(/(?<!\\);/).map((x) => unescapeVcf(/ENCODING=QUOTED-PRINTABLE/i.test(head) ? decodeQuotedPrintable(x) : x).trim());
      n = [prefix, given, middle, family, suffix].filter(Boolean).join(" ") || null;
    } else if (prop === "ORG") org = value.replace(/;+$/, "").replace(/;/g, " ") || null;
    else if (prop === "TEL") {
      const phone = normalisePhone(value.replace(/^tel:/i, ""), defaultCountry);
      if (phone && !phones.some((p) => p.phone === phone)) phones.push({ phone, mobile: /cell|mobile|iphone/i.test(head) });
    } else if (prop === "END") {
      const name = fn || n || org;
      if (name && phones.length) {
        // Mobile numbers first: they're the ones WhatsApp uses.
        contacts.push({ name, phones: [...phones.filter((p) => p.mobile), ...phones.filter((p) => !p.mobile)].map((p) => p.phone) });
      }
    }
  }
  return contacts;
}

/** Fills in numbers for people saved under a name, and names for people who showed up as a number. */
export function enrichWithContacts(extract: GroupExtract, contacts: Contact[]): GroupExtract {
  const byName = new Map<string, Contact[]>();
  const byPhone = new Map<string, Contact>();
  const last10 = (p: string) => p.replace(/\D/g, "").slice(-10);
  for (const c of contacts) {
    const k = nameKey(c.name);
    byName.set(k, [...(byName.get(k) ?? []), c]);
    for (const p of c.phones) {
      byPhone.set(p, c);
      if (!byPhone.has(`10:${last10(p)}`)) byPhone.set(`10:${last10(p)}`, c);
    }
  }

  const people = extract.people.map((p): GroupPerson => {
    const out: GroupPerson = { ...p, notes: [...p.notes], warning: undefined };
    if (!p.phone && p.name) {
      const found = byName.get(nameKey(p.name)) ?? [];
      if (found.length === 1) {
        out.phone = found[0].phones[0];
        out.phoneFrom = "contacts";
        if (found[0].phones.length > 1) out.warning = `Contact has ${found[0].phones.length} numbers; using the mobile one`;
      } else if (found.length > 1) out.warning = `${found.length} contacts are called "${p.name}"`;
      else out.warning = "Not found in your contacts";
    } else if (p.phone && !p.name) {
      const c = byPhone.get(p.phone) ?? byPhone.get(`10:${last10(p.phone)}`);
      if (c) out.name = c.name;
    }
    return out;
  });

  // The same number can now appear twice (once by name, once by number): keep one.
  const merged = new Map<string, GroupPerson>();
  const rest: GroupPerson[] = [];
  for (const p of people) {
    if (!p.phone) {
      rest.push(p);
      continue;
    }
    const prev = merged.get(p.phone);
    if (!prev) {
      merged.set(p.phone, p);
      continue;
    }
    const latest = (prev.lastSeen ?? "") >= (p.lastSeen ?? "") ? prev : p;
    merged.set(p.phone, {
      ...latest,
      name: prev.name ?? p.name,
      phoneFrom: prev.phoneFrom === "chat" || p.phoneFrom === "chat" ? "chat" : "contacts",
      messages: prev.messages + p.messages,
      firstSeen: [prev.firstSeen, p.firstSeen].filter(Boolean).sort()[0] ?? null,
      lastSeen: [prev.lastSeen, p.lastSeen].filter(Boolean).sort().pop() ?? null,
      notes: [...new Set([...prev.notes, ...p.notes])],
    });
  }
  return { ...extract, people: sortPeople([...merged.values(), ...rest]) };
}

// ---------------------------------------------------------------------------------------------------------------
// Export

const STATUS_LABEL: Record<GroupStatus, string> = { member: "In group", left: "Left", removed: "Removed" };
export const statusLabel = (s: GroupStatus) => STATUS_LABEL[s];

const csvCell = (v: string | number | null) => {
  const s = v === null ? "" : String(v);
  // A leading = + - @ would be run as a formula by spreadsheet apps (phone numbers like "+91 98000 00001" are fine).
  const safe = /^[=+\-@]/.test(s) && !/^\+[\d ]+$/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(people: GroupPerson[]): string {
  const rows: (string | number | null)[][] = [["Name", "Phone", "Status", "Messages", "First seen", "Last seen", "Notes"]];
  for (const p of people) rows.push([p.name, p.phone && formatPhone(p.phone), STATUS_LABEL[p.status], p.messages, p.firstSeen, p.lastSeen, p.notes.join("; ")]);
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const vcfText = (s: string) => s.replace(/([\\,;])/g, "\\$1");

/** A contacts file that phones and Google Contacts can import. People without a number are skipped. */
export function toVcf(people: GroupPerson[], groupName?: string | null): string {
  return people
    .filter((p) => p.phone)
    .map((p) =>
      [
        "BEGIN:VCARD",
        "VERSION:3.0",
        `FN:${vcfText(p.name ?? formatPhone(p.phone!))}`,
        `N:;${vcfText(p.name ?? formatPhone(p.phone!))};;;`,
        `TEL;TYPE=CELL:${p.phone}`,
        ...(groupName ? [`NOTE:${vcfText(`WhatsApp group: ${groupName}`)}`] : []),
        "END:VCARD",
      ].join("\r\n"),
    )
    .join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------------------------------------------
// Zip (WhatsApp shares chat exports as a .zip)

/** Pulls the chat text out of a WhatsApp export .zip. Uses the browser's built-in decompression. */
export async function chatTextFromZip(bytes: Uint8Array): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This doesn't look like a zip file.");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries: { name: string; method: number; size: number; offset: number }[] = [];
  for (let i = 0; i < count && view.getUint32(p, true) === 0x02014b50; i++) {
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const texts = entries.filter((e) => /\.txt$/i.test(e.name) && !e.name.startsWith("__MACOSX"));
  const entry = texts.find((e) => /(^|\/)_chat\.txt$|WhatsApp Chat/i.test(e.name)) ?? texts[0];
  if (!entry) throw new Error("No chat text file in this zip. Export the chat again from WhatsApp.");

  const local = entry.offset;
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const data = bytes.subarray(start, start + entry.size);
  if (entry.method === 0) return new TextDecoder().decode(data);
  if (entry.method !== 8) throw new Error("This zip uses a compression method that can't be read here.");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new TextDecoder().decode(new Uint8Array(await new Response(stream).arrayBuffer()));
}
