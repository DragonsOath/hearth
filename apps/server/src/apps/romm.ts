import type {
  AppReport,
  RommDashboard,
  RommGame,
  RommGameDetail,
  RommGamesPage,
  RommPlatform,
  StepParams,
} from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * RomM, your game library (checklist 46.12), through its own API (checked against RomM 5.3's
 * OpenAPI document and source). The vault holds a RomM login (any user can browse; scans need an
 * administrator, RomM's "tasks.run") or a RomM API token (read only). Reads: the library's totals,
 * platforms, recently added, favourites, a searchable and filterable list of games, each game's
 * page, and its cover (passed through Hearth, only from RomM's own resources folder). Controls, each
 * a plan you approve: a library scan (RomM starts scans only over its live socket, from a signed-in
 * session) and adding or removing a favourite. A scan never deletes a game; cleaning up missing
 * games stays in RomM.
 */

export interface RommCredential {
  /** A login's username; absent for an API token. */
  username?: string;
  value: string;
}

const authOf = (c: RommCredential) =>
  c.username
    ? `Basic ${Buffer.from(`${c.username}:${c.value}`).toString("base64")}`
    : `Bearer ${c.value}`;

async function request(
  fetchImpl: Fetch,
  base: string,
  cred: RommCredential,
  path: string,
  init: { method?: string; body?: string; contentType?: string; timeoutMs?: number } = {},
) {
  try {
    return await fetchImpl(joinUrl(base, path), {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/json",
        Authorization: authOf(cred),
        ...(init.contentType ? { "Content-Type": init.contentType } : {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS * 2),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : "no answer";
    throw new AppUnreachableError(`RomM did not answer at ${base}: ${why}`);
  }
}

async function get<T>(fetchImpl: Fetch, base: string, cred: RommCredential, path: string) {
  const res = await request(fetchImpl, base, cred, path);
  if (res.status === 401)
    throw new AppKeyError(
      cred.username
        ? "RomM refused the username or password. Check the login in the vault."
        : "RomM refused the API token. Check it in the vault.",
    );
  if (res.status === 403)
    throw new AppKeyError(
      "RomM's login in the vault may not read this (its role or the token's scopes are too narrow).",
    );
  if (!res.ok)
    throw new AppUnreachableError(`RomM answered ${res.status} for ${path.split("?")[0]}.`);
  return (await res.json()) as T;
}

interface RawRom {
  id: number;
  name?: string | null;
  fs_name?: string;
  platform_id?: number;
  platform_slug?: string;
  platform_display_name?: string;
  fs_size_bytes?: number;
  regions?: string[];
  languages?: string[];
  summary?: string | null;
  path_cover_small?: string | null;
  path_cover_large?: string | null;
  url_cover?: string | null;
  is_unidentified?: boolean;
  created_at?: string;
  has_manual?: boolean;
  metadatum?: {
    genres?: string[];
    franchises?: string[];
    developers?: string[];
    publishers?: string[];
    companies?: string[];
    player_count?: string | null;
    first_release_date?: number | null;
    average_rating?: number | null;
  };
  files?: { file_name?: string; file_size_bytes?: number }[];
  merged_screenshots?: string[];
  rom_user?: { id?: number } | null;
}
interface RawPlatform {
  id: number;
  name?: string;
  display_name?: string;
  slug?: string;
  fs_slug?: string;
  rom_count?: number;
  fs_size_bytes?: number;
  missing_from_fs?: boolean;
  is_unidentified?: boolean;
}
interface RawPage {
  items?: RawRom[];
  total?: number;
  filter_values?: { genres?: string[] };
}

/** The year from RomM's release date (milliseconds in RomM 5; seconds from older metadata). */
const yearOf = (t?: number | null) => {
  if (!t) return undefined;
  const d = new Date(t > 1e11 ? t : t * 1000);
  const y = d.getUTCFullYear();
  return y > 1950 && y < 2200 ? y : undefined;
};
/** A cover RomM keeps in its own resources folder: the only kind Hearth passes through. */
const COVER = /^\/assets\/romm\/resources\/[\w/.-]+\.(png|jpe?g|webp|gif)(\?.*)?$/i;

function game(r: RawRom, favorites?: Set<number>): RommGame {
  const year = yearOf(r.metadatum?.first_release_date);
  return {
    id: r.id,
    name: r.name || r.fs_name || "A game",
    platform: r.platform_display_name ?? r.platform_slug ?? "",
    platformSlug: r.platform_slug ?? "",
    ...(year ? { year } : {}),
    cover: COVER.test(r.path_cover_small ?? "") || COVER.test(r.path_cover_large ?? ""),
    ...(r.fs_size_bytes !== undefined ? { sizeBytes: r.fs_size_bytes } : {}),
    ...(r.regions?.length ? { regions: r.regions } : {}),
    ...(favorites ? { favorite: favorites.has(r.id) } : {}),
    ...(r.created_at ? { addedAt: r.created_at } : {}),
    ...(r.is_unidentified ? { unidentified: true } : {}),
  };
}

function platform(p: RawPlatform): RommPlatform {
  return {
    id: p.id,
    name: p.display_name || p.name || p.fs_slug || "A platform",
    slug: p.slug ?? p.fs_slug ?? "",
    games: p.rom_count ?? 0,
    sizeBytes: p.fs_size_bytes ?? 0,
    ...(p.missing_from_fs ? { missing: true } : {}),
    ...(p.is_unidentified ? { unidentified: true } : {}),
  };
}

interface RawCollection {
  id: number;
  is_favorite?: boolean;
  rom_ids?: number[];
}

/** The ids in the signed-in user's favourites (an empty set when it has none, or a token). */
async function favoriteIds(fetchImpl: Fetch, base: string, cred: RommCredential) {
  const all = await get<RawCollection[]>(fetchImpl, base, cred, "/api/collections").catch(
    () => [] as RawCollection[],
  );
  const fav = all.find((c) => c.is_favorite);
  return { collection: fav?.id, ids: new Set(fav?.rom_ids ?? []) };
}

export async function rommDashboard(
  fetchImpl: Fetch,
  base: string,
  cred: RommCredential,
): Promise<RommDashboard> {
  const [beat, stats, platforms, recent, unmatched, me, favs] = await Promise.all([
    get<{ SYSTEM?: { VERSION?: string } }>(fetchImpl, base, cred, "/api/heartbeat").catch(
      () => ({}) as { SYSTEM?: { VERSION?: string } },
    ),
    get<{
      PLATFORMS?: number;
      ROMS?: number;
      SAVES?: number;
      STATES?: number;
      SCREENSHOTS?: number;
      TOTAL_FILESIZE_BYTES?: number;
    }>(fetchImpl, base, cred, "/api/stats"),
    get<RawPlatform[]>(fetchImpl, base, cred, "/api/platforms"),
    get<RawPage>(fetchImpl, base, cred, "/api/roms?order_by=created_at&order_dir=desc&limit=12"),
    get<RawPage>(fetchImpl, base, cred, "/api/roms?matched=false&limit=1&with_total=true").catch(
      () => ({}) as RawPage,
    ),
    get<{ role?: string }>(fetchImpl, base, cred, "/api/users/me").catch(
      () => ({}) as { role?: string },
    ),
    favoriteIds(fetchImpl, base, cred),
  ]);
  const favList = favs.ids.size
    ? await get<RawPage>(fetchImpl, base, cred, "/api/roms?favorite=true&limit=12").catch(
        () => ({}) as RawPage,
      )
    : ({} as RawPage);
  return {
    app: "romm",
    ...(beat.SYSTEM?.VERSION ? { version: beat.SYSTEM.VERSION } : {}),
    totals: {
      platforms: stats.PLATFORMS ?? platforms.length,
      games: stats.ROMS ?? 0,
      saves: stats.SAVES ?? 0,
      states: stats.STATES ?? 0,
      screenshots: stats.SCREENSHOTS ?? 0,
      sizeBytes: stats.TOTAL_FILESIZE_BYTES ?? 0,
    },
    platforms: platforms.map(platform).sort((a, b) => b.games - a.games),
    recent: (recent.items ?? []).map((r) => game(r, favs.ids)),
    favorites: (favList.items ?? []).map((r) => game(r, favs.ids)),
    unidentified: Number(unmatched.total ?? 0),
    canScan: Boolean(cred.username) && me.role === "admin",
  };
}

const ORDERS = {
  name: "order_by=name&order_dir=asc",
  added: "order_by=created_at&order_dir=desc",
  size: "order_by=fs_size_bytes&order_dir=desc",
  released: "order_by=first_release_date&order_dir=desc",
} as const;
export type RommOrder = keyof typeof ORDERS;
export const ROMM_PAGE = 48;

/** One page of games: searched by name, one platform, one genre, favourites, in an order. */
export async function rommGames(
  fetchImpl: Fetch,
  base: string,
  cred: RommCredential,
  want: {
    search?: string;
    platformId?: number;
    genre?: string;
    favorites?: boolean;
    order?: RommOrder;
    offset?: number;
  } = {},
): Promise<RommGamesPage> {
  const q = new URLSearchParams({
    limit: String(ROMM_PAGE),
    offset: String(Math.max(0, Math.floor(want.offset ?? 0))),
    with_filter_values: "true",
    with_total: "true",
    ...(want.search?.trim() ? { search_term: want.search.trim().slice(0, 200) } : {}),
    ...(want.platformId ? { platform_ids: String(want.platformId) } : {}),
    ...(want.genre ? { genres: want.genre.slice(0, 100) } : {}),
    ...(want.favorites ? { favorite: "true" } : {}),
  });
  const [page, favs] = await Promise.all([
    get<RawPage>(
      fetchImpl,
      base,
      cred,
      `/api/roms?${q.toString()}&${ORDERS[want.order ?? "name"] ?? ORDERS.name}`,
    ),
    favoriteIds(fetchImpl, base, cred),
  ]);
  const items = (page.items ?? []).map((r) => game(r, favs.ids));
  return {
    total: Number(page.total ?? items.length),
    items,
    genres: [...new Set(page.filter_values?.genres ?? [])].sort(),
  };
}

/** One game's page. */
export async function rommGame(
  fetchImpl: Fetch,
  base: string,
  cred: RommCredential,
  id: number,
): Promise<RommGameDetail> {
  const [r, favs] = await Promise.all([
    get<RawRom>(fetchImpl, base, cred, `/api/roms/${id}`),
    favoriteIds(fetchImpl, base, cred),
  ]);
  const m = r.metadatum ?? {};
  return {
    ...game(r, favs.ids),
    ...(r.summary ? { summary: r.summary.slice(0, 4000) } : {}),
    genres: m.genres ?? [],
    developers: m.developers ?? [],
    publishers: m.publishers ?? [],
    franchises: m.franchises ?? [],
    languages: r.languages ?? [],
    ...(m.player_count ? { playerCount: m.player_count } : {}),
    ...(m.average_rating ? { rating: Math.round(m.average_rating) } : {}),
    files: (r.files ?? []).slice(0, 200).map((f) => ({
      name: f.file_name ?? "A file",
      sizeBytes: f.file_size_bytes ?? 0,
    })),
    screenshots: (r.merged_screenshots ?? []).length,
    hasManual: Boolean(r.has_manual),
    path: `/rom/${r.id}`,
  };
}

/** A game's cover, small or large, read from RomM's resources (never any other path). */
export async function rommCover(
  fetchImpl: Fetch,
  base: string,
  cred: RommCredential,
  id: number,
  size: "small" | "large",
): Promise<{ type: string; bytes: Buffer } | undefined> {
  const r = await get<RawRom>(fetchImpl, base, cred, `/api/roms/${id}`);
  const path = (size === "large" ? r.path_cover_large : r.path_cover_small) || r.path_cover_small;
  if (!path || !COVER.test(path)) return undefined;
  const res = await request(fetchImpl, base, cred, path);
  if (!res.ok || !res.arrayBuffer) return undefined;
  const type = res.headers?.get("content-type") ?? "image/png";
  if (!/^image\//.test(type)) return undefined;
  const bytes = Buffer.from(await res.arrayBuffer());
  return bytes.byteLength > 8 * 1024 * 1024 ? undefined : { type, bytes };
}

export async function readRomm(
  base: string,
  cred: RommCredential,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await rommDashboard(fetchImpl, base, cred);
  const missing = d.platforms.filter((p) => p.missing);
  const issues = missing.length
    ? [
        {
          level: "warning" as const,
          key: "platforms-missing",
          text: `RomM lists ${missing.length} platform${missing.length === 1 ? "" : "s"} whose folder is gone: ${missing.map((p) => p.name).join(", ")}.`,
        },
      ]
    : [];
  return {
    app: "romm",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      { label: "Games", value: String(d.totals.games) },
      { label: "Platforms", value: String(d.totals.platforms) },
      { label: "Not identified", value: String(d.unidentified) },
    ],
  };
}

/** RomM's scan kinds, in plain words. */
export const SCAN_TYPES = {
  quick: "Find new games and platforms (games already in RomM stay as they are)",
  new_platforms: "Only platforms that are not in RomM yet",
  unmatched: "Try again to identify games RomM could not identify",
  update: "Read the details and covers again for every game (slower)",
  complete: "Rescan everything and read every game's details again (slowest)",
} as const;
export type ScanType = keyof typeof SCAN_TYPES;

/** RomM's metadata sources, by the heartbeat flag that says each is switched on. */
const SOURCES: Record<string, string> = {
  IGDB_API_ENABLED: "igdb",
  SS_API_ENABLED: "ss",
  MOBY_API_ENABLED: "moby",
  STEAMGRIDDB_API_ENABLED: "sgdb",
  RA_API_ENABLED: "ra",
  LAUNCHBOX_API_ENABLED: "launchbox",
  HASHEOUS_API_ENABLED: "hasheous",
  PLAYMATCH_API_ENABLED: "playmatch",
  TGDB_API_ENABLED: "tgdb",
  FLASHPOINT_API_ENABLED: "flashpoint",
  HLTB_API_ENABLED: "hltb",
  LIBRETRO_API_ENABLED: "libretro",
};

/**
 * Starts a scan the way RomM's own page does: sign in (a session cookie), open its socket
 * (Engine.IO 4 long-polling), send "scan", then follow its events until it finishes or the wait
 * runs out. Returns what RomM said. Signed out after.
 */
export async function rommScan(
  fetchImpl: Fetch,
  base: string,
  cred: RommCredential,
  options: { type: ScanType; platformIds: number[] },
  waitMs = 120_000,
): Promise<{
  state: "done" | "refused" | "running";
  message?: string;
  stats?: Record<string, number>;
}> {
  if (!cred.username)
    return { state: "refused", message: "Scans need a RomM login in the vault, not an API token." };
  const login = await request(fetchImpl, base, cred, "/api/login", { method: "POST" });
  if (login.status === 401 || login.status === 403)
    throw new AppKeyError("RomM refused the username or password. Check the login in the vault.");
  const session = /romm_session=([^;,\s]+)/.exec(login.headers?.get("set-cookie") ?? "")?.[1];
  if (!login.ok || !session) throw new AppUnreachableError("RomM did not start a session.");
  const Cookie = `romm_session=${session}`;
  const beat = await get<{ METADATA_SOURCES?: Record<string, boolean> }>(
    fetchImpl,
    base,
    cred,
    "/api/heartbeat",
  ).catch(() => ({}) as { METADATA_SOURCES?: Record<string, boolean> });
  const apis = Object.entries(SOURCES)
    .filter(([flag]) => beat.METADATA_SOURCES?.[flag])
    .map(([, source]) => source);
  const sock = (sid?: string) =>
    joinUrl(
      base,
      `/ws/socket.io/?EIO=4&transport=polling${sid ? `&sid=${sid}` : ""}&t=${Date.now()}`,
    );
  const text = async (r: Awaited<ReturnType<Fetch>>) => (r.text ? r.text() : "");
  const call = (sid: string | undefined, body?: string) =>
    fetchImpl(sock(sid), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie,
        ...(body !== undefined ? { "Content-Type": "text/plain;charset=UTF-8" } : {}),
      },
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(40_000),
    });
  try {
    const open = await text(await call(undefined));
    const sid = (JSON.parse(open.slice(1)) as { sid?: string }).sid;
    if (!sid) throw new AppUnreachableError("RomM's socket did not open.");
    await call(sid, "40");
    await text(await call(sid)); // the namespace's connect answer
    await call(
      sid,
      `42${JSON.stringify(["scan", { platforms: options.platformIds, type: options.type, apis }])}`,
    );
    const until = Date.now() + waitMs;
    let started = false;
    while (Date.now() < until) {
      const packets = (await text(await call(sid))).split("\x1e");
      for (const p of packets) {
        if (p === "2") await call(sid, "3");
        if (!p.startsWith("42")) continue;
        let event: unknown[];
        try {
          event = JSON.parse(p.slice(2)) as unknown[];
        } catch {
          continue;
        }
        const [name, data] = event as [string, unknown];
        if (name === "scan:done") return { state: "done", stats: data as Record<string, number> };
        if (name === "scan:done_ko") return { state: "refused", message: String(data) };
        if (name.startsWith("scan:")) started = true;
      }
    }
    return {
      state: "running",
      message: started ? "RomM is scanning." : "RomM took the request.",
    };
  } finally {
    await request(fetchImpl, base, cred, "/api/logout", { method: "POST" }).catch(() => undefined);
  }
}

export const ROMM_OPS = ["scan", "favorite", "unfavorite"] as const;
type Op = (typeof ROMM_OPS)[number];

export class RommOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
    /** How long a scan is followed before Hearth reports it as running. */
    private readonly scanWaitMs = 120_000,
  ) {}

  private use<T>(
    service: { id: string; localUrl: string },
    purpose: string,
    access: "read" | "change",
    fn: (cred: RommCredential) => Promise<T>,
  ) {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value, username }) => fn({ value, ...(username ? { username } : {}) }),
    );
  }

  async plan(
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as Op;
    if (!ROMM_OPS.includes(op)) throw new Error(`Say what to do: ${ROMM_OPS.join(", ")}.`);
    const d = await this.use(service, "read RomM", "read", (c) =>
      rommDashboard(this.fetchImpl, service.localUrl, c),
    );
    if (op === "scan") {
      if (!d.canScan)
        throw new Error(
          "Scans need a RomM administrator's login in the vault (RomM lets only administrators run scans).",
        );
      const type = String(params?.scanType ?? "quick") as ScanType;
      if (!(type in SCAN_TYPES))
        throw new Error(`The scan is one of: ${Object.keys(SCAN_TYPES).join(", ")}.`);
      const wanted = String(params?.platformIds ?? "")
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((x) => Number.isInteger(x) && x > 0);
      const chosen = d.platforms.filter((p) => wanted.includes(p.id));
      if (wanted.length && chosen.length !== wanted.length)
        throw new Error("RomM does not have one of those platforms.");
      const where = chosen.length ? chosen.map((p) => p.name).join(", ") : "the whole library";
      const label = `Scan ${where} in ${service.name}: ${SCAN_TYPES[type].split(" (")[0]!.toLowerCase()}`;
      return {
        ...base,
        label,
        serviceName: service.name,
        params: {
          op,
          scanType: type,
          ...(chosen.length ? { platformIds: chosen.map((p) => p.id).join(",") } : {}),
        },
        change: {
          summary: `${label}. A scan never deletes a game or a file.`,
          settings: [
            {
              name: chosen.length ? where : "Library",
              before: `${d.totals.games} games on ${d.totals.platforms} platforms`,
              after: `${SCAN_TYPES[type]}. No game or file is deleted.`,
            },
          ],
        },
      };
    }
    const romId = Number(params?.romId);
    if (!Number.isInteger(romId) || romId < 1) throw new Error("Say which game (params.romId).");
    const g = await this.use(service, "read a game in RomM", "read", (c) =>
      rommGame(this.fetchImpl, service.localUrl, c, romId),
    );
    if (op === "favorite" && g.favorite) throw new Error(`${g.name} is already a favourite.`);
    if (op === "unfavorite" && !g.favorite) throw new Error(`${g.name} is not a favourite.`);
    const label =
      op === "favorite"
        ? `Add ${g.name} to your favourites in ${service.name}`
        : `Take ${g.name} out of your favourites in ${service.name}`;
    return {
      ...base,
      label,
      serviceName: service.name,
      params: { op, romId, name: g.name },
      change: {
        summary: label,
        settings: [
          {
            name: g.name,
            before: g.favorite ? "a favourite" : "not a favourite",
            after: op === "favorite" ? "a favourite" : "not a favourite",
          },
        ],
      },
    };
  }

  async run(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const op = String(p.op) as Op;
    const outcome =
      op === "scan" ? await this.runScan(p, service) : await this.runFavorite(op, p, service);
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${op}${p.name ? ` (${String(p.name)})` : ""} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op, ok: outcome.ok, ...(op === "scan" ? { scanType: String(p.scanType) } : {}) },
    });
    return outcome;
  }

  private async runScan(
    p: StepParams,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const type = String(p.scanType ?? "quick") as ScanType;
    const platformIds = String(p.platformIds ?? "")
      .split(",")
      .map(Number)
      .filter((x) => Number.isInteger(x) && x > 0);
    const r = await this.use(service, "scan RomM's library", "change", (c) =>
      rommScan(this.fetchImpl, service.localUrl, c, { type, platformIds }, this.scanWaitMs),
    );
    if (r.state === "refused")
      return {
        ok: false,
        result: `RomM did not start the scan: ${r.message ?? "no reason given"}.`,
      };
    if (r.state === "running")
      return {
        ok: true,
        result: `${r.message ?? "RomM is scanning."} It is still going: new games appear in the panel as it finds them.`,
      };
    const s = r.stats ?? {};
    const n = (k: string) => Number(s[k] ?? 0);
    return {
      ok: true,
      result: `RomM finished the scan: ${n("scanned_platforms")} platform${n("scanned_platforms") === 1 ? "" : "s"}, ${n("scanned_roms")} game${n("scanned_roms") === 1 ? "" : "s"} looked at, ${n("new_roms")} new, ${n("identified_roms")} identified.`,
    };
  }

  private async runFavorite(
    op: "favorite" | "unfavorite",
    p: StepParams,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const romId = Number(p.romId);
    const name = String(p.name || "The game");
    return this.use(service, "change a favourite in RomM", "change", async (c) => {
      const base = service.localUrl;
      const fav = await favoriteIds(this.fetchImpl, base, c);
      const ids = fav.ids;
      let collection = fav.collection;
      // Already as wanted (a retried plan): nothing to do.
      if (ids.has(romId) === (op === "favorite"))
        return {
          ok: true,
          result: `${name} is already ${op === "favorite" ? "a favourite" : "not a favourite"}.`,
        };
      if (!collection) {
        if (op === "unfavorite") return { ok: true, result: `${name} is not a favourite.` };
        // RomM's own favourites collection, made the way its page makes it.
        const boundary = `----hearth${Date.now().toString(16)}`;
        const body = `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nFavourites\r\n--${boundary}--\r\n`;
        const made = await request(this.fetchImpl, base, c, "/api/collections?is_favorite=true", {
          method: "POST",
          body,
          contentType: `multipart/form-data; boundary=${boundary}`,
        });
        if (!made.ok)
          return {
            ok: false,
            result: `RomM did not make the favourites collection (${made.status}).`,
          };
        collection = ((await made.json()) as { id?: number }).id;
        if (!collection) return { ok: false, result: "RomM did not say which collection it made." };
      }
      const res = await request(this.fetchImpl, base, c, `/api/collections/${collection}/roms`, {
        method: op === "favorite" ? "POST" : "DELETE",
        body: JSON.stringify({ rom_ids: [romId] }),
        contentType: "application/json",
      });
      if (!res.ok) return { ok: false, result: `RomM refused it (${res.status}).` };
      const after = await favoriteIds(this.fetchImpl, base, c);
      const ok = after.ids.has(romId) === (op === "favorite");
      return ok
        ? {
            ok: true,
            result: `${name} is ${op === "favorite" ? "a favourite now" : "no longer a favourite"}. RomM confirms it.`,
          }
        : { ok: false, result: "RomM answered, but its favourites do not show the change." };
    });
  }
}
