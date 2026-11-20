import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ActionKind, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { ArrResourceOperations } from "./arr-resource-operations";
import type { Fetch } from "./http";
import { PROWLARR_VIEWS, readProwlarrView } from "./prowlarr-panel";
import type { ServarrGet } from "./servarr-panel";

/**
 * The Prowlarr panel's reads and changes against a real, disposable Prowlarr whose only indexer is
 * a mock inside its own network (checklist 46.10g). Skipped unless HEARTH_PROWLARR_TEST_URL and
 * HEARTH_PROWLARR_TEST_KEY_FILE point at such an instance: never run this against one anyone uses.
 * Everything it adds it removes again, and everything it changes it puts back.
 */

const url = process.env.HEARTH_PROWLARR_TEST_URL;
const keyFile = process.env.HEARTH_PROWLARR_TEST_KEY_FILE;
const key = keyFile ? readFileSync(keyFile, "utf8").trim() : "";
const live = Boolean(url && key);

const fetchImpl: Fetch = (u, init) => fetch(u, init);
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
const prowlarr = { id: "prowlarr-test", name: "Prowlarr", localUrl: url ?? "", hostId: "h" };
const ops = new ArrResourceOperations(handle, broker, fetchImpl);
const plan = (kind: ActionKind, params: StepParams) =>
  ops.plan(kind, "prowlarr", prowlarr, params, base);
const step = (kind: ActionKind, planned: PlannedStep) => ({
  kind,
  serviceId: "prowlarr-test",
  requestedBy: "you" as const,
  params: planned.params,
  change: planned.change,
});
const run = (kind: ActionKind, planned: PlannedStep) =>
  ops.run(step(kind, planned), "prowlarr", prowlarr);
const undo = (kind: ActionKind, planned: PlannedStep) =>
  ops.undo(step(kind, planned), "prowlarr", prowlarr);

type Json = Record<string, unknown>;
async function api<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${url}${path}`, {
    method,
    headers: { "X-Api-Key": key, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
  return (text ? JSON.parse(text) : {}) as T;
}
const get: ServarrGet = async (path) => {
  const r = await fetch(`${url}${path}`, {
    headers: { "X-Api-Key": key },
    signal: AbortSignal.timeout(30_000),
  });
  return { ok: r.ok, status: r.status, data: await r.json() };
};
const tag = `t${Date.now().toString(36)}`;
const testIndexer = async () =>
  (await api<Json[]>("GET", "/api/v1/indexer")).find((i) => i.name === "Hearth Test Indexer")!;

describe.skipIf(!live)(
  "the Prowlarr panel against a real disposable Prowlarr",
  { timeout: 90_000 },
  () => {
    it("reads every view, and never returns a download link or the key", async () => {
      const ix = await testIndexer();
      for (const view of PROWLARR_VIEWS) {
        const q: Record<string, string> =
          view === "indexer"
            ? { id: String(ix.id) }
            : view === "definitions"
              ? { term: "torznab" }
              : view === "definition"
                ? { name: "Generic Torznab" }
                : view === "search"
                  ? { query: "metropolis" }
                  : {};
        const v = await readProwlarrView(get, view, q);
        expect(v.meta, view).toMatchObject({ supported: true });
        const text = JSON.stringify(v);
        // Checked as a yes/no so a failure never prints the key.
        expect(text.includes(key), `${view} holds the key`).toBe(false);
        expect(text, view).not.toContain("downloadUrl");
      }
      const found = await readProwlarrView(get, "search", { query: "metropolis" });
      expect((found.results as Json[]).map((r) => r.title)).toEqual(
        expect.arrayContaining(["Metropolis.1927.1080p.BluRay.x265-GRP"]),
      );
      const defs = await readProwlarrView(get, "definitions", {});
      expect(Number(defs.total)).toBeGreaterThan(100);
    });

    it("changes an indexer's priority and sync profile setting, then puts it back", async () => {
      const ix = await testIndexer();
      const planned = await plan("app-arr-edit", {
        resource: "indexer",
        id: Number(ix.id),
        changes: JSON.stringify({ priority: Number(ix.priority) === 10 ? 11 : 10 }),
      });
      expect(await run("app-arr-edit", planned)).toMatchObject({
        ok: true,
        result: expect.stringMatching(/verified/),
      });
      expect(await undo("app-arr-edit", planned)).toMatchObject({ ok: true });
      expect((await testIndexer()).priority).toBe(ix.priority);
      // A secret setting is never sent from a plan.
      await expect(
        plan("app-arr-edit", {
          resource: "indexer",
          id: Number(ix.id),
          changes: JSON.stringify({ fields: { apiKey: "x" } }),
        }),
      ).rejects.toThrow(/secret/);
    });

    it("adds an indexer from a definition once, refuses a secret, and removes it", async () => {
      const name = `Mock ${tag}`;
      const body = (extra: Json = {}) =>
        JSON.stringify({
          definition: "Generic Torznab",
          name,
          fields: { baseUrl: "http://torznab-test:9117", apiPath: "/api", ...extra },
          priority: 30,
        });
      await expect(
        plan("app-arr-create", { resource: "indexer", body: body({ apiKey: "nope" }) }),
      ).rejects.toThrow(/secret/);
      const planned = await plan("app-arr-create", { resource: "indexer", body: body() });
      expect(planned.label).toContain(name);
      const done = await run("app-arr-create", planned);
      expect(done, JSON.stringify(done)).toMatchObject({
        ok: true,
        result: expect.stringMatching(/verified/),
      });
      expect(await run("app-arr-create", planned)).toMatchObject({ ok: false, stale: true });
      await expect(plan("app-arr-create", { resource: "indexer", body: body() })).rejects.toThrow(
        /already/,
      );
      const made = (await api<Json[]>("GET", "/api/v1/indexer")).find((i) => i.name === name)!;
      const gone = await plan("app-arr-delete", { resource: "indexer", id: Number(made.id) });
      expect(await run("app-arr-delete", gone)).toMatchObject({ ok: true });
    });

    it("adds, changes and removes a sync profile, and a tag", async () => {
      const made = await plan("app-arr-create", {
        resource: "appprofile",
        body: JSON.stringify({
          name: `Profile ${tag}`,
          enableRss: true,
          enableAutomaticSearch: true,
          enableInteractiveSearch: true,
          minimumSeeders: 1,
        }),
      });
      expect(await run("app-arr-create", made)).toMatchObject({ ok: true });
      const p = (await api<Json[]>("GET", "/api/v1/appprofile")).find(
        (x) => x.name === `Profile ${tag}`,
      )!;
      const edit = await plan("app-arr-edit", {
        resource: "appprofile",
        id: Number(p.id),
        changes: JSON.stringify({ enableRss: false, minimumSeeders: 3 }),
      });
      expect(await run("app-arr-edit", edit)).toMatchObject({
        ok: true,
        result: expect.stringMatching(/verified/),
      });
      const gone = await plan("app-arr-delete", { resource: "appprofile", id: Number(p.id) });
      expect(await run("app-arr-delete", gone)).toMatchObject({ ok: true });

      const t = await plan("app-arr-create", {
        resource: "tag",
        body: JSON.stringify({ label: tag }),
      });
      expect(await run("app-arr-create", t)).toMatchObject({ ok: true });
      const madeTag = (await api<Json[]>("GET", "/api/v1/tag")).find((x) => x.label === tag)!;
      const tGone = await plan("app-arr-delete", { resource: "tag", id: Number(madeTag.id) });
      expect(await run("app-arr-delete", tGone)).toMatchObject({ ok: true });
    });

    it("changes how an app is synced, keeps its key untouched, and puts it back", async () => {
      const app = (await api<Json[]>("GET", "/api/v1/applications")).find(
        (a) => a.implementation === "Radarr",
      )!;
      const planned = await plan("app-arr-edit", {
        resource: "application",
        id: Number(app.id),
        changes: JSON.stringify({ syncLevel: "addOnly" }),
      });
      expect(JSON.stringify(planned)).not.toContain('apiKey":"');
      expect(await run("app-arr-edit", planned)).toMatchObject({
        ok: true,
        result: expect.stringMatching(/verified/),
      });
      expect(await undo("app-arr-edit", planned)).toMatchObject({ ok: true });
      expect((await api<Json>("GET", `/api/v1/applications/${String(app.id)}`)).syncLevel).toBe(
        app.syncLevel,
      );
      // The app still works afterwards: its key was sent back as Prowlarr's own placeholder.
      const sync = await plan("app-arr-command", { command: "ApplicationIndexerSync" });
      expect(await run("app-arr-command", sync)).toMatchObject({ ok: true });
    });

    it("sends a search result to the download client once", async () => {
      const found = await readProwlarrView(get, "search", { query: "general 1926" });
      const r = (found.results as Json[])[0]!;
      const planned = await plan("app-arr-command", {
        command: "GrabRelease",
        guid: String(r.guid),
        indexerId: Number(r.indexerId),
        releaseTitle: String(r.title),
      });
      expect(planned.label).toMatch(/The\.General\.1926/);
      const done = await run("app-arr-command", planned);
      expect(done, JSON.stringify(done)).toMatchObject({
        ok: true,
        result: expect.stringMatching(/verified/),
      });
      expect(await run("app-arr-command", planned)).toMatchObject({ ok: false, stale: true });
    });

    it("runs a backup and a health check, but never an app update", async () => {
      for (const command of ["Backup", "CheckHealth"]) {
        const p = await plan("app-arr-command", { command });
        expect(await run("app-arr-command", p), command).toMatchObject({ ok: true });
      }
      await expect(plan("app-arr-command", { command: "ApplicationUpdate" })).rejects.toThrow(
        /updates stay in the app/,
      );
    });
  },
);
