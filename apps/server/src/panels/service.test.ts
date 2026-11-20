import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PanelSpec } from "@dragon-control/core";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import * as t from "../db/schema";
import { CustomPanels, PanelSpecError, type PanelApps } from "./service";
import { fakeIntake } from "./intake";

// Custom panels on the server (Ember Panel Builder, Phase 2): only basic panels, reads through the
// apps service (GET only), drafts, Keep and Drop, install refused while a kept block is not real,
// Back to basic and restore. The app here is a stand-in; the browser test uses the fake ZoneMinder.

const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.sqlite.close();
});

async function setup(
  answers: Record<string, unknown> = {},
  opts: ConstructorParameters<typeof CustomPanels>[2] = {},
) {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  handles.push(handle);
  await handle.db.insert(t.hosts).values({
    id: "h1",
    name: "Homeserver",
    role: "server",
    os: "Linux",
    address: "127.0.0.1",
    cpuModel: "x",
    cpuCores: 8,
    cpuUsagePct: 0,
    memTotalGb: 32,
    memUsedGb: 8,
    uptimeHours: 1,
    connection: "this-machine",
    docker: true,
    health: "healthy",
    lastSeenAt: "2026-11-10T00:00:00Z",
  });
  const svc = (id: string, name: string, image: string) => ({
    id,
    name,
    category: "media",
    hostId: "h1",
    kind: "container" as const,
    image,
    health: "healthy" as const,
    autonomyArea: "media",
    checkTarget: `container:${id}`,
    localUrl: "http://10.0.0.9:8484",
  });
  await handle.db
    .insert(t.services)
    .values([
      svc("zm", "ZoneMinder", "zoneminderhq/zoneminder-base"),
      svc("plex", "Plex", "plexinc/pms-docker"),
      svc("pg", "Postgres", "postgres:16"),
      svc("ph", "Pi-hole", "pihole/pihole:latest"),
    ]);
  const calls: { method: string; path: string; by?: string }[] = [];
  const apps: PanelApps = {
    async appApi(_id, req, opts) {
      calls.push({ method: req.method, path: req.path, ...(opts.by ? { by: opts.by } : {}) });
      const body = answers[req.path];
      if (body === undefined)
        return { status: 404, ok: false, body: null, app: "generic", service: "ZoneMinder" };
      return { status: 200, ok: true, body, app: "generic", service: "ZoneMinder" };
    },
    async genericImage() {
      return { type: "image/png", bytes: Buffer.from([1]) };
    },
  };
  return { panels: new CustomPanels(handle, apps, opts), calls, handle };
}

const spec = (over: Partial<PanelSpec> = {}): PanelSpec => ({
  specVersion: 1,
  id: "community.zoneminder.cameras",
  title: "Cameras",
  serviceId: "zm",
  refreshSeconds: 60,
  reads: [
    { id: "monitors", path: "/zm/api/monitors.json" },
    { id: "events", path: "/zm/api/events/index.json" },
  ],
  blocks: [
    { kind: "stat", id: "count", read: "monitors", label: "Cameras", field: "monitors.length" },
    {
      kind: "image-grid",
      id: "snaps",
      read: "monitors",
      items: "monitors",
      image: "/zm/cgi-bin/nph-zms?mode=single&monitor={Monitor.Id}",
    },
    {
      kind: "table",
      id: "recent",
      read: "events",
      items: "events",
      columns: [{ label: "Camera", field: "Event.MonitorId" }],
    },
  ],
  ...over,
});

const monitors = { monitors: [{ Monitor: { Id: "1" } }, { Monitor: { Id: "2" } }] };

describe("custom panels on the server", () => {
  it("a code panel: its page, fixed reads for it, reads on demand and actions only as declared (11-18)", async () => {
    const { panels, calls } = await setup({
      "/api/movies": { results: [{ id: 7, title: "A" }] },
      "/api/movie/7": { id: 7, videos: [{ key: "abcdefghijk" }] },
    });
    const code = spec({
      reads: [
        { id: "movies", path: "/api/movies" },
        { id: "details", path: "/api/movie/{id}" },
      ],
      blocks: [],
      code: "<div id=app></div><script>document.title='x'</script>",
      actions: [
        {
          id: "request",
          label: "Request",
          method: "POST",
          path: "/api/request",
          why: "Requests it",
        },
      ],
    });
    const { run } = await panels.draft("zm", code, "Poster wall");
    // Only the fixed read runs up front; its answer goes to the page.
    expect(run.reads.map((r) => r.path)).toEqual(["/api/movies"]);
    expect(run.values).toEqual({ movies: { results: [{ id: 7, title: "A" }] } });
    // On demand, with the value URL-encoded: never another segment or address.
    expect(await panels.readOne("zm", "draft", "details", { id: 7 })).toMatchObject({ id: 7 });
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/api/movie/7", by: "you" });
    await expect(panels.readOne("zm", "draft", "details", { id: "../../x" })).rejects.toThrow();
    expect(calls.at(-1)?.path).toBe("/api/movie/7");
    await expect(panels.readOne("zm", "draft", "details", {})).rejects.toThrow(/value for \{id\}/);
    await expect(panels.readOne("zm", "draft", "nope", {})).rejects.toThrow(/no read/);
    // An action is only made ready (the owner approves it as a plan), never sent here.
    const before = calls.length;
    expect(
      await panels.action("zm", "draft", "request", {}, { mediaType: "movie", mediaId: 7 }),
    ).toEqual({
      label: "Request",
      method: "POST",
      path: "/api/request",
      body: '{"mediaType":"movie","mediaId":7}',
      why: "Requests it",
    });
    expect(calls.length).toBe(before);
    await expect(panels.action("zm", "draft", "delete-all", {}, undefined)).rejects.toThrow(
      /no action/,
    );
    // Installs while its fixed reads answer.
    expect((await panels.install("zm")).spec.code).toContain("id=app");
  });

  it("refuses placeholders and actions outside code panels, and a code panel whose read fails", async () => {
    const { panels } = await setup({});
    const err = await panels
      .draft("zm", spec({ reads: [{ id: "monitors", path: "/zm/{id}" }] }), undefined)
      .catch((e) => e);
    expect((err as PanelSpecError).issues.map((i) => i.message).join(" ")).toMatch(
      /code panels only/,
    );
    await panels.draft(
      "zm",
      spec({ reads: [{ id: "movies", path: "/api/movies" }], blocks: [], code: "<p>x</p>" }),
      undefined,
    );
    await expect(panels.install("zm")).rejects.toThrow(/read movies/);
  });

  it("builds on Hearth's own app panels, but refuses network and security apps and infrastructure (11-19)", async () => {
    const { panels } = await setup({
      "/zm/api/monitors.json": monitors,
      "/zm/api/events/index.json": { events: [] },
    });
    // Plex has Hearth's own panel: a custom one is a layer over it now.
    const plex = await panels.draft("plex", spec({ serviceId: "plex" }), undefined);
    expect(plex.draft.serviceId).toBe("plex");
    await expect(panels.draft("ph", spec({ serviceId: "ph" }), undefined)).rejects.toThrow(
      /network or security app/,
    );
    await expect(panels.draft("pg", spec({ serviceId: "pg" }), undefined)).rejects.toThrow(
      /infrastructure Hearth only watches/,
    );
    // A tool panel is not a service at all.
    await expect(panels.draft("tool:home-rows", spec(), undefined)).rejects.toThrow(/Not a system/);
  });

  it("refuses a spec for another app, with every problem listed", async () => {
    const { panels } = await setup();
    const err = await panels
      .draft("zm", spec({ serviceId: "plex", refreshSeconds: 5 }), undefined)
      .catch((e) => e);
    expect(err).toBeInstanceOf(PanelSpecError);
    expect((err as PanelSpecError).issues.map((i) => i.message).join(" ")).toMatch(
      /only its own app.*refreshSeconds|refreshSeconds.*only its own app/s,
    );
  });

  it("drafts with reads through the broker (GET only, on Ember's behalf), Keep and Drop, and refuses an install while a kept block has no working read", async () => {
    const { panels, calls } = await setup({ "/zm/api/monitors.json": monitors });
    const d = await panels.draft("zm", spec(), "Your cameras at a glance.", "agent");
    expect(d.draft).toMatchObject({
      status: "draft",
      version: 1,
      note: "Your cameras at a glance.",
    });
    expect(calls.every((c) => c.method === "GET" && c.by === "agent")).toBe(true);
    expect(d.run.blocks.find((b) => b.id === "recent")).toMatchObject({
      state: "not-possible",
      reason: "The app answered 404.",
    });
    await expect(panels.install("zm")).rejects.toThrow(/no working read/);

    await panels.setDropped("zm", ["recent"]);
    // A revised draft keeps what was dropped.
    await panels.draft("zm", spec({ title: "Cameras and events" }), undefined);
    expect((await panels.state("zm")).draft?.dropped).toEqual(["recent"]);

    const inst = await panels.install("zm");
    expect(inst.status).toBe("installed");
    expect(inst.spec.blocks.map((b) => b.id)).toEqual(["count", "snaps"]);
    const s = await panels.state("zm");
    expect(s.draft).toBeUndefined();
    expect(s.installed?.version).toBe(1);
    expect((await panels.data("zm", "installed")).blocks[0]).toMatchObject({
      state: "real",
      view: { value: 2 },
    });
  });

  it("Back to basic keeps the panel; restore brings it back; a new install keeps the previous one", async () => {
    const { panels } = await setup({
      "/zm/api/monitors.json": monitors,
      "/zm/api/events/index.json": { events: [] },
    });
    await panels.draft("zm", spec(), undefined);
    const v1 = await panels.install("zm");
    await panels.draft("zm", spec({ title: "Cameras v2" }), undefined);
    const v2 = await panels.install("zm");
    expect(v2.version).toBe(2);
    let s = await panels.state("zm");
    expect(s.installed?.id).toBe(v2.id);
    expect(s.previous.map((p) => p.id)).toEqual([v1.id]);

    await panels.backToBasic("zm");
    s = await panels.state("zm");
    expect(s.installed).toBeUndefined();
    expect(s.previous).toHaveLength(2);

    await panels.restore("zm", v1.id);
    expect((await panels.state("zm")).installed?.spec.title).toBe("Cameras");
  });

  it("the picture proxy serves only paths the panel's own image blocks make", async () => {
    const { panels } = await setup({
      "/zm/api/monitors.json": monitors,
      "/zm/api/events/index.json": { events: [] },
    });
    await panels.draft("zm", spec(), undefined);
    await expect(
      panels.image("zm", "/zm/cgi-bin/nph-zms?mode=single&monitor=1"),
    ).resolves.toMatchObject({
      type: "image/png",
    });
    await expect(panels.image("zm", "/zm/api/host/getConfig.json")).rejects.toThrow(
      /Not a picture/,
    );
  });
});

/* ---------------- The Free plan's contribution workflow (the owner, 11-10 review) ---------------- */

const answers = {
  "/zm/api/monitors.json": monitors,
  "/zm/api/events/index.json": { events: [{ Event: { MonitorId: "1" } }] },
};

async function free(plan: "free" | "premium" = "free") {
  const fi = fakeIntake();
  let current = plan;
  const env = await setup(answers, {
    plan: async () => current,
    requireBuilder: async (_id, what) => {
      if (current === "free") throw new Error(`${what} is part of Hearth Premium.`);
    },
    intake: fi.intake,
    intakeKeys: () => fi.keys,
    licence: async () => (current === "premium" ? "HEARTHL1.test-licence.sig" : undefined),
  });
  return { ...env, fi, setPlan: (p: "free" | "premium") => (current = p) };
}

/** A small panel: one stat on the monitors read. */
const small = (over: Partial<PanelSpec> = {}): PanelSpec =>
  spec({
    reads: [{ id: "monitors", path: "/zm/api/monitors.json" }],
    blocks: [
      { kind: "stat", id: "count", read: "monitors", label: "Cameras", field: "monitors.length" },
    ],
    ...over,
  });

/** The full panel: new blocks on a new read, new reusable functionality against the small one. */
const bigger = (): PanelSpec => spec();

async function installVia(panels: CustomPanels, s: PanelSpec, by: "agent" | "you" = "agent") {
  await panels.draft("zm", s, undefined, by);
  return panels.install("zm");
}

describe("Panel Builder is Premium (11-14)", () => {
  it("on Free, Ember's drafts are refused and nothing is drafted; with Premium she drafts and it installs at once", async () => {
    const f = await free();
    await expect(f.panels.draft("zm", small(), undefined, "agent")).rejects.toThrow(
      /Building a panel with Ember is part of Hearth Premium/,
    );
    expect((await f.panels.state("zm")).draft).toBeUndefined();
    expect((await f.panels.state("zm")).plan).toBe("free");
    f.setPlan("premium");
    expect(await installVia(f.panels, bigger())).toMatchObject({ status: "installed" });
    expect((await f.panels.state("zm")).plan).toBe("premium");
  });

  it("on Free, loading a panel file, installing and restoring are refused; Back to basic stays free", async () => {
    const f = await free("premium");
    const p = await installVia(f.panels, bigger(), "you");
    f.setPlan("free");
    await expect(f.panels.draft("zm", small(), undefined, "you")).rejects.toThrow(
      /Loading a panel file is part of Hearth Premium/,
    );
    await f.panels.backToBasic("zm");
    expect((await f.panels.state("zm")).installed).toBeUndefined();
    await expect(f.panels.restore("zm", p.id)).rejects.toThrow(
      /Bringing back a custom panel is part of Hearth Premium/,
    );
    f.setPlan("premium");
    await f.panels.restore("zm", p.id);
    expect((await f.panels.state("zm")).installed?.id).toBe(p.id);
  });
});

describe("sharing a panel (Donate) is Premium's and voluntary", () => {
  it("needs Premium and its agreement, and sends only on approval", async () => {
    const f = await free("premium");
    await installVia(f.panels, small(), "you");
    f.setPlan("free");
    await expect(f.panels.submit("zm", { reviewed: true, agreed: true })).rejects.toThrow(
      /Sharing a panel is part of Hearth Premium/,
    );
    f.setPlan("premium");
    await expect(f.panels.submit("zm", { reviewed: false, agreed: true })).rejects.toThrow(
      /approve sending it/,
    );
    await expect(f.panels.submit("zm", { reviewed: true })).rejects.toThrow(
      /agreement has not been accepted/,
    );
    expect(f.fi.received).toHaveLength(0);
    const sub = await f.panels.submit("zm", { reviewed: true, agreed: true });
    expect(sub.version).toBe(1);
    expect(f.fi.received).toHaveLength(1);
    expect((await f.panels.state("zm")).submission?.id).toBe(sub.id);
    // This Hearth's licence goes with it (the service checks it); no credit unless asked.
    expect(f.fi.sentWith[0]).toEqual({ licence: "HEARTHL1.test-licence.sig", credit: {} });
  });

  it("the donor's credit, as they gave it, goes with the panel and nowhere else", async () => {
    const f = await free("premium");
    await installVia(f.panels, small(), "you");
    await f.panels.submit(
      "zm",
      { reviewed: true, agreed: true },
      { name: "Sam", github: "sam-dev" },
    );
    expect(f.fi.sentWith[0]!.credit).toEqual({ name: "Sam", github: "sam-dev" });
    // The published file itself names nobody: the credit is the service's to record.
    expect(JSON.stringify(f.fi.received[0])).not.toContain("sam-dev");
  });

  it("a forged receipt, or one for another panel, is not kept", async () => {
    const f = await free("premium");
    await installVia(f.panels, small());
    for (const mode of ["forged", "wrong-panel"] as const) {
      f.fi.mode(mode);
      await expect(f.panels.submit("zm", { reviewed: true, agreed: true })).rejects.toThrow(
        /could not be verified/,
      );
      expect((await f.panels.state("zm")).submission).toBeUndefined();
    }
  });

  it("with no submission service, sharing says so and building still works", async () => {
    const noService = await setup(answers, { plan: async () => "premium" });
    await noService.panels.draft("zm", small(), undefined, "agent");
    expect(await noService.panels.install("zm")).toMatchObject({ status: "installed" });
    expect((await noService.panels.state("zm")).canSubmit).toBe(false);
    await expect(noService.panels.submit("zm", { reviewed: true, agreed: true })).rejects.toThrow(
      /no submission service/,
    );
  });
});
