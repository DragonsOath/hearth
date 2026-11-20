import { appKindOf } from "@dragon-control/core";
import { eq } from "drizzle-orm";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { AppUnreachableError, joinUrl, TIMEOUT_MS, type Fetch } from "./http";

/**
 * Recently Released by home release (11-13, the owner: "count recently released by digital
 * release, theatrical releases not counting, so Heart of the Beast is newer than something
 * released later on Netflix, like Masterplan. Toggle it off and it does it normally").
 *
 * Plex sorts Recently Released by each film's release date and has no setting for which one, so
 * with this on Hearth sets every film's release date in Plex to the day it came out at home
 * (Radarr's digital release, else its physical one) and locks it so a refresh keeps it. Films
 * Radarr has no home date for keep Plex's. New films get theirs as they arrive. Off puts every
 * date Hearth changed back as it was and unlocks it.
 */

interface Store {
  on: boolean;
  /** Each film Hearth changed (Plex's ratingKey) and the date it had before. */
  was: Record<string, string>;
}

interface Item {
  rk: string;
  lib: string;
  title: string;
  date: string;
  tmdb?: string;
}

const KEY = (serviceId: string) => `plex-digital:${serviceId}`;
/** How often new films are checked while it is on. */
const EVERY_MS = 6 * 3_600_000;

export class PlexDigitalDates {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  /** Keeps new films up to date while it is on (a while after start, then every few hours). */
  resume(delayMs = 60_000) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick()
        .catch(() => undefined)
        .finally(() => this.resume(EVERY_MS));
    }, delayMs);
    this.timer.unref?.();
  }

  async isOn(serviceId: string) {
    return (await this.load(serviceId)).on;
  }

  /** What turning it on or off would change: films and their dates before and after. */
  async preview(service: { id: string; localUrl: string }, on: boolean) {
    const store = await this.load(service.id);
    if (!on)
      return {
        changes: Object.keys(store.was).length,
        examples: [] as { title: string; from: string; to: string }[],
      };
    const { changes } = await this.diff(service, store);
    return {
      changes: changes.length,
      examples: changes.slice(0, 3).map((c) => ({ title: c.title, from: c.date, to: c.to })),
    };
  }

  /** On: every film gets its home release date, locked. Returns how many changed. */
  async apply(service: { id: string; localUrl: string }) {
    const store = await this.load(service.id);
    const { changes } = await this.diff(service, store);
    const groups = new Map<string, { lib: string; to: string; rks: string[] }>();
    for (const c of changes) {
      const k = `${c.lib}|${c.to}`;
      const g = groups.get(k) ?? { lib: c.lib, to: c.to, rks: [] };
      g.rks.push(c.rk);
      groups.set(k, g);
    }
    let done = 0;
    await this.plex(service, "change", "set release dates to home release", async (call) => {
      for (const g of groups.values())
        for (let i = 0; i < g.rks.length; i += 50) {
          const ids = g.rks.slice(i, i + 50);
          const q = new URLSearchParams({
            type: "1",
            id: ids.join(","),
            "originallyAvailableAt.value": g.to,
            "originallyAvailableAt.locked": "1",
          });
          const r = await call(`/library/sections/${g.lib}/all?${q.toString()}`, "PUT");
          if (!r.ok) continue;
          for (const rk of ids) {
            const c = changes.find((x) => x.rk === rk)!;
            if (!(rk in store.was)) store.was[rk] = c.date;
          }
          done += ids.length;
        }
    });
    store.on = true;
    await this.save(service.id, store);
    return done;
  }

  /** Off: every date Hearth changed goes back, unlocked. Returns how many went back. */
  async restore(service: { id: string; localUrl: string }) {
    const store = await this.load(service.id);
    const items = await this.items(service);
    const byRk = new Map(items.map((i) => [i.rk, i]));
    let done = 0;
    await this.plex(service, "change", "put release dates back", async (call) => {
      for (const [rk, date] of Object.entries(store.was)) {
        const item = byRk.get(rk);
        if (!item) {
          delete store.was[rk];
          continue;
        }
        const q = new URLSearchParams({
          type: "1",
          id: rk,
          "originallyAvailableAt.value": date,
          "originallyAvailableAt.locked": "0",
        });
        const r = await call(`/library/sections/${item.lib}/all?${q.toString()}`, "PUT");
        if (r.ok) {
          delete store.was[rk];
          done += 1;
        }
      }
    });
    store.on = false;
    await this.save(service.id, store);
    return { done, left: Object.keys(store.was).length };
  }

  /** While on: new films (and changed Radarr dates) get their home release date. */
  async tick() {
    const rows = await this.handle.db.select().from(t.settings).all();
    for (const r of rows) {
      if (!r.key.startsWith("plex-digital:")) continue;
      const v = r.value as Store | undefined;
      if (!v?.on) continue;
      const serviceId = r.key.slice("plex-digital:".length);
      const svc = await this.handle.db
        .select()
        .from(t.services)
        .where(eq(t.services.id, serviceId))
        .get();
      if (svc?.localUrl) await this.apply({ id: svc.id, localUrl: svc.localUrl });
    }
  }

  /** Each film whose Plex date differs from its home release date. */
  private async diff(service: { id: string; localUrl: string }, _store: Store) {
    const home = await this.homeDates();
    const items = await this.items(service);
    const changes: (Item & { to: string })[] = [];
    for (const i of items) {
      const h = i.tmdb ? home.get(i.tmdb) : undefined;
      if (!h) continue;
      // A home date more than a year after the film first came out is a re-release (a new 4K
      // disc of a 1978 film, seen in the owner's Radarr): the film keeps its own date.
      const first = h.theaters || i.date;
      if (first && Date.parse(h.home) - Date.parse(first) > 365 * 86_400_000) continue;
      const to = h.home;
      if (to === i.date) continue;
      changes.push({ ...i, to });
    }
    return { changes };
  }

  /** Every Radarr's home release dates, by TMDB id: digital first, else physical. */
  private async homeDates() {
    const out = new Map<string, { home: string; theaters: string }>();
    const rows = (await this.handle.db.select().from(t.services).all()).filter(
      (s) =>
        s.lifecycle === "active" &&
        s.localUrl &&
        !s.checkTarget?.startsWith("demo:") &&
        appKindOf({ name: s.name, image: s.image ?? undefined }) === "radarr",
    );
    if (!rows.length) throw new Error("Hearth needs Radarr for home release dates.");
    for (const s of rows) {
      const list = await this.broker.use(
        {
          serviceId: s.id,
          purpose: "read home release dates for Plex",
          access: "read",
          destination: s.localUrl!,
        },
        async ({ value }) => {
          const res = await this.fetchImpl(joinUrl(s.localUrl!, "/api/v3/movie"), {
            method: "GET",
            headers: { "X-Api-Key": value, Accept: "application/json" },
            signal: AbortSignal.timeout(TIMEOUT_MS * 6),
          });
          if (!res.ok) throw new AppUnreachableError(`${s.name} answered ${res.status}.`);
          return (await res.json()) as {
            tmdbId?: number;
            inCinemas?: string;
            digitalRelease?: string;
            physicalRelease?: string;
          }[];
        },
      );
      for (const m of list) {
        const at = (m.digitalRelease ?? m.physicalRelease ?? "").slice(0, 10);
        if (m.tmdbId && /^\d{4}-\d{2}-\d{2}$/.test(at) && !out.has(String(m.tmdbId)))
          out.set(String(m.tmdbId), { home: at, theaters: (m.inCinemas ?? "").slice(0, 10) });
      }
    }
    return out;
  }

  /** Every film in Plex's movie libraries: its release date and TMDB id. */
  private async items(service: { id: string; localUrl: string }) {
    return this.plex(service, "read", "read films' release dates", async (call) => {
      const secs = await this.json<{
        MediaContainer?: { Directory?: { key?: string; type?: string }[] };
      }>(call, "/library/sections");
      const out: Item[] = [];
      for (const d of secs.MediaContainer?.Directory ?? []) {
        if (d.type !== "movie" || !d.key) continue;
        const r = await this.json<{
          MediaContainer?: {
            Metadata?: {
              ratingKey?: string;
              title?: string;
              originallyAvailableAt?: string;
              Guid?: { id?: string }[];
            }[];
          };
        }>(call, `/library/sections/${d.key}/all?type=1&includeGuids=1`);
        for (const m of r.MediaContainer?.Metadata ?? []) {
          if (!m.ratingKey) continue;
          const tmdb = (m.Guid ?? [])
            .map((g) => /^tmdb:\/\/(\d+)$/.exec(g.id ?? "")?.[1])
            .find(Boolean);
          out.push({
            rk: String(m.ratingKey),
            lib: d.key,
            title: m.title ?? "",
            date: m.originallyAvailableAt ?? "",
            ...(tmdb ? { tmdb } : {}),
          });
        }
      }
      return out;
    });
  }

  private plex<T>(
    service: { id: string; localUrl: string },
    access: "read" | "change",
    purpose: string,
    fn: (call: (path: string, method?: string) => Promise<Res>) => Promise<T>,
  ) {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value: token }) =>
        fn(async (path, method = "GET") => {
          try {
            return await this.fetchImpl(joinUrl(service.localUrl, path), {
              method,
              headers: { Accept: "application/json", "X-Plex-Token": token },
              signal: AbortSignal.timeout(TIMEOUT_MS * 6),
            });
          } catch (error) {
            const why = error instanceof Error ? error.message : "no answer";
            throw new AppUnreachableError(
              `Plex did not answer: ${why.replaceAll(token, "[hidden]")}`,
            );
          }
        }),
    );
  }

  private async json<T>(call: (path: string) => Promise<Res>, path: string): Promise<T> {
    const r = await call(path);
    if (!r.ok)
      throw new AppUnreachableError(`Plex answered ${r.status} for ${path.split("?")[0]}.`);
    return (await r.json().catch(() => ({}))) as T;
  }

  private async load(serviceId: string): Promise<Store> {
    try {
      const r = await this.handle.db
        .select()
        .from(t.settings)
        .where(eq(t.settings.key, KEY(serviceId)))
        .get();
      const v = r?.value as Store | undefined;
      return { on: Boolean(v?.on), was: { ...(v?.was ?? {}) } };
    } catch {
      return { on: false, was: {} };
    }
  }

  private async save(serviceId: string, store: Store) {
    const at = new Date().toISOString();
    await this.handle.db
      .insert(t.settings)
      .values({ key: KEY(serviceId), value: store as never, updatedAt: at })
      .onConflictDoUpdate({
        target: t.settings.key,
        set: { value: store as never, updatedAt: at },
      });
  }
}

type Res = Awaited<ReturnType<Fetch>>;
