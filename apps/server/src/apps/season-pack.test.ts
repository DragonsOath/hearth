import { describe, expect, it } from "vitest";
import { grabSeasonPacks, seasonPackChange, seasonPackParams } from "./season-pack";
import type { Call } from "./release-search";

/** A scripted Sonarr: the show turns up on the second look; season 1 has a pack it takes. */
function sonarr(opts: { arrivesAfter?: number } = {}) {
  let looks = 0;
  const grabbed: string[] = [];
  const queue: { title: string }[] = [];
  const releases: Record<number, unknown[]> = {
    1: [
      { guid: "ep", indexerId: 1, title: "Ghosts.S01E01.1080p", approved: true, fullSeason: false },
      {
        guid: "pack1",
        indexerId: 1,
        title: "Ghosts.S01.1080p",
        approved: true,
        fullSeason: true,
        size: 20e9,
      },
    ],
    // Season 2's pack breaks a rule (over the cap): turned down, so no pack.
    2: [
      {
        guid: "pack2",
        indexerId: 1,
        title: "Ghosts.S02.2160p",
        approved: false,
        fullSeason: true,
        rejections: ["Too big"],
      },
    ],
    3: [],
  };
  const call: Call = async (method, path, body) => {
    const ok = <T>(data: T) => ({ ok: true, status: 200, data: data as never });
    if (path === "/api/v3/series") {
      looks++;
      return ok(
        looks > (opts.arrivesAfter ?? 1)
          ? [
              {
                id: 7,
                tmdbId: 100,
                title: "Ghosts",
                seasons: [
                  { seasonNumber: 0 },
                  { seasonNumber: 1 },
                  { seasonNumber: 2 },
                  { seasonNumber: 3, monitored: false },
                ],
              },
            ]
          : [],
      );
    }
    const m = /seasonNumber=(\d+)/.exec(path);
    if (method === "GET" && path.startsWith("/api/v3/release?") && m)
      return ok(releases[Number(m[1])]);
    if (method === "POST" && path === "/api/v3/release") {
      const r = Object.values(releases)
        .flat()
        .find((x) => (x as { guid: string }).guid === (body as { guid: string }).guid) as {
        title: string;
      };
      grabbed.push(r.title);
      queue.push({ title: r.title });
      return ok({});
    }
    if (path.startsWith("/api/v3/queue")) return ok({ records: queue });
    return { ok: false, status: 404, data: undefined as never };
  };
  return { call, grabbed };
}
const wait = async () => {};

describe("a season pack for one request", () => {
  it("waits for the show, grabs only a pack Sonarr would take, leaves the rest to episodes", async () => {
    const s = sonarr({ arrivesAfter: 2 });
    const out = await grabSeasonPacks(s.call, { tmdbId: 100, title: "Ghosts" }, wait);
    expect(s.grabbed).toEqual(["Ghosts.S01.1080p"]);
    expect(out.ok).toBe(true);
    expect(out.result).toContain("Downloading 1 season pack.");
    expect(out.result).toContain("Season 1: Ghosts.S01.1080p (18.63 GB)");
    expect(out.result).toContain("Season 2: no pack Sonarr would take; episode by episode.");
    // Specials and unmonitored seasons are not tried.
    expect(out.result).not.toContain("Season 0");
    expect(out.result).not.toContain("Season 3");
  });

  it("only the seasons asked for; a show that never arrives downloads nothing", async () => {
    const s = sonarr();
    const out = await grabSeasonPacks(s.call, { tmdbId: 100, title: "Ghosts", seasons: [2] }, wait);
    expect(s.grabbed).toEqual([]);
    expect(out.result).toContain("No season pack downloaded.");
    const never = sonarr({ arrivesAfter: 99 });
    const none = await grabSeasonPacks(never.call, { tmdbId: 100, title: "Ghosts" }, wait, 3);
    expect(never.grabbed).toEqual([]);
    expect(none.result).toContain("has not reached Sonarr yet");
  });

  it("checks its params and says what it will do in the plan", () => {
    expect(seasonPackParams({})).toBe("Say which show (params.tmdbId).");
    expect(seasonPackParams({ tmdbId: 5, seasons: "0" })).toContain("season numbers");
    expect(seasonPackParams({ tmdbId: 5, title: "X", seasons: "1,2,2" })).toEqual({
      tmdbId: 5,
      title: "X",
      seasons: [1, 2],
    });
    const c = seasonPackChange("Sonarr", { tmdbId: 5, title: "X", seasons: [1, 2] });
    expect(c.summary).toBe("Try a season pack for X in Sonarr");
    expect(c.settings[0]!.name).toBe("Seasons 1, 2");
    expect(c.settings[0]!.after).toContain("else episode by episode");
  });
});
