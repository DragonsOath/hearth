import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { Fetch } from "./http";
import { paperlessDashboard, paperlessDocuments, pl, readPaperless } from "./paperless";
import { PaperlessOperations, readDocs } from "./paperless-control";

/**
 * The same reads and changes as paperless.test.ts against a real Paperless-ngx: only a throwaway
 * one made for this, with an inbox tag "Inbox", a tag "Bills", a correspondent, a document type,
 * at least two documents and one failed import. It runs only with HEARTH_PAPERLESS_TEST_URL,
 * HEARTH_PAPERLESS_TEST_TOKEN_FILE and HEARTH_PAPERLESS_TEST_THROWAWAY=yes, and puts back what it
 * changes.
 */

const url = process.env.HEARTH_PAPERLESS_TEST_URL ?? "";
const file = process.env.HEARTH_PAPERLESS_TEST_TOKEN_FILE;
const run = Boolean(url && file && process.env.HEARTH_PAPERLESS_TEST_THROWAWAY === "yes");
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const realFetch: Fetch = (u, init) => fetch(u, init) as unknown as ReturnType<Fetch>;

describe.skipIf(!run)(
  `a real, throwaway Paperless-ngx at ${url || "(none)"}`,
  { timeout: 60_000 },
  () => {
    const key = run ? readFileSync(file!, "utf8").trim() : "";
    const service = { id: "real", name: "Paperless-ngx", localUrl: url };
    const broker = {
      use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: key }),
    } as unknown as CredentialBroker;
    const ops = new PaperlessOperations(handle, broker, realFetch);
    const step = (params: PlannedStep["params"]) => ({
      kind: "app-paperless-control" as const,
      serviceId: "real",
      requestedBy: "you" as const,
      params: params!,
    });
    const go = async (params: PlannedStep["params"]) => {
      const planned = await ops.plan(service, params, base);
      const outcome = await ops.run(step(planned.params), service);
      return { planned, outcome, undo: () => ops.undo(step(planned.params), service) };
    };
    const docs = async () =>
      (await paperlessDocuments(realFetch, url, key, {})).items.sort((a, b) => a.id - b.id);

    it("reads the inbox, imports, health, storage and labels, and no text or addresses", async () => {
      const d = await paperlessDashboard(realFetch, url, key);
      expect(d.version).toMatch(/^\d+\.\d+/);
      expect(d.documents).toBeGreaterThanOrEqual(2);
      expect(d.inboxTags.length).toBeGreaterThan(0);
      expect(d.tags.find((t) => t.name === "Inbox")?.inbox).toBe(true);
      expect(d.failed.some((t) => t.name === "Import" && t.file)).toBe(true);
      expect(d.health.map((h) => h.part)).toEqual(
        expect.arrayContaining(["Database", "Redis", "Workers", "Search index"]),
      );
      expect(d.freeGb).toBeGreaterThan(0);
      const json = JSON.stringify(d);
      expect(json).not.toMatch(/redis:\/\/|sqlite3|postgres:\/\//);
      expect(json).not.toContain(key);
      const r = await readPaperless(url, key, realFetch);
      expect(r.issues.map((i) => i.key)).toContain("imports-failed");
    });

    it("searches documents and lists the trash, never with their text", async () => {
      const all = await docs();
      expect(all.length).toBeGreaterThanOrEqual(2);
      const found = await paperlessDocuments(realFetch, url, key, { query: "electricity" });
      expect(found.items.some((x) => /electricity/i.test(x.title))).toBe(true);
      const trash = await paperlessDocuments(realFetch, url, key, { trash: true });
      expect(JSON.stringify(trash)).not.toContain('"content"');
    });

    it("marks an inbox document done and puts it back on undo", async () => {
      const d = await paperlessDashboard(realFetch, url, key);
      const doc = (await docs())[0]!;
      if (!doc.tags.some((t) => d.inboxTags.includes(t)))
        await pl(realFetch, url, key, "POST", "/api/documents/bulk_edit/", {
          documents: [doc.id],
          method: "add_tag",
          parameters: { tag: d.inboxTags[0] },
        });
      await new Promise((r) => setTimeout(r, 3000));
      const r = await go({ op: "inbox-done", documents: String(doc.id) });
      expect(r.outcome).toMatchObject({ ok: true, verified: true });
      await r.undo();
      await new Promise((r) => setTimeout(r, 3000));
      const back = (await readDocs(realFetch, url, key, [doc.id]))[0]!;
      expect(back.tags!.some((t) => d.inboxTags.includes(t))).toBe(true);
    });

    it("tags, sets the correspondent and type, and puts each back", async () => {
      const d = await paperlessDashboard(realFetch, url, key);
      const doc = (await docs())[0]!;
      const bills = d.tags.find((t) => t.name === "Bills")!;
      const t = await go({
        op: doc.tags.includes(bills.id) ? "tag-remove" : "tag-add",
        documents: String(doc.id),
        tagId: bills.id,
      });
      expect(t.outcome).toMatchObject({ ok: true, verified: true });
      expect((await t.undo())?.ok).toBe(true);
      const corr = d.correspondents[0]!;
      const c = await go({
        op: "correspondent",
        documents: String(doc.id),
        value: doc.correspondentId === corr.id ? "" : String(corr.id),
      });
      expect(c.outcome).toMatchObject({ ok: true, verified: true });
      await c.undo();
      const type = d.types[0]!;
      const ty = await go({
        op: "type",
        documents: String(doc.id),
        value: doc.typeId === type.id ? "" : String(type.id),
      });
      expect(ty.outcome).toMatchObject({ ok: true, verified: true });
      await ty.undo();
      await new Promise((r) => setTimeout(r, 3000));
      const after = (await docs())[0]!;
      expect([after.tags.includes(bills.id), after.correspondentId, after.typeId]).toEqual([
        doc.tags.includes(bills.id),
        doc.correspondentId,
        doc.typeId,
      ]);
    });

    it("moves a document to the trash and brings it back", async () => {
      const doc = (await docs()).at(-1)!;
      const r = await go({ op: "trash", documents: String(doc.id) });
      expect(r.outcome).toMatchObject({ ok: true, verified: true });
      expect((await r.undo())?.ok).toBe(true);
      expect((await docs()).some((x) => x.id === doc.id)).toBe(true);
    });

    it("makes a tag, runs the sanity check, and dismisses a failed import", async () => {
      const name = `Hearth test ${Date.now() % 100000}`;
      const t = await go({ op: "tag-create", name });
      expect(t.outcome).toMatchObject({ ok: true, verified: true });
      expect((await t.undo())?.ok).toBe(true);
      const s = await go({ op: "run", task: "sanity_check" });
      expect(s.outcome.ok).toBe(true);
      const failed = (await paperlessDashboard(realFetch, url, key)).failed.find(
        (x) => x.name === "Import",
      );
      if (failed) {
        const r = await go({ op: "dismiss", taskIds: String(failed.id) });
        expect(r.outcome).toMatchObject({ ok: true, verified: true });
      }
      await expect(paperlessDashboard(realFetch, url, "not-a-real-token")).rejects.toThrow(
        /refused the API token/,
      );
    });
  },
);
