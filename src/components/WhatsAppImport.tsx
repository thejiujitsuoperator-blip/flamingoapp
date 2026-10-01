import { useMemo, useRef, useState } from "react";
import { formatDate } from "../lib/dates";
import { cleanPhone, mergeRoster, parseContactLabel, rosterId } from "../lib/roster";
import type { RosterEntry } from "../lib/types";
import {
  chatTextFromZip,
  enrichWithContacts,
  formatPhone,
  groupNameFromFile,
  parseChatExport,
  parseVcf,
  statusLabel,
  toCsv,
  toVcf,
  type Contact,
  type GroupExtract,
  type GroupPerson,
  type GroupStatus,
} from "../lib/whatsapp";

interface Props {
  roster: RosterEntry[];
  onSaveVersion: (entries: RosterEntry[], note: string) => Promise<void>;
  canWrite: boolean;
}

type Downloads = { save(r: { filename: string; data: Uint8Array }): Promise<unknown> };

/** Saves a file through the artifact's downloads capability, or a plain browser download when run locally. */
async function saveFile(filename: string, text: string, type: string): Promise<void> {
  const data = new TextEncoder().encode(text);
  const use = (window as unknown as { claude?: { use?: (n: string) => Promise<unknown> } }).claude?.use;
  const downloads = use ? ((await use("downloads").catch(() => null)) as Downloads | null) : null;
  if (downloads) {
    await downloads.save({ filename, data });
    return;
  }
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const TONE: Record<GroupStatus, string> = { member: "good", left: "neutral", removed: "bad" };
const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, " ").trim() || "WhatsApp group";

export function WhatsAppImport({ roster, onSaveVersion, canWrite }: Props) {
  const [chat, setChat] = useState<{ file: string; extract: GroupExtract } | null>(null);
  const [contacts, setContacts] = useState<{ file: string; list: Contact[] } | null>(null);
  const [show, setShow] = useState<"member" | "all">("member");
  const [status, setStatus] = useState<{ kind: "busy" | "ok" | "error"; text: string } | null>(null);
  const chatInput = useRef<HTMLInputElement>(null);
  const vcfInput = useRef<HTMLInputElement>(null);

  const result = useMemo(() => (chat ? (contacts ? enrichWithContacts(chat.extract, contacts.list) : chat.extract) : null), [chat, contacts]);
  const shown = result ? result.people.filter((p) => show === "all" || p.status === "member") : [];
  const inGroup = result ? result.people.filter((p) => p.status === "member") : [];
  const withPhone = shown.filter((p) => p.phone).length;
  const group = fileSafe(result?.groupName ?? "WhatsApp group");

  async function readChat(file: File | undefined) {
    if (!file) return;
    setStatus({ kind: "busy", text: `Reading ${file.name}…` });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
      const text = isZip ? await chatTextFromZip(bytes) : new TextDecoder().decode(bytes);
      const extract = parseChatExport(text, { groupName: groupNameFromFile(file.name) });
      if (!extract.linesRead) throw new Error("No WhatsApp messages found in this file. Use the file from WhatsApp's \"Export chat\".");
      setChat({ file: file.name, extract });
      setStatus(null);
    } catch (err) {
      setStatus({ kind: "error", text: (err as Error).message });
    } finally {
      if (chatInput.current) chatInput.current.value = "";
    }
  }

  async function readContacts(file: File | undefined) {
    if (!file) return;
    try {
      const list = parseVcf(await file.text());
      if (!list.length) throw new Error("No contacts with phone numbers found in this file. Use a .vcf (vCard) contacts export.");
      setContacts({ file: file.name, list });
      setStatus(null);
    } catch (err) {
      setStatus({ kind: "error", text: (err as Error).message });
    } finally {
      if (vcfInput.current) vcfInput.current.value = "";
    }
  }

  async function download(kind: "csv" | "vcf") {
    try {
      if (kind === "csv") await saveFile(`${group} members.csv`, toCsv(shown), "text/csv");
      else await saveFile(`${group} members.vcf`, toVcf(shown, result?.groupName), "text/vcard");
    } catch {
      setStatus({ kind: "error", text: "The file wasn't saved." });
    }
  }

  function addToList() {
    const entries: RosterEntry[] = shown.map((p) => {
      const label = p.name ?? formatPhone(p.phone!);
      const { name, tags } = p.name ? parseContactLabel(p.name) : { name: label, tags: [] };
      const phone = cleanPhone(p.phone);
      return {
        id: rosterId(label, phone),
        name,
        ...(label !== name ? { label } : {}),
        ...(tags.length ? { tags } : {}),
        phone,
        source: `WhatsApp: ${result?.groupName ?? "group"}`,
      };
    });
    const merged = mergeRoster(roster, entries);
    onSaveVersion(merged.roster, `Added ${merged.added} from WhatsApp group${result?.groupName ? ` "${result.groupName}"` : ""}`)
      .then(() =>
        setStatus({
          kind: "ok",
          text: `Added ${merged.added} name${merged.added === 1 ? "" : "s"} (${entries.length - merged.added} already on the list). Saved as a new version of the list.`,
        }),
      )
      .catch((err: Error) => setStatus({ kind: "error", text: err.message }));
  }

  return (
    <section className="card">
      <h2>Import from a WhatsApp group</h2>
      <p className="muted small">
        Get the names and numbers of everyone in a WhatsApp group from the group's chat export. Files are read on this
        device and aren't uploaded anywhere.
      </p>
      <details>
        <summary className="small">How to get the files</summary>
        <ol className="plain small">
          <li>
            <strong>Chat export.</strong> In WhatsApp, open the group, tap its name (iPhone) or ⋮ → More (Android), then{" "}
            <em>Export chat</em> → <em>Without media</em>. Save or send the file to yourself and pick it below (the .zip or
            the .txt inside it).
          </li>
          <li>
            <strong>Contacts (optional).</strong> WhatsApp writes people saved in your phone by name only, so their numbers
            come from your contacts. Export them as a .vcf file: Google Contacts → Export → vCard, or on iPhone, Contacts →
            Lists → long-press <em>All Contacts</em> → Export.
          </li>
        </ol>
        <p className="muted small">
          The export only shows people who posted, or who were added, joined, left or were removed while the chat history
          on your phone was kept. Long-quiet members from before that won't appear; add them by hand.
        </p>
      </details>
      <div className="row">
        <button className="primary" onClick={() => chatInput.current?.click()} disabled={status?.kind === "busy"}>
          {chat ? "Choose another chat" : "Choose chat export"}
        </button>
        <input ref={chatInput} type="file" accept=".txt,.zip,text/plain,application/zip" hidden onChange={(e) => readChat(e.target.files?.[0])} />
        <button onClick={() => vcfInput.current?.click()}>{contacts ? "Choose other contacts" : "Add contacts (.vcf)"}</button>
        <input ref={vcfInput} type="file" accept=".vcf,text/vcard,text/x-vcard" hidden onChange={(e) => readContacts(e.target.files?.[0])} />
        {(chat || contacts) && (
          <span className="muted small">
            {[chat?.file, contacts && `${contacts.file} (${contacts.list.length} contacts)`].filter(Boolean).join(" · ")}
          </span>
        )}
      </div>
      {status && <p className={status.kind === "error" ? "ask-error" : "muted small"}>{status.text}</p>}

      {result && (
        <>
          <p className="small">
            <strong>{result.groupName ?? "This group"}</strong>: {inGroup.length} in the group, {result.people.length - inGroup.length} left
            or removed
            {result.dateRange && ` · chat from ${formatDate(result.dateRange.from)} to ${formatDate(result.dateRange.to)}`}.{" "}
            {!contacts && inGroup.some((p) => !p.phone) && (
              <span className="muted">Add your contacts to fill in the numbers of people saved in your phone.</span>
            )}
          </p>
          <div className="row">
            <div className="segmented" role="radiogroup" aria-label="Show">
              {(
                [
                  ["member", "In group", inGroup.length],
                  ["all", "Everyone", result.people.length],
                ] as const
              ).map(([k, label, n]) => (
                <button key={k} role="radio" aria-checked={show === k} className={show === k ? "on" : ""} onClick={() => setShow(k)}>
                  {label} <span className="muted">{n}</span>
                </button>
              ))}
            </div>
            <button onClick={() => download("csv")} disabled={!shown.length}>
              Download CSV
            </button>
            <button onClick={() => download("vcf")} disabled={!withPhone}>
              Download contacts (.vcf)
            </button>
            <button onClick={addToList} disabled={!shown.length || !canWrite}>
              Add {shown.length} to member list
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Status</th>
                  <th className="num">Messages</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p: GroupPerson) => (
                  <tr key={`${p.phone ?? ""}|${p.name ?? ""}`}>
                    <td>
                      {p.name ?? <span className="muted">Not saved</span>}
                      {p.notes.length > 0 && <div className="muted small">{p.notes.join(" · ")}</div>}
                    </td>
                    <td>
                      {p.phone ? formatPhone(p.phone) : <span className="muted">—</span>}
                      {p.phoneFrom === "contacts" && <div className="muted small">from your contacts</div>}
                      {p.warning && <div className="small warn-text">{p.warning}</div>}
                    </td>
                    <td>
                      <span className={`pill ${TONE[p.status]}`}>{statusLabel(p.status)}</span>
                    </td>
                    <td className="num">{p.messages}</td>
                    <td>{p.lastSeen ? formatDate(p.lastSeen) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
