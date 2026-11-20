import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import * as t from "../db/schema";
import { getSetting } from "../store/settings";

/**
 * The AI agents Hearth knows about. Which one is connected is a
 * setting of this installation, not sample data, so it survives sample
 * switches and re-scans. Only Claude Code can be the operator today: it
 * can run with every built-in tool switched off, so it can act only
 * through Hearth's own tools.
 */
export const AGENT_CATALOG = [
  {
    id: "claude-code",
    name: "Claude Code",
    description:
      "Anthropic's agent, connected through Hearth's own tools with its shell, files, and web access switched off.",
    status: "available" as const,
    detail: null,
  },
  {
    id: "codex",
    name: "Codex",
    description: "OpenAI's coding agent, with Hearth's tools, the same as in the War Room.",
    status: "available" as const,
    detail: null,
  },
  {
    id: "openai-compatible",
    name: "OpenAI-compatible endpoint",
    description: "Any hosted or local model that speaks the OpenAI API.",
    status: "coming-later" as const,
    detail: null,
  },
  {
    id: "ollama",
    name: "Ollama",
    description:
      "Free models on your own hardware, run through Claude Code with the same tools and access. Slower, depending on your hardware.",
    status: "available" as const,
    detail: null,
  },
];

export async function ensureAgentCatalog(db: Database): Promise<void> {
  const operator = await getSetting(db, "operator_agent");
  const existing = new Map((await db.select().from(t.agents)).map((a) => [a.id, a]));
  for (const [i, a] of AGENT_CATALOG.entries()) {
    const status = operator === a.id ? ("connected" as const) : a.status;
    const row = existing.get(a.id);
    if (!row) {
      await db.insert(t.agents).values({ ...a, status, sort: i });
    } else if (row.status !== status || row.description !== a.description) {
      // Older sample data claimed an agent was connected when none was.
      await db
        .update(t.agents)
        .set({
          status,
          description: a.description,
          detail: status === "connected" ? row.detail : a.detail,
        })
        .where(eq(t.agents.id, a.id));
    }
  }
}
