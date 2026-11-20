import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { ActionKind, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { Fetch } from "./http";
import { TorrentOperations } from "./torrent-operations";

/**
 * qBittorrent's Settings tab against a real, disposable qBittorrent 5.2.4 on an internal network
 * with no internet route (checklist 46.10k). Skipped unless HEARTH_QBT_TEST_URL and
 * HEARTH_QBT_TEST_PASSWORD_FILE point at such an instance: never run this against one anyone uses.
 * Every setting it changes it puts back.
 */

const url = process.env.HEARTH_QBT_TEST_URL;
const pwFile = process.env.HEARTH_QBT_TEST_PASSWORD_FILE;
const password = pwFile ? readFileSync(pwFile, "utf8").trim() : "";
const live = Boolean(url && password);

const fetchImpl: Fetch = (u, init) => fetch(u, init);
const broker = {
  use: (_s: unknown, fn: (c: { value: string; username?: string }) => unknown) =>
    fn({ value: password, username: "hearthtest" }),
} as unknown as CredentialBroker;
const handle = {
  db: {
    insert: () => ({ values: async () => undefined }),
    // No Sonarr, Radarr or Lidarr watched in this test.
    select: () => ({ from: () => ({ all: async () => [] }) }),
  },
} as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const qbt = { id: "qbt-test", name: "qBittorrent", localUrl: url ?? "", hostId: "h" };
const ops = new TorrentOperations(handle, broker, fetchImpl, undefined, async () => undefined);

async function prefs(): Promise<Record<string, unknown>> {
  const login = await fetch(`${url}/api/v2/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: url! },
    body: new URLSearchParams({ username: "hearthtest", password }).toString(),
  });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const r = await fetch(`${url}/api/v2/app/preferences`, { headers: { Cookie: cookie } });
  return (await r.json()) as Record<string, unknown>;
}

const KEYS = [
  "dl_limit",
  "max_ratio_enabled",
  "max_ratio",
  "max_active_downloads",
  "max_ratio_act",
];

describe.skipIf(!live)("qBittorrent settings against a real test instance", () => {
  let original: Record<string, unknown> = {};
  const step = (planned: PlannedStep) => ({
    kind: "app-qbt-set-preferences" as const,
    serviceId: "qbt-test",
    requestedBy: "you" as const,
    params: planned.params,
    change: planned.change,
  });
  const plan = (preferences: Record<string, unknown>) =>
    ops.plan(
      "app-qbt-set-preferences",
      qbt,
      { preferences: JSON.stringify(preferences) } as StepParams,
      base,
    );

  afterAll(async () => {
    // Put back anything a failed run left changed.
    const now = await prefs();
    const back = Object.fromEntries(
      KEYS.filter((k) => now[k] !== original[k]).map((k) => [k, original[k]]),
    );
    if (Object.keys(back).length) {
      const planned = await plan(back);
      await ops.run(step(planned), qbt);
    }
  });

  it("reads the settings Hearth may change, with categories and tags", async () => {
    original = await prefs();
    const v = await ops.settings(qbt);
    const keys = v.settings.map((s) => s.key);
    for (const k of KEYS) expect(keys).toContain(k);
    expect(v.settings.find((s) => s.key === "dl_limit")).toMatchObject({ type: "int" });
    expect(v.categories.map((c) => c.name)).toEqual(
      expect.arrayContaining(["tv-sonarr", "radarr"]),
    );
    expect(v.tags).toEqual(expect.arrayContaining(["hearth-test", "keep"]));
    // Nothing secret comes back with the settings.
    expect(JSON.stringify(v).includes(password)).toBe(false);
  });

  it("changes several settings in one plan, reads them back, refuses a retry, and undoes", async () => {
    const wanted = {
      dl_limit: 512 * 1024,
      max_ratio_enabled: true,
      max_ratio: 1.5,
      max_active_downloads: 2,
    };
    const planned = await plan(wanted);
    expect(planned.change?.settings.map((s) => s.name)).toEqual(
      expect.arrayContaining(["Download speed limit", "Share ratio limit"]),
    );
    const done = await ops.run(step(planned), qbt);
    expect(done.ok, done.result).toBe(true);
    const now = await prefs();
    for (const [k, v] of Object.entries(wanted)) expect(now[k]).toBe(v);

    // The same approved plan again: its "before" no longer matches, so nothing is changed.
    const retry = await ops.run(step(planned), qbt);
    expect(retry).toMatchObject({ ok: false, stale: true });

    const undone = await ops.run(step(planned), qbt, { undo: true });
    expect(undone.ok, undone.result).toBe(true);
    const back = await prefs();
    for (const k of Object.keys(wanted)) expect(back[k]).toBe(original[k]);
  });

  it("refuses networking settings, and warns before a limit that deletes files", async () => {
    await expect(plan({ listen_port: 51413 })).rejects.toThrow(/networking/);
    await expect(plan({ save_path: "/elsewhere" })).rejects.toThrow(/save paths/);
    const planned = await plan({ max_ratio_act: 3 });
    expect(JSON.stringify(planned.change)).toMatch(/AND its downloaded files deleted/);
  });
});

/** A small two-file .torrent (no peer is reachable: the test instance has no internet). */
function testTorrent(name: string) {
  const info = `d5:filesld6:lengthi4096e4:pathl8:main.mkveed6:lengthi512e4:pathl10:sample.mkveee4:name${name.length}:${name}12:piece lengthi16384e6:pieces20:${"z".repeat(20)}e`;
  return {
    data: Buffer.from(`d4:info${info}e`, "latin1").toString("base64"),
    hash: createHash("sha1").update(Buffer.from(info, "latin1")).digest("hex"),
  };
}

describe.skipIf(!live)("the Torrents tab against a real test instance", () => {
  // Real waits between read-backs: qBittorrent applies start, stop and recheck a moment later.
  const torrentOps = new TorrentOperations(
    handle,
    broker,
    fetchImpl,
    undefined,
    (ms) => new Promise((r) => setTimeout(r, ms)),
  );
  const plan = (kind: ActionKind, params: Record<string, unknown>) =>
    torrentOps.plan(kind, qbt, params as StepParams, base);
  const run = (kind: ActionKind, planned: PlannedStep, undo = false) =>
    torrentOps.run(
      {
        kind,
        serviceId: "qbt-test",
        requestedBy: "you",
        params: planned.params,
        change: planned.change,
      },
      qbt,
      { undo },
    );

  it("uploads a .torrent, reads its files, changes a file's priority and its category, then removes it", async () => {
    const name = `Hearth.Test.${Date.now()}`;
    const t = testTorrent(name);
    const added = await run(
      "app-qbt-add",
      await plan("app-qbt-add", {
        files: JSON.stringify([{ name: "test.torrent", data: t.data }]),
        category: "radarr",
        paused: true,
      }),
    );
    expect(added.ok, added.result).toBe(true);
    try {
      const { QbittorrentLive } = await import("./qbittorrent-live");
      const detail = await new QbittorrentLive(fetchImpl).detail(
        "qbt-test",
        url!,
        { username: "hearthtest", password },
        t.hash,
        { files: true, peers: true },
      );
      expect(detail.files?.map((f) => f.name)).toEqual([`${name}/main.mkv`, `${name}/sample.mkv`]);
      expect(detail.peerList).toEqual([]);

      const skip = await plan("app-qbt-file-priority", {
        hash: t.hash,
        fileIndexes: "1",
        filePriority: 0,
      });
      const skipped = await run("app-qbt-file-priority", skip);
      expect(skipped.ok, skipped.result).toBe(true);
      const back = await run("app-qbt-file-priority", skip, true);
      expect(back.ok, back.result).toBe(true);

      // The everyday buttons on the same torrent, each read back from qBittorrent.
      for (const [kind, params] of [
        ["app-qbt-resume", { hash: t.hash }],
        ["app-qbt-pause", { hash: t.hash }],
        ["app-qbt-recheck", { hash: t.hash }],
        ["app-qbt-force-start", { hash: t.hash, value: true }],
        ["app-qbt-set-tags", { hash: t.hash, addTags: "hearth-test" }],
      ] as const) {
        const done = await run(kind, await plan(kind, params));
        // A recheck of a torrent with no data (no internet here) ends before it can be seen
        // running: qBittorrent accepted it, which is all this instance can show.
        if (kind === "app-qbt-recheck") expect(done.result).toMatch(/accepted/);
        else expect(done.ok, `${kind}: ${done.result}`).toBe(true);
      }

      const move = await plan("app-qbt-set-category", { hash: t.hash, category: "tv-sonarr" });
      expect(JSON.stringify(move.change)).toMatch(/: files|FILES MOVE/);
      const moved = await run("app-qbt-set-category", move);
      expect(moved.ok, moved.result).toBe(true);
    } finally {
      const removed = await run("app-qbt-remove", await plan("app-qbt-remove", { hash: t.hash }));
      expect(removed.ok, removed.result).toBe(true);
    }
  }, 180_000);

  it("creates a category and removes it again", async () => {
    const cat = `hearth-e2e-${Date.now() % 100000}`;
    const made = await run(
      "app-qbt-category",
      await plan("app-qbt-category", { categoryAction: "create", category: cat }),
    );
    expect(made.ok, made.result).toBe(true);
    const gone = await run(
      "app-qbt-category",
      await plan("app-qbt-category", { categoryAction: "remove", category: cat }),
    );
    expect(gone.ok, gone.result).toBe(true);
    await expect(
      plan("app-qbt-category", { categoryAction: "remove", category: `nope-${cat}` }),
    ).rejects.toThrow(/has no category/);
  });
});
