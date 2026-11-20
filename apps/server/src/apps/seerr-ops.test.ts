import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeMedia } from "../watches/fake-media";
import { RadarrFolderOperations } from "./radarr-folder";
import { SeerrLibrary } from "./seerr-library";
import { SeerrOperations } from "./seerr-ops";

/** Approving and declining requests, and moving a movie's root folder, against the stand-ins. */

const broker = {
  use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: "key" }),
} as unknown as CredentialBroker;
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const seerr = { id: "seerr", name: "Overseerr", localUrl: "http://10.0.0.5:5055" };
const radarr = { id: "radarr", name: "Radarr", localUrl: "http://10.0.0.5:7878" };

describe("approving and declining a Seerr request", () => {
  it("names the title and who asked, approves, and reads it back", async () => {
    const media = fakeMedia();
    media.control({ pending: 9002 });
    const ops = new SeerrOperations(handle, broker, media.fetch);
    const planned = await ops.plan("app-seerr-approve", seerr, { requestId: 2 }, base);
    expect(planned.label).toBe("Approve Alex's request for Quiet Harbor (2026) in Overseerr");
    const done = await ops.run(
      { kind: "app-seerr-approve", serviceId: "seerr", requestedBy: "you", params: planned.params },
      seerr,
    );
    expect(done).toMatchObject({
      ok: true,
      result: expect.stringMatching(/Overseerr confirms it/),
    });
    // Handled now: a second approval is not planned, and a decline is left alone.
    await expect(ops.plan("app-seerr-decline", seerr, { requestId: 2 }, base)).rejects.toThrow(
      /not waiting for approval/,
    );
  });

  it("declines a waiting request", async () => {
    const media = fakeMedia();
    media.control({ pending: 9002 });
    const ops = new SeerrOperations(handle, broker, media.fetch);
    const planned = await ops.plan("app-seerr-decline", seerr, { requestId: 2 }, base);
    const done = await ops.run(
      { kind: "app-seerr-decline", serviceId: "seerr", requestedBy: "you", params: planned.params },
      seerr,
    );
    expect(done).toMatchObject({ ok: true, result: expect.stringMatching(/^Declined/) });
  });
});

describe("stop tracking a request", () => {
  it("removes the request from Seerr (any status) and reads it back; the movie stays", async () => {
    const media = fakeMedia();
    const ops = new SeerrOperations(handle, broker, media.fetch);
    const planned = await ops.plan("app-seerr-remove", seerr, { requestId: 2 }, base);
    expect(planned.label).toBe("Remove Alex's request for Quiet Harbor (2026) from Overseerr");
    expect(planned.change?.settings?.[0]?.after).toMatch(/movie and its files stay/);
    const done = await ops.run(
      { kind: "app-seerr-remove", serviceId: "seerr", requestedBy: "you", params: planned.params },
      seerr,
    );
    expect(done).toMatchObject({ ok: true, result: expect.stringMatching(/no longer lists it/) });
    // Gone from the list; the movie is still in Radarr.
    await expect(ops.plan("app-seerr-remove", seerr, { requestId: 2 }, base)).rejects.toThrow(
      /no request #2/,
    );
    expect(media.movies().some((m) => m.title === "Quiet Harbor")).toBe(true);
    // Running it again is harmless.
    const again = await ops.run(
      { kind: "app-seerr-remove", serviceId: "seerr", requestedBy: "you", params: planned.params },
      seerr,
    );
    expect(again).toMatchObject({ ok: true, result: expect.stringMatching(/already gone/) });
  });
});

describe("changing a movie's root folder in Radarr", () => {
  it("offers only Radarr's real folders and reads the change back", async () => {
    const media = fakeMedia();
    const ops = new RadarrFolderOperations(handle, broker, media.fetch);
    await expect(ops.plan(radarr, { movieId: 103, rootFolder: "/nowhere" }, base)).rejects.toThrow(
      /has no root folder \/nowhere\. It has: \/movies, \/movies-4k, \/new releases/,
    );
    const planned = await ops.plan(radarr, { movieId: 103, rootFolder: "/new releases" }, base);
    expect(planned.label).toBe(
      "Change Night Signal (2026)'s folder in Radarr from /movies to /new releases",
    );
    const done = await ops.run(
      {
        kind: "app-radarr-set-root-folder",
        serviceId: "radarr",
        requestedBy: "you",
        params: planned.params,
        change: planned.change,
      },
      radarr,
    );
    expect(done).toMatchObject({
      ok: true,
      result: "Night Signal (2026) now goes to /new releases.",
    });
  });

  it("says when the movie already goes there, and moves files only for a downloaded one", async () => {
    const media = fakeMedia();
    const ops = new RadarrFolderOperations(handle, broker, media.fetch);
    await expect(ops.plan(radarr, { movieId: 103, rootFolder: "/movies" }, base)).rejects.toThrow(
      /already goes to \/movies/,
    );
    const downloaded = await ops.plan(radarr, { movieId: 105, rootFolder: "/movies-4k" }, base);
    expect(downloaded.label).toMatch(/, moving its files$/);
    expect(downloaded.params).toMatchObject({ moveFiles: true });
  });
});

describe("requesting and handling issues in Seerr", () => {
  const setup = () => {
    const media = fakeMedia();
    const ops = new SeerrOperations(handle, broker, media.fetch);
    const plan = (
      kind: Parameters<SeerrOperations["plan"]>[0],
      params: Record<string, string | number>,
    ) => ops.plan(kind, seerr, params, base);
    const run = (kind: Parameters<SeerrOperations["plan"]>[0], planned: PlannedStep) =>
      ops.run({ kind, serviceId: "seerr", requestedBy: "you", params: planned.params }, seerr);
    return { plan, run };
  };

  it("requests a film once; one already requested or in the library is refused", async () => {
    const { plan, run } = setup();
    const planned = await plan("app-seerr-request", { mediaType: "movie", tmdbId: 9101 });
    expect(planned.label).toBe("Request Harbor Lights (2019) in Overseerr");
    expect(await run("app-seerr-request", planned)).toMatchObject({ ok: true });
    expect(await run("app-seerr-request", planned)).toMatchObject({ ok: false, stale: true });
    await expect(plan("app-seerr-request", { mediaType: "movie", tmdbId: 9101 })).rejects.toThrow(
      /already requested/,
    );
    await expect(plan("app-seerr-request", { mediaType: "movie", tmdbId: 9005 })).rejects.toThrow(
      /already/,
    );
  });

  it("requests a show by season, never asking twice for a season", async () => {
    const { plan, run } = setup();
    const some = await plan("app-seerr-request", { mediaType: "tv", tmdbId: 9102, seasons: "1,2" });
    expect(some.change?.summary).toBe("Request Signal Hill (2018), seasons 1, 2");
    expect((await run("app-seerr-request", some)).ok).toBe(true);
    const rest = await plan("app-seerr-request", { mediaType: "tv", tmdbId: 9102 });
    // Specials (season 0) are never added on their own; seasons 1 and 2 are taken now.
    expect(rest.params).toMatchObject({ seasons: "3" });
    await expect(
      plan("app-seerr-request", { mediaType: "tv", tmdbId: 9102, seasons: "1" }),
    ).rejects.toThrow(/already in the library or requested/);
    await expect(
      plan("app-seerr-request", { mediaType: "tv", tmdbId: 9102, seasons: "9" }),
    ).rejects.toThrow(/no season 9/);
  });

  it("comments on, resolves and deletes an issue; a repeated comment is not posted twice", async () => {
    const { plan, run } = setup();
    const comment = await plan("app-seerr-issue", { issueId: 1, op: "comment", message: "On it." });
    expect(comment.label).toMatch(/Ember Lake \(\d{4}\) \(subtitles\)/);
    expect((await run("app-seerr-issue", comment)).ok).toBe(true);
    expect(await run("app-seerr-issue", comment)).toMatchObject({ ok: false, stale: true });
    expect(
      (await run("app-seerr-issue", await plan("app-seerr-issue", { issueId: 1, op: "resolve" })))
        .ok,
    ).toBe(true);
    await expect(plan("app-seerr-issue", { issueId: 1, op: "resolve" })).rejects.toThrow(
      /already resolved/,
    );
    await expect(plan("app-seerr-issue", { issueId: 2, op: "comment" })).rejects.toThrow(/message/);
    const del = await run(
      "app-seerr-issue",
      await plan("app-seerr-issue", { issueId: 2, op: "delete" }),
    );
    expect(del.ok).toBe(true);
    await expect(plan("app-seerr-issue", { issueId: 2, op: "reopen" })).rejects.toThrow(
      /no issue #2/,
    );
  });

  it("retries only a request that failed", async () => {
    const { plan } = setup();
    await expect(plan("app-seerr-retry", { requestId: 1 })).rejects.toThrow(/has not failed/);
  });
});

describe("Seerr's automatic search, for the Crucible", () => {
  it("turns it off in words, reads it back, refuses a repeat, and Undo turns it back on", async () => {
    const media = fakeMedia();
    const { openDatabase, runMigrations } = await import("../db/client");
    const { SERVER_ROOT } = await import("../config");
    const { getSetting } = await import("../store/settings");
    const path = await import("node:path");
    const db = openDatabase(":memory:");
    await runMigrations(db, path.join(SERVER_ROOT, "drizzle"));
    const ops = new SeerrOperations(db, broker, media.fetch);
    const planned = await ops.plan("app-seerr-search-on-add", seerr, { search: false }, base);
    expect(planned.change?.settings).toEqual([
      {
        name: "Radarr: search as soon as a movie is requested",
        before: "Yes (Seerr searches)",
        after: "No (Hearth searches after sorting)",
      },
      {
        name: "Radarr: quality profile for new requests",
        before: "HD-1080p",
        after:
          "Hearth · Waiting for the Crucible (nothing can be grabbed until the Crucible sorts it)",
      },
    ]);
    const step = {
      kind: "app-seerr-search-on-add" as const,
      serviceId: "seerr",
      requestedBy: "you" as const,
      params: planned.params,
    };
    expect(await ops.run(step, seerr)).toMatchObject({ ok: true, verified: true });
    await expect(
      ops.plan("app-seerr-search-on-add", seerr, { search: false }, base),
    ).rejects.toThrow(/already leaves the search to Hearth/);
    const settings = async () =>
      (await (
        await media.fetch("http://10.0.0.5:5055/api/v1/settings/radarr", {
          headers: {},
          signal: AbortSignal.timeout(2000),
        })
      ).json()) as { preventSearch: boolean; activeProfileName: string }[];
    expect((await settings())[0]).toMatchObject({
      preventSearch: true,
      activeProfileName: "Hearth · Waiting for the Crucible",
    });
    // Remembered while the Crucible holds Seerr's requests, with the default it had.
    expect((await getSetting(db.db, "crucible_seerr"))?.seerr).toMatchObject({
      serverId: 0,
      profileBefore: 4,
      profileBeforeName: "HD-1080p",
    });
    expect(await ops.undo(step, seerr)).toMatchObject({ ok: true, verified: true });
    expect((await getSetting(db.db, "crucible_seerr"))?.seerr).toBeUndefined();
    expect((await settings())[0]).toMatchObject({
      preventSearch: false,
      activeProfileName: "HD-1080p",
    });
    const again = await ops.plan("app-seerr-search-on-add", seerr, { search: false }, base);
    expect(again.change?.settings[0]?.before).toBe("Yes (Seerr searches)");
  });
});

describe("Seerr's automatic search for shows (the Crucible, step 9)", () => {
  it("turns it off for Seerr's Sonarr, remembers it per app, and Undo turns it back on", async () => {
    const media = fakeMedia();
    const { openDatabase, runMigrations } = await import("../db/client");
    const { SERVER_ROOT } = await import("../config");
    const { getSetting } = await import("../store/settings");
    const path = await import("node:path");
    const db = openDatabase(":memory:");
    await runMigrations(db, path.join(SERVER_ROOT, "drizzle"));
    const ops = new SeerrOperations(db, broker, media.fetch);
    const planned = await ops.plan(
      "app-seerr-search-on-add",
      seerr,
      { search: false, app: "sonarr" },
      base,
    );
    expect(planned.change?.settings[0]?.name).toBe("Sonarr: search as soon as a show is requested");
    const step = {
      kind: "app-seerr-search-on-add" as const,
      serviceId: "seerr",
      requestedBy: "you" as const,
      params: planned.params,
    };
    expect(await ops.run(step, seerr)).toMatchObject({ ok: true, verified: true });
    expect((await getSetting(db.db, "crucible_seerr"))?.["seerr:sonarr"]).toMatchObject({
      app: "sonarr",
      profileBeforeName: "HD-1080p",
    });
    // Movies are untouched.
    expect((await getSetting(db.db, "crucible_seerr"))?.seerr).toBeUndefined();
    expect(await ops.undo(step, seerr)).toMatchObject({ ok: true, verified: true });
    expect((await getSetting(db.db, "crucible_seerr"))?.["seerr:sonarr"]).toBeUndefined();
  });
});

describe("a movie you already have (11-19: requested, downloaded, Stop tracking, then requestable again)", () => {
  // Radarr as Hearth reads it: the stand-in at 7878, where Ember Lake (9005) has its file.
  const library = (media: ReturnType<typeof fakeMedia>) =>
    new SeerrLibrary({
      services: async () => [{ ...radarr, name: "Radarr" }] as never,
      read: async <T>(_s: unknown, path: string) => {
        const r = await media.fetch(`http://10.0.0.5:7878${path}`, {
          method: "GET",
          headers: {},
          signal: AbortSignal.timeout(5_000),
        });
        return { status: r.status, data: (await r.json()) as T };
      },
    });

  it("Stop tracking tells Seerr it is in the library first, so it never looks not requested", async () => {
    const media = fakeMedia();
    const ops = new SeerrOperations(handle, broker, media.fetch, library(media));
    const planned = await ops.plan("app-seerr-remove", seerr, { requestId: 5 }, base);
    expect(planned.params).toMatchObject({ requestId: 5, markAvailable: 9505 });
    expect(planned.change?.settings?.[0]?.after).toMatch(
      /Marked as in your library first \(Radarr has it\)/,
    );
    const done = await ops.run(
      { kind: "app-seerr-remove", serviceId: "seerr", requestedBy: "you", params: planned.params },
      seerr,
    );
    expect(done.ok).toBe(true);
    const after = (await (
      await media.fetch("http://10.0.0.5:5055/api/v1/movie/9005", {
        method: "GET",
        headers: {},
        signal: AbortSignal.timeout(5_000),
      })
    ).json()) as { mediaInfo: { status: number } };
    expect(after.mediaInfo.status).toBe(5);
    // Requesting it now is refused: Seerr knows it is in the library.
    await expect(
      ops.plan("app-seerr-request", seerr, { mediaType: "movie", tmdbId: 9005 }, base),
    ).rejects.toThrow(/already in the library/);
  });

  it("without Hearth's fix Seerr forgets it; Tell Seerr you have it repairs that, and Request warns", async () => {
    const media = fakeMedia();
    // Stop tracking the old way (no library check): Seerr resets Ember Lake to not requested.
    const old = new SeerrOperations(handle, broker, media.fetch);
    const p = await old.plan("app-seerr-remove", seerr, { requestId: 5 }, base);
    expect(p.params?.markAvailable).toBeUndefined();
    await old.run(
      { kind: "app-seerr-remove", serviceId: "seerr", requestedBy: "you", params: p.params },
      seerr,
    );

    const ops = new SeerrOperations(handle, broker, media.fetch, library(media));
    // Request still works, but says Radarr already has it downloaded.
    const req = await ops.plan(
      "app-seerr-request",
      seerr,
      { mediaType: "movie", tmdbId: 9005 },
      base,
    );
    expect(req.change?.summary).toMatch(/again: Radarr already has it downloaded/);
    expect(req.change?.settings?.[0]).toMatchObject({ name: "Already in your library" });

    const mark = await ops.plan(
      "app-seerr-mark-available",
      seerr,
      { mediaType: "movie", tmdbId: 9005 },
      base,
    );
    expect(mark.label).toMatch(/^Tell Overseerr Ember Lake .* is in your library$/);
    const done = await ops.run(
      {
        kind: "app-seerr-mark-available",
        serviceId: "seerr",
        requestedBy: "you",
        params: mark.params,
      },
      seerr,
    );
    expect(done).toMatchObject({ ok: true, result: expect.stringMatching(/now shows/) });
    await expect(
      ops.plan("app-seerr-mark-available", seerr, { mediaType: "movie", tmdbId: 9005 }, base),
    ).rejects.toThrow(/already shows/);
  });

  it("won't mark a movie Radarr doesn't have on disk", async () => {
    const media = fakeMedia();
    const ops = new SeerrOperations(handle, broker, media.fetch, library(media));
    // Quiet Harbor (request 2) is requested but not downloaded.
    const tmdb = media.movies().find((m) => m.title === "Quiet Harbor")!.tmdbId;
    await expect(
      ops.plan("app-seerr-mark-available", seerr, { mediaType: "movie", tmdbId: tmdb }, base),
    ).rejects.toThrow(/Neither Radarr nor Sonarr has/);
  });

  it("the panel shows a forgotten movie as in your library", async () => {
    const media = fakeMedia();
    const lib = library(media);
    const out = await lib.annotate("search", {
      results: [
        { tmdbId: 9005, mediaType: "movie", status: "not requested" },
        { tmdbId: 9002, mediaType: "movie", status: "not requested" },
        { tmdbId: 9005, mediaType: "movie", status: "available" },
      ],
    });
    expect(out.results[0]).toMatchObject({
      status: "in your library",
      library: { app: "Radarr", service: "Radarr", files: 1 },
    });
    expect(out.results[1]).toMatchObject({ status: "not requested" });
    expect(out.results[1]).not.toHaveProperty("library");
    expect(out.results[2]).toMatchObject({ status: "available" });
  });

  it("a title in the library offers Upgrade quality: its quality now and the profiles to pick", async () => {
    const media = fakeMedia();
    const lib = library(media);
    // Seerr already calls it available: the upgrade is offered all the same.
    const title = await lib.annotate("title", {
      tmdbId: 9005,
      mediaType: "movie",
      status: "available",
    });
    expect(title).toMatchObject({
      status: "available",
      upgrade: {
        app: "radarr",
        service: "Radarr",
        arrId: 105,
        profileId: 1,
        monitored: true,
        quality: "WEBDL-720p",
        profiles: [
          { id: 1, name: "HD-1080p", cutoff: "Bluray-1080p" },
          { id: 2, name: "Ultra-HD", cutoff: "Bluray-2160p" },
        ],
      },
    });
    // A title Radarr has no file for has nothing to upgrade.
    const none = await lib.annotate("title", {
      tmdbId: 9002,
      mediaType: "movie",
      status: "not requested",
    });
    expect(none).not.toHaveProperty("upgrade");
  });
});
