import type Anthropic from "@anthropic-ai/sdk";
import { EXTRACT_INSTRUCTIONS } from "../src/lib/prompts";
import { claude, MODEL, parseJsonResponse, toClaudeError } from "./claude";

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
      system: EXTRACT_INSTRUCTIONS,
      messages: [{ role: "user", content }],
    });
  } catch (err) {
    throw toClaudeError(err);
  }
  return parseJsonResponse<{ people: ExtractedPerson[] }>(response).people;
}
