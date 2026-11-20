import type { GrabSource } from "@dragon-control/core";

/**
 * Where a download came from (11-11, the owner: "I want to know which indexer or Usenet grabbed
 * the torrent ... which tracker was it"): the indexer named in the grab, as the app that
 * grabbed it recorded it. Radarr, Sonarr, Lidarr, Chaptarr and Readarr keep it in their history,
 * tied to the download client's id (a torrent's hash, a SABnzbd job's id); a grab made straight
 * from Prowlarr (Hearth's manual downloads) is in Prowlarr's history, tied only by its title.
 * When neither knows it, a private tracker's own address still names it.
 */

export interface GrabRecord {
  /** The download client's id: a torrent's hash, a SABnzbd nzo id. */
  downloadId?: string;
  /** The release title as grabbed. */
  title?: string;
  indexer: string;
  /** The app that grabbed it ("Radarr", "Prowlarr"). */
  via: string;
}

/** A name compared loosely: case, dots, spaces and brackets don't matter. */
export const looseName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Indexer names without the *arr's "(Prowlarr)" suffix. */
const cleanIndexer = (s: string) => s.replace(/\s*\(Prowlarr\)\s*$/i, "").trim();

export function sourceIndex(records: GrabRecord[]) {
  const byId = new Map<string, GrabSource>();
  const byTitle = new Map<string, GrabSource>();
  for (const r of records) {
    const s = { indexer: cleanIndexer(r.indexer), via: r.via };
    if (!s.indexer) continue;
    // Newest first: the first record for an id or a title wins.
    if (r.downloadId && !byId.has(r.downloadId.toLowerCase()))
      byId.set(r.downloadId.toLowerCase(), s);
    if (r.title && !byTitle.has(looseName(r.title))) byTitle.set(looseName(r.title), s);
  }
  return {
    find(id: string | undefined, title: string | undefined): GrabSource | undefined {
      return (
        (id ? byId.get(id.toLowerCase()) : undefined) ??
        (title ? byTitle.get(looseName(title)) : undefined)
      );
    },
  };
}

/** Private trackers whose own address names the site (public ones, like opentrackr, don't). */
const TRACKERS: [RegExp, string][] = [
  [/scenetime/i, "SceneTime"],
  [/torrentleech|tleechreload/i, "TorrentLeech"],
  [/iptorrents|empirehost|stackoverflow\.tech|bgp\.technology/i, "IPTorrents"],
  [/torrentday/i, "TorrentDay"],
  [/myanonamouse/i, "MyAnonamouse"],
  [/passthepopcorn/i, "PassThePopcorn"],
  [/beyond-hd/i, "BeyondHD"],
  [/blutopia/i, "Blutopia"],
  [/aither/i, "Aither"],
  [/hdbits/i, "HDBits"],
  [/filelist/i, "FileList"],
  [/redacted\.ch|flacsfor\.me/i, "Redacted"],
  [/orpheus/i, "Orpheus"],
  [/morethantv/i, "MoreThanTV"],
  [/broadcasthe\.net/i, "BroadcasTheNet"],
  [/nyaa/i, "Nyaa"],
  [/yts\.|yify/i, "YTS"],
];

export function trackerSource(tracker: string | undefined): GrabSource | undefined {
  if (!tracker) return undefined;
  const hit = TRACKERS.find(([re]) => re.test(tracker));
  return hit ? { indexer: hit[1], via: "tracker" } : undefined;
}
