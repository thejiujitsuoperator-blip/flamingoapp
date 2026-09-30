import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ask } from "./ask";
import { aiEnabled, ClaudeError } from "./claude";
import { extractNames, IMAGE_TYPES, type ImageType } from "./extract";

const app = express();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ai: aiEnabled() });
});

function sendError(res: express.Response, err: unknown) {
  if (err instanceof ClaudeError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
}

function requireAi(res: express.Response): boolean {
  if (aiEnabled()) return true;
  res.status(503).json({ error: "AI features are off: set ANTHROPIC_API_KEY on the server." });
  return false;
}

app.post("/api/ask", express.json({ limit: "5mb" }), async (req, res) => {
  const { question, context } = req.body ?? {};
  if (typeof question !== "string" || !question.trim() || question.length > 1000 || typeof context !== "object") {
    res.status(400).json({ error: "Send { question, context }." });
    return;
  }
  if (!requireAi(res)) return;
  try {
    res.json(await ask(question.trim(), context));
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/extract-names", express.json({ limit: "30mb" }), async (req, res) => {
  const images = req.body?.images;
  const valid =
    Array.isArray(images) &&
    images.length > 0 &&
    images.length <= 5 &&
    images.every(
      (i) => typeof i?.data === "string" && i.data.length > 0 && IMAGE_TYPES.includes(i.mediaType as ImageType),
    );
  if (!valid) {
    res.status(400).json({ error: "Send { images: [{ data: <base64>, mediaType }] } with 1–5 PNG/JPEG/WebP/GIF images." });
    return;
  }
  if (!requireAi(res)) return;
  try {
    res.json({ people: await extractNames(images) });
  } catch (err) {
    sendError(res, err);
  }
});

if (process.env.NODE_ENV === "production") {
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
  app.use(express.static(dist));
  app.get("/{*path}", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`API listening on http://localhost:${port} (AI features ${aiEnabled() ? "on" : "off"})`);
});
