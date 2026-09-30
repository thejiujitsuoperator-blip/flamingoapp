import { useState } from "react";
import { formatDate } from "../lib/dates";
import { normaliseName } from "../lib/classify";
import { DEFAULT_SETTINGS } from "../lib/settings";
import type { Dataset, PlanTier, Settings } from "../lib/types";

interface Props {
  settings: Settings;
  setSettings: (fn: (s: Settings) => Settings) => void;
  data: Dataset;
  onClear: () => void;
}

export function SettingsTab({ settings, setSettings, data, onClear }: Props) {
  const [owner, setOwner] = useState("");
  const update = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));
  const setTier = (i: number, patch: Partial<PlanTier>) =>
    update({ planTiers: settings.planTiers.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  return (
    <div className="settings">
      <section className="card">
        <h2>Membership plans</h2>
        <p className="muted small">
          A fee buys the longest plan whose minimum it reaches. E.g. with these defaults ₹12,000 buys a quarterly plan and
          ₹42,000 an annual one. Adjust to match your price list.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Plan name</th>
                <th>Minimum amount (₹)</th>
                <th>Months covered</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {settings.planTiers.map((t, i) => (
                <tr key={i}>
                  <td>
                    <input value={t.label} onChange={(e) => setTier(i, { label: e.target.value })} aria-label="Plan name" />
                  </td>
                  <td>
                    <input type="number" min={0} value={t.minAmount} onChange={(e) => setTier(i, { minAmount: Number(e.target.value) })} aria-label="Minimum amount" />
                  </td>
                  <td>
                    <input type="number" min={1} max={36} value={t.months} onChange={(e) => setTier(i, { months: Math.max(1, Number(e.target.value)) })} aria-label="Months" />
                  </td>
                  <td>
                    {settings.planTiers.length > 1 && (
                      <button className="link small" onClick={() => update({ planTiers: settings.planTiers.filter((_, j) => j !== i) })}>
                        remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button onClick={() => update({ planTiers: [...settings.planTiers, { label: "New plan", minAmount: 0, months: 1 }] })}>
          Add plan
        </button>
      </section>

      <section className="card">
        <h2>Rules</h2>
        <div className="form-grid">
          <NumberField label="Smallest membership fee (₹)" hint="Credits below this count as merch / misc." value={settings.minFee} onChange={(v) => update({ minFee: v })} />
          <NumberField label="Drop-in class up to (₹)" hint="Credits at or below this count as drop-in classes." value={settings.dropInMax} onChange={(v) => update({ dropInMax: v })} />
          <NumberField label="Renewal grace (days)" hint="A renewal this soon after expiry continues the old membership instead of restarting it." value={settings.renewalGraceDays} onChange={(v) => update({ renewalGraceDays: v })} />
          <NumberField label="Due-for-renewal window (days)" hint="How long an expired member stays 'due' before counting as lapsed." value={settings.dueWindowDays} onChange={(v) => update({ dueWindowDays: v })} />
          <NumberField label="'Renewing soon' window (days)" hint="Used for the upcoming renewals list." value={settings.renewSoonDays} onChange={(v) => update({ renewSoonDays: v })} />
        </div>
      </section>

      <section className="card">
        <h2>Owner & family transfers</h2>
        <p className="muted small">
          Payers sharing the account holder's surname ({data.accountHolder ?? "unknown"}) are already excluded from
          revenue. Add anyone else whose transfers aren't gym income.
        </p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const n = normaliseName(owner);
            if (n && !settings.ownerPayers.includes(n)) update({ ownerPayers: [...settings.ownerPayers, n] });
            setOwner("");
          }}
        >
          <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Payer name as on statement" aria-label="Payer name" />
          <button type="submit">Add</button>
        </form>
        <ul className="plain">
          {settings.ownerPayers.map((n) => (
            <li key={n}>
              {n}{" "}
              <button className="link small" onClick={() => update({ ownerPayers: settings.ownerPayers.filter((x) => x !== n) })}>
                remove
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Loaded statements</h2>
        <ul className="plain">
          {data.sources.map((s, i) => (
            <li key={i}>
              <strong>{s.fileName}</strong> — {formatDate(s.from)} to {formatDate(s.to)}, {s.rows} transactions
            </li>
          ))}
        </ul>
        <p className="muted small">
          {data.txns.length} transactions stored in this browser only. Nothing is uploaded to a server unless you ask a
          question with Claude, which sends a summary of members and payments.
        </p>
        <div className="row">
          <button onClick={() => setSettings(() => ({ ...DEFAULT_SETTINGS }))}>Reset settings</button>
          <button
            className="danger"
            onClick={() => {
              if (confirm("Remove all statement data from this browser?")) onClear();
            }}
          >
            Clear all data
          </button>
        </div>
      </section>
    </div>
  );
}

function NumberField(props: { label: string; hint: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input type="number" min={0} value={props.value} onChange={(e) => props.onChange(Math.max(0, Number(e.target.value)))} />
      <span className="muted small">{props.hint}</span>
    </label>
  );
}
