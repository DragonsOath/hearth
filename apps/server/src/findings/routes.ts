import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DbHandle } from "../db/client";
import type { Todos } from "../todos/service";
import { buildBriefing } from "./briefing";
import type { FindingsEngine } from "./engine";

/**
 * Findings for the owner (session only). The owner's decisions about a finding (seen, snooze,
 * dismiss, reopen) are made here; resolving is left to Hearth's recheck.
 */

type Id = { Params: { id: string } };

const REFRESH_MIN_MS = 30_000;

export function registerFindingRoutes(
  app: FastifyInstance,
  handle: DbHandle,
  engine: FindingsEngine,
  todos: Todos,
) {
  const findings = engine.findings;
  let lastRefresh = 0;

  app.get<{ Querystring: { status?: string; serviceId?: string } }>(
    "/api/findings",
    async (request) => {
      const status = z
        .enum(["active", "resolved", "dismissed", "accepted", "all"])
        .catch("active")
        .parse(request.query.status);
      return findings.list({
        status,
        ...(request.query.serviceId ? { serviceId: request.query.serviceId } : {}),
      });
    },
  );

  app.get<{ Querystring: { since?: string } }>("/api/findings/briefing", async (request) => {
    const since = request.query.since;
    return buildBriefing(handle, engine, {
      ...(since && !Number.isNaN(Date.parse(since))
        ? { since: new Date(since).toISOString() }
        : {}),
    });
  });

  app.get("/api/findings/coverage", async () => engine.coverage());

  // Look again now (at most every 30 seconds), for "check again" after fixing something.
  app.post("/api/findings/refresh", async () => {
    if (Date.now() - lastRefresh < REFRESH_MIN_MS) return { ran: false };
    lastRefresh = Date.now();
    await engine.tick({ only: engine.analyzers.map((a) => a.id) });
    return { ran: true };
  });

  app.get<Id>("/api/findings/:id", async (request) => findings.get(request.params.id));

  app.post<Id>("/api/findings/:id/acknowledge", async (request) =>
    findings.act(request.params.id, { type: "acknowledge" }, "you"),
  );
  app.post<Id>("/api/findings/:id/snooze", async (request) => {
    const { hours } = z
      .object({
        hours: z
          .number()
          .min(1)
          .max(24 * 90),
      })
      .strict()
      .parse(request.body);
    return findings.act(
      request.params.id,
      { type: "snooze", until: new Date(Date.now() + hours * 3_600_000).toISOString() },
      "you",
    );
  });
  app.post<Id>("/api/findings/:id/dismiss", async (request) => {
    const { reason } = z
      .object({ reason: z.string().max(300).optional() })
      .strict()
      .parse(request.body ?? {});
    return findings.act(request.params.id, { type: "dismiss", reason }, "you");
  });
  // Accept the condition as it is: it stays accepted while it looks the same.
  app.post<Id>("/api/findings/:id/accept", async (request) => {
    const { note } = z
      .object({ note: z.string().trim().max(300).optional() })
      .strict()
      .parse(request.body ?? {});
    return findings.act(request.params.id, { type: "accept", note }, "you");
  });
  app.post<Id>("/api/findings/:id/unaccept", async (request) =>
    findings.act(request.params.id, { type: "unaccept" }, "you"),
  );
  app.post<Id>("/api/findings/:id/reopen", async (request) =>
    findings.act(request.params.id, { type: "reopen" }, "you"),
  );
  app.post<Id>("/api/findings/:id/note", async (request) => {
    const { text } = z
      .object({ text: z.string().trim().min(1).max(1000) })
      .strict()
      .parse(request.body);
    return findings.act(request.params.id, { type: "note", text }, "you");
  });
  app.post<Id>("/api/findings/:id/resolve", async (request) => {
    const { verification } = z
      .object({ verification: z.string().trim().min(10).max(600) })
      .strict()
      .parse(request.body);
    return findings.act(request.params.id, { type: "resolve", verification }, "you");
  });

  /**
   * The owner asks Ember to investigate: the finding shows Ember is on it, and the words to
   * start the conversation with come back (the page sends them to Ember).
   */
  app.post<Id>("/api/findings/:id/investigate", async (request) => {
    const f = await findings.act(request.params.id, { type: "investigating" }, "you");
    return {
      finding: f,
      prompt: `Please investigate finding F-${f.number}: ${f.title}. Read it with get_finding first, find the cause from evidence, and tell me what you found. If a fix is needed, propose it as a plan linked to this finding.`,
    };
  });

  // Onto the owner's own list, with the finding as its evidence.
  app.post<Id>("/api/findings/:id/todo", async (request) => {
    const f = await findings.get(request.params.id);
    if (f.todoId) return { todoId: f.todoId };
    const item = await todos.create(
      {
        category: f.kind === "recommendation" || f.kind === "observation" ? "task" : "issue",
        title: f.title.slice(0, 160),
        description: `${f.summary}\n\nWhy it matters: ${f.why}`.slice(0, 2000),
        priority:
          f.severity === "critical" || f.severity === "high"
            ? "high"
            : f.severity === "medium"
              ? "medium"
              : "low",
        services: f.serviceId ? [f.serviceId] : [],
        evidence: [{ label: `Finding F-${f.number}`, ref: `finding:${f.id}`, kind: "record" }],
        ...(f.nextSteps[0] ? { nextAction: f.nextSteps[0].slice(0, 500) } : {}),
      },
      "you",
    );
    await findings.linkTodo(f.id, item.id);
    return { todoId: item.id, number: item.number };
  });
}
