import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeTautulli } from "./fake-tautulli";
import { tautulliDashboard, TautulliOperations, whyConverted } from "./tautulli";

/** Tautulli's panel and stopping a stream, against a stand-in that answers like Tautulli 2.15. */

const BASE = "http://10.0.0.9:8181";
const KEY = "e2e-tautulli-key";
const service = { id: "tautulli", name: "Tautulli", localUrl: BASE };
const broker = {
  use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: KEY }),
} as unknown as CredentialBroker;
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

describe("the Tautulli panel", () => {
  it("shows who is watching, how it plays, and the week", async () => {
    const d = await tautulliDashboard(fakeTautulli().fetch, BASE, KEY);
    expect(d.totals).toEqual({
      streams: 2,
      transcoding: 1,
      bandwidthKbps: 28500,
      remoteKbps: 8200,
    });
    expect(d.streams[0]).toMatchObject({
      user: "Alex",
      decision: "direct play",
      location: "lan",
      thumb: "/library/metadata/77/thumb/1700000000",
    });
    expect(d.streams[1]).toMatchObject({
      user: "sam",
      title: "Dune: Part Two",
      year: 2024,
      decision: "transcode",
      why: "Video converted from 4k to 720p (hevc to h264), on the graphics card.",
    });
    expect(d.top.users[0]).toEqual({ name: "Alex", plays: 14 });
    expect(d.history[0]).toMatchObject({ user: "Alex", watchedPct: 100 });
  });

  it("explains conversions in plain words, and says nothing for direct play", () => {
    expect(whyConverted({ transcode_decision: "direct play" })).toBeUndefined();
    expect(whyConverted({ transcode_decision: "transcode", subtitle_decision: "burn" })).toBe(
      "Subtitles burned in.",
    );
    expect(
      whyConverted({ transcode_decision: "copy", container: "mkv", stream_container: "mpegts" }),
    ).toBe("Repackaged (mkv to mpegts), picture and sound untouched.");
  });
});

describe("stopping a stream", () => {
  it("names who and what, stops it, and checks it is gone", async () => {
    const ops = new TautulliOperations(handle, broker, fakeTautulli().fetch, async () => undefined);
    const planned = await ops.plan(
      service,
      { sessionId: "ph-2", message: "Server maintenance" },
      base,
    );
    expect(planned.label).toBe(
      'Stop sam\'s stream of Dune: Part Two on iPhone · Plex for iOS with the message "Server maintenance"',
    );
    const done = await ops.run(
      {
        kind: "app-tautulli-stop-stream",
        serviceId: "tautulli",
        requestedBy: "you",
        params: planned.params,
      },
      service,
    );
    expect(done).toMatchObject({
      ok: true,
      result: "Stopped sam's stream of Dune: Part Two; it is no longer playing.",
    });
    await expect(ops.plan(service, { sessionId: "ph-2" }, base)).rejects.toThrow(/already ended/);
  });
});
