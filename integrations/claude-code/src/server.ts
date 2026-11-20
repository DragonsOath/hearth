import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Companion, OfflineError, RejectedError } from "./client";
import { briefingText, provenance, recallText } from "./format";
import { syncSession } from "./sessions";

/**
 * The companion's tools, as an MCP server Claude Code starts on this
 * machine. Every answer starts with where it came from: LIVE from
 * Hearth, or a CACHED copy with its age when Hearth is away.
 * Saves made while away are queued and sent automatically later.
 */

const KINDS = ["journal", "thread", "win", "preference", "hardware", "note"] as const;
const BASES = ["observed", "documented", "stated", "unknown"] as const;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export async function serve() {
  const c = new Companion();
  const flush = () => c.flush((id) => syncSession(c, id)).catch(() => undefined);
  void flush();

  const server = new McpServer(
    { name: "dragon-control", version: "0.1.0" },
    {
      instructions:
        "Hearth is the homelab's memory: projects, a journal of what was built and fixed, open threads, how the owner likes to work, hardware, and word-for-word past sessions. In homelab conversations, read the briefing first, recall before answering questions about history or decisions, and remember decisions, fixes, wins, and new unfinished work as soon as they happen. Always say whether information is live or cached.",
    },
  );

  server.registerTool(
    "briefing",
    {
      description:
        "Get caught up on the homelab: what's up (what needs the owner, what happened since, wins, one idea), recent history, open threads, projects, preferences, hardware, and the live state of their systems. Call it first in any homelab conversation (unless the briefing was already provided this session).",
      inputSchema: {},
    },
    async () => text(briefingText(await c.briefing(), c.url)),
  );

  server.registerTool(
    "recall",
    {
      description:
        "Search the homelab memory and past conversations word for word (Claude Code sessions, the app, Belle). Use it for 'why did we...', 'when did we...', 'what was the fix for...'. Word forms match (ports finds port).",
      inputSchema: { query: z.string().min(1).max(200).describe("Words to look for") },
    },
    async ({ query }) => text(recallText(await c.search(query), c.url)),
  );

  server.registerTool(
    "read_session",
    {
      description: "Read the exchange around a match in a saved session (from recall).",
      inputSchema: {
        id: z.string().describe("The session id from recall"),
        around: z
          .number()
          .int()
          .optional()
          .describe("Message number to center on; omit for the whole session"),
      },
    },
    async ({ id, around }) => {
      try {
        const t = await c.transcript(id, around);
        return text(
          [
            `[Hearth: LIVE] Session "${t.transcript.title}" (${t.transcript.client}${t.transcript.machine ? ` on ${t.transcript.machine}` : ""}, ${t.transcript.startedAt.slice(0, 10)})`,
            ...t.messages.map((m) => `#${m.seq} ${m.role} (${m.at}):\n${m.text}`),
          ].join("\n\n"),
        );
      } catch (error) {
        if (error instanceof OfflineError) {
          return text(
            `[Hearth: UNREACHABLE] Saved sessions are only on Hearth and cannot be read right now (${error.message}).`,
          );
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "remember",
    {
      description:
        "Save something to the homelab memory right away: a decision and why, a fix, a win, new unfinished work (kind thread), how the owner likes things done (preference), or hardware facts. Say how it is known: observed (you checked it just now), documented (a note or doc says so), stated (the owner said it), unknown. Never include passwords, keys, or tokens.",
      inputSchema: {
        kind: z.enum(KINDS),
        title: z.string().min(1).max(200),
        body: z
          .string()
          .max(20000)
          .optional()
          .describe("Details: what, why, and anything a future session needs"),
        basis: z.enum(BASES),
        project: z.string().max(80).optional().describe("Project name; created if new"),
        machine: z.string().max(80).optional(),
        happened_at: z.string().optional().describe("ISO date or time, if not now"),
        verification: z
          .object({ check: z.string(), result: z.string() })
          .optional()
          .describe("For observed facts: the command or check you ran and what it returned"),
      },
    },
    async (args) => {
      let projectId: string | undefined;
      if (args.project) projectId = await c.ensureProject(args.project).catch(() => undefined);
      const body = {
        kind: args.kind,
        title: args.title,
        body: args.body,
        basis: args.basis,
        projectId,
        machine: args.machine,
        happenedAt: args.happened_at,
        verification: args.verification
          ? { at: new Date().toISOString(), ...args.verification }
          : undefined,
      };
      try {
        const result = await c.remember(body);
        return text(
          result.sent
            ? `Saved to Hearth [id ${result.entry.id}].`
            : `Hearth is unreachable (${result.reason}). Saved on this machine and queued; it will be sent automatically when Hearth answers (${result.queued} waiting).${args.project && !projectId ? " The project will need to be set once it is back." : ""}`,
        );
      } catch (error) {
        if (error instanceof RejectedError) return text(`Hearth refused it: ${error.message}`);
        throw error;
      }
    },
  );

  server.registerTool(
    "update_memory",
    {
      description:
        "Change a memory: close an open thread (status done), reopen it, correct it, or record a verification of it. When something remembered is no longer how things are (moved, replaced, removed), set no_longer_true with what replaced it: it stays as history and stops appearing as current. Use the id shown in the briefing or recall.",
      inputSchema: {
        id: z.string(),
        status: z.enum(["open", "done"]).optional(),
        title: z.string().max(200).optional(),
        body: z.string().max(20000).optional(),
        basis: z.enum(BASES).optional(),
        verification: z.object({ check: z.string(), result: z.string() }).optional(),
        no_longer_true: z
          .string()
          .max(1000)
          .optional()
          .describe("What changed, e.g. 'Plex moved to the Linux server on 2026-10-06'."),
        still_current: z
          .boolean()
          .optional()
          .describe("True to undo no_longer_true: it is how things are after all."),
      },
    },
    async ({ id, verification, no_longer_true, still_current, ...rest }) => {
      const now = new Date().toISOString();
      const body = {
        ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
        ...(verification ? { verification: { at: now, ...verification } } : {}),
        ...(no_longer_true ? { superseded: { at: now, reason: no_longer_true } } : {}),
        ...(still_current ? { superseded: null } : {}),
      };
      try {
        const result = await c.update(id, body);
        return text(
          result.sent
            ? `Updated [id ${id}].`
            : `Hearth is unreachable (${result.reason}). The change is queued and will be sent automatically (${result.queued} waiting).`,
        );
      } catch (error) {
        if (error instanceof RejectedError) return text(`Hearth refused it: ${error.message}`);
        throw error;
      }
    },
  );

  server.registerTool(
    "list_memories",
    {
      description:
        "List memories by kind (journal, thread, win, preference, hardware, note) and status.",
      inputSchema: {
        kind: z.enum(KINDS).optional(),
        status: z.enum(["open", "done"]).optional(),
      },
    },
    async (filter) => {
      const result = await c.list(filter);
      const lines = (result.data ?? []).map(
        (e) =>
          `- ${e.title} (${e.kind}${e.status ? `, ${e.status}` : ""}, ${e.happenedAt.slice(0, 10)}, ${e.basis}) [id ${e.id}]`,
      );
      return text(
        [provenance(result, c.url), "", ...(lines.length ? lines : ["Nothing."])].join("\n"),
      );
    },
  );

  server.registerTool(
    "companion_status",
    {
      description:
        "Whether Hearth is reachable, how many saves are waiting to sync, and how old the cached copy is.",
      inputSchema: {},
    },
    async () => {
      const flushed = await c
        .flush((id) => syncSession(c, id))
        .catch(() => ({ sent: 0, left: c.pending().length }));
      const cached = c.readCache<unknown>("briefing");
      let reachable = "unknown";
      try {
        await c.projects().then((r) => (reachable = r.live ? "yes" : `no (${r.reason})`));
      } catch {
        reachable = "no";
      }
      return text(
        [
          `Hearth: ${c.url ?? "not set up"}; reachable: ${reachable}.`,
          `Waiting to sync: ${flushed.left}${flushed.sent ? ` (just sent ${flushed.sent})` : ""}.`,
          `Cached briefing from: ${cached?.at ?? "never"}.`,
        ].join("\n"),
      );
    },
  );

  await server.connect(new StdioServerTransport());
}
