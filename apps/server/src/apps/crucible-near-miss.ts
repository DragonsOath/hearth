import {
  DEFAULT_NEAR_MISS_SETTINGS,
  type NearMiss,
  type NearMissItem,
  type NearMissReport,
  type NearMissSettings,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import { getSetting, setSetting } from "../store/settings";
import type { Arr } from "./crucible-apply";

type Json = Record<string, unknown>;
const DAY = 24 * 60 * 60_000;
/** A title looked at is left alone this long, so the daily budget walks the whole list. */
const RECHECK_DAYS = 7;

export interface NearMissDeps {
  /** Every connected Radarr. */
  radarrs: () => Promise<{ id: string; name: string; localUrl: string }[]>;
  arrFor: (service: { id: string; name: string; localUrl: string }) => Arr;
  /** One interactive search (no download), with what it says about why nothing was grabbed. */
  search: (serviceId: string, movieId: number) => Promise<NearMiss | undefined>;
  now?: () => number;
}

/**
 * Near misses on their own (the Crucible, plan step 8; Flint and the owner, 11-17): once a day, up
 * to `perDay` movies that have been missing at least `minDays` (oldest first, each at most once a
 * week) are searched without downloading, and the result is kept: nothing exists, something fits,
 * or the owner's own rules turned every release down (with the closest one for Grab it anyway).
 * It changes nothing; grabbing is a plan the owner approves.
 */
export class NearMissWatch {
  private running?: Promise<NearMissReport>;
  constructor(
    private readonly handle: DbHandle,
    private readonly deps: NearMissDeps,
  ) {}

  private get now() {
    return this.deps.now?.() ?? Date.now();
  }

  async settings(): Promise<NearMissSettings> {
    return {
      ...DEFAULT_NEAR_MISS_SETTINGS,
      ...((await getSetting(this.handle.db, "crucible_near_miss_settings")) ?? {}),
    };
  }

  async setSettings(patch: Partial<NearMissSettings>): Promise<NearMissSettings> {
    const next = { ...(await this.settings()), ...patch };
    next.perDay = Math.max(0, Math.min(50, Math.round(next.perDay)));
    next.minDays = Math.max(0, Math.min(365, Math.round(next.minDays)));
    await setSetting(this.handle.db, "crucible_near_miss_settings", next);
    return next;
  }

  async report(): Promise<NearMissReport> {
    const saved = await getSetting(this.handle.db, "crucible_near_misses");
    return {
      settings: await this.settings(),
      ...(saved?.checkedAt ? { checkedAt: saved.checkedAt } : {}),
      items: saved?.items ?? [],
    };
  }

  /** Has the daily check run today (for the timer)? */
  async due(): Promise<boolean> {
    const saved = await getSetting(this.handle.db, "crucible_near_misses");
    return !saved?.checkedAt || this.now - Date.parse(saved.checkedAt) >= DAY - 60_000;
  }

  /** The daily check (one at a time). */
  check(): Promise<NearMissReport> {
    this.running ??= this.run().finally(() => (this.running = undefined));
    return this.running;
  }

  private async run(): Promise<NearMissReport> {
    const db = this.handle.db;
    const settings = await this.settings();
    const saved = (await getSetting(db, "crucible_near_misses")) ?? { items: [], lastChecked: {} };
    const lastChecked = { ...saved.lastChecked };
    const now = this.now;
    const keep: NearMissItem[] = [];
    const candidates: { service: { id: string; name: string; localUrl: string }; movie: Json }[] =
      [];
    for (const service of await this.deps.radarrs()) {
      // One Radarr that can't be read (no key yet, offline) never stops the others.
      const r = await this.deps
        .arrFor(service)<Json[]>("GET", "/api/v3/movie", "read the library (near misses)")
        .catch(() => ({ ok: false, status: 0, data: undefined }));
      if (!r.ok || !Array.isArray(r.data)) {
        // Unreachable: what it had stays as it was.
        keep.push(...saved.items.filter((i) => i.serviceId === service.id));
        continue;
      }
      const missing = r.data.filter(
        (m) =>
          m.monitored !== false &&
          !m.hasFile &&
          m.isAvailable !== false &&
          now - Date.parse(String(m.added ?? "")) >= settings.minDays * DAY,
      );
      const still = new Set(missing.map((m) => Number(m.id)));
      // Results for movies that are still missing stay; the rest (found since, removed) go.
      keep.push(...saved.items.filter((i) => i.serviceId === service.id && still.has(i.movieId)));
      for (const m of missing) candidates.push({ service, movie: m });
    }
    const due = candidates
      .filter(({ service, movie }) => {
        const at = lastChecked[`${service.id}:${String(movie.id)}`];
        return !at || now - Date.parse(at) >= RECHECK_DAYS * DAY;
      })
      .sort((a, b) => Date.parse(String(a.movie.added)) - Date.parse(String(b.movie.added)))
      .slice(0, settings.perDay);
    const at = new Date(now).toISOString();
    for (const { service, movie } of due) {
      const key = `${service.id}:${String(movie.id)}`;
      let nm: NearMiss | undefined;
      try {
        nm = await this.deps.search(service.id, Number(movie.id));
      } catch {
        continue; // An indexer error: tried again next time.
      }
      lastChecked[key] = at;
      if (!nm) continue;
      const item: NearMissItem = {
        serviceId: service.id,
        service: service.name,
        movieId: Number(movie.id),
        title: `${String(movie.title)}${movie.year ? ` (${String(movie.year)})` : ""}`,
        checkedAt: at,
        kind: nm.kind,
        sentence: nm.sentence,
        ...(nm.kind === "blocked" && nm.closest
          ? {
              closest: {
                guid: nm.closest.guid,
                indexerId: nm.closest.indexerId,
                title: nm.closest.title,
                ...(nm.closest.quality ? { quality: nm.closest.quality } : {}),
                ...(nm.closest.sizeGB !== undefined ? { sizeGB: nm.closest.sizeGB } : {}),
                ...(nm.closest.indexer ? { indexer: nm.closest.indexer } : {}),
              },
            }
          : {}),
      };
      const i = keep.findIndex((x) => x.serviceId === item.serviceId && x.movieId === item.movieId);
      if (i >= 0) keep[i] = item;
      else keep.push(item);
    }
    // Forget looks at titles no longer missing (the map stays small).
    const live = new Set(
      candidates.map(({ service, movie }) => `${service.id}:${String(movie.id)}`),
    );
    for (const k of Object.keys(lastChecked)) if (!live.has(k)) delete lastChecked[k];
    // Turned down by the owner's rules first (the useful ones), then the rest.
    const order = { blocked: 0, available: 1, none: 2 } as const;
    keep.sort((a, b) => order[a.kind] - order[b.kind] || a.title.localeCompare(b.title));
    await setSetting(db, "crucible_near_misses", { checkedAt: at, items: keep, lastChecked });
    return { settings, checkedAt: at, items: keep };
  }
}
