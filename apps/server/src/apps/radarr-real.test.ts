import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ActionKind, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { ArrResourceOperations } from "./arr-resource-operations";
import type { Fetch } from "./http";
import { RADARR_VIEWS, readRadarrView, type RadarrGet } from "./radarr-panel";

/**
 * The Radarr panel's reads and shared changes against a real, disposable Radarr with synthetic
 * media (checklist 46.9k, D12). Skipped unless HEARTH_RADARR_TEST_URL and
 * HEARTH_RADARR_TEST_KEY_FILE point at such an instance: never run this against a library
 * anyone uses. Everything it adds it removes again, through the same remove step.
 */

const url = process.env.HEARTH_RADARR_TEST_URL;
const keyFile = process.env.HEARTH_RADARR_TEST_KEY_FILE;
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
const radarr = { id: "radarr-test", name: "Radarr", localUrl: url ?? "", hostId: "h" };
const ops = new ArrResourceOperations(handle, broker, fetchImpl);
const plan = (kind: ActionKind, params: StepParams) =>
  ops.plan(kind, "radarr", radarr, params, base);
const step = (kind: ActionKind, planned: PlannedStep) => ({
  kind,
  serviceId: "radarr-test",
  requestedBy: "you" as const,
  params: planned.params,
  change: planned.change,
});
const run = (kind: ActionKind, planned: PlannedStep) =>
  ops.run(step(kind, planned), "radarr", radarr);
const undo = (kind: ActionKind, planned: PlannedStep) =>
  ops.undo(step(kind, planned), "radarr", radarr);

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
const get: RadarrGet = async (path) => {
  const r = await fetch(`${url}${path}`, {
    headers: { "X-Api-Key": key },
    signal: AbortSignal.timeout(20_000),
  });
  return { ok: r.ok, status: r.status, data: await r.json() };
};
const tag = `t${Date.now().toString(36)}`;

describe.skipIf(!live)(
  "the Radarr panel against a real disposable Radarr",
  { timeout: 60_000 },
  () => {
    it("reads every view the panel shows", async () => {
      const movies = await api<Json[]>("GET", "/api/v3/movie");
      const id = String(movies[0]!.id);
      for (const view of RADARR_VIEWS) {
        const q: Record<string, string> =
          view === "movie"
            ? { id }
            : view === "lookup"
              ? { title: "Charade" }
              : view === "parse"
                ? { title: "Metropolis.1927.1080p.BluRay.x265-GRP" }
                : view === "imports"
                  ? { folder: "/downloads" }
                  : {};
        const v = await readRadarrView(get, view, q);
        expect(v.meta, view).toMatchObject({ supported: true });
      }
      const lib = await readRadarrView(get, "library", {});
      expect((lib.movies as unknown[]).length).toBeGreaterThanOrEqual(8);
      // Connection secrets never come back, only whether they are set.
      expect(JSON.stringify(await readRadarrView(get, "connections", {}))).not.toContain(key);
    });

    it("changes a movie, stops if it changed meanwhile, reads it back, and puts it back", async () => {
      const [m] = await api<Json[]>("GET", "/api/v3/movie");
      const id = Number(m!.id);
      const planned = await plan("app-arr-edit", {
        resource: "movie",
        id,
        changes: JSON.stringify({ monitored: !m!.monitored, minimumAvailability: "announced" }),
      });
      expect(planned.change!.settings.length).toBe(2);
      expect(await run("app-arr-edit", planned)).toMatchObject({
        ok: true,
        result: expect.stringMatching(/verified/),
      });
      const after = await api("GET", `/api/v3/movie/${id}`);
      expect(after).toMatchObject({ monitored: !m!.monitored, minimumAvailability: "announced" });
      // Path and files untouched by the edit.
      expect(after.path).toBe(m!.path);
      expect(await undo("app-arr-edit", planned)).toMatchObject({ ok: true });
      expect(await api("GET", `/api/v3/movie/${id}`)).toMatchObject({
        monitored: m!.monitored,
        minimumAvailability: m!.minimumAvailability,
      });

      // Someone changes the same setting in Radarr after the plan: the plan stops.
      const now = await api("GET", `/api/v3/movie/${id}`);
      const [target, meanwhile] =
        now.minimumAvailability === "inCinemas"
          ? ["released", "announced"]
          : ["inCinemas", now.minimumAvailability === "announced" ? "released" : "announced"];
      const stale = await plan("app-arr-edit", {
        resource: "movie",
        id,
        changes: JSON.stringify({ minimumAvailability: target }),
      });
      await api("PUT", `/api/v3/movie/${id}?moveFiles=false`, {
        ...now,
        minimumAvailability: meanwhile,
      });
      expect(await run("app-arr-edit", stale)).toMatchObject({ ok: false, stale: true });

      // A different setting changed meanwhile is kept, not overwritten by the plan.
      await api("PUT", `/api/v3/movie/${id}?moveFiles=false`, { ...now });
      const other = await plan("app-arr-edit", {
        resource: "movie",
        id,
        changes: JSON.stringify({ minimumAvailability: target }),
      });
      await api("PUT", `/api/v3/movie/${id}?moveFiles=false`, {
        ...now,
        monitored: !now.monitored,
      });
      expect(await run("app-arr-edit", other)).toMatchObject({ ok: true });
      expect(await api("GET", `/api/v3/movie/${id}`)).toMatchObject({
        monitored: !now.monitored,
        minimumAvailability: target,
      });
      await api("PUT", `/api/v3/movie/${id}?moveFiles=false`, {
        ...(await api("GET", `/api/v3/movie/${id}`)),
        monitored: now.monitored,
        minimumAvailability: now.minimumAvailability,
      });
    });

    it("adds a movie from Radarr's own search once, then removes it keeping files", async () => {
      const found = await api<Json[]>("GET", "/api/v3/movie/lookup?term=Charade%201963");
      const pick = found.find((x) => x.year === 1963)!;
      const have = await api<Json[]>("GET", `/api/v3/movie?tmdbId=${String(pick.tmdbId)}`);
      for (const h of have) await api("DELETE", `/api/v3/movie/${String(h.id)}?deleteFiles=false`);
      const body = JSON.stringify({
        tmdbId: pick.tmdbId,
        qualityProfileId: 1,
        rootFolderPath: "/movies",
        monitored: true,
        minimumAvailability: "released",
        tags: [],
        searchForMovie: false,
      });
      const planned = await plan("app-arr-create", { resource: "movie", body });
      expect(planned.label).toMatch(/Charade/);
      expect(await run("app-arr-create", planned)).toMatchObject({
        ok: true,
        result: expect.stringMatching(/verified/),
      });
      // A retried plan never adds it twice, and a new plan is refused.
      expect(await run("app-arr-create", planned)).toMatchObject({ ok: false, stale: true });
      await expect(plan("app-arr-create", { resource: "movie", body })).rejects.toThrow(/already/);
      const added = await api<Json[]>("GET", `/api/v3/movie?tmdbId=${String(pick.tmdbId)}`);
      expect(added.length).toBe(1);
      expect(added[0]!.path).toBe("/movies/Charade (1963)");

      const remove = await plan("app-arr-delete", {
        resource: "movie",
        id: Number(added[0]!.id),
        deleteFiles: false,
      });
      expect(await run("app-arr-delete", remove)).toMatchObject({ ok: true });
      expect(await api<Json[]>("GET", `/api/v3/movie?tmdbId=${String(pick.tmdbId)}`)).toEqual([]);
    });

    it("adds a tag once and removes it", async () => {
      const planned = await plan("app-arr-create", {
        resource: "tag",
        body: JSON.stringify({ label: tag }),
      });
      expect(await run("app-arr-create", planned)).toMatchObject({ ok: true });
      expect(await run("app-arr-create", planned)).toMatchObject({ ok: false, stale: true });
      const t = (await api<Json[]>("GET", "/api/v3/tag")).find((x) => x.label === tag)!;
      const remove = await plan("app-arr-delete", { resource: "tag", id: Number(t.id) });
      expect(await run("app-arr-delete", remove)).toMatchObject({ ok: true });
    });

    it("makes a custom format that Radarr's own name check matches, scores it, then removes both", async () => {
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

      // D13: the preview is Radarr's own matching, not an approximation.
      const hit = await readRadarrView(get, "parse", {
        title: "Metropolis.1927.1080p.BluRay.x265-GRP",
      });
      expect(JSON.stringify(hit)).toContain(name);
      const miss = await readRadarrView(get, "parse", {
        title: "Metropolis.1927.1080p.BluRay.x264-GRP",
      });
      expect(JSON.stringify(miss)).not.toContain(name);

      const copy = await plan("app-arr-create", {
        resource: "qualityprofile",
        cloneFrom: 1,
        body: JSON.stringify({ name: `Copy ${tag}` }),
      });
      expect(await run("app-arr-create", copy)).toMatchObject({ ok: true });
      const prof = (await api<Json[]>("GET", "/api/v3/qualityprofile")).find(
        (x) => x.name === `Copy ${tag}`,
      )!;
      const score = await plan("app-arr-edit", {
        resource: "qualityprofile",
        id: Number(prof.id),
        changes: JSON.stringify({ formatScores: { [String(cf.id)]: 40 }, upgradeAllowed: true }),
      });
      expect(await run("app-arr-edit", score)).toMatchObject({
        ok: true,
        result: expect.stringMatching(/verified/),
      });
      const scored = await api<{ formatItems: { format: number; score: number }[] }>(
        "GET",
        `/api/v3/qualityprofile/${String(prof.id)}`,
      );
      expect(scored.formatItems.find((f) => f.format === cf.id)?.score).toBe(40);

      for (const [resource, id] of [
        ["qualityprofile", prof.id],
        ["customformat", cf.id],
      ] as const) {
        const r = await plan("app-arr-delete", { resource, id: Number(id) });
        expect(await run("app-arr-delete", r)).toMatchObject({ ok: true });
      }
    });

    it("changes naming and media management settings and puts them back", async () => {
      const naming = await api("GET", "/api/v3/config/naming");
      const n = await plan("app-arr-edit", {
        resource: "naming",
        changes: JSON.stringify({ renameMovies: !naming.renameMovies }),
      });
      expect(await run("app-arr-edit", n)).toMatchObject({ ok: true });
      expect(await undo("app-arr-edit", n)).toMatchObject({ ok: true });
      expect((await api("GET", "/api/v3/config/naming")).renameMovies).toBe(naming.renameMovies);

      const media = await api("GET", "/api/v3/config/mediamanagement");
      const m = await plan("app-arr-edit", {
        resource: "mediamanagement",
        changes: JSON.stringify({ recycleBinCleanupDays: Number(media.recycleBinCleanupDays) + 1 }),
      });
      expect(await run("app-arr-edit", m)).toMatchObject({ ok: true });
      expect(await undo("app-arr-edit", m)).toMatchObject({ ok: true });
      expect((await api("GET", "/api/v3/config/mediamanagement")).recycleBinCleanupDays).toBe(
        media.recycleBinCleanupDays,
      );
    });

    it("adds and removes a release profile and a root folder", async () => {
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
      const made = (await api<Json[]>("GET", "/api/v3/releaseprofile")).find(
        (x) => x.name === `rp ${tag}`,
      )!;
      const rpGone = await plan("app-arr-delete", {
        resource: "releaseprofile",
        id: Number(made.id),
      });
      expect(await run("app-arr-delete", rpGone)).toMatchObject({ ok: true });

      const root = await plan("app-arr-create", {
        resource: "rootfolder",
        body: JSON.stringify({ path: "/downloads" }),
      });
      expect(await run("app-arr-create", root)).toMatchObject({ ok: true });
      const r = (await api<Json[]>("GET", "/api/v3/rootfolder")).find(
        (x) => x.path === "/downloads",
      )!;
      const rootGone = await plan("app-arr-delete", { resource: "rootfolder", id: Number(r.id) });
      expect(await run("app-arr-delete", rootGone)).toMatchObject({ ok: true });
    });

    it("changes a connection's ordinary settings without sending its secret, then removes it", async () => {
      // A disabled download client that points at nothing; Radarr's own "test" is skipped.
      const schema = (await api<Json[]>("GET", "/api/v3/downloadclient/schema")).find(
        (x) => x.implementation === "Transmission",
      )!;
      const fields = (schema.fields as { name: string; value?: unknown }[]).map((f) =>
        f.name === "host"
          ? { ...f, value: "127.0.0.1" }
          : f.name === "password"
            ? { ...f, value: "test-only" }
            : f,
      );
      const dc = await api("POST", "/api/v3/downloadclient?forceSave=true", {
        ...schema,
        name: `dc ${tag}`,
        enable: false,
        fields,
      });
      await expect(
        plan("app-arr-edit", {
          resource: "downloadclient",
          id: Number(dc.id),
          changes: JSON.stringify({ fields: { password: "other" } }),
        }),
      ).rejects.toThrow(/secret/);
      const edit = await plan("app-arr-edit", {
        resource: "downloadclient",
        id: Number(dc.id),
        changes: JSON.stringify({ fields: { movieCategory: "films" } }),
      });
      expect(JSON.stringify(edit)).not.toContain("test-only");
      const done = await run("app-arr-edit", edit);
      expect(done, JSON.stringify(done)).toMatchObject({ ok: true });
      const after = await api<{ fields: { name: string; value: unknown }[] }>(
        "GET",
        `/api/v3/downloadclient/${String(dc.id)}`,
      );
      expect(after.fields.find((f) => f.name === "movieCategory")?.value).toBe("films");
      const gone = await plan("app-arr-delete", { resource: "downloadclient", id: Number(dc.id) });
      expect(await run("app-arr-delete", gone)).toMatchObject({ ok: true });
    });

    it("changes a quality's size limits and puts them back", async () => {
      const defs = await api<Json[]>("GET", "/api/v3/qualitydefinition");
      const d = defs.find((x) => (x.quality as Json).name === "Bluray-1080p")!;
      const max = typeof d.maxSize === "number" ? d.maxSize : 400;
      const planned = await plan("app-arr-edit", {
        resource: "qualitydefinition",
        id: Number(d.id),
        changes: JSON.stringify({
          maxSize: max - 1,
          preferredSize: Math.min(Number(d.preferredSize ?? max - 2), max - 2),
        }),
      });
      expect(await run("app-arr-edit", planned)).toMatchObject({
        ok: true,
        result: expect.stringMatching(/verified/),
      });
      expect((await api("GET", `/api/v3/qualitydefinition/${String(d.id)}`)).maxSize).toBe(max - 1);
      expect(await undo("app-arr-edit", planned)).toMatchObject({ ok: true });
      // Radarr leaves out a size with no limit; back means the same value or no limit again.
      const back = await api("GET", `/api/v3/qualitydefinition/${String(d.id)}`);
      expect(back.maxSize ?? null).toBe(d.maxSize ?? null);
      expect(back.preferredSize ?? null).toBe(d.preferredSize ?? null);
    });

    it("excludes a movie from import lists once and removes the exclusion", async () => {
      const found = await api<Json[]>("GET", "/api/v3/movie/lookup?term=Charade%201963");
      const tmdbId = Number(found.find((x) => x.year === 1963)!.tmdbId);
      const ex = await plan("app-arr-create", {
        resource: "exclusion",
        body: JSON.stringify({ tmdbId }),
      });
      expect(ex.label).toMatch(/Charade \(1963\)/);
      expect(await run("app-arr-create", ex)).toMatchObject({
        ok: true,
        result: expect.stringMatching(/verified/),
      });
      expect(await run("app-arr-create", ex)).toMatchObject({ ok: false, stale: true });
      const made = (await api<Json[]>("GET", "/api/v3/exclusions")).find(
        (x) => x.tmdbId === tmdbId,
      )!;
      const gone = await plan("app-arr-delete", { resource: "exclusion", id: Number(made.id) });
      expect(await run("app-arr-delete", gone)).toMatchObject({
        ok: true,
        result: expect.stringMatching(/gone/),
      });
    });

    it("imports a waiting file into a movie by copying it, then removes that movie with its copy", async () => {
      const file =
        "/downloads/Charade.1963.1080p.BluRay.x264-GRP/Charade.1963.1080p.BluRay.x264-GRP.mkv";
      const waiting = await api<Json[]>(
        "GET",
        "/api/v3/manualimport?folder=%2Fdownloads&filterExistingFiles=true",
      );
      expect(waiting.map((f) => f.path)).toContain(file);
      const found = await api<Json[]>("GET", "/api/v3/movie/lookup?term=Charade%201963");
      const movie = await api("POST", "/api/v3/movie", {
        ...found.find((x) => x.year === 1963)!,
        qualityProfileId: 1,
        rootFolderPath: "/movies",
        monitored: true,
        minimumAvailability: "released",
        addOptions: { searchForMovie: false, monitor: "movieOnly" },
      });
      try {
        const planned = await plan("app-arr-command", {
          command: "ManualImport",
          folder: "/downloads",
          importMode: "copy",
          files: JSON.stringify([{ path: file, movieId: movie.id }]),
        });
        expect(planned.label).toMatch(/copy, the originals stay/);
        const done = await run("app-arr-command", planned);
        expect(done, JSON.stringify(done)).toMatchObject({
          ok: true,
          result: expect.stringMatching(/verified/),
        });
        expect((await api("GET", `/api/v3/movie/${String(movie.id)}`)).hasFile).toBe(true);
        // Copied: the original is still waiting.
        const still = await api<Json[]>(
          "GET",
          "/api/v3/manualimport?folder=%2Fdownloads&filterExistingFiles=true",
        );
        expect(still.map((f) => f.path)).toContain(file);
      } finally {
        await api("DELETE", `/api/v3/movie/${String(movie.id)}?deleteFiles=true`);
      }
    });

    it("runs a refresh, a rescan and a backup, but never an app update", async () => {
      const [m] = await api<Json[]>("GET", "/api/v3/movie");
      for (const params of <StepParams[]>[
        { command: "RefreshMovie", movieIds: String(m!.id) },
        { command: "RescanMovie", movieIds: String(m!.id) },
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
