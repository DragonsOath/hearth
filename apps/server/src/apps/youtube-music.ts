import { createHash } from "node:crypto";
import type { MusicItem } from "./homeassistant-home";
import type { Fetch } from "./http";

/**
 * YouTube Music read with the owner's own sign-in (11-05: "I want my quick picks visible",
 * "it's connected to my wrong account... I created a separate channel"). Music Assistant asks
 * YouTube Music for only its first three home rows and keeps the sign-in to itself, so when the
 * owner signs in during Hearth's YouTube Music setup, Hearth keeps a copy in Secure Vault and
 * reads two things directly, the way YouTube Music's own web page does:
 *
 * - the channels that sign-in can use (the person's own and any brand channels), for the
 *   channel picker;
 * - the home page, every row in YouTube Music's own order (Quick picks, Listen again, mixes),
 *   as items Music Assistant can play.
 *
 * The sign-in is only ever sent to music.youtube.com. Nothing here changes anything on the
 * account; it only reads.
 */

const ORIGIN = "https://music.youtube.com";
const API = `${ORIGIN}/youtubei/v1`;

/** The sign-in a Chrome profile holds, as one Cookie header, and which channel it plays as. */
export interface YoutubeSignIn {
  cookie: string;
  /** A brand channel's page id; none for the person's own channel. */
  channel?: string;
}

export interface YoutubeChannel {
  /** A brand channel's page id; none for the person's own channel. */
  id?: string;
  name: string;
  /** "@handle" or the account's e-mail, as YouTube shows it under the name. */
  byline?: string;
  photo?: string;
}

export class YoutubeSignedOut extends Error {}

function clientVersion(now = new Date()) {
  const d = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `1.${d}.01.00`;
}

/** The request headers YouTube Music's web page sends for a signed-in person. */
export function authHeaders(cookie: string, now = Date.now()): Record<string, string> {
  const sapisid =
    /(?:^|;\s*)__Secure-3PAPISID=([^;]+)/.exec(cookie)?.[1] ??
    /(?:^|;\s*)SAPISID=([^;]+)/.exec(cookie)?.[1];
  if (!sapisid) throw new YoutubeSignedOut("That isn't a YouTube sign-in.");
  const ts = Math.floor(now / 1000);
  const hash = createHash("sha1").update(`${ts} ${sapisid} ${ORIGIN}`).digest("hex");
  return {
    "Content-Type": "application/json",
    Accept: "*/*",
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    Origin: ORIGIN,
    "X-Origin": ORIGIN,
    "X-Goog-AuthUser": "0",
    Cookie: cookie,
    Authorization: `SAPISIDHASH ${ts}_${hash}`,
  };
}

async function post<T>(
  fetchImpl: Fetch,
  path: string,
  s: YoutubeSignIn,
  body: Record<string, unknown>,
  query = "",
): Promise<T> {
  const res = await fetchImpl(`${API}/${path}?prettyPrint=false${query}`, {
    method: "POST",
    headers: authHeaders(s.cookie),
    body: JSON.stringify({
      context: {
        client: { clientName: "WEB_REMIX", clientVersion: clientVersion(), hl: "en" },
        user: s.channel ? { onBehalfOfUser: s.channel } : {},
      },
      ...body,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403)
    throw new YoutubeSignedOut("YouTube Music refused the sign-in. Sign in again in Hearth.");
  if (!res.ok) throw new Error(`YouTube Music answered ${res.status}.`);
  return (await res.json()) as T;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object";

/** Every object under `o` that has key `k` (depth first, in order). */
function findAll(o: unknown, k: string, out: Obj[] = []): Obj[] {
  if (Array.isArray(o)) for (const x of o) findAll(x, k, out);
  else if (isObj(o)) {
    if (k in o && isObj(o[k])) out.push(o[k] as Obj);
    for (const [key, v] of Object.entries(o)) if (key !== k) findAll(v, k, out);
  }
  return out;
}
const textOf = (v: unknown): string => {
  if (!isObj(v)) return "";
  if (typeof v.simpleText === "string") return v.simpleText;
  return Array.isArray(v.runs)
    ? v.runs.map((r) => (isObj(r) ? String(r.text ?? "") : "")).join("")
    : "";
};
const lastThumb = (v: unknown): string | undefined => {
  const list = findAll(v, "thumbnail")
    .flatMap((t) => (Array.isArray(t.thumbnails) ? t.thumbnails : []))
    .filter(isObj);
  const url = list.length ? String(list[list.length - 1]!.url ?? "") : "";
  return /^https:\/\//.test(url) ? url : undefined;
};

/** The channels this sign-in can play as: the person's own, then brand channels. */
export async function youtubeChannels(fetchImpl: Fetch, cookie: string): Promise<YoutubeChannel[]> {
  const r = await post<Obj>(fetchImpl, "account/accounts_list", { cookie }, {});
  const out: YoutubeChannel[] = [];
  for (const a of findAll(r, "accountItem")) {
    const name = textOf(a.accountName);
    if (!name) continue;
    const tokens = findAll(a.serviceEndpoint, "pageIdToken");
    const id = tokens.map((t) => String(t.pageId ?? "")).find((x) => /^\d{10,30}$/.test(x));
    const byline = textOf(a.channelHandle) || textOf(a.accountByline);
    const photo = lastThumb({ thumbnail: a.accountPhoto });
    out.push({
      ...(id ? { id } : {}),
      name: name.slice(0, 120),
      ...(byline ? { byline: byline.slice(0, 120) } : {}),
      ...(photo ? { photo } : {}),
    });
  }
  // The person's own first.
  return out.sort((a, b) => Number(Boolean(a.id)) - Number(Boolean(b.id)));
}

export interface YoutubeRow {
  title: string;
  items: MusicItem[];
}

/** A YouTube Music item as a Music Assistant address (provider instance, kind, id). */
function itemOf(raw: Obj, provider: string): MusicItem | undefined {
  const two = raw.musicTwoRowItemRenderer as Obj | undefined;
  const list = raw.musicResponsiveListItemRenderer as Obj | undefined;
  const r = two ?? list;
  if (!r) return undefined;
  const image = lastThumb(two ? r.thumbnailRenderer : r.thumbnail);
  // A song (Quick picks and the like): a video id.
  const videoId =
    findAll(list ? r.playlistItemData : r.navigationEndpoint, "watchEndpoint")
      .map((w) => w.videoId)
      .concat(isObj(r.playlistItemData) ? [r.playlistItemData.videoId] : [])
      .find((v): v is string => typeof v === "string" && /^[\w-]{11}$/.test(v)) ??
    findAll(r, "watchEndpoint")
      .map((w) => w.videoId)
      .find((v): v is string => typeof v === "string" && /^[\w-]{11}$/.test(v));
  const browse = findAll(r.navigationEndpoint ?? r, "browseEndpoint")[0];
  const browseId = typeof browse?.browseId === "string" ? browse.browseId : undefined;
  const pageType = String(
    (isObj(browse?.browseEndpointContextSupportedConfigs) &&
      isObj(browse.browseEndpointContextSupportedConfigs.browseEndpointContextMusicConfig) &&
      browse.browseEndpointContextSupportedConfigs.browseEndpointContextMusicConfig.pageType) ??
      "",
  );
  let name: string;
  let by: string;
  if (two) {
    name = textOf(r.title);
    by = textOf(r.subtitle);
  } else {
    const cols = Array.isArray(r.flexColumns) ? r.flexColumns.filter(isObj) : [];
    const col = (i: number) =>
      textOf(
        isObj(cols[i]?.musicResponsiveListItemFlexColumnRenderer)
          ? (cols[i]!.musicResponsiveListItemFlexColumnRenderer as Obj).text
          : undefined,
      );
    name = col(0);
    by = col(1);
  }
  if (!name) return undefined;
  const base = {
    name: name.slice(0, 200),
    ...(by ? { by: by.slice(0, 200) } : {}),
    ...(image ? { image } : {}),
  };
  if (two && browseId && /ALBUM|SINGLE/.test(pageType))
    return { uri: `${provider}://album/${browseId}`, kind: "album", ...base };
  if (two && browseId && /PLAYLIST/.test(pageType))
    return {
      uri: `${provider}://playlist/${browseId.replace(/^VL/, "")}`,
      kind: "playlist",
      ...base,
    };
  if (two && browseId && /ARTIST|USER_CHANNEL/.test(pageType))
    return { uri: `${provider}://artist/${browseId}`, kind: "artist", ...base };
  if (videoId) return { uri: `${provider}://track/${videoId}`, kind: "track", ...base };
  return undefined;
}

/** The token for the next piece of a page, if there is one. */
function continuationOf(page: Obj): string | undefined {
  const c = findAll(page, "nextContinuationData")[0]?.continuation;
  return typeof c === "string" && c.length < 2000 ? c : undefined;
}

/**
 * The YouTube Music home page, every row in its own order (Quick picks first when YouTube puts
 * it first), as items the given Music Assistant YouTube Music provider can play.
 */
export async function youtubeHome(
  fetchImpl: Fetch,
  s: YoutubeSignIn,
  provider: string,
  maxRows = 14,
): Promise<YoutubeRow[]> {
  const r = await post<Obj>(fetchImpl, "browse", s, { browseId: "FEmusic_home" });
  // The website loads the lower rows as you scroll (11-06: "Trending songs for you" is far
  // down); Hearth reads up to two more pieces the same way.
  const pages: Obj[] = [r];
  let token = continuationOf(r);
  for (let i = 0; i < 2 && token; i++) {
    const t = encodeURIComponent(token);
    const more = await post<Obj>(
      fetchImpl,
      "browse",
      s,
      {},
      `&ctoken=${t}&continuation=${t}&type=next`,
    ).catch(() => undefined);
    if (!more) break;
    pages.push(more);
    token = continuationOf(more);
  }
  const rows: YoutubeRow[] = [];
  for (const shelf of pages.flatMap((p) => findAll(p, "musicCarouselShelfRenderer"))) {
    const header = findAll(shelf.header, "title")[0];
    const title =
      textOf(header) || textOf(findAll(shelf, "musicCarouselShelfBasicHeaderRenderer")[0]?.title);
    const contents = Array.isArray(shelf.contents) ? shelf.contents.filter(isObj) : [];
    const items = contents
      .map((c) => itemOf(c, provider))
      .filter((x): x is MusicItem => Boolean(x))
      .slice(0, 30);
    if (title && items.length) rows.push({ title: title.slice(0, 80), items });
    if (rows.length >= maxRows) break;
  }
  // YouTube Music's website calls the pinned row "Listen again"; its apps call it "Speed dial"
  // (11-06: the same pinned picks, named differently). Shown as Speed dial, like the app.
  if (!rows.some((r) => /speed dial/i.test(r.title))) {
    const pinned = rows.findIndex((r) => /^listen again$/i.test(r.title));
    if (pinned >= 0) rows[pinned] = { ...rows[pinned]!, title: "Speed dial" };
  }
  // Its picked-songs row goes by other names on the website too ("Trending songs for you");
  // shown as Quick picks, like the app.
  if (!rows.some((r) => /quick picks/i.test(r.title))) {
    const picks = rows.findIndex((r) => /songs for you/i.test(r.title));
    if (picks >= 0) rows[picks] = { ...rows[picks]!, title: "Quick picks" };
  }
  // Speed dial (the owner's pinned picks) first, the rest in YouTube Music's order.
  const dial = rows.findIndex((r) => /speed dial/i.test(r.title));
  if (dial > 0) rows.unshift(...rows.splice(dial, 1));
  return rows;
}
