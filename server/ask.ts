import { ASK_INSTRUCTIONS } from "../src/lib/prompts";
import { claude, MODEL, parseJsonResponse, toClaudeError } from "./claude";

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
      system: ASK_INSTRUCTIONS,
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
