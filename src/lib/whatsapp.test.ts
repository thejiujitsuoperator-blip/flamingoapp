import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { chatTextFromZip, enrichWithContacts, groupNameFromFile, normalisePhone, parseChatExport, parseVcf, toCsv, toVcf } from "./whatsapp";

const LRM = "‎";
const NNBSP = " ";

const android = [
  `03/01/2026, 9:00${NNBSP}am - Messages and calls are end-to-end encrypted. No one outside of this chat can read or listen to them.`,
  `03/01/2026, 9:00${NNBSP}am - You created group "Flamingo BJJ"`,
  `03/01/2026, 9:01${NNBSP}am - You added Meera Venkatesh, Rohan Desai and ⁨+91 98000 00003⁩`,
  `04/01/2026, 7:15${NNBSP}pm - Meera Venkatesh: Class at 7 tomorrow?`,
  `04/01/2026, 7:16${NNBSP}pm - Rohan Desai: Yes. Bring your gi: the blue one`,
  `04/01/2026, 7:20${NNBSP}pm - +91 98000 00003: 👍`,
  `15/01/2026, 6:02${NNBSP}pm - ⁨+91 98000 00004⁩ joined using this group's invite link`,
  `16/01/2026, 8:30${NNBSP}am - +91 98000 00004: Hi all, I'm Kiran`,
  `and this is a second line: of the same message`,
  `20/01/2026, 10:00${NNBSP}am - Tara Menon left`,
  `21/01/2026, 10:00${NNBSP}am - Rohan Desai removed ⁨+91 98000 00003⁩`,
  `22/01/2026, 11:00${NNBSP}am - Rohan Desai changed the subject to "Flamingo: Mon/Wed"`,
  `23/01/2026, 11:00${NNBSP}am - Meera Venkatesh: Rohan Desai left the mat early today`,
].join("\n");

const ios = [
  `[03/01/26, 9:00:00 AM] Flamingo BJJ: ${LRM}Messages and calls are end-to-end encrypted.`,
  `${LRM}[03/01/26, 9:01:00 AM] Flamingo BJJ: ${LRM}Rohan Desai added Meera Venkatesh`,
  `[04/01/26, 7:15:12 PM] Meera Venkatesh: Hello`,
  `${LRM}[04/01/26, 7:16:40 PM] ~${NNBSP}Kiran: ${LRM}image omitted`,
  `${LRM}[05/01/26, 7:00:00 PM] Flamingo BJJ: ${LRM}‪+91 98000 00005‬ joined using this group's invite link`,
  `${LRM}[06/01/26, 7:00:00 PM] Flamingo BJJ: ${LRM}Meera Venkatesh left`,
].join("\n");

describe("parseChatExport", () => {
  it("reads an Android export", () => {
    const r = parseChatExport(android, { groupName: groupNameFromFile("WhatsApp Chat with Flamingo BJJ.txt") });
    expect(r.groupName).toBe("Flamingo BJJ");
    expect(r.dateRange).toEqual({ from: "2026-01-03", to: "2026-01-23" });
    const by = (k: string) => r.people.find((p) => p.name === k || p.phone === k);
    expect(by("Meera Venkatesh")).toMatchObject({ status: "member", messages: 2, phone: null, firstSeen: "2026-01-03" });
    expect(by("Rohan Desai")).toMatchObject({ status: "member", messages: 1 });
    expect(by("+919800000003")).toMatchObject({ status: "removed", messages: 1, name: null, phoneFrom: "chat" });
    expect(by("+919800000004")).toMatchObject({ status: "member", messages: 1, notes: ["joined via invite link"] });
    expect(by("Tara Menon")).toMatchObject({ status: "left" });
    // A message that reads like an event is still a message, and the exporter ("You") isn't listed.
    expect(r.people.map((p) => p.name ?? p.phone).sort()).toEqual(
      ["+919800000003", "+919800000004", "Meera Venkatesh", "Rohan Desai", "Tara Menon"].sort(),
    );
    expect(by("Meera Venkatesh")!.notes).toContain("added by you");
  });

  it("reads an iPhone export, where group events come from the group", () => {
    const r = parseChatExport(ios);
    expect(r.groupName).toBe("Flamingo BJJ");
    const names = r.people.map((p) => p.name ?? p.phone);
    expect(names).not.toContain("Flamingo BJJ");
    expect(r.people.find((p) => p.name === "Meera Venkatesh")).toMatchObject({ status: "left", messages: 1 });
    expect(r.people.find((p) => p.name === "Kiran")).toMatchObject({ status: "member", messages: 1 });
    expect(r.people.find((p) => p.phone === "+919800000005")).toMatchObject({ status: "member" });
    expect(r.people.find((p) => p.name === "Rohan Desai")).toMatchObject({ status: "member", messages: 0 });
  });

  it("reads month-first dates", () => {
    const r = parseChatExport("1/23/26, 9:41 PM - Meera: Hi\n2/2/26, 9:41 PM - Rohan: Hey");
    expect(r.dateRange).toEqual({ from: "2026-01-23", to: "2026-02-02" });
  });
});

describe("phones", () => {
  it("normalises numbers", () => {
    expect(normalisePhone("98000 00001")).toBe("+919800000001");
    expect(normalisePhone("098000 00001")).toBe("+919800000001");
    expect(normalisePhone("+1 (415) 555-0100")).toBe("+14155550100");
    expect(normalisePhone("0044 20 7946 0000")).toBe("+442079460000");
    expect(normalisePhone("123")).toBeNull();
  });
});

const vcf = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Meera Venkatesh",
  "N:Venkatesh;Meera;;;",
  "TEL;TYPE=HOME:022 2345 6789",
  "item1.TEL;TYPE=CELL:+91 98000 00001",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:2.1",
  "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Des=C3=A1i;Rohan;;;",
  "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Rohan Des=C3=A1i",
  "TEL;CELL:9800000002",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Kiran",
  "TEL:+91 98000 00004",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Tara Menon",
  "TEL:+91 98000 00006",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Tara Menon",
  "TEL:+91 98000 00007",
  "END:VCARD",
].join("\r\n");

describe("contacts", () => {
  it("parses vCards, mobile numbers first", () => {
    const c = parseVcf(vcf);
    expect(c[0]).toEqual({ name: "Meera Venkatesh", phones: ["+919800000001", "+912223456789"] });
    expect(c[1]).toEqual({ name: "Rohan Desái", phones: ["+919800000002"] });
  });

  it("fills in numbers by name and names by number", () => {
    const r = enrichWithContacts(parseChatExport(android), parseVcf(vcf));
    expect(r.people.find((p) => p.name === "Meera Venkatesh")).toMatchObject({ phone: "+919800000001", phoneFrom: "contacts" });
    expect(r.people.find((p) => p.phone === "+919800000004")).toMatchObject({ name: "Kiran", phoneFrom: "chat" });
    expect(r.people.find((p) => p.name === "Tara Menon")).toMatchObject({ phone: null, warning: '2 contacts are called "Tara Menon"' });
    expect(r.people.find((p) => p.name === "Rohan Desai")!.warning).toBe("Not found in your contacts");
  });
});

describe("export", () => {
  const people = enrichWithContacts(parseChatExport(android), parseVcf(vcf)).people;
  it("writes CSV", () => {
    const csv = toCsv(people);
    expect(csv.split("\r\n")[0]).toBe("Name,Phone,Status,Messages,First seen,Last seen,Notes");
    expect(csv).toContain("Meera Venkatesh,+91 98000 00001,In group,2,2026-01-03,2026-01-23,added by you");
  });
  it("writes vCards only for people with a number", () => {
    const out = toVcf(people, "Flamingo BJJ");
    expect(out.match(/BEGIN:VCARD/g)).toHaveLength(3);
    expect(out).toContain("FN:Kiran\r\nN:;Kiran;;;\r\nTEL;TYPE=CELL:+919800000004\r\nNOTE:WhatsApp group: Flamingo BJJ");
    expect(parseVcf(out).map((c) => c.name)).toEqual(people.filter((p) => p.phone).map((p) => p.name ?? expect.any(String)));
  });
});

/** A one-file zip, deflated, like the one WhatsApp shares. */
function zip(name: string, text: string): Uint8Array {
  const data = new TextEncoder().encode(text);
  const comp = deflateRawSync(data);
  const nameBytes = new TextEncoder().encode(name);
  const local = new Uint8Array(30 + nameBytes.length + comp.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(8, 8, true);
  lv.setUint32(18, comp.length, true);
  lv.setUint32(22, data.length, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(comp, 30 + nameBytes.length);
  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(10, 8, true);
  cv.setUint32(20, comp.length, true);
  cv.setUint32(24, data.length, true);
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint32(42, 0, true);
  central.set(nameBytes, 46);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length, true);
  const out = new Uint8Array(local.length + central.length + end.length);
  out.set(local);
  out.set(central, local.length);
  out.set(end, local.length + central.length);
  return out;
}

describe("chatTextFromZip", () => {
  it("reads the chat out of an export zip", async () => {
    expect(await chatTextFromZip(zip("_chat.txt", ios))).toBe(ios);
  });
  it("explains a zip with no chat", async () => {
    await expect(chatTextFromZip(zip("photo.jpg", "x"))).rejects.toThrow("No chat text file");
  });
});
