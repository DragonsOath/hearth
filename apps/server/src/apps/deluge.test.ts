import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { DelugeLive, delugeStatus, readDeluge, toTorrent } from "./deluge";
import { DelugeOperations } from "./deluge-control";
import { fakeDeluge } from "./fake-deluge";

/**
 * Deluge against the stand-in (answering as a throwaway Deluge 2.2.0 did; deluge-real.test.ts runs
 * the same calls against a real one): the panel's reads, and every change as a plan, read back.
 */

const BASE = "http://10.0.0.9:8112";
const PW = "e2e-deluge";
const service = { id: "dl", name: "Deluge", localUrl: BASE };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const BUNNY = "1111111111111111111111111111111111111111";
const SINTEL = "2222222222222222222222222222222222222222";
const BOOK = "3333333333333333333333333333333333333333";

function setup(pw = PW) {
  const d = fakeDeluge();
  const broker = {
    use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: pw }),
  } as unknown as CredentialBroker;
  const ops = new DelugeOperations(handle, broker, d.fetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-deluge-control" as const,
    serviceId: "dl",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    return { planned, outcome: await ops.run(step(planned.params), service) };
  };
  const live = new DelugeLive(d.fetch);
  return { d, ops, go, step, live, board: () => live.dashboard("dl", BASE, pw) };
}

describe("reading Deluge", () => {
  it("reads Deluge's states as the panel's, with progress out of 100", () => {
    expect(delugeStatus({ state: "Downloading", total_size: 0 })).toBe("metadata");
    expect(
      delugeStatus({ state: "Downloading", total_size: 1, download_payload_rate: 0, num_seeds: 0 }),
    ).toBe("stalled");
    expect(delugeStatus({ state: "Paused", progress: 100 })).toBe("completed");
    expect(delugeStatus({ state: "Paused", progress: 40 })).toBe("paused");
    expect(delugeStatus({ state: "Error" })).toBe("error");
    expect(
      toTorrent(BUNNY, {
        name: "x",
        state: "Downloading",
        progress: 42.5,
        total_size: 200,
        total_done: 85,
        queue: 0,
      }),
    ).toMatchObject({
      progressPct: 42.5,
      downloadedBytes: 85,
      leftBytes: 115,
      queuePosition: 1,
    });
  });

  it("signs in, attaches the Web UI to its daemon, and reads the live dashboard", async () => {
    const { board } = setup();
    const d = await board();
    expect(d).toMatchObject({
      app: "deluge",
      version: "2.2.0",
      connection: "connected",
      labelsEnabled: false,
      dhtNodes: 312,
    });
    expect(d.torrents.map((t) => [t.name, t.status])).toEqual([
      ["Big.Buck.Bunny.2008.1080p", "downloading"],
      ["Sintel.S01E02.720p", "stalled"],
      ["Elephants.Dream.Audiobook", "seeding"],
    ]);
    expect(d.torrents[1]!.problem).toBe("Stalled: no seeders in the swarm.");
  });

  it("shows tracker hosts only, never the announce address with its passkey", async () => {
    const { live } = setup();
    const detail = await live.detail("dl", BASE, PW, SINTEL, { files: true, peers: true });
    expect(detail.trackers).toEqual([
      {
        host: "tracker.example.org",
        status: "not working",
        seeds: 0,
        leechers: 2,
        message: "Error: unregistered torrent",
      },
    ]);
    expect(JSON.stringify(detail)).not.toMatch(/passkey|SECRET/);
    expect(detail.files).toEqual([
      {
        index: 0,
        name: "Sintel.S01E02.720p.mkv",
        sizeBytes: 734003200,
        progressPct: 3,
        priority: 1,
      },
    ]);
  });

  it("reads settings without the proxy password or ports, and says a wrong password plainly", async () => {
    const { live, d } = setup();
    const s = await live.settings("dl", BASE, PW);
    expect(s.settings.find((x) => x.key === "max_upload_speed")).toMatchObject({
      shown: "500 KiB/s",
    });
    expect(s.settings.find((x) => x.key === "max_download_speed")).toMatchObject({
      shown: "no limit",
    });
    expect(s.defaultSavePath).toBe("/downloads");
    expect(JSON.stringify(s)).not.toMatch(/never-shown|listen_ports|proxy/);
    await expect(readDeluge(BASE, "wrong", d.fetch)).rejects.toThrow(/refused the Web UI password/);
    expect((await readDeluge(BASE, PW, d.fetch)).facts[1]).toMatchObject({
      label: "Downloading",
      value: "2 (1 stalled)",
    });
  });
});

describe("changing Deluge, each a plan read back", () => {
  it("pauses and resumes, and refuses what would change nothing", async () => {
    const { go, ops } = setup();
    const p = await go({ op: "pause", hash: BUNNY });
    expect(p.planned.label).toBe("Pause Big.Buck.Bunny.2008.1080p in Deluge");
    expect(p.outcome).toMatchObject({ ok: true, verified: true });
    await expect(ops.plan(service, { op: "pause", hash: BUNNY }, base)).rejects.toThrow(
      /already paused/,
    );
    expect((await go({ op: "resume", hash: BUNNY })).outcome).toMatchObject({
      ok: true,
      verified: true,
    });
    await expect(ops.plan(service, { op: "resume", hash: BUNNY }, base)).rejects.toThrow(
      /not paused/,
    );
  });

  it("labels need the Label plugin: turn it on, make a label, use it, and refuse removing one in use", async () => {
    const { go, ops, board } = setup();
    await expect(
      ops.plan(service, { op: "label", hash: BUNNY, category: "movies" }, base),
    ).rejects.toThrow(/Label plugin is off/);
    expect((await go({ op: "labels-on" })).outcome).toMatchObject({ ok: true, verified: true });
    expect((await go({ op: "label-create", category: "Movies" })).outcome).toMatchObject({
      ok: true,
      verified: true,
    });
    await expect(
      ops.plan(service, { op: "label", hash: BUNNY, category: "tv" }, base),
    ).rejects.toThrow(/no label tv: make it first/);
    const l = await go({ op: "label", hash: BUNNY, category: "movies" });
    expect(l.planned.change?.settings[0]).toMatchObject({ before: "no label", after: "movies" });
    expect(l.outcome).toMatchObject({ ok: true, verified: true });
    expect((await board()).torrents[0]).toMatchObject({ category: "movies" });
    await expect(
      ops.plan(service, { op: "label-delete", category: "movies" }, base),
    ).rejects.toThrow(/1 torrent has the label movies/);
  });

  it("a label changed in Deluge after planning is left alone, and undo puts one back", async () => {
    const { go, ops, step } = setup();
    await go({ op: "labels-on" });
    await go({ op: "label-create", category: "a" });
    await go({ op: "label-create", category: "b" });
    const planned = await ops.plan(service, { op: "label", hash: BUNNY, category: "a" }, base);
    await go({ op: "label", hash: BUNNY, category: "b" });
    expect(await ops.run(step(planned.params), service)).toMatchObject({ ok: false, stale: true });
    const again = await ops.plan(service, { op: "label", hash: BUNNY, category: "a" }, base);
    await ops.run(step(again.params), service);
    expect(await ops.undo(step(again.params), service)).toMatchObject({ ok: true });
  });

  it("moves through the queue, sets which files download, and removes keeping or deleting files", async () => {
    const { go, ops, board, live } = setup();
    expect((await go({ op: "queue-top", hash: SINTEL })).outcome).toMatchObject({
      ok: true,
      result: /place 1/,
    });
    await expect(ops.plan(service, { op: "queue-up", hash: BOOK }, base)).rejects.toThrow(
      /not in Deluge's queue/,
    );
    const f = await go({ op: "file-priority", hash: BUNNY, fileIndexes: "1", filePriority: 0 });
    expect(f.planned.label).toBe(
      "Set 1 file of Big.Buck.Bunny.2008.1080p to do not download in Deluge",
    );
    expect(f.outcome).toMatchObject({ ok: true, verified: true });
    expect(
      (await live.detail("dl", BASE, PW, BUNNY, { files: true })).files?.map((x) => x.priority),
    ).toEqual([1, 0]);
    const r = await go({ op: "remove-with-data", hash: BOOK });
    expect(r.planned.label).toMatch(/AND delete its files/);
    expect(r.outcome).toMatchObject({ ok: true, verified: true });
    expect((await board()).torrents.map((t) => t.hash)).not.toContain(BOOK);
  });

  it("adds magnet links and .torrent addresses, not other links, and not twice", async () => {
    const { go, ops, board } = setup();
    const magnet = "magnet:?xt=urn:btih:5555555555555555555555555555555555555555&dn=Tears.of.Steel";
    const a = await go({ op: "add", urls: magnet, paused: true });
    expect(a.planned.label).toBe("Add 1 link to Deluge, paused");
    expect(a.outcome).toMatchObject({ ok: true, verified: true });
    expect((await board()).torrents.find((t) => t.name === "Tears.of.Steel")).toMatchObject({
      state: "Paused",
    });
    // Run again (a second submission): counted as there, not added twice.
    expect((await go({ op: "add", urls: magnet })).outcome).toMatchObject({ ok: true });
    expect((await board()).torrents.filter((t) => t.name === "Tears.of.Steel")).toHaveLength(1);
    await expect(ops.plan(service, { op: "add", urls: "ftp://x/y.torrent" }, base)).rejects.toThrow(
      /Only magnet links/,
    );
  });

  it("changes only the speed, queue and seeding settings, read back, and changes nothing when Deluge changed them first", async () => {
    const { go, ops, step, live } = setup();
    const s = await go({
      op: "settings",
      body: JSON.stringify({ max_download_speed: 2048, max_active_downloading: 4 }),
    });
    expect(s.planned.change?.settings).toEqual([
      { name: "Download speed limit", before: "no limit", after: "2048 KiB/s" },
      { name: "Most active downloads", before: "3", after: "4" },
    ]);
    expect(s.outcome).toMatchObject({ ok: true, verified: true });
    await expect(
      ops.plan(
        service,
        { op: "settings", body: JSON.stringify({ proxy: { hostname: "x" } }) },
        base,
      ),
    ).rejects.toThrow(/does not change proxy/);
    await expect(
      ops.plan(
        service,
        { op: "settings", body: JSON.stringify({ download_location: "/x" }) },
        base,
      ),
    ).rejects.toThrow(/does not change download_location/);
    const planned = await ops.plan(
      service,
      { op: "settings", body: JSON.stringify({ max_active_seeding: 9 }) },
      base,
    );
    await go({ op: "settings", body: JSON.stringify({ max_active_seeding: 7 }) });
    expect(await ops.run(step(planned.params), service)).toMatchObject({ ok: false, stale: true });
    expect(
      (await live.settings("dl", BASE, PW)).settings.find((x) => x.key === "max_active_seeding"),
    ).toMatchObject({ value: 7 });
  });
});
