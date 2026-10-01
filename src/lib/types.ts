/** One row of a bank statement. Dates are ISO `YYYY-MM-DD`. */
export interface Txn {
  id: string;
  date: string;
  narration: string;
  ref: string;
  withdrawal: number;
  deposit: number;
  balance: number | null;
}

export type Category =
  | "membership"
  | "dropin"
  | "merch"
  | "other"
  | "refund"
  | "interest"
  | "investment"
  | "owner"
  | "expense";

/** Categories that count as gym revenue. The rest are shown but excluded from revenue. */
export const REVENUE_CATEGORIES: Category[] = ["membership", "dropin", "merch", "other"];

export const CATEGORY_LABELS: Record<Category, string> = {
  membership: "Membership fees",
  dropin: "Drop-in classes",
  merch: "Merch & misc",
  other: "Other income",
  refund: "Refunds received",
  interest: "Bank interest",
  investment: "Dividends / investments",
  owner: "Owner / family transfers",
  expense: "Withdrawal",
};

/** Parsed details of a credit's counterparty. */
export interface Payer {
  name: string;
  vpa: string | null;
  remark: string;
}

export interface Payment {
  txnId: string;
  date: string;
  amount: number;
  category: Category;
  payer: Payer | null;
  memberId: string | null;
  /** Membership coverage window this payment bought, if it is a membership fee. */
  coverFrom?: string;
  coverTo?: string;
  planLabel?: string;
}

export type MemberStatus = "active" | "due" | "lapsed";

export interface Member {
  id: string;
  name: string;
  vpas: string[];
  payments: Payment[];
  totalPaid: number;
  membershipPaid: number;
  firstPaid: string;
  lastPaid: string;
  /** Last day of paid membership coverage (null if they never paid a membership fee). */
  expiry: string | null;
  status: MemberStatus;
  /** Days from the as-of date to expiry (negative = expired that many days ago). */
  daysLeft: number | null;
  currentPlan: string | null;
}

export interface PlanTier {
  /** Smallest amount (inclusive) that buys this plan. */
  minAmount: number;
  months: number;
  label: string;
}

export interface Settings {
  planTiers: PlanTier[];
  /** Credits below this are never treated as membership fees. */
  minFee: number;
  /** Credits at or below this are drop-in classes. */
  dropInMax: number;
  /** A renewal paid within this many days after expiry continues from the old expiry. */
  renewalGraceDays: number;
  /** Expired members stay "due for renewal" for this many days, then count as lapsed. */
  dueWindowDays: number;
  /** Window for "renewing soon". */
  renewSoonDays: number;
  /** Payer names (normalised, upper case) treated as owner/family transfers. */
  ownerPayers: string[];
  /** Per-transaction category corrections. */
  categoryOverrides: Record<string, Category>;
  /** Display-name overrides keyed by member id. */
  memberNames: Record<string, string>;
}

/** The bank's own totals, printed at the end of the statement. */
export interface StatementSummary {
  opening: number;
  debits: number;
  credits: number;
  closing: number;
  debitCount: number | null;
  creditCount: number | null;
}

export interface StatementSource {
  fileName: string;
  accountHolder: string | null;
  /** First and last transaction dates. */
  from: string | null;
  to: string | null;
  rows: number;
  /** The period printed on the statement ("Statement From … To …"), when present. */
  periodFrom?: string | null;
  periodTo?: string | null;
  summary?: StatementSummary | null;
}

export interface Dataset {
  txns: Txn[];
  sources: StatementSource[];
  accountHolder: string | null;
}

/** A person on the gym's own member list (typed in, pasted, or scanned from screenshots). */
export interface RosterEntry {
  id: string;
  /** The person's name, with contact-list labels like "Flamingo" or "April Trial" removed. */
  name: string;
  /** The entry exactly as it appeared on the list, when it differs from the name. */
  label?: string;
  /** Labels pulled out of the entry: "Trial", "Enquiry", "Friend of Asha", "Age 14", "April 2026"… */
  tags?: string[];
  /** Digits only, last 10 digits of an Indian mobile number when present. */
  phone: string | null;
  source: string;
  /** Manual link to a statement member: a member id, or null to force "no match". Undefined = automatic. */
  linkedMemberId?: string | null;
}
