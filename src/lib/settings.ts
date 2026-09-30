import type { Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  planTiers: [
    { minAmount: 0, months: 1, label: "Monthly" },
    { minAmount: 8000, months: 3, label: "Quarterly" },
    { minAmount: 20000, months: 6, label: "Half-yearly" },
    { minAmount: 34000, months: 12, label: "Annual" },
  ],
  minFee: 2500,
  dropInMax: 1000,
  renewalGraceDays: 10,
  dueWindowDays: 30,
  renewSoonDays: 7,
  ownerPayers: [],
  categoryOverrides: {},
  memberNames: {},
};

export function planFor(amount: number, settings: Settings) {
  const tiers = [...settings.planTiers].sort((a, b) => a.minAmount - b.minAmount);
  let plan = tiers[0];
  for (const t of tiers) if (amount >= t.minAmount) plan = t;
  return plan;
}
