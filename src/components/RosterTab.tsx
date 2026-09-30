import { useEffect, useRef, useState } from "react";
import { formatDate } from "../lib/dates";
import { money } from "../lib/format";
import type { Analysis } from "../lib/members";
import { mergeRoster, parseRosterText, rosterId, type MatchConfidence, type RosterMatch } from "../lib/roster";
import type { RosterEntry } from "../lib/types";
import { StatusPill } from "./StatusPill";

interface Props {
  matches: RosterMatch[];
  analysis: Analysis;
  setRoster: (fn: (r: RosterEntry[]) => RosterEntry[]) => void;
  onOpenMember: (id: string) => void;
}

const CONFIDENCE: Record<MatchConfidence, { label: string; tone: string }> = {
  manual: { label: "Linked by you", tone: "neutral" },
  exact: { label: "Exact match", tone: "good" },
  likely: { label: "Likely match", tone: "good" },
  possible: { label: "Check this", tone: "warn" },
  none: { label: "No payments found", tone: "bad" },
};

const AUTO = "__auto";
const NONE = "__none";

/** Shrinks a screenshot so its long edge is at most 1600px (the model downsizes larger images anyway). */
async function toBase64Png(file: File): Promise<{ data: string; mediaType: "image/png" }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/png");
  return { data: url.slice(url.indexOf(",") + 1), mediaType: "image/png" };
}

export function RosterTab({ matches, analysis, setRoster, onOpenMember }: Props) {
  const [text, setText] = useState("");
  const [scanStatus, setScanStatus] = useState<{ kind: "busy" | "ok" | "error"; text: string } | null>(null);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [filter, setFilter] = useState<"all" | "unmatched" | "check" | "inactive">("all");
  const shotInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) => setAiAvailable(Boolean(h.ai)))
      .catch(() => setAiAvailable(false));
  }, []);

  async function scan(files: FileList | null) {
    if (!files?.length) return;
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;
    const lines: string[] = [];
    try {
      for (let i = 0; i < list.length; i += 3) {
        const batch = list.slice(i, i + 3);
        setScanStatus({ kind: "busy", text: `Reading screenshot ${i + 1}–${i + batch.length} of ${list.length}…` });
        const res = await fetch("/api/extract-names", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ images: await Promise.all(batch.map(toBase64Png)) }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
        for (const p of body.people as { name: string; phone: string | null }[]) {
          lines.push(p.phone ? `${p.name}  ${p.phone}` : p.name);
        }
      }
      setText((t) => [t.trim(), ...lines].filter(Boolean).join("\n"));
      setScanStatus({
        kind: "ok",
        text: `Found ${lines.length} names in ${list.length} screenshot${list.length > 1 ? "s" : ""}. Check them below, fix any misreads, then add them.`,
      });
    } catch (err) {
      setScanStatus({ kind: "error", text: (err as Error).message });
    } finally {
      if (shotInput.current) shotInput.current.value = "";
    }
  }

  function addFromText() {
    const entries = parseRosterText(text, "Pasted / scanned");
    let added = 0;
    setRoster((r) => {
      const merged = mergeRoster(r, entries);
      added = merged.added;
      return merged.roster;
    });
    setText("");
    setScanStatus({ kind: "ok", text: `Added ${added} name${added === 1 ? "" : "s"} (${entries.length - added} already on the list).` });
  }

  const updateEntry = (id: string, patch: Partial<RosterEntry>) =>
    setRoster((r) => r.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  const listed = new Set(matches.filter((m) => m.member && !m.paidBy).map((m) => m.member!.id));
  const notListed = analysis.members.filter((m) => !listed.has(m.id) && m.status !== "lapsed");
  const counts = {
    all: matches.length,
    unmatched: matches.filter((m) => !m.member).length,
    check: matches.filter((m) => m.confidence === "possible").length,
    inactive: matches.filter((m) => m.member && m.member.status !== "active").length,
  };
  const shown = matches.filter((m) =>
    filter === "all"
      ? true
      : filter === "unmatched"
        ? !m.member
        : filter === "check"
          ? m.confidence === "possible"
          : m.member && m.member.status !== "active",
  );
  const sortedMembers = [...analysis.members].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="settings">
      <section className="card">
        <h2>Add names to your member list</h2>
        <p className="muted small">
          Scan screenshots of your member list (a WhatsApp group, contacts, an app or a sheet), or paste names — one per
          line, with a phone number if you have it. Names are matched against who paid in your bank statements.
        </p>
        <div className="row">
          <button className="primary" onClick={() => shotInput.current?.click()} disabled={!aiAvailable || scanStatus?.kind === "busy"}>
            Scan screenshots
          </button>
          <input ref={shotInput} type="file" accept="image/*" multiple hidden onChange={(e) => scan(e.target.files)} />
          {!aiAvailable && (
            <span className="muted small">Scanning needs ANTHROPIC_API_KEY on the server. Pasting names works without it.</span>
          )}
        </div>
        {scanStatus && <p className={scanStatus.kind === "error" ? "ask-error" : "muted small"}>{scanStatus.text}</p>}
        <textarea
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"Meera Venkatesh\nRohan Desai  +91 98000 00002\nTara Menon"}
          aria-label="Names to add"
        />
        <div className="row">
          <button onClick={addFromText} disabled={!text.trim()}>
            Add to list
          </button>
          {matches.length > 0 && (
            <button
              className="danger"
              onClick={() => {
                if (confirm(`Remove all ${matches.length} names from the member list?`)) setRoster(() => []);
              }}
            >
              Clear list
            </button>
          )}
        </div>
      </section>

      {matches.length > 0 && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Member list vs. payments</h2>
              <p className="muted small">
                {matches.length - counts.unmatched} of {matches.length} matched to payments · status as of{" "}
                {formatDate(analysis.asOf)}. If a match is wrong, pick the right payer from the dropdown.
              </p>
            </div>
          </div>
          <div className="segmented" role="radiogroup" aria-label="Filter">
            {(
              [
                ["all", "All"],
                ["inactive", "Not paid up"],
                ["unmatched", "No payments"],
                ["check", "Check match"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} role="radio" aria-checked={filter === k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
                {label} <span className="muted">{counts[k]}</span>
              </button>
            ))}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name on list</th>
                  <th>Pays as (bank statement)</th>
                  <th>Status</th>
                  <th>Paid until</th>
                  <th className="num">Total paid</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((m) => {
                  const c = CONFIDENCE[m.confidence];
                  const value = m.entry.linkedMemberId === undefined ? AUTO : (m.entry.linkedMemberId ?? NONE);
                  return (
                    <tr key={m.entry.id}>
                      <td>
                        {m.member ? (
                          <button className="link" onClick={() => onOpenMember(m.member!.id)}>
                            {m.entry.name}
                          </button>
                        ) : (
                          m.entry.name
                        )}
                        {m.entry.phone && <div className="muted small">{m.entry.phone}</div>}
                      </td>
                      <td>
                        <select
                          value={value}
                          aria-label={`Payer for ${m.entry.name}`}
                          onChange={(e) =>
                            updateEntry(m.entry.id, {
                              linkedMemberId: e.target.value === AUTO ? undefined : e.target.value === NONE ? null : e.target.value,
                            })
                          }
                        >
                          <option value={AUTO}>
                            {m.entry.linkedMemberId === undefined && m.member ? `Auto: ${m.member.name}` : "Auto"}
                          </option>
                          <option value={NONE}>Not in statements</option>
                          <optgroup label="All payers">
                            {sortedMembers.map((mem) => (
                              <option key={mem.id} value={mem.id}>
                                {mem.name}
                              </option>
                            ))}
                          </optgroup>
                        </select>
                        <div className="small">
                          <span className={`pill ${c.tone}`}>{m.paidBy ? "Paid by someone else" : c.label}</span>
                        </div>
                      </td>
                      <td>{m.member ? <StatusPill member={m.member} /> : <span className="muted">—</span>}</td>
                      <td>{m.member ? formatDate(m.member.expiry) : "—"}</td>
                      <td className="num">{m.member ? money(m.member.totalPaid) : "—"}</td>
                      <td>
                        <button className="link small" onClick={() => setRoster((r) => r.filter((e) => e.id !== m.entry.id))}>
                          remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {matches.length > 0 && notListed.length > 0 && (
        <section className="card">
          <h2>Paying, but not on your list</h2>
          <p className="muted small">Active or recently expired members from the statements who don't match anyone on your list.</p>
          <ul className="plain">
            {notListed.map((m) => (
              <li key={m.id}>
                <button className="link" onClick={() => onOpenMember(m.id)}>
                  {m.name}
                </button>{" "}
                <span className="muted small">
                  {m.status} · until {formatDate(m.expiry)}
                </span>{" "}
                <button
                  className="link small"
                  onClick={() =>
                    setRoster((r) => [...r, { id: rosterId(m.name, null), name: m.name, phone: null, source: "Added from statements", linkedMemberId: m.id }])
                  }
                >
                  add to list
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
