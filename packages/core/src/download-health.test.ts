import { describe, expect, it } from "vitest";
import {
  assess,
  explainImport,
  explainUsenet,
  type DownloadObservation,
  type Strike,
} from "./download-health";

const T0 = "2026-11-07T10:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const stalled = (
  key: string,
  bytes = 100,
  extra: Partial<DownloadObservation> = {},
): DownloadObservation => ({
  key: `qbt1:${key}`,
  title: key,
  client: "qBittorrent",
  clientServiceId: "qbt1",
  problem: "stalled",
  downloadedBytes: bytes,
  ...extra,
});

/** Runs several checks, carrying the strikes along. */
function checks(
  rounds: {
    min: number;
    seen: DownloadObservation[];
    down?: { serviceId: string; name: string }[];
  }[],
) {
  let strikes: Record<string, Strike> = {};
  let last: ReturnType<typeof assess> | undefined;
  for (const r of rounds) {
    last = assess(r.seen, strikes, at(r.min), undefined, r.down);
    strikes = last.strikes;
  }
  return last!;
}

describe("download health strikes", () => {
  it("a stalled download needs attention only after 3 checks over at least an hour", () => {
    expect(
      checks([
        { min: 0, seen: [stalled("a")] },
        { min: 5, seen: [stalled("a")] },
        { min: 10, seen: [stalled("a")] },
      ]).items[0],
    ).toMatchObject({ state: "watching", strikes: 3 });
    const late = checks([
      { min: 0, seen: [stalled("a")] },
      { min: 30, seen: [stalled("a")] },
      { min: 61, seen: [stalled("a")] },
    ]);
    expect(late.items[0]).toMatchObject({ state: "attention", strikes: 3 });
    expect(late.items[0]!.explain).toContain("isn't making progress");
  });

  it("any progress clears the strikes: slow is not broken", () => {
    const r = checks([
      { min: 0, seen: [stalled("a", 100)] },
      { min: 30, seen: [stalled("a", 100)] },
      { min: 61, seen: [stalled("a", 500)] },
    ]);
    expect(r.items).toEqual([]);
    expect(r.strikes["qbt1:a"]).toBeUndefined();
  });

  it("an unreachable client gives no strikes and keeps the ones it had", () => {
    const r = checks([
      { min: 0, seen: [stalled("a")] },
      { min: 30, seen: [stalled("a")], down: [{ serviceId: "qbt1", name: "qBittorrent" }] },
    ]);
    expect(r.strikes["qbt1:a"]!.count).toBe(1);
    expect(r.items).toEqual([]);
    expect(r.causes[0]!.text).toContain("can't reach qBittorrent");
  });

  it("many stalled at once is one shared cause, held back from attention", () => {
    const many = ["a", "b", "c", "d", "e"].map((k) => stalled(k));
    const r = checks([
      { min: 0, seen: many },
      { min: 30, seen: many },
      { min: 61, seen: many },
    ]);
    expect(r.causes).toHaveLength(1);
    expect(r.causes[0]!.text).toContain("5 downloads in qBittorrent stopped at the same time");
    expect(r.items.every((i) => i.state === "watching" && i.sharedCause)).toBe(true);
  });

  it("failures and failed imports need attention at once", () => {
    const r = assess(
      [
        {
          key: "sab1:x",
          title: "x",
          client: "SABnzbd",
          clientServiceId: "sab1",
          problem: "usenet-failed",
          final: true,
          detail: "Aborted, cannot be completed",
        },
      ],
      {},
      T0,
    );
    expect(r.items[0]).toMatchObject({ state: "attention" });
    expect(r.items[0]!.explain).toContain("no longer on your Usenet provider");
  });

  it("explains the apps' and SABnzbd's own words plainly", () => {
    expect(explainImport("Episode 12x09 was not found in the grabbed release")).toContain(
      "manual import",
    );
    expect(explainImport("No files found are eligible for import")).toContain("no usable video");
    expect(explainUsenet("Unpacking failed, archive requires a password")).toContain("password");
    const r = assess(
      [
        {
          key: "s:1",
          title: "y",
          client: "Sonarr",
          clientServiceId: "s",
          problem: "download-failed",
          final: true,
          detail: "Repair failed, not enough repair blocks (4 short)",
        },
      ],
      {},
      T0,
    );
    expect(r.items[0]!.explain).toContain("Usenet provider");
  });
});
