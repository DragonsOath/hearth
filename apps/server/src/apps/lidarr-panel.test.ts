import { describe, expect, it } from "vitest";
import type { ActionKind, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { ArrResourceOperations } from "./arr-resource-operations";
import { fakeLidarr } from "./fake-lidarr";
import { LIDARR_VIEWS, readLidarrView } from "./lidarr-panel";
import type { ServarrGet } from "./servarr-panel";

/** Lidarr's native panel reads and steps, against the stand-in Lidarr 3.1. */

const KEY = "e2e-lidarr-key";
const setup = () => {
  const fake = fakeLidarr();
  const get: ServarrGet = async (path) => {
    const r = await fake.fetch(`http://lidarr.test:8686${path}`, {
      method: "GET",
      headers: { "X-Api-Key": KEY },
      signal: AbortSignal.timeout(5_000),
    });
    return { ok: r.ok, status: r.status, data: await r.json() };
  };
  const broker = {
    use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: KEY }),
  } as unknown as CredentialBroker;
  const handle = {
    db: { insert: () => ({ values: async () => undefined }) },
  } as unknown as DbHandle;
  const ops = new ArrResourceOperations(handle, broker, fake.fetch);
  const svc = { id: "l", name: "Lidarr", localUrl: "http://lidarr.test:8686", hostId: "h" };
  const base: PlannedStep = {
    label: "",
    serviceName: "",
    changes: true,
    policy: "approve-first",
    policyReason: "",
  };
  const plan = (kind: ActionKind, params: StepParams) =>
    ops.plan(kind, "lidarr", svc, params, base);
  const run = (kind: ActionKind, p: PlannedStep) =>
    ops.run(
      { kind, serviceId: "l", requestedBy: "you", params: p.params, change: p.change },
      "lidarr",
      svc,
    );
  return { get, plan, run };
};

describe("the Lidarr panel reads", () => {
  it("answers every view", async () => {
    const { get } = setup();
    for (const view of LIDARR_VIEWS) {
      const q =
        view === "artist"
          ? { id: "1" }
          : view === "album"
            ? { id: "32" }
            : view === "lookup"
              ? { title: "lantern" }
              : view === "imports"
                ? { folder: "/downloads" }
                : {};
      const v = await readLidarrView(get, view, q);
      expect(v.meta, view).toMatchObject({ version: "3.1.0.4875", supported: true });
    }
  });

  it("lists artists with what is on disk, an artist's albums newest first, and an album's tracks", async () => {
    const { get } = setup();
    const lib = await readLidarrView(get, "library", {});
    const radiohead = (
      lib.artists as { name: string; stats: { files: number; total: number } }[]
    ).find((a) => a.name === "Radiohead");
    expect(radiohead?.stats).toMatchObject({ files: 3, total: 9 });
    const artist = await readLidarrView(get, "artist", { id: "1" });
    expect((artist.albums as { title: string }[]).map((a) => a.title)).toEqual([
      "Kid A",
      "OK Computer",
      "Pablo Honey",
    ]);
    const album = await readLidarrView(get, "album", { id: "32" });
    expect((album.tracks as { title: string; hasFile: boolean }[])[1]).toMatchObject({
      title: "Paranoid Android",
      hasFile: true,
    });
  });
});

describe("Lidarr plan steps", () => {
  it("monitors an album and changes an artist's metadata profile, in words", async () => {
    const { plan, run } = setup();
    const p = await plan("app-arr-edit", {
      resource: "album",
      id: 42,
      changes: JSON.stringify({ monitored: false }),
    });
    expect(p.label).toContain("Homogenic");
    expect(await run("app-arr-edit", p)).toMatchObject({
      ok: true,
      result: expect.stringMatching(/verified/),
    });
    const a = await plan("app-arr-edit", {
      resource: "artist",
      id: 2,
      changes: JSON.stringify({ metadataProfileId: 2 }),
    });
    expect(a.change!.settings[0]).toMatchObject({ before: "Standard (#1)", after: "None (#2)" });
    await expect(
      plan("app-arr-edit", {
        resource: "artist",
        id: 2,
        changes: JSON.stringify({ path: "/elsewhere" }),
      }),
    ).rejects.toThrow(/moves its files/);
  });

  it("adds an artist from Lidarr's search once", async () => {
    const { plan, run } = setup();
    const body = JSON.stringify({
      foreignArtistId: "6c0f1d2e-1111-4a2b-9c3d-123456789abc",
      qualityProfileId: 1,
      metadataProfileId: 1,
      rootFolderPath: "/music",
      monitor: "all",
      monitorNewItems: "all",
    });
    const p = await plan("app-arr-create", { resource: "artist", body });
    expect(p.label).toBe("Add The Lantern Choir to Lidarr");
    expect(await run("app-arr-create", p)).toMatchObject({ ok: true });
    expect(await run("app-arr-create", p)).toMatchObject({ ok: false, stale: true });
  });

  it("imports a waiting file into its track, and searches for an album", async () => {
    const { plan, run } = setup();
    const p = await plan("app-arr-command", {
      command: "ManualImport",
      folder: "/downloads",
      importMode: "copy",
      files: JSON.stringify([{ path: "/downloads/Bjork-Homogenic-1997-FLAC/01 - Hunter.flac" }]),
    });
    expect(p.change!.settings[0]!.after).toContain("Homogenic: 1. Hunter");
    expect(await run("app-arr-command", p)).toMatchObject({
      ok: true,
      result: expect.stringMatching(/verified/),
    });
    const s = await plan("app-arr-command", { command: "AlbumSearch", albumIds: "31" });
    expect(s.label).toBe("Search for the album in Lidarr: Kid A");
    expect(await run("app-arr-command", s)).toMatchObject({ ok: true });
  });
});
