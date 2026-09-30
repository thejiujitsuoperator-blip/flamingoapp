import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ask, AskError, aiEnabled } from "./ask";

const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ai: aiEnabled() });
});

app.post("/api/ask", async (req, res) => {
  const { question, context } = req.body ?? {};
  if (typeof question !== "string" || !question.trim() || question.length > 1000 || typeof context !== "object") {
    res.status(400).json({ error: "Send { question, context }." });
    return;
  }
  if (!aiEnabled()) {
    res.status(503).json({ error: "AI answers are off: set ANTHROPIC_API_KEY on the server." });
    return;
  }
  try {
    res.json(await ask(question.trim(), context));
  } catch (err) {
    if (err instanceof AskError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Unexpected error answering the question." });
  }
});

if (process.env.NODE_ENV === "production") {
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
  app.use(express.static(dist));
  app.get("/{*path}", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`API listening on http://localhost:${port} (AI answers ${aiEnabled() ? "on" : "off"})`);
});
