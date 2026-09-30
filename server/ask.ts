import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";

const SYSTEM = `You answer questions about a martial-arts gym's members and payments for the gym owner.

You receive a JSON snapshot built from the gym's bank statements:
- members: people who have paid a membership fee, with status relative to as_of ("active" = membership covers as_of, "due" = expired within due_window_days, "lapsed" = expired longer ago), expiry, days_left and total_paid.
- payments: every credit. category is one of membership, dropin, merch, other (these four are revenue) or refund, interest, investment, owner (not revenue). "covers" is the membership period a fee bought.
- monthly: month-wise revenue split and member counts.
- rules: how plans and statuses were derived.

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

export class AskError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

let client: Anthropic | null = null;

export function aiEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export async function ask(question: string, context: unknown): Promise<AskResult> {
  client ??= new Anthropic();
  let response;
  try {
    response = await client.beta.messages.create({
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
    if (err instanceof Anthropic.AuthenticationError) throw new AskError("The server's Anthropic API key is invalid.", 502);
    if (err instanceof Anthropic.RateLimitError) throw new AskError("Rate limited by the Claude API — try again shortly.", 429);
    if (err instanceof Anthropic.BadRequestError) throw new AskError(`Claude API rejected the request: ${err.message}`, 502);
    if (err instanceof Anthropic.APIError) throw new AskError(`Claude API error (${err.status ?? "network"}).`, 502);
    throw err;
  }

  if (response.stop_reason === "refusal") throw new AskError("Claude declined to answer this question.", 422);
  if (response.stop_reason === "max_tokens") throw new AskError("The answer was too long — try a narrower question.", 422);

  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const parsed = JSON.parse(text) as { answer: string; table: AskResult["table"]; member_ids: string[] };
  return { answer: parsed.answer, table: parsed.table, memberIds: parsed.member_ids };
}
