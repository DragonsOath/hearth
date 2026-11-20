import { describe, expect, it } from "vitest";
import { APP_INTEGRATIONS } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeImmich } from "./fake-immich";
import { FAKE_PHOTOS, fakeImmich as standIn } from "./fake-immich";
import {
  immichDashboard,
  immichPhotos,
  immichThumbnail,
  ImmichOperations,
  readImmich,
} from "./immich";

/** Immich v3's health read, panel, and controls, against a stand-in answering like 3.2. */

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
const step = (params: PlannedStep["params"]) => ({
  kind: "app-immich-control" as const,
  serviceId: "im",
  requestedBy: "you" as const,
  params,
});
const ops = () => new ImmichOperations(handle, broker, fakeImmich().fetch);

describe("the Immich panel", () => {
  it("shows photos, storage, use per person, and queues with failures first", async () => {
    const d = await immichDashboard(fakeImmich().fetch, BASE, KEY);
    expect(d).toMatchObject({ version: "3.2.4", photos: 48210, videos: 1904, usageGb: 812 });
    expect(d.disk).toEqual({ used: "1.9 TiB", size: "3.6 TiB", free: "1.7 TiB", pct: 52 });
    expect(d.people.map((p) => [p.name, p.usageGb, p.quotaGb])).toEqual([
      ["Alex", 700, undefined],
      ["Sam", 112, 200],
    ]);
    expect(d.queues[0]).toMatchObject({ name: "faceDetection", label: "Finding faces", failed: 7 });
    expect(d.queues[1]).toMatchObject({ name: "thumbnailGeneration", active: 2, waiting: 120 });
  });

  it("reports failed jobs as a warning and refuses a wrong key plainly", async () => {
    const r = await readImmich(BASE, KEY, fakeImmich().fetch);
    expect(r.issues[0]?.text).toBe("Immich's finding faces queue has 7 failed jobs.");
    await expect(readImmich(BASE, "wrong", fakeImmich().fetch)).rejects.toThrow(
      /refused the API key/,
    );
  });

  it("is matched by the server's image, not its database or machine learning", () => {
    const re = APP_INTEGRATIONS.immich.image;
    expect(re.test("ghcr.io/immich-app/immich-server:v3")).toBe(true);
    expect(re.test("ghcr.io/immich-app/immich-machine-learning:v3")).toBe(false);
    expect(re.test("ghcr.io/immich-app/postgres:14")).toBe(false);
    // And by the name you gave it, but not its helpers' names.
    expect(re.test("Immich")).toBe(true);
    expect(re.test("Immich photos")).toBe(true);
    expect(re.test("Immich ML")).toBe(false);
    expect(re.test("immich_postgres")).toBe(false);
    expect(re.test("immich_redis")).toBe(false);
  });
});

describe("Immich controls", () => {
  it("pauses a queue and clears failed jobs, reading both back", async () => {
    const o = ops();
    const pause = await o.plan(service, { op: "pause-queue", queue: "thumbnailGeneration" }, base);
    expect(pause.label).toBe("Pause Thumbnails in Immich (waiting work stays queued)");
    expect(await o.run(step(pause.params), service)).toEqual({
      ok: true,
      result: "Thumbnails is paused. Immich confirms it.",
    });
    const clear = await o.plan(service, { op: "clear-failed", queue: "faceDetection" }, base);
    expect(clear.label).toBe("Clear 7 failed finding faces jobs in Immich (the photos stay)");
    expect(await o.run(step(clear.params), service)).toMatchObject({ ok: true });
    await expect(
      o.plan(service, { op: "clear-failed", queue: "faceDetection" }, base),
    ).rejects.toThrow(/no failed jobs/);
  });

  it("backs up the database and refuses a queue it cannot start", async () => {
    const o = ops();
    const b = await o.plan(service, { op: "backup-database" }, base);
    expect(await o.run(step(b.params), service)).toMatchObject({ ok: true });
    await expect(o.plan(service, { op: "run-missing", queue: "nope" }, base)).rejects.toThrow(
      /does not have/,
    );
  });
});

describe("Immich's recent photos", () => {
  it("lists the newest 20 timeline photos, never archived or locked ones", async () => {
    const d = await immichDashboard(standIn().fetch, BASE, KEY);
    expect(d.recent).toHaveLength(20);
    expect(d.recent![0]).toMatchObject({ name: "IMG_4100.jpg" });
    expect(d.recent!.filter((p) => p.favorite)).toHaveLength(1);
    expect(d.recent!.some((p) => /archived|locked/.test(p.name))).toBe(false);
    const times = d.recent!.map((p) => Date.parse(p.takenAt!));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("still shows the panel when Immich will not list photos", async () => {
    const im = standIn();
    const fetch: typeof im.fetch = (url, init) =>
      url.includes("/search/metadata")
        ? Promise.resolve({ ok: false, status: 403, json: async () => ({}) })
        : im.fetch(url, init);
    const d = await immichDashboard(fetch, BASE, KEY);
    expect(d.recent).toBeUndefined();
    expect(d.photos).toBe(48210);
  });

  it("fetches a thumbnail only for an asset id, and only as a picture", async () => {
    const im = standIn();
    const d = await immichDashboard(im.fetch, BASE, KEY);
    const pic = await immichThumbnail(im.fetch, BASE, KEY, d.recent![0]!.id);
    expect(pic?.type).toBe("image/png");
    expect(pic!.bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(await immichThumbnail(im.fetch, BASE, KEY, "../server/about")).toBeUndefined();
    // An SVG (or a page) from Immich is never passed on: it could run in Hearth's page.
    const svg: typeof im.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      headers: { get: () => "image/svg+xml" },
      arrayBuffer: async () => new ArrayBuffer(4),
    });
    expect(await immichThumbnail(svg, BASE, KEY, d.recent![0]!.id)).toBeUndefined();
  });
});

describe("Immich's Photos tab and sharing", () => {
  it("pages through the whole timeline, newest first, and says when it ends", async () => {
    const im = standIn();
    const one = await immichPhotos(im.fetch, BASE, KEY, 1);
    expect(one.items).toHaveLength(60);
    expect(one.next).toBe(2);
    const two = await immichPhotos(im.fetch, BASE, KEY, 2);
    expect(two.items).toHaveLength(30);
    expect(two.next).toBeUndefined();
    expect(new Set([...one.items, ...two.items].map((p) => p.id)).size).toBe(90);
  });

  it("plans a shared link for a timeline photo, makes it, and reports its address", async () => {
    const ops = new ImmichOperations(handle, broker, standIn().fetch);
    const id = FAKE_PHOTOS[4]!.id;
    const planned = await ops.plan(
      service,
      { op: "share-link", assetId: id, expiresDays: 30 },
      base,
    );
    expect(planned.label).toMatch(/anyone can open to IMG_4096\.jpg.*30 days/);
    expect(planned.change?.settings[0]).toMatchObject({ after: "anyone with the link" });
    const out = await ops.run(
      { ...step(planned.params), params: planned.params! },
      { ...service, publicUrl: "https://photos.example.com" },
    );
    expect(out).toMatchObject({ ok: true, verified: true });
    expect(out.result).toMatch(/Send this link: https:\/\/photos\.example\.com\/share\/share1key/);
  });

  it("never shares a locked or archived photo, or an odd link length", async () => {
    const ops = new ImmichOperations(handle, broker, standIn().fetch);
    await expect(
      ops.plan(
        service,
        { op: "share-link", assetId: "00000000-0000-4000-8000-0000000000bb" },
        base,
      ),
    ).rejects.toThrow(/no such photo on its timeline/);
    await expect(
      ops.plan(service, { op: "share-link", assetId: FAKE_PHOTOS[0]!.id, expiresDays: 3 }, base),
    ).rejects.toThrow(/1, 7 or 30 days/);
  });

  it("fetches the larger preview for the full view", async () => {
    const pic = await immichThumbnail(standIn().fetch, BASE, KEY, FAKE_PHOTOS[0]!.id, "preview");
    expect(pic?.type).toBe("image/png");
  });
});
