import type { Fetch } from "./http";

/**
 * A song's official music video on YouTube, for the home dashboard's now-playing card (the owner
 * 11-05: "the video plays inside of the media bubble ... if it doesn't have a video then it
 * should show the entire poster"). Speakers report the song, not its video, and YouTube Music's
 * own song-to-video link needs a signed-in account, so this searches YouTube Music's public
 * video search for the artist and title and takes only an official video (YouTube's
 * MUSIC_VIDEO_TYPE_OMV) whose title has the song and whose channel line has the artist. Fan
 * uploads, lyric videos and live recordings don't count; then the card shows the poster.
 *
 * Only the song's title and artist leave Hearth (no account, no key). Answers, including "none",
 * are kept for a day.
 */

const SEARCH = "https://music.youtube.com/youtubei/v1/search?prettyPrint=false";
/** YouTube Music's "Videos" search filter. */
const VIDEOS = "EgWKAQIQAWoMEA4QChADEAQQCRAF";
const DAY = 24 * 60 * 60_000;
const cache = new Map<string, { at: number; id: string | null }>();

const plain = (s: string) =>
  s
    .toLowerCase()
    .replace(/\((feat|ft|with|from|remaster)[^)]*\)|\[[^\]]*]/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

interface Hit {
  id: string;
  type: string;
  title: string;
  line: string;
}

function hitsOf(json: unknown): Hit[] {
  const out: Hit[] = [];
  const walk = (o: unknown) => {
    if (!o || typeof o !== "object" || out.length > 20) return;
    const row = (o as Record<string, unknown>).musicResponsiveListItemRenderer as
      Record<string, unknown> | undefined;
    if (row) {
      const s = JSON.stringify(row);
      const cols = (row.flexColumns ?? []) as {
        musicResponsiveListItemFlexColumnRenderer?: { text?: { runs?: { text?: string }[] } };
      }[];
      const text = (i: number) =>
        (cols[i]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [])
          .map((r) => r.text ?? "")
          .join("");
      const id = /"videoId":"([\w-]{11})"/.exec(s)?.[1];
      const type = /MUSIC_VIDEO_TYPE_\w+/.exec(s)?.[0] ?? "";
      if (id) out.push({ id, type, title: text(0), line: text(1) });
      return;
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(json);
  return out;
}

/** The YouTube id of the song's official video, or null when it has none. */
export async function musicVideo(
  fetchImpl: Fetch,
  title: string,
  artist: string,
): Promise<string | null> {
  const song = plain(title);
  const by = plain(artist.split(/,|&| feat\.? | ft\.? | x /i)[0] ?? "");
  if (!song || !by) return null;
  const key = `${song}|${by}`;
  const kept = cache.get(key);
  if (kept && Date.now() - kept.at < DAY) return kept.id;
  let id: string | null;
  try {
    const res = await fetchImpl(SEARCH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
        Origin: "https://music.youtube.com",
      },
      body: JSON.stringify({
        context: {
          client: { clientName: "WEB_REMIX", clientVersion: "1.20251015.01.00", hl: "en" },
        },
        query: `${artist} ${title}`.slice(0, 200),
        params: VIDEOS,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const hit = hitsOf(await res.json()).find(
      (h) =>
        h.type === "MUSIC_VIDEO_TYPE_OMV" &&
        plain(h.title).includes(song) &&
        plain(h.line).includes(by) &&
        !/\b(live|lyric|lyrics|cover|reaction|karaoke)\b/.test(plain(h.title).replace(song, "")),
    );
    id = hit?.id ?? null;
  } catch {
    // YouTube didn't answer: the poster shows, and it is asked again next time.
    return null;
  }
  if (cache.size > 500) cache.clear();
  cache.set(key, { at: Date.now(), id });
  return id;
}

/** For tests. */
export const _hitsOf = hitsOf;
