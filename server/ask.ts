import { claude, MODEL, parseJsonResponse, toClaudeError } from "./claude";

const SYSTEM = `You answer questions about a martial-arts gym's members and payments for the gym owner.

You receive a JSON snapshot built from the gym's bank statements:
- members: people who have paid a membership fee, with status relative to as_of ("active" = membership covers as_of, "due" = expired within due_window_days, "lapsed" = expired longer ago), expiry, days_left and total_paid.
- payments: every credit. category is one of membership, dropin, merch, other (these four are revenue) or refund, interest, investment, owner (not revenue). "covers" is the membership period a fee bought.
- monthly: month-wise revenue split and member counts.
- rules: how plans and statuses were derived.
- roster (may be empty): the gym's own member list. Each entry has the name as the gym knows it, the matched member_id from the statements (null when no payment was found) and paid_by_other when someone else pays for them (member_id is then the payer). Member names already use the roster name where matched. Use it for questions about who is on the list but not paying, or paying but not on the list.

Answer only from this data. Amounts are in Indian rupees; write them like ₹12,500. Interpret relative dates ("this month", "next 7 days") against as_of, not today's calendar date. "Up for renewal in the next N days" means active members with 0 <= days_left <= N. When the question asks for a list or breakdown, put it in "table" (strings in every cell) and keep "answer" to one to three sentences; otherwise set table to null. Put the ids of members the answer is about in member_ids. If the data can't answer the question, say so plainly and suggest what would.`;

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    table: {
      anyOf: [
        {
          type: "object",
          properties: {
            columns: { type: "array", items: { type: "string" } },
            rows: { type: "array", items: { type: "array", items: { type: "string" } } },
          },
          required: ["columns", "rows"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
    member_ids: { type: "array", items: { type: "string" } },
  },
  required: ["answer", "table", "member_ids"],
  additionalProperties: false,
};

export interface AskResult {
  answer: string;
  table: { columns: string[]; rows: string[][] } | null;
  memberIds: string[];
}

export async function ask(question: string, context: unknown): Promise<AskResult> {
  let response;
  try {
    response = await claude().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // On a safety decline the API re-runs the request on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: ANSWER_SCHEMA } },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            // Data first and cached, so follow-up questions on the same data reuse it.
            { type: "text", text: `<data>\n${JSON.stringify(context)}\n</data>`, cache_control: { type: "ephemeral" } },
            { type: "text", text: question },
          ],
        },
      ],
    });
  } catch (err) {
    throw toClaudeError(err);
  }
  const parsed = parseJsonResponse<{ answer: string; table: AskResult["table"]; member_ids: string[] }>(response);
  return { answer: parsed.answer, table: parsed.table, memberIds: parsed.member_ids };
}
