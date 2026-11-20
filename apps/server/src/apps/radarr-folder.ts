import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, type Fetch } from "./http";

/**
 * Changing where Radarr keeps one movie (its root folder), from the Overseerr panel: a plan step
 * you confirm, planned from the movie and the root folders Radarr really has, made through
 * Radarr's movie editor (PUT /api/v3/movie/editor), and read back. A movie already downloaded
 * has its files moved by Radarr only when the plan says so.
 */

interface Movie {
  id: number;
  title?: string;
  year?: number;
  path?: string;
  rootFolderPath?: string;
  hasFile?: boolean;
}

const parentOf = (p: string) => p.replace(/[/\\]+$/, "").replace(/[/\\][^/\\]*$/, "");
const norm = (p: string) => p.replace(/[/\\]+$/, "");

export class RadarrFolderOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  private call<T>(
    service: { id: string; name: string; localUrl: string },
    method: "GET" | "PUT",
    path: string,
    purpose: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; data: T }> {
    const url = joinUrl(service.localUrl, path);
    return this.broker.use(
      {
        serviceId: service.id,
        purpose,
        access: method === "GET" ? "read" : "change",
        destination: url,
      },
      async ({ value }) => {
        let res: Awaited<ReturnType<Fetch>>;
        try {
          res = await this.fetchImpl(url, {
            method,
            headers: {
              "X-Api-Key": value,
              Accept: "application/json",
              ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(TIMEOUT_MS * 3),
          });
        } catch (error) {
          throw new AppUnreachableError(
            `${service.name} did not answer: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (res.status === 401 || res.status === 403)
          throw new AppKeyError(`${service.name} refused the API key.`);
        return {
          ok: res.ok,
          status: res.status,
          data: (await res.json().catch(() => undefined)) as T,
        };
      },
    );
  }

  private async movie(service: { id: string; name: string; localUrl: string }, id: number) {
    const r = await this.call<Movie>(service, "GET", `/api/v3/movie/${id}`, "read a movie");
    if (!r.ok || !r.data) throw new Error(`${service.name} has no movie #${id}.`);
    const m = r.data;
    return { ...m, root: norm(m.rootFolderPath ?? (m.path ? parentOf(m.path) : "")) };
  }

  async plan(
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const id = Number(params?.movieId);
    const want = typeof params?.rootFolder === "string" ? norm(params.rootFolder.trim()) : "";
    if (!Number.isInteger(id) || id <= 0 || !want)
      throw new Error("Say which movie (movieId) and which root folder (rootFolder).");
    const m = await this.movie(service, id);
    const roots = await this.call<{ path: string; accessible?: boolean }[]>(
      service,
      "GET",
      "/api/v3/rootfolder",
      "list Radarr's root folders",
    );
    const known = (roots.data ?? []).map((r) => ({
      path: norm(r.path),
      ok: r.accessible !== false,
    }));
    const target = known.find((r) => r.path === want);
    if (!target)
      throw new Error(
        `${service.name} has no root folder ${want}. It has: ${known.map((r) => r.path).join(", ") || "none"}.`,
      );
    if (!target.ok) throw new Error(`${service.name} cannot reach ${want} right now.`);
    if (m.root === want) throw new Error(`${m.title ?? "That movie"} already goes to ${want}.`);
    const move = Boolean(m.hasFile) && params?.moveFiles !== false;
    const title = `${m.title ?? `Movie ${id}`}${m.year ? ` (${m.year})` : ""}`;
    return {
      ...base,
      label: `Change ${title}'s folder in ${service.name} from ${m.root || "(none)"} to ${want}${m.hasFile ? (move ? ", moving its files" : ", leaving its files where they are") : ""}`,
      serviceName: service.name,
      params: { movieId: id, rootFolder: want, moveFiles: move, title },
      change: {
        summary: `${title}: root folder`,
        settings: [{ name: `${title}: root folder`, before: m.root || "(none)", after: want }],
      },
    };
  }

  async run(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const id = Number(step.params?.movieId);
    const want = String(step.params?.rootFolder ?? "");
    const before = step.change?.settings[0]?.before;
    const m = await this.movie(service, id);
    if (before !== undefined && m.root !== before && m.root !== want)
      return {
        ok: false,
        stale: true,
        result: `It now goes to ${m.root}, not ${before} as when you confirmed; nothing was changed.`,
      };
    if (m.root !== want) {
      const put = await this.call(
        service,
        "PUT",
        "/api/v3/movie/editor",
        "change a movie's root folder",
        {
          movieIds: [id],
          rootFolderPath: want,
          moveFiles: Boolean(step.params?.moveFiles),
        },
      );
      if (!put.ok)
        return {
          ok: false,
          result: `${service.name} refused the change (${put.status}). Nothing was changed.`,
        };
    }
    const after = await this.movie(service, id);
    const verified = after.root === want;
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `Changed ${step.params?.title ?? `movie ${id}`}'s root folder in ${service.name} to ${want}`,
      target: `service:${service.id}`,
      detail: {
        before: before ?? null,
        after: after.root,
        moveFiles: Boolean(step.params?.moveFiles),
        verified,
      },
    });
    return verified
      ? {
          ok: true,
          result: `${step.params?.title ?? "The movie"} now goes to ${want}${step.params?.moveFiles ? "; Radarr is moving its files" : ""}.`,
        }
      : {
          ok: false,
          result: `${service.name} accepted it, but the movie still reads ${after.root}.`,
        };
  }
}
