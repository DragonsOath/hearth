import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Memory } from "../memory/service";
import { recordAudit } from "../store/audit";
import type { Database } from "../db/client";
import { submissionMessage, type Workspaces } from "./service";

/**
 * The owner's side of a workspace: choices, submit, minimize, save, close. Session only (access
 * keys never reach these). Closing removes the workspace's own data, nothing else.
 */

type Id = { Params: { id: string } };

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  workspaces: Workspaces,
  /** Hands a submission to the workspace's conversation (Ember continues from it). */
  converse: (text: string, conversationId: string) => Promise<unknown>,
  deps: { memory: Memory; db: Database },
) {
  app.get<{ Querystring: { conversationId?: string; kind?: string } }>(
    "/api/workspaces",
    async (request) =>
      workspaces.list({
        conversationId: request.query.conversationId || undefined,
        kind:
          request.query.kind === "saved" || request.query.kind === "temporary"
            ? request.query.kind
            : undefined,
      }),
  );
  app.get<Id>("/api/workspaces/:id", async (request) => workspaces.get(request.params.id));
  app.put<Id>("/api/workspaces/:id/selections", async (request) => {
    const changes = z
      .record(z.string().max(400), z.string().max(40).nullable())
      .refine((r) => Object.keys(r).length <= 2000)
      .parse(request.body);
    return workspaces.select(request.params.id, changes);
  });
  // A title from the whole library, added to a pick sheet and selected (the Forge's search).
  app.post<Id>("/api/workspaces/:id/items", async (request) => {
    const item = z
      .object({
        id: z.string().min(1).max(400),
        values: z.record(z.string().max(80), z.union([z.string().max(2000), z.number(), z.null()])),
        image: z
          .string()
          .max(400)
          .regex(/^\/library\/metadata\//)
          .optional(),
      })
      .strict()
      .parse(request.body);
    return workspaces.addPicked(request.params.id, item);
  });
  app.post<Id>("/api/workspaces/:id/state", async (request) => {
    const { state } = z
      .object({ state: z.enum(["open", "minimized", "closed"]) })
      .strict()
      .parse(request.body);
    return workspaces.setState(request.params.id, state);
  });
  app.post<Id>("/api/workspaces/:id/submit", async (request) => {
    const view = await workspaces.submit(request.params.id);
    if (view.conversationId) await converse(submissionMessage(view), view.conversationId);
    return view;
  });
  // Save as a working file: the whole interactive workspace, kept in Saved work.
  app.post<Id>("/api/workspaces/:id/save", async (request) => {
    const body = z
      .object({ title: z.string().max(120).optional(), folder: z.string().max(60).optional() })
      .strict()
      .parse(request.body ?? {});
    const view = await workspaces.save(request.params.id, body);
    await recordAudit(deps.db, {
      actor: "you",
      action: `Saved the workspace "${view.spec.title}" as a working file`,
      target: `workspace:${view.id}`,
    });
    return view;
  });
  // Save as a note: what it found, as reference in Memory. The workspace is unchanged.
  app.post<Id>("/api/workspaces/:id/note", async (request) => {
    const { title } = z
      .object({ title: z.string().max(160).optional() })
      .strict()
      .parse(request.body ?? {});
    return workspaces.saveNote(request.params.id, deps.memory, { title });
  });
  // Your edits: name, description, folder.
  app.patch<Id>("/api/workspaces/:id", async (request) => {
    const patch = z
      .object({
        title: z.string().max(120).optional(),
        description: z.string().max(1000).optional(),
        folder: z.string().max(60).nullable().optional(),
      })
      .strict()
      .parse(request.body);
    return workspaces.edit(request.params.id, patch);
  });
  // Temporary: discard. Saved: only with ?saved=1, the deliberate delete in Saved work.
  app.delete<Id & { Querystring: { saved?: string } }>(
    "/api/workspaces/:id",
    async (request, reply) => {
      const before = await workspaces.get(request.params.id);
      await workspaces.remove(request.params.id, { saved: request.query.saved === "1" });
      if (before.kind === "saved")
        await recordAudit(deps.db, {
          actor: "you",
          action: `Deleted the working file "${before.spec.title}"`,
          target: `workspace:${before.id}`,
        });
      return reply.code(204).send();
    },
  );
}
