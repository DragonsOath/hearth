import { describe, expect, it } from "vitest";
import type { ReleaseOption } from "./release-search";
import { blockReason, nearMiss, sizeCapGB } from "./smart-quality";

let n = 0;
const rel = (over: Partial<ReleaseOption>): ReleaseOption => ({
  guid: `g${++n}`,
  indexerId: 1,
  title: `Release ${n}`,
  approved: false,
  rejections: [],
  ...over,
});

describe("Smart Quality: near-miss check", () => {
  it("sorts Radarr's and Sonarr's rejection texts into plain reasons", () => {
    expect(blockReason("8.9 GiB is larger than maximum allowed 8 GiB")).toBe("size");
    expect(blockReason("150.0 MiB is smaller than minimum allowed 400.0 MiB")).toBe("too-small");
    expect(blockReason("Bluray-2160p is not wanted in profile")).toBe("quality");
    expect(blockReason("Existing file on disk is of equal or higher preference: WEBDL-1080p")).toBe(
      "already-have",
    );
    expect(blockReason("Custom Formats  scored 0, below the minimum custom format score 100")).toBe(
      "score",
    );
    expect(blockReason("Release is blocklisted")).toBe("blocklist");
    expect(blockReason("Language is not wanted")).toBe("language");
    expect(blockReason("Not enough seeders: 0. Minimum seeders: 1")).toBe("seeders");
    expect(blockReason("Something new")).toBe("other");
  });

  it("reads the size limit the app named", () => {
    expect(sizeCapGB("8.9 GiB is larger than maximum allowed 8 GiB")).toBe(8);
    expect(sizeCapGB("12.3 GB is larger than maximum allowed 6144.0 MiB")).toBe(6);
    expect(sizeCapGB("Bluray-1080p is not wanted in profile")).toBeUndefined();
  });

  it("nothing found at all", () => {
    expect(nearMiss({ releases: [], found: 0 })).toMatchObject({ kind: "none" });
  });

  it("one fits: Radarr can take it", () => {
    const r = nearMiss({ releases: [rel({ approved: true }), rel({})], found: 2 });
    expect(r).toMatchObject({ kind: "available", count: 1 });
    expect(r.sentence).toContain("Radarr can take one");
  });

  it("found, but only over the size cap: names the closest, the smallest of those", () => {
    const over = "is larger than maximum allowed 8 GiB";
    const r = nearMiss(
      {
        releases: [
          rel({ sizeGB: 12.4, quality: "Bluray-1080p", rejections: [`12.4 GiB ${over}`] }),
          rel({ sizeGB: 8.9, quality: "Bluray-1080p", rejections: [`8.9 GiB ${over}`] }),
          rel({ sizeGB: 9.6, quality: "WEBDL-1080p", rejections: [`9.6 GiB ${over}`] }),
          // Over the cap AND a quality not allowed: not a near miss.
          rel({
            sizeGB: 2,
            quality: "CAM",
            rejections: [`2 GiB ${over}`, "CAM is not wanted in profile"],
          }),
        ],
        found: 4,
      },
      "Radarr",
    );
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") return;
    expect(r.sizeOnly).toBe(3);
    expect(r.capGB).toBe(8);
    expect(r.closest?.sizeGB).toBe(8.9);
    expect(r.sentence).toBe(
      "Found 4 releases, but your own rules turned every one down. 3 are only over your size limit of 8 GB. Closest: 8.9 GB Bluray-1080p.",
    );
    expect(r.reasons[0]).toMatchObject({ why: "size", count: 4 });
  });

  it("found, but blocked for other reasons: says which, most first", () => {
    const r = nearMiss({
      releases: [
        rel({ rejections: ["Bluray-2160p is not wanted in profile"] }),
        rel({ rejections: ["Remux-2160p is not wanted in profile"] }),
        rel({ rejections: ["Release is blocklisted"] }),
      ],
      found: 3,
    });
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") return;
    expect(r.closest).toBeUndefined();
    expect(r.sentence).toBe(
      "Found 3 releases, but your own rules turned every one down: 2 a quality your settings don't allow, 1 on your blocklist.",
    );
  });
});
