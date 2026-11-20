import { describe, expect, it } from "vitest";
import type { ActionKind, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { ArrResourceOperations } from "./arr-resource-operations";
import { fakeSonarr } from "./fake-sonarr";

/** The Sonarr panel's and Ember's shared changes, against the stand-in Sonarr 4 (Phase 3). */

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
const sonarrSvc = { id: "sonarr", name: "Sonarr", localUrl: "http://10.0.0.6:8990", hostId: "h" };

function setup() {
  const app = fakeSonarr();
  const ops = new ArrResourceOperations(handle, broker, app.fetch);
  const plan = (kind: ActionKind, params: StepParams) =>
    ops.plan(kind, "sonarr", sonarrSvc, params, base);
  const step = (kind: ActionKind, planned: PlannedStep) => ({
    kind,
    serviceId: "sonarr",
    requestedBy: "you" as const,
    params: planned.params,
    change: planned.change,
  });
  const run = (kind: ActionKind, planned: PlannedStep) =>
    ops.run(step(kind, planned), "sonarr", sonarrSvc);
  const undo = (kind: ActionKind, planned: PlannedStep) =>
    ops.undo(step(kind, planned), "sonarr", sonarrSvc);
  return { app, plan, run, undo };
}

describe("Sonarr series, seasons and episodes", () => {
  it("changes a series' profile, type and monitored seasons in words, and puts them back", async () => {
    const { app, plan, run, undo } = setup();
    const planned = await plan("app-arr-edit", {
      resource: "series",
      id: 3,
      changes: JSON.stringify({
        qualityProfileId: 2,
        seriesType: "daily",
        monitoredSeasons: [3, 1, 2],
      }),
    });
    expect(planned.label).toBe('Change the series "Small Hours (2021)" in Sonarr');
    expect(planned.change!.settings).toEqual([
      {
        name: "Small Hours (2021): Quality profile",
        before: "HD-1080p (#1)",
        after: "Ultra-HD (#2)",
      },
      { name: "Small Hours (2021): Series type", before: "standard", after: "daily" },
      {
        name: "Small Hours (2021): Monitored seasons",
        before: "Season 2, Season 3",
        after: "Season 1, Season 2, Season 3",
      },
    ]);
    expect(await run("app-arr-edit", planned)).toMatchObject({
      ok: true,
      result: expect.stringMatching(/verified/),
    });
    // Switching season 1 on switched its episodes on too.
    expect(
      app
        .episodes()
        .filter((e) => e.seriesId === 3 && e.seasonNumber === 1)
        .every((e) => e.monitored),
    ).toBe(true);
    expect(await undo("app-arr-edit", planned)).toMatchObject({ ok: true });
    expect(app.series().find((x) => x.id === 3)).toMatchObject({
      qualityProfileId: 1,
      seriesType: "standard",
    });
    await expect(
      plan("app-arr-edit", { resource: "series", id: 3, changes: '{"monitoredSeasons":[9]}' }),
    ).rejects.toThrow(/no season 9/);
    await expect(
      plan("app-arr-edit", { resource: "series", id: 3, changes: '{"path":"/elsewhere"}' }),
    ).rejects.toThrow(/cannot change here/);
  });

  it("stops monitoring one episode", async () => {
    const { app, plan, run } = setup();
    const planned = await plan("app-arr-edit", {
      resource: "episode",
      id: 26,
      changes: JSON.stringify({ monitored: false }),
    });
    expect(planned.label).toBe('Change the episode "S02E06 "Chapter 6"" in Sonarr');
    expect(await run("app-arr-edit", planned)).toMatchObject({ ok: true });
    expect(app.episodes().find((e) => e.id === 26)?.monitored).toBe(false);
  });

  it("adds a series found through Sonarr's own search, once", async () => {
    const { app, plan, run } = setup();
    const body = JSON.stringify({
      tvdbId: 99000,
      qualityProfileId: 1,
      rootFolderPath: "/tv",
      monitor: "future",
      seriesType: "standard",
      searchForMissingEpisodes: false,
    });
    const planned = await plan("app-arr-create", { resource: "series", body });
    expect(planned.label).toBe("Add Lantern Bay (2024) to Sonarr");
    expect(planned.change!.settings).toContainEqual({
      name: "Monitor",
      before: "(new)",
      after: "Future episodes",
    });
    expect(await run("app-arr-create", planned)).toMatchObject({
      ok: true,
      result: expect.stringMatching(/verified/),
    });
    expect(await run("app-arr-create", planned)).toMatchObject({ ok: false, stale: true });
    await expect(plan("app-arr-create", { resource: "series", body })).rejects.toThrow(
      /already in/,
    );
    expect(app.series().some((x) => x.title === "Lantern Bay")).toBe(true);
    await expect(
      plan("app-arr-create", {
        resource: "series",
        body: JSON.stringify({ tvdbId: 99001, qualityProfileId: 1, rootFolderPath: "/movies" }),
      }),
    ).rejects.toThrow(/root folder/);
  });

  it("removes a series keeping its files, and says so", async () => {
    const { app, plan, run } = setup();
    const planned = await plan("app-arr-delete", { resource: "series", id: 4, deleteFiles: false });
    expect(planned.change!.settings[1]).toMatchObject({
      before: expect.stringMatching(/^4 files/),
      after: "Kept on disk",
    });
    expect(await run("app-arr-delete", planned)).toMatchObject({ ok: true });
    expect(app.series().some((x) => x.id === 4)).toBe(false);
  });

  it("excludes a show from import lists by its TVDB id, once", async () => {
    const { plan, run } = setup();
    const planned = await plan("app-arr-create", {
      resource: "exclusion",
      body: JSON.stringify({ tvdbId: 99000 }),
    });
    expect(planned.label).toBe("Stop import lists adding Lantern Bay (2024) to Sonarr");
    expect(await run("app-arr-create", planned)).toMatchObject({ ok: true });
    expect(await run("app-arr-create", planned)).toMatchObject({ ok: false, stale: true });
    const gone = await plan("app-arr-delete", { resource: "exclusion", id: 1 });
    expect(await run("app-arr-delete", gone)).toMatchObject({ ok: true });
  });
});

describe("Sonarr commands and manual import", () => {
  it("runs a series, season or episode command, but never an app update", async () => {
    const { plan, run } = setup();
    const season = await plan("app-arr-command", {
      command: "SeasonSearch",
      seriesId: 2,
      seasonNumber: 2,
    });
    expect(season.label).toBe("Search for the season in Sonarr: The Copper Line (2023), season 2");
    expect(await run("app-arr-command", season)).toMatchObject({ ok: true });
    const eps = await plan("app-arr-command", { command: "EpisodeSearch", episodeIds: "26,27" });
    expect(eps.label).toBe("Search for the episode in Sonarr: S02E06, S02E07");
    const refresh = await plan("app-arr-command", { command: "RefreshSeries", seriesId: 1 });
    expect(refresh.label).toMatch(/Night Harbor/);
    await expect(
      plan("app-arr-command", { command: "SeasonSearch", seriesId: 2, seasonNumber: 5 }),
    ).rejects.toThrow(/no season 5/);
    await expect(plan("app-arr-command", { command: "ApplicationUpdate" })).rejects.toThrow(
      /updates stay in the app/,
    );
  });

  it("imports a file into the episode chosen for it, only files Sonarr lists", async () => {
    const { app, plan, run } = setup();
    const file =
      "/downloads/The.Copper.Line.S02E07.1080p.WEB-DL-GRP/The.Copper.Line.S02E07.1080p.WEB-DL-GRP.mkv";
    const ep = app
      .episodes()
      .find((e) => e.seriesId === 2 && e.seasonNumber === 2 && e.episodeNumber === 7)!;
    const planned = await plan("app-arr-command", {
      command: "ManualImport",
      folder: "/downloads",
      files: JSON.stringify([{ path: file, seriesId: 2, episodeIds: [ep.id] }]),
    });
    expect(planned.label).toBe("Import 1 file into Sonarr (move)");
    expect(planned.change!.settings[0]!.after).toBe(
      "Moved into The Copper Line (2023) S02E07 as WEBDL-1080p",
    );
    expect(await run("app-arr-command", planned)).toMatchObject({
      ok: true,
      result: expect.stringMatching(/verified: each episode has its file/),
    });
    expect(app.episodes().find((e) => e.id === ep.id)?.hasFile).toBe(true);
    expect(await run("app-arr-command", planned)).toMatchObject({ ok: false, stale: true });
    await expect(
      plan("app-arr-command", {
        command: "ManualImport",
        folder: "/downloads",
        files: JSON.stringify([{ path: "/etc/passwd", seriesId: 2, episodeIds: [ep.id] }]),
      }),
    ).rejects.toThrow(/does not list/);
    await expect(
      plan("app-arr-command", {
        command: "ManualImport",
        folder: "/downloads",
        files: JSON.stringify([
          { path: "/downloads/Home.Movie.2024.mkv", seriesId: 1, episodeIds: [ep.id] },
        ]),
      }),
    ).rejects.toThrow(/not in Night Harbor/);
  });
});
