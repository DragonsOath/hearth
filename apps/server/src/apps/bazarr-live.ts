import type { BazarrDashboard, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, type Fetch } from "./http";

/**
 * Bazarr's panel and controls: the movies and episodes missing subtitles (and which languages),
 * whether each subtitle provider works or is throttled, and recent downloads; plus searching
 * subtitles for one movie or episode, searching everything wanted, and resetting throttled
 * providers. Searches are read back from the wanted list, so "nothing found yet" is said plainly.
 */

type Method = "GET" | "POST" | "PATCH";

async function call<T>(
  fetchImpl: Fetch,
  base: string,
  key: string,
  method: Method,
  path: string,
  timeoutMs = TIMEOUT_MS * 2,
): Promise<{ ok: boolean; status: number; data: T }> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, path), {
      method,
      headers: { "X-API-KEY": key, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : "no answer";
    throw new AppUnreachableError(`Bazarr did not answer at ${base}: ${why}`);
  }
  if (res.status === 401 || res.status === 403)
    throw new AppKeyError("Bazarr refused the API key.");
  const data = (await res.json().catch(() => null)) as T;
  return { ok: res.ok, status: res.status, data };
}

async function get<T>(fetchImpl: Fetch, base: string, key: string, path: string): Promise<T> {
  const r = await call<T>(fetchImpl, base, key, "GET", path);
  if (!r.ok)
    throw new AppUnreachableError(`Bazarr answered ${r.status} for ${path.split("?")[0]}.`);
  return r.data;
}

interface Lang {
  name?: string;
  code2?: string;
  forced?: boolean;
  hi?: boolean;
}
interface WantedMovie {
  title?: string;
  radarrId?: number;
  missing_subtitles?: Lang[];
}
interface WantedEpisode {
  seriesTitle?: string;
  episode_number?: string;
  episodeTitle?: string;
  sonarrSeriesId?: number;
  sonarrEpisodeId?: number;
  missing_subtitles?: Lang[];
}
interface Hist {
  title?: string;
  seriesTitle?: string;
  episode_number?: string;
  description?: string;
  parsed_timestamp?: string;
  timestamp?: string | number;
}

const langName = (l: Lang) =>
  `${l.name ?? l.code2 ?? "?"}${l.forced ? " (forced)" : ""}${l.hi ? " (hearing impaired)" : ""}`;

const when = (h: Hist) => {
  const t =
    typeof h.timestamp === "number" ? h.timestamp * 1000 : Date.parse(String(h.timestamp ?? ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};

export async function bazarrDashboard(
  fetchImpl: Fetch,
  base: string,
  key: string,
): Promise<BazarrDashboard> {
  const g = <T>(path: string) => get<T>(fetchImpl, base, key, path);
  const [status, movies, episodes, providers, mh, eh] = await Promise.all([
    g<{ data?: { bazarr_version?: string } }>("/api/system/status"),
    g<{ data?: WantedMovie[]; total?: number }>("/api/movies/wanted?start=0&length=25"),
    g<{ data?: WantedEpisode[]; total?: number }>("/api/episodes/wanted?start=0&length=25"),
    g<{ data?: { name?: string; status?: string; retry?: string }[] }>("/api/providers").catch(
      () => ({ data: [] }),
    ),
    g<{ data?: Hist[] }>("/api/movies/history?start=0&length=8").catch(() => ({ data: [] })),
    g<{ data?: Hist[] }>("/api/episodes/history?start=0&length=8").catch(() => ({ data: [] })),
  ]);
  const prov = (providers.data ?? []).map((p) => ({
    name: p.name ?? "A provider",
    ok: !p.status || /^good$/i.test(p.status),
    ...(p.status && !/^good$/i.test(p.status) ? { why: p.status } : {}),
    ...(p.retry && p.retry !== "-" ? { retry: p.retry } : {}),
  }));
  const history = [
    ...(mh.data ?? []).map((h) => ({ title: h.title ?? "A movie", h })),
    ...(eh.data ?? []).map((h) => ({
      title: `${h.seriesTitle ?? "A show"}${h.episode_number ? ` ${h.episode_number}` : ""}`,
      h,
    })),
  ]
    .map(({ title, h }) => ({
      title,
      text: (h.description ?? "").slice(0, 200),
      ...(when(h) ? { at: when(h)! } : {}),
    }))
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    .slice(0, 10);
  return {
    app: "bazarr",
    ...(status.data?.bazarr_version ? { version: status.data.bazarr_version } : {}),
    totals: {
      movies: movies.total ?? movies.data?.length ?? 0,
      episodes: episodes.total ?? episodes.data?.length ?? 0,
      providers: prov.length,
      throttled: prov.filter((p) => !p.ok).length,
    },
    movies: (movies.data ?? [])
      .filter((m) => m.radarrId !== undefined)
      .map((m) => ({
        radarrId: m.radarrId!,
        title: m.title ?? "A movie",
        missing: (m.missing_subtitles ?? []).map(langName),
      })),
    episodes: (episodes.data ?? [])
      .filter((e) => e.sonarrEpisodeId !== undefined && e.sonarrSeriesId !== undefined)
      .map((e) => ({
        seriesId: e.sonarrSeriesId!,
        episodeId: e.sonarrEpisodeId!,
        title: `${e.seriesTitle ?? "A show"}${e.episode_number ? ` ${e.episode_number}` : ""}${e.episodeTitle ? `: ${e.episodeTitle}` : ""}`,
        missing: (e.missing_subtitles ?? []).map(langName),
      })),
    providers: prov,
    history,
  };
}

export const BAZARR_OPS = [
  "search-movie",
  "search-episode",
  "search-all",
  "reset-providers",
] as const;
type Op = (typeof BAZARR_OPS)[number];

export class BazarrOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  private use<T>(
    service: { id: string; localUrl: string },
    purpose: string,
    access: "read" | "change",
    fn: (key: string) => Promise<T>,
  ) {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value }) => fn(value),
    );
  }

  async plan(
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as Op;
    if (!BAZARR_OPS.includes(op)) throw new Error(`Say what to do: ${BAZARR_OPS.join(", ")}.`);
    const d = await this.use(service, "read Bazarr's wanted list", "read", (key) =>
      bazarrDashboard(this.fetchImpl, service.localUrl, key),
    );
    let label: string;
    let extra: Record<string, string | number> = {};
    if (op === "search-movie") {
      const m = d.movies.find((x) => x.radarrId === Number(params?.radarrId));
      if (!m) throw new Error("That movie is not missing subtitles any more.");
      label = `Search subtitles for ${m.title} (${m.missing.join(", ")}) in ${service.name}`;
      extra = { radarrId: m.radarrId, name: m.title };
    } else if (op === "search-episode") {
      const e = d.episodes.find((x) => x.episodeId === Number(params?.episodeId));
      if (!e) throw new Error("That episode is not missing subtitles any more.");
      label = `Search subtitles for ${e.title} (${e.missing.join(", ")}) in ${service.name}; Bazarr also checks that show's other missing episodes`;
      extra = { seriesId: e.seriesId, episodeId: e.episodeId, name: e.title };
    } else if (op === "search-all") {
      if (!d.totals.movies && !d.totals.episodes) throw new Error("Nothing is missing subtitles.");
      label = `Search subtitles for everything wanted in ${service.name} (${d.totals.movies} movies, ${d.totals.episodes} episodes)`;
    } else {
      if (!d.totals.throttled) throw new Error("No provider is throttled.");
      label = `Reset ${d.totals.throttled} throttled subtitle providers in ${service.name} so Bazarr tries them again`;
    }
    return {
      ...base,
      label,
      serviceName: service.name,
      params: { op, ...extra },
      change: {
        summary: label,
        settings: [{ name: String(extra.name ?? "Subtitles"), before: "missing", after: op }],
      },
    };
  }

  async run(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const op = String(p.op) as Op;
    const name = String(p.name || "subtitles");
    const outcome = await this.use(
      service,
      `${op} in Bazarr`,
      "change",
      async (key): Promise<StepOutcome> => {
        const base = service.localUrl;
        const c = (method: Method, path: string, timeout?: number) =>
          call<unknown>(this.fetchImpl, base, key, method, path, timeout);
        if (op === "reset-providers") {
          const r = await c("POST", "/api/providers?action=reset");
          if (!r.ok)
            return { ok: false, result: `Bazarr did not reset its providers (${r.status}).` };
          const d = await bazarrDashboard(this.fetchImpl, base, key);
          return d.totals.throttled
            ? {
                ok: false,
                result: `Bazarr reset them, but ${d.totals.throttled} still show throttled.`,
              }
            : { ok: true, result: "Every subtitle provider is back in use. Bazarr confirms it." };
        }
        if (op === "search-all") {
          const a = await c(
            "POST",
            "/api/system/tasks?taskid=wanted_search_missing_subtitles_movies",
          );
          const b = await c(
            "POST",
            "/api/system/tasks?taskid=wanted_search_missing_subtitles_series",
          );
          return a.ok && b.ok
            ? {
                ok: true,
                result:
                  "Bazarr started searching for every missing subtitle; it works through them in the background.",
              }
            : {
                ok: false,
                result: `Bazarr did not start the search (${a.ok ? b.status : a.status}).`,
              };
        }
        // One item: Bazarr searches while we wait (providers can be slow), then the wanted list says.
        const r =
          op === "search-movie"
            ? await c(
                "PATCH",
                `/api/movies?radarrid=${Number(p.radarrId)}&action=search-missing`,
                120_000,
              )
            : await c(
                "PATCH",
                `/api/series?seriesid=${Number(p.seriesId)}&action=search-missing`,
                120_000,
              );
        if (!r.ok && r.status !== 404)
          return { ok: false, result: `Bazarr could not search (${r.status}).` };
        const d = await bazarrDashboard(this.fetchImpl, base, key);
        const still =
          op === "search-movie"
            ? d.movies.find((m) => m.radarrId === Number(p.radarrId))
            : d.episodes.find((e) => e.episodeId === Number(p.episodeId));
        return {
          ok: true,
          result: still
            ? `Bazarr searched; no ${still.missing.join(", ")} subtitles found for ${name} yet. It keeps looking on its schedule.`
            : `Bazarr found subtitles for ${name}.`,
        };
      },
    );
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${op} (${name}) in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op, ok: outcome.ok },
    });
    return outcome;
  }
}
