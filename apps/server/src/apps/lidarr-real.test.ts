import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ActionKind, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { ArrResourceOperations } from "./arr-resource-operations";
import type { Fetch } from "./http";
import { LIDARR_VIEWS, readLidarrView } from "./lidarr-panel";
import type { ServarrGet } from "./servarr-panel";

/**
 * The Lidarr panel's reads and changes against a real, disposable Lidarr with synthetic tracks
 * (checklist 46.10). Skipped unless HEARTH_LIDARR_TEST_URL and HEARTH_LIDARR_TEST_KEY_FILE point
 * at such an instance: never run this against a library anyone uses. Everything it adds it
 * removes again, and everything it changes it puts back.
 */

const url = process.env.HEARTH_LIDARR_TEST_URL;
const keyFile = process.env.HEARTH_LIDARR_TEST_KEY_FILE;
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
const lidarr = { id: "lidarr-test", name: "Lidarr", localUrl: url ?? "", hostId: "h" };
const ops = new ArrResourceOperations(handle, broker, fetchImpl);
const plan = (kind: ActionKind, params: StepParams) =>
  ops.plan(kind, "lidarr", lidarr, params, base);
const step = (kind: ActionKind, planned: PlannedStep) => ({
  kind,
  serviceId: "lidarr-test",
  requestedBy: "you" as const,
  params: planned.params,
  change: planned.change,
});
const run = (kind: ActionKind, planned: PlannedStep) =>
  ops.run(step(kind, planned), "lidarr", lidarr);
const undo = (kind: ActionKind, planned: PlannedStep) =>
  ops.undo(step(kind, planned), "lidarr", lidarr);

type Json = Record<string, unknown>;
async function api<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${url}${path}`, {
    method,
    headers: { "X-Api-Key": key, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
  return (text ? JSON.parse(text) : {}) as T;
}
const get: ServarrGet = async (path) => {
  const r = await fetch(`${url}${path}`, {
    headers: { "X-Api-Key": key },
    signal: AbortSignal.timeout(30_000),
  });
  // Lidarr answers some missing endpoints (quality size limits) with an empty 404.
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => null) };
};
const tag = `t${Date.now().toString(36)}`;
const byName = async (start: string) =>
  (await api<Json[]>("GET", "/api/v1/artist")).find((a) => String(a.artistName).startsWith(start))!;

describe.skipIf(!live)(
  "the Lidarr panel against a real disposable Lidarr",
  { timeout: 120_000 },
  () => {
    it("reads every view the panel shows", async () => {
      const a = await byName("Scott Joplin");
      const [al] = await api<Json[]>("GET", `/api/v1/album?artistId=${String(a.id)}`);
      for (const view of LIDARR_VIEWS) {
        const q: Record<string, string> =
          view === "artist"
            ? { id: String(a.id) }
            : view === "album"
              ? { id: String(al!.id) }
              : view === "lookup"
                ? { title: "Bessie Smith" }
                : view === "imports"
                  ? { folder: "/downloads" }
                  : {};
        const v = await readLidarrView(get, view, q);
        expect(v.meta, view).toMatchObject({ supported: true });
        expect(JSON.stringify(v).includes(key), `${view} holds the key`).toBe(false);
      }
      const lib = await readLidarrView(get, "library", {});
      expect((lib.artists as unknown[]).length).toBeGreaterThanOrEqual(3);
    });

    it("changes an artist and an album, reads them back, and puts them back", async () => {
      const a = await byName("Jelly Roll Morton");
      const id = Number(a.id);
      const edit = await plan("app-arr-edit", {
        resource: "artist",
        id,
        changes: JSON.stringify({ monitorNewItems: a.monitorNewItems === "none" ? "all" : "none" }),
      });
      expect(await run("app-arr-edit", edit)).toMatchObject({
        ok: true,
        result: expect.stringMatching(/verified/),
      });
      expect((await api("GET", `/api/v1/artist/${id}`)).path).toBe(a.path);
      expect(await undo("app-arr-edit", edit)).toMatchObject({ ok: true });
      expect((await api("GET", `/api/v1/artist/${id}`)).monitorNewItems).toBe(a.monitorNewItems);

      const [al] = await api<Json[]>("GET", `/api/v1/album?artistId=${id}`);
      const mon = await plan("app-arr-edit", {
        resource: "album",
        id: Number(al!.id),
        changes: JSON.stringify({ monitored: !al!.monitored }),
      });
      expect(await run("app-arr-edit", mon)).toMatchObject({ ok: true });
      expect((await api("GET", `/api/v1/album/${String(al!.id)}`)).monitored).toBe(!al!.monitored);
      expect(await undo("app-arr-edit", mon)).toMatchObject({ ok: true });
    });

    it("adds an artist from Lidarr's own search once, then removes it keeping files", async () => {
      const found = await api<Json[]>("GET", "/api/v1/artist/lookup?term=Bessie%20Smith");
      const mbid = String(found[0]!.foreignArtistId);
      for (const h of (await api<Json[]>("GET", "/api/v1/artist")).filter(
        (x) => x.foreignArtistId === mbid,
      ))
        await api("DELETE", `/api/v1/artist/${String(h.id)}?deleteFiles=false`);
      const [quality] = await api<Json[]>("GET", "/api/v1/qualityprofile");
      const [metadata] = await api<Json[]>("GET", "/api/v1/metadataprofile");
      const body = JSON.stringify({
        foreignArtistId: mbid,
        qualityProfileId: quality!.id,
        metadataProfileId: metadata!.id,
        rootFolderPath: "/music",
        monitor: "none",
        monitorNewItems: "none",
        searchForMissingAlbums: false,
      });
      const planned = await plan("app-arr-create", { resource: "artist", body });
      expect(planned.label).toMatch(/Bessie Smith/);
      const done = await run("app-arr-create", planned);
      expect(done, JSON.stringify(done)).toMatchObject({
        ok: true,
        result: expect.stringMatching(/verified/),
      });
      expect(await run("app-arr-create", planned)).toMatchObject({ ok: false, stale: true });
      await expect(plan("app-arr-create", { resource: "artist", body })).rejects.toThrow(/already/);
      const added = (await api<Json[]>("GET", "/api/v1/artist")).find(
        (x) => x.foreignArtistId === mbid,
      )!;
      const remove = await plan("app-arr-delete", {
        resource: "artist",
        id: Number(added.id),
        deleteFiles: false,
      });
      expect(await run("app-arr-delete", remove)).toMatchObject({ ok: true });
    });

    it("adds and removes a tag, and excludes an artist from import lists once", async () => {
      const t = await plan("app-arr-create", {
        resource: "tag",
        body: JSON.stringify({ label: tag }),
      });
      expect(await run("app-arr-create", t)).toMatchObject({ ok: true });
      const made = (await api<Json[]>("GET", "/api/v1/tag")).find((x) => x.label === tag)!;
      const tGone = await plan("app-arr-delete", { resource: "tag", id: Number(made.id) });
      expect(await run("app-arr-delete", tGone)).toMatchObject({ ok: true });

      const found = await api<Json[]>("GET", "/api/v1/artist/lookup?term=Bessie%20Smith");
      const mbid = String(found[0]!.foreignArtistId);
      const ex = await plan("app-arr-create", {
        resource: "exclusion",
        body: JSON.stringify({ foreignId: mbid }),
      });
      expect(await run("app-arr-create", ex)).toMatchObject({
        ok: true,
        result: expect.stringMatching(/verified/),
      });
      expect(await run("app-arr-create", ex)).toMatchObject({ ok: false, stale: true });
      const e = (await api<Json[]>("GET", "/api/v1/importlistexclusion")).find(
        (x) => x.foreignId === mbid,
      )!;
      const gone = await plan("app-arr-delete", { resource: "exclusion", id: Number(e.id) });
      expect(await run("app-arr-delete", gone)).toMatchObject({ ok: true });
    });

    it("changes naming and a quality size, and puts them back", async () => {
      const naming = await api("GET", "/api/v1/config/naming");
      const n = await plan("app-arr-edit", {
        resource: "naming",
        changes: JSON.stringify({ renameTracks: !naming.renameTracks }),
      });
      expect(await run("app-arr-edit", n)).toMatchObject({ ok: true });
      expect(await undo("app-arr-edit", n)).toMatchObject({ ok: true });
      expect((await api("GET", "/api/v1/config/naming")).renameTracks).toBe(naming.renameTracks);

      const defs = await api<Json[]>("GET", "/api/v1/qualitydefinition");
      const d = defs.find((x) => (x.quality as Json).name === "MP3-320")!;
      const sz = await plan("app-arr-edit", {
        resource: "qualitydefinition",
        id: Number(d.id),
        changes: JSON.stringify({ minSize: Number(d.minSize ?? 0) + 1 }),
      });
      expect(await run("app-arr-edit", sz)).toMatchObject({ ok: true });
      expect(await undo("app-arr-edit", sz)).toMatchObject({ ok: true });
      expect((await api("GET", `/api/v1/qualitydefinition/${String(d.id)}`)).minSize).toBe(
        d.minSize,
      );
    });

    it("imports a waiting file into its track by copying it, then deletes only that copy", async () => {
      const waiting = await api<Json[]>(
        "GET",
        "/api/v1/manualimport?folder=%2Fdownloads&filterExistingFiles=true",
      );
      const f = waiting[0]!;
      const album = f.album as Json | undefined;
      expect(
        album?.id,
        JSON.stringify({ album: album?.title, rejections: f.rejections }),
      ).toBeTruthy();
      const before = await api<Json[]>("GET", `/api/v1/track?albumId=${String(album!.id)}`);
      const planned = await plan("app-arr-command", {
        command: "ManualImport",
        folder: "/downloads",
        importMode: "copy",
        files: JSON.stringify([{ path: f.path, albumId: album!.id }]),
      });
      expect(planned.label).toMatch(/copy/);
      try {
        const done = await run("app-arr-command", planned);
        expect(done, JSON.stringify(done)).toMatchObject({
          ok: true,
          result: expect.stringMatching(/verified/),
        });
      } finally {
        const after = await api<Json[]>("GET", `/api/v1/track?albumId=${String(album!.id)}`);
        for (const t of after)
          if (t.hasFile && !before.find((b) => b.id === t.id)?.hasFile)
            await api("DELETE", `/api/v1/trackfile/${String(t.trackFileId)}`);
      }
    });

    it("refreshes an artist and runs a backup, but never an app update", async () => {
      const a = await byName("Scott Joplin");
      for (const params of <StepParams[]>[
        { command: "RefreshArtist", artistId: Number(a.id) },
        { command: "Backup" },
      ]) {
        const p = await plan("app-arr-command", params);
        expect(await run("app-arr-command", p), String(params.command)).toMatchObject({ ok: true });
      }
      await expect(plan("app-arr-command", { command: "ApplicationUpdate" })).rejects.toThrow(
        /updates stay in the app/,
      );
    });
  },
);
