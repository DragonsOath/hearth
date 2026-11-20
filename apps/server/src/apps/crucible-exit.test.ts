import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CRUCIBLE_PRESETS, HOLD_PROFILE } from "@dragon-control/core";
import { SERVER_ROOT } from "../config";
import type { CredentialBroker } from "../credentials/broker";
import { openDatabase, runMigrations } from "../db/client";
import * as t from "../db/schema";
import { getSetting, setSetting } from "../store/settings";
import { fakeMedia } from "../watches/fake-media";
import { planCrucible, runCrucible, type Arr } from "./crucible-apply";
import { CrucibleKeeper } from "./crucible-keeper";
import { fakeRadarr } from "./fake-radarr";
import { SeerrOperations } from "./seerr-ops";

/**
 * The clean exit (Flint, 11-17; run first when Hearth uninstalls itself): Seerr searches by itself
 * again with its earlier default, and every request waiting for the Crucible gets its row and is
 * searched. Never stranded.
 */
const broker = {
  use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: "key" }),
} as unknown as CredentialBroker;

describe("the Crucible's clean exit", () => {
  it("hands Seerr's search back, releases waiting requests, and the installers' marker goes", async () => {
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
      lastSeenAt: "2026-11-17T00:00:00Z",
    });
    for (const [id, name, url] of [
      ["radarr", "Radarr", "http://10.0.0.5:7879"],
      ["seerr", "Overseerr", "http://10.0.0.5:5055"],
    ] as const)
      await handle.db.insert(t.services).values({
        id,
        name,
        category: "media",
        hostId: "h1",
        kind: "container",
        image: `x/${id}`,
        localUrl: url,
        checkTarget: `container:${id}`,
        health: "healthy",
        autonomyArea: "media",
      });

    const radarrApp = fakeRadarr();
    const media = fakeMedia();
    const arr: Arr = async (method, p, _purpose, body) => {
      const res = await radarrApp.fetch(`http://10.0.0.5:7879${p}`, {
        method,
        headers: { "X-Api-Key": "key", "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return {
        ok: res.ok,
        status: res.status,
        data: (await res.json().catch(() => undefined)) as never,
      };
    };
    const seerr = new SeerrOperations(handle, broker, media.fetch);
    const dataDir = await mkdtemp(path.join(tmpdir(), "crucible-exit-"));
    const keeper = new CrucibleKeeper(handle, () => arr, undefined, Date.now, seerr, dataDir);

    // The checkpoint on: Save with the holding profile, Seerr's search handed to the Crucible.
    const setup = { ...CRUCIBLE_PRESETS["storage-smart"].setup(), searchAfterSorting: true };
    const [, params] = await planCrucible(arr, "Radarr", { setup: JSON.stringify(setup) }, 2026);
    await runCrucible(arr, "Radarr", params);
    await setSetting(handle.db, "crucible", { radarr: setup });
    const svc = { id: "seerr", name: "Overseerr", localUrl: "http://10.0.0.5:5055" };
    const base = {
      label: "",
      serviceName: "",
      changes: true,
      policy: "allow" as const,
      policyReason: "",
    };
    const off = await seerr.plan("app-seerr-search-on-add", svc, { search: false }, base);
    expect(
      await seerr.run(
        {
          kind: "app-seerr-search-on-add",
          serviceId: "seerr",
          requestedBy: "you",
          params: off.params ?? {},
        },
        svc,
      ),
    ).toMatchObject({ ok: true });
    await keeper.syncMarker();
    expect(
      JSON.parse(await readFile(path.join(dataDir, "crucible-checkpoint.json"), "utf8")),
    ).toMatchObject({ on: true });

    const profiles = (
      await arr<{ id: number; name: string }[]>("GET", "/api/v3/qualityprofile", "t")
    ).data;
    const hold = profiles.find((p) => p.name === HOLD_PROFILE)!;
    const held = (
      await arr<{ id: number }>("POST", "/api/v3/movie", "test", {
        title: "Old Harbour Tales",
        year: 1979,
        tmdbId: 424242,
        qualityProfileId: hold.id,
        rootFolderPath: "/movies",
        monitored: true,
        genres: ["Drama"],
        addOptions: { searchForMovie: false },
      })
    ).data.id;

    expect(await keeper.exitPreview()).toEqual({
      waiting: [{ service: "Radarr", titles: ["Old Harbour Tales (1979)"] }],
      seerrs: ["Overseerr"],
    });
    const r = await keeper.exit();
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.lines.join(" ")).toContain("Overseerr searches by itself again, on HD-1080p");

    // Seerr: searching again, its earlier default back.
    const settings = (await (
      await media.fetch("http://10.0.0.5:5055/api/v1/settings/radarr", {
        headers: {},
        signal: AbortSignal.timeout(2000),
      })
    ).json()) as { preventSearch: boolean; activeProfileName: string }[];
    expect(settings[0]).toMatchObject({ preventSearch: false, activeProfileName: "HD-1080p" });
    // Radarr: the request got its row and was searched (and grabbed under it).
    const classics = profiles.find((p) => p.name === "Hearth · Classics (30+ years)")!;
    expect(radarrApp.grabs().filter((g) => g.movieId === held)).toEqual([
      { movieId: held, profileId: classics.id, by: "search" },
    ]);
    expect(await keeper.exitPreview()).toEqual({ waiting: [], seerrs: [] });
    expect((await getSetting(handle.db, "crucible"))?.radarr?.searchAfterSorting).toBe(false);
    await expect(stat(path.join(dataDir, "crucible-checkpoint.json"))).rejects.toThrow();
  });
});
