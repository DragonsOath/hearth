import { extensionOf, previewPath } from "@dragon-control/core";
import type { Fetch } from "./http";
import { placeholderArt } from "./fake-jellyfin";

/**
 * A stand-in Immich v3 (port 2283) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install): photos and videos, storage, two people, queues with one busy and one with failures,
 * and the calls the panel's controls make.
 */

export interface FakeImmich {
  fetch: Fetch;
  reset(): void;
  /** Adds albums named Album 1 to Album n, two photos each, the last one newest. */
  seedAlbums(n: number): void;
}

const QUEUES = () => [
  {
    name: "thumbnailGeneration",
    isPaused: false,
    statistics: { active: 2, completed: 0, failed: 0, delayed: 0, waiting: 120, paused: 0 },
  },
  {
    name: "faceDetection",
    isPaused: false,
    statistics: { active: 0, completed: 0, failed: 7, delayed: 0, waiting: 0, paused: 0 },
  },
  {
    name: "smartSearch",
    isPaused: false,
    statistics: { active: 0, completed: 0, failed: 0, delayed: 0, waiting: 0, paused: 0 },
  },
  {
    name: "storageTemplateMigration",
    isPaused: false,
    statistics: { active: 0, completed: 0, failed: 0, delayed: 0, waiting: 0, paused: 0 },
  },
];

/** The stand-in's one person (an administrator) and Immich's default storage template (off). */
const OWNER = "11111111-0000-4000-8000-000000000001";
const STORAGE = () => ({
  enabled: false,
  hashVerificationEnabled: true,
  template: "{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}",
});
/** Where Immich keeps a fresh upload: upload/<user>/<two folders>/<asset id>.<ext>. */
const uploadPath = (a: { id: string; originalFileName: string }) =>
  `/data/upload/${OWNER}/${a.id.slice(0, 2)}/${a.id.slice(2, 4)}/${a.id}.${extensionOf(a.originalFileName)}`;

/** Its photos: 90 on the timeline, newest first, plus one archived and one locked (never shown). */
const TINTS: [number, number, number][] = [
  [220, 120, 40],
  [60, 140, 230],
  [70, 200, 120],
  [200, 80, 160],
  [230, 200, 60],
  [120, 90, 230],
];
export const FAKE_PHOTOS = Array.from({ length: 90 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  originalFileName: `IMG_${String(4100 - i).padStart(4, "0")}.${i < 10 ? "jpg" : ["jpg", "heic", "png", "jpg", "jpeg"][i % 5]}`,
  fileCreatedAt: new Date(Date.UTC(2026, 9, 30, 18) - i * 5 * 3_600_000).toISOString(),
  isFavorite: i === 2,
  visibility: "timeline",
}));
const HIDDEN = [
  {
    id: "00000000-0000-4000-8000-0000000000aa",
    originalFileName: "archived.jpg",
    visibility: "archive",
  },
  {
    id: "00000000-0000-4000-8000-0000000000bb",
    originalFileName: "locked.jpg",
    visibility: "locked",
  },
];
const thumbs = new Map<string, Buffer>();
/**
 * A photo's stand-in picture: a glow placed off center, so a flip or a turn visibly moves it (as
 * Immich's edited thumbnail would show the edit).
 */
const thumbOf = (id: string, edits: unknown[] = []) => {
  const n = Number(id.slice(-4)) || 0;
  let cx = 0.3 + ((n * 37) % 40) / 100;
  let cy = 0.35 + ((n * 53) % 30) / 100;
  for (const e of edits as { action: string; parameters: { axis?: string; angle?: number } }[]) {
    if (e.action === "mirror" && e.parameters.axis === "horizontal") cx = 1 - cx;
    if (e.action === "mirror" && e.parameters.axis === "vertical") cy = 1 - cy;
    if (e.action === "rotate")
      for (let q = 0; q < (e.parameters.angle ?? 0) / 90; q++) [cx, cy] = [1 - cy, cx];
  }
  const k = `${id}:${cx.toFixed(3)}:${cy.toFixed(3)}`;
  let t = thumbs.get(k);
  if (!t) {
    t = placeholderArt(48, 48, cx, cy, TINTS[n % TINTS.length]);
    thumbs.set(k, t);
  }
  return t;
};

export function fakeImmich(): FakeImmich {
  let queues = QUEUES();
  const jobs: string[] = [];
  let links: { id: string; key: string; assets: { id: string }[] }[] = [];
  // Albums (photo ids in each) and Immich 2.5's edits (mirror and rotate), per photo.
  let albums: { id: string; albumName: string; ids: Set<string>; updatedAt: string }[] = [];
  // Files and folders: the storage template, where each file is, and the job's remaining polls.
  let storage = STORAGE();
  let paths = new Map<string, string>();
  let migrating = 0;
  let edits = new Map<string, unknown[]>();
  let albumSeq = 0;
  let stamps = new Map<string, string>();
  const reply = (status: number, data: unknown) => ({
    ok: status < 400,
    status,
    json: async () => data,
  });
  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/api/, "");
    const method = init.method ?? "GET";
    const key = ((init.headers ?? {}) as Record<string, string>)["x-api-key"] ?? "";
    if (!key.startsWith("e2e-")) return reply(401, { message: "Invalid API key" });
    const body = init.body
      ? (JSON.parse(String(init.body)) as { isPaused?: boolean; command?: string; name?: string })
      : {};
    if (p === "/server/about") return reply(200, { version: "v3.2.4" });
    if (p === "/server/statistics")
      return reply(200, {
        photos: 48210,
        videos: 1904,
        usage: 812 * 1024 ** 3,
        usageByUser: [
          {
            userName: "Alex",
            photos: 40000,
            videos: 1500,
            usage: 700 * 1024 ** 3,
            quotaSizeInBytes: null,
          },
          {
            userName: "Sam",
            photos: 8210,
            videos: 404,
            usage: 112 * 1024 ** 3,
            quotaSizeInBytes: 200 * 1024 ** 3,
          },
        ],
      });
    if (p === "/server/storage")
      return reply(200, {
        diskSize: "3.6 TiB",
        diskUse: "1.9 TiB",
        diskAvailable: "1.7 TiB",
        diskUsagePercentage: 52.4,
      });
    if (p === "/queues" && method === "GET") {
      // The storage template job shows as busy for a couple of reads, then done.
      const busy = migrating > 0;
      if (busy) migrating -= 1;
      return reply(
        200,
        queues.map((x) =>
          x.name === "storageTemplateMigration"
            ? { ...x, statistics: { ...x.statistics, active: busy ? 1 : 0 } }
            : x,
        ),
      );
    }
    const q = /^\/queues\/(\w+)$/.exec(p);
    if (q && method === "PUT") {
      queues = queues.map((x) =>
        x.name === q[1] ? { ...x, isPaused: Boolean(body.isPaused) } : x,
      );
      return reply(
        200,
        queues.find((x) => x.name === q[1]),
      );
    }
    const legacy = /^\/jobs\/(\w+)$/.exec(p);
    if (legacy && method === "PUT" && legacy[1] === "storageTemplateMigration") {
      // Immich moves and renames every file in the library to match (external ones stay).
      if (storage.enabled)
        for (const a of FAKE_PHOTOS) {
          const album = albums.find((x) => x.ids.has(a.id))?.albumName;
          paths.set(
            a.id,
            `/data/${previewPath(storage.template, {
              name: a.originalFileName,
              takenAt: a.fileCreatedAt,
              owner: "admin",
              ...(album ? { album } : {}),
            })}`,
          );
        }
      migrating = 2;
      return reply(200, { queueStatus: { isActive: true }, jobCounts: { active: 1 } });
    }
    if (legacy && method === "PUT") {
      if (body.command === "clear-failed")
        queues = queues.map((x) =>
          x.name === legacy[1] ? { ...x, statistics: { ...x.statistics, failed: 0 } } : x,
        );
      return reply(200, {});
    }
    if (p === "/search/metadata" && method === "POST") {
      const want = body as {
        size?: number;
        page?: number;
        visibility?: string;
        type?: string;
        albumIds?: string[];
      };
      const inAlbum = want.albumIds?.length
        ? albums.find((a) => a.id === want.albumIds![0])?.ids
        : undefined;
      const all = [...FAKE_PHOTOS, ...HIDDEN].filter(
        (a) =>
          (!want.visibility || a.visibility === want.visibility) &&
          (!want.albumIds?.length || Boolean(inAlbum?.has(a.id))),
      );
      const size = want.size ?? 250;
      const page = want.page ?? 1;
      // Immich changes a photo's updatedAt when it is edited (Hearth uses it to show the new look).
      const items = all.slice((page - 1) * size, page * size).map((a) => ({
        ...a,
        updatedAt: stamps.get(a.id) ?? "2026-01-01T00:00:00.000Z",
        ownerId: OWNER,
        type: "IMAGE",
        isExternal: false,
        libraryId: null,
        originalPath: paths.get(a.id) ?? uploadPath(a),
      }));
      const more = page * size < all.length;
      return reply(200, {
        assets: {
          total: all.length,
          count: items.length,
          items,
          nextPage: more ? String(page + 1) : null,
        },
      });
    }
    const asset = /^\/assets\/([0-9a-f-]{36})$/.exec(p);
    if (asset && method === "GET") {
      const a = [...FAKE_PHOTOS, ...HIDDEN].find((x) => x.id === asset[1]);
      return a
        ? reply(200, {
            ...a,
            type: "IMAGE",
            isTrashed: false,
            livePhotoVideoId: null,
            libraryId: null,
            isExternal: false,
            ownerId: OWNER,
            originalPath: paths.get(a.id) ?? uploadPath(a),
            isEdited: edits.has(a.id),
          })
        : reply(404, {});
    }
    if (p === "/server/config") return reply(200, { externalDomain: "" });
    if (p === "/system-config" && method === "GET")
      return reply(200, { storageTemplate: storage, trash: { enabled: true, days: 30 } });
    if (p === "/system-config" && method === "PUT") {
      // A read-only key cannot change settings (Immich answers 403 for a missing permission).
      if (key === "e2e-im-readonly") return reply(403, { message: "Missing permission" });
      const next = (body as unknown as { storageTemplate?: typeof storage }).storageTemplate;
      if (!next?.template || !/\{\{filename\}\}|\{\{assetId/.test(next.template))
        return reply(400, { message: "Invalid storage template" });
      storage = { ...storage, ...next };
      return reply(200, { storageTemplate: storage });
    }
    if (p === "/users/me" && method === "GET")
      return reply(200, { id: OWNER, isAdmin: true, storageLabel: "admin", name: "Alex" });
    if (p === "/api-keys/me" && method === "GET")
      return reply(200, {
        name: "Hearth",
        permissions: key === "e2e-im-readonly" ? ["asset.read", "systemConfig.read"] : ["all"],
      });
    const known = (id: string) => FAKE_PHOTOS.some((a) => a.id === id);
    if (p === "/albums" && method === "GET") {
      const of = u.searchParams.get("assetId");
      return reply(
        200,
        albums
          .filter((a) => !of || a.ids.has(of))
          .map((a) => ({
            id: a.id,
            albumName: a.albumName,
            assetCount: a.ids.size,
            updatedAt: a.updatedAt,
          })),
      );
    }
    if (p === "/albums" && method === "POST") {
      const b = body as unknown as { albumName?: string; assetIds?: string[] };
      const id = `22222222-0000-4000-8000-${String(++albumSeq).padStart(12, "0")}`;
      albums.push({
        id,
        albumName: String(b.albumName),
        ids: new Set((b.assetIds ?? []).filter(known)),
        // Each new album is newer than the last, as a real one made later would be.
        updatedAt: new Date(Date.UTC(2026, 10, 1) + albumSeq * 60_000).toISOString(),
      });
      return reply(201, { id, albumName: b.albumName });
    }
    const albumOne = /^\/albums\/([0-9a-f-]{36})$/.exec(p);
    if (albumOne && method === "DELETE") {
      const before = albums.length;
      albums = albums.filter((a) => a.id !== albumOne[1]);
      return reply(albums.length < before ? 204 : 400, null);
    }
    const albumAssets = /^\/albums\/([0-9a-f-]{36})\/assets$/.exec(p);
    if (albumAssets) {
      const album = albums.find((a) => a.id === albumAssets[1]);
      if (!album) return reply(400, { message: "Not found or no album.read access" });
      const ids = (body as unknown as { ids?: string[] }).ids ?? [];
      if (method === "PUT")
        return reply(
          200,
          ids.map((id) => {
            if (!known(id)) return { id, success: false, error: "not_found" };
            if (album.ids.has(id)) return { id, success: false, error: "duplicate" };
            album.ids.add(id);
            album.updatedAt = new Date(Date.parse(album.updatedAt) + 1000).toISOString();
            return { id, success: true };
          }),
        );
      if (method === "DELETE")
        return reply(
          200,
          ids.map((id) => ({ id, success: album.ids.delete(id) })),
        );
    }
    const assetEdits = /^\/assets\/([0-9a-f-]{36})\/edits$/.exec(p);
    if (assetEdits) {
      const id = assetEdits[1]!;
      if (!known(id)) return reply(400, { message: "Asset not found" });
      if (method === "GET") return reply(200, { assetId: id, edits: edits.get(id) ?? [] });
      if (method === "PUT") {
        const list = ((body as unknown as { edits?: unknown[] }).edits ?? []).map((e, i) => ({
          id: `33333333-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
          ...(e as object),
        }));
        edits.set(id, list);
        stamps.set(id, new Date().toISOString());
        return reply(200, { assetId: id, edits: list });
      }
      if (method === "DELETE") {
        edits.delete(id);
        stamps.set(id, new Date().toISOString());
        return reply(204, null);
      }
    }
    if (p === "/shared-links" && method === "POST") {
      const b = body as unknown as { assetIds?: string[] };
      const id = `11111111-0000-4000-8000-${String(links.length + 1).padStart(12, "0")}`;
      const link = {
        id,
        key: `share${links.length + 1}key`,
        assets: (b.assetIds ?? []).map((x) => ({ id: x })),
      };
      links.push(link);
      return reply(201, link);
    }
    const link = /^\/shared-links\/([0-9a-f-]{36})$/.exec(p);
    if (link && method === "GET") {
      const l = links.find((x) => x.id === link[1]);
      return l ? reply(200, l) : reply(404, {});
    }
    const thumb = /^\/assets\/([0-9a-f-]{36})\/thumbnail$/.exec(p);
    if (thumb && method === "GET") {
      if (![...FAKE_PHOTOS, ...HIDDEN].some((a) => a.id === thumb[1])) return reply(404, {});
      const img = thumbOf(
        thumb[1]!,
        u.searchParams.get("edited") === "true" ? edits.get(thumb[1]!) : undefined,
      );
      return {
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "image/png" : null) },
        json: async () => ({}),
        text: async () => "",
        arrayBuffer: async () => img.buffer.slice(img.byteOffset, img.byteOffset + img.length),
      } as unknown as Awaited<ReturnType<Fetch>>;
    }
    if (p === "/jobs" && method === "POST") {
      jobs.push(String(body.name));
      return reply(204, null);
    }
    return reply(404, {});
  };
  return {
    fetch: fetchImpl,
    seedAlbums: (n: number) => {
      for (let k = 1; k <= n; k++) {
        albumSeq += 1;
        albums.push({
          id: `22222222-0000-4000-8000-${String(albumSeq).padStart(12, "0")}`,
          albumName: `Album ${k}`,
          ids: new Set([FAKE_PHOTOS[20 + k]!.id, FAKE_PHOTOS[40 + k]!.id]),
          updatedAt: new Date(Date.UTC(2026, 9, 1) + k * 60_000).toISOString(),
        });
      }
    },
    reset: () => {
      queues = QUEUES();
      links = [];
      albums = [];
      storage = STORAGE();
      paths = new Map();
      migrating = 0;
      edits = new Map();
      stamps = new Map();
    },
  };
}
