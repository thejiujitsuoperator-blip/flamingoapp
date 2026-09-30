import type { Category, Payer, Settings, Txn } from "./types";

const UPI_RE = /^UPI-(.+?)-([^\s@]+@[A-Za-z0-9.]+)-([A-Z]{4}0[A-Z0-9]{6})-(\d+)-?(.*)$/;
const NEFT_RE = /^(?:NEFT CR|RTGS CR)-[A-Z0-9]+-(.+?)-/;
const IMPS_RE = /^IMPS-\d+-(.+?)-/;

/** Remarks the payer's UPI app fills in by default; they carry no information. */
const EMPTY_REMARKS = new Set([
  "", "UPI", "NA", "NO REMARKS", "PAYMENT FROM PHONE", "SENT USING PAYTM U", "PAID VIA MOBIKWIK",
  "UPI PAYMENT", "REMARK", "PAY TO BHARATPE ME", "PAYMENT",
]);

export function normaliseName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/^(MR|MS|MRS|DR|SHRI|SMT)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Bank-masked names like "XXXPGN KOTAK 811 SAV" don't identify a person. */
export function isMaskedName(name: string): boolean {
  return /XXX|KOTAK 811|\bSAV\b/.test(name);
}

export function extractPayer(narration: string): Payer | null {
  const upi = narration.match(UPI_RE);
  if (upi) {
    const remark = upi[5].trim().toUpperCase();
    return {
      name: normaliseName(upi[1]),
      vpa: upi[2].toLowerCase(),
      remark: EMPTY_REMARKS.has(remark) ? "" : remark,
    };
  }
  const bank = narration.match(NEFT_RE) ?? narration.match(IMPS_RE);
  if (bank) return { name: normaliseName(bank[1]), vpa: null, remark: "" };
  return null;
}

const MERCH_RE = /SHORTS|MERCH|RASH ?GUARD|\bGI\b|T ?SHIRT|TEE\b|BELT|HOODIE|PATCH|JERSEY/;
const DROPIN_RE = /DROP ?IN|TRIAL|SINGLE CLASS/;

function surname(name: string): string | null {
  const parts = name.split(" ").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : null;
}

/** Rule-based category for a transaction. Per-transaction overrides in settings win. */
export function classify(txn: Txn, settings: Settings, accountHolder: string | null): Category {
  const override = settings.categoryOverrides[txn.id];
  if (override) return override;
  if (!txn.deposit) return "expense";

  const n = txn.narration.toUpperCase();
  if (n.startsWith("INTEREST PAID")) return "interest";
  if (n.startsWith("ACH C-") || /\bDIV\b|DIV\d|FINDIV|INTDIV|FNLDIV|FINAL DIV/.test(n)) return "investment";
  if (/REFUND|^UPIRET/.test(n)) return "refund";

  const payer = extractPayer(txn.narration);
  if (!payer) return "other";

  if (settings.ownerPayers.includes(payer.name)) return "owner";
  const holderSurname = accountHolder ? surname(normaliseName(accountHolder)) : null;
  if (holderSurname && surname(payer.name) === holderSurname) return "owner";

  const amt = txn.deposit;
  if (DROPIN_RE.test(payer.remark) || amt <= settings.dropInMax) return "dropin";
  if (MERCH_RE.test(payer.remark)) return "merch";
  // Fees are round amounts (₹3,500, ₹6,000…); odd amounts like ₹4,696 are shop sales.
  if (amt < settings.minFee || amt % 250 > 1) return "merch";
  return "membership";
}
