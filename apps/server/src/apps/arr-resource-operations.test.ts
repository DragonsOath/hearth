import { describe, expect, it } from "vitest";
import type { ActionKind, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { ArrResourceOperations, contains } from "./arr-resource-operations";
import { fakeRadarr } from "./fake-radarr";

/** The panel's and Ember's shared Radarr changes, against the stand-in Radarr. */

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
const radarr = { id: "radarr", name: "Radarr", localUrl: "http://10.0.0.5:7879", hostId: "h" };

function setup() {
  const app = fakeRadarr();
  const ops = new ArrResourceOperations(handle, broker, app.fetch);
  const plan = (kind: ActionKind, params: StepParams) =>
    ops.plan(kind, "radarr", radarr, params, base);
  const run = (kind: ActionKind, planned: PlannedStep) =>
    ops.run(
      {
        kind,
        serviceId: "radarr",
        requestedBy: "you",
        params: planned.params,
        change: planned.change,
      },
      "radarr",
      radarr,
    );
  return { app, ops, plan, run };
}

describe("changing one Radarr object", () => {
  it("shows a movie's change in words, applies it, reads it back, and can put it back", async () => {
    const { app, ops, plan, run } = setup();
    const planned = await plan("app-arr-edit", {
      resource: "movie",
      id: 1,
      changes: JSON.stringify({ monitored: false, qualityProfileId: 2, tags: [1] }),
    });
    expect(planned.label).toBe('Change the movie "Harbor Lights (2019)" in Radarr');
    expect(planned.change!.settings).toEqual([
      { name: "Harbor Lights (2019): Monitored", before: "Yes", after: "No" },
      {
        name: "Harbor Lights (2019): Quality profile",
        before: "HD-1080p (#1)",
        after: "Ultra-HD (#2)",
      },
      { name: "Harbor Lights (2019): Tags", before: "No tags", after: "kids" },
    ]);
    const done = await run("app-arr-edit", planned);
    expect(done).toMatchObject({ ok: true, result: expect.stringMatching(/verified/) });
    expect(app.movies()[0]).toMatchObject({ monitored: false, qualityProfileId: 2, tags: [1] });
    const undone = await ops.undo(
      {
        kind: "app-arr-edit",
        serviceId: "radarr",
        requestedBy: "you",
        params: planned.params,
        change: planned.change,
      },
      "radarr",
      radarr,
    );
    expect(undone).toMatchObject({ ok: true });
    expect(app.movies()[0]).toMatchObject({ monitored: true, qualityProfileId: 1, tags: [] });
  });

  it("stops when the object changed after the plan was made", async () => {
    const { plan, run } = setup();
    const planned = await plan("app-arr-edit", {
      resource: "movie",
      id: 1,
      changes: JSON.stringify({ monitored: false }),
    });
    const other = await plan("app-arr-edit", {
      resource: "movie",
      id: 1,
      changes: JSON.stringify({ monitored: false }),
    });
    await run("app-arr-edit", other);
    expect(await run("app-arr-edit", planned)).toMatchObject({ ok: false, stale: true });
  });

  it("refuses locked fields, unknown settings and a change that changes nothing", async () => {
    const { plan } = setup();
    await expect(
      plan("app-arr-edit", { resource: "movie", id: 1, changes: '{"path":"/elsewhere"}' }),
    ).rejects.toThrow(/root folder/);
    await expect(
      plan("app-arr-edit", { resource: "qualityprofile", id: 1, changes: '{"bogus":1}' }),
    ).rejects.toThrow(/no setting "bogus"/);
    await expect(
      plan("app-arr-edit", { resource: "movie", id: 1, changes: '{"monitored":true}' }),
    ).rejects.toThrow(/Nothing would change/);
    await expect(
      plan("app-arr-edit", { resource: "series", id: 1, changes: '{"monitored":true}' }),
    ).rejects.toThrow(/Say which kind of object/);
  });

  it("never sends a connection's secret from a plan, but changes its ordinary settings", async () => {
    const { app, plan, run } = setup();
    await expect(
      plan("app-arr-edit", {
        resource: "downloadclient",
        id: 1,
        changes: JSON.stringify({ fields: { password: "new" } }),
      }),
    ).rejects.toThrow(/is a secret/);
    const planned = await plan("app-arr-edit", {
      resource: "downloadclient",
      id: 1,
      changes: JSON.stringify({ enable: false, fields: { movieCategory: "films" } }),
    });
    expect(JSON.stringify(planned)).not.toContain("stand-in-secret");
    expect(await run("app-arr-edit", planned)).toMatchObject({ ok: true });
    const r = await app.fetch("http://x:7879/api/v3/downloadclient/1", {
      method: "GET",
      headers: {},
      signal: AbortSignal.timeout(1000),
    });
    const client = (await r.json()) as {
      enable: boolean;
      fields: { name: string; value: unknown }[];
    };
    expect(client.enable).toBe(false);
    expect(client.fields.find((f) => f.name === "movieCategory")?.value).toBe("films");
    // The secret it had is untouched.
    expect(client.fields.find((f) => f.name === "password")?.value).toBe("stand-in-secret");
  });

  it("changes a quality profile's allowed qualities and scores in words", async () => {
    const { plan, run } = setup();
    const planned = await plan("app-arr-edit", {
      resource: "qualityprofile",
      id: 1,
      changes: JSON.stringify({ upgradeAllowed: false, cutoffFormatScore: 50 }),
    });
    expect(planned.change!.settings.map((s) => s.name)).toEqual([
      "HD-1080p: Upgrades allowed",
      "HD-1080p: Upgrade until custom format score",
    ]);
    expect(await run("app-arr-edit", planned)).toMatchObject({ ok: true });
  });
});

describe("quality profiles in plain terms", () => {
  it("changes allowed qualities and format scores by id, in the profile's own order", async () => {
    const { app, plan, run } = setup();
    // WEBDL-2160p (18) added, HDTV-720p not allowed anyway; ids given out of order.
    const planned = await plan("app-arr-edit", {
      resource: "qualityprofile",
      id: 1,
      changes: JSON.stringify({
        allowedQualities: [7, 18, 3, 9, 14, 6],
        formatScores: { "2": 25 },
      }),
    });
    expect(planned.change!.settings).toEqual([
      {
        name: "HD-1080p: Allowed qualities",
        before: "WEBDL-720p, Bluray-720p, HDTV-1080p, WEBDL-1080p, Bluray-1080p",
        after: "WEBDL-720p, Bluray-720p, HDTV-1080p, WEBDL-1080p, Bluray-1080p, WEBDL-2160p",
      },
      { name: "HD-1080p: Custom format scores", before: "x265 (HD): -10", after: "x265 (HD): 25" },
    ]);
    expect(await run("app-arr-edit", planned)).toMatchObject({
      ok: true,
      result: expect.stringMatching(/verified/),
    });
    const r = await app.fetch("http://x:7879/api/v3/qualityprofile/1", {
      method: "GET",
      headers: {},
      signal: AbortSignal.timeout(1000),
    });
    const p = (await r.json()) as {
      items: { quality: { id: number }; allowed: boolean }[];
      formatItems: { format: number; score: number }[];
    };
    expect(p.items.find((i) => i.quality.id === 18)?.allowed).toBe(true);
    expect(p.formatItems.find((f) => f.format === 2)?.score).toBe(25);
    expect(p.formatItems.find((f) => f.format === 3)?.score).toBe(-1000);
  });

  it("refuses a quality the profile does not have", async () => {
    const { plan } = setup();
    await expect(
      plan("app-arr-edit", {
        resource: "qualityprofile",
        id: 1,
        changes: JSON.stringify({ allowedQualities: [999] }),
      }),
    ).rejects.toThrow(/no quality with id 999/);
  });

  it("adds a copy of an existing profile under a new name", async () => {
    const { plan, run } = setup();
    const planned = await plan("app-arr-create", {
      resource: "qualityprofile",
      cloneFrom: 1,
      body: JSON.stringify({ name: "HD for kids" }),
    });
    expect(planned.label).toBe('Add the quality profile "HD for kids" to Radarr');
    expect(await run("app-arr-create", planned)).toMatchObject({ ok: true });
  });
});

describe("adding, removing and running", () => {
  it("adds a new movie found through Radarr's own search, once", async () => {
    const { app, plan, run } = setup();
    const want = JSON.stringify({
      tmdbId: 9902,
      qualityProfileId: 1,
      rootFolderPath: "/movies",
      monitored: true,
      minimumAvailability: "released",
      searchForMovie: true,
    });
    const planned = await plan("app-arr-create", { resource: "movie", body: want });
    expect(planned.label).toBe("Add The Orchard Keeper (2021) to Radarr and search for it");
    expect(planned.change!.settings.find((x) => x.name === "Folder")?.after).toBe(
      "/movies/The Orchard Keeper (2021)",
    );
    expect(await run("app-arr-create", planned)).toMatchObject({
      ok: true,
      result: expect.stringMatching(/searching for it now/),
    });
    expect(app.movies().some((m) => m.title === "The Orchard Keeper")).toBe(true);
    // A retry adds nothing, and planning it again says it is there.
    expect(await run("app-arr-create", planned)).toMatchObject({ ok: false, stale: true });
    await expect(plan("app-arr-create", { resource: "movie", body: want })).rejects.toThrow(
      /already in Radarr/,
    );
    await expect(
      plan("app-arr-create", {
        resource: "movie",
        body: JSON.stringify({ tmdbId: 9900, qualityProfileId: 1, rootFolderPath: "/elsewhere" }),
      }),
    ).rejects.toThrow(/Say a root folder Radarr has/);
  });

  it("adds a tag once, even if the plan runs twice", async () => {
    const { plan, run } = setup();
    const planned = await plan("app-arr-create", {
      resource: "tag",
      body: JSON.stringify({ label: "family" }),
    });
    expect(planned.label).toBe('Add the tag "family" to Radarr');
    expect(await run("app-arr-create", planned)).toMatchObject({ ok: true });
    expect(await run("app-arr-create", planned)).toMatchObject({ ok: false, stale: true });
    await expect(
      plan("app-arr-create", { resource: "tag", body: JSON.stringify({ label: "Family" }) }),
    ).rejects.toThrow(/already has a tag called "Family"/);
  });

  it("removes a movie, saying what happens to its files, and checks it is gone", async () => {
    const { app, plan, run } = setup();
    const planned = await plan("app-arr-delete", { resource: "movie", id: 2, deleteFiles: false });
    expect(planned.change!.settings[1]).toMatchObject({ before: "18.2 GB", after: "Kept on disk" });
    expect(await run("app-arr-delete", planned)).toMatchObject({ ok: true });
    expect(app.movies().some((m) => m.id === 2)).toBe(false);
  });

  it("removes a custom format even though Radarr answers a missing one with an error", async () => {
    const { plan, run } = setup();
    const planned = await plan("app-arr-delete", { resource: "customformat", id: 3 });
    expect(await run("app-arr-delete", planned)).toMatchObject({
      ok: true,
      result: expect.stringMatching(/verified: it is gone/),
    });
  });

  it("removes a blocklist entry", async () => {
    const { plan, run } = setup();
    const planned = await plan("app-arr-delete", { resource: "blocklist", id: 1 });
    expect(planned.label).toMatch(/off|from Radarr's blocklist/);
    expect(await run("app-arr-delete", planned)).toMatchObject({ ok: true });
  });

  it("runs a refresh or a scheduled task, but never an app update", async () => {
    const { plan, run } = setup();
    const refresh = await plan("app-arr-command", { command: "RefreshMovie", movieIds: "1,3" });
    expect(refresh.label).toBe(
      "Refresh (update details and rescan) in Radarr: Harbor Lights (2019), Paper Lanterns (2016)",
    );
    expect(await run("app-arr-command", refresh)).toMatchObject({ ok: true });
    const rss = await plan("app-arr-command", { command: "RssSync" });
    expect(rss.label).toBe('Run "RSS Sync" now in Radarr');
    await expect(plan("app-arr-command", { command: "ApplicationUpdate" })).rejects.toThrow(
      /updates stay in the app/,
    );
    await expect(plan("app-arr-command", { command: "Nonsense" })).rejects.toThrow(
      /Say which command/,
    );
  });
});

describe("sizes, exclusions and manual import", () => {
  it("changes a quality's size limits in MB per minute, inside Radarr's limits, and puts them back", async () => {
    const { ops, plan, run } = setup();
    const planned = await plan("app-arr-edit", {
      resource: "qualitydefinition",
      id: 7,
      changes: JSON.stringify({ maxSize: 200, preferredSize: 60 }),
    });
    expect(planned.change!.settings).toEqual([
      { name: "Bluray-1080p: Maximum size (MB per minute)", before: "400", after: "200" },
      { name: "Bluray-1080p: Preferred size (MB per minute)", before: "95", after: "60" },
    ]);
    expect(await run("app-arr-edit", planned)).toMatchObject({
      ok: true,
      result: expect.stringMatching(/verified/),
    });
    expect(
      await ops.undo(
        {
          kind: "app-arr-edit",
          serviceId: "radarr",
          requestedBy: "you",
          params: planned.params,
          change: planned.change,
        },
        "radarr",
        radarr,
      ),
    ).toMatchObject({ ok: true });
    await expect(
      plan("app-arr-edit", { resource: "qualitydefinition", id: 7, changes: '{"maxSize":5000}' }),
    ).rejects.toThrow(/from 0 to 2000/);
    await expect(
      plan("app-arr-edit", { resource: "qualitydefinition", id: 7, changes: '{"minSize":300}' }),
    ).rejects.toThrow(/minimum must not be above/);
    await expect(
      plan("app-arr-edit", { resource: "qualitydefinition", id: 7, changes: '{"title":"x"}' }),
    ).rejects.toThrow(/Only these can change/);
  });

  it("excludes a movie from import lists once, and removes an exclusion", async () => {
    const { plan, run } = setup();
    const planned = await plan("app-arr-create", {
      resource: "exclusion",
      body: JSON.stringify({ tmdbId: 9900 }),
    });
    expect(planned.label).toBe("Stop import lists adding Lantern Season (2023) to Radarr");
    expect(await run("app-arr-create", planned)).toMatchObject({
      ok: true,
      result: expect.stringMatching(/verified/),
    });
    expect(await run("app-arr-create", planned)).toMatchObject({ ok: false, stale: true });
    await expect(
      plan("app-arr-create", { resource: "exclusion", body: JSON.stringify({ tmdbId: 9902 }) }),
    ).rejects.toThrow(/already excluded/);
    const gone = await plan("app-arr-delete", { resource: "exclusion", id: 1 });
    expect(gone.label).toContain("The Orchard Keeper (2021)");
    expect(await run("app-arr-delete", gone)).toMatchObject({
      ok: true,
      result: expect.stringMatching(/gone/),
    });
  });

  it("imports a file Radarr found into the movie chosen for it, and only files Radarr lists", async () => {
    const { app, plan, run } = setup();
    const file =
      "/downloads/Glass.Meridian.2018.1080p.BluRay.x264-GRP/Glass.Meridian.2018.1080p.BluRay.x264-GRP.mkv";
    const planned = await plan("app-arr-command", {
      command: "ManualImport",
      folder: "/downloads",
      files: JSON.stringify([{ path: file, movieId: 6 }]),
    });
    expect(planned.label).toBe("Import 1 file into Radarr (move)");
    expect(planned.change!.settings[0]).toMatchObject({
      before: "In /downloads",
      after: expect.stringMatching(/^Moved into Glass Meridian .* as Bluray-1080p$/),
    });
    expect(await run("app-arr-command", planned)).toMatchObject({
      ok: true,
      result: expect.stringMatching(/verified: each movie has its file/),
    });
    expect(app.movies().find((m) => m.id === 6)).toMatchObject({ hasFile: true });
    // Already moved: running the same plan again changes nothing.
    expect(await run("app-arr-command", planned)).toMatchObject({ ok: false, stale: true });
    await expect(
      plan("app-arr-command", {
        command: "ManualImport",
        folder: "/downloads",
        files: JSON.stringify([{ path: "/etc/passwd", movieId: 6 }]),
      }),
    ).rejects.toThrow(/does not list/);
    await expect(
      plan("app-arr-command", {
        command: "ManualImport",
        folder: "/downloads",
        files: JSON.stringify([
          { path: "/downloads/Holiday.Video.2024.mkv", movieId: 3 },
          { path: "/downloads/Holiday.Video.2024.mkv", movieId: 3 },
        ]),
      }),
    ).rejects.toThrow(/one file per movie/);
  });
});

describe("contains", () => {
  it("ignores extra properties the app adds but not missing or different ones", () => {
    expect(contains({ a: 1, b: 2 }, { a: 1 })).toBe(true);
    expect(contains({ a: 1 }, { a: 2 })).toBe(false);
    expect(contains([{ a: 1, x: 0 }], [{ a: 1 }])).toBe(true);
    expect(contains([{ a: 1 }], [{ a: 1 }, { a: 2 }])).toBe(false);
  });
});
