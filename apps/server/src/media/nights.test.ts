import path from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations } from "../db/client";
import type { ServerRead } from "./arrivals";
import { MovieNights, timeIn } from "./nights";
import type { LibraryItem } from "./sources";
import { MediaWatcher } from "./watcher";

const movie = (title: string, tmdb: string): LibraryItem => ({
  itemId: `j-${tmdb}`,
  kind: "movie",
  title,
  year: 2026,
  ids: { tmdb },
  libraryId: "1",
  library: "Movies",
  overview: `${title} is a film.`,
  genres: ["Drama"],
  runtimeMin: 110,
  poster: `/Items/${tmdb}/Images/Primary`,
  backdrop: `/Items/${tmdb}/Images/Backdrop`,
  addedAt: new Date().toISOString(),
});

interface Sent {
  channelId: string;
  title: string;
  author?: string;
  fields: string;
  description: string;
  edit?: string;
  event: string;
  buttons?: string;
  picture?: string;
  files: string;
}

async function setup() {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  let clock = new Date("2026-10-30T12:00:00Z");
  const library = [movie("Quiet Harbor", "700"), movie("Long Road", "701")];
  const watcher = new MediaWatcher(handle, {
    servers: async () => [
      { serviceId: "jf", server: "jellyfin", name: "Jellyfin", parts: ["video"] },
    ],
    read: async (serviceId): Promise<ServerRead> => ({
      serviceId,
      server: "jellyfin",
      serverName: "Jellyfin",
      items: library,
    }),
    art: async () => ({ bytes: Buffer.from("img"), type: "image/jpeg" }),
    trailer: async () => undefined,
    channels: async () => [],
    send: async () => ({ ok: true }),
    now: () => clock,
  });
  await watcher.tick(); // The library is known (the baseline), so its titles can be picked.
  const sent: Sent[] = [];
  let n = 0;
  let deleted = false;
  const nights = new MovieNights(handle, {
    watcher,
    channels: async () => [
      { id: "discord-friends", name: "Friends" },
      { id: "ntfy-family", name: "Family" },
    ],
    send: async (channelId, rich, plain, opts) => {
      const embed = (rich.payload.embeds as Record<string, unknown>[])[0]!;
      sent.push({
        channelId,
        title: plain.title,
        author: (embed.author as { name: string } | undefined)?.name,
        fields: JSON.stringify(embed.fields ?? []),
        description: String(embed.description ?? ""),
        ...(opts.edit ? { edit: opts.edit } : {}),
        event: opts.event,
        ...(rich.components ? { buttons: JSON.stringify(rich.components) } : {}),
        picture: embed.image
          ? `wide ${(embed.image as { url: string }).url}`
          : embed.thumbnail
            ? `beside ${(embed.thumbnail as { url: string }).url}`
            : "none",
        files: rich.files.map((f) => f.name).join(","),
      });
      // Discord gives the message an id; the text destination does not.
      if (channelId !== "discord-friends") return { ok: true };
      if (opts.edit && deleted) return { ok: true, messageId: `m${++n}` };
      return { ok: true, messageId: opts.edit ?? `m${++n}` };
    },
    join: async () => [
      {
        server: "jellyfin",
        name: "Jellyfin",
        url: "https://watch.example.com/web/#/details?id=j-700",
      },
    ],
    now: () => clock,
  });
  const key = (await watcher.arrivals.search("movie", "quiet"))[0]!.key;
  return {
    nights,
    sent,
    key,
    tick: (ms: number) => (clock = new Date(clock.getTime() + ms)),
    deleteInDiscord: () => (deleted = true),
  };
}

const base = (key: string) => ({
  key,
  startsAt: "2026-10-31T03:00:00Z", // Friday 8 PM in Los Angeles
  timeZone: "America/Los_Angeles",
  spots: 3,
  note: "Snacks at 7:45.",
  reminders: ["day", "hour", "start"] as ("day" | "hour" | "start")[],
  channels: ["discord-friends", "ntfy-family"],
});

describe("movie nights", () => {
  it("finds library titles by the words typed", async () => {
    const { nights: _n, key } = await setup();
    expect(key).toBe("movie:tmdb:700");
  });

  it("posts the invitation once per destination, then edits it in place on Discord", async () => {
    const { nights, sent, key } = await setup();
    const night = await nights.create(base(key));
    expect(sent.map((s) => s.channelId)).toEqual(["discord-friends", "ntfy-family"]);
    expect(sent[0]!.description).toContain("<t:1793415600:F>");
    expect(sent[0]!.fields).toContain("Nobody has said they're coming yet · 3 spots left");
    expect(sent[0]!.fields).toContain("SyncPlay: join **Movie night: Quiet Harbor**");
    expect(sent[1]!.title).toBe("Movie night: Quiet Harbor (2026)");

    // A guest: Discord's message is edited; the text destination is not pinged again.
    sent.length = 0;
    const withGuest = await nights.guests(night.id, { add: "Sam" });
    expect(withGuest.guests).toEqual(["Sam"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channelId: "discord-friends", edit: "m1" });
    expect(sent[0]!.fields).toContain("1 going · 2 spots left");
    await expect(nights.guests(night.id, { add: "sam" })).rejects.toThrow("already on the list");

    // A new time reaches everyone; cancelling too, in the same Discord message.
    sent.length = 0;
    await nights.update(night.id, { startsAt: "2026-11-01T03:00:00Z" });
    expect(sent.map((s) => [s.channelId, s.edit])).toEqual([
      ["discord-friends", "m1"],
      ["ntfy-family", undefined],
    ]);
    sent.length = 0;
    const off = await nights.cancel(night.id);
    expect(off.status).toBe("cancelled");
    expect(sent[0]).toMatchObject({ edit: "m1", author: "Movie night cancelled" });
    expect(sent[1]!.title).toBe("Movie night cancelled: Quiet Harbor (2026)");
  });

  it("refuses alert channels, past times, and titles not in the library", async () => {
    const { nights, key } = await setup();
    await expect(nights.create({ ...base(key), channels: ["email"] })).rejects.toThrow(
      "the destinations chosen for New in your library",
    );
    await expect(nights.create({ ...base(key), startsAt: "2026-10-29T00:00:00Z" })).rejects.toThrow(
      "has not passed",
    );
    await expect(nights.create({ ...base("movie:tmdb:999") })).rejects.toThrow(
      "not in your libraries",
    );
  });

  it("sends each reminder once, only the latest due, and is done after the night", async () => {
    // Planned two days ahead, then nobody checks until an hour before: only the hour one goes.
    {
      const early = await setup();
      await early.nights.create({ ...base(early.key), startsAt: "2026-11-01T12:00:00Z" });
      early.sent.length = 0;
      early.tick(47.5 * 60 * 60_000);
      await early.nights.tick();
      expect(early.sent.map((s) => s.author)).toEqual([
        "Starting in an hour",
        "Starting in an hour",
      ]);
    }
    const { nights, sent, key, tick } = await setup();
    const night = await nights.create(base(key));
    sent.length = 0;
    // Planned 15 hours ahead: "a day before" has gone by already, so it never goes out.
    await nights.tick();
    expect(sent).toHaveLength(0);
    tick(14.5 * 60 * 60_000); // half an hour before
    await nights.tick();
    await nights.tick();
    expect(sent.map((s) => s.author)).toEqual(["Starting in an hour", "Starting in an hour"]);
    expect(sent.every((s) => s.event === "movie-night-reminder" && !s.edit)).toBe(true);
    tick(30 * 60_000);
    sent.length = 0;
    await nights.tick();
    expect(sent.map((s) => s.author)).toEqual(["Starting now", "Starting now"]);
    tick(5 * 60 * 60_000);
    await nights.tick();
    expect((await nights.get(night.id)).status).toBe("done");
  });

  it("shows the host's note in a bold quote, and their own Where to watch in place of the links", async () => {
    const { nights, sent, key } = await setup();
    const night = await nights.create({
      ...base(key),
      watch: "Come over, or [watch on Plex](https://app.plex.tv/desktop/)",
    });
    expect(sent[0]!.description).toContain("> **Snacks at 7:45.**");
    expect(sent[0]!.fields).toContain("Come over, or [watch on Plex]");
    expect(sent[0]!.fields).not.toContain("SyncPlay");
    // Emptied again: Hearth's own links come back.
    sent.length = 0;
    await nights.update(night.id, { watch: "" });
    expect(sent[0]!.fields).toContain("SyncPlay: join");
  });

  it("posts in the style chosen, and changing it updates the invitation in place", async () => {
    const { nights, sent, key } = await setup();
    // Not chosen: Cinematic, the poster beside the details.
    const plain = await nights.create(base(key));
    expect(plain.look).toBe("cinematic");
    expect(sent[0]!.picture).toBe("beside attachment://poster.jpg");
    sent.length = 0;
    // Streaming: the wide picture under the invitation.
    const wide = await nights.create({ ...base(key), look: "streaming" });
    expect(wide.look).toBe("streaming");
    expect(sent[0]!.picture).toBe("wide attachment://backdrop.jpg");
    // Changed later: Discord's message is edited, and text destinations are not pinged for it.
    sent.length = 0;
    const back = await nights.update(wide.id, { look: "compact" });
    expect(back.look).toBe("compact");
    expect(sent.map((x) => [x.channelId, x.picture])).toEqual([
      ["discord-friends", "beside attachment://poster.jpg"],
    ]);
  });

  it("Banner: one picture Hearth makes leads the post, and the card under it skips the title", async () => {
    const { nights, sent, key } = await setup();
    const night = await nights.create({ ...base(key), look: "banner" });
    expect(night.look).toBe("banner");
    expect(sent[0]!.files).toBe("banner.png");
    expect(sent[0]!.picture).toBe("none");
    expect(sent[0]!.author).toBeUndefined();
    expect(sent[0]!.fields).toContain("Who's coming");
    // A new guest makes a new banner too (spots left is on it).
    sent.length = 0;
    await nights.guests(night.id, { add: "Sam" });
    expect(sent[0]).toMatchObject({ edit: "m1", files: "banner.png" });
  });

  it("adds a room code later: Discord is edited and text destinations hear about it", async () => {
    const { nights, sent, key } = await setup();
    const night = await nights.create({
      ...base(key),
      watch: "In Plezy, open Watch Together, choose Join Room and enter the room code.",
    });
    expect(sent[0]!.fields).not.toContain("Room code");
    sent.length = 0;
    const withCode = await nights.update(night.id, { code: " 4N7-54F " });
    expect(withCode.code).toBe("4N7-54F");
    expect(sent.map((s) => [s.channelId, s.edit])).toEqual([
      ["discord-friends", "m1"],
      ["ntfy-family", undefined],
    ]);
    expect(sent[0]!.fields).toContain("Room code: **4N7-54F**");
    // The same code again is no news for the text destination.
    sent.length = 0;
    await nights.update(night.id, { code: "4N7-54F" });
    expect(sent.map((s) => s.channelId)).toEqual(["discord-friends"]);
  });

  it("links #name to a saved Discord channel in the note", async () => {
    const { nights, sent, key } = await setup();
    await expect(nights.saveChannelLinks([{ name: "chat", link: "not a link" }])).rejects.toThrow(
      "Copy Link",
    );
    const saved = await nights.saveChannelLinks([
      { name: "#Movie Chat", link: "https://discord.com/channels/111111/1565080201413795884" },
    ]);
    expect(saved).toEqual([{ name: "movie-chat", id: "1565080201413795884" }]);
    await nights.create({ ...base(key), note: "Talk in #movie-chat during the movie" });
    expect(sent[0]!.description).toContain("> **Talk in <#1565080201413795884> during the movie**");
  });

  it("friends answer with the buttons on your bot's post: in, full, and out", async () => {
    const { nights, sent, key } = await setup();
    const night = await nights.create({ ...base(key), spots: 1 });
    sent.length = 0;
    expect(await nights.rsvp(`mn:in:${night.id}`, "Sam")).toEqual({
      text: "You're in for Quiet Harbor. See you there!",
    });
    expect((await nights.get(night.id)).guests).toEqual(["Sam"]);
    // The invitation is edited on Discord to say so.
    expect(sent[0]).toMatchObject({ channelId: "discord-friends", edit: "m1" });
    expect(sent[0]!.fields).toContain("1 going · full");
    expect(sent[0]!.buttons).toContain(`"custom_id":"mn:in:${night.id}"`);
    expect((await nights.rsvp(`mn:in:${night.id}`, "sam")).text).toMatch(/already on the list/);
    expect((await nights.rsvp(`mn:in:${night.id}`, "Alex")).text).toMatch(/full/);
    expect((await nights.rsvp(`mn:out:${night.id}`, "Sam")).text).toMatch(/off the list/);
    expect((await nights.get(night.id)).guests).toEqual([]);
    expect((await nights.rsvp("someone-else:button", "Sam")).text).toMatch(/not Hearth's/);
    sent.length = 0;
    await nights.cancel(night.id);
    // Cancelled: the buttons come off the post.
    expect(sent[0]!.buttons).toBe("[]");
    expect((await nights.rsvp(`mn:in:${night.id}`, "Sam")).text).toMatch(/cancelled/);
  });

  it("keeps the host's saved places, one name each", async () => {
    const { nights } = await setup();
    expect(await nights.places()).toEqual([]);
    const saved = await nights.savePlaces([
      { name: " Watch party ", text: "Join the room with the code." },
      { name: "Empty", text: " " },
    ]);
    expect(saved).toEqual([{ name: "Watch party", text: "Join the room with the code." }]);
    await expect(
      nights.savePlaces([
        { name: "Couch", text: "Come over." },
        { name: "couch", text: "Again." },
      ]),
    ).rejects.toThrow("already a place called couch");
    expect(await nights.places()).toEqual(saved);
  });

  it("writes the time in the host's time zone for text destinations", () => {
    expect(timeIn("2026-10-31T03:00:00Z", "America/Los_Angeles")).toBe(
      "Friday, Oct 30, 8:00 PM PDT",
    );
  });
});
