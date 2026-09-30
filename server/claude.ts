import Anthropic from "@anthropic-ai/sdk";

export const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";

export class ClaudeError extends Error {
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

export function claude(): Anthropic {
  client ??= new Anthropic();
  return client;
}

/** Converts SDK errors into messages that are safe to show in the UI. */
export function toClaudeError(err: unknown): unknown {
  if (err instanceof Anthropic.AuthenticationError) return new ClaudeError("The server's Anthropic API key is invalid.", 502);
  if (err instanceof Anthropic.RateLimitError) return new ClaudeError("Rate limited by the Claude API — try again shortly.", 429);
  if (err instanceof Anthropic.BadRequestError) return new ClaudeError(`Claude API rejected the request: ${err.message}`, 502);
  if (err instanceof Anthropic.APIError) return new ClaudeError(`Claude API error (${err.status ?? "network"}).`, 502);
  return err;
}

type Response = Awaited<ReturnType<Anthropic["beta"]["messages"]["create"]>>;

/** Checks the stop reason and parses the structured-output JSON text. */
export function parseJsonResponse<T>(response: Response): T {
  if (!("content" in response)) throw new ClaudeError("Unexpected streaming response.", 500);
  if (response.stop_reason === "refusal") throw new ClaudeError("Claude declined this request.", 422);
  if (response.stop_reason === "max_tokens") throw new ClaudeError("The response was too long — try a smaller request.", 422);
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return JSON.parse(text) as T;
}
