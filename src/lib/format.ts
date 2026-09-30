const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

export function money(n: number): string {
  return inr.format(Math.round(n));
}

/** Compact axis labels: ₹12k, ₹1.2L. */
export function moneyShort(n: number): string {
  if (Math.abs(n) >= 100_000) return `₹${+(n / 100_000).toFixed(1)}L`;
  if (Math.abs(n) >= 1_000) return `₹${+(n / 1_000).toFixed(1)}k`;
  return `₹${n}`;
}

export function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());
}
