import { ASK_INSTRUCTIONS, EXTRACT_INSTRUCTIONS } from "./prompts";
import type { QueryResult } from "./query";

/**
 * Claude access for the browser. Published as a claude.ai artifact, the page asks Claude
 * through the viewer's own account (the artifact `sample` capability). Run locally, it uses
 * this project's API server, which needs ANTHROPIC_API_KEY.
 */

interface SampleError {
  code: string;
  message: string;
}
interface Sample {
  json<T>(input: string, options?: { images?: Blob[]; modelTier?: "quick" | "default" | "complex" }): Promise<T>;
  limits(): Promise<{ images?: { maxCount: number } }>;
}
declare global {
  interface Window {
    claude?: { use(name: "sample"): Promise<Sample | null> };
  }
}

export type AiBackend = { kind: "artifact"; sample: Sample; imagesPerCall: number } | { kind: "server" };

let backend: Promise<AiBackend | null> | null = null;

/** Works out once which way this page can reach Claude, or null if it can't. */
export function aiBackend(): Promise<AiBackend | null> {
  backend ??= (async () => {
    if (window.claude?.use) {
      const sample = await window.claude.use("sample").catch(() => null);
      if (!sample) return null;
      const limits = await sample.limits().catch(() => null);
      return { kind: "artifact", sample, imagesPerCall: limits?.images?.maxCount ?? 0 } as const;
    }
    try {
      const health = await fetch("/api/health").then((r) => r.json());
      return health.ai ? ({ kind: "server" } as const) : null;
    } catch {
      return null;
    }
  })();
  return backend;
}

const ERROR_COPY: Record<string, string> = {
  not_granted: "Claude wasn't allowed for this page. Reload the page to be asked again.",
  sampling_disabled: "Claude isn't available on this account.",
  rate_limited: "Claude is busy or your usage limit was reached. Try again in a little while.",
  session_expired: "Sign in to Claude again, then retry.",
  refused: "Claude declined to answer that. Try rephrasing the question.",
  invalid_json: "Claude's reply couldn't be read. Try again.",
  images_unavailable: "Images can't be sent to Claude from this view. Paste the names instead.",
  image_rejected: "One of the screenshots couldn't be read. Try a PNG or JPEG under 20 MB.",
  prompt_too_large: "There's too much data for one question. Ask about a shorter period.",
};

function sampleError(err: unknown): Error {
  const code = (err as SampleError)?.code;
  return new Error(ERROR_COPY[code] ?? "Claude couldn't answer just now. Try again.");
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json as T;
}

export async function askClaude(ai: AiBackend, question: string, context: unknown): Promise<QueryResult> {
  if (ai.kind === "server") {
    return { ...(await postJson<Omit<QueryResult, "engine">>("/api/ask", { question, context })), engine: "claude" };
  }
  const prompt = `${ASK_INSTRUCTIONS}

<data>
${JSON.stringify(context)}
</data>

Question: ${question}

Reply with only a JSON object: {"answer": string, "table": {"columns": string[], "rows": string[][]} | null, "member_ids": string[]}`;
  try {
    const r = await ai.sample.json<{ answer?: string; table?: QueryResult["table"]; member_ids?: string[] }>(prompt);
    if (typeof r?.answer !== "string") throw { code: "invalid_json" };
    return { answer: r.answer, table: r.table ?? null, memberIds: r.member_ids ?? [], engine: "claude" };
  } catch (err) {
    throw sampleError(err);
  }
}

export interface ExtractedPerson {
  name: string;
  phone: string | null;
}

/** Reads member names from screenshots; calls `onProgress` before each batch. */
export async function extractNames(
  ai: AiBackend,
  images: Blob[],
  onProgress: (done: number, total: number) => void,
): Promise<ExtractedPerson[]> {
  const perCall = ai.kind === "server" ? 3 : Math.max(1, ai.imagesPerCall);
  if (ai.kind === "artifact" && ai.imagesPerCall === 0) throw sampleError({ code: "images_unavailable" });
  const people: ExtractedPerson[] = [];
  for (let i = 0; i < images.length; i += perCall) {
    onProgress(i, images.length);
    const batch = images.slice(i, i + perCall);
    if (ai.kind === "server") {
      const encoded = await Promise.all(batch.map(toBase64Png));
      people.push(...(await postJson<{ people: ExtractedPerson[] }>("/api/extract-names", { images: encoded })).people);
      continue;
    }
    try {
      const r = await ai.sample.json<{ people?: ExtractedPerson[] }>(
        `${EXTRACT_INSTRUCTIONS}

The attached ${batch.length === 1 ? "image is a screenshot" : `${batch.length} images are screenshots`} of the member list.
Reply with only a JSON object: {"people": [{"name": string, "phone": string | null}]}`,
        { images: batch },
      );
      people.push(...(r?.people ?? []).filter((p) => typeof p?.name === "string"));
    } catch (err) {
      throw sampleError(err);
    }
  }
  return people;
}

/** Shrinks a screenshot so its long edge is at most 1600px before sending it to the server. */
async function toBase64Png(file: Blob): Promise<{ data: string; mediaType: "image/png" }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/png");
  return { data: url.slice(url.indexOf(",") + 1), mediaType: "image/png" };
}
