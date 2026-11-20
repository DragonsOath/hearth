import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import {
  ABS_ITEM,
  positionIn,
  audiobookshelfDashboard,
  bookOf,
  AudiobookshelfOperations,
  readAudiobookshelf,
} from "./audiobookshelf";
import { fakeAudiobookshelf } from "./fake-audiobookshelf";

/** Audiobookshelf's health read, panel, and controls, against a stand-in answering like 2.35. */

const BASE = "http://10.0.0.9:13378";
const KEY = "e2e-abs-key";
const service = { id: "abs", name: "Audiobookshelf", localUrl: BASE };
const broker = {
  use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: KEY }),
} as unknown as CredentialBroker;
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const step = (params: PlannedStep["params"]) => ({
  kind: "app-audiobookshelf-control" as const,
  serviceId: "abs",
  requestedBy: "you" as const,
  params,
});

describe("the Audiobookshelf panel", () => {
  it("shows who is listening, libraries in hours and space, and backups", async () => {
    const d = await audiobookshelfDashboard(fakeAudiobookshelf().fetch, BASE, KEY);
    expect(d.version).toBe("2.35.1");
    expect(d.listening).toEqual([
      {
        user: "alex",
        title: "The Hobbit · J.R.R. Tolkien",
        device: "Abs Android · Pixel",
        progressPct: 30,
        itemId: "li-hobbit",
      },
    ]);
    expect(d.libraries[0]).toMatchObject({
      name: "Audiobooks",
      kind: "books",
      items: 312,
      authors: 140,
      hours: 4210,
      sizeGb: 180,
    });
    expect(d.libraries[0]?.recent[0]?.title).toBe("Project Hail Mary · Andy Weir");
    expect(d.libraries[1]?.kind).toBe("podcasts");
    expect(d.backups.count).toBe(1);
  });

  it("warns when the newest backup is over a week old, and refuses a wrong key plainly", async () => {
    const r = await readAudiobookshelf(BASE, KEY, fakeAudiobookshelf().fetch);
    expect(r.issues[0]?.text).toBe("Audiobookshelf has not made a backup in over a week.");
    await expect(readAudiobookshelf(BASE, "wrong", fakeAudiobookshelf().fetch)).rejects.toThrow(
      /refused the API key/,
    );
  });
});

describe("Audiobookshelf controls", () => {
  it("makes a backup and sees it in the list; scans a library", async () => {
    const o = new AudiobookshelfOperations(handle, broker, fakeAudiobookshelf().fetch);
    const b = await o.plan(service, { op: "backup" }, base);
    expect(await o.run(step(b.params), service)).toEqual({
      ok: true,
      result: "Audiobookshelf made a backup now. It shows in its backup list.",
    });
    const s = await o.plan(service, { op: "scan-library", libraryId: "lib-books" }, base);
    expect(s.label).toBe("Scan the Audiobooks library in Audiobookshelf for new and changed books");
    expect(await o.run(step(s.params), service)).toEqual({
      ok: true,
      result: "Audiobookshelf is scanning Audiobooks.",
    });
  });

  it("takes a book out of Continue listening (its progress kept), read back", async () => {
    const fake = fakeAudiobookshelf();
    const o = new AudiobookshelfOperations(handle, broker, fake.fetch);
    const p = await o.plan(service, { op: "continue-remove", itemId: "li-hobbit" }, base);
    expect(p.label).toMatch(/out of Continue listening in Audiobookshelf/);
    expect(await o.run(step(p.params), service)).toEqual({
      ok: true,
      result: "Taken out, read back: it's no longer in Continue listening.",
    });
    await expect(
      o.plan(service, { op: "continue-remove", itemId: "li-hobbit" }, base),
    ).rejects.toThrow(/isn't in Continue listening/);
  });

  it("scans every library at once, for the panel's Scan libraries button", async () => {
    const o = new AudiobookshelfOperations(handle, broker, fakeAudiobookshelf().fetch);
    const s = await o.plan(service, { op: "scan-all" }, base);
    expect(s.label).toBe("Scan all 2 libraries in Audiobookshelf for new and changed books");
    expect(await o.run(step(s.params), service)).toEqual({
      ok: true,
      result: "Audiobookshelf is scanning all 2 libraries; new books show up as it finds them.",
    });
  });
});

describe("bookOf", () => {
  it("a book's details in plain words, its description without the publisher's HTML", () => {
    const b = bookOf({
      id: "li_abc123",
      addedAt: Date.parse("2026-10-17T00:00:00Z"),
      media: {
        coverPath: "/books/cover.jpg",
        duration: 3_600 * 20.25,
        metadata: {
          title: "He Who Fights with Monsters 13",
          authorName: "Travis Deverell",
          narratorName: "Heath Miller",
          seriesName: "He Who Fights with Monsters #13",
          publishedYear: "2025",
          genres: ["LitRPG", "Fantasy"],
          description: "<p>Jason&nbsp;returns &amp; the <b>stakes</b> rise.</p>",
        },
      },
    });
    expect(b).toMatchObject({
      id: "li_abc123",
      name: "He Who Fights with Monsters 13",
      author: "Travis Deverell",
      narrator: "Heath Miller",
      hours: 20.3,
      cover: true,
      description: "Jason returns & the stakes rise.",
    });
    expect(bookOf({}).cover).toBeUndefined();
    expect(ABS_ITEM.test("../etc")).toBe(false);
  });
});

describe("now listening and shelves", () => {
  it("where you are: the chapter, how far into it, and the book overall", () => {
    const at = positionIn(
      {
        media: {
          chapters: [
            { start: 0, end: 600, title: "One" },
            { start: 600, end: 1800, title: "Two" },
          ],
        },
      },
      900,
      1800,
    );
    expect(at).toMatchObject({
      positionSec: 900,
      progressPct: 50,
      chapter: { title: "Two", number: 2, count: 2, pct: 25 },
    });
  });

  it("the panel has the book being played, continue listening, your TBR, and next in series", async () => {
    const fake = fakeAudiobookshelf();
    const d = await audiobookshelfDashboard(fake.fetch, "http://abs.test:13378", "e2e-abs-key");
    expect(d.nowListening).toMatchObject({
      live: true,
      book: { name: "The Hobbit", narrator: "Andy Serkis" },
      positionSec: 10_800,
      progressPct: 30,
      chapter: { title: "Over Hill and Under Hill", number: 3, count: 4, pct: 50 },
    });
    expect(d.shelves?.map((sh) => [sh.kind, sh.label])).toEqual([
      ["continue", "Continue listening"],
      ["tbr", "TBR"],
      ["series", "Next in your series · Audiobooks"],
    ]);
    expect(d.shelves?.[0]?.books[0]?.progressPct).toBe(30);
  });
});

describe("your lists: playlists, collections and the TBR", () => {
  const ops = () => {
    const fake = fakeAudiobookshelf();
    const o = new AudiobookshelfOperations(handle, broker, fake.fetch);
    const lists = async () => (await audiobookshelfDashboard(fake.fetch, BASE, KEY)).lists ?? [];
    const names = async (name: string) =>
      (await lists()).find((l) => l.name === name)?.books.map((b) => b.name);
    return { o, lists, names };
  };

  it("reads each list with its books in order, the TBR first and marked", async () => {
    const { lists } = ops();
    expect((await lists()).map((l) => [l.kind, l.name, l.tbr, l.books.map((b) => b.id)])).toEqual([
      ["collection", "TBR", true, ["li-dune"]],
      ["playlist", "Road trip", false, ["li-hail"]],
    ]);
    const d = await audiobookshelfDashboard(fakeAudiobookshelf().fetch, BASE, KEY);
    expect(d.shelves?.find((s) => s.kind === "tbr")?.list).toEqual({
      id: "col-tbr",
      kind: "collection",
    });
  });

  it("adds a book to the TBR, moves it up, and takes it out, each read back", async () => {
    const { o, names } = ops();
    const add = await o.plan(
      service,
      { op: "list-add", list: "collection:col-tbr", itemId: "li-hobbit" },
      base,
    );
    expect(add.label).toBe('Add The Hobbit to the collection "TBR"');
    expect(add.change?.settings).toEqual([
      { name: "TBR", before: "Dune", after: "Dune, The Hobbit" },
    ]);
    expect(await o.run(step(add.params), service)).toMatchObject({ ok: true });
    expect(await names("TBR")).toEqual(["Dune", "The Hobbit"]);
    const up = await o.plan(
      service,
      { op: "list-order", list: "collection:col-tbr", itemId: "li-hobbit", direction: "up" },
      base,
    );
    expect(await o.run(step(up.params), service)).toMatchObject({ ok: true });
    expect(await names("TBR")).toEqual(["The Hobbit", "Dune"]);
    const out = await o.plan(
      service,
      { op: "list-remove", list: "collection:col-tbr", itemId: "li-dune" },
      base,
    );
    expect(await o.run(step(out.params), service)).toMatchObject({ ok: true });
    expect(await names("TBR")).toEqual(["The Hobbit"]);
    await expect(
      o.plan(service, { op: "list-add", list: "collection:col-tbr", itemId: "li-hobbit" }, base),
    ).rejects.toThrow(/already in/);
  });

  it("makes a playlist with its first book, and moves a book between lists", async () => {
    const { o, names, lists } = ops();
    const make = await o.plan(
      service,
      { op: "list-create", newName: "Up next", libraryId: "lib-books", itemId: "li-hobbit" },
      base,
    );
    expect(make.label).toBe('Make a playlist "Up next" in Audiobooks, starting with The Hobbit');
    expect(await o.run(step(make.params), service)).toMatchObject({ ok: true });
    expect(await names("Up next")).toEqual(["The Hobbit"]);
    const move = await o.plan(
      service,
      {
        op: "list-move",
        list: "playlist:pl-road",
        toList: "collection:col-tbr",
        itemId: "li-hail",
      },
      base,
    );
    // Road trip's last book: Audiobookshelf deletes the playlist, and the plan says so.
    expect(move.label).toMatch(/deletes that playlist/);
    expect(await o.run(step(move.params), service)).toMatchObject({ ok: true });
    expect(await names("TBR")).toEqual(["Dune", "Project Hail Mary"]);
    expect((await lists()).some((l) => l.name === "Road trip")).toBe(false);
  });

  it("refuses a change when the list changed after it was planned", async () => {
    const { o } = ops();
    const a = await o.plan(
      service,
      { op: "list-add", list: "collection:col-tbr", itemId: "li-hobbit" },
      base,
    );
    const b = await o.plan(
      service,
      { op: "list-add", list: "collection:col-tbr", itemId: "li-hail" },
      base,
    );
    expect(await o.run(step(a.params), service)).toMatchObject({ ok: true });
    expect(await o.run(step(b.params), service)).toEqual({
      ok: false,
      result:
        "The list changed in Audiobookshelf since this was planned. Nothing changed; plan it again.",
    });
    await expect(
      o.plan(service, { op: "list-add", list: "nope", itemId: "li-hail" }, base),
    ).rejects.toThrow(/Say which list/);
  });
});
