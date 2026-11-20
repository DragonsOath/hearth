import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeKavita } from "./fake-kavita";
import { kavitaDashboard, KavitaOperations, readKavita } from "./kavita";

/** Kavita's health read, panel, and controls, against a stand-in that logs in like Kavita. */

const BASE = "http://10.0.0.9:5000";
const KEY = "e2e-kv-key";
const service = { id: "kv", name: "Kavita", localUrl: BASE };
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
  kind: "app-kavita-control" as const,
  serviceId: "kv",
  requestedBy: "you" as const,
  params,
});

describe("the Kavita panel", () => {
  it("trades the key for a token and shows what is in it, libraries, and unreadable files", async () => {
    const d = await kavitaDashboard(fakeKavita().fetch, BASE, KEY);
    expect(d).toMatchObject({
      version: "0.8.8.3",
      series: 420,
      files: 11020,
      sizeGb: 210,
      readingHours: 312,
    });
    expect(d.libraries[0]).toMatchObject({ name: "Manga", kind: "manga", folders: 1 });
    expect(d.libraries[1]).toMatchObject({ name: "Books", kind: "books", folders: 2 });
    expect(d.libraries[1]?.lastScanned).toBeUndefined();
    expect(d.unreadable).toEqual({
      count: 1,
      files: [
        { file: "broken.epub", where: "Books · Broken", why: "The file is not a valid EPUB" },
      ],
    });
  });

  it("warns about unreadable files, and refuses a wrong key plainly", async () => {
    const r = await readKavita(BASE, KEY, fakeKavita().fetch);
    expect(r.issues[0]?.text).toBe("Kavita could not read 1 files.");
    await expect(readKavita(BASE, "wrong", fakeKavita().fetch)).rejects.toThrow(
      /refused the API key/,
    );
  });
});

describe("Kavita controls", () => {
  it("scans one library and backs up the database", async () => {
    const o = new KavitaOperations(handle, broker, fakeKavita().fetch);
    const scan = await o.plan(service, { op: "scan-library", libraryId: 2 }, base);
    expect(scan.label).toBe("Scan the Books library in Kavita");
    expect(await o.run(step(scan.params), service)).toEqual({
      ok: true,
      result: "Kavita is scanning Books; new files show up as it finds them.",
    });
    const b = await o.plan(service, { op: "backup-db" }, base);
    expect(await o.run(step(b.params), service)).toEqual({
      ok: true,
      result: "Kavita is backing up its database.",
    });
  });
});
