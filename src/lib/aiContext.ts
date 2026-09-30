import { monthly, type Analysis } from "./members";
import type { Settings } from "./types";

/** Compact snapshot of the analysed data that is sent with an AI question. */
export function buildAiContext(a: Analysis, settings: Settings) {
  const names = new Map(a.members.map((m) => [m.id, m.name]));
  return {
    as_of: a.asOf,
    data_from: a.dataFrom,
    data_to: a.dataTo,
    currency: "INR",
    rules: {
      plan_tiers: settings.planTiers,
      due_window_days: settings.dueWindowDays,
      renew_soon_days: settings.renewSoonDays,
      revenue_categories: ["membership", "dropin", "merch", "other"],
    },
    members: a.members.map((m) => ({
      id: m.id,
      name: m.name,
      status: m.status,
      plan: m.currentPlan,
      expiry: m.expiry,
      days_left: m.daysLeft,
      first_paid: m.firstPaid,
      total_paid: m.totalPaid,
    })),
    payments: a.payments.map((p) => ({
      date: p.date,
      amount: p.amount,
      category: p.category,
      member_id: p.memberId,
      payer: p.memberId ? names.get(p.memberId) : (p.payer?.name ?? null),
      note: p.payer?.remark || undefined,
      covers: p.coverFrom ? `${p.coverFrom}..${p.coverTo}` : undefined,
    })),
    monthly: monthly(a).map((r) => ({
      month: r.month,
      revenue: r.revenue,
      membership: r.byCategory.membership,
      dropin: r.byCategory.dropin,
      merch: r.byCategory.merch,
      other: r.byCategory.other,
      new_members: r.newMembers,
      active_at_month_end: r.activeAtMonthEnd,
    })),
  };
}

export type AiContext = ReturnType<typeof buildAiContext>;
