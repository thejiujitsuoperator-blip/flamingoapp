import { useEffect, useState } from "react";
import { formatDate } from "../lib/dates";
import { money } from "../lib/format";
import { CATEGORY_LABELS, type Member } from "../lib/types";
import { StatusPill } from "./StatusPill";

interface Props {
  member: Member;
  asOf: string;
  onClose: () => void;
  onRename: (name: string) => void;
}

export function MemberProfile({ member, asOf, onClose, onRename }: Props) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(member.name);

  useEffect(() => {
    setName(member.name);
    setEditing(false);
  }, [member.id, member.name]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const statusLine =
    member.status === "active"
      ? `Membership runs until ${formatDate(member.expiry)} — ${member.daysLeft} day${member.daysLeft === 1 ? "" : "s"} left as of ${formatDate(asOf)}.`
      : `Membership ended ${formatDate(member.expiry)} (${-member.daysLeft!} days before ${formatDate(asOf)}).`;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`${member.name} profile`} onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          {editing ? (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) onRename(name.trim());
                setEditing(false);
              }}
            >
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Member name" />
              <button className="primary" type="submit">
                Save
              </button>
            </form>
          ) : (
            <div>
              <h2>{member.name}</h2>
              <button className="link small" onClick={() => setEditing(true)}>
                Rename
              </button>
            </div>
          )}
          <button className="ghost close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="profile-status">
          <StatusPill member={member} />
          <p>{statusLine}</p>
        </div>

        <dl className="facts">
          <div>
            <dt>Current plan</dt>
            <dd>{member.currentPlan ?? "—"}</dd>
          </div>
          <div>
            <dt>Member since</dt>
            <dd>{formatDate(member.payments.find((p) => p.category === "membership")?.date)}</dd>
          </div>
          <div>
            <dt>Total paid</dt>
            <dd>{money(member.totalPaid)}</dd>
          </div>
          <div>
            <dt>Membership fees</dt>
            <dd>{money(member.membershipPaid)}</dd>
          </div>
          <div className="wide">
            <dt>Pays as (bank statement name)</dt>
            <dd>{[...new Set(member.payments.map((p) => p.payer?.name).filter(Boolean))].join(", ")}</dd>
          </div>
          <div className="wide">
            <dt>UPI ids</dt>
            <dd>{member.vpas.join(", ") || "—"}</dd>
          </div>
        </dl>

        <h3>Payment history</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th className="num">Amount</th>
                <th>Covers</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {[...member.payments].reverse().map((p) => (
                <tr key={p.txnId}>
                  <td>{formatDate(p.date)}</td>
                  <td>{p.category === "membership" ? p.planLabel : CATEGORY_LABELS[p.category]}</td>
                  <td className="num">{money(p.amount)}</td>
                  <td className="small">{p.coverFrom ? `${formatDate(p.coverFrom)} – ${formatDate(p.coverTo)}` : "—"}</td>
                  <td className="small muted">{p.payer?.remark}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </aside>
    </div>
  );
}
