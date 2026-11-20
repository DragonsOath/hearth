import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  HEARTH_PREFIX,
  HOLD_PROFILE,
  arrTitle,
  rowFor,
  rowProfileName,
  safeToMove,
  type CrucibleSetup,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { Memory } from "../memory/service";
import { recordAudit } from "../store/audit";
import { getSetting, setSetting } from "../store/settings";
import { SHAPES, giveRow, shapeOf, type Arr, type ArrShape } from "./crucible-apply";
import { appKindOf } from "@dragon-control/core";
import type { SeerrOperations } from "./seerr-ops";

type Json = Record<string, unknown>;

/**
 * The Crucible's keeper (11-17, plan step 5, approved with the plan): every few minutes, each
 * movie added to a Radarr since it last looked (Seerr requests included) gets its row's profile.
 * Only new movies, each once: a movie someone later moves by hand is never moved back, and the
 * movies there before Save are only moved when Save was asked to. Off with the Crucible's switch
 * "Give new movies their row automatically". Each move is in the audit log and the journal.
 */
export async function keepNewMovies(
  arr: Arr,
  setup: CrucibleSetup,
  /** The highest movie id already handled; undefined: first look, nothing moves. */
  seenId: number | undefined,
  thisYear: number,
  /** Automatic sorting off: only the waiting requests (never strand them). */
  onlyHeld = false,
  shape: ArrShape = SHAPES.radarr,
): Promise<{ moved: { title: string; to: string }[]; lastId: number }> {
  const get = async (path: string) => {
    const r = await arr<Json[]>("GET", path, "read the library (the Crucible)");
    if (!r.ok || !Array.isArray(r.data))
      throw new Error(`Radarr did not answer ${path} (${r.status}).`);
    return r.data;
  };
  const movies = await get(shape.items);
  const lastId = Math.max(seenId ?? 0, ...movies.map((m) => Number(m.id)));
  const [profiles, tags] = await Promise.all([get("/api/v3/qualityprofile"), get("/api/v3/tag")]);
  const idOf = new Map(profiles.map((p) => [String(p.name), Number(p.id)]));
  // Waiting for the Crucible (Seerr's requests while the Crucible starts the searches): always
  // sorted, however old, so a request that came in while Hearth was down is caught up now.
  const hold = idOf.get(HOLD_PROFILE);
  const fresh = movies.filter(
    (m) =>
      (hold !== undefined && Number(m.qualityProfileId) === hold) ||
      (!onlyHeld && seenId !== undefined && Number(m.id) > seenId),
  );
  if (!fresh.length) return { moved: [], lastId };
  const label = new Map(tags.map((x) => [Number(x.id), String(x.label)]));
  const byTarget = new Map<string, Json[]>();
  for (const m of fresh) {
    const r = rowFor(arrTitle(m, label), shape.rows(setup), thisYear);
    if (!r) continue;
    const to = rowProfileName(r);
    if (!idOf.has(to) || idOf.get(to) === Number(m.qualityProfileId)) continue;
    byTarget.set(to, [...(byTarget.get(to) ?? []), m]);
  }
  const moved: { title: string; to: string }[] = [];
  for (const [to, list] of byTarget) {
    const ok = await giveRow(
      arr,
      shape,
      list.map((m) => Number(m.id)),
      idOf.get(to),
      shape.rows(setup).find((x) => rowProfileName(x) === to),
      `give ${list.length} new ${shape.many} their row (the Crucible)`,
    );
    const r = { ok };
    if (!r.ok) continue;
    for (const m of list)
      moved.push({
        title: `${String(m.title)}${m.year ? ` (${String(m.year)})` : ""}`,
        to: to.slice(HEARTH_PREFIX.length),
      });
    // Missed by the webhook (Hearth was down): when Hearth starts the searches, start these now.
    // Searched now: when Hearth starts the searches, and always for a request that was waiting.
    const search = list
      .filter(
        (m) =>
          (setup.searchAfterSorting || Number(m.qualityProfileId) === hold) && shape.wanting(m),
      )
      .map((m) => Number(m.id));
    for (const cmd of search.length ? shape.search(search) : [])
      await arr(
        "POST",
        "/api/v3/command",
        `search for new ${shape.many} with their row's profile (the Crucible)`,
        cmd,
      );
  }
  return { moved, lastId };
}

/**
 * Titles follow the rules as they age (11-18, the owner): each title on one of Hearth's row
 * profiles whose rule is now a different one moves there, only when that replaces nothing (no
 * file yet, or its file already fits). Titles moved by hand to a profile Hearth didn't make are
 * never touched, nor requests waiting for the Crucible (the keeper sorts those).
 */
export async function followAging(
  arr: Arr,
  setup: CrucibleSetup,
  thisYear: number,
  shape: ArrShape = SHAPES.radarr,
  now: Date = new Date(),
): Promise<{ moved: { title: string; to: string }[]; kept: number }> {
  const get = async (path: string) => {
    const r = await arr<Json[]>("GET", path, "read the library (the Crucible, titles aging)");
    if (!r.ok || !Array.isArray(r.data))
      throw new Error(`${shape.App} did not answer ${path} (${r.status}).`);
    return r.data;
  };
  const [items, profiles, tags] = await Promise.all([
    get(shape.items),
    get("/api/v3/qualityprofile"),
    get("/api/v3/tag"),
  ]);
  const rows = shape.rows(setup);
  const nameOf = new Map(profiles.map((p) => [Number(p.id), String(p.name)]));
  const idOf = new Map(profiles.map((p) => [String(p.name), Number(p.id)]));
  const rowNames = new Set(rows.map(rowProfileName));
  const label = new Map(tags.map((x) => [Number(x.id), String(x.label)]));
  const byTarget = new Map<string, Json[]>();
  let kept = 0;
  for (const m of items) {
    const now_ = nameOf.get(Number(m.qualityProfileId)) ?? "";
    if (!rowNames.has(now_)) continue;
    const title = arrTitle(m, label, now);
    const r = rowFor(title, rows, thisYear);
    if (!r) continue;
    const to = rowProfileName(r);
    if (to === now_ || !idOf.has(to)) continue;
    if (!safeToMove(title, r)) {
      kept += 1;
      continue;
    }
    byTarget.set(to, [...(byTarget.get(to) ?? []), m]);
  }
  const moved: { title: string; to: string }[] = [];
  for (const [to, list] of byTarget) {
    const ok = await giveRow(
      arr,
      shape,
      list.map((m) => Number(m.id)),
      idOf.get(to),
      rows.find((x) => rowProfileName(x) === to),
      `move ${list.length} ${shape.many} to the rule they fit now (the Crucible)`,
    );
    if (!ok) continue;
    for (const m of list)
      moved.push({
        title: `${String(m.title)}${m.year ? ` (${String(m.year)})` : ""}`,
        to: to.slice(HEARTH_PREFIX.length),
      });
  }
  return { moved, kept };
}

/**
 * One movie, the moment Radarr says it was added (its "On Movie Added" webhook): its row's
 * profile now, then, when Seerr's own search is off for this Radarr, the search, so the first
 * search uses the row's profile. Movies that already have a file or aren't monitored aren't searched.
 */
export async function sortOne(
  arr: Arr,
  setup: CrucibleSetup,
  movieId: number,
  thisYear: number,
  /** Automatic sorting off: only a request waiting for the Crucible is sorted (never stranded). */
  onlyIfHeld = false,
  shape: ArrShape = SHAPES.radarr,
): Promise<{ title: string; to?: string; searched: boolean }> {
  const m = await arr<Json>(
    "GET",
    `${shape.items}/${movieId}`,
    `read the new ${shape.one} (the Crucible)`,
  );
  if (!m.ok || !m.data) throw new Error(`${shape.App} has no ${shape.one} #${movieId}.`);
  const movie = m.data;
  const title = `${String(movie.title)}${movie.year ? ` (${String(movie.year)})` : ""}`;
  const [profiles, tags] = await Promise.all([
    arr<Json[]>("GET", "/api/v3/qualityprofile", "read the profiles (the Crucible)"),
    arr<Json[]>("GET", "/api/v3/tag", "read the tags (the Crucible)"),
  ]);
  const idOf = new Map((profiles.data ?? []).map((p) => [String(p.name), Number(p.id)]));
  const label = new Map((tags.data ?? []).map((x) => [Number(x.id), String(x.label)]));
  const held = idOf.get(HOLD_PROFILE) === Number(movie.qualityProfileId);
  if (onlyIfHeld && !held) return { title, searched: false };
  const r = rowFor(arrTitle(movie, label), shape.rows(setup), thisYear);
  const target = r ? idOf.get(rowProfileName(r)) : undefined;
  let to: string | undefined;
  if (r && target !== undefined && target !== Number(movie.qualityProfileId)) {
    if (await giveRow(arr, shape, [movieId], target, r, `give ${title} its row (the Crucible)`))
      to = r.name;
  }
  let searched = false;
  if ((setup.searchAfterSorting || (held && to)) && shape.wanting(movie)) {
    const c = await arr(
      "POST",
      "/api/v3/command",
      `search for ${title} with its row's profile (the Crucible)`,
      shape.search([movieId])[0],
    );
    searched = c.ok;
  }
  return { title, ...(to ? { to } : {}), searched };
}

/**
 * The clean exit (Flint, 11-17): every movie waiting on the holding profile goes to its row's
 * profile (or, without rows, Seerr's earlier default, else Radarr's first profile not made by
 * Hearth), then is searched. Run before the checkpoint is turned off, before Undo removes the
 * profiles, and before Hearth is uninstalled, so nothing is left stranded where it can't be grabbed.
 */
export async function releaseHeld(
  arr: Arr,
  setup: CrucibleSetup | undefined,
  thisYear: number,
  fallback?: { id?: number; name?: string },
  shape: ArrShape = SHAPES.radarr,
): Promise<{ released: { title: string; to: string }[]; searched: number; stuck: string[] }> {
  const get = async (path: string) => {
    const r = await arr<Json[]>("GET", path, "read the library (the Crucible's exit)");
    if (!r.ok || !Array.isArray(r.data))
      throw new Error(`Radarr did not answer ${path} (${r.status}).`);
    return r.data;
  };
  const [movies, profiles, tags] = await Promise.all([
    get(shape.items),
    get("/api/v3/qualityprofile"),
    get("/api/v3/tag"),
  ]);
  const hold = profiles.find((p) => p.name === HOLD_PROFILE);
  if (!hold) return { released: [], searched: 0, stuck: [] };
  const held = movies.filter((m) => Number(m.qualityProfileId) === Number(hold.id));
  if (!held.length) return { released: [], searched: 0, stuck: [] };
  const byName = new Map(profiles.map((p) => [String(p.name), p]));
  const byId = new Map(profiles.map((p) => [Number(p.id), p]));
  const label = new Map(tags.map((x) => [Number(x.id), String(x.label)]));
  const plain = profiles.find((p) => !String(p.name).startsWith(HEARTH_PREFIX));
  const other =
    (fallback?.id !== undefined ? byId.get(fallback.id) : undefined) ??
    (fallback?.name ? byName.get(fallback.name) : undefined) ??
    plain;
  const byTarget = new Map<number, Json[]>();
  const stuck: string[] = [];
  const titleOf = (m: Json) => `${String(m.title)}${m.year ? ` (${String(m.year)})` : ""}`;
  for (const m of held) {
    const rows = setup ? shape.rows(setup) : [];
    const r = rows.length ? rowFor(arrTitle(m, label), rows, thisYear) : undefined;
    const target = (r ? byName.get(rowProfileName(r)) : undefined) ?? other;
    if (!target || Number(target.id) === Number(hold.id)) {
      stuck.push(titleOf(m));
      continue;
    }
    byTarget.set(Number(target.id), [...(byTarget.get(Number(target.id)) ?? []), m]);
  }
  const released: { title: string; to: string }[] = [];
  let searched = 0;
  for (const [to, list] of byTarget) {
    const rowName = String(byId.get(to)?.name ?? "");
    const ok = await giveRow(
      arr,
      shape,
      list.map((m) => Number(m.id)),
      to,
      (setup ? shape.rows(setup) : []).find((x) => rowProfileName(x) === rowName),
      `release waiting ${shape.many} (the Crucible)`,
    );
    if (!ok) {
      stuck.push(...list.map(titleOf));
      continue;
    }
    const name = String(byId.get(to)?.name ?? "");
    for (const m of list)
      released.push({
        title: titleOf(m),
        to: name.startsWith(HEARTH_PREFIX) ? name.slice(HEARTH_PREFIX.length) : name,
      });
    const search = list.filter((m) => shape.wanting(m)).map((m) => Number(m.id));
    for (const cmd of search.length ? shape.search(search) : []) {
      const c = await arr(
        "POST",
        "/api/v3/command",
        `search for released ${shape.many} (the Crucible)`,
        cmd,
      );
      if (c.ok) searched += shape.app === "sonarr" ? 1 : search.length;
    }
  }
  return { released, searched, stuck };
}

/** Radarr or Sonarr, from the service as Hearth knows it. */
const shapeFor = (svc: { name: string; image?: string | null }) =>
  shapeOf(appKindOf({ name: svc.name, image: svc.image ?? undefined }));

export class CrucibleKeeper {
  constructor(
    private readonly handle: DbHandle,
    private readonly arrFor: (service: { id: string; name: string; localUrl: string }) => Arr,
    private readonly memory?: Memory,
    private readonly now: () => number = Date.now,
    private readonly seerr?: SeerrOperations,
    private readonly dataDir?: string,
  ) {}

  /** The services the Crucible touches, by id (Radarrs with saved rows, Seerrs it took over). */
  private async serviceOf(id: string) {
    const svc = await this.handle.db.select().from(t.services).where(eq(t.services.id, id)).get();
    return svc?.localUrl
      ? { id: svc.id, name: svc.name, localUrl: svc.localUrl, shape: shapeFor(svc) }
      : undefined;
  }

  /** What the clean exit would do: requests waiting per Radarr, and Seerrs to hand back. */
  async exitPreview(): Promise<{
    waiting: { service: string; titles: string[] }[];
    seerrs: string[];
  }> {
    const db = this.handle.db;
    const setups = (await getSetting(db, "crucible")) ?? {};
    const checkpoint = (await getSetting(db, "crucible_seerr")) ?? {};
    const waiting: { service: string; titles: string[] }[] = [];
    for (const id of Object.keys(setups)) {
      const service = await this.serviceOf(id);
      if (!service) continue;
      const arr = this.arrFor(service);
      const [movies, profiles] = await Promise.all([
        arr<Json[]>("GET", service.shape.items, "read the library (the Crucible's exit)"),
        arr<Json[]>("GET", "/api/v3/qualityprofile", "read the profiles (the Crucible's exit)"),
      ]);
      const hold = (profiles.data ?? []).find((p) => p.name === HOLD_PROFILE);
      if (!hold) continue;
      const titles = (movies.data ?? [])
        .filter((m) => Number(m.qualityProfileId) === Number(hold.id))
        .map((m) => `${String(m.title)}${m.year ? ` (${String(m.year)})` : ""}`);
      if (titles.length) waiting.push({ service: service.name, titles });
    }
    const seerrs: string[] = [];
    for (const [id, kept] of Object.entries(checkpoint))
      seerrs.push(
        `${(await this.serviceOf(id.split(":")[0]!))?.name ?? id}${kept.app === "sonarr" ? " (shows)" : ""}`,
      );
    return { waiting, seerrs };
  }

  /**
   * The clean exit (Flint, 11-17; before uninstalling Hearth): each Seerr the Crucible took over
   * searches by itself again with the default profile it had (so no new request lands on the
   * holding profile), then every waiting request gets its row (or that default) and is searched.
   */
  async exit(): Promise<{ ok: boolean; lines: string[]; problems: string[] }> {
    const db = this.handle.db;
    const lines: string[] = [];
    const problems: string[] = [];
    const checkpoint = (await getSetting(db, "crucible_seerr")) ?? {};
    const fallbacks: { app: "radarr" | "sonarr"; id?: number; name?: string }[] = [];
    for (const [id, kept] of Object.entries(checkpoint)) {
      const app = kept.app ?? "radarr";
      fallbacks.push({
        app,
        ...(kept.profileBefore !== undefined ? { id: kept.profileBefore } : {}),
        ...(kept.profileBeforeName ? { name: kept.profileBeforeName } : {}),
      });
      const service = await this.serviceOf(id.split(":")[0]!);
      if (!service || !this.seerr) {
        problems.push(
          `Seerr (${service?.name ?? id}) could not be reached to turn its search back on.`,
        );
        continue;
      }
      try {
        const base = {
          label: "",
          serviceName: service.name,
          changes: true,
          policy: "allow" as const,
          policyReason: "",
        };
        const planned = await this.seerr.plan(
          "app-seerr-search-on-add",
          service,
          { search: true, serverId: kept.serverId, ...(app === "sonarr" ? { app } : {}) },
          base,
        );
        const done = await this.seerr.run(
          {
            kind: "app-seerr-search-on-add",
            serviceId: service.id,
            requestedBy: "dragon-control",
            params: planned.params ?? {},
          },
          service,
        );
        if (done.ok)
          lines.push(
            `${service.name} searches by itself again, on ${kept.profileBeforeName ?? "its earlier default profile"}.`,
          );
        else problems.push(`${service.name}: ${done.result}`);
      } catch (e) {
        problems.push(`${service.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const setups = (await getSetting(db, "crucible")) ?? {};
    for (const [id, setup] of Object.entries(setups)) {
      const service = await this.serviceOf(id);
      if (!service) continue;
      try {
        const kind = service.shape.app;
        const fallback = fallbacks.find((f) => f.app === kind);
        const r = await releaseHeld(
          this.arrFor(service),
          setup,
          new Date(this.now()).getFullYear(),
          fallback,
          service.shape,
        );
        if (r.released.length)
          lines.push(
            `${service.name}: ${r.released.length} waiting ${r.released.length === 1 ? "request got its" : "requests got their"} profile and ${r.searched} searched.`,
          );
        if (r.stuck.length)
          problems.push(
            `${service.name}: still waiting, move them in Radarr: ${r.stuck.join(", ")}.`,
          );
        setups[id] = { ...setup, searchAfterSorting: false };
      } catch (e) {
        problems.push(`${service.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await setSetting(db, "crucible", setups);
    await this.syncMarker();
    if (lines.length || problems.length)
      await recordAudit(db, {
        actor: "dragon-control",
        action: `The Crucible's clean exit: ${[...lines, ...problems].join(" ")}`,
        target: "tool:crucible",
        detail: { lines, problems },
      });
    return { ok: problems.length === 0, lines, problems };
  }

  /**
   * A small file in Hearth's data folder while the request checkpoint is on, so an installer's
   * --uninstall can warn that Seerr's requests would be left waiting.
   */
  async syncMarker(): Promise<void> {
    if (!this.dataDir) return;
    const file = path.join(this.dataDir, "crucible-checkpoint.json");
    const checkpoint = (await getSetting(this.handle.db, "crucible_seerr")) ?? {};
    try {
      if (Object.keys(checkpoint).length)
        await writeFile(
          file,
          JSON.stringify({ on: true, seerrs: Object.keys(checkpoint).length }) + "\n",
        );
      else await rm(file, { force: true });
    } catch {
      /* the data folder is read-only or gone; the in-app uninstall still does the exit */
    }
  }

  /** Radarr's "On Movie Added" webhook: sort that one movie now (and search, when Hearth does). */
  async added(serviceId: string, movieId: number): Promise<string | undefined> {
    const db = this.handle.db;
    const setup = ((await getSetting(db, "crucible")) ?? {})[serviceId];
    if (!setup) return undefined;
    const svc = await db.select().from(t.services).where(eq(t.services.id, serviceId)).get();
    if (!svc?.localUrl) return undefined;
    const service = { id: svc.id, name: svc.name, localUrl: svc.localUrl };
    const shape = shapeFor(svc);
    const r = await sortOne(
      this.arrFor(service),
      setup,
      movieId,
      new Date(this.now()).getFullYear(),
      setup.autoAssign === false,
      shape,
    );
    if (!r.to && !r.searched) return undefined;
    const what = `${r.title}${r.to ? ` → ${r.to}` : ""}${r.searched ? ", then searched" : ""}`;
    await recordAudit(db, {
      actor: "dragon-control",
      action: `The Crucible sorted a new ${shape.one} the moment it was added: ${what}`,
      target: `service:${service.id}`,
      detail: { movieId, ...r },
    });
    return `${service.name}: ${what}`;
  }

  /** One pass over every Radarr with saved rows (the safety net). Returns a line per movie moved. */
  async tick(): Promise<string[]> {
    const db = this.handle.db;
    const setups = (await getSetting(db, "crucible")) ?? {};
    const seen = (await getSetting(db, "crucible_seen")) ?? {};
    const lines: string[] = [];
    await this.syncMarker();
    for (const [serviceId, setup] of Object.entries(setups)) {
      // Automatic sorting off still releases requests waiting for the Crucible.
      const onlyHeld = setup.autoAssign === false;
      const svc = await db.select().from(t.services).where(eq(t.services.id, serviceId)).get();
      if (!svc?.localUrl) continue;
      const service = { id: svc.id, name: svc.name, localUrl: svc.localUrl };
      const shape = shapeFor(svc);
      try {
        const r = await keepNewMovies(
          this.arrFor(service),
          setup,
          seen[serviceId],
          new Date(this.now()).getFullYear(),
          onlyHeld,
          shape,
        );
        seen[serviceId] = r.lastId;
        if (!r.moved.length) continue;
        const what = r.moved.map((m) => `${m.title} → ${m.to}`).join("; ");
        lines.push(`${service.name}: ${what}`);
        await recordAudit(db, {
          actor: "dragon-control",
          action: `The Crucible gave ${r.moved.length} new ${r.moved.length === 1 ? shape.one : shape.many} their row's profile`,
          target: `service:${service.id}`,
          detail: { moved: r.moved },
        });
        await this.memory
          ?.recordSystem(db, {
            title: `The Crucible sorted ${r.moved.length} new ${r.moved.length === 1 ? "movie" : "movies"} in ${service.name}`,
            body: what.slice(0, 600),
            happenedAt: new Date(this.now()).toISOString(),
            links: [{ label: service.name, ref: `service:${service.id}` }],
          })
          .catch(() => undefined);
      } catch {
        // Radarr unreachable this time: tried again on the next pass.
      }
    }
    await setSetting(db, "crucible_seen", seen);
    lines.push(...(await this.age()));
    return lines;
  }

  /** Once a day per app: titles follow the rules as they age (unless switched off). */
  async age(force = false): Promise<string[]> {
    const db = this.handle.db;
    const setups = (await getSetting(db, "crucible")) ?? {};
    const last = (await getSetting(db, "crucible_aged")) ?? {};
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const lines: string[] = [];
    for (const [serviceId, setup] of Object.entries(setups)) {
      if (setup.followAge === false || (!force && last[serviceId] === today)) continue;
      const svc = await db.select().from(t.services).where(eq(t.services.id, serviceId)).get();
      if (!svc?.localUrl) continue;
      const service = { id: svc.id, name: svc.name, localUrl: svc.localUrl };
      const shape = shapeFor(svc);
      try {
        const r = await followAging(
          this.arrFor(service),
          setup,
          new Date(this.now()).getFullYear(),
          shape,
          new Date(this.now()),
        );
        last[serviceId] = today;
        if (!r.moved.length) continue;
        const what = r.moved.map((m) => `${m.title} → ${m.to}`).join("; ");
        lines.push(`${service.name}: ${what}`);
        await recordAudit(db, {
          actor: "dragon-control",
          action: `The Crucible moved ${r.moved.length} ${r.moved.length === 1 ? shape.one : shape.many} to the rule they fit now (they aged)`,
          target: `service:${service.id}`,
          detail: { moved: r.moved, kept: r.kept },
        });
      } catch {
        // Unreachable today: tried again on the next pass.
      }
    }
    await setSetting(db, "crucible_aged", last);
    return lines;
  }
}
