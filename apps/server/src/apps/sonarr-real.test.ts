import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ActionKind, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { ArrResourceOperations } from "./arr-resource-operations";
import type { Fetch } from "./http";
import type { ServarrGet } from "./servarr-panel";
import { SONARR_VIEWS, readSonarrView } from "./sonarr-panel";

/**
 * The Sonarr panel's reads and changes against a real, disposable Sonarr with synthetic media
 * (checklist 46.10e). Skipped unless HEARTH_SONARR_TEST_URL and HEARTH_SONARR_TEST_KEY_FILE point
 * at such an instance: never run this against a library anyone uses. Everything it adds it
 * removes again, and everything it changes it puts back.
 */

const url = process.env.HEARTH_SONARR_TEST_URL;
const keyFile = process.env.HEARTH_SONARR_TEST_KEY_FILE;
const key = keyFile ? readFileSync(keyFile, "utf8").trim() : "";
const live = Boolean(url && key);

const fetchImpl: Fetch = (u, init) => fetch(u, init);
const broker = {
  use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: key }),
} as unknown as CredentialBroker;
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const sonarr = { id: "sonarr-test", name: "Sonarr", localUrl: url ?? "", hostId: "h" };
const ops = new ArrResourceOperations(handle, broker, fetchImpl);
const plan = (kind: ActionKind, params: StepParams) =>
  ops.plan(kind, "sonarr", sonarr, params, base);
const step = (kind: ActionKind, planned: PlannedStep) => ({
  kind,
  serviceId: "sonarr-test",
  requestedBy: "you" as const,
  params: planned.params,
  change: planned.change,
});
const run = (kind: ActionKind, planned: PlannedStep) =>
  ops.run(step(kind, planned), "sonarr", sonarr);
const undo = (kind: ActionKind, planned: PlannedStep) =>
  ops.undo(step(kind, planned), "sonarr", sonarr);

type Json = Record<string, unknown>;
async function api<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${url}${path}`, {
    method,
    headers: { "X-Api-Key": key, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
  return (text ? JSON.parse(text) : {}) as T;
}
const get: ServarrGet = async (path) => {
  const r = await fetch(`${url}${path}`, {
    headers: { "X-Api-Key": key },
    signal: AbortSignal.timeout(20_000),
  });
  return { ok: r.ok, status: r.status, data: await r.json() };
};
const tag = `t${Date.now().toString(36)}`;
const bySeriesTitle = async (start: string) =>
  (await api<Json[]>("GET", "/api/v3/series")).find((s) => String(s.title).startsWith(start))!;

describe.skipIf(!live)(
  "the Sonarr panel against a real disposable Sonarr",
  { timeout: 60_000 },
  () => {
    it("reads every view the panel shows", async () => {
      const series = await api<Json[]>("GET", "/api/v3/series");
      const id = String(series[0]!.id);
      for (const view of SONARR_VIEWS) {
        const q: Record<string, string> =
          view === "series"
            ? { id }
            : view === "lookup"
              ? { title: "Peter Gunn" }
              : view === "parse"
                ? { title: "Dragnet.1967.S01E02.720p.WEB.x265-GRP" }
                : view === "imports"
                  ? { folder: "/downloads" }
                  : {};
        const v = await readSonarrView(get, view, q);
        expect(v.meta, view).toMatchObject({ supported: true });
      }
      const lib = await readSonarrView(get, "library", {});
      expect((lib.series as unknown[]).length).toBeGreaterThanOrEqual(4);
      const one = await readSonarrView(get, "series", { id });
      expect((one.episodes as unknown[]).length).toBeGreaterThan(0);
      expect(JSON.stringify(await readSonarrView(get, "connections", {}))).not.toContain(key);
    });

    it("changes a series and its season monitoring, reads it back, and puts it back", async () => {
      const s = await bySeriesTitle("The Beverly Hillbillies");
      const id = Number(s.id);
      const seasons = (s.seasons as { seasonNumber: number; monitored: boolean }[]).filter(
        (x) => x.seasonNumber > 0,
      );
      const keep = seasons.slice(0, 1).map((x) => x.seasonNumber);
      const planned = await plan("app-arr-edit", {
        resource: "series",
        id,
        changes: JSON.stringify({
          seriesType: s.seriesType === "daily" ? "standard" : "daily",
          seasonFolder: !s.seasonFolder,
          monitoredSeasons: keep,
        }),
      });
      expect(await run("app-arr-edit", planned)).toMatchObject({
        ok: true,
        result: expect.stringMatching(/verified/),
      });
      const after = await api("GET", `/api/v3/series/${id}`);
      expect(after.path).toBe(s.path);
      expect(after.seasonFolder).toBe(!s.seasonFolder);
      const on = (after.seasons as { seasonNumber: number; monitored: boolean }[])
        .filter((x) => x.seasonNumber > 0 && x.monitored)
        .map((x) => x.seasonNumber);
      expect(on).toEqual(keep);
      expect(await undo("app-arr-edit", planned)).toMatchObject({ ok: true });
      const back = await api("GET", `/api/v3/series/${id}`);
      expect(back).toMatchObject({ seriesType: s.seriesType, seasonFolder: s.seasonFolder });
      expect(
        (back.seasons as { seasonNumber: number; monitored: boolean }[]).map((x) => x.monitored),
      ).toEqual((s.seasons as { monitored: boolean }[]).map((x) => x.monitored));
    });

    it("stops an edit when the same setting changed in Sonarr meanwhile", async () => {
      const s = await bySeriesTitle("One Step Beyond");
      const id = Number(s.id);
      const stale = await plan("app-arr-edit", {
        resource: "series",
        id,
        changes: JSON.stringify({ seriesType: "anime" }),
      });
      await api("PUT", `/api/v3/series/${id}?moveFiles=false`, { ...s, seriesType: "daily" });
      try {
        expect(await run("app-arr-edit", stale)).toMatchObject({ ok: false, stale: true });
      } finally {
        await api("PUT", `/api/v3/series/${id}?moveFiles=false`, {
          ...(await api("GET", `/api/v3/series/${id}`)),
          seriesType: s.seriesType,
        });
      }
    });

    it("monitors and unmonitors one episode", async () => {
      const s = await bySeriesTitle("The Lone Ranger");
      const [e] = await api<Json[]>("GET", `/api/v3/episode?seriesId=${String(s.id)}`);
      const planned = await plan("app-arr-edit", {
        resource: "episode",
        id: Number(e!.id),
        changes: JSON.stringify({ monitored: !e!.monitored }),
      });
      expect(planned.label).toMatch(/S\d\dE\d\d/);
      expect(await run("app-arr-edit", planned)).toMatchObject({ ok: true });
      expect((await api("GET", `/api/v3/episode/${String(e!.id)}`)).monitored).toBe(!e!.monitored);
      expect(await undo("app-arr-edit", planned)).toMatchObject({ ok: true });
      expect((await api("GET", `/api/v3/episode/${String(e!.id)}`)).monitored).toBe(e!.monitored);
    });

    it("adds a show from Sonarr's own search once, then removes it keeping files", async () => {
      const found = await api<Json[]>("GET", "/api/v3/series/lookup?term=Peter%20Gunn");
      const pick = found.find((x) => x.year === 1958) ?? found[0]!;
      const tvdbId = Number(pick.tvdbId);
      for (const h of await api<Json[]>("GET", `/api/v3/series?tvdbId=${tvdbId}`))
        await api("DELETE", `/api/v3/series/${String(h.id)}?deleteFiles=false`);
      const body = JSON.stringify({
        tvdbId,
        qualityProfileId: 1,
        rootFolderPath: "/tv",
        monitor: "firstSeason",
        seriesType: "standard",
        seasonFolder: true,
        searchForMissingEpisodes: false,
      });
      const planned = await plan("app-arr-create", { resource: "series", body });
      expect(planned.label).toMatch(/Peter Gunn/);
      expect(await run("app-arr-create", planned)).toMatchObject({
        ok: true,
        result: expect.stringMatching(/verified/),
      });
      expect(await run("app-arr-create", planned)).toMatchObject({ ok: false, stale: true });
      await expect(plan("app-arr-create", { resource: "series", body })).rejects.toThrow(/already/);
      const added = await api<Json[]>("GET", `/api/v3/series?tvdbId=${tvdbId}`);
      expect(added.length).toBe(1);
      const remove = await plan("app-arr-delete", {
        resource: "series",
        id: Number(added[0]!.id),
        deleteFiles: false,
      });
      expect(await run("app-arr-delete", remove)).toMatchObject({ ok: true });
      expect(await api<Json[]>("GET", `/api/v3/series?tvdbId=${tvdbId}`)).toEqual([]);
    });

    it("adds a tag and a release profile once and removes them", async () => {
      const t = await plan("app-arr-create", {
        resource: "tag",
        body: JSON.stringify({ label: tag }),
      });
      expect(await run("app-arr-create", t)).toMatchObject({ ok: true });
      expect(await run("app-arr-create", t)).toMatchObject({ ok: false, stale: true });
      const made = (await api<Json[]>("GET", "/api/v3/tag")).find((x) => x.label === tag)!;
      const tGone = await plan("app-arr-delete", { resource: "tag", id: Number(made.id) });
      expect(await run("app-arr-delete", tGone)).toMatchObject({ ok: true });

      const rp = await plan("app-arr-create", {
        resource: "releaseprofile",
        body: JSON.stringify({
          name: `rp ${tag}`,
          enabled: true,
          required: [],
          ignored: ["CAM"],
          tags: [],
        }),
      });
      expect(await run("app-arr-create", rp)).toMatchObject({ ok: true });
      const r = (await api<Json[]>("GET", "/api/v3/releaseprofile")).find(
        (x) => x.name === `rp ${tag}`,
      )!;
      const rGone = await plan("app-arr-delete", { resource: "releaseprofile", id: Number(r.id) });
      expect(await run("app-arr-delete", rGone)).toMatchObject({ ok: true });
    });

    it("makes a custom format that Sonarr's own name check matches, then removes it", async () => {
      const name = `x265 ${tag}`;
      const made = await plan("app-arr-create", {
        resource: "customformat",
        body: JSON.stringify({
          name,
          includeCustomFormatWhenRenaming: false,
          specifications: [
            {
              name: "x265",
              implementation: "ReleaseTitleSpecification",
              negate: false,
              required: true,
              fields: [{ name: "value", value: "\\b(x265|HEVC)\\b" }],
            },
          ],
        }),
      });
      expect(await run("app-arr-create", made)).toMatchObject({ ok: true });
      const cf = (await api<Json[]>("GET", "/api/v3/customformat")).find((x) => x.name === name)!;
      try {
        const hit = await readSonarrView(get, "parse", {
          title: "Dragnet.1967.S01E02.720p.WEB.x265-GRP",
        });
        expect(JSON.stringify(hit)).toContain(name);
        const miss = await readSonarrView(get, "parse", {
          title: "Dragnet.1967.S01E02.720p.WEB.x264-GRP",
        });
        expect(JSON.stringify(miss)).not.toContain(name);
      } finally {
        const gone = await plan("app-arr-delete", { resource: "customformat", id: Number(cf.id) });
        expect(await run("app-arr-delete", gone)).toMatchObject({ ok: true });
      }
    });

    it("changes naming, media management and a quality size, and puts them back", async () => {
      const naming = await api("GET", "/api/v3/config/naming");
      const n = await plan("app-arr-edit", {
        resource: "naming",
        changes: JSON.stringify({ renameEpisodes: !naming.renameEpisodes }),
      });
      expect(await run("app-arr-edit", n)).toMatchObject({ ok: true });
      expect(await undo("app-arr-edit", n)).toMatchObject({ ok: true });
      expect((await api("GET", "/api/v3/config/naming")).renameEpisodes).toBe(
        naming.renameEpisodes,
      );

      const media = await api("GET", "/api/v3/config/mediamanagement");
      const m = await plan("app-arr-edit", {
        resource: "mediamanagement",
        changes: JSON.stringify({ recycleBinCleanupDays: Number(media.recycleBinCleanupDays) + 1 }),
      });
      expect(await run("app-arr-edit", m)).toMatchObject({ ok: true });
      expect(await undo("app-arr-edit", m)).toMatchObject({ ok: true });

      const defs = await api<Json[]>("GET", "/api/v3/qualitydefinition");
      const d = defs.find((x) => (x.quality as Json).name === "HDTV-720p")!;
      const max = typeof d.maxSize === "number" ? d.maxSize : 400;
      const sz = await plan("app-arr-edit", {
        resource: "qualitydefinition",
        id: Number(d.id),
        changes: JSON.stringify({
          maxSize: max - 1,
          preferredSize: Math.min(Number(d.preferredSize ?? max - 2), max - 2),
        }),
      });
      expect(await run("app-arr-edit", sz)).toMatchObject({ ok: true });
      expect((await api("GET", `/api/v3/qualitydefinition/${String(d.id)}`)).maxSize).toBe(max - 1);
      expect(await undo("app-arr-edit", sz)).toMatchObject({ ok: true });
      const back = await api("GET", `/api/v3/qualitydefinition/${String(d.id)}`);
      expect(back.maxSize ?? null).toBe(d.maxSize ?? null);
    });

    it("excludes a show from import lists once and removes the exclusion", async () => {
      const found = await api<Json[]>("GET", "/api/v3/series/lookup?term=Peter%20Gunn");
      const tvdbId = Number((found.find((x) => x.year === 1958) ?? found[0]!).tvdbId);
      const ex = await plan("app-arr-create", {
        resource: "exclusion",
        body: JSON.stringify({ tvdbId }),
      });
      expect(ex.label).toMatch(/Peter Gunn/);
      expect(await run("app-arr-create", ex)).toMatchObject({
        ok: true,
        result: expect.stringMatching(/verified/),
      });
      expect(await run("app-arr-create", ex)).toMatchObject({ ok: false, stale: true });
      const made = (await api<Json[]>("GET", "/api/v3/importlistexclusion")).find(
        (x) => x.tvdbId === tvdbId,
      )!;
      const gone = await plan("app-arr-delete", { resource: "exclusion", id: Number(made.id) });
      expect(await run("app-arr-delete", gone)).toMatchObject({ ok: true });
    });

    it("imports a waiting episode by copying it, then deletes only that copy", async () => {
      const file =
        "/downloads/Dragnet.1951.S01E02.720p.WEB.x264-GRP/Dragnet.1951.S01E02.720p.WEB.x264-GRP.mkv";
      const s = await bySeriesTitle("Dragnet");
      const eps = await api<Json[]>("GET", `/api/v3/episode?seriesId=${String(s.id)}`);
      const e = eps.find((x) => x.seasonNumber === 1 && x.episodeNumber === 2)!;
      expect(e.hasFile).toBe(false);
      const planned = await plan("app-arr-command", {
        command: "ManualImport",
        folder: "/downloads",
        importMode: "copy",
        files: JSON.stringify([{ path: file, seriesId: s.id, episodeIds: [e.id] }]),
      });
      expect(planned.label).toMatch(/copy/);
      try {
        const done = await run("app-arr-command", planned);
        expect(done, JSON.stringify(done)).toMatchObject({
          ok: true,
          result: expect.stringMatching(/verified/),
        });
        expect((await api("GET", `/api/v3/episode/${String(e.id)}`)).hasFile).toBe(true);
        const still = await api<Json[]>(
          "GET",
          "/api/v3/manualimport?folder=%2Fdownloads&filterExistingFiles=true",
        );
        expect(still.map((f) => f.path)).toContain(file);
      } finally {
        const now = await api("GET", `/api/v3/episode/${String(e.id)}`);
        if (now.episodeFileId)
          await api("DELETE", `/api/v3/episodefile/${String(now.episodeFileId)}`);
      }
    });

    it("runs a refresh, a rescan and a backup, but never an app update", async () => {
      const s = await bySeriesTitle("The Lone Ranger");
      for (const params of <StepParams[]>[
        { command: "RefreshSeries", seriesId: Number(s.id) },
        { command: "RescanSeries", seriesId: Number(s.id) },
        { command: "Backup" },
      ]) {
        const p = await plan("app-arr-command", params);
        const r = await run("app-arr-command", p);
        expect(r, String(params.command)).toMatchObject({ ok: true });
      }
      await expect(plan("app-arr-command", { command: "ApplicationUpdate" })).rejects.toThrow(
        /updates stay in the app/,
      );
    });
  },
);
