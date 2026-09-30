import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { diffDays, formatDate, formatMonth, monthKey } from "../lib/dates";
import { money, moneyShort } from "../lib/format";
import { activeMembers, dueForRenewal, monthly, renewingSoon, type Analysis } from "../lib/members";
import { CATEGORY_LABELS, type Member, type Settings } from "../lib/types";
import { DataTable } from "./DataTable";
import { useChartTheme } from "./useChartTheme";

interface Props {
  analysis: Analysis;
  settings: Settings;
  onOpenMember: (id: string) => void;
}

const SERIES = ["membership", "dropin", "merch", "other"] as const;

export function Overview({ analysis, settings, onOpenMember }: Props) {
  const theme = useChartTheme();
  const [showTable, setShowTable] = useState(false);
  const months = useMemo(() => monthly(analysis), [analysis]);
  const active = activeMembers(analysis.members);
  const soon = renewingSoon(analysis.members, settings.renewSoonDays);
  const due = dueForRenewal(analysis.members);

  const totalRevenue = months.reduce((s, r) => s + r.revenue, 0);
  const asOfMonth = months.find((r) => r.month === monthKey(analysis.asOf));
  const chartData = months.map((r) => ({ label: formatMonth(r.month), ...r.byCategory, revenue: r.revenue, active: r.activeAtMonthEnd }));
  const staleDays = analysis.dataTo ? diffDays(analysis.asOf, analysis.dataTo) : 0;

  return (
    <div className="overview">
      {staleDays > 0 && (
        <p className="notice warn">
          Statuses are as of {formatDate(analysis.asOf)}, but the latest transaction loaded is from{" "}
          {formatDate(analysis.dataTo)}. Payments made after that won't show until you upload a newer statement.
        </p>
      )}

      <div className="kpis">
        <Kpi label="Active members" value={String(active.length)} sub={`as of ${formatDate(analysis.asOf)}`} />
        <Kpi
          label={`Renewing in next ${settings.renewSoonDays} days`}
          value={String(soon.length)}
          sub={soon.length ? `next: ${soon[0].name} (${formatDate(soon[0].expiry)})` : "none coming up"}
        />
        <Kpi label="Due for renewal" value={String(due.length)} sub={`expired in the last ${settings.dueWindowDays} days`} />
        <Kpi
          label={`Revenue · ${formatMonth(monthKey(analysis.asOf))}`}
          value={money(asOfMonth?.revenue ?? 0)}
          sub={`${money(totalRevenue)} across all loaded months`}
        />
      </div>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Month-wise revenue</h2>
            <p className="muted small">Split by type. Bank interest, dividends, refunds and owner transfers are excluded.</p>
          </div>
          <button className="ghost" onClick={() => setShowTable((v) => !v)}>
            {showTable ? "Show chart" : "Show table"}
          </button>
        </div>
        {showTable ? (
          <DataTable
            columns={["Month", ...SERIES.map((s) => CATEGORY_LABELS[s]), "Total", "New members"]}
            rows={months.map((r) => [
              formatMonth(r.month),
              ...SERIES.map((s) => money(r.byCategory[s])),
              money(r.revenue),
              r.newMembers,
            ])}
          />
        ) : (
          <div className="chart">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke={theme.grid} />
                <XAxis dataKey="label" tick={{ fill: theme.axis, fontSize: 12 }} tickLine={false} axisLine={{ stroke: theme.grid }} />
                <YAxis tickFormatter={moneyShort} tick={{ fill: theme.axis, fontSize: 12 }} tickLine={false} axisLine={false} width={56} />
                <Tooltip
                  cursor={{ fill: theme.grid, opacity: 0.5 }}
                  content={({ active: on, payload, label }) =>
                    on && payload?.length ? (
                      <div className="tooltip">
                        <strong>{label}</strong>
                        {[...payload].reverse().map((p) => (
                          <div key={String(p.dataKey)} className="tooltip-row">
                            <span className="swatch" style={{ background: p.color }} />
                            <span>{p.name}</span>
                            <span className="num">{money(Number(p.value))}</span>
                          </div>
                        ))}
                        <div className="tooltip-row total">
                          <span />
                          <span>Total</span>
                          <span className="num">{money(Number(payload[0].payload.revenue))}</span>
                        </div>
                      </div>
                    ) : null
                  }
                />
                <Legend
                  content={() => (
                    <ul className="legend">
                      {SERIES.map((s, i) => (
                        <li key={s}>
                          <span className="swatch" style={{ background: theme.series[i] }} />
                          {CATEGORY_LABELS[s]}
                        </li>
                      ))}
                    </ul>
                  )}
                />
                {SERIES.map((s, i) => (
                  <Bar
                    key={s}
                    dataKey={s}
                    name={CATEGORY_LABELS[s]}
                    stackId="rev"
                    fill={theme.series[i]}
                    stroke={theme.surface}
                    strokeWidth={1}
                    maxBarSize={44}
                    radius={i === SERIES.length - 1 ? [4, 4, 0, 0] : 0}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Active members at month end</h2>
        <p className="muted small">The latest month is counted up to {formatDate(analysis.asOf)}.</p>
        <div className="chart">
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke={theme.grid} />
              <XAxis dataKey="label" tick={{ fill: theme.axis, fontSize: 12 }} tickLine={false} axisLine={{ stroke: theme.grid }} />
              <YAxis allowDecimals={false} tick={{ fill: theme.axis, fontSize: 12 }} tickLine={false} axisLine={false} width={40} />
              <Tooltip
                content={({ active: on, payload, label }) =>
                  on && payload?.length ? (
                    <div className="tooltip">
                      <strong>{label}</strong>
                      <div>{payload[0].value} active</div>
                    </div>
                  ) : null
                }
              />
              <Line type="linear" dataKey="active" stroke={theme.series[0]} strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 6 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="lists">
        <MemberList
          title={`Up for renewal in the next ${settings.renewSoonDays} days`}
          empty="No memberships expire this week."
          members={soon}
          detail={(m) => (m.daysLeft === 0 ? "expires today" : `in ${m.daysLeft} day${m.daysLeft === 1 ? "" : "s"}`)}
          tone="warn"
          onOpen={onOpenMember}
        />
        <MemberList
          title="Due for renewal"
          empty="Nobody is overdue."
          members={due}
          detail={(m) => `expired ${-m.daysLeft!} day${m.daysLeft === -1 ? "" : "s"} ago`}
          tone="bad"
          onOpen={onOpenMember}
        />
        <MemberList
          title="Active members"
          empty="No active members on this date."
          members={active}
          detail={(m) => `until ${formatDate(m.expiry)}`}
          tone="good"
          onOpen={onOpenMember}
        />
      </div>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card kpi">
      <p className="muted small">{label}</p>
      <p className="kpi-value">{value}</p>
      <p className="muted small">{sub}</p>
    </div>
  );
}

function MemberList(props: {
  title: string;
  empty: string;
  members: Member[];
  detail: (m: Member) => string;
  tone: "good" | "warn" | "bad";
  onOpen: (id: string) => void;
}) {
  return (
    <section className="card member-list">
      <h2>
        {props.title} <span className={`count ${props.tone}`}>{props.members.length}</span>
      </h2>
      {props.members.length === 0 ? (
        <p className="muted">{props.empty}</p>
      ) : (
        <ul>
          {props.members.map((m) => (
            <li key={m.id}>
              <button className="link-row" onClick={() => props.onOpen(m.id)}>
                <span className="name">{m.name}</span>
                <span className="muted small">
                  {m.currentPlan} · {props.detail(m)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
