import type { MovieReleases } from "../watches/movie-release";

/**
 * What Radarr and Sonarr already have on disk, by TMDB id, so the Seerr panel and a request plan
 * can say "you already have this" even when Seerr forgot (11-19, the owner: a movie requested,
 * downloaded, then Stop tracking, showed in Seerr as not requested and could be requested again).
 * Seerr resets a title to "not requested" when its last request is removed before Seerr's own
 * Plex scan marked it available, so Seerr's word alone is not enough.
 */
export interface LibraryHit {
  app: "Radarr" | "Sonarr";
  serviceId: string;
  /** The Radarr or Sonarr it is in, by name. */
  service: string;
  /** Radarr: 1 when the movie's file is there. Sonarr: episode files on disk. */
  files: number;
  /** The movie's id in Radarr, or the series' id in Sonarr. */
  arrId: number;
}

/**
 * Upgrade quality (11-19, the owner liked Ember's Tasterr panel button): what a title in the
 * library is now, and the quality profiles it could move to. The panel plans the change with
 * Hearth's own Radarr and Sonarr steps (app-arr-edit, then a search), approved as usual.
 */
export interface UpgradeInfo {
  app: "radarr" | "sonarr";
  serviceId: string;
  service: string;
  arrId: number;
  profileId?: number;
  monitored: boolean;
  /** The file's quality now (Radarr), as Radarr names it. */
  quality?: string;
  profiles: { id: number; name: string; cutoff?: string }[];
}

type Profile = {
  id?: number;
  name?: string;
  cutoff?: number;
  items?: { quality?: { id?: number; name?: string }; id?: number; name?: string }[];
};

/** A profile's "upgrade until" quality, by name (a quality or a group of them). */
function cutoffName(p: Profile): string | undefined {
  for (const i of p.items ?? []) {
    if (i.quality?.id === p.cutoff) return i.quality?.name;
    if (i.id !== undefined && i.id === p.cutoff) return i.name;
  }
  return undefined;
}

type Index = Map<number, LibraryHit>;

/** How long one read of every Radarr and Sonarr is reused (a panel asks for many titles at once). */
const FRESH_MS = 60_000;

export class SeerrLibrary {
  private cache = new Map<"movie" | "tv", { at: number; apps: string; index: Promise<Index> }>();

  constructor(
    private readonly apps: Pick<MovieReleases, "services" | "read">,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Every movie (Radarr) or show (Sonarr) with files, by TMDB id. Unreadable apps are skipped. A
   * minute's answer is reused, unless a Radarr or Sonarr was added or removed since.
   */
  async index(type: "movie" | "tv"): Promise<Index> {
    const services = await this.apps.services(type === "movie" ? "radarr" : "sonarr");
    const apps = services.map((s) => s.id).join(",");
    const hit = this.cache.get(type);
    if (hit && hit.apps === apps && this.now() - hit.at < FRESH_MS) return hit.index;
    const index = this.read(type, services);
    this.cache.set(type, { at: this.now(), apps, index });
    index.catch(() => this.cache.delete(type));
    return index;
  }

  async find(type: "movie" | "tv", tmdbId: number): Promise<LibraryHit | undefined> {
    return (await this.index(type)).get(tmdbId);
  }

  private async read(
    type: "movie" | "tv",
    services: Awaited<ReturnType<MovieReleases["services"]>>,
  ): Promise<Index> {
    const index: Index = new Map();
    await Promise.all(
      services.map(async (s) => {
        const r = await this.apps
          .read<
            {
              id?: number;
              tmdbId?: number;
              hasFile?: boolean;
              statistics?: { episodeFileCount?: number };
            }[]
          >(
            s,
            type === "movie" ? "/api/v3/movie" : "/api/v3/series",
            "check what is already in the library for Seerr",
          )
          .catch(() => undefined);
        for (const x of r?.data ?? []) {
          const files =
            type === "movie" ? (x.hasFile ? 1 : 0) : (x.statistics?.episodeFileCount ?? 0);
          if (!x.tmdbId || !x.id || files <= 0 || index.has(x.tmdbId)) continue;
          index.set(x.tmdbId, {
            app: type === "movie" ? "Radarr" : "Sonarr",
            serviceId: s.id,
            service: s.name,
            files,
            arrId: x.id,
          });
        }
      }),
    );
    return index;
  }

  /**
   * A title in the library as it is now in Radarr or Sonarr (read fresh, not from the minute's
   * index, so the panel shows a change just approved), with the quality profiles it could use.
   */
  async upgrade(type: "movie" | "tv", tmdbId: number): Promise<UpgradeInfo | undefined> {
    const hit = await this.find(type, tmdbId);
    if (!hit) return undefined;
    const app = type === "movie" ? "radarr" : "sonarr";
    const services = await this.apps.services(app);
    const s = services.find((x) => x.id === hit.serviceId);
    if (!s) return undefined;
    const why = "show what a title's quality could be upgraded to";
    const [one, profiles] = await Promise.all([
      this.apps.read<{
        qualityProfileId?: number;
        monitored?: boolean;
        movieFile?: { quality?: { quality?: { name?: string } } };
      }>(s, `${type === "movie" ? "/api/v3/movie" : "/api/v3/series"}/${hit.arrId}`, why),
      this.apps.read<Profile[]>(s, "/api/v3/qualityprofile", why),
    ]);
    if (!one.data) return undefined;
    return {
      app,
      serviceId: s.id,
      service: s.name,
      arrId: hit.arrId,
      ...(one.data.qualityProfileId !== undefined ? { profileId: one.data.qualityProfileId } : {}),
      monitored: one.data.monitored !== false,
      ...(one.data.movieFile?.quality?.quality?.name
        ? { quality: one.data.movieFile.quality.quality.name }
        : {}),
      profiles: (profiles.data ?? [])
        .filter((p) => p.id !== undefined && p.name)
        .map((p) => ({
          id: p.id!,
          name: p.name!,
          ...(cutoffName(p) ? { cutoff: cutoffName(p) } : {}),
        })),
    };
  }

  /**
   * Seerr's answers for the panel with what is on disk added: a movie Seerr calls not requested
   * (or deleted) that Radarr has is "in your library"; a show keeps its status (other seasons can
   * still be asked for) and gains `library`, so the panel says Sonarr already has some of it.
   */
  async annotate<T>(view: string, data: T): Promise<T> {
    const one = async (r: Record<string, unknown>) => {
      const type = r.mediaType === "tv" ? "tv" : r.mediaType === "movie" ? "movie" : undefined;
      const tmdbId = Number(r.tmdbId);
      if (!type || !tmdbId) return;
      if (r.status !== "not requested" && r.status !== "deleted") return;
      const hit = await this.find(type, tmdbId).catch(() => undefined);
      if (!hit) return;
      r.library = { app: hit.app, service: hit.service, files: hit.files };
      if (type === "movie") r.status = "in your library";
    };
    if (!data || typeof data !== "object") return data;
    const d = data as Record<string, unknown>;
    const lists: unknown[] = [];
    if (view === "title") {
      lists.push(d);
      // Any title in the library can be upgraded, whatever Seerr calls it.
      const type = d.mediaType === "tv" ? "tv" : d.mediaType === "movie" ? "movie" : undefined;
      const tmdbId = Number(d.tmdbId);
      if (type && tmdbId) {
        const up = await this.upgrade(type, tmdbId).catch(() => undefined);
        if (up) d.upgrade = up;
      }
    }
    if (Array.isArray(d.results)) lists.push(...d.results);
    if (Array.isArray(d.rows))
      for (const row of d.rows as { results?: unknown[] }[])
        if (Array.isArray(row?.results)) lists.push(...row.results);
    await Promise.all(
      lists.map((x) =>
        x && typeof x === "object" ? one(x as Record<string, unknown>) : undefined,
      ),
    );
    return data;
  }
}
