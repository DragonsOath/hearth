import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HEALTH_SETTINGS, type DownloadHealthItem } from "@dragon-control/core";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import { setSetting } from "../store/settings";
import { downloadsAnalyzer } from "./analyzers/downloads";

const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

const now = new Date("2026-11-10T20:00:00Z");
const item = (o: Partial<DownloadHealthItem>): DownloadHealthItem => ({
  key: "qbt:1",
  title: "A Court of Frost and Starlight",
  app: "Chaptarr",
  appServiceId: "chaptarr",
  client: "qBittorrent",
  clientServiceId: "qbit",
  problem: "stalled",
  state: "attention",
  strikes: 3,
  explain: "This download isn't making progress. No peers have been found recently.",
  since: "2026-11-08T04:55:00Z",
  ...o,
});

async function withHealth(items: DownloadHealthItem[], checkedAt = now.toISOString()) {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  handles.push(handle);
  await setSetting(handle.db, "download_health", {
    strikes: {},
    overview: {
      checkedAt,
      downloading: 1,
      watching: 0,
      attention: items.length,
      clients: [],
      causes: [],
      items,
      settings: DEFAULT_HEALTH_SETTINGS,
    },
  });
  return downloadsAnalyzer().run({ handle, now, environment: "real", memo: null });
}

describe("Download Health in Needs you (11-10: a stalled download never reached the bell)", () => {
  it("raises a stuck download its client reports", async () => {
    const r = await withHealth([item({})]);
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]).toMatchObject({
      key: "downloads:qbit",
      kind: "problem",
      severity: "medium",
      title: "qBittorrent: A Court of Frost and Starlight is stalled",
    });
  });

  it("groups a client's downloads, and leaves watching ones and app-only problems to others", async () => {
    const r = await withHealth([
      item({}),
      item({ key: "qbt:2", title: "Dune", problem: "metadata" }),
      item({ key: "qbt:3", title: "Slow one", state: "watching" }),
      // A failed import only Sonarr sees: Sonarr's own finding shows it.
      item({
        key: "s:1",
        title: "Doctor Who",
        client: "Sonarr",
        clientServiceId: "sonarr",
        appServiceId: "sonarr",
        problem: "import-failed",
      }),
    ]);
    expect(r.drafts.map((d) => d.title)).toEqual(["qBittorrent: 2 downloads stuck or failed"]);
  });

  it("says nothing new from an old check, so nothing resolves by mistake", async () => {
    const r = await withHealth([item({})], "2026-11-10T18:00:00Z");
    expect(r.status).toBe("partial");
    expect(r.covered("downloads:qbit")).toBe(false);
  });
});
