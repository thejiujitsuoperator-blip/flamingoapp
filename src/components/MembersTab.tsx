import { useState } from "react";
import { formatDate } from "../lib/dates";
import { money } from "../lib/format";
import type { Analysis } from "../lib/members";
import type { MemberStatus } from "../lib/types";
import { StatusPill } from "./StatusPill";

type SortKey = "name" | "expiry" | "totalPaid" | "lastPaid";

export function MembersTab({ analysis, onOpenMember }: { analysis: Analysis; onOpenMember: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<MemberStatus | "all">("all");
  const [sort, setSort] = useState<SortKey>("name");

  const q = search.trim().toLowerCase();
  const list = analysis.members
    .filter((m) => status === "all" || m.status === status)
    .filter((m) => !q || m.name.toLowerCase().includes(q) || m.vpas.some((v) => v.includes(q)))
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : sort === "totalPaid"
          ? b.totalPaid - a.totalPaid
          : (b[sort] ?? "").localeCompare(a[sort] ?? ""),
    );

  const counts = {
    all: analysis.members.length,
    active: analysis.members.filter((m) => m.status === "active").length,
    due: analysis.members.filter((m) => m.status === "due").length,
    lapsed: analysis.members.filter((m) => m.status === "lapsed").length,
  };

  return (
    <section className="card">
      <div className="filters">
        <input type="search" placeholder="Search name or UPI id" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="segmented" role="radiogroup" aria-label="Status">
          {(["all", "active", "due", "lapsed"] as const).map((s) => (
            <button key={s} role="radio" aria-checked={status === s} className={status === s ? "on" : ""} onClick={() => setStatus(s)}>
              {s[0].toUpperCase() + s.slice(1)} <span className="muted">{counts[s]}</span>
            </button>
          ))}
        </div>
        <label className="small">
          Sort{" "}
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="name">Name</option>
            <option value="expiry">Expiry (latest first)</option>
            <option value="lastPaid">Last payment</option>
            <option value="totalPaid">Total paid</option>
          </select>
        </label>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Member</th>
              <th>Status</th>
              <th>Plan</th>
              <th>Membership until</th>
              <th>Last payment</th>
              <th className="num">Payments</th>
              <th className="num">Total paid</th>
            </tr>
          </thead>
          <tbody>
            {list.map((m) => (
              <tr key={m.id} className="clickable" onClick={() => onOpenMember(m.id)}>
                <td>
                  <button className="link" onClick={() => onOpenMember(m.id)}>
                    {m.name}
                  </button>
                </td>
                <td>
                  <StatusPill member={m} />
                </td>
                <td>{m.currentPlan}</td>
                <td>{formatDate(m.expiry)}</td>
                <td>{formatDate(m.lastPaid)}</td>
                <td className="num">{m.payments.length}</td>
                <td className="num">{money(m.totalPaid)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length === 0 && <p className="muted">No members match.</p>}
    </section>
  );
}
