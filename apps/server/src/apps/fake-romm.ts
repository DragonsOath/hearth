import type { Fetch } from "./http";

/**
 * A stand-in RomM 5.3 (port 8095) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install): four platforms, eight invented games (one without a cover, two not identified), a
 * favourites collection, sign-in and sign-out, covers, and a library scan over a pretend socket
 * that finds one new game. A login's password, or a token, starting "e2e-" is accepted; the login
 * "e2e-viewer" is a viewer (no scans).
 */

export interface FakeRomm {
  fetch: Fetch;
  reset(): void;
}

const PLATFORMS = [
  {
    id: 1,
    slug: "gba",
    fs_slug: "gba",
    name: "Game Boy Advance",
    display_name: "Game Boy Advance",
  },
  {
    id: 2,
    slug: "nes",
    fs_slug: "nes",
    name: "Nintendo Entertainment System",
    display_name: "Nintendo Entertainment System",
  },
  { id: 3, slug: "psx", fs_slug: "psx", name: "PlayStation", display_name: "PlayStation" },
  {
    id: 4,
    slug: "snes",
    fs_slug: "snes",
    name: "Super Nintendo Entertainment System",
    display_name: "Super Nintendo Entertainment System",
  },
];

interface Rom {
  id: number;
  name: string;
  fs_name: string;
  platform_id: number;
  fs_size_bytes: number;
  regions: string[];
  genres: string[];
  developers: string[];
  year?: number;
  cover: boolean;
  identified: boolean;
  created: number;
  summary?: string;
}

const day = 86_400_000;
const ROMS = (now: number): Rom[] => [
  {
    id: 1,
    name: "Pocket Lighthouse",
    fs_name: "Pocket Lighthouse (USA).gba",
    platform_id: 1,
    fs_size_bytes: 2_097_152,
    regions: ["USA"],
    genres: ["Puzzle"],
    developers: ["Harbor Soft"],
    year: 2003,
    cover: true,
    identified: true,
    created: now - 9 * day,
    summary: "Keep the light burning through a long night of puzzles.",
  },
  {
    id: 2,
    name: "Tidal Garden",
    fs_name: "Tidal Garden (Europe) (En,Fr,De).gba",
    platform_id: 1,
    fs_size_bytes: 1_048_576,
    regions: ["Europe"],
    genres: ["Simulation"],
    developers: ["Shoreline"],
    year: 2004,
    cover: true,
    identified: true,
    created: now - 8 * day,
  },
  {
    id: 3,
    name: "Copper Comet",
    fs_name: "Copper Comet (Europe).nes",
    platform_id: 2,
    fs_size_bytes: 24_592,
    regions: ["Europe"],
    genres: [],
    developers: [],
    cover: false,
    identified: false,
    created: now - 7 * day,
  },
  {
    id: 4,
    name: "Lantern Quest",
    fs_name: "Lantern Quest (USA).nes",
    platform_id: 2,
    fs_size_bytes: 40_976,
    regions: ["USA"],
    genres: ["Adventure", "Role-playing (RPG)"],
    developers: ["Ember Works"],
    year: 1989,
    cover: true,
    identified: true,
    created: now - 6 * day,
    summary: "A small lantern, a long road, and a castle at the end of it.",
  },
  {
    id: 5,
    name: "Moss Knight",
    fs_name: "Moss Knight (USA) (Rev 1).nes",
    platform_id: 2,
    fs_size_bytes: 131_088,
    regions: ["USA"],
    genres: ["Platform"],
    developers: ["Ember Works"],
    year: 1991,
    cover: true,
    identified: true,
    created: now - 5 * day,
  },
  {
    id: 6,
    name: "Silent Ferry",
    fs_name: "Silent Ferry (USA)",
    platform_id: 3,
    fs_size_bytes: 3_145_809,
    regions: ["USA"],
    genres: ["Adventure"],
    developers: ["Night Harbor"],
    year: 1998,
    cover: true,
    identified: true,
    created: now - 1 * day,
  },
  {
    id: 7,
    name: "Harbor Lights",
    fs_name: "Harbor Lights (USA).sfc",
    platform_id: 4,
    fs_size_bytes: 524_288,
    regions: ["USA"],
    genres: ["Racing"],
    developers: ["Shoreline"],
    year: 1994,
    cover: true,
    identified: true,
    created: now - 4 * day,
  },
  {
    id: 8,
    name: "Iron Orchard",
    fs_name: "Iron Orchard (Japan).sfc",
    platform_id: 4,
    fs_size_bytes: 1_048_576,
    regions: ["Japan"],
    genres: [],
    developers: [],
    cover: true,
    identified: false,
    created: now - 3 * day,
  },
];
/** What a scan "finds": one new game on the NES. */
const FOUND = (now: number): Rom => ({
  id: 9,
  name: "Ember Valley",
  fs_name: "Ember Valley (USA).nes",
  platform_id: 2,
  fs_size_bytes: 65_552,
  regions: ["USA"],
  genres: ["Action"],
  developers: ["Ember Works"],
  year: 1990,
  cover: false,
  identified: true,
  created: now,
});

/** A 1x1 PNG, the stand-in's every cover. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4zwAAAgIBAJUcF6kAAAAASUVORK5CYII=",
  "base64",
);

export function fakeRomm(): FakeRomm {
  let roms = ROMS(Date.now());
  let favorites: number[] | undefined = [4];
  let scans = 0;
  let pending: string[] = [];
  const reply = (status: number, data: unknown, headers: Record<string, string> = {}) => ({
    ok: status < 400,
    status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  });
  const platformOf = (r: Rom) => PLATFORMS.find((p) => p.id === r.platform_id)!;
  const raw = (r: Rom) => ({
    id: r.id,
    name: r.name,
    fs_name: r.fs_name,
    platform_id: r.platform_id,
    platform_slug: platformOf(r).slug,
    platform_display_name: platformOf(r).display_name,
    fs_size_bytes: r.fs_size_bytes,
    regions: r.regions,
    languages: ["English"],
    summary: r.summary ?? "",
    path_cover_small: r.cover
      ? `/assets/romm/resources/roms/${r.platform_id}/${r.id}/cover/small.png?ts=1`
      : "",
    path_cover_large: r.cover
      ? `/assets/romm/resources/roms/${r.platform_id}/${r.id}/cover/big.png?ts=1`
      : "",
    is_unidentified: !r.identified,
    created_at: new Date(r.created).toISOString(),
    has_manual: false,
    metadatum: {
      genres: r.genres,
      franchises: [],
      developers: r.developers,
      publishers: [],
      player_count: "1",
      first_release_date: r.year ? Date.UTC(r.year, 5, 1) : null,
      average_rating: r.identified ? 78 : null,
    },
    files: [
      {
        file_name: r.fs_name.includes(".") ? r.fs_name : `${r.fs_name}.bin`,
        file_size_bytes: r.fs_size_bytes,
      },
    ],
    merged_screenshots: [],
  });
  const who = (init: { headers: Record<string, string> }) => {
    const a = init.headers.Authorization ?? init.headers.authorization ?? "";
    const cookie = init.headers.Cookie ?? init.headers.cookie ?? "";
    if (/romm_session=e2e-session/.test(cookie)) return "admin";
    if (a.startsWith("Bearer ")) return a.slice(7).startsWith("e2e-") ? "token" : undefined;
    if (a.startsWith("Basic ")) {
      const [user, pass] = Buffer.from(a.slice(6), "base64").toString().split(":");
      if (!pass?.startsWith("e2e-")) return undefined;
      return user === "e2e-viewer" ? "viewer" : "admin";
    }
    return undefined;
  };
  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname;
    const q = u.searchParams;
    const method = init.method ?? "GET";
    if (p === "/api/heartbeat")
      return reply(200, {
        SYSTEM: { VERSION: "5.3.1", SHOW_SETUP_WIZARD: false },
        METADATA_SOURCES: { LAUNCHBOX_API_ENABLED: true, HASHEOUS_API_ENABLED: true },
      });
    if (p.startsWith("/assets/romm/resources/"))
      return {
        ...reply(200, ""),
        arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
        headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "image/png" : null) },
      };
    // The pretend socket: open, connect, take "scan", answer with its events.
    if (p === "/ws/socket.io/") {
      if (!q.get("sid"))
        return reply(
          200,
          `0{"sid":"fake-sid","upgrades":[],"pingInterval":25000,"pingTimeout":60000}`,
        );
      if (method === "POST") {
        const body = String(init.body ?? "");
        if (body === "40") pending.push(`40{"sid":"fake-ns"}`);
        else if (body.startsWith("42")) {
          const [name, options] = JSON.parse(body.slice(2)) as [string, { platforms?: number[] }];
          if (name === "scan") {
            const cookie = init.headers.Cookie ?? "";
            if (!/romm_session=e2e-session/.test(cookie))
              pending.push(
                `42${JSON.stringify(["scan:done_ko", "You are not authorized to run scans"])}`,
              );
            else {
              scans += 1;
              const touches = !options.platforms?.length || options.platforms.includes(2);
              if (touches && !roms.some((r) => r.id === 9)) roms.push(FOUND(Date.now()));
              pending.push(
                `42${JSON.stringify(["scan:update_stats", { total_platforms: 4, scanned_platforms: 0 }])}`,
                `42${JSON.stringify(["scan:done", { scanned_platforms: options.platforms?.length || 4, scanned_roms: roms.length, new_roms: touches && scans === 1 ? 1 : 0, identified_roms: roms.filter((r) => r.identified).length }])}`,
              );
            }
          }
        }
        return reply(200, "ok");
      }
      const out = pending.join("\x1e") || "6";
      pending = [];
      return reply(200, out);
    }
    if (p === "/api/login" && method === "POST") {
      const role = who(init);
      if (role !== "admin" && role !== "viewer")
        return reply(401, { detail: "Invalid credentials" });
      return reply(
        200,
        { msg: "Successfully logged in" },
        {
          "set-cookie": "romm_session=e2e-session; HttpOnly; Path=/; SameSite=Lax",
        },
      );
    }
    if (p === "/api/logout") return reply(200, { msg: "Successfully logged out" });
    const role = who(init);
    if (!role) return reply(401, { detail: "Not authenticated" });
    if (p === "/api/users/me")
      return reply(200, {
        id: 1,
        username: role === "admin" ? "hearth" : "e2e-viewer",
        role: role === "admin" ? "admin" : role === "viewer" ? "viewer" : "viewer",
      });
    if (p === "/api/stats")
      return reply(200, {
        PLATFORMS: 4,
        ROMS: roms.length,
        SAVES: 3,
        STATES: 1,
        SCREENSHOTS: 0,
        TOTAL_FILESIZE_BYTES: roms.reduce((n, r) => n + r.fs_size_bytes, 0),
      });
    if (p === "/api/platforms")
      return reply(
        200,
        PLATFORMS.map((pl) => ({
          ...pl,
          rom_count: roms.filter((r) => r.platform_id === pl.id).length,
          fs_size_bytes: roms
            .filter((r) => r.platform_id === pl.id)
            .reduce((n, r) => n + r.fs_size_bytes, 0),
          missing_from_fs: false,
          is_unidentified: false,
        })),
      );
    if (p === "/api/collections" && method === "GET")
      return reply(
        200,
        favorites ? [{ id: 7, name: "Favourites", is_favorite: true, rom_ids: favorites }] : [],
      );
    if (p === "/api/collections" && method === "POST") {
      if (role === "token") return reply(403, { detail: "Forbidden" });
      favorites = [];
      return reply(200, { id: 7, name: "Favourites", is_favorite: true, rom_ids: [] });
    }
    const coll = /^\/api\/collections\/7\/roms$/.exec(p);
    if (coll && favorites) {
      if (role === "token") return reply(403, { detail: "Forbidden" });
      const ids = (JSON.parse(String(init.body ?? "{}")) as { rom_ids?: number[] }).rom_ids ?? [];
      favorites =
        method === "DELETE"
          ? favorites.filter((x) => !ids.includes(x))
          : [...new Set([...favorites, ...ids])];
      return reply(200, { id: 7, rom_ids: favorites });
    }
    if (p === "/api/roms") {
      const term = (q.get("search_term") ?? "").toLowerCase();
      const plat = Number(q.get("platform_ids") ?? 0);
      const genre = q.get("genres");
      let list = roms
        .filter(
          (r) =>
            !term || r.name.toLowerCase().includes(term) || r.fs_name.toLowerCase().includes(term),
        )
        .filter((r) => !plat || r.platform_id === plat)
        .filter((r) => !genre || r.genres.includes(genre))
        .filter((r) => q.get("favorite") !== "true" || (favorites ?? []).includes(r.id))
        .filter((r) => q.get("matched") !== "false" || !r.identified);
      const by = q.get("order_by") ?? "name";
      const dir = q.get("order_dir") === "desc" ? -1 : 1;
      const key = (r: Rom) =>
        by === "created_at"
          ? r.created
          : by === "fs_size_bytes"
            ? r.fs_size_bytes
            : by === "first_release_date"
              ? (r.year ?? 0)
              : r.name.toLowerCase();
      list = [...list].sort((a, b) => (key(a) < key(b) ? -dir : key(a) > key(b) ? dir : 0));
      const offset = Number(q.get("offset") ?? 0);
      const limit = Number(q.get("limit") ?? 50);
      return reply(200, {
        items: list.slice(offset, offset + limit).map(raw),
        total: list.length,
        limit,
        offset,
        filter_values: { genres: [...new Set(roms.flatMap((r) => r.genres))] },
      });
    }
    const one = /^\/api\/roms\/(\d+)$/.exec(p);
    if (one) {
      const r = roms.find((x) => x.id === Number(one[1]));
      return r ? reply(200, raw(r)) : reply(404, { detail: "Rom not found" });
    }
    return reply(404, { detail: "Not Found" });
  };
  return {
    fetch: fetchImpl,
    reset: () => {
      roms = ROMS(Date.now());
      favorites = [4];
      scans = 0;
      pending = [];
    },
  };
}
