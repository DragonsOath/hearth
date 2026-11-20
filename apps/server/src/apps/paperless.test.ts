import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakePaperless } from "./fake-paperless";
import {
  cleanMessage,
  paperlessDashboard,
  paperlessDocuments,
  readPaperless,
  toTask,
} from "./paperless";
import { docIds, PaperlessOperations, runPaperless } from "./paperless-control";

/**
 * Paperless-ngx against the stand-in (answering as a throwaway 3.4.2 did; paperless-real.test.ts
 * runs the same calls against a real one): what the panel reads, no document text, token or Redis
 * and database addresses, and every change as a plan read back and undone.
 */

const BASE = "http://10.0.0.9:8000";
const KEY = "e2e-paperless-token";
const service = { id: "pl", name: "Paperless-ngx", localUrl: BASE };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

function setup() {
  const fake = fakePaperless();
  const broker = {
    use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: KEY }),
  } as unknown as CredentialBroker;
  const ops = new PaperlessOperations(handle, broker, fake.fetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-paperless-control" as const,
    serviceId: "pl",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    const outcome = await ops.run(step(planned.params), service);
    return { planned, outcome, undo: () => ops.undo(step(planned.params), service) };
  };
  return { fake, go };
}

describe("reading Paperless-ngx", () => {
  it("reads the inbox, imports, health and labels, and no text, token or addresses", async () => {
    const { fake } = setup();
    const d = await paperlessDashboard(fake.fetch, BASE, KEY);
    expect(d).toMatchObject({
      app: "paperless",
      version: "3.4.2",
      updateTo: "3.5.0",
      documents: 5,
      inboxCount: 3,
      inboxTags: [1],
      freeGb: 120,
      trashCount: 0,
    });
    expect(d.inbox.map((x) => [x.id, x.correspondent, x.type])).toEqual([
      [1, "Acme Power", undefined],
      [2, "City Water", "Invoice"],
      [3, undefined, undefined],
    ]);
    expect(d.failed).toEqual([
      expect.objectContaining({ id: 11, name: "Import", file: "scan-0042.pdf", status: "failed" }),
    ]);
    expect(d.waiting.map((t) => [t.file, t.status])).toEqual([
      ["receipt-hardware-store.jpg", "running"],
    ]);
    expect(d.health.find((h) => h.part === "Classifier")).toMatchObject({ status: "warning" });
    expect(d.tags.find((t) => t.name === "Inbox")).toMatchObject({ inbox: true, count: 3 });
    const json = JSON.stringify(d);
    expect(json).not.toContain("SECRET");
    expect(json).not.toContain(KEY);
  });

  it("reports failed imports and refuses a wrong token plainly", async () => {
    const { fake } = setup();
    const r = await readPaperless(BASE, KEY, fake.fetch);
    expect(r.status).toBe("attention");
    expect(r.issues.map((i) => i.key)).toEqual(["imports-failed"]);
    expect(r.issues[0]!.text).toContain("scan-0042.pdf");
    expect(r.facts).toEqual(expect.arrayContaining([{ label: "In the inbox", value: "3" }]));
    await expect(paperlessDashboard(fake.fetch, BASE, "wrong")).rejects.toThrow(
      /refused the API token/,
    );
  });

  it("searches, filters by tag, and lists the trash without text", async () => {
    const { fake, go } = setup();
    expect((await paperlessDocuments(fake.fetch, BASE, KEY, { query: "bill" })).total).toBe(2);
    expect((await paperlessDocuments(fake.fetch, BASE, KEY, { tagId: 3 })).items[0]!.title).toBe(
      "Tax return 2025",
    );
    await go({ op: "trash", documents: "5" });
    const trash = await paperlessDocuments(fake.fetch, BASE, KEY, { trash: true });
    expect(trash.items.map((x) => x.id)).toEqual([5]);
    expect(trash.items[0]!.deletedAt).toBeDefined();
    expect(JSON.stringify(trash)).not.toContain("SECRET");
  });

  it("words tasks plainly and keeps addresses out of messages", () => {
    expect(toTask({ id: 1, task_name: "train_classifier", status: "SUCCESS" }).name).toBe(
      "Train the classifier",
    );
    expect(cleanMessage("Error 111 connecting to redis://:pw@broker:6379. Refused.")).toBe(
      "Error 111 connecting to (address) Refused.",
    );
    expect(docIds("3, 1 3")).toEqual([3, 1]);
    expect(() => docIds("x")).toThrow(/which documents/);
  });
});

describe("changing Paperless-ngx", () => {
  it("marks inbox documents done and puts them back", async () => {
    const { go, fake } = setup();
    const r = await go({ op: "inbox-done", documents: "1,2,4" });
    // Only the two in the inbox are planned.
    expect(r.planned.label).toBe("Mark 2 documents done in Paperless-ngx (out of the inbox)");
    expect(r.outcome).toMatchObject({ ok: true, verified: true });
    expect((await paperlessDashboard(fake.fetch, BASE, KEY)).inboxCount).toBe(1);
    await r.undo();
    expect((await paperlessDashboard(fake.fetch, BASE, KEY)).inboxCount).toBe(3);
    await expect(go({ op: "inbox-done", documents: "4" })).rejects.toThrow(/not in the inbox/);
  });

  it("tags and untags, and sets and clears correspondent and type, each undone", async () => {
    const { go, fake } = setup();
    const t = await go({ op: "tag-add", documents: "1", tagId: 2 });
    expect(t.planned.label).toBe('Tag Bills on "Electricity bill November" in Paperless-ngx');
    expect(t.outcome.ok).toBe(true);
    await t.undo();
    const c = await go({ op: "correspondent", documents: "1,2", value: "2" });
    expect(c.planned.label).toBe(
      'Set the correspondent of "Electricity bill November" to City Water in Paperless-ngx',
    );
    expect(c.outcome).toMatchObject({ ok: true, verified: true });
    await c.undo();
    const ty = await go({ op: "type", documents: "2", value: "" });
    expect(ty.planned.label).toContain("Clear the document type");
    expect(ty.outcome.ok).toBe(true);
    await ty.undo();
    const inbox = (await paperlessDashboard(fake.fetch, BASE, KEY)).inbox;
    expect(inbox.find((x) => x.id === 1)).toMatchObject({ correspondentId: 1, tags: [1] });
    expect(inbox.find((x) => x.id === 2)).toMatchObject({ correspondentId: 2, typeId: 1 });
    await expect(go({ op: "correspondent", documents: "1", value: "99" })).rejects.toThrow(
      /no such correspondent/,
    );
  });

  it("moves to the trash and brings back, and refuses documents it does not have", async () => {
    const { go } = setup();
    const r = await go({ op: "trash", documents: "4" });
    expect(r.planned.label).toContain("undo brings it back");
    expect(r.outcome).toMatchObject({ ok: true, verified: true });
    expect((await r.undo())?.ok).toBe(true);
    await expect(go({ op: "restore", documents: "4" })).rejects.toThrow(
      /no document 4 in its trash/,
    );
    await expect(go({ op: "trash", documents: "77" })).rejects.toThrow(/no document 77/);
  });

  it("makes a tag, runs maintenance, and dismisses a failed import", async () => {
    const { go, fake } = setup();
    const t = await go({ op: "tag-create", name: "Receipts", inbox: false });
    expect(t.outcome).toMatchObject({ ok: true, verified: true });
    await expect(go({ op: "tag-create", name: "bills" })).rejects.toThrow(/already has a tag/);
    expect((await t.undo())?.ok).toBe(true);
    expect((await go({ op: "run", task: "train_classifier" })).outcome.ok).toBe(true);
    await expect(go({ op: "run", task: "empty_trash" })).rejects.toThrow(/Choose a task/);
    const r = await go({ op: "dismiss", taskIds: "11" });
    expect(r.outcome).toMatchObject({ ok: true, verified: true });
    expect((await paperlessDashboard(fake.fetch, BASE, KEY)).failed).toEqual([]);
  });

  it("refuses a change that went stale before it ran", async () => {
    const { fake } = setup();
    const out = await runPaperless(fake.fetch, BASE, KEY, { op: "restore", documents: "1" });
    expect(out).toMatchObject({ ok: false, stale: true });
  });
});
