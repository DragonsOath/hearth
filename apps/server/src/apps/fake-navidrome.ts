import type { Fetch } from "./http";

/**
 * A stand-in Navidrome (port 4533) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install), answering as a throwaway deluan/navidrome 0.64.2 did: a sign-in that gives a session and
 * a Subsonic token, an administrator and two users, one library, someone listening now, players,
 * a missing file, and the scan, user and missing-file calls. It counts sign-ins (a reader must reuse
 * its session), and its users carry a password field (e2e-SECRET) that must never reach the panel.
 */

export interface FakeNavidrome {
  fetch: Fetch;
  reset(): void;
  signIns(): number;
}

interface User {
  id: string;
  userName: string;
  name: string;
  email: string;
  isAdmin: boolean;
  lastAccessAt: string | null;
}

export function fakeNavidrome(): FakeNavidrome {
  let users: User[] = [];
  let missing: { id: string; title: string; artist: string; path: string }[] = [];
  let lastScan = "";
  let signIns = 0;
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const reset = () => {
    users = [
      {
        id: "u-admin",
        userName: "admin",
        name: "Alex",
        email: "alex@example.com",
        isAdmin: true,
        lastAccessAt: ago(2),
      },
      {
        id: "u-sam",
        userName: "sam",
        name: "Sam",
        email: "",
        isAdmin: false,
        lastAccessAt: ago(60 * 5),
      },
      { id: "u-kid", userName: "kid", name: "Kid", email: "", isAdmin: false, lastAccessAt: null },
    ];
    missing = [
      {
        id: "s-ember",
        title: "Ember",
        artist: "Lantern",
        path: "Lantern/First Light/02 Ember.mp3",
      },
    ];
    lastScan = ago(60 * 24 * 10);
    signIns = 0;
  };
  reset();

  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    return {
      ok: status < 400,
      status,
      json: async () => JSON.parse(text || "null") as unknown,
      text: async () => text,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    };
  };
  const list = (items: unknown[], total = items.length) =>
    reply(200, items, { "x-total-count": String(total) });
  const ok = (extra: Record<string, unknown> = {}) =>
    reply(200, {
      "subsonic-response": {
        status: "ok",
        version: "1.16.1",
        type: "navidrome",
        serverVersion: "0.64.2 (10114574)",
        openSubsonic: true,
        ...extra,
      },
    });

  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname;
    const method = init.method ?? "GET";
    if (path === "/auth/login") {
      signIns += 1;
      const b = JSON.parse(init.body ?? "{}") as { username?: string; password?: string };
      if (!b.username || !b.password?.startsWith("e2e-"))
        return reply(401, { error: "Invalid username or password" });
      return reply(200, {
        id: "u-admin",
        isAdmin: true,
        name: "Alex",
        token: "e2e-jwt",
        subsonicToken: "e2e-sub",
        subsonicSalt: "abc",
      });
    }
    if (path.startsWith("/rest/")) {
      if (u.searchParams.get("t") !== "e2e-sub")
        return reply(200, {
          "subsonic-response": {
            status: "failed",
            error: { code: 40, message: "Wrong username or password" },
          },
        });
      const m = path.slice(6);
      // Like the real one: starting answers "scanning" with the previous scan's time.
      if (m === "startScan") {
        const was = lastScan;
        lastScan = new Date().toISOString();
        return ok({
          scanStatus: {
            scanning: true,
            count: 0,
            folderCount: 0,
            lastScan: was,
            scanType: "quick",
          },
        });
      }
      if (m === "getScanStatus")
        return ok({
          scanStatus: {
            scanning: false,
            count: 1284,
            folderCount: 96,
            lastScan,
            scanType: u.searchParams.get("fullScan") ? "full" : "quick",
          },
        });
      if (m === "getNowPlaying")
        return ok({
          nowPlaying: {
            entry: [
              {
                username: "sam",
                title: "Tide",
                artist: "Quiet Harbor",
                album: "Open Water",
                playerName: "Sam's phone",
                minutesAgo: 1,
              },
            ],
          },
        });
      return ok();
    }
    if (init.headers["x-nd-authorization"] !== "Bearer e2e-jwt")
      return reply(401, { error: "Not authenticated" });
    if (path === "/api/library")
      return list([
        {
          id: 1,
          name: "Music Library",
          path: "/music",
          totalSongs: 1284,
          totalAlbums: 112,
          totalArtists: 64,
          totalMissingFiles: missing.length,
          lastScanAt: lastScan,
        },
      ]);
    if (path === "/api/user" && method === "GET")
      return list(users.map((x) => ({ ...x, password: "e2e-SECRET" })));
    if (path === "/api/player")
      return list([
        {
          id: "p1",
          name: "Sam's phone [Symfonium]",
          userName: "sam",
          client: "Symfonium",
          lastSeen: ago(1),
        },
        {
          id: "p2",
          name: "NavidromeUI [Firefox]",
          userName: "admin",
          client: "NavidromeUI",
          lastSeen: ago(2),
        },
      ]);
    if (path === "/api/missing" && method === "GET") return list(missing);
    if (path === "/api/missing" && method === "DELETE") {
      const ids = u.searchParams.getAll("id");
      missing = missing.filter((x) => !ids.includes(x.id));
      return reply(200, {});
    }
    if (path === "/api/playlist") return list([], 7);
    if (path === "/api/share") return list([], 2);
    const m = /^\/api\/user\/([^/]+)$/.exec(path);
    const user = m ? users.find((x) => x.id === decodeURIComponent(m[1]!)) : undefined;
    if (m && !user) return reply(404, { error: "not found" });
    if (user) {
      if (method === "DELETE") {
        users = users.filter((x) => x !== user);
        return reply(200, {});
      }
      if (method === "PUT") {
        const b = JSON.parse(init.body ?? "{}") as Partial<User>;
        user.isAdmin = b.isAdmin === true;
        return reply(200, user);
      }
      return reply(200, { ...user, password: "e2e-SECRET" });
    }
    return reply(404, { error: "not found" });
  };

  return { fetch: fetchImpl, reset, signIns: () => signIns };
}
