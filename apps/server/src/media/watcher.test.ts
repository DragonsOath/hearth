import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEDIA_ANNOUNCE,
  HERALD_ICON,
  type MediaAnnounceSettings,
} from "@dragon-control/core";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations } from "../db/client";
import type { ServerRead } from "./arrivals";
import type { LibraryItem } from "./sources";
import { MediaWatcher, type MediaWatcherDeps } from "./watcher";

const movie = (title: string, tmdb: string, extra: Partial<LibraryItem> = {}): LibraryItem => ({
  itemId: `p-${tmdb}`,
  kind: "movie",
  title,
  year: 2026,
  ids: { tmdb },
  libraryId: "1",
  library: "Movies",
  overview: `${title} is a film.`,
  genres: ["Drama"],
  runtimeMin: 94,
  poster: `/library/metadata/${tmdb}/thumb/1`,
  addedAt: new Date().toISOString(),
  ...extra,
});
const episode = (show: string, s: number, e: number): LibraryItem => ({
  itemId: `${show}${s}${e}`,
  kind: "episode",
  title: `Ep ${e}`,
  show,
  showIds: { tvdb: show },
  season: s,
  episode: e,
  ids: {},
  libraryId: "2",
  library: "TV",
  addedAt: new Date(Date.now() + s * 100 + e).toISOString(),
});

interface Sent {
  channelId: string;
  payload: Record<string, unknown>;
  files: string[];
  title: string;
  test?: boolean;
}

async function setup(
  opts: { fail?: (n: number) => { ok: false; error: string; retryAfterMs?: number } | null } = {},
) {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  let library: LibraryItem[] = [movie("Old Favorite", "1")];
  let clock = new Date("2026-10-27T15:00:00Z");
  let local = new Date("2026-10-27T15:00:00");
  const sent: Sent[] = [];
  let calls = 0;
  const deps: MediaWatcherDeps = {
    servers: async () => [
      { serviceId: "svc-plex", server: "plex", name: "Plex", parts: ["video"] },
    ],
    read: async (serviceId): Promise<ServerRead> => ({
      serviceId,
      server: "plex",
      serverName: "Plex",
      items: library,
    }),
    art: async () => ({ bytes: Buffer.from("img"), type: "image/jpeg" }),
    trailer: async (tmdb) =>
      tmdb === "700" ? "https://www.youtube.com/watch?v=abcdef1" : undefined,
    channels: async () => [{ id: "discord-friends", name: "New in the Vault" }],
    send: async (channelId, rich, plain, o) => {
      calls++;
      const f = opts.fail?.(calls);
      if (f) return f;
      sent.push({
        channelId,
        payload: rich.payload,
        files: rich.files.map((x) => x.name),
        title: plain.title,
        ...(o?.test ? { test: true } : {}),
      });
      return { ok: true };
    },
    now: () => clock,
    localTime: () => local,
  };
  const w = new MediaWatcher(handle, deps);
  return {
    w,
    handle,
    sent,
    deps,
    setLibrary: (l: LibraryItem[]) => (library = l),
    addLibrary: (...l: LibraryItem[]) => (library = [...library, ...l]),
    at: (iso: string, localIso: string) => {
      clock = new Date(iso);
      local = new Date(localIso);
    },
    settings: async (s: Partial<MediaAnnounceSettings>) =>
      w.saveSettings({ ...DEFAULT_MEDIA_ANNOUNCE, ...s }),
  };
}

describe("media announcements: from library arrival to a destination", () => {
  it("baseline first, then one announcement per new movie with its poster and a verified trailer, never twice", async () => {
    const x = await setup();
    await x.w.tick();
    expect(x.sent).toEqual([]);
    x.addLibrary(movie("Quiet Harbor", "700"));
    await x.w.tick();
    expect(x.sent).toHaveLength(1);
    const msg = x.sent[0]!;
    expect(msg.channelId).toBe("discord-friends");
    expect(msg.files).toEqual(["poster.jpg"]);
    const embed = (msg.payload.embeds as Record<string, unknown>[])[0]!;
    expect(embed).toMatchObject({
      author: { name: expect.stringMatching(/^Ember: /), icon_url: HERALD_ICON },
      title: "Just added to the library: Quiet Harbor (2026)",
      thumbnail: { url: "attachment://poster.jpg" },
    });
    expect(String(embed.description)).toContain(
      "[Watch trailer](https://www.youtube.com/watch?v=abcdef1)",
    );
    expect(String(embed.description)).toContain("Drama · 1h 34m");
    // Nothing about the servers' insides: no ids, addresses, paths or keys.
    const all = JSON.stringify(msg.payload);
    for (const secret of ["svc-plex", "/library/metadata", "http://", "token", "Movies"])
      expect(all).not.toContain(secret);
    // Rescans and restarts: nothing more.
    await x.w.tick();
    const again = new MediaWatcher(x.handle, x.deps);
    await again.tick();
    expect(x.sent).toHaveLength(1);
    // No trailer known: the line is simply left out.
    x.addLibrary(movie("No Trailer Film", "800"));
    await x.w.tick();
    expect(JSON.stringify(x.sent[1]!.payload)).not.toContain("Watch trailer");
  });

  it("follows the rules: episodes off by default, chosen libraries, exclusions", async () => {
    const x = await setup();
    x.setLibrary([episode("Long Show", 1, 1)]);
    await x.w.tick();
    x.addLibrary(
      episode("Long Show", 1, 2),
      movie("Kids Movie", "900", { title: "Sing Along Kids" }),
    );
    await x.settings({ exclude: ["kids"] });
    await x.w.tick();
    expect(x.sent).toEqual([]);
    // A new series is announced (series are on); only from the chosen library.
    await x.settings({ libraries: ["svc-plex/2"] });
    x.addLibrary(episode("The Expanse", 1, 1), movie("Elsewhere", "901"));
    await x.w.tick();
    expect(x.sent.map((s) => s.title)).toEqual(["New series: The Expanse"]);
  });

  it("retries a failure with growing waits, does not count rate limits, stops after five, and can be retried", async () => {
    let failing = true;
    const x = await setup({
      fail: (n) =>
        n === 1
          ? { ok: false, error: "slow down", retryAfterMs: 2000 }
          : failing
            ? { ok: false, error: "Discord refused the message (500)." }
            : null,
    });
    await x.w.tick();
    x.addLibrary(movie("Quiet Harbor", "700"));
    await x.w.tick();
    let h = await x.w.history();
    expect(h[0]).toMatchObject({ status: "pending", attempts: 0, error: "slow down" });
    for (let i = 0; i < 6; i++) {
      x.at(new Date(Date.now() + (i + 1) * 3 * 3600_000).toISOString(), "2026-10-27T15:00:00");
      await x.w.flush();
    }
    h = await x.w.history();
    expect(h[0]).toMatchObject({ status: "failed", attempts: 5 });
    expect(h[0]!.error).toMatch(/refused/);
    failing = false;
    await x.w.retry(h[0]!.key, "discord-friends");
    expect((await x.w.history())[0]).toMatchObject({ status: "sent" });
    expect(x.sent).toHaveLength(1);
  });

  it("a daily roundup sends one message at its hour; quiet hours hold until morning", async () => {
    const x = await setup();
    await x.w.tick();
    await x.settings({ mode: "digest", digestHour: 18 });
    x.addLibrary(movie("Quiet Harbor", "700"), movie("Elsewhere", "901"));
    await x.w.tick();
    expect(x.sent).toEqual([]);
    x.at("2026-10-28T02:00:00Z", "2026-10-27T18:30:00");
    await x.w.flush();
    expect(x.sent).toHaveLength(1);
    expect(x.sent[0]!.title).toBe("2 new in the library");

    const y = await setup();
    await y.w.tick();
    await y.settings({ quietHours: true });
    y.at("2026-10-28T07:00:00Z", "2026-10-27T23:30:00");
    y.addLibrary(movie("Night Arrival", "702"));
    await y.w.tick();
    expect(y.sent).toEqual([]);
    y.at("2026-10-28T15:05:00Z", "2026-10-28T07:05:00");
    await y.w.flush();
    expect(y.sent.map((s) => s.title)).toEqual(["Just added to the library: Night Arrival (2026)"]);
  });

  it("a test goes to one destination, clearly marked, and records nothing as announced", async () => {
    const x = await setup();
    await x.w.tick();
    const [sample] = await x.w.arrivals.samples("movie");
    const r = await x.w.test("discord-friends", sample!.key);
    expect(r).toEqual({ ok: true });
    expect(x.sent[0]).toMatchObject({
      test: true,
      title: "[Test] Just added to the library: Old Favorite (2026)",
    });
    expect(String(x.sent[0]!.payload.content)).toMatch(/Test announcement/);
    expect(await x.w.history()).toEqual([]);
  });
});

describe("pictures for a post", () => {
  it("tries each server that has the picture, so one that is down or gone does not lose it", async () => {
    const handle = openDatabase(":memory:");
    await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
    const asked: string[] = [];
    const watcher = new MediaWatcher(handle, {
      servers: async () => [],
      read: async () => {
        throw new Error("not used");
      },
      art: async (serviceId) => {
        asked.push(serviceId);
        if (serviceId === "gone") throw new Error("not found");
        return { bytes: Buffer.from("img"), type: "image/jpeg" };
      },
      trailer: async () => undefined,
      channels: async () => [],
      send: async () => ({ ok: true }),
    });
    const where = [
      { serviceId: "gone", poster: "/p", backdrop: "/b" },
      { serviceId: "here", poster: "/p", backdrop: "/b" },
    ];
    const arrival = { kind: "movie", where } as unknown as Parameters<typeof watcher.files>[0];
    const s: MediaAnnounceSettings = {
      ...DEFAULT_MEDIA_ANNOUNCE,
      looks: { ...DEFAULT_MEDIA_ANNOUNCE.looks, movie: { template: "streaming", heading: "New" } },
    };
    const got = await watcher.files(arrival, s);
    expect(got.backdrop).toBe("backdrop.jpg");
    expect(asked).toEqual(["gone", "here"]);
  });

  it("the Banner style sends one picture Hearth drew, from the backdrop and the poster", async () => {
    const handle = openDatabase(":memory:");
    await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
    const asked: string[] = [];
    const watcher = new MediaWatcher(handle, {
      servers: async () => [],
      read: async () => {
        throw new Error("not used");
      },
      art: async (_id, _path, shape) => {
        asked.push(shape);
        return { bytes: Buffer.from("img"), type: "image/jpeg" };
      },
      trailer: async () => undefined,
      channels: async () => [],
      send: async () => ({ ok: true }),
    });
    const arrival = {
      kind: "movie",
      title: "Night of the Living Dead",
      year: 1968,
      ids: {},
      genres: ["Horror"],
      where: [{ serviceId: "here", server: "plex", poster: "/p", backdrop: "/b" }],
    } as unknown as Parameters<typeof watcher.files>[0];
    const s: MediaAnnounceSettings = {
      ...DEFAULT_MEDIA_ANNOUNCE,
      looks: { ...DEFAULT_MEDIA_ANNOUNCE.looks, movie: { template: "banner", heading: "New" } },
    };
    const got = await watcher.files(arrival, s);
    expect(asked).toEqual(["backdrop", "poster"]);
    expect(got.banner).toBe("banner.png");
    expect(got.files.map((f) => f.name)).toEqual(["banner.png"]);
    expect(got.files[0]!.bytes.subarray(1, 4).toString()).toBe("PNG");
  });
});
