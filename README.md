# Flamingo Members

A dashboard for a membership business (built for a jiu-jitsu gym) that works straight from your bank statement.
Upload an HDFC account statement (`.xls`) and get:

- **Member profiles** with each member's full payment history and the membership period each payment covered
- **Month-wise revenue**, split into membership fees, drop-in classes, merch and other income
- **Active members**, members **due for renewal**, and members **up for renewal in the next 7 days**
- **Your member list vs. the bank**: scan screenshots of your member list (or paste names) and see who on it is
  paid up, who has no payments, who is paid for by someone else, and who pays but isn't on the list
- **Plain-English questions**, e.g. "who hasn't renewed since January?", "revenue in Feb", "payments by Meera"

## Running it

```bash
npm install
npm run dev          # web app on http://localhost:5173, API on :8787
```

Production build:

```bash
npm run build
npm start            # serves the built app and API on http://localhost:8787
```

To answer free-form questions with Claude, set `ANTHROPIC_API_KEY` in the server's environment (see `.env.example`).
Without it, questions are answered by a built-in parser that understands renewals, revenue by month or date range,
active/due/lapsed/new members, top payers, a member's name, and amount filters.

## How the data is interpreted

Statements are parsed in the browser and stored only in that browser's `localStorage`. Upload more statements any
time; overlapping transactions are de-duplicated. If you use Claude answers, a summary of members and payments is
sent to the server with the question.

Each credit is classified:

| Type | Rule (defaults, editable in **Settings**) |
|---|---|
| Bank interest / dividends / refunds | recognised from the narration (`INTEREST PAID`, `ACH C-`, `REFUND`…) and excluded from revenue |
| Owner / family transfers | payer shares the account holder's surname, or is listed in Settings; excluded from revenue |
| Drop-in class | ≤ ₹1,000, or the UPI note mentions a drop-in |
| Merch & misc | UPI note mentions shorts/merch/gi etc., the amount is under ₹2,500, or it isn't a round amount (e.g. ₹4,696) |
| Membership fee | everything else paid over UPI |

Any single transaction can be re-classified from the **Transactions** tab.

**Members.** Payments are grouped into people by UPI id and payer name, so someone paying from two UPI apps shows up
once. You can rename a member from their profile.

**Plans.** A fee's amount decides how long it covers: by default under ₹8,000 is monthly, ₹8,000+ quarterly,
₹20,000+ half-yearly, ₹34,000+ annual. Set these to your real price list in **Settings**. A renewal paid early (or
up to 10 days late) extends the current membership instead of restarting it.

**Statuses** are worked out for the "Status as of" date (default: the last transaction in your statements):
*active* until the paid period ends, *due for renewal* for 30 days after that, then *lapsed*.

## Member list

The **Member list** tab takes names from screenshots (read by Claude; needs `ANTHROPIC_API_KEY`) or pasted text,
one person per line with an optional phone number. Each name is matched to a payer in the statements using:

- phone numbers against UPI ids like `9876501234@ybl`
- names, allowing for the bank's truncated or run-together names ("MEERA LAKSHMI VENKAT", "ROHANDESAI")
  and UPI ids made of the name ("nehajoshi@okicici")
- payment notes, so a member whose fee someone else pays ("TARA MENON" on someone else's transfer) is still found

A shared first name alone is not treated as a match. Matched members are shown under their list name everywhere in
the dashboard. Wrong or missing matches can be fixed from the dropdown on each row.

## Development

```bash
npm test            # unit tests (parser, classification, membership logic, query engine)
npm run typecheck
```

Code layout: `src/lib` holds the data logic (parsing, classification, membership analysis, the built-in query
engine), `src/components` the UI, and `server/` the small Express API that calls Claude.

Don't commit real statements: `.xls`/`.xlsx` files are git-ignored. Use **Try with demo data** on the start screen
to explore with made-up data.
