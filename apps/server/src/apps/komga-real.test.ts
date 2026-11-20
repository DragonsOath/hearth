import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { Fetch } from "./http";
import { komgaDashboard, readKomga } from "./komga";
import { KomgaOperations } from "./komga-control";

/**
 * The same reads and changes as komga.test.ts against a real Komga: only a throwaway one made for
 * this, with one library of comics, one broken file in it, and a new file added after its last scan
 * (so a scan finds something). It runs only with HEARTH_KOMGA_TEST_URL, HEARTH_KOMGA_TEST_KEY_FILE
 * and HEARTH_KOMGA_TEST_THROWAWAY=yes.
 */

const url = process.env.HEARTH_KOMGA_TEST_URL ?? "";
const file = process.env.HEARTH_KOMGA_TEST_KEY_FILE;
const run = Boolean(url && file && process.env.HEARTH_KOMGA_TEST_THROWAWAY === "yes");
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const realFetch: Fetch = (u, init) => fetch(u, init) as unknown as ReturnType<Fetch>;

describe.skipIf(!run)(`a real, throwaway Komga at ${url || "(none)"}`, { timeout: 60_000 }, () => {
  const key = run ? readFileSync(file!, "utf8").trim() : "";
  const service = { id: "real", name: "Komga", localUrl: url };
  const broker = {
    use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: key }),
  } as unknown as CredentialBroker;
  const ops = new KomgaOperations(handle, broker, realFetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-komga-control" as const,
    serviceId: "real",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    return { planned, outcome: await ops.run(step(planned.params), service) };
  };

  it("scans a library and finds the new book, read back by the count", async () => {
    const lib = (await komgaDashboard(realFetch, url, key)).libraries[0]!;
    const r = await go({ op: "scan", libraryId: lib.id });
    expect(r.outcome).toMatchObject({ ok: true, verified: true });
    expect((await komgaDashboard(realFetch, url, key)).libraries[0]!.books).toBeGreaterThan(
      lib.books,
    );
  });

  it("reads libraries, books, unreadable files, users and failed sign-ins, and no key", async () => {
    await fetch(`${url}/api/v1/libraries`, { headers: { "X-API-Key": "wrong-key" } });
    // Komga reads new books in the background after a scan.
    let d = await komgaDashboard(realFetch, url, key);
    for (let i = 0; i < 10 && !d.unreadableCount; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      d = await komgaDashboard(realFetch, url, key);
    }
    expect(d.version).toMatch(/^\d+\.\d+/);
    expect(d.series).toBeGreaterThan(0);
    expect(d.libraries[0]!.scanEvery).toBeTruthy();
    expect(d.unreadableCount).toBeGreaterThan(0);
    expect(d.latest.length).toBeGreaterThan(0);
    expect(d.users.find((u) => u.admin)!.lastSeen).toBeDefined();
    expect(JSON.stringify(d)).not.toContain(key);
    const r = await readKomga(url, key, realFetch);
    expect(r.issues.map((i) => i.key)).toContain("unreadable");
  });

  it("analyzes, refreshes metadata, empties the trash, and reads a broken book again", async () => {
    const d = await komgaDashboard(realFetch, url, key);
    const lib = d.libraries[0]!.id;
    for (const op of ["analyze", "refresh-metadata", "empty-trash"])
      expect((await go({ op, libraryId: lib })).outcome.ok).toBe(true);
    expect((await go({ op: "analyze-book", bookId: d.unreadable[0]!.id })).outcome.ok).toBe(true);
    await expect(komgaDashboard(realFetch, url, "wrong-key")).rejects.toThrow(
      /refused the API key/,
    );
  });
});
