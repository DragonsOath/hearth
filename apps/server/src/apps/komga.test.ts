import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeKomga } from "./fake-komga";
import { komgaDashboard, readKomga, unreadableWhy } from "./komga";
import { KomgaOperations } from "./komga-control";

/**
 * Komga against the stand-in (answering as a throwaway 1.30.0 did; komga-real.test.ts runs the same
 * calls against a real one): libraries, unreadable books, who used it and failed sign-ins, and the
 * library tasks as plans.
 */

const BASE = "http://10.0.0.9:25600";
const KEY = "e2e-komga-key";
const service = { id: "km", name: "Komga", localUrl: BASE };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

function setup() {
  const fake = fakeKomga();
  const broker = {
    use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: KEY }),
  } as unknown as CredentialBroker;
  const ops = new KomgaOperations(handle, broker, fake.fetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-komga-control" as const,
    serviceId: "km",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    return { planned, outcome: await ops.run(step(planned.params), service) };
  };
  return { fake, go };
}

describe("reading Komga", () => {
  it("reads libraries, counts, unreadable books, users and failed sign-ins, and no key", async () => {
    const { fake } = setup();
    const d = await komgaDashboard(fake.fetch, BASE, KEY);
    expect(d).toMatchObject({
      version: "1.30.0",
      series: 59,
      books: 642,
      unreadableCount: 1,
      readLists: 3,
      collections: 5,
    });
    expect(d.libraries.map((l) => [l.name, l.series, l.books, l.scanEvery])).toEqual([
      ["Comics", 38, 412, "every 6 hours"],
      ["Manga", 21, 230, "off"],
    ]);
    expect(d.unreadable[0]).toMatchObject({ name: "Harbor Lights v03", why: "ERR_1002" });
    expect(d.users.map((u) => [u.email, u.admin, Boolean(u.lastSeen)])).toEqual([
      ["alex@example.com", true, true],
      ["kid@example.com", false, true],
    ]);
    expect(d.failedSignIns).toHaveLength(6);
    expect(d.history[0]!.text).toBe("Book imported: Lantern Tales v04");
    expect(JSON.stringify(d)).not.toContain(KEY);
  });

  it("reports unreadable books and many failed sign-ins, and refuses a wrong key plainly", async () => {
    const { fake } = setup();
    const r = await readKomga(BASE, KEY, fake.fetch);
    expect(r.issues.map((i) => i.key)).toEqual(["unreadable", "failed-sign-ins"]);
    expect(r.issues[0]!.text).toBe('Komga could not read "Harbor Lights v03": ERR_1002');
    await expect(komgaDashboard(fake.fetch, BASE, "wrong")).rejects.toThrow(/refused the API key/);
    expect(unreadableWhy("UNSUPPORTED", "")).toBe("not a format Komga reads");
  });
});

describe("changing Komga", () => {
  it("scans a library and reads the new count back", async () => {
    const { go } = setup();
    const r = await go({ op: "scan", libraryId: "lib-comics" });
    expect(r.planned.label).toBe("Scan the Comics library for new and changed books in Komga");
    expect(r.outcome).toMatchObject({
      ok: true,
      verified: true,
      result: "Komga scanned Comics: 413 books (was 412).",
    });
  });

  it("starts the other library tasks and reads a broken book again", async () => {
    const { go, fake } = setup();
    for (const op of ["analyze", "refresh-metadata", "empty-trash", "deep-scan"])
      expect((await go({ op, libraryId: "lib-manga" })).outcome.ok).toBe(true);
    const b = await go({ op: "analyze-book", bookId: "b-bad" });
    expect(b.planned.label).toContain("after replacing or fixing its file");
    expect(b.outcome.ok).toBe(true);
    expect((await komgaDashboard(fake.fetch, BASE, KEY)).unreadableCount).toBe(0);
    await expect(go({ op: "scan", libraryId: "nope" })).rejects.toThrow(/no such library/);
  });
});
