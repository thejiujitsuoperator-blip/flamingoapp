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

### As a claude.ai artifact

`npm run build:artifact` writes the whole app as one self-contained page, `dist-artifact/flamingo-members.html`,
for publishing as a private claude.ai artifact with the capabilities `db`, `assets`, `user`, `downloads`, `sample`
and `mcp` (Google Drive `create_file`). There, questions the built-in parser can't answer and screenshot scanning
go to Claude through the viewer's own claude.ai account, so no server or API key is needed.

### Claude answers when self-hosted

To answer free-form questions with Claude, set `ANTHROPIC_API_KEY` in the server's environment (see `.env.example`).
Without it, questions are answered by a built-in parser that understands renewals, revenue by month or date range,
active/due/lapsed/new members, top payers, a member's name, and amount filters.

## Upload history and audit

Nothing is ever overwritten. Each statement upload, each version of the member list and each manual change
(reclassified payment, corrected match, renamed member, settings edit) is added to a history, shown in the
**History** tab:

- **Statement uploads** keep the original file, the parsed rows, the bank's own summary, the settings in force at
  the time, and the results of these checks:

  | Check | Catches |
  |---|---|
  | Rows read vs the bank's summary (counts and totals) | rows missed or misread |
  | Running balance row by row, and against the bank's closing balance | missing or altered transactions |
  | Opening balance vs the previous statement's closing balance, and date gaps | gaps or overlaps between statements |
  | Overlapping dates vs earlier uploads, line by line | the bank's file changing after the fact |
  | Revenue for months already covered, before vs after | earlier months changing |
  | Same file uploaded twice (by fingerprint) | double counting (the upload is refused) |

- **Compare with now** rebuilds the dashboard as it stood right after any upload and shows, month by month, what
  reads differently today.
- For dates covered by more than one upload, the newest statement is used; the older ones stay in the history.

Where it's kept: on the published claude.ai page, in the page's own storage (owner writes, anyone it's shared with
can read), with each upload and member-list version also copied to a "Flamingo Members backups" folder in Google
Drive through the owner's claude.ai Google Drive connector. Run locally, the same history is kept in the browser's
`localStorage` (without the original files or Drive backups).

## How the data is interpreted

If you use Claude answers, a summary of members and payments is sent along with the question.

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

Contact-style labels are split off the name and kept as tags: "Karan Enquiry April 2026" becomes *Karan* with
tags *Enquiry* and *April 2026*; "Nikhil Pooja Friend" becomes *Nikhil*, *Friend of Pooja*; "Flamingo" is dropped.
People who only paid for merch or drop-in classes are shown with those payments rather than as "no payments".

A shared first name alone is not treated as a match, and a single-name entry ("Anil") is marked *Check this*
when several people on the list share that first name. Matched members are shown under their list name everywhere in
the dashboard. Wrong or missing matches can be fixed from the dropdown on each row.

## Development

```bash
npm test            # unit tests (parser, classification, membership logic, audit checks, query engine)
npm run typecheck
```

Code layout: `src/lib` holds the data logic (parsing, classification, membership analysis, the built-in query
engine), `src/components` the UI, and `server/` the small Express API that calls Claude.

Don't commit real statements: `.xls`/`.xlsx` files are git-ignored. Use **Try with demo data** on the start screen
to explore with made-up data.
