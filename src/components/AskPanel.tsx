import { useEffect, useState } from "react";
import { aiBackend, askClaude, type AiBackend } from "../lib/ai";
import { buildAiContext } from "../lib/aiContext";
import type { Analysis } from "../lib/members";
import { EXAMPLE_QUESTIONS, localQuery, type QueryResult } from "../lib/query";
import type { RosterMatch } from "../lib/roster";
import type { Settings } from "../lib/types";
import { DataTable } from "./DataTable";

interface Props {
  analysis: Analysis;
  settings: Settings;
  roster: RosterMatch[];
  onOpenMember: (id: string) => void;
}

export function AskPanel({ analysis, settings, roster, onOpenMember }: Props) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState<AiBackend | null>(null);
  const [alwaysClaude, setAlwaysClaude] = useState(false);

  useEffect(() => {
    aiBackend().then(setAi);
  }, []);

  async function run(q: string) {
    if (!q.trim()) return;
    setQuestion(q);
    setError(null);
    // The built-in parser answers common questions instantly; Claude takes the rest.
    const local = alwaysClaude && ai ? null : localQuery(q, analysis, settings.renewSoonDays, roster);
    if (local) {
      setResult(local);
      return;
    }
    if (!ai) {
      setResult(null);
      setError(
        "I didn't understand that. Try asking about revenue, renewals, active members, your member list, a member's name, or payments in a month.",
      );
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      setResult(await askClaude(ai, q, buildAiContext(analysis, settings, roster)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const memberByName = new Map(analysis.members.map((m) => [m.name, m.id]));

  return (
    <section className="card ask" aria-label="Ask a question">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(question);
        }}
        className="ask-form"
      >
        <input
          type="search"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask in plain English — e.g. “Who hasn't renewed since January?”"
          aria-label="Question"
        />
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Thinking…" : "Ask"}
        </button>
      </form>
      <div className="ask-meta">
        <div className="chips">
          {EXAMPLE_QUESTIONS.map((q) => (
            <button key={q} className="chip" onClick={() => run(q)} disabled={busy}>
              {q}
            </button>
          ))}
        </div>
        {ai && (
          <label className="toggle small">
            <input id="always-claude" type="checkbox" checked={alwaysClaude} onChange={(e) => setAlwaysClaude(e.target.checked)} />
            Always ask Claude
          </label>
        )}
      </div>

      {busy && <p className="muted">Asking Claude… this can take up to a minute.</p>}
      {error && <p className="ask-error">{error}</p>}
      {result && (
        <div className="ask-result">
          <p>
            {result.answer}{" "}
            <span className="badge">{result.engine === "claude" ? "Claude" : "Built-in"}</span>
          </p>
          {result.table && result.table.rows.length > 0 && (
            <DataTable
              columns={result.table.columns}
              rows={result.table.rows}
              onRowClick={(row) => {
                const id = memberByName.get(String(row[0])) ?? memberByName.get(String(row[1]));
                if (id) onOpenMember(id);
              }}
            />
          )}
        </div>
      )}
    </section>
  );
}
