import { beforeEach, describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeTransmission } from "./fake-transmission";
import {
  forgetTransmissionSessions,
  readTransmission,
  rpcUrl,
  TransmissionLive,
  transmissionStatus,
} from "./transmission";
import { TransmissionOperations, withLabel } from "./transmission-control";

/**
 * Transmission against the stand-in (answering as a throwaway 4.1.4 did;
 * transmission-real.test.ts runs the same calls against a real one): the session handshake, the
 * panel's reads with no passkey, and every change as a plan read back.
 */

const BASE = "http://10.0.0.9:9091";
const LOGIN = { username: "hearth", password: "e2e-transmission" };
const service = { id: "tr", name: "Transmission", localUrl: BASE };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const h = (n: number) => n.toString(16).padStart(2, "0").repeat(20);

function setup() {
  const tr = fakeTransmission();
  const broker = {
    use: (_s: unknown, fn: (c: { value: string; username: string }) => unknown) =>
      fn({ value: LOGIN.password, username: LOGIN.username }),
  } as unknown as CredentialBroker;
  const ops = new TransmissionOperations(handle, broker, tr.fetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-transmission-control" as const,
    serviceId: "tr",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    return { planned, outcome: await ops.run(step(planned.params), service) };
  };
  return { tr, ops, go, step, live: new TransmissionLive(tr.fetch) };
}

beforeEach(() => forgetTransmissionSessions());

describe("reading Transmission", () => {
  it("reads every torrent in qBittorrent's shapes, with labels, and no passkey", async () => {
    const { live } = setup();
    const d = await live.dashboard("tr", BASE, LOGIN);
    expect(d.version).toBe("4.1.4");
    expect(d.connection).toBe("connected");
    expect(d.freeSpaceBytes).toBe(812_000_000_000);
    expect(d.torrents.map((t) => [t.name, t.status, t.category ?? ""])).toEqual([
      ["Lantern Season 1", "downloading", "tv"],
      ["Quiet Harbor 2024", "stalled", "movies"],
      ["Open Source Album", "seeding", "music"],
      ["Old Documentary", "paused", ""],
      ["Broken Download", "error", "movies"],
    ]);
    const album = d.torrents[2]!;
    expect(album).toMatchObject({
      tags: ["music", "flac"],
      ratio: 1.42,
      tracker: "tracker.example",
    });
    expect(d.torrents[4]!.problem).toContain("No data found");
    expect(d.torrents[1]!.problem).toBe("Stalled: no seeders in the swarm.");
    const detail = await live.detail("tr", BASE, LOGIN, h(1), { files: true, peers: true });
    expect(detail.files).toHaveLength(2);
    expect(detail.peerList?.[0]).toMatchObject({ address: "203.0.113.9", downSpeed: 350_000 });
    expect(detail.trackers[0]).toMatchObject({ host: "tracker.example", status: "working" });
    const s = await live.settings("tr", BASE, LOGIN);
    expect(s.categories.map((c) => c.name)).toEqual(["flac", "movies", "music", "tv"]);
    expect(s.settings.find((x) => x.key === "seedRatioLimit")).toMatchObject({ value: 2 });
    // Passkeys in tracker addresses and magnet links, the RPC password and the proxy never come.
    expect(JSON.stringify([d, detail, s])).not.toContain("SECRET");
  });

  it("reports what needs attention", async () => {
    const { tr } = setup();
    const r = await readTransmission(BASE, LOGIN, tr.fetch);
    expect(r.issues.map((i) => i.key)).toEqual(["torrents:error"]);
    expect(r.queue?.[0]).toMatchObject({ title: "Broken Download" });
    expect(r.version).toBe("4.1.4");
  });

  it("names a wrong password as the vault's problem", async () => {
    const { live } = setup();
    await expect(
      live.dashboard("tr", BASE, { username: "hearth", password: "wrong" }),
    ).rejects.toThrow(/refused the username or password/);
  });

  it("maps Transmission's states, and finds its RPC address", () => {
    expect(
      transmissionStatus({ id: 1, hashString: "", status: 4, metadataPercentComplete: 0.3 }),
    ).toBe("metadata");
    expect(transmissionStatus({ id: 1, hashString: "", status: 0, percentDone: 1 })).toBe(
      "completed",
    );
    expect(transmissionStatus({ id: 1, hashString: "", status: 2 })).toBe("checking");
    expect(rpcUrl("http://nas:9091")).toBe("http://nas:9091/transmission/rpc");
    expect(rpcUrl("http://nas:9091/tr/rpc/")).toBe("http://nas:9091/tr/rpc");
    expect(withLabel(["tv", "hd"], "movies")).toEqual(["movies", "hd"]);
    expect(withLabel(["tv"], "")).toEqual([]);
  });
});

describe("changing Transmission", () => {
  it("pauses and resumes, read back, and refuses what is already so", async () => {
    const { go, tr } = setup();
    const p = await go({ op: "pause", hash: h(1) });
    expect(p.planned.label).toBe("Pause Lantern Season 1 in Transmission");
    expect(p.outcome).toMatchObject({ ok: true, verified: true });
    expect(tr.torrent(h(1))!.status).toBe(0);
    await expect(go({ op: "pause", hash: h(1) })).rejects.toThrow(/already paused/);
    expect((await go({ op: "resume", hash: h(1) })).outcome.ok).toBe(true);
  });

  it("labels a torrent, keeping its other labels, and puts it back on undo", async () => {
    const { go, ops, step, tr } = setup();
    const r = await go({ op: "label", hash: h(3), category: "audio" });
    expect(r.outcome).toMatchObject({ ok: true, result: expect.stringContaining("audio") });
    expect(tr.torrent(h(3))!.labels).toEqual(["audio", "flac"]);
    await ops.undo(step(r.planned.params), service);
    expect(tr.torrent(h(3))!.labels).toEqual(["music", "flac"]);
    await expect(go({ op: "label", hash: h(3), category: "a,b" })).rejects.toThrow(/no commas/);
  });

  it("sets which files download, and moves a torrent in the queue", async () => {
    const { go, tr } = setup();
    expect(
      (await go({ op: "file-priority", hash: h(1), fileIndexes: "1", filePriority: 0 })).outcome,
    ).toMatchObject({ ok: true });
    expect(tr.torrent(h(1))!.fileStats[1]!.wanted).toBe(false);
    expect(
      (await go({ op: "file-priority", hash: h(1), fileIndexes: "0", filePriority: 7 })).outcome,
    ).toMatchObject({ ok: true });
    expect(tr.torrent(h(1))!.fileStats[0]!.priority).toBe(1);
    const q = await go({ op: "queue-top", hash: h(2) });
    expect(q.outcome.result).toContain("place 1");
  });

  it("adds a magnet with a label, counts it once when run twice, and removes it", async () => {
    const { go, tr } = setup();
    const magnet = `magnet:?xt=urn:btih:${"ab".repeat(20)}&dn=New+Thing`;
    const add = { op: "add", urls: magnet, category: "tv", paused: true };
    expect((await go(add)).outcome).toMatchObject({ ok: true, verified: true });
    expect((await go(add)).outcome).toMatchObject({ ok: true });
    expect(tr.torrent("ab".repeat(20))).toMatchObject({ labels: ["tv"], status: 0 });
    const rm = await go({ op: "remove-with-data", hash: "ab".repeat(20) });
    expect(rm.planned.label).toContain("AND delete its files");
    expect(rm.outcome.ok).toBe(true);
    await expect(go({ op: "add", urls: "ftp://x" })).rejects.toThrow(/Only magnet links/);
  });

  it("changes ratio and speed settings, refuses others, and is stale when they changed", async () => {
    const { go, ops, tr } = setup();
    const r = await go({
      op: "settings",
      body: JSON.stringify({ seedRatioLimit: 3, "speed-limit-down-enabled": true }),
    });
    expect(r.planned.change?.settings).toEqual([
      { name: "Share ratio to stop at", before: "2", after: "3" },
      { name: "Limit download speed", before: "off", after: "on" },
    ]);
    expect(r.outcome).toMatchObject({ ok: true, verified: true });
    await expect(
      go({ op: "settings", body: JSON.stringify({ "rpc-password": "x" }) }),
    ).rejects.toThrow(/does not change rpc-password/);
    // Planned, then changed in Transmission before it ran: nothing is changed.
    const planned = await ops.plan(
      service,
      { op: "settings", body: JSON.stringify({ seedRatioLimit: 4 }) },
      base,
    );
    await tr.fetch(`${BASE}/transmission/rpc`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from("h:e2e-x").toString("base64")}`,
        "X-Transmission-Session-Id": "fake-transmission-session",
      },
      body: JSON.stringify({ method: "session-set", arguments: { seedRatioLimit: 5 } }),
      signal: AbortSignal.timeout(1000),
    });
    const out = await ops.run(
      {
        kind: "app-transmission-control",
        serviceId: "tr",
        requestedBy: "you",
        params: planned.params!,
      },
      service,
    );
    expect(out).toMatchObject({ ok: false, stale: true });
  });
});
