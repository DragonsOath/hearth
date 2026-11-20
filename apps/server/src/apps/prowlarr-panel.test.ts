import { describe, expect, it } from "vitest";
import type { ActionKind, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { ArrResourceOperations } from "./arr-resource-operations";
import { fakeProwlarr } from "./fake-prowlarr";
import { PROWLARR_VIEWS, readProwlarrView, scrubUrl } from "./prowlarr-panel";
import { scrubText, type ServarrGet } from "./servarr-panel";

/** Prowlarr's native panel reads and steps, against the stand-in Prowlarr 2.6. */

const KEY = "e2e-prowlarr-key";
const reader = () => {
  const fake = fakeProwlarr();
  const get: ServarrGet = async (path) => {
    const r = await fake.fetch(`http://prowlarr.test:9696${path}`, {
      method: "GET",
      headers: { "X-Api-Key": KEY },
      signal: AbortSignal.timeout(5_000),
    });
    return { ok: r.ok, status: r.status, data: await r.json() };
  };
  return { fake, get };
};

describe("the Prowlarr panel reads", () => {
  it("answers every view without a secret, a key or a download link", async () => {
    const { get } = reader();
    for (const view of PROWLARR_VIEWS) {
      const q =
        view === "indexer"
          ? { id: "1" }
          : view === "definition"
            ? { name: "Generic Torznab" }
            : view === "search"
              ? { query: "lantern season" }
              : {};
      const text = JSON.stringify(await readProwlarrView(get, view, q));
      for (const secret of [
        "secret-indexer-key",
        "hunter2",
        "stand-in-secret",
        "stand-in-passkey",
        "e2e-stand-in-prowlarr-key",
        "downloadUrl",
      ])
        expect(text.includes(secret), `${view}: ${secret}`).toBe(false);
    }
  });

  it("lists indexers with how each is doing, and definitions that need a login", async () => {
    const { get } = reader();
    const ix = await readProwlarrView(get, "indexers", {});
    expect((ix.indexers as { name: string; failing: boolean }[]).find((i) => i.failing)?.name).toBe(
      "Torrent Alpha",
    );
    const defs = await readProwlarrView(get, "definitions", { privacy: "private" });
    expect(defs.definitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Members Only", needsSecret: true }),
      ]),
    );
    const one = await readProwlarrView(get, "indexer", { id: "3" });
    const fields = (one.indexer as { fields: { name: string; secret: boolean; set?: boolean }[] })
      .fields;
    expect(fields.find((f) => f.name === "password")).toMatchObject({ secret: true, set: true });
  });

  it("searches across indexers, best seeded first", async () => {
    const { get } = reader();
    const r = await readProwlarrView(get, "search", { query: "lantern season", indexerIds: "2" });
    const titles = (r.results as { title: string; indexerId: number }[]).map((x) => x.title);
    expect(titles[0]).toBe("Lantern.Season.2024.1080p.WEB-DL.x264-GRP");
    expect((r.results as { indexerId: number }[]).every((x) => x.indexerId === 2)).toBe(true);
  });
});

describe("scrubbing", () => {
  it("hides keys in links and log lines", () => {
    expect(scrubUrl("https://a.example/d/1?passkey=abc&x=1")).toBe(
      "https://a.example/d/1?passkey=hidden&x=1",
    );
    expect(scrubText("GET /api?t=caps&apikey=e2e-key failed")).toBe(
      "GET /api?t=caps&apikey=[hidden] failed",
    );
    expect(scrubText("key 0123456789abcdef0123456789abcdef used")).toBe("key [hidden] used");
  });
});

describe("Prowlarr plan steps", () => {
  const { fake } = reader();
  const broker = {
    use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: KEY }),
  } as unknown as CredentialBroker;
  const handle = {
    db: { insert: () => ({ values: async () => undefined }) },
  } as unknown as DbHandle;
  const ops = new ArrResourceOperations(handle, broker, fake.fetch);
  const svc = { id: "p", name: "Prowlarr", localUrl: "http://prowlarr.test:9696", hostId: "h" };
  const base: PlannedStep = {
    label: "",
    serviceName: "",
    changes: true,
    policy: "approve-first",
    policyReason: "",
  };
  const plan = (kind: ActionKind, params: StepParams) =>
    ops.plan(kind, "prowlarr", svc, params, base);
  const run = (kind: ActionKind, p: PlannedStep) =>
    ops.run(
      { kind, serviceId: "p", requestedBy: "you", params: p.params, change: p.change },
      "prowlarr",
      svc,
    );

  it("adds an indexer from a definition, never with a secret", async () => {
    await expect(
      plan("app-arr-create", {
        resource: "indexer",
        body: JSON.stringify({ definition: "Generic Torznab", fields: { apiKey: "x" } }),
      }),
    ).rejects.toThrow(/secret/);
    const p = await plan("app-arr-create", {
      resource: "indexer",
      body: JSON.stringify({
        definition: "Lantern Public",
        fields: { baseUrl: "https://lantern.mirror" },
      }),
    });
    expect(p.label).toBe('Add the indexer "Lantern Public" (Lantern Public) to Prowlarr');
    expect(await run("app-arr-create", p)).toMatchObject({ ok: true });
    await expect(
      plan("app-arr-create", {
        resource: "indexer",
        body: JSON.stringify({ definition: "Lantern Public" }),
      }),
    ).rejects.toThrow(/already/);
  });

  it("refuses a secret in any new connection", async () => {
    await expect(
      plan("app-arr-create", {
        resource: "indexerproxy",
        body: JSON.stringify({
          name: "Socks",
          implementation: "Socks5",
          fields: [{ name: "password", value: "x", type: "password", privacy: "password" }],
        }),
      }),
    ).rejects.toThrow(/secret/);
  });

  it("sends a search result once, and says to search again when it expired", async () => {
    const p = await plan("app-arr-command", {
      command: "GrabRelease",
      guid: "stand-in-1",
      indexerId: 2,
      releaseTitle: "Lantern.Season.2024.1080p.WEB-DL.x264-GRP",
    });
    expect(p.label).toBe(
      'Send "Lantern.Season.2024.1080p.WEB-DL.x264-GRP" from Torrent Alpha to Stand-in qBittorrent',
    );
    expect(await run("app-arr-command", p)).toMatchObject({
      ok: true,
      result: expect.stringMatching(/verified/),
    });
    expect(await run("app-arr-command", p)).toMatchObject({ ok: false, stale: true });
    const gone = await plan("app-arr-command", {
      command: "GrabRelease",
      guid: "expired",
      indexerId: 2,
      releaseTitle: "Old",
    });
    expect(await run("app-arr-command", gone)).toMatchObject({
      ok: false,
      result: expect.stringMatching(/Search again/),
    });
  });
});
