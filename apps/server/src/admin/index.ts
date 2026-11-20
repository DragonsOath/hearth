import { existsSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DbHandle } from "../db/client";
import type { ActionRunner } from "../actions/service";
import type { Memory } from "../memory/service";
import { ForbiddenAuthError } from "../auth/service";
import { Capabilities } from "./capabilities";
import { Elevation } from "./elevation";
import { realContainerExec, type ContainerExec } from "./docker-exec";
import { HostInvestigation, realRun, type Runner } from "./host";
import { ConfigOperations } from "./operations";
import { Recyclarr } from "./recyclarr";
import { HostScopes, type ScopeRules } from "./scope";

/** Host administration (feature request 21; docs/design/HOST_ADMINISTRATION.md). */
export interface Admin {
  scopes: HostScopes;
  host: HostInvestigation;
  capabilities: Capabilities;
  recyclarr: Recyclarr;
  config: ConfigOperations;
  /** The root-owned elevated executor, when the owner set it up. */
  elevation: Elevation;
  backupRoot: string;
  docsRoot?: string;
}

/**
 * Where service configuration backups go: the host's backup ledger. On the home server that is
 * /srv/homelab/backups (beside Hearth's own backups), per its documented convention
 * backups/<service>/<date>-<reason>/. Elsewhere, a folder in Hearth's data.
 */
export function serviceBackupRoot(env: NodeJS.ProcessEnv, dataDir: string): string {
  if (env.DC_SERVICE_BACKUP_DIR) return path.resolve(env.DC_SERVICE_BACKUP_DIR);
  if (env.DC_BACKUP_DIR) return path.dirname(path.resolve(env.DC_BACKUP_DIR));
  return path.join(dataDir, "service-backups");
}

/**
 * The host's own documentation, which conventions come from: DC_HOST_DOCS, or a "docs" folder
 * beside the backup ledger (/srv/homelab/backups and /srv/homelab/docs), when there is one.
 */
export function hostDocsRoot(env: NodeJS.ProcessEnv, dataDir?: string): string | undefined {
  if (env.DC_HOST_DOCS) return path.resolve(env.DC_HOST_DOCS);
  if (!env.DC_SERVICE_BACKUP_DIR && !env.DC_BACKUP_DIR) return undefined;
  const beside = path.join(path.dirname(serviceBackupRoot(env, dataDir ?? "")), "docs");
  return existsSync(beside) ? beside : undefined;
}

export function createAdmin(
  handle: DbHandle,
  runner: ActionRunner,
  opts: {
    backupRoot: string;
    docsRoot?: string;
    rules?: Partial<ScopeRules>;
    memory?: Memory;
    exec?: ContainerExec;
    run?: Runner;
    elevation?: Elevation;
    /** Waiting while containers come back (tests pass a no-op). */
    wait?: (ms: number) => Promise<void>;
  },
): Admin {
  const scopes = new HostScopes(handle, runner.containerTools, opts.rules);
  const elevation = opts.elevation ?? new Elevation();
  const recyclarr = new Recyclarr(opts.exec ?? realContainerExec);
  return {
    scopes,
    host: new HostInvestigation(handle, scopes, opts.run ?? realRun),
    capabilities: new Capabilities(handle),
    recyclarr,
    config: new ConfigOperations(
      handle,
      scopes,
      recyclarr,
      runner.containerTools,
      runner,
      opts.backupRoot,
      opts.memory,
      {
        run: opts.run ?? realRun,
        exec: opts.exec ?? realContainerExec,
        ...(opts.wait ? { wait: opts.wait } : {}),
      },
      elevation,
    ),
    elevation,
    backupRoot: opts.backupRoot,
    ...(opts.docsRoot ? { docsRoot: opts.docsRoot } : {}),
  };
}

/** Yours to give and withdraw: session routes only (no access key reaches them). */
export function registerAdminRoutes(
  app: FastifyInstance,
  admin: Admin,
  /** Whether this request's owner confirmed it is them just now (a fresh "it's you"). */
  recentlyVerified: (request: FastifyRequest) => boolean,
) {
  app.get<{ Querystring: { all?: string } }>("/api/admin/scopes", async (request) => ({
    scopes: await admin.scopes.list({ all: request.query.all === "1" }),
    host: (await admin.scopes.localHost()) ?? null,
    backupRoot: admin.backupRoot,
    docsRoot: admin.docsRoot ?? null,
  }));
  // Switching host administration on reaches the whole machine: it needs a fresh "it's you",
  // wherever it is asked from (Settings, or a panel that needs it). Switching off never does.
  app.post("/api/admin/scopes", async (request) => {
    if (!recentlyVerified(request))
      throw new ForbiddenAuthError(
        "Host administration reaches the whole machine. Confirm it's you, then switch it on.",
      );
    return admin.scopes.enable(request.body);
  });
  app.delete<{ Params: { id: string } }>("/api/admin/scopes/:id", async (request, reply) => {
    await admin.scopes.revoke(request.params.id);
    return reply.code(204).send();
  });
  // What the elevated executor may do (its scope), never anything it was asked to do.
  app.get("/api/admin/elevation", async () => admin.elevation.state(true));
  app.get("/api/admin/capabilities", async () => admin.capabilities.list());
  app.post("/api/admin/capabilities/detect", async () =>
    admin.capabilities.detect((await admin.scopes.localHost())?.id),
  );
  app.post<{ Params: { id: string } }>(
    "/api/admin/capabilities/:id/dismiss",
    async (request, reply) => {
      await admin.capabilities.dismiss(request.params.id);
      return reply.code(204).send();
    },
  );
}
