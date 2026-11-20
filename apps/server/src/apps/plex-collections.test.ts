import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakePlex } from "./fake-plex";
import { PlexOperations } from "./plex-control";

// Plex collections from Hearth (the Forge collection workflow, checklist 45.15): add titles one
// by one (the first creates the collection), take one out, delete a collection; every change is
// read back from the collection's members.

const BASE = "http://10.0.0.9:32400";
const TOKEN = "e2e-plex-token";
const service = { id: "plex", name: "Plex", localUrl: BASE };
const broker = {
  use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: TOKEN }),
} as unknown as CredentialBroker;
const handle = {
  db: {
    insert: () => ({ values: async () => undefined }),
    select: () => ({ from: async () => [] }),
  },
} as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const step = (params: PlannedStep["params"]) => ({
  kind: "app-plex-control" as const,
  serviceId: "plex",
  requestedBy: "you" as const,
  params,
});

describe("Plex collections", () => {
  it("creates a collection with the first title, adds the next, and reads both back", async () => {
    const plex = fakePlex();
    const o = new PlexOperations(handle, broker, plex.fetch);
    // Both planned before either runs (as a plan of several steps is).
    const a = await o.plan(
      service,
      { op: "collection-add", ratingKey: "101", collection: "Test Picks" },
      base,
    );
    const b = await o.plan(
      service,
      { op: "collection-add", ratingKey: "102", collection: "Test Picks" },
      base,
    );
    expect(a.label).toBe("Add Harbor Lights to “Test Picks” in Plex");
    expect(a.change?.settings.at(-1)?.after).toMatch(/the first title added creates it/);
    const r1 = await o.run(step(a.params), service);
    expect(r1).toMatchObject({ ok: true, verified: true });
    expect(r1.result).toMatch(/collection created/);
    const r2 = await o.run(step(b.params), service);
    expect(r2).toMatchObject({ ok: true, verified: true });
    expect(r2.result).toMatch(/2 titles now/);
    // Run again: already in it, nothing changed (a retried plan never adds twice).
    expect(await o.run(step(b.params), service)).toMatchObject({ ok: false, stale: true });
    // And planning it again is refused for the same reason.
    await expect(
      o.plan(service, { op: "collection-add", ratingKey: "102", collection: "test picks" }, base),
    ).rejects.toThrow(/already in/);
  });

  it("takes one title out and deletes the collection, the titles staying in the library", async () => {
    const plex = fakePlex();
    const o = new PlexOperations(handle, broker, plex.fetch);
    for (const k of ["101", "102"]) {
      const s = await o.plan(
        service,
        { op: "collection-add", ratingKey: k, collection: "Gone Soon" },
        base,
      );
      await o.run(step(s.params), service);
    }
    const out = await o.plan(
      service,
      { op: "collection-remove", ratingKey: "101", collection: "Gone Soon" },
      base,
    );
    expect(await o.run(step(out.params), service)).toMatchObject({ ok: true, verified: true });
    const key = String(out.params?.collectionKey);
    const del = await o.plan(service, { op: "collection-delete", collectionKey: key }, base);
    expect(del.change?.settings[0]).toEqual({
      name: "“Gone Soon”",
      before: "1 title",
      after: "deleted",
    });
    expect(await o.run(step(del.params), service)).toMatchObject({ ok: true, verified: true });
    expect(await o.run(step(del.params), service)).toMatchObject({ ok: false, stale: true });
    // The movie itself is still in Plex.
    const still = await o.plan(service, { op: "refresh-item", ratingKey: "101" }, base);
    expect(still.label).toMatch(/Harbor Lights/);
  });
  it("renames a collection, read back, and refuses a stale plan", async () => {
    const plex = fakePlex();
    const o = new PlexOperations(handle, broker, plex.fetch);
    const made = await o.plan(
      service,
      { op: "collection-add", ratingKey: "101", collection: "Old Name" },
      base,
    );
    await o.run(step(made.params), service);
    const key = String(
      (
        await o.plan(
          service,
          { op: "collection-remove", ratingKey: "101", collection: "Old Name" },
          base,
        )
      ).params?.collectionKey,
    );
    const r = await o.plan(
      service,
      { op: "collection-rename", collectionKey: key, collection: "  New   Name " },
      base,
    );
    expect(r.change?.settings[0]).toEqual({ name: "Name", before: "Old Name", after: "New Name" });
    expect(await o.run(step(r.params), service)).toMatchObject({ ok: true, verified: true });
    // Planned against the old name: refused, nothing changed.
    expect(await o.run(step(r.params), service)).toMatchObject({ ok: false, stale: true });
    await expect(
      o.plan(
        service,
        { op: "collection-rename", collectionKey: key, collection: "New Name" },
        base,
      ),
    ).rejects.toThrow(/already/);
  });
});
