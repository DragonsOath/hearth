import { describe, expect, it } from "vitest";
import {
  buildTemplate,
  choicesOf,
  extensionOf,
  pathMatches,
  previewPath,
  templateProblem,
  zonesThatFit,
} from "./immich-storage";

/**
 * Building Immich's storage template from plain choices and previewing paths. The expected paths
 * are what a throwaway Immich 3.2.4 actually wrote for the same photos and pattern.
 */

const beach = { name: "Beach.jpeg", takenAt: "2025-01-12T09:30:00.000Z", owner: "admin" };
const inAlbum = {
  name: "IMG_0006.jpg",
  takenAt: "2026-03-02T14:00:00.000Z",
  owner: "admin",
  album: "Utah Trip",
};

describe("Immich's storage template", () => {
  it("builds patterns from choices and reads them back", () => {
    const t = buildTemplate("album", "date");
    expect(t).toBe(
      "{{#if album}}{{album}}{{else}}{{y}}/{{MM}}{{/if}}/{{y}}-{{MM}}-{{dd}} {{filename}}",
    );
    expect(choicesOf(t)).toEqual({ folder: "album", name: "date" });
    expect(choicesOf("{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}")).toBeUndefined();
  });

  it("previews the paths Immich 3.2.4 wrote", () => {
    const t = buildTemplate("album", "date");
    expect(previewPath(t, inAlbum)).toBe("library/admin/Utah Trip/2026-03-02 IMG_0006.jpg");
    // Not in an album: by year and month; .jpeg becomes .jpg, as Immich does.
    expect(previewPath(t, beach)).toBe("library/admin/2025/01/2025-01-12 Beach.jpg");
    expect(previewPath(buildTemplate("year", "original"), beach)).toBe(
      "library/admin/2025/Beach.jpg",
    );
    expect(previewPath(buildTemplate("year-month", "album-date"), inAlbum)).toBe(
      "library/admin/2026/03/Utah Trip 2026-03-02 IMG_0006.jpg",
    );
    expect(previewPath(buildTemplate("year-month", "album-date"), beach)).toBe(
      "library/admin/2025/01/2025-01-12 Beach.jpg",
    );
    // Immich's own default.
    expect(previewPath("{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}", beach)).toBe(
      "library/admin/2025/2025-01-12/Beach.jpg",
    );
  });

  it("cleans album names as Immich does, and keeps paths inside the library", () => {
    expect(
      previewPath(buildTemplate("album", "original"), { ...inAlbum, album: "Trip: v1.0 / ../x" }),
    ).toBe("library/admin/Trip v10  x/IMG_0006.jpg");
    expect(extensionOf("a.TIF")).toBe("tiff");
  });

  it("says plainly what is wrong with a pattern", () => {
    expect(templateProblem("{{y}}/{{MM}}")).toMatch(/needs the file name/);
    expect(templateProblem("{{#if album}}{{album}}/{{filename}}")).toMatch(/not closed/);
    expect(templateProblem("{{nope}}/{{filename}}")).toMatch(/does not know \{\{nope\}\}/);
    expect(templateProblem(buildTemplate("album", "album-date"))).toBeUndefined();
  });

  it("checks where Immich put a file, allowing its +1 for a clash", () => {
    const want = "library/admin/2025/Beach.jpg";
    expect(pathMatches("/data/library/admin/2025/Beach.jpg", want)).toBe(true);
    expect(pathMatches("/data/library/admin/2025/Beach+2.jpg", want)).toBe(true);
    expect(pathMatches("/data/upload/u/ab/cd/x.jpg", want)).toBe(false);
  });

  it("works out Immich's time zone from where it filed photos (a throwaway Immich 3.2.4 with TZ=America/Denver)", () => {
    const t = buildTemplate("album", "date");
    // What that Immich actually wrote: Late.jpg, taken 03:30 UTC on March 10, is March 9 in Denver.
    const filed = [
      {
        name: "Late.jpg",
        takenAt: "2025-03-10T03:30:00.000Z",
        owner: "admin",
        path: "/data/library/admin/2025/03/2025-03-09 Late.jpg",
      },
      {
        name: "IMG_0004.jpg",
        takenAt: "2025-01-13T18:00:00.000Z",
        owner: "admin",
        path: "/data/library/admin/2025/01/2025-01-13 IMG_0004.jpg",
      },
      { ...inAlbum, path: "/data/library/admin/Utah Trip/2026-03-02 IMG_0006.jpg" },
    ];
    const zones = zonesThatFit(t, filed)!;
    expect(zones).toContain("America/Denver");
    expect(zones).not.toContain("UTC");
    expect(previewPath(t, filed[0]!, "America/Denver")).toBe(
      "library/admin/2025/03/2025-03-09 Late.jpg",
    );
    // Daylight saving: summer and winter photos both fit Denver (UTC-6 then, UTC-7 now).
    const summer = { name: "a.jpg", takenAt: "2024-07-05T05:30:00.000Z", owner: "admin" };
    expect(previewPath(t, summer, "America/Denver")).toBe("library/admin/2024/07/2024-07-04 a.jpg");
    // Nothing filed by a dated pattern yet: unknown, so the preview stays on UTC.
    expect(zonesThatFit(t, [{ ...beach, path: "/data/upload/u/ab/cd/x.jpg" }])).toBeUndefined();
    expect(zonesThatFit(buildTemplate("album", "original"), filed)).toBeUndefined();
  });
});
