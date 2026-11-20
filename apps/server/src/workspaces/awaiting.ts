import { foldTitle } from "@dragon-control/core";
import type { Database } from "../db/client";
import { getSetting, setSetting } from "../store/settings";
import type { Workspaces } from "./service";

/**
 * A film or show requested from a Forge pick sheet that isn't in the library yet (11-07:
 * request, download and add-to-row as one step). Once it is in Plex, it joins the sheet in
 * Selected and Ember is told in the sheet's conversation, so it can propose the change to Plex
 * for your approval. Nothing reaches Plex without that approval.
 */
export interface Awaiting {
  workspaceId: string;
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  year?: number;
  /** The Plex the sheet's titles come from (its imageService). */
  plexServiceId: string;
  requestedAt: string;
}

/** Given up after three weeks: the request was declined, or never downloaded. */
const GIVE_UP_MS = 21 * 86_400_000;
const MAX = 100;

type Find = (
  serviceId: string,
  q: string,
  kind: "movie" | "show",
) => Promise<{
  titles: {
    ratingKey: string;
    title: string;
    year?: number;
    thumb?: string;
    genres?: string[];
    rating?: number;
  }[];
}>;

export class ForgeAwaiting {
  constructor(
    private readonly db: Database,
    private readonly workspaces: Workspaces,
    /** The whole-library search (Home rows' catalog, cached a few minutes). */
    private readonly find: Find,
    /** Says something in a conversation as the app (Ember answers it). */
    private readonly converse: (text: string, conversationId: string) => Promise<unknown>,
    private readonly clock: () => number = Date.now,
    /**
     * The saved Home row of hand-picked titles built from a sheet (same name, same Plex), so the
     * news can say which row to add the title to (11-15: Ember guessed at a route that isn't there).
     */
    private readonly rowFor?: (
      name: string,
      plexServiceId: string,
    ) => Promise<{ id: string; name: string; titles: string[] } | undefined>,
  ) {}

  async list(workspaceId?: string): Promise<Awaiting[]> {
    const all = (await getSetting(this.db, "forge_awaiting")) ?? [];
    return workspaceId ? all.filter((a) => a.workspaceId === workspaceId) : all;
  }

  private async save(list: Awaiting[]) {
    await setSetting(this.db, "forge_awaiting", list.slice(-MAX));
  }

  /** Remembers a title requested from this sheet (only a Plex-backed pick sheet). */
  async add(
    workspaceId: string,
    a: { tmdbId: number; mediaType: "movie" | "tv"; title: string; year?: number },
  ): Promise<Awaiting> {
    const ws = await this.workspaces.get(workspaceId);
    if (ws.spec.layout?.kind !== "pick" || !ws.spec.imageService)
      throw new Error("Only a pick sheet of Plex titles waits for a requested title.");
    const entry: Awaiting = {
      workspaceId,
      tmdbId: a.tmdbId,
      mediaType: a.mediaType,
      title: a.title.slice(0, 200),
      ...(a.year ? { year: a.year } : {}),
      plexServiceId: ws.spec.imageService,
      requestedAt: new Date(this.clock()).toISOString(),
    };
    const list = (await this.list()).filter(
      (x) => !(x.workspaceId === workspaceId && x.tmdbId === a.tmdbId),
    );
    await this.save([...list, entry]);
    return entry;
  }

  /**
   * Every few minutes: each waiting title found in Plex (same title, same year give or take one)
   * joins its sheet in Selected, and Ember hears about it. Returns the titles that arrived.
   */
  async tick(): Promise<string[]> {
    const list = await this.list();
    if (!list.length) return [];
    const keep: Awaiting[] = [];
    const arrived: string[] = [];
    for (const a of list) {
      if (this.clock() - Date.parse(a.requestedAt) > GIVE_UP_MS) continue;
      let ws;
      try {
        ws = await this.workspaces.get(a.workspaceId);
      } catch {
        continue; // the sheet was closed: nothing to add it to
      }
      let hit;
      try {
        const r = await this.find(
          a.plexServiceId,
          a.title,
          a.mediaType === "tv" ? "show" : "movie",
        );
        hit = r.titles.find(
          (t) =>
            foldTitle(t.title) === foldTitle(a.title) &&
            (!a.year || !t.year || Math.abs(t.year - a.year) <= 1),
        );
      } catch {
        keep.push(a); // Plex didn't answer: try again next time
        continue;
      }
      if (!hit) {
        keep.push(a);
        continue;
      }
      const first = ws.spec.columns[0]?.key ?? "title";
      const values: Record<string, string | number | null> = {};
      for (const c of ws.spec.columns) {
        const k = `${c.key} ${c.label}`.toLowerCase();
        values[c.key] =
          c.key === first || /\b(title|name|film|movie|show)\b/.test(k)
            ? hit.title
            : /\byear\b/.test(k)
              ? (hit.year ?? null)
              : /genre/.test(k)
                ? (hit.genres ?? []).join(", ") || null
                : /rating|score/.test(k)
                  ? (hit.rating ?? null)
                  : /\b(why|reason|note)\b/.test(k)
                    ? "You requested it from this list"
                    : null;
      }
      try {
        await this.workspaces.addPicked(a.workspaceId, {
          id: hit.ratingKey,
          values,
          ...(hit.thumb ? { image: hit.thumb } : {}),
        });
      } catch {
        keep.push(a);
        continue;
      }
      const name = `${hit.title}${hit.year ? ` (${hit.year})` : ""}`;
      arrived.push(name);
      if (ws.conversationId) {
        const row = await this.rowFor?.(ws.spec.title, a.plexServiceId).catch(() => undefined);
        const next =
          row && !row.titles.includes(hit.ratingKey)
            ? `The Home row "${row.name}" was built from this sheet: propose adding it to the end of that row, one app-plex-control home-row-apply step with rowId ${row.id} and addTitle ${hit.ratingKey}, as a plan I approve.`
            : row
              ? `It is already in the Home row "${row.name}".`
              : "Propose adding it to what this sheet is for, as a plan I approve.";
        await this.converse(
          `${name}, which I requested from the sheet "${ws.spec.title}", is now in Plex, and Hearth put it in Selected there. ${next}`,
          ws.conversationId,
        ).catch(() => undefined);
      }
    }
    await this.save(keep);
    return arrived;
  }
}
