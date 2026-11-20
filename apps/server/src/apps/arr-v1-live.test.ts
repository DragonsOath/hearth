import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeArrV1 } from "./fake-arr-v1";
import { libraryDashboard, LibraryOperations } from "./arr-v1-live";

/** Lidarr and Chaptarr's shared panel and controls, against stand-ins answering their v1 API. */

const KEY = "e2e-lib-key";
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
const step = (
  kind: "app-lidarr-control" | "app-chaptarr-control",
  params: PlannedStep["params"],
) => ({
  kind,
  serviceId: "lib",
  requestedBy: "you" as const,
  params,
});

describe("the library panel", () => {
  it("reads Lidarr in its own words: stuck first, missing, coming out", async () => {
    const d = await libraryDashboard(
      "lidarr",
      fakeArrV1("lidarr").fetch,
      "http://10.0.0.9:8686",
      KEY,
    );
    expect(d.words).toEqual({ who: "artist", what: "album", whats: "albums" });
    expect(d.totals).toEqual({ people: 3, monitored: 2, missing: 1, queue: 2, stuck: 1 });
    expect(d.queue[0]).toMatchObject({
      title: "Radiohead - OK Computer",
      release: "Radiohead-OK_Computer-1997-FLAC",
      stuck: true,
      problem: "No files found are eligible for import",
      sizeBytes: 100,
      via: "SABnzbd",
      indexer: "UsenetOne",
    });
    // History in plain words, with the quality split out.
    expect(d.recent[0]).toMatchObject({
      event: "imported",
      title: "Bjork - Post",
      quality: "FLAC",
      failed: false,
    });
    expect(d.missing[0]).toMatchObject({ id: 31, title: "Radiohead - Kid A" });
    expect(d.upcoming[0]?.title).toBe("Bjork - New Album");
  });

  it("reads Chaptarr as authors and books", async () => {
    const d = await libraryDashboard(
      "chaptarr",
      fakeArrV1("chaptarr").fetch,
      "http://10.0.0.9:8789",
      KEY,
    );
    expect(d.words.what).toBe("book");
    expect(d.queue[0]?.title).toBe("Andy Weir - Project Hail Mary");
    expect(d.missing[0]?.title).toBe("Andy Weir - Artemis");
  });
});

describe("library controls", () => {
  it("searches one missing album and waits for Lidarr to finish", async () => {
    const o = new LibraryOperations(
      handle,
      broker,
      fakeArrV1("lidarr").fetch,
      async () => undefined,
    );
    const service = { id: "lib", name: "Lidarr", localUrl: "http://10.0.0.9:8686" };
    const planned = await o.plan("lidarr", service, { op: "search", itemId: 31 }, base);
    expect(planned.label).toBe("Search for Radiohead - Kid A in Lidarr");
    expect(await o.run("lidarr", step("app-lidarr-control", planned.params), service)).toEqual({
      ok: true,
      result: "Lidarr searched for Radiohead - Kid A. Anything it found is in its queue.",
    });
  });

  it("replaces a stuck Chaptarr download and checks it left the queue", async () => {
    const o = new LibraryOperations(
      handle,
      broker,
      fakeArrV1("chaptarr").fetch,
      async () => undefined,
    );
    const service = { id: "lib", name: "Chaptarr", localUrl: "http://10.0.0.9:8789" };
    const planned = await o.plan(
      "chaptarr",
      service,
      { op: "replace-download", queueId: 501 },
      base,
    );
    expect(planned.label).toContain("block that release, and search for another");
    expect(
      await o.run("chaptarr", step("app-chaptarr-control", planned.params), service),
    ).toMatchObject({ ok: true });
    await expect(
      o.plan("chaptarr", service, { op: "replace-download", queueId: 501 }, base),
    ).rejects.toThrow(/not in the queue/);
  });
});

describe("Chaptarr's collection", () => {
  it("counts wanted and on-disk books per format, each author, and what is coming", async () => {
    const d = await libraryDashboard(
      "chaptarr",
      fakeArrV1("chaptarr").fetch,
      "http://10.0.0.21:8789",
      KEY,
    );
    expect(d.collection).toEqual({
      known: 6,
      formats: [
        { format: "audiobook", wanted: 1, have: 1, sizeBytes: 312_000_000, unwanted: 0 },
        { format: "ebook", wanted: 2, have: 1, sizeBytes: 4_100_000, unwanted: 0 },
      ],
    });
    expect(d.wanted?.map((b) => [b.title, b.format, b.have])).toEqual([
      ["Artemis", "ebook", false],
      ["The Martian", "audiobook", true],
      ["The Martian", "ebook", true],
    ]);
    expect(d.wanted?.[1]).toMatchObject({
      author: "Andy Weir",
      narrator: "R. C. Bray",
      minutes: 653,
    });
    expect(d.coming).toEqual([
      expect.objectContaining({
        id: 65,
        title: "The Next One",
        wanted: false,
        series: "Hail Mary #2",
      }),
    ]);
    const weir = d.authors?.find((a) => a.name === "Andy Weir");
    expect(weir).toMatchObject({ wanted: { audiobook: 1, ebook: 2 }, have: 2 });
    expect(weir?.next?.title).toBe("The Next One");
    expect(d.authors?.find((a) => a.name === "Iain M. Banks")?.monitored).toBe(false);
    expect(d.folders?.map((f) => f.path)).toEqual(["/audiobooks", "/ebooks"]);
  });

  it("leaves Lidarr's panel as it was", async () => {
    const d = await libraryDashboard(
      "lidarr",
      fakeArrV1("lidarr").fetch,
      "http://10.0.0.22:8686",
      KEY,
    );
    expect(d.collection).toBeUndefined();
    expect(d.authors).toBeUndefined();
  });

  it("wants one format of a coming book, reads it back, and refuses wanting it twice", async () => {
    const fake = fakeArrV1("chaptarr");
    const o = new LibraryOperations(handle, broker, fake.fetch, async () => undefined);
    const service = { id: "lib", name: "Chaptarr", localUrl: "http://10.0.0.23:8789" };
    await expect(o.plan("chaptarr", service, { op: "monitor", itemId: 65 }, base)).rejects.toThrow(
      /monitored true or false/,
    );
    const planned = await o.plan(
      "chaptarr",
      service,
      { op: "monitor", itemId: 65, monitored: true },
      base,
    );
    expect(planned.label).toBe(
      "Want the audiobook of The Next One by Andy Weir in Chaptarr: it is downloaded when a release is found",
    );
    expect(planned.change?.settings).toEqual([
      { name: "the audiobook of The Next One by Andy Weir", before: "not wanted", after: "wanted" },
    ]);
    expect(
      await o.run("chaptarr", step("app-chaptarr-control", planned.params), service),
    ).toMatchObject({ ok: true, result: expect.stringMatching(/is wanted now/) });
    const d = await libraryDashboard("chaptarr", fake.fetch, service.localUrl, KEY);
    expect(d.coming?.[0]?.wanted).toBe(true);
    await expect(
      o.plan("chaptarr", service, { op: "monitor", itemId: 65, monitored: true }, base),
    ).rejects.toThrow(/already wanted/);
    await expect(
      o.plan("chaptarr", service, { op: "monitor", itemId: 999, monitored: true }, base),
    ).rejects.toThrow(/no book with id 999/);
  });
});

describe("requesting a book in Chaptarr (the Curator, 11-17)", () => {
  it("adds it, wants it even though Chaptarr leaves a new author's book not wanted, and searches", async () => {
    const fake = fakeArrV1("chaptarr");
    const o = new LibraryOperations(handle, broker, fake.fetch, async () => undefined);
    const service = { id: "lib", name: "Chaptarr", localUrl: "http://10.0.0.9:8789" };
    const book = JSON.stringify({
      title: "Mother of Learning Arc 1",
      foreignBookId: "gr:93951856",
      mediaType: "audiobook",
      monitored: true,
      addOptions: { searchForNewBook: true },
      author: { authorName: "Domagoj Kurmaic", addOptions: { monitor: "none" } },
    });
    const planned = await o.plan("chaptarr", service, { op: "request", book }, base);
    expect(planned.label).toBe(
      "Request Mother of Learning Arc 1 in Chaptarr: add it, want it, and search for it",
    );
    const done = await o.run("chaptarr", step("app-chaptarr-control", planned.params), service);
    expect(done).toMatchObject({ ok: true, verified: true });
    const books = (await (
      await fake.fetch("http://10.0.0.9:8789/api/v1/book", {
        headers: { "X-Api-Key": KEY },
        signal: AbortSignal.timeout(2000),
      })
    ).json()) as { id: number; title: string; monitored: boolean }[];
    const added = books.find((b) => b.title === "Mother of Learning Arc 1")!;
    expect(added.monitored).toBe(true);
    expect(fake.searches()).toEqual([{ name: "BookSearch", ids: [added.id] }]);
    // Asked again (a retry): the same book, not a second copy.
    await o.run("chaptarr", step("app-chaptarr-control", planned.params), service);
    const again = (await (
      await fake.fetch("http://10.0.0.9:8789/api/v1/book", {
        headers: { "X-Api-Key": KEY },
        signal: AbortSignal.timeout(2000),
      })
    ).json()) as { title: string }[];
    expect(again.filter((b) => b.title === "Mother of Learning Arc 1")).toHaveLength(1);
  });
});
