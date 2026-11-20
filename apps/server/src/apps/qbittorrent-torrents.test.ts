import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ActionKind, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeQbittorrent } from "./fake-qbittorrent";
import { planControl } from "./qbittorrent-control";
import { TorrentOperations } from "./torrent-operations";

/**
 * The Torrents tab's changes (checklist 46.11) against the stand-in qBittorrent: adding an
 * uploaded .torrent, choosing only a folder qBittorrent already uses, file priorities, creating and
 * removing categories (never one in use), and a category change that says whether files move.
 */

const qb = fakeQbittorrent();
const broker = {
  use: (_s: unknown, fn: (c: { value: string; username?: string }) => unknown) =>
    fn({ value: "e2e-qbt", username: "admin" }),
} as unknown as CredentialBroker;
// No Sonarr, Radarr or Lidarr watched here; audits go nowhere.
const handle = {
  db: {
    insert: () => ({ values: async () => undefined }),
    select: () => ({
      from: () => ({ all: async () => [], where: () => ({ get: async () => undefined }) }),
    }),
  },
} as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const service = { id: "qbt", name: "qBittorrent", localUrl: "http://10.0.0.5:8090", hostId: "h" };
const ops = new TorrentOperations(handle, broker, qb.fetch, undefined, async () => undefined);
const plan = (kind: ActionKind, params: Record<string, unknown>) =>
  ops.plan(kind, service, params as StepParams, base);
const run = (kind: ActionKind, planned: PlannedStep, undo = false) =>
  ops.run(
    {
      kind,
      serviceId: service.id,
      requestedBy: "you",
      params: planned.params,
      change: planned.change,
    },
    service,
    { undo },
  );

const UBUNTU = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SHOW = "b2c3d4e5f60718293a4b5c6d7e8f901234567890";

/** A small, valid .torrent file. */
function torrentFile(name: string) {
  const info = `d6:lengthi2048e4:name${name.length}:${name}12:piece lengthi16384e6:pieces20:${"x".repeat(20)}e`;
  const bytes = Buffer.from(`d8:announce19:http://t.example/an4:info${info}e`, "latin1");
  return {
    data: bytes.toString("base64"),
    hash: createHash("sha1").update(Buffer.from(info, "latin1")).digest("hex"),
  };
}

beforeEach(() => qb.reset());

describe("adding torrents", () => {
  it("adds an uploaded .torrent file, named in the plan, and finds it by its hash", async () => {
    const f = torrentFile("Big.Buck.Bunny.mkv");
    const planned = await plan("app-qbt-add", {
      files: JSON.stringify([{ name: "bunny.torrent", data: f.data }]),
      category: "radarr",
    });
    expect(planned.change?.summary).toBe('Add "Big.Buck.Bunny.mkv" to qBittorrent');
    expect(JSON.stringify(planned.change)).toContain("from your file bunny.torrent");
    expect(JSON.stringify(planned.change)).toContain("/downloads/movies");
    const done = await run("app-qbt-add", planned);
    expect(done.ok, done.result).toBe(true);
    expect(qb.torrents().find((t) => t.hash === f.hash)).toMatchObject({
      name: "Big.Buck.Bunny.mkv",
      category: "radarr",
    });
    // The same file again is refused before anything is sent.
    await expect(
      plan("app-qbt-add", { files: JSON.stringify([{ name: "again.torrent", data: f.data }]) }),
    ).rejects.toThrow(/already has "Big.Buck.Bunny.mkv"/);
  });

  it("refuses a file that is not a torrent, and a folder qBittorrent does not use", async () => {
    await expect(
      plan("app-qbt-add", {
        files: JSON.stringify([
          { name: "notes.txt", data: Buffer.from("hello").toString("base64") },
        ]),
      }),
    ).rejects.toThrow(/notes.txt: It is not a .torrent file/);
    const magnet = "magnet:?xt=urn:btih:dddddddddddddddddddddddddddddddddddddddd&dn=Test";
    await expect(plan("app-qbt-add", { urls: magnet, savepath: "/etc" })).rejects.toThrow(
      /not one of qBittorrent's folders/,
    );
    const ok = await plan("app-qbt-add", { urls: magnet, savepath: "/downloads/tv" });
    expect(JSON.stringify(ok.change)).toContain("saved to /downloads/tv");
    const done = await run("app-qbt-add", ok);
    expect(done.ok, done.result).toBe(true);
    expect(qb.torrents().find((t) => t.name === "Test")).toMatchObject({
      save_path: "/downloads/tv",
      auto_tmm: false,
    });
  });
});

describe("a torrent's files", () => {
  it("stops one file downloading, verified, refuses a stale retry, and puts it back", async () => {
    const planned = await plan("app-qbt-file-priority", {
      hash: UBUNTU,
      fileIndexes: "1",
      filePriority: 0,
    });
    expect(planned.change?.settings[0]).toMatchObject({
      name: "SHA256SUMS",
      before: "Normal",
      after: "Do not download",
    });
    const done = await run("app-qbt-file-priority", planned);
    expect(done.ok, done.result).toBe(true);
    expect(qb.torrents().find((t) => t.hash === UBUNTU)!.files[1]!.priority).toBe(0);
    expect(await run("app-qbt-file-priority", planned)).toMatchObject({ ok: false, stale: true });
    const back = await run("app-qbt-file-priority", planned, true);
    expect(back.ok, back.result).toBe(true);
    expect(qb.torrents().find((t) => t.hash === UBUNTU)!.files[1]!.priority).toBe(1);
  });
});

describe("categories", () => {
  it("creates one in qBittorrent's default place and removes it again while empty", async () => {
    const made = await plan("app-qbt-category", { categoryAction: "create", category: "games" });
    expect(JSON.stringify(made.change)).toContain("/downloads/games");
    expect((await run("app-qbt-category", made)).ok).toBe(true);
    const gone = await plan("app-qbt-category", { categoryAction: "remove", category: "games" });
    expect((await run("app-qbt-category", gone)).ok).toBe(true);
    await expect(
      plan("app-qbt-category", { categoryAction: "create", category: "x", savePath: "/other" }),
    ).rejects.toThrow(/not done from here/);
  });

  it("never removes a category with torrents in it, or one Sonarr, Radarr or Lidarr uses", async () => {
    await expect(
      plan("app-qbt-category", { categoryAction: "remove", category: "radarr" }),
    ).rejects.toThrow(/"Quiet.Harbor.2024.1080p.BluRay" is in "radarr"/);
    // An empty category that Sonarr sends downloads to.
    const session = (_a: unknown, _p: unknown, fn: (q: never) => unknown) =>
      fn({
        get: async (path: string) => {
          const res = await qb.fetch(`http://x${path}`, {
            headers: { Cookie: "QBT_SID_8090=e2e-session" },
            signal: AbortSignal.timeout(1000),
          });
          const all = (await res.json()) as unknown;
          return path.startsWith("/api/v2/torrents/info") ? [] : all;
        },
      } as never);
    await expect(
      planControl(
        "app-qbt-category",
        service,
        { categoryAction: "remove", category: "tv-sonarr" } as StepParams,
        base,
        session as never,
        {
          arrCategories: async () => ({
            used: [{ app: "Sonarr", category: "tv-sonarr" }],
            unchecked: [],
          }),
        },
      ),
    ).rejects.toThrow(/Sonarr sends its downloads to "tv-sonarr"/);
    await expect(
      planControl(
        "app-qbt-category",
        service,
        { categoryAction: "remove", category: "tv-sonarr" } as StepParams,
        base,
        session as never,
        { arrCategories: async () => ({ used: [], unchecked: ["Lidarr"] }) },
      ),
    ).rejects.toThrow(/could not read Lidarr/);
  });

  it("says, torrent by torrent, whether a category change moves its files", async () => {
    // The show has automatic management on: its files would move to the movies folder.
    const moving = await plan("app-qbt-set-category", { hash: SHOW, category: "radarr" });
    expect(moving.change?.settings).toContainEqual({
      name: "Night.Signal.S01E01.1080p.WEB: FILES MOVE",
      before: "/downloads/tv",
      after: "/downloads/movies (automatic torrent management is on for it)",
    });
    // Ubuntu has it off: its files stay.
    const staying = await plan("app-qbt-set-category", { hash: UBUNTU, category: "radarr" });
    expect(staying.change?.settings).toContainEqual({
      name: "Ubuntu 24.04 Desktop: files",
      before: "",
      after: "Stay where they are (/downloads)",
    });
  });
});
