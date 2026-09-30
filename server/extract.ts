import type Anthropic from "@anthropic-ai/sdk";
import { claude, MODEL, parseJsonResponse, toClaudeError } from "./claude";

const SYSTEM = `You read screenshots of a martial-arts gym's member list — for example a WhatsApp group's participant list, a contacts list, a spreadsheet or a membership app — and transcribe the people in it.

Return every person visible, in on-screen order, with their name exactly as shown (keep the spelling; drop emoji and decorations) and their phone number if one is shown. Skip anything that isn't a member: the group or app name, headings, buttons, timestamps, message text, "You", and admin or status labels. If an entry shows only a phone number with no name, include it with name set to the number. Do not guess text you can't read; leave out entries that are cut off.`;

const SCHEMA = {
  type: "object",
  properties: {
    people: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          phone: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["name", "phone"],
        additionalProperties: false,
      },
    },
  },
  required: ["people"],
  additionalProperties: false,
};

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export interface ExtractedPerson {
  name: string;
  phone: string | null;
}

export async function extractNames(images: { data: string; mediaType: ImageType }[]): Promise<ExtractedPerson[]> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...images.map((img) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: img.mediaType, data: img.data },
    })),
    { type: "text", text: `Transcribe the members in ${images.length === 1 ? "this screenshot" : `these ${images.length} screenshots`}.` },
  ];
  let response;
  try {
    response = await claude().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content }],
    });
  } catch (err) {
    throw toClaudeError(err);
  }
  return parseJsonResponse<{ people: ExtractedPerson[] }>(response).people;
}
