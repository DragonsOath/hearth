import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ManualSortConfig } from "@dragon-control/core";
import { SERVER_ROOT } from "../config";
import type { CredentialBroker } from "../credentials/broker";
import { openDatabase, runMigrations } from "../db/client";
import * as t from "../db/schema";
import type { PlannedStep } from "../jobs/operations";
import { getSetting } from "../store/settings";
import { fakeApps } from "./fake-apps";
import { SKIP_TAG } from "./manual-sort";
import { TorrentOperations } from "./torrent-operations";

// Sorting manual downloads (the owner, 2026-11-07): a finished torrent with no category is judged
// by its files, filed into its type's category (qBittorrent moves it), and handed to Radarr, which
// adds a film it lacks (no search) and imports it. Unclear ones go to Unsorted; Undo puts one back
// for good; "file as" sorts one the owner names. Torrents with a category are never touched.

const QBT = "http://10.0.0.5:8090";
const RADARR = "http://10.0.0.5:7879";
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const broker = {
  use: (_s: unknown, fn: (c: { value: string; username?: string }) => unknown) =>
    fn({ value: "e2e-key", username: "admin" }),
} as unknown as CredentialBroker;

async function setup() {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  await handle.db.insert(t.hosts).values({
    id: "h1",
    name: "Home Server",
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
    lastSeenAt: "2026-11-07T00:00:00Z",
  });
  for (const [id, name, image, localUrl] of [
    ["qbt", "qBittorrent", "lscr.io/linuxserver/qbittorrent", QBT],
    ["radarr", "Radarr", "lscr.io/linuxserver/radarr", RADARR],
  ] as const)
    await handle.db.insert(t.services).values({
      id,
      name,
      category: "media",
      hostId: "h1",
      kind: "container",
      image,
      localUrl,
      health: "healthy",
      autonomyArea: "media",
    });
  const apps = fakeApps();
  const ops = new TorrentOperations(handle, broker, apps.fetch, undefined, async () => undefined);
  const service = { id: "qbt", name: "qBittorrent", localUrl: QBT, hostId: "h1" };
  const plan = (params: Record<string, unknown>) =>
    ops.plan("app-qbt-manual-sort", service, params as PlannedStep["params"], base);
  const run = async (params: Record<string, unknown>) => {
    const planned = await plan(params);
    return ops.run(
      {
        kind: "app-qbt-manual-sort",
        serviceId: "qbt",
        requestedBy: "you",
        params: planned.params,
        change: planned.change,
        job: { id: "job-1", seq: 0, approvedAt: new Date().toISOString() },
      },
      service,
    );
  };
  const qbtTorrents = async () =>
    (await (await apps.fetch(`${QBT}/api/v2/torrents/info`, QB_INIT)).json()) as {
      hash: string;
      category: string;
      save_path: string;
      tags: string;
    }[];
  return { handle, apps, ops, service, plan, run, qbtTorrents };
}

const QB_INIT = {
  headers: { Cookie: "QBT_SID_8090=e2e-session" },
  signal: AbortSignal.timeout(5000),
};
const FILM = "d4e5f60718293a4b5c6d7e8f9012345678901a2b";
const MYSTERY = "e5f60718293a4b5c6d7e8f9012345678901a2b3c";

describe("sorting manual downloads", () => {
  it("proposes a setup from the apps, then sorts, hands on, keeps Unsorted, and undoes", async () => {
    const { handle, apps, ops, service, plan, run, qbtTorrents } = await setup();
    const view = await ops.sorter.view(service);
    expect(view.config).toBeUndefined();
    const proposal = view.proposal!;
    expect(proposal.types.movie).toMatchObject({
      app: "radarr",
      appServiceId: "radarr",
      create: true,
    });
    expect(proposal.types.movie!.category).toBe("manual-movies");

    const config: ManualSortConfig = { ...proposal, sab: [] };
    const planned = await plan({
      mode: "setup",
      config: JSON.stringify(config),
      includeExisting: true,
    });
    expect(planned.change?.summary).toBe("Sort manual downloads in qBittorrent");
    expect(JSON.stringify(planned.change)).toContain("then Radarr imports it");
    const done = await run({
      mode: "setup",
      config: JSON.stringify(config),
      includeExisting: true,
    });
    expect(done.ok).toBe(true);
    expect(done.result).toContain('"manual-movies"');
    const cats = (await (
      await apps.fetch(`${QBT}/api/v2/torrents/categories`, QB_INIT)
    ).json()) as Record<string, unknown>;
    expect(cats).toHaveProperty("manual-movies");
    expect(cats).toHaveProperty("unsorted");

    // Two finished torrents added by hand.
    apps.control({ manualTorrents: true });
    const before = await qbtTorrents();
    await ops.sorter.tick();
    const after = await qbtTorrents();
    expect(after.find((x) => x.hash === FILM)?.category).toBe("manual-movies");
    expect(after.find((x) => x.hash === MYSTERY)?.category).toBe("unsorted");
    // The apps' own downloads are untouched.
    for (const tor of before.filter((x) => x.category))
      expect(after.find((x) => x.hash === tor.hash)?.category).toBe(tor.category);

    // The next pass sees the move done and hands the film to Radarr (added first, no search).
    await ops.sorter.tick();
    let log = (await getSetting(handle.db, "manual_sort_log"))!;
    const film = log.find((e) => e.ref === FILM)!;
    expect(film.type).toBe("movie");
    expect(film.status).toBe("sent");
    expect(film.message).toContain("Radarr is importing it");
    await ops.sorter.tick();
    log = (await getSetting(handle.db, "manual_sort_log"))!;
    expect(log.find((e) => e.ref === FILM)?.status).toBe("done");
    expect(log.find((e) => e.ref === MYSTERY)?.status).toBe("unsorted");

    // You say what it is: filed as a movie.
    const mystery = log.find((e) => e.ref === MYSTERY)!;
    const filed = await run({ mode: "file", event: mystery.id, type: "movie" });
    expect(filed.ok).toBe(true);
    expect((await qbtTorrents()).find((x) => x.hash === MYSTERY)?.category).toBe("manual-movies");

    // Undo: no category, tagged so it is never sorted again.
    const undone = await run({ mode: "undo", event: film.id });
    expect(undone.ok).toBe(true);
    const back = (await qbtTorrents()).find((x) => x.hash === FILM)!;
    expect(back.category).toBe("");
    expect(back.tags).toContain(SKIP_TAG);
    await ops.sorter.tick();
    expect((await qbtTorrents()).find((x) => x.hash === FILM)?.category).toBe("");

    // Off: nothing more is sorted.
    expect((await run({ mode: "off" })).ok).toBe(true);
    expect((await getSetting(handle.db, "manual_sort"))!.qbt!.enabled).toBe(false);
  });

  it("refuses an unreadable setup and an unknown mode", async () => {
    const { plan } = await setup();
    await expect(plan({ mode: "setup", config: "{" })).rejects.toThrow(/not readable/);
    await expect(plan({ mode: "nope" })).rejects.toThrow(/Say what to do/);
  });
});
