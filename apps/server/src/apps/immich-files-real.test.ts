import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTemplate } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { Fetch } from "./http";
import { immichPhotos, immichThumbnail, ImmichOperations } from "./immich";
import { filesStatus, migrationState } from "./immich-files";
import { immichAlbums } from "./immich-organize";

/**
 * Files and folders, albums and edits against a real, throwaway Immich (3.2.4 in a container made
 * for this, with generated test pictures). It changes that Immich's settings and moves its files,
 * so it runs only when HEARTH_IMMICH_TEST_URL, HEARTH_IMMICH_TEST_KEY_FILE and
 * HEARTH_IMMICH_TEST_THROWAWAY=yes are all set, and it refuses a library with more than 50 photos.
 * Never point it at a library anyone uses. It puts the storage template back as it found it.
 */

const url = process.env.HEARTH_IMMICH_TEST_URL;
const keyFile = process.env.HEARTH_IMMICH_TEST_KEY_FILE;
const throwaway = process.env.HEARTH_IMMICH_TEST_THROWAWAY === "yes";
const key = keyFile ? readFileSync(keyFile, "utf8").trim() : "";
const f = ((u: string, init: Parameters<typeof fetch>[1]) => fetch(u, init)) as unknown as Fetch;
const service = { id: "im", name: "Immich", localUrl: url ?? "" };
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
const c = { fetchImpl: f, base: url ?? "", key, service };
const ops = new ImmichOperations(handle, broker, f);
const go = async (params: PlannedStep["params"]) => {
  const planned = await ops.plan(service, params, base);
  const outcome = await ops.run(
    { kind: "app-immich-control", serviceId: "im", requestedBy: "you", params: planned.params! },
    service,
  );
  return { planned, outcome };
};
async function settle() {
  for (let i = 0; i < 60; i++) {
    const m = await migrationState(c);
    if (m.active === 0 && m.waiting === 0) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Immich's storage template job did not finish in a minute.");
}

describe.skipIf(!(url && key && throwaway))("Files and folders against a throwaway Immich", () => {
  it("is a throwaway: a handful of photos at most", async () => {
    const r = await fetch(`${url}/api/server/statistics`, { headers: { "x-api-key": key } });
    const s = (await r.json()) as { photos: number };
    expect(s.photos).toBeLessThanOrEqual(50);
  });

  it("changes the pattern through a plan, runs Immich's job, and finds files where it says", async () => {
    const start = await filesStatus(c);
    expect(start.storage).toMatchObject({ known: true, canChange: true });
    const was = { enabled: start.storage.enabled, template: start.storage.template };
    try {
      // An album, so the album folder has something in it.
      const photos = start.samples.slice(0, 2).map((s) => s.id);
      const albums = await immichAlbums(f, url!, key);
      const name = "Hearth test album";
      const old = albums.find((a) => a.albumName === name);
      if (old)
        await fetch(`${url}/api/albums/${old.id}`, {
          method: "DELETE",
          headers: { "x-api-key": key },
        });
      expect(
        (await go({ op: "album-create", name, body: photos.join(",") })).outcome,
      ).toMatchObject({
        ok: true,
        verified: true,
      });

      // An album tab lists only that album's photos.
      const made = (await immichAlbums(f, url!, key)).find((a) => a.albumName === name)!;
      expect(made.updatedAt).toBeTruthy();
      const inTab = await immichPhotos(f, url!, key, 1, 60, made.id);
      expect(inTab.items.map((p) => p.id).sort()).toEqual([...photos].sort());

      for (const [folder, file] of [
        ["year", "original"],
        ["album", "date"],
      ] as const) {
        const template = buildTemplate(folder, file);
        const plan = await go({
          op: "storage-template",
          body: JSON.stringify({ enabled: true, template }),
        });
        expect(plan.outcome, plan.outcome.result).toMatchObject({ ok: true, verified: true });
        expect((await go({ op: "storage-migrate" })).outcome).toMatchObject({ ok: true });
        await new Promise((r) => setTimeout(r, 1500));
        await settle();
        const now = await filesStatus(c);
        console.log(JSON.stringify(now.samples.map((s) => [s.name, s.album, s.path, s.expected])));
        for (const s of now.samples.filter((x) => !x.external)) {
          expect(s.inPlace, `${s.name}: ${s.path} vs ${s.expected}`).toBe(true);
          // Immich still finds the photo: its thumbnail loads.
          expect(await immichThumbnail(f, url!, key, s.id)).toBeTruthy();
        }
        // Immich's time zone, worked out from where it filed them (HEARTH_IMMICH_TEST_TZ is the
        // TZ that throwaway Immich runs with; a photo taken near midnight UTC tells them apart).
        const tz = process.env.HEARTH_IMMICH_TEST_TZ;
        // (A year-only pattern tells nothing unless a photo sits near New Year.)
        if (tz && file === "date") {
          expect(now.zone.known).toBe(true);
          expect(now.zone.zones).toContain(tz);
          expect(now.zone.zones).not.toContain("UTC");
        }
        if (folder === "album")
          expect(
            now.samples.filter((s) => s.album === name).every((s) => s.path.includes(`/${name}/`)),
          ).toBe(true);
      }

      // Edits on the real Immich: turn one photo, read it back, restore it.
      const id = photos[0]!;
      expect(
        (await go({ op: "edit", assetId: id, rotate: 90, mirrorH: true })).outcome,
      ).toMatchObject({
        ok: true,
        verified: true,
      });
      expect((await go({ op: "edit-reset", assetId: id })).outcome).toMatchObject({
        ok: true,
        verified: true,
      });
    } finally {
      // Back as it was: the pattern, then Immich's job so files follow it.
      const now = await filesStatus(c);
      if (now.storage.enabled !== was.enabled || now.storage.template !== was.template) {
        await go({ op: "storage-template", body: JSON.stringify(was) });
      }
    }
  }, 180_000);
});
