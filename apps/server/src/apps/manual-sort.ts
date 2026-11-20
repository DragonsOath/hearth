import {
  appKindOf,
  classifyFiles,
  classifyName,
  mapPath,
  SORT_TYPE_LABEL,
  SORT_TYPE_PLURAL,
  SORT_TYPES,
  type ManualSortConfig,
  type ManualSortEvent,
  type ManualSortView,
  type SortApp,
  type SortTarget,
  type SortType,
  type StepChange,
  type StepParams,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { CredentialBroker } from "../credentials/broker";
import { getSetting, setSetting } from "../store/settings";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { AppUnreachableError, joinUrl, TIMEOUT_MS, type Fetch } from "./http";
import type { Session } from "./qbittorrent-control";

/**
 * Sorting manual downloads (the owner, 2026-11-07; checklist: qBittorrent "Manual downloads").
 *
 * A torrent added by hand has no category, so qBittorrent leaves it in its default folder and no
 * app imports it. Once the owner approves the setup plan (app-qbt-manual-sort, mode "setup"), a
 * finished torrent with no category is judged by its files every minute, given the category for
 * its type (qBittorrent itself moves the files, so seeding carries on), and handed to the app that
 * imports that type (Radarr, Sonarr, Lidarr, Chaptarr), which renames and files it the way it
 * would its own grab. A title Radarr or Sonarr does not have yet is added first, without a search.
 * SABnzbd jobs with no category are judged by their name and handed over the same way.
 *
 * Never: a torrent that already has a category (an app's own download), a guess (Unsorted
 * instead), a delete, or a move outside qBittorrent. Each sort is in the history with Undo.
 */

type Raw = {
  hash: string;
  name: string;
  category?: string;
  tags?: string;
  progress?: number;
  state?: string;
  save_path?: string;
  content_path?: string;
  completion_on?: number;
  auto_tmm?: boolean;
};

/** Marks a torrent the owner took back from the sorter (Undo): never sorted again. */
export const SKIP_TAG = "hearth-not-sorted";
const LOG_MAX = 200;
const DONE_STATE = /^(uploading|stalledUP|pausedUP|stoppedUP|queuedUP|forcedUP|checkingUP)$/;

interface ServiceRow {
  id: string;
  name: string;
  localUrl: string | null;
  image?: string | null;
  lifecycle?: string;
  checkTarget?: string | null;
}

const norm = (p: string) => p.replace(/\/+$/, "");
const now = () => new Date().toISOString();
const newId = () => `ms-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export class ManualSorter {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
    /** A signed-in qBittorrent session (the same one every torrent plan uses). */
    private readonly qb: (service: { id: string; name: string; localUrl: string }) => Session,
  ) {}

  /* ---------------- stored state ---------------- */

  private async configs(): Promise<Record<string, ManualSortConfig>> {
    return (await getSetting(this.handle.db, "manual_sort")) ?? {};
  }
  private async saveConfig(serviceId: string, config: ManualSortConfig | undefined) {
    const all = await this.configs();
    if (config) all[serviceId] = config;
    else delete all[serviceId];
    await setSetting(this.handle.db, "manual_sort", all);
  }
  private async log(): Promise<ManualSortEvent[]> {
    return (await getSetting(this.handle.db, "manual_sort_log")) ?? [];
  }
  private async record(event: ManualSortEvent) {
    const list = (await this.log()).filter((e) => e.id !== event.id);
    list.unshift({ ...event, updatedAt: now() });
    await setSetting(this.handle.db, "manual_sort_log", list.slice(0, LOG_MAX));
  }

  private async services(): Promise<ServiceRow[]> {
    return (await this.handle.db.select().from(t.services).all()) as ServiceRow[];
  }
  private live(rows: ServiceRow[]) {
    return rows.filter(
      (s) => s.lifecycle === "active" && s.localUrl && !s.checkTarget?.startsWith("demo:"),
    );
  }

  /* ---------------- the apps ---------------- */

  /** One call to an *arr app with its key from the vault (v3 for Radarr/Sonarr, v1 otherwise). */
  private async arr<T>(
    svc: ServiceRow,
    access: "read" | "change",
    purpose: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const app = appKindOf({ name: svc.name, image: svc.image ?? undefined });
    const v = app === "radarr" || app === "sonarr" ? "/api/v3" : "/api/v1";
    return this.broker.use(
      { serviceId: svc.id, purpose, access, destination: svc.localUrl! },
      async ({ value }) => {
        let res: Awaited<ReturnType<Fetch>>;
        try {
          res = await this.fetchImpl(joinUrl(svc.localUrl!, `${v}${path}`), {
            method,
            headers: {
              "X-Api-Key": value,
              Accept: "application/json",
              ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(TIMEOUT_MS * 2),
          } as Parameters<Fetch>[1]);
        } catch (error) {
          throw new AppUnreachableError(
            `${svc.name} did not answer: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!res.ok) {
          const text = res.text ? await res.text().catch(() => "") : "";
          throw new AppUnreachableError(
            `${svc.name} answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}.`,
          );
        }
        return (await res.json()) as T;
      },
    );
  }

  private appOf(svc: ServiceRow): SortApp | undefined {
    const k = appKindOf({ name: svc.name, image: svc.image ?? undefined });
    return k === "radarr" || k === "sonarr" || k === "lidarr" || k === "chaptarr" ? k : undefined;
  }

  private async sabKey<T>(svc: ServiceRow, mode: string): Promise<T> {
    return this.broker.use(
      {
        serviceId: svc.id,
        purpose: "read SABnzbd's history to sort manual jobs",
        access: "read",
        destination: svc.localUrl!,
      },
      async ({ value }) => {
        const url = joinUrl(
          svc.localUrl!,
          `/api?mode=${mode}&output=json&apikey=${encodeURIComponent(value)}`,
        );
        let res: Awaited<ReturnType<Fetch>>;
        try {
          res = await this.fetchImpl(url, {
            signal: AbortSignal.timeout(TIMEOUT_MS),
          } as Parameters<Fetch>[1]);
        } catch {
          throw new AppUnreachableError(`${svc.name} did not answer.`);
        }
        if (!res.ok) throw new AppUnreachableError(`${svc.name} answered ${res.status}.`);
        return (await res.json()) as T;
      },
    );
  }

  /* ---------------- the view and the proposal ---------------- */

  async view(service: { id: string; name: string; localUrl: string }): Promise<ManualSortView> {
    const config = (await this.configs())[service.id];
    const rows = this.live(await this.services());
    const apps = rows
      .map((s) => ({ s, app: this.appOf(s) }))
      .filter((x): x is { s: ServiceRow; app: SortApp } => Boolean(x.app))
      .map(({ s, app }) => ({ serviceId: s.id, name: s.name, app }));
    const sabServices = rows
      .filter((s) => appKindOf({ name: s.name, image: s.image ?? undefined }) === "sabnzbd")
      .map((s) => ({ serviceId: s.id, name: s.name }));
    const events = (await this.log()).filter(
      (e) => e.serviceId === service.id || (config?.sab ?? []).includes(e.serviceId),
    );
    const out: ManualSortView = { events, apps, sabServices };
    if (config) out.config = config;
    else
      try {
        out.proposal = await this.propose(service, rows);
      } catch (error) {
        out.error = error instanceof Error ? error.message : String(error);
      }
    return out;
  }

  /** A ready setup from this homelab: each type follows the app that already handles it. */
  private async propose(
    service: { id: string; name: string; localUrl: string },
    rows: ServiceRow[],
  ): Promise<NonNullable<ManualSortView["proposal"]>> {
    const session = this.qb(service);
    const { cats, prefs, done } = await session(
      "read",
      "read qBittorrent to plan manual sorting",
      async (q) => ({
        cats: await q.get<Record<string, { savePath?: string; save_path?: string }>>(
          "/api/v2/torrents/categories",
        ),
        prefs: await q.get<{ save_path?: string; save_path_changed_tmm_enabled?: boolean }>(
          "/api/v2/app/preferences",
        ),
        done: await q.get<Raw[]>("/api/v2/torrents/info?filter=completed"),
      }),
    );
    const pathOf = (c: string) => norm(cats[c]?.savePath ?? cats[c]?.save_path ?? "");
    const defaultPath = norm(prefs.save_path ?? "");
    const notes: string[] = [];
    const types: ManualSortConfig["types"] = {};

    // Which qBittorrent category each app sends its own downloads to.
    const used = new Map<string, string[]>();
    for (const s of rows) {
      const app = this.appOf(s);
      if (!app) continue;
      try {
        const clients = await this.arr<
          { implementation?: string; fields?: { name?: string; value?: unknown }[] }[]
        >(s, "read", "check which qBittorrent category it uses", "GET", "/downloadclient");
        for (const c of clients)
          if (/qbittorrent/i.test(c.implementation ?? ""))
            for (const f of c.fields ?? [])
              if (/category$/i.test(f.name ?? "") && typeof f.value === "string" && f.value)
                used.set(s.id, [...(used.get(s.id) ?? []), f.value]);
      } catch {
        notes.push(`${s.name} could not be read, so it is left out for now.`);
      }
    }
    const appsOf = (app: SortApp) => rows.filter((s) => this.appOf(s) === app);
    const target = async (
      type: SortType,
      app: SortApp,
      pick?: (cat: string) => boolean,
    ): Promise<SortTarget | undefined> => {
      const svc = appsOf(app).find((s) => (used.get(s.id) ?? []).some((c) => !pick || pick(c)));
      if (!svc) return undefined;
      const cat = (used.get(svc.id) ?? []).find((c) => !pick || pick(c))!;
      const savePath = pathOf(cat) || `${defaultPath}/${cat}`;
      const name = `manual-${type === "tv" ? "tv" : `${type}s`.replace("musics", "music")}`;
      const t: SortTarget = {
        category: name,
        savePath,
        appServiceId: svc.id,
        app,
        appName: svc.name,
        ...(cats[name] ? {} : { create: true }),
      };
      if (app === "radarr" || app === "sonarr") {
        try {
          const roots = await this.arr<{ path: string }[]>(
            svc,
            "read",
            "read its library folders",
            "GET",
            "/rootfolder",
          );
          const profiles = await this.arr<{ id: number; name: string }[]>(
            svc,
            "read",
            "read its quality profiles",
            "GET",
            "/qualityprofile",
          );
          const items = await this.arr<
            { qualityProfileId?: number; rootFolderPath?: string; path?: string }[]
          >(
            svc,
            "read",
            "see which library folder and quality it uses most",
            "GET",
            app === "radarr" ? "/movie" : "/series",
          );
          const count = <K>(xs: (K | undefined)[]) => {
            const m = new Map<K, number>();
            for (const x of xs) if (x !== undefined) m.set(x, (m.get(x) ?? 0) + 1);
            return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
          };
          const root =
            count(items.map((i) => roots.find((r) => (i.path ?? "").startsWith(r.path))?.path)) ??
            roots[0]?.path;
          const profile = count(items.map((i) => i.qualityProfileId)) ?? profiles[0]?.id;
          if (root) t.rootFolder = root;
          if (profile !== undefined) t.qualityProfileId = profile;
        } catch {
          notes.push(
            `${svc.name}'s library folders could not be read: new titles will not be added.`,
          );
        }
      }
      return t;
    };
    const movie = await target("movie", "radarr");
    if (movie) types.movie = movie;
    const tv = await target("tv", "sonarr");
    if (tv) types.tv = tv;
    const music = await target("music", "lidarr");
    if (music) types.music = music;
    const ebook = await target("ebook", "chaptarr", (c) => /e-?book/i.test(c));
    if (ebook) types.ebook = ebook;
    const audiobook = await target("audiobook", "chaptarr", (c) => /audio/i.test(c));
    if (audiobook) types.audiobook = audiobook;
    else if (cats.audiobooks) {
      types.audiobook = { category: "audiobooks", savePath: pathOf("audiobooks") };
      notes.push(
        'Audiobooks go to your "audiobooks" category\'s folder; nothing imports them from Hearth.',
      );
    }
    for (const type of SORT_TYPES)
      if (!types[type])
        notes.push(`${SORT_TYPE_PLURAL[type]} go to Unsorted: no app for them was found.`);

    const suggested = types.tv?.savePath ? `${types.tv.savePath}/Manual` : undefined;
    const unsortedBase = suggested ?? defaultPath;
    const existing = done
      .filter((r) => !r.category && !(r.tags ?? "").includes(SKIP_TAG))
      .slice(0, 50)
      .map((r) => ({ hash: r.hash, name: r.name, type: classifyName(r.name).type }));
    return {
      enabled: true,
      types,
      unsorted: {
        category: "unsorted",
        savePath: cats.unsorted ? pathOf("unsorted") : `${unsortedBase}/Unsorted`,
        ...(cats.unsorted ? {} : { create: true }),
      },
      sab: rows
        .filter((s) => appKindOf({ name: s.name, image: s.image ?? undefined }) === "sabnzbd")
        .map((s) => s.id),
      since: now(),
      notes,
      defaultSavePath: {
        now: defaultPath,
        ...(suggested && suggested !== defaultPath ? { suggested } : {}),
        relocates: prefs.save_path_changed_tmm_enabled === true,
      },
      existing,
    };
  }

  /* ---------------- plans ---------------- */

  async plan(
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const mode = String(params?.mode ?? "");
    const done = (change: StepChange, p: StepParams): PlannedStep => ({
      ...base,
      label: change.summary,
      serviceName: service.name,
      params: p,
      change,
    });
    if (mode === "setup") {
      const config = parseConfig(params?.config);
      const session = this.qb(service);
      const { cats, prefs } = await session(
        "read",
        "read qBittorrent for a sorting plan",
        async (q) => ({
          cats: await q.get<Record<string, unknown>>("/api/v2/torrents/categories"),
          prefs: await q.get<{ save_path?: string; save_path_changed_tmm_enabled?: boolean }>(
            "/api/v2/app/preferences",
          ),
        }),
      );
      const settings: StepChange["settings"] = [];
      for (const type of SORT_TYPES) {
        const tg = config.types[type];
        settings.push({
          name: SORT_TYPE_LABEL[type],
          before: "Stays in the default folder",
          after: tg
            ? `Category "${tg.category}" (${
                cats[tg.category]
                  ? `already in qBittorrent, its own folder ${
                      (cats[tg.category] as { savePath?: string }).savePath || "(default)"
                    } kept`
                  : `${tg.savePath}, new`
              })${
                tg.appName ? `, then ${tg.appName} imports it` : ""
              }${tg.rootFolder ? `; a title ${tg.appName} does not have is added to ${tg.rootFolder} first, without a search` : ""}`
            : "Unsorted (no app for it)",
        });
      }
      settings.push({
        name: "Anything unclear",
        before: "Stays in the default folder",
        after: `Category "${config.unsorted.category}" (${config.unsorted.savePath}), for you to sort`,
      });
      const sabNames = (await this.services())
        .filter((s) => config.sab.includes(s.id))
        .map((s) => s.name);
      if (sabNames.length)
        settings.push({
          name: "Usenet",
          before: "Manual jobs stay where SABnzbd put them",
          after: `${sabNames.join(", ")}: manual jobs (no category) are judged by name and handed to the same apps`,
        });
      const newDefault =
        typeof params?.defaultSavePath === "string" ? norm(params.defaultSavePath.trim()) : "";
      if (newDefault && newDefault !== norm(prefs.save_path ?? ""))
        settings.push({
          name: "Default download folder",
          before: prefs.save_path ?? "",
          after: `${newDefault}${
            prefs.save_path_changed_tmm_enabled
              ? " (qBittorrent is set to MOVE torrents without a category there too)"
              : " (torrents already there stay where they are)"
          }`,
        });
      settings.push({
        name: "From now on",
        before: "Off",
        after:
          "Every minute, finished torrents with no category are sorted on their own; each one is listed with Undo. Torrents with a category (your apps' own) are never touched.",
      });
      const count = params?.includeExisting === true ? Number(params?.existingCount ?? 0) : 0;
      if (count)
        settings.push({
          name: "Already finished",
          before: `${count} manual torrent${count === 1 ? "" : "s"} with no category`,
          after: "Sorted the same way, right after this",
        });
      return done(
        { summary: `Sort manual downloads in ${service.name}`, settings },
        {
          mode,
          config: JSON.stringify(config),
          ...(newDefault
            ? { defaultSavePath: newDefault, defaultBefore: prefs.save_path ?? "" }
            : {}),
          ...(params?.includeExisting === true
            ? { includeExisting: true, existingCount: count }
            : {}),
        },
      );
    }
    if (mode === "off") {
      const config = (await this.configs())[service.id];
      if (!config?.enabled) throw new PlanRefusedError("Sorting is already off.");
      return done(
        {
          summary: `Stop sorting manual downloads in ${service.name}`,
          settings: [
            { name: "Sorting", before: "On", after: "Off (nothing already sorted moves)" },
          ],
        },
        { mode },
      );
    }
    if (mode === "undo" || mode === "retry" || mode === "file") {
      const event = (await this.log()).find((e) => e.id === params?.event);
      if (!event) throw new PlanRefusedError("That sort is no longer in the history.");
      if (mode === "undo") {
        if (event.source !== "qbittorrent")
          throw new PlanRefusedError(
            "A Usenet job was moved by the app that imported it: Hearth cannot put it back.",
          );
        return done(
          {
            summary: `Put "${event.name}" back unsorted`,
            settings: [
              {
                name: event.name,
                before: `Category "${event.category ?? ""}"`,
                after:
                  "No category, back in the default folder, never sorted again (what an app already imported stays)",
              },
            ],
          },
          { mode, event: event.id },
        );
      }
      const type = mode === "file" ? String(params?.type ?? "") : event.type;
      if (!(SORT_TYPES as readonly string[]).includes(type))
        throw new PlanRefusedError("Say what it is: movie, tv, music, audiobook or ebook.");
      const config = (await this.configs())[service.id];
      const tg = config?.types[type as SortType];
      if (!tg)
        throw new PlanRefusedError(`Nothing is set up for ${SORT_TYPE_LABEL[type as SortType]}s.`);
      return done(
        {
          summary: `${mode === "retry" ? "Try again with" : "File"} "${event.name}" as ${SORT_TYPE_LABEL[type as SortType].toLowerCase()}`,
          settings: [
            {
              name: event.name,
              before: SORT_TYPE_LABEL[event.type],
              after: `${SORT_TYPE_LABEL[type as SortType]}: category "${tg.category}"${tg.appName ? `, then ${tg.appName} imports it` : ""}`,
            },
          ],
        },
        { mode, event: event.id, type },
      );
    }
    throw new PlanRefusedError('Say what to do: mode "setup", "off", "undo", "retry" or "file".');
  }

  async run(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const mode = String(p.mode ?? "");
    const session = this.qb(service);
    if (mode === "setup") {
      const config = parseConfig(p.config);
      const want = [
        ...SORT_TYPES.map((x) => config.types[x]).filter((x): x is SortTarget => Boolean(x)),
        config.unsorted,
      ];
      const made: string[] = [];
      await session(
        "change",
        "create the categories for sorting manual downloads (approved plan)",
        async (q) => {
          const cats = await q.get<Record<string, unknown>>("/api/v2/torrents/categories");
          for (const tg of want) {
            if (cats[tg.category]) continue;
            const r = await q.post(
              "/api/v2/torrents/createCategory",
              `category=${encodeURIComponent(tg.category)}&savePath=${encodeURIComponent(tg.savePath)}`,
            );
            if (!r.ok)
              throw new AppUnreachableError(
                `qBittorrent would not create "${tg.category}" (${r.status}).`,
              );
            made.push(tg.category);
          }
          if (typeof p.defaultSavePath === "string" && p.defaultSavePath) {
            const r = await q.post(
              "/api/v2/app/setPreferences",
              `json=${encodeURIComponent(JSON.stringify({ save_path: p.defaultSavePath }))}`,
            );
            if (!r.ok)
              throw new AppUnreachableError(
                `qBittorrent would not change its default folder (${r.status}).`,
              );
          }
          const after = await q.get<Record<string, unknown>>("/api/v2/torrents/categories");
          const missing = want.filter((tg) => !after[tg.category]).map((tg) => tg.category);
          if (missing.length)
            throw new AppUnreachableError(
              `qBittorrent does not list ${missing.join(", ")} after creating them.`,
            );
        },
      );
      await this.saveConfig(service.id, {
        ...config,
        enabled: true,
        since: p.includeExisting === true ? new Date(0).toISOString() : now(),
        approvedBy: step.job?.id ?? "approved plan",
      });
      return {
        ok: true,
        verified: true,
        result: `Sorting is on in ${service.name}${made.length ? `; created ${made.map((m) => `"${m}"`).join(", ")}` : ""}${
          p.defaultSavePath ? `; new downloads go to ${p.defaultSavePath}` : ""
        }. Finished torrents with no category are sorted every minute.`,
      };
    }
    if (mode === "off") {
      const config = (await this.configs())[service.id];
      if (config) await this.saveConfig(service.id, { ...config, enabled: false });
      return {
        ok: true,
        verified: true,
        result: "Sorting is off. Nothing already sorted was moved.",
      };
    }
    const event = (await this.log()).find((e) => e.id === p.event);
    if (!event) return { ok: false, stale: true, result: "That sort is no longer in the history." };
    if (mode === "undo") {
      const ok = await session(
        "change",
        `put "${event.name}" back unsorted (approved plan)`,
        async (q) => {
          await q.post(
            "/api/v2/torrents/addTags",
            `hashes=${event.ref}&tags=${encodeURIComponent(SKIP_TAG)}`,
          );
          await q.post("/api/v2/torrents/setCategory", `hashes=${event.ref}&category=`);
          const [r] = await q.get<Raw[]>(`/api/v2/torrents/info?hashes=${event.ref}`);
          return r ? !r.category : false;
        },
      );
      if (!ok)
        return { ok: false, result: `${service.name} still lists "${event.name}" in a category.` };
      await this.record({
        ...event,
        status: "undone",
        message: "Put back with no category; it will not be sorted again.",
      });
      return {
        ok: true,
        verified: true,
        result: `"${event.name}" has no category again and will not be sorted.`,
      };
    }
    // file or retry: the same steps a sort takes.
    const config = (await this.configs())[service.id];
    const type = (mode === "file" ? String(p.type) : event.type) as SortType;
    const tg = config?.types[type];
    if (!config || !tg) return { ok: false, stale: true, result: `Nothing is set up for ${type}.` };
    if (event.source === "sabnzbd") {
      const next = await this.handOff({ ...event, type }, tg, event.fromPath ?? "", "Move");
      await this.record(next);
      return { ok: next.status !== "failed", result: next.message };
    }
    await session("change", `file "${event.name}" as ${type} (approved plan)`, (q) =>
      q.post(
        "/api/v2/torrents/setCategory",
        `hashes=${event.ref}&category=${encodeURIComponent(tg.category)}`,
      ),
    );
    await this.record({
      ...event,
      type,
      category: tg.category,
      status: "moving",
      message: `Filed as ${SORT_TYPE_LABEL[type].toLowerCase()}: qBittorrent is moving it to ${tg.savePath}.`,
    });
    return {
      ok: true,
      result: `"${event.name}" is filed as ${SORT_TYPE_LABEL[type].toLowerCase()}; it is handed on once qBittorrent has moved it.`,
    };
  }

  /* ---------------- every minute ---------------- */

  async tick(): Promise<void> {
    const configs = await this.configs();
    const rows = await this.services();
    for (const [serviceId, config] of Object.entries(configs)) {
      if (!config.enabled) continue;
      const svc = rows.find((s) => s.id === serviceId);
      if (!svc?.localUrl) continue;
      try {
        await this.sortTorrents({ id: svc.id, name: svc.name, localUrl: svc.localUrl }, config);
      } catch {
        // qBittorrent away: the next minute tries again.
      }
      for (const sabId of config.sab) {
        const sab = rows.find((s) => s.id === sabId);
        if (sab?.localUrl) await this.sortSab(serviceId, sab, config).catch(() => undefined);
      }
    }
  }

  private async sortTorrents(
    service: { id: string; name: string; localUrl: string },
    config: ManualSortConfig,
  ) {
    const session = this.qb(service);
    const since = Date.parse(config.since) / 1000;
    const log = await this.log();
    const known = new Map(log.filter((e) => e.source === "qbittorrent").map((e) => [e.ref, e]));
    const all = await session("read", "look for finished manual downloads", (q) =>
      q.get<Raw[]>("/api/v2/torrents/info"),
    );

    // Moves that finished: hand them on.
    for (const e of log.filter((x) => x.serviceId === service.id && x.status === "moving")) {
      const r = all.find((x) => x.hash === e.ref);
      const tg = e.type === "unsorted" ? undefined : config.types[e.type];
      if (!r) {
        await this.record({
          ...e,
          status: "failed",
          message: "The torrent is no longer in qBittorrent.",
        });
        continue;
      }
      const target = e.type === "unsorted" ? config.unsorted.savePath : tg?.savePath;
      if (r.state === "moving" || !target || norm(r.save_path ?? "") !== norm(target)) continue;
      if (e.type === "unsorted") {
        await this.record({
          ...e,
          status: "unsorted",
          message: `In ${target}, waiting for you to say what it is.`,
        });
        continue;
      }
      if (!tg!.appServiceId) {
        await this.record({ ...e, status: "done", message: `In ${target}.` });
        continue;
      }
      await this.record(
        await this.handOff(e, tg!, r.content_path ?? `${target}/${r.name}`, "Copy"),
      );
    }

    // Imports running in an app: see how they ended.
    for (const e of log.filter((x) => x.serviceId === service.id && x.status === "sent"))
      await this.record(await this.checkImport(e, config));

    // New manual downloads.
    for (const r of all) {
      if (r.category || known.has(r.hash) || (r.tags ?? "").includes(SKIP_TAG)) continue;
      if ((r.progress ?? 0) < 1 || !DONE_STATE.test(r.state ?? "")) continue;
      if ((r.completion_on ?? 0) > 0 && (r.completion_on ?? 0) < since) continue;
      const files = await session("read", "read a manual download's files to sort it", (q) =>
        q.get<{ name: string; size: number }[]>(`/api/v2/torrents/files?hash=${r.hash}`),
      );
      const judged = classifyFiles(files, r.name);
      const tg = judged.type === "unsorted" ? undefined : config.types[judged.type];
      const category = tg?.category ?? config.unsorted.category;
      await session(
        "change",
        `sort the manual download "${r.name}" (standing approval: ${config.approvedBy ?? "setup plan"})`,
        async (q) => {
          if (!r.auto_tmm)
            await q.post("/api/v2/torrents/setAutoManagement", `hashes=${r.hash}&enable=true`);
          await q.post(
            "/api/v2/torrents/setCategory",
            `hashes=${r.hash}&category=${encodeURIComponent(category)}`,
          );
        },
      );
      await this.record({
        id: newId(),
        at: now(),
        source: "qbittorrent",
        serviceId: service.id,
        ref: r.hash,
        name: r.name,
        type: tg ? judged.type : "unsorted",
        reason: tg
          ? judged.reason
          : judged.type === "unsorted"
            ? judged.reason
            : `${judged.reason} Nothing is set up for that type.`,
        status: "moving",
        message: `qBittorrent is moving it to ${tg?.savePath ?? config.unsorted.savePath}.`,
        category,
        fromPath: r.save_path ?? "",
        updatedAt: now(),
      });
    }
  }

  private async sortSab(qbServiceId: string, sab: ServiceRow, config: ManualSortConfig) {
    const log = await this.log();
    for (const e of log.filter((x) => x.serviceId === sab.id && x.status === "sent"))
      await this.record(await this.checkImport(e, config));
    const known = new Set(log.filter((e) => e.serviceId === sab.id).map((e) => e.ref));
    const h = await this.sabKey<{
      history?: {
        slots?: {
          nzo_id: string;
          name: string;
          category?: string;
          status?: string;
          storage?: string;
          completed?: number;
        }[];
      };
    }>(sab, "history&limit=40");
    const since = Date.parse(config.since) / 1000;
    for (const s of h.history?.slots ?? []) {
      if (known.has(s.nzo_id) || s.status !== "Completed") continue;
      if (s.category && s.category !== "*" && s.category !== "Default") continue;
      if ((s.completed ?? 0) < since) continue;
      const judged = classifyName(s.name);
      const tg = judged.type === "unsorted" ? undefined : config.types[judged.type];
      const event: ManualSortEvent = {
        id: newId(),
        at: now(),
        source: "sabnzbd",
        serviceId: sab.id,
        ref: s.nzo_id,
        name: s.name,
        type: tg ? judged.type : "unsorted",
        reason: judged.reason,
        status: "unsorted",
        message: `Left where SABnzbd put it (${s.storage ?? "its complete folder"}) for you to say what it is.`,
        fromPath: s.storage ?? "",
        updatedAt: now(),
      };
      await this.record(
        tg?.appServiceId && s.storage ? await this.handOff(event, tg, s.storage, "Move") : event,
      );
    }
  }

  /** Asks the app to import the folder (adding the title first when Radarr or Sonarr lacks it). */
  private async handOff(
    e: ManualSortEvent,
    tg: SortTarget,
    path: string,
    importMode: "Copy" | "Move",
  ): Promise<ManualSortEvent> {
    const svc = (await this.services()).find((s) => s.id === tg.appServiceId);
    if (!svc?.localUrl || !tg.app)
      return {
        ...e,
        status: "failed",
        message: `${tg.appName ?? "The app"} is not in Hearth any more.`,
      };
    const why = `import the manual download "${e.name}" (standing approval for sorting)`;
    try {
      const maps = await this.arr<{ remotePath: string; localPath: string }[]>(
        svc,
        "read",
        "read its download folder mappings",
        "GET",
        "/remotepathmapping",
      ).catch(() => []);
      const local = mapPath(path, maps);
      let added = "";
      if (tg.app === "radarr" || tg.app === "sonarr")
        added = await this.ensureTitle(svc, tg, e.name);
      const command = {
        radarr: "DownloadedMoviesScan",
        sonarr: "DownloadedEpisodesScan",
        lidarr: "DownloadedAlbumsScan",
        chaptarr: "DownloadedBooksScan",
      }[tg.app];
      const r = await this.arr<{ id?: number }>(svc, "change", why, "POST", "/command", {
        name: command,
        path: local,
        importMode,
      });
      return {
        ...e,
        status: "sent",
        ...(r.id !== undefined ? { commandId: r.id } : {}),
        message: `${added}${svc.name} is importing it from ${local}.`,
      };
    } catch (error) {
      return {
        ...e,
        status: "failed",
        message: `${svc.name} could not take it: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** Radarr or Sonarr: the title is added (not searched) when it is not in the library yet. */
  private async ensureTitle(svc: ServiceRow, tg: SortTarget, name: string): Promise<string> {
    const radarr = tg.app === "radarr";
    const parsed = await this.arr<{
      movie?: { id: number };
      series?: { id: number };
      parsedMovieInfo?: { movieTitles?: string[]; movieTitle?: string; year?: number };
      parsedEpisodeInfo?: { seriesTitle?: string };
    }>(
      svc,
      "read",
      "work out which title a download is",
      "GET",
      `/parse?title=${encodeURIComponent(name)}`,
    );
    if (radarr ? parsed.movie : parsed.series) return "";
    if (!tg.rootFolder || tg.qualityProfileId === undefined)
      throw new AppUnreachableError(
        `it does not have this title, and no library folder is set to add it to`,
      );
    const title = radarr
      ? (parsed.parsedMovieInfo?.movieTitles?.[0] ?? parsed.parsedMovieInfo?.movieTitle)
      : parsed.parsedEpisodeInfo?.seriesTitle;
    if (!title) throw new AppUnreachableError("it could not tell which title this is");
    const year = parsed.parsedMovieInfo?.year;
    const found = await this.arr<Record<string, unknown>[]>(
      svc,
      "read",
      "look the title up",
      "GET",
      `${radarr ? "/movie/lookup" : "/series/lookup"}?term=${encodeURIComponent(`${title}${radarr && year ? ` ${year}` : ""}`)}`,
    );
    const match = found.find((f) => !radarr || !year || f.year === year);
    if (!match) throw new AppUnreachableError(`it found no title matching "${title}"`);
    await this.arr(
      svc,
      "change",
      `add "${String(match.title)}" so a manual download can be imported`,
      "POST",
      radarr ? "/movie" : "/series",
      {
        ...match,
        rootFolderPath: tg.rootFolder,
        qualityProfileId: tg.qualityProfileId,
        monitored: true,
        ...(radarr
          ? { minimumAvailability: "released", addOptions: { searchForMovie: false } }
          : {
              seasonFolder: true,
              languageProfileId: 1,
              addOptions: { monitor: "none", searchForMissingEpisodes: false },
            }),
      },
    );
    return `Added "${String(match.title)}" to ${svc.name} (no search). `;
  }

  private async checkImport(
    e: ManualSortEvent,
    config: ManualSortConfig,
  ): Promise<ManualSortEvent> {
    const tg = e.type === "unsorted" ? undefined : config.types[e.type];
    const svc = (await this.services()).find((s) => s.id === tg?.appServiceId);
    if (!svc || e.commandId === undefined) return { ...e, status: "done", message: e.message };
    try {
      const c = await this.arr<{ status?: string; message?: string; result?: string }>(
        svc,
        "read",
        "check its import",
        "GET",
        `/command/${e.commandId}`,
      );
      if (c.status === "completed")
        return {
          ...e,
          status: "done",
          message: `${svc.name} finished importing it. Its Activity and History show what it filed.`,
        };
      if (c.status === "failed" || c.status === "aborted" || c.status === "cancelled")
        return {
          ...e,
          status: "failed",
          message: `${svc.name}'s import ${c.status}${c.message ? `: ${c.message}` : ""}.`,
        };
      if (Date.now() - Date.parse(e.updatedAt) > 6 * 3600_000)
        return {
          ...e,
          status: "failed",
          message: `${svc.name} has not finished importing it after six hours.`,
        };
      return e;
    } catch {
      return e;
    }
  }
}

export class PlanRefusedError extends Error {}

function parseConfig(raw: unknown): ManualSortConfig {
  let c: ManualSortConfig;
  try {
    c = JSON.parse(String(raw ?? "")) as ManualSortConfig;
  } catch {
    throw new PlanRefusedError("The sorting setup is not readable (params.config).");
  }
  const safe = /^[\w .\-+]{1,60}$/;
  const pathOk = (p: unknown) =>
    typeof p === "string" && p.startsWith("/") && !p.includes("..") && p.length < 400;
  if (!c?.unsorted || !safe.test(c.unsorted.category) || !pathOk(c.unsorted.savePath))
    throw new PlanRefusedError("Say where unsorted downloads go (a category and its folder).");
  const types: ManualSortConfig["types"] = {};
  for (const type of SORT_TYPES) {
    const tg = c.types?.[type];
    if (!tg) continue;
    if (!safe.test(tg.category) || !pathOk(tg.savePath))
      throw new PlanRefusedError(
        `${SORT_TYPE_LABEL[type]}: give a category name and a folder starting with /.`,
      );
    types[type] = tg;
  }
  return {
    enabled: true,
    types,
    unsorted: { category: c.unsorted.category, savePath: c.unsorted.savePath },
    sab: Array.isArray(c.sab) ? c.sab.filter((x) => typeof x === "string") : [],
    since: now(),
  };
}
