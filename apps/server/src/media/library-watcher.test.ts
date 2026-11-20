import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MEDIA_ANNOUNCE, type MediaAnnounceSettings } from "@dragon-control/core";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations } from "../db/client";
import type { ReadPart, ServerRead } from "./arrivals";
import type { LibraryItem } from "./sources";
import { GATHER_MS, MediaWatcher, type MediaWatcherDeps } from "./watcher";

// "New in your library" for music, books, comics, games and podcasts: read from the library apps,
// each kind off until a destination wants it, bursts as one message, Ember's line on top.

const T0 = new Date("2026-11-16T15:00:00Z");

const album = (title: string, at: Date, artist = "Fleetwood Mac"): LibraryItem => ({
  itemId: `al-${title}`,
  kind: "album",
  title,
  creators: [artist],
  year: 1977,
  tracks: 11,
  genres: ["Rock"],
  ids: {},
  libraryId: "9",
  library: "Music",
  poster: `/library/metadata/${title}/thumb/1`,
  addedAt: at.toISOString(),
});
const audiobook = (title: string, at: Date): LibraryItem => ({
  itemId: `li_${title.replace(/\W/g, "")}xyz`,
  kind: "audiobook",
  title,
  creators: ["James S. A. Corey"],
  narrators: ["Jefferson Mays"],
  ids: {},
  libraryId: "lib-b",
  library: "Books",
  poster: `/api/items/li_${title.replace(/\W/g, "")}xyz/cover`,
  addedAt: at.toISOString(),
});

interface Sent {
  channelId: string;
  title: string;
  embed: { title?: string; description?: string; author?: { name?: string } };
}

async function setup(write?: (system: string, prompt: string) => Promise<string>) {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  let clock = T0;
  const shelves: { plex: LibraryItem[]; abs: LibraryItem[] } = { plex: [], abs: [] };
  const reads: { serviceId: string; part: ReadPart }[] = [];
  const sent: Sent[] = [];
  const deps: MediaWatcherDeps = {
    servers: async () => [
      { serviceId: "plex", server: "plex", name: "Plex", parts: ["video", "library"] },
      { serviceId: "abs", server: "audiobookshelf", name: "Books", parts: ["library"] },
    ],
    read: async (serviceId, _limit, part = "video"): Promise<ServerRead> => {
      reads.push({ serviceId, part });
      return {
        serviceId,
        server: serviceId === "plex" ? "plex" : "audiobookshelf",
        serverName: serviceId,
        items: part === "library" ? shelves[serviceId as "plex" | "abs"] : [],
      };
    },
    art: async () => ({ bytes: Buffer.from("img"), type: "image/jpeg" }),
    trailer: async () => undefined,
    channels: async () => [
      { id: "friends", name: "Friends" },
      { id: "family", name: "Family" },
    ],
    send: async (channelId, rich, plain) => {
      const embed = (rich.payload.embeds as Sent["embed"][])[0]!;
      sent.push({ channelId, title: plain.title, embed });
      return { ok: true };
    },
    aiName: async () => "Cinder",
    ...(write ? { write } : {}),
    now: () => clock,
    localTime: () => new Date("2026-11-16T15:00:00"),
  };
  const w = new MediaWatcher(handle, deps);
  return {
    w,
    sent,
    reads,
    shelves,
    later: (ms: number) => (clock = new Date(clock.getTime() + ms)),
    now: () => clock,
    settings: (s: Partial<MediaAnnounceSettings>) =>
      w.saveSettings({ ...DEFAULT_MEDIA_ANNOUNCE, ...s }),
  };
}

const allOn = { ...DEFAULT_MEDIA_ANNOUNCE.types, album: true, audiobook: true, game: true };

describe("New in your library: reading the library apps", () => {
  it("nothing is read from them while every library kind is off", async () => {
    const x = await setup();
    await x.w.tick();
    expect(x.reads.filter((r) => r.part === "library")).toEqual([]);
    expect(x.reads.map((r) => r.serviceId)).toEqual(["plex"]); // movies and shows, as before
  });

  it("turning music on for a server read for years announces only what is added from then on", async () => {
    const x = await setup();
    x.shelves.plex = [album("Rumours", new Date("2020-01-01")), album("Tusk", T0)];
    await x.w.tick(); // movies baseline; music still off
    await x.settings({ types: allOn });
    await x.w.tick(); // music's own baseline: the albums already there are never announced
    x.later(GATHER_MS + 1000);
    await x.w.tick();
    expect(x.sent).toEqual([]);
    x.shelves.plex = [...x.shelves.plex, album("Mirage", x.now())];
    await x.w.tick();
    expect(x.sent).toEqual([]); // waits a little for the rest of a burst
    x.later(GATHER_MS + 1000);
    await x.w.tick();
    expect(x.sent.map((s) => [s.channelId, s.embed.title])).toEqual([
      ["friends", "Mirage by Fleetwood Mac (1977)"],
      ["family", "Mirage by Fleetwood Mac (1977)"],
    ]);
    expect(x.sent[0]!.embed.author?.name).toBe("New music");
    // Ember's line leads the card, under the name she goes by here.
    expect(x.sent[0]!.embed.description).toMatch(/^\*\*Cinder:\*\* /);
  });

  it("an addition from days ago is not news", async () => {
    const x = await setup();
    await x.settings({ types: allOn });
    await x.w.tick();
    x.shelves.abs = [audiobook("Old Shelf Find", new Date(T0.getTime() - 5 * 24 * 3600_000))];
    await x.w.tick();
    x.later(GATHER_MS + 1000);
    await x.w.tick();
    expect(x.sent).toEqual([]);
  });
});

describe("New in your library: bursts and destinations", () => {
  it("a burst of albums is one message; an audiobook beside it is its own card", async () => {
    const x = await setup();
    await x.settings({ types: allOn, destinations: { family: { types: { album: false } } } });
    await x.w.tick();
    x.shelves.plex = ["A", "B", "C"].map((t) => album(t, x.now()));
    x.shelves.abs = [audiobook("Leviathan Wakes", x.now())];
    await x.w.tick();
    x.later(GATHER_MS + 1000);
    await x.w.tick();
    const friends = x.sent.filter((s) => s.channelId === "friends").map((s) => s.embed.title);
    // The audiobook is not burst-prone: it went out at once; the albums waited for each other.
    expect(friends).toEqual(["Leviathan Wakes by James S. A. Corey", "3 new albums"]);
    // The family channel said no to music: it gets the audiobook only.
    expect(x.sent.filter((s) => s.channelId === "family").map((s) => s.embed.title)).toEqual([
      "Leviathan Wakes by James S. A. Corey",
    ]);
    const batch = x.sent.find((s) => s.embed.title === "3 new albums")!;
    expect(batch.embed.author?.name).toBe("New music");
    expect(batch.embed.description).toContain("C by Fleetwood Mac");
  });

  it("each destination has its own tone: Off sends the card without a line", async () => {
    const x = await setup();
    await x.settings({ types: allOn, destinations: { family: { tone: "off" } } });
    await x.w.tick();
    x.shelves.abs = [audiobook("Caliban's War", x.now())];
    await x.w.tick();
    x.later(GATHER_MS + 1000);
    await x.w.tick();
    const by = Object.fromEntries(x.sent.map((s) => [s.channelId, s.embed.description ?? ""]));
    expect(by.friends).toMatch(/^\*\*Cinder:\*\* /);
    expect(by.family).not.toContain("Cinder:");
  });

  it("a destination never gets the same line twice in a row", async () => {
    const x = await setup();
    await x.settings({ types: allOn, destinations: { family: { types: { audiobook: false } } } });
    await x.w.tick();
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) {
      x.shelves.abs = [...x.shelves.abs, audiobook(`Book ${i}`, x.now())];
      await x.w.tick();
      x.later(GATHER_MS + 1000);
      await x.w.tick();
      const d = x.sent.at(-1)!.embed.description ?? "";
      lines.push(/^\*\*Cinder:\*\* (.+?)(\n|$)/.exec(d)?.[1] ?? "");
    }
    expect(x.sent).toHaveLength(8);
    for (let i = 1; i < lines.length; i++) expect(lines[i]).not.toBe(lines[i - 1]);
  });

  it("the preview and test send show the line in that destination's tone", async () => {
    const x = await setup();
    await x.settings({ types: allOn });
    await x.w.tick();
    x.shelves.abs = [audiobook("Abaddon's Gate", x.now())];
    await x.w.tick();
    const key = (await x.w.arrivals.samples("audiobook"))[0]!.key;
    const s = { ...(await x.w.settings()), destinations: { family: { tone: "off" as const } } };
    expect((await x.w.compose(key, s, true, "friends")).line?.aiName).toBe("Cinder");
    expect((await x.w.compose(key, s, true, "family")).line).toBeUndefined();
  });
});

describe("Let Ember write it", () => {
  const on = (x: Awaited<ReturnType<typeof setup>>, extra: Partial<MediaAnnounceSettings> = {}) =>
    x.settings({
      types: allOn,
      emberWrites: true,
      destinations: { family: { types: { audiobook: false } } },
      ...extra,
    });
  const arrive = async (x: Awaited<ReturnType<typeof setup>>, item: LibraryItem) => {
    x.shelves.abs = [...x.shelves.abs, item];
    await x.w.tick();
  };
  const lineOf = (d?: string) => /^\*\*Cinder:\*\* (.+?)(\n|$)/.exec(d ?? "")?.[1];

  it("her own line goes on the card, checked and tidied", async () => {
    const asked: string[] = [];
    const x = await setup(async (system, prompt) => {
      asked.push(`${system}\n${prompt}`);
      return '"A long voyage begins tonight — settle in"';
    });
    await on(x);
    await x.w.tick();
    await arrive(x, audiobook("Leviathan Wakes", x.now()));
    expect(lineOf(x.sent[0]?.embed.description)).toBe("A long voyage begins tonight, settle in.");
    expect(asked[0]).toContain("Leviathan Wakes by James S. A. Corey");
    expect(asked[0]).toContain("Never mention who asked for it");
  });

  it("a line that fails the check, or no answer, falls back to the written set", async () => {
    const x = await setup(async () => "Somebody's guilty pleasure, finally here.");
    await on(x);
    await x.w.tick();
    await arrive(x, audiobook("Caliban's War", x.now()));
    const line = lineOf(x.sent[0]?.embed.description);
    expect(line).toBeTruthy();
    expect(line).not.toContain("guilty pleasure");
  });

  it("only so many a day; the rest come from the written set", async () => {
    let calls = 0;
    const x = await setup(async () => `Fresh off the shelf, number ${++calls}.`);
    await on(x, { emberWritesPerDay: 2 });
    await x.w.tick();
    for (let i = 0; i < 4; i++) await arrive(x, audiobook(`Book ${i}`, x.now()));
    expect(calls).toBe(2);
    expect(x.sent).toHaveLength(4);
    expect(
      x.sent.map((m) => lineOf(m.embed.description)).filter((l) => l?.includes("number")),
    ).toHaveLength(2);
  });

  it("sensitive titles never go to her, and the preview never asks her", async () => {
    let calls = 0;
    const x = await setup(async () => {
      calls++;
      return "Ready when you are.";
    });
    await on(x);
    await x.w.tick();
    await arrive(x, { ...audiobook("Atomic Habits", x.now()), genres: ["Self-Help"] });
    expect(calls).toBe(0);
    expect(x.sent).toHaveLength(1);
    await arrive(x, audiobook("Abaddon's Gate", x.now()));
    const before = calls;
    const key = (await x.w.arrivals.samples("audiobook"))[0]!.key;
    await x.w.compose(key, await x.w.settings(), false, "friends");
    expect(calls).toBe(before);
  });
});
