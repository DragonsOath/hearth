import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { Fetch } from "./http";
import { FAKE_PHOTOS, fakeImmich } from "./fake-immich";
import { immichThumbnail, ImmichOperations } from "./immich";
import {
  ALBUM_CHUNK,
  albumAssetIds,
  chunk,
  editsFor,
  immichAlbums,
  stateOf,
  storageLayout,
} from "./immich-organize";

/**
 * Organizing photos from Hearth (albums, and Immich's own non-destructive flip and rotate),
 * against the stand-in Immich. Nothing here touches a real library.
 */

const BASE = "http://10.0.0.9:2283";
const KEY = "e2e-im-key";
const service = { id: "im", name: "Immich", localUrl: BASE };
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
const ids = (n: number, from = 0) => FAKE_PHOTOS.slice(from, from + n).map((p) => p.id);

function setup(fetchImpl?: Fetch) {
  const im = fakeImmich();
  const f = fetchImpl ?? im.fetch;
  const ops = new ImmichOperations(handle, broker, f);
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    const outcome = await ops.run(
      { kind: "app-immich-control", serviceId: "im", requestedBy: "you", params: planned.params! },
      service,
    );
    return { planned, outcome };
  };
  return { im, ops, go, fetch: f };
}

describe("albums", () => {
  it("splits big batches into steps of at most 500 photos", () => {
    const list = Array.from({ length: 1234 }, (_, i) => i);
    expect(chunk(list).map((c) => c.length)).toEqual([ALBUM_CHUNK, ALBUM_CHUNK, 234]);
    expect(chunk([])).toEqual([]);
  });

  it("makes an album from chosen photos and reads it back", async () => {
    const { go, fetch } = setup();
    const { planned, outcome } = await go({
      op: "album-create",
      name: "  Utah   Road Trip 2026 ",
      body: ids(5).join(","),
    });
    expect(planned.label).toBe('Make the album "Utah Road Trip 2026" in Immich with 5 photos');
    expect(outcome).toMatchObject({ ok: true, verified: true });
    const albums = await immichAlbums(fetch, BASE, KEY);
    expect(albums).toMatchObject([{ albumName: "Utah Road Trip 2026", assetCount: 5 }]);
    expect((await albumAssetIds(fetch, BASE, KEY, albums[0]!.id)).size).toBe(5);
  });

  it("refuses a second album with the same name, and a step over 500 photos", async () => {
    const { go, ops } = setup();
    await go({ op: "album-create", name: "Trip", body: ids(2).join(",") });
    await expect(
      ops.plan(service, { op: "album-create", name: "trip", body: ids(1).join(",") }, base),
    ).rejects.toThrow(/already has an album called "trip". Add the photos to it instead/);
    const many = Array.from(
      { length: 501 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    await expect(
      ops.plan(service, { op: "album-create", name: "Big", body: many.join(",") }, base),
    ).rejects.toThrow(/at most 500/);
    await expect(
      ops.plan(service, { op: "album-create", name: "Bad", body: "../../etc" }, base),
    ).rejects.toThrow(/not Immich photo ids/);
  });

  it("adds to an existing album, counting photos already in it as done", async () => {
    const { go, fetch } = setup();
    await go({ op: "album-create", name: "Trip", body: ids(3).join(",") });
    const [album] = await immichAlbums(fetch, BASE, KEY);
    const { planned, outcome } = await go({
      op: "album-add",
      albumId: album!.id,
      body: ids(5, 1).join(","),
    });
    expect(planned.change?.settings[0]).toMatchObject({ before: "3 photos" });
    expect(outcome).toMatchObject({ ok: true, verified: true });
    expect((await albumAssetIds(fetch, BASE, KEY, album!.id)).size).toBe(6);
  });

  it("never adds to an album with the same name made after planning, and never makes a second", async () => {
    const { ops, fetch } = setup();
    const planned = await ops.plan(
      service,
      { op: "album-create", name: "Trip", body: ids(4).join(",") },
      base,
    );
    const run = () =>
      ops.run(
        {
          kind: "app-immich-control",
          serviceId: "im",
          requestedBy: "you",
          params: planned.params!,
        },
        service,
      );
    expect(await run()).toMatchObject({ ok: true, verified: true });
    // Run again (a second submission): refused, and the album is as it was.
    expect(await run()).toMatchObject({ ok: false, stale: true });
    expect(await immichAlbums(fetch, BASE, KEY)).toMatchObject([{ assetCount: 4 }]);
    // Someone makes "Hike" in Immich after the plan was made: it is left alone.
    const hike = await ops.plan(
      service,
      { op: "album-create", name: "Hike", body: ids(2, 10).join(",") },
      base,
    );
    await fetch(`${BASE}/api/albums`, {
      method: "POST",
      headers: { "x-api-key": KEY },
      body: JSON.stringify({ albumName: "hike", assetIds: [] }),
      signal: AbortSignal.timeout(1000),
    });
    expect(
      await ops.run(
        { kind: "app-immich-control", serviceId: "im", requestedBy: "you", params: hike.params! },
        service,
      ),
    ).toMatchObject({ ok: false, stale: true, result: /already has an album called "Hike"/ });
    const theirs = (await immichAlbums(fetch, BASE, KEY)).find((a) => a.albumName === "hike");
    expect(theirs?.assetCount).toBe(0);
  });

  it("fills an album made earlier in the same plan, found by its name", async () => {
    const { go, fetch } = setup();
    await go({ op: "album-create", name: "Trip", body: ids(2).join(",") });
    const { outcome } = await go({
      op: "album-add",
      name: "Trip",
      made: true,
      body: ids(3, 2).join(","),
    });
    expect(outcome).toMatchObject({ ok: true, verified: true });
    expect(await immichAlbums(fetch, BASE, KEY)).toMatchObject([{ assetCount: 5 }]);
  });

  it("takes photos out again (the undo), leaving them in Immich", async () => {
    const { go, fetch } = setup();
    await go({ op: "album-create", name: "Trip", body: ids(4).join(",") });
    const [album] = await immichAlbums(fetch, BASE, KEY);
    const { outcome } = await go({
      op: "album-remove",
      albumId: album!.id,
      body: ids(2).join(","),
    });
    expect(outcome).toMatchObject({ ok: true, verified: true });
    expect((await albumAssetIds(fetch, BASE, KEY, album!.id)).size).toBe(2);
  });

  it("adds only photos not already in the album, so undo takes out exactly those", async () => {
    const { go, ops, fetch } = setup();
    await go({ op: "album-create", name: "Trip", body: ids(3).join(",") });
    const [album] = await immichAlbums(fetch, BASE, KEY);
    const planned = await ops.plan(
      service,
      { op: "album-add", albumId: album!.id, body: ids(5).join(",") },
      base,
    );
    expect(String(planned.params?.body).split(",")).toEqual(ids(2, 3));
    expect(planned.change?.settings[1]).toMatchObject({
      name: "Left as they are",
      before: "3 photos",
      after: "already in it",
    });
    const step = {
      kind: "app-immich-control" as const,
      serviceId: "im",
      requestedBy: "you" as const,
      params: planned.params!,
    };
    await ops.run(step, service);
    expect(await ops.undo(step, service)).toMatchObject({ ok: true });
    const left = await albumAssetIds(fetch, BASE, KEY, album!.id);
    expect([...left].sort()).toEqual(ids(3).sort());
    await expect(
      ops.plan(service, { op: "album-add", albumId: album!.id, body: ids(2).join(",") }, base),
    ).rejects.toThrow(/already in "Trip"/);
  });

  it("undoes a new album by removing it once empty, and an edit by putting it back", async () => {
    const { ops, go, fetch } = setup();
    const made = await ops.plan(
      service,
      { op: "album-create", name: "Trip", body: ids(2).join(",") },
      base,
    );
    const step = {
      kind: "app-immich-control" as const,
      serviceId: "im",
      requestedBy: "you" as const,
      params: made.params!,
    };
    await ops.run(step, service);
    expect(await ops.undo(step, service)).toMatchObject({
      ok: true,
      result: /Removed the new album/,
    });
    expect(await immichAlbums(fetch, BASE, KEY)).toEqual([]);

    const id = FAKE_PHOTOS[3]!.id;
    await go({ op: "edit", assetId: id, rotate: 90 });
    const second = await ops.plan(service, { op: "edit", assetId: id, mirrorV: true }, base);
    const edit = { ...step, params: second.params! };
    await ops.run(edit, service);
    expect(await ops.undo(edit, service)).toMatchObject({ ok: true });
    const back = await ops.plan(service, { op: "edit-reset", assetId: id }, base);
    expect(back.change?.settings[0]).toMatchObject({ before: "turned 90° clockwise" });
  });

  it("reports what the storage template does with files on disk", async () => {
    const { fetch } = setup();
    // Immich's default: off, with its default pattern (no album in it).
    expect(await storageLayout(fetch, BASE, KEY)).toMatchObject({
      known: true,
      enabled: false,
      usesAlbum: false,
    });
    // A key that cannot read Immich's settings: the panel says it does not know.
    const noAdmin: Fetch = async (url, init) =>
      String(url).includes("/system-config")
        ? ({ ok: false, status: 403, json: async () => ({}) } as Awaited<ReturnType<Fetch>>)
        : fetch(url, init);
    expect(await storageLayout(noAdmin, BASE, KEY)).toEqual({ known: false });
  });
});

describe("flip and rotate (Immich's own edits)", () => {
  it("writes edits in Immich's order, keeping a crop, and reads them back", () => {
    const crop = { action: "crop" as const, parameters: { x: 0, y: 0, width: 10, height: 10 } };
    const e = editsFor({ rotate: -90, mirrorH: true, mirrorV: false }, [crop]);
    expect(e.map((x) => x.action)).toEqual(["crop", "mirror", "rotate"]);
    expect(stateOf(e)).toEqual({ rotate: 270, mirrorH: true, mirrorV: false });
    expect(editsFor({ rotate: 360, mirrorH: false, mirrorV: false })).toEqual([]);
  });

  it("flips and turns a photo without touching the original, then restores it", async () => {
    const { go, ops, fetch } = setup();
    const id = FAKE_PHOTOS[0]!.id;
    const plain = await immichThumbnail(fetch, BASE, KEY, id);
    const { planned, outcome } = await go({ op: "edit", assetId: id, rotate: 90, mirrorH: true });
    expect(planned.label).toMatch(/flipped left to right, turned 90° clockwise/);
    expect(planned.label).toMatch(/the original file stays as it is/);
    expect(outcome).toMatchObject({ ok: true, verified: true });
    // The edited thumbnail differs; the unedited one is what it was.
    const edited = await immichThumbnail(fetch, BASE, KEY, id);
    const original = await immichThumbnail(fetch, BASE, KEY, id, "thumbnail", false);
    expect(Buffer.from(edited!.bytes).equals(Buffer.from(plain!.bytes))).toBe(false);
    expect(Buffer.from(original!.bytes).equals(Buffer.from(plain!.bytes))).toBe(true);

    await expect(
      ops.plan(service, { op: "edit", assetId: id, rotate: 90, mirrorH: true }, base),
    ).rejects.toThrow(/Nothing would change/);
    const reset = await go({ op: "edit-reset", assetId: id });
    expect(reset.planned.change?.settings[0]).toMatchObject({
      before: "flipped left to right, turned 90° clockwise",
      after: "as taken (the original)",
    });
    expect(reset.outcome).toMatchObject({ ok: true, verified: true });
    await expect(ops.plan(service, { op: "edit-reset", assetId: id }, base)).rejects.toThrow(
      /already shows the original/,
    );
  });

  it("changes nothing when the photo was edited elsewhere after planning", async () => {
    const { go, ops } = setup();
    const id = FAKE_PHOTOS[1]!.id;
    const planned = await ops.plan(service, { op: "edit", assetId: id, mirrorV: true }, base);
    await go({ op: "edit", assetId: id, rotate: 180 });
    expect(
      await ops.run(
        {
          kind: "app-immich-control",
          serviceId: "im",
          requestedBy: "you",
          params: planned.params!,
        },
        service,
      ),
    ).toMatchObject({ ok: false, stale: true });
  });

  it("refuses odd turns, locked photos, and an Immich too old to edit", async () => {
    const { ops, fetch } = setup();
    const id = FAKE_PHOTOS[0]!.id;
    await expect(ops.plan(service, { op: "edit", assetId: id, rotate: 45 }, base)).rejects.toThrow(
      /quarter turns/,
    );
    await expect(
      ops.plan(
        service,
        { op: "edit", assetId: "00000000-0000-4000-8000-0000000000bb", rotate: 90 },
        base,
      ),
    ).rejects.toThrow(/Only photos on the timeline/);
    // Before Immich 2.5 there is no edits endpoint, and thumbnails do not know "edited".
    const old: Fetch = async (url, init) => {
      if (String(url).includes("/edits"))
        return { ok: false, status: 404, json: async () => ({}) } as Awaited<ReturnType<Fetch>>;
      if (String(url).includes("edited=true"))
        return { ok: false, status: 400, json: async () => ({}) } as Awaited<ReturnType<Fetch>>;
      return fetch(url, init);
    };
    const oldOps = new ImmichOperations(handle, broker, old);
    await expect(
      oldOps.plan(service, { op: "edit", assetId: id, rotate: 90 }, base),
    ).rejects.toThrow(/cannot edit photos/);
    expect(await immichThumbnail(old, BASE, KEY, id)).toBeTruthy();
  });
});
