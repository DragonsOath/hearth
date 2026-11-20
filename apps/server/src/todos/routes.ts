import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TODO_CATEGORIES, TODO_PRIORITIES } from "@dragon-control/core";
import type { Todos } from "./service";

/**
 * The owner's own changes to the to-do list. Session only (access keys never
 * reach these). The owner can close an item: they are the reliable evidence.
 */

const item = z
  .object({
    category: z.enum(TODO_CATEGORIES),
    title: z.string().trim().min(3).max(160),
    description: z.string().max(2000).optional(),
    priority: z.enum(TODO_PRIORITIES).optional(),
    services: z.array(z.string()).max(12).optional(),
    projectId: z.string().optional(),
    nextAction: z.string().max(500).optional(),
    status: z.enum(["open", "deferred"]).optional(),
  })
  .strict();

const patch = z
  .object({
    category: z.enum(TODO_CATEGORIES).optional(),
    title: z.string().trim().min(3).max(160).optional(),
    description: z.string().max(2000).optional(),
    priority: z.enum(TODO_PRIORITIES).optional(),
    services: z.array(z.string()).max(12).optional(),
    projectId: z.string().nullable().optional(),
    nextAction: z.string().max(500).optional(),
    status: z
      .enum(["open", "investigating", "waiting-approval", "deferred", "resolved", "dismissed"])
      .optional(),
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

type Id = { Params: { id: string } };

export function registerTodoRoutes(app: FastifyInstance, todos: Todos) {
  app.get<{ Querystring: { suggestions?: string; projectId?: string; conversationId?: string } }>(
    "/api/todos",
    async (request) =>
      todos.list({
        suggestions: request.query.suggestions === "1",
        projectId: request.query.projectId || undefined,
        conversationId: request.query.conversationId || undefined,
      }),
  );
  app.get<Id>("/api/todos/:id", async (request) => todos.get(request.params.id));
  app.post("/api/todos", async (request) => {
    const { status, ...input } = item.parse(request.body);
    return todos.create(input, "you", status ?? "open");
  });
  app.patch<Id>("/api/todos/:id", async (request) => {
    const { status, note, ...edits } = patch.parse(request.body);
    const { id } = await todos.get(request.params.id);
    if (Object.keys(edits).length) await todos.edit(id, edits, "you");
    if (status) await todos.setStatus(id, status, "you", { note });
    else if (note) await todos.note(id, note, "you");
    return todos.get(id);
  });
  // A suggestion Ember made goes onto the list.
  // The Ember conversation it is worked on in (Work on this): the next one goes back to it.
  app.put<Id>("/api/todos/:id/conversation", async (request) => {
    const { conversationId } = z
      .object({ conversationId: z.string().min(1).max(80) })
      .strict()
      .parse(request.body);
    return todos.linkConversation(request.params.id, conversationId);
  });
  app.post<Id>("/api/todos/:id/save", async (request) => {
    const { deferred } = z
      .object({ deferred: z.boolean().optional() })
      .strict()
      .parse(request.body ?? {});
    return todos.save(request.params.id, "you", { deferred });
  });
}
