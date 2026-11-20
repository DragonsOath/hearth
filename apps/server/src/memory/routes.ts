import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { MEMORY_BASES, MEMORY_KINDS, TRANSCRIPT_ROLES } from "@dragon-control/core";
import type { Backups } from "../backup/service";
import { backupKey } from "../backup/crypto";
import type { Auth } from "../auth/service";
import type { DbHandle } from "../db/client";
import { buildBriefing } from "./briefing";
import type { Imports } from "./imports";
import type { Memory, Writer } from "./service";

/**
 * The memory and backup API. Owner sessions only for now; the companion
 * key for Claude Code arrives with the Claude Code add-on.
 */

const isoTime = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), "must be a date or time");
const link = z
  .object({ label: z.string().trim().min(1).max(120), ref: z.string().trim().min(1).max(2000) })
  .strict();
const verification = z
  .object({
    at: isoTime,
    check: z.string().trim().min(1).max(2000),
    result: z.string().trim().min(1).max(4000),
  })
  .strict();

const entryFields = {
  kind: z.enum(MEMORY_KINDS),
  title: z.string().trim().min(1, "Give it a title").max(200),
  body: z.string().max(20_000).optional(),
  projectId: z.string().max(80).nullable().optional(),
  status: z.enum(["open", "done"]).nullable().optional(),
  happenedAt: isoTime.optional(),
  basis: z.enum(MEMORY_BASES).optional(),
  machine: z.string().trim().max(80).nullable().optional(),
  verification: verification.nullable().optional(),
  superseded: z
    .object({ at: isoTime, reason: z.string().trim().min(1).max(1000) })
    .strict()
    .nullable()
    .optional(),
  links: z.array(link).max(50).optional(),
};

const schemas = {
  entry: z
    .object({ ...entryFields, clientRef: z.string().trim().min(8).max(100).optional() })
    .strict(),
  briefing: z.object({ since: isoTime.optional() }),
  importEntry: z
    .object({
      kind: z.enum(MEMORY_KINDS),
      title: z.string().trim().min(1).max(200),
      body: z.string().max(20_000).optional(),
      projectName: z.string().trim().max(80).optional(),
      status: z.enum(["open", "done"]).optional(),
      happenedAt: isoTime.optional(),
      basis: z.enum(MEMORY_BASES).optional(),
      machine: z.string().trim().max(80).optional(),
      author: z.string().trim().max(80).optional(),
    })
    .strict(),
  patch: z.object(entryFields).partial().strict(),
  list: z.object({
    kind: z.enum(MEMORY_KINDS).optional(),
    projectId: z.string().max(80).optional(),
    status: z.enum(["open", "done"]).optional(),
    view: z.enum(["active", "deleted"]).default("active"),
  }),
  search: z.object({ q: z.string().max(200).default("") }),
  project: z
    .object({
      name: z.string().trim().min(1, "Give the project a name").max(80),
      summary: z.string().max(4000).optional(),
      status: z.enum(["active", "paused", "done"]).optional(),
    })
    .strict(),
  transcript: z
    .object({
      client: z.string().trim().min(1).max(40),
      title: z.string().trim().min(1).max(200),
      machine: z.string().trim().max(80).optional(),
      sessionRef: z.string().trim().max(200).optional(),
      projectId: z.string().max(80).optional(),
      startedAt: isoTime.optional(),
    })
    .strict(),
  messages: z
    .object({
      messages: z
        .array(
          z
            .object({
              seq: z.number().int().min(1).optional(),
              role: z.enum(TRANSCRIPT_ROLES),
              text: z.string().max(200_000),
              at: isoTime.optional(),
            })
            .strict(),
        )
        .min(1)
        .max(500),
    })
    .strict(),
};

const importPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entry"), entry: schemas.importEntry }).strict(),
  z
    .object({
      kind: z.literal("project"),
      project: z
        .object({
          name: z.string().trim().min(1).max(80),
          summary: z.string().max(4000).optional(),
          status: z.enum(["active", "paused", "done"]).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("session"),
      session: z
        .object({
          client: z.string().trim().min(1).max(40),
          title: z.string().trim().min(1).max(200),
          machine: z.string().trim().max(80).optional(),
          sessionRef: z.string().trim().min(1).max(200),
          startedAt: isoTime.optional(),
          messages: z
            .array(
              z
                .object({
                  seq: z.number().int().min(1),
                  role: z.enum(TRANSCRIPT_ROLES),
                  text: z.string().max(200_000),
                  at: isoTime.optional(),
                })
                .strict(),
            )
            .max(20_000),
        })
        .strict(),
    })
    .strict(),
]);

const importSchemas = {
  propose: z
    .object({
      batch: z.string().trim().min(1).max(120),
      drafts: z
        .array(
          z
            .object({
              sourceRef: z.string().trim().min(8).max(200),
              origin: z.string().trim().min(1).max(1000),
              anchor: z.string().trim().max(300),
              payload: importPayload,
              note: z.string().max(500).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(500),
    })
    .strict(),
  list: z.object({
    status: z.enum(["pending", "accepted", "rejected"]).optional(),
    batch: z.string().max(120).optional(),
  }),
  accept: z
    .object({
      edits: schemas.importEntry.partial().optional(),
      // Older notes that conflict with what Hearth sees are saved as
      // history unless you say they are still how things are.
      asCurrent: z.boolean().optional(),
    })
    .strict(),
  decide: z
    .object({
      ids: z.array(z.string().max(80)).min(1).max(2000),
      decision: z.enum(["accept", "reject"]),
    })
    .strict(),
};

const you: Writer = { source: "you" };

/**
 * Who is writing: you in the app, or the companion through its access key.
 * The companion names itself ("Claude Code on ai-box") in X-DC-Client.
 */
function writer(request: FastifyRequest): Writer {
  if (!request.key) return you;
  const header = request.headers["x-dc-client"];
  const client = (Array.isArray(header) ? header[0] : header)?.replace(/[^\w .,'()-]/g, "").trim();
  return { source: "ai", author: (client || request.key.name).slice(0, 80) };
}

export interface MemoryRouteDeps {
  handle: DbHandle;
  memory: Memory;
  imports: Imports;
  backups: Backups;
  auth: Auth;
  keyDir: string;
  demo: boolean;
}

export function registerMemory(app: FastifyInstance, deps: MemoryRouteDeps) {
  const { memory, backups } = deps;
  type Id = { Params: { id: string } };

  app.get("/api/companion/briefing", async (request) =>
    buildBriefing(deps.handle, memory, backups, {
      since: schemas.briefing.parse(request.query).since,
      demo: deps.demo,
      imports: () => deps.imports.readiness(),
    }),
  );

  app.get("/api/memory/projects", async () => memory.projects());
  app.post("/api/memory/projects", async (request, reply) =>
    reply.code(201).send(await memory.createProject(schemas.project.parse(request.body))),
  );
  app.patch<Id>("/api/memory/projects/:id", async (request) =>
    memory.updateProject(request.params.id, schemas.project.partial().parse(request.body)),
  );

  app.get("/api/memory/entries", async (request) => {
    const q = schemas.list.parse(request.query);
    return memory.list({ ...q, deleted: q.view === "deleted" });
  });
  app.post("/api/memory/entries", async (request, reply) =>
    reply.code(201).send(await memory.create(schemas.entry.parse(request.body), writer(request))),
  );
  app.get<Id>("/api/memory/entries/:id", async (request) => ({
    entry: await memory.get(request.params.id),
    history: await memory.history(request.params.id),
  }));
  app.patch<Id>("/api/memory/entries/:id", async (request) =>
    memory.update(request.params.id, schemas.patch.parse(request.body), writer(request)),
  );
  app.delete<Id>("/api/memory/entries/:id", async (request, reply) => {
    await memory.remove(request.params.id, you);
    return reply.code(204).send();
  });
  app.post<Id>("/api/memory/entries/:id/restore", async (request) =>
    memory.restore(request.params.id, you),
  );
  app.delete<Id>("/api/memory/entries/:id/forever", async (request, reply) => {
    await memory.purge(request.params.id);
    return reply.code(204).send();
  });

  app.get("/api/memory/search", async (request) =>
    memory.search(schemas.search.parse(request.query).q),
  );

  app.get("/api/memory/transcripts", async () => memory.transcripts());
  app.post("/api/memory/transcripts", async (request, reply) =>
    reply.code(201).send(await memory.startTranscript(schemas.transcript.parse(request.body))),
  );
  app.get<Id>("/api/memory/transcripts/:id", async (request) =>
    memory.transcript(request.params.id),
  );
  app.post<Id>("/api/memory/transcripts/:id/messages", async (request) =>
    memory.appendMessages(request.params.id, schemas.messages.parse(request.body).messages),
  );
  app.post<Id>("/api/memory/transcripts/:id/end", async (request) =>
    memory.endTranscript(request.params.id),
  );

  /* ---------- Import review ---------- */
  const { imports } = deps;
  const owner = (request: FastifyRequest) => {
    if (!request.session)
      throw Object.assign(new Error("Only you can decide what is imported."), { statusCode: 403 });
  };
  // Importers send whole sessions, so this route accepts larger bodies.
  app.post("/api/memory/imports", { bodyLimit: 64 * 1024 * 1024 }, async (request) => {
    const { batch, drafts } = importSchemas.propose.parse(request.body);
    return imports.propose(batch, drafts);
  });
  app.get("/api/memory/imports/summary", async () => imports.summary());
  app.get("/api/memory/imports", async (request) =>
    imports.list(importSchemas.list.parse(request.query)),
  );
  app.get<Id>("/api/memory/imports/:id", async (request) => imports.get(request.params.id));
  app.post<Id>("/api/memory/imports/:id/accept", async (request) => {
    owner(request);
    const { edits, asCurrent } = importSchemas.accept.parse(request.body ?? {});
    return imports.accept(request.params.id, edits, { asCurrent });
  });
  app.post<Id>("/api/memory/imports/:id/reject", async (request) => {
    owner(request);
    return imports.reject(request.params.id);
  });
  app.post<Id>("/api/memory/imports/:id/reopen", async (request) => {
    owner(request);
    return imports.reopen(request.params.id);
  });
  app.post("/api/memory/imports/decide", async (request) => {
    owner(request);
    const { ids, decision } = importSchemas.decide.parse(request.body);
    return imports.decide(ids, decision);
  });

  app.get("/api/backups", async () => backups.status());
  app.post("/api/backups/run", async () => backups.run("manual"));

  /**
   * The keys to keep somewhere safe (a password manager): the one that
   * opens off-machine backups, and on Linux the one that opens background
   * secrets. You only, after confirming it is you; never an access key.
   */
  app.post("/api/backups/keys", async (request) => {
    if (!request.session)
      throw Object.assign(new Error("Sign in to do this."), { statusCode: 403 });
    deps.auth.requireRecent(request.session);
    const vaultFile = path.join(deps.keyDir, "vault.key");
    return {
      backupKey: backupKey(deps.keyDir).toString("base64"),
      vaultKey: existsSync(vaultFile) ? readFileSync(vaultFile, "utf8").trim() : undefined,
    };
  });
}
