import {
  PAGE_SIZE,
  SHARED_VIEWS,
  ServarrReadError,
  list,
  lookupsOf,
  needer,
  num,
  nums,
  obj,
  page,
  qualityOf,
  readSharedView,
  str,
  strs,
  versionInfo,
  type Json,
  type ServarrGet,
  type SharedView,
} from "./servarr-panel";

/**
 * Lidarr's native panel reads (native panels Phase 3): artists, an artist's albums, an album's
 * tracks and files, missing and below-cutoff albums, files waiting to be imported, and Lidarr's own
 * artist search. Profiles, formats, tags, naming, connections, history, blocklist, system and the
 * log are the shared Servarr reads on Lidarr's v1 API. Reading changes nothing; every change is a
 * plan step, the same one Ember plans.
 */

export const LIDARR_VIEWS = [
  "library",
  "artist",
  "album",
  "missing",
  "cutoff",
  "imports",
  "lookup",
  "metadata",
  ...SHARED_VIEWS,
] as const;
export type LidarrView = (typeof LIDARR_VIEWS)[number];

export { ServarrReadError as LidarrReadError };

const V1 = "/api/v1";
const stats = (v: unknown) => {
  const s = obj(v);
  return {
    albums: num(s.albumCount) ?? 0,
    files: num(s.trackFileCount) ?? 0,
    tracks: num(s.trackCount) ?? 0,
    total: num(s.totalTrackCount) ?? 0,
    size: num(s.sizeOnDisk) ?? 0,
  };
};

export function artistRow(a: Json) {
  return {
    id: num(a.id)!,
    name: str(a.artistName) ?? "?",
    sortName: (str(a.sortName) ?? str(a.artistName) ?? "").toLowerCase(),
    foreignId: str(a.foreignArtistId),
    disambiguation: str(a.disambiguation) || undefined,
    type: str(a.artistType),
    status: str(a.status) ?? "continuing",
    monitored: a.monitored === true,
    monitorNewItems: str(a.monitorNewItems) ?? "all",
    profileId: num(a.qualityProfileId),
    metadataProfileId: num(a.metadataProfileId),
    tags: nums(a.tags),
    path: str(a.path),
    genres: strs(a.genres).slice(0, 4),
    added: str(a.added),
    stats: stats(a.statistics),
  };
}

function albumRow(a: Json) {
  return {
    id: num(a.id)!,
    artistId: num(a.artistId),
    artist: str(obj(a.artist).artistName),
    title: str(a.title) ?? "?",
    type: str(a.albumType) ?? "Album",
    secondaryTypes: strs(a.secondaryTypes),
    released: str(a.releaseDate),
    monitored: a.monitored === true,
    anyReleaseOk: a.anyReleaseOk !== false,
    foreignId: str(a.foreignAlbumId),
    stats: stats(a.statistics),
    releases: list(a.releases).length,
  };
}

export async function readLidarrView(
  get: ServarrGet,
  view: LidarrView,
  q: Record<string, string | undefined>,
): Promise<Json> {
  const need = needer("lidarr", get);
  const status = obj(await need(`${V1}/system/status`, "its version"));
  if ((SHARED_VIEWS as readonly string[]).includes(view))
    return readSharedView("lidarr", get, view as SharedView, q, status);
  const meta = versionInfo(status, "lidarr");
  const lookups = async () => {
    const [base, metadata] = await Promise.all([
      lookupsOf("lidarr", get),
      need(`${V1}/metadataprofile`, "its metadata profiles"),
    ]);
    return {
      ...base,
      metadataProfiles: list(metadata).map((m) => ({ id: num(m.id)!, name: str(m.name) ?? "?" })),
    };
  };

  switch (view as Exclude<LidarrView, SharedView>) {
    case "library": {
      const [artists, look, roots] = await Promise.all([
        need(`${V1}/artist`, "its artists"),
        lookups(),
        need(`${V1}/rootfolder`, "its root folders"),
      ]);
      return {
        meta,
        ...look,
        rootFolders: list(roots).map((r) => ({ id: num(r.id)!, path: str(r.path) ?? "" })),
        artists: list(artists).map(artistRow),
      };
    }
    case "artist": {
      const id = Number(q.id);
      if (!Number.isInteger(id) || id <= 0) throw new ServarrReadError("Say which artist (id).");
      const [artist, albums, look, history] = await Promise.all([
        need(`${V1}/artist/${id}`, "the artist"),
        need(`${V1}/album?artistId=${id}`, "its albums"),
        lookups(),
        get(`${V1}/history/artist?artistId=${id}&includeAlbum=true`),
      ]);
      const a = obj(artist);
      return {
        meta,
        ...look,
        artist: { ...artistRow(a), overview: str(a.overview) },
        albums: list(albums)
          .map(albumRow)
          .sort((x, y) => (y.released ?? "").localeCompare(x.released ?? "")),
        history: list(history.ok ? history.data : [])
          .slice(0, 20)
          .map((h) => ({
            id: num(h.id)!,
            event: str(h.eventType) ?? "unknown",
            release: str(h.sourceTitle),
            album: str(obj(h.album).title),
            quality: qualityOf(h).name,
            date: str(h.date),
          })),
      };
    }
    case "album": {
      const id = Number(q.id);
      if (!Number.isInteger(id) || id <= 0) throw new ServarrReadError("Say which album (id).");
      const [album, tracks, files] = await Promise.all([
        need(`${V1}/album/${id}`, "the album"),
        need(`${V1}/track?albumId=${id}`, "its tracks"),
        need(`${V1}/trackfile?albumId=${id}`, "its files"),
      ]);
      const byFile = new Map(list(files).map((f) => [num(f.id), f]));
      return {
        meta,
        album: albumRow(obj(album)),
        tracks: list(tracks)
          .map((t) => {
            const f = byFile.get(num(t.trackFileId));
            return {
              id: num(t.id)!,
              number: str(t.trackNumber) ?? String(num(t.absoluteTrackNumber) ?? ""),
              medium: num(t.mediumNumber) ?? 1,
              title: str(t.title) ?? "?",
              duration: num(t.duration),
              hasFile: t.hasFile === true,
              fileId: f ? num(f.id) : undefined,
              quality: f ? qualityOf(f).name : undefined,
              size: f ? num(f.size) : undefined,
            };
          })
          .sort((a, b) => a.medium - b.medium || Number(a.number) - Number(b.number)),
      };
    }
    case "missing":
    case "cutoff": {
      const data = obj(
        await need(
          `${V1}/wanted/${view}?page=${page(q)}&pageSize=${PAGE_SIZE}&sortKey=releaseDate&sortDirection=descending&includeArtist=true`,
          view === "missing" ? "missing albums" : "albums below their cutoff",
        ),
      );
      return {
        meta,
        page: num(data.page) ?? 1,
        pageSize: PAGE_SIZE,
        total: num(data.totalRecords) ?? 0,
        records: list(data.records).map(albumRow),
      };
    }
    case "imports": {
      const folder = String(q.folder ?? "")
        .trim()
        .slice(0, 400);
      if (!folder) return { meta, folder, files: [] };
      const found = list(
        await need(
          `${V1}/manualimport?folder=${encodeURIComponent(folder)}&filterExistingFiles=true`,
          "the files waiting there",
        ),
      );
      return {
        meta,
        folder,
        files: found.map((f) => ({
          path: str(f.path) ?? "",
          name: str(f.name) ?? str(f.path) ?? "",
          size: num(f.size) ?? 0,
          quality: qualityOf(f).name,
          artistId: num(obj(f.artist).id),
          artist: str(obj(f.artist).artistName),
          albumId: num(obj(f.album).id),
          album: str(obj(f.album).title),
          releaseId: num(f.albumReleaseId),
          tracks: list(f.tracks).map((t) => ({
            id: num(t.id)!,
            title: str(t.title) ?? "?",
            number: str(t.trackNumber),
          })),
          rejections: list(f.rejections).map((r) => str(r.reason) ?? ""),
        })),
      };
    }
    case "lookup": {
      const term = String(q.title ?? "")
        .trim()
        .slice(0, 120);
      if (!term) return { meta, results: [] };
      const [found, have, look, roots] = await Promise.all([
        need(`${V1}/artist/lookup?term=${encodeURIComponent(term)}`, "search results"),
        need(`${V1}/artist`, "its artists"),
        lookups(),
        need(`${V1}/rootfolder`, "its root folders"),
      ]);
      const ids = new Set(list(have).map((a) => str(a.foreignArtistId)));
      return {
        meta,
        ...look,
        rootFolders: list(roots).map((r) => ({ id: num(r.id)!, path: str(r.path) ?? "" })),
        results: list(found)
          .slice(0, 20)
          .map((a) => ({
            key: str(a.foreignArtistId) ?? "",
            name: str(a.artistName) ?? "?",
            // Shared screens (Exclusions) list results by title.
            title: str(a.artistName) ?? "?",
            disambiguation: str(a.disambiguation) || undefined,
            type: str(a.artistType),
            overview: str(a.overview)?.slice(0, 400),
            genres: strs(a.genres).slice(0, 3),
            inLibrary: ids.has(str(a.foreignArtistId)),
          })),
      };
    }
    case "metadata": {
      const profiles = list(await need(`${V1}/metadataprofile`, "its metadata profiles"));
      const kinds = (v: unknown, key: string) =>
        list(v).map((x) => ({
          id: num(obj(x[key]).id)!,
          name: str(obj(x[key]).name) ?? "?",
          allowed: x.allowed === true,
        }));
      return {
        meta,
        profiles: profiles.map((p) => ({
          id: num(p.id)!,
          name: str(p.name) ?? "?",
          primary: kinds(p.primaryAlbumTypes, "albumType"),
          secondary: kinds(p.secondaryAlbumTypes, "albumType"),
          statuses: kinds(p.releaseStatuses, "releaseStatus"),
        })),
      };
    }
  }
}
