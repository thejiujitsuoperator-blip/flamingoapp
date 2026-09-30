import { useState } from "react";
import { formatDate } from "../lib/dates";
import { money } from "../lib/format";
import type { Analysis } from "../lib/members";
import { CATEGORY_LABELS, REVENUE_CATEGORIES, type Category, type Settings } from "../lib/types";

interface Props {
  analysis: Analysis;
  settings: Settings;
  setSettings: (fn: (s: Settings) => Settings) => void;
}

const CHOICES: Category[] = ["membership", "dropin", "merch", "other", "refund", "interest", "investment", "owner"];

export function TransactionsTab({ analysis, settings, setSettings }: Props) {
  const [filter, setFilter] = useState<Category | "all" | "revenue">("all");
  const [search, setSearch] = useState("");
  const names = new Map(analysis.members.map((m) => [m.id, m.name]));
  const q = search.trim().toUpperCase();

  const rows = [...analysis.payments]
    .reverse()
    .filter((p) => filter === "all" || (filter === "revenue" ? REVENUE_CATEGORIES.includes(p.category) : p.category === filter))
    .filter((p) => !q || (p.payer?.name ?? "").includes(q) || (p.payer?.remark ?? "").includes(q));

  const setCategory = (txnId: string, category: Category) =>
    setSettings((s) => ({ ...s, categoryOverrides: { ...s.categoryOverrides, [txnId]: category } }));
  const clearOverride = (txnId: string) =>
    setSettings((s) => {
      const { [txnId]: _removed, ...rest } = s.categoryOverrides;
      return { ...s, categoryOverrides: rest };
    });

  return (
    <section className="card">
      <p className="muted small">
        Every credit in your statements, with how it was classified. If something is wrong — say a membership fee that
        was counted as merch — change its type here and the whole dashboard updates.
      </p>
      <div className="filters">
        <input type="search" placeholder="Search payer or note" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">All credits</option>
          <option value="revenue">Revenue only</option>
          {CHOICES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        <span className="muted small">
          {rows.length} credits · {money(rows.reduce((s, p) => s + p.amount, 0))}
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>From</th>
              <th>Note</th>
              <th className="num">Amount</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.txnId}>
                <td>{formatDate(p.date)}</td>
                <td>{(p.memberId && names.get(p.memberId)) || p.payer?.name || <span className="muted">—</span>}</td>
                <td className="small muted">{p.payer ? p.payer.remark : "Bank credit"}</td>
                <td className="num">{money(p.amount)}</td>
                <td>
                  <select
                    value={p.category}
                    onChange={(e) => setCategory(p.txnId, e.target.value as Category)}
                    aria-label="Transaction type"
                  >
                    {CHOICES.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_LABELS[c]}
                      </option>
                    ))}
                  </select>
                  {settings.categoryOverrides[p.txnId] && (
                    <button className="link small" onClick={() => clearOverride(p.txnId)}>
                      reset
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
