import { describe, expect, it } from "vitest";
import { CRUCIBLE_PRESETS, type StepParams } from "@dragon-control/core";
import { planCrucible, runCrucible, undoCrucible, type Arr } from "./crucible-apply";
import { fakeRadarr } from "./fake-radarr";

/** The Crucible's Save against the stand-in Radarr. */

function radarr() {
  const app = fakeRadarr();
  const arr: Arr = async (method, path, _purpose, body) => {
    const res = await app.fetch(`http://10.0.0.5:7879${path}`, {
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
  const get = async <T>(path: string) => (await arr<T>("GET", path, "test")).data;
  return { arr, get, app };
}

const storageSmart = () => JSON.stringify(CRUCIBLE_PRESETS["storage-smart"].setup());
type P = {
  id: number;
  name: string;
  upgradeAllowed: boolean;
  formatItems: { name: string; score: number }[];
  items: { quality?: { name: string }; allowed: boolean; items?: unknown[] }[];
};

describe("the Crucible's Save", () => {
  it("plans in words, creates Hearth's own profiles and caps, and touches nothing else", async () => {
    const { arr, get } = radarr();
    const ownBefore = JSON.stringify(
      (await get<P[]>("/api/v3/qualityprofile")).filter((p) => !p.name.startsWith("Hearth")),
    );
    const [change, params] = await planCrucible(arr, "Radarr", { setup: storageSmart() }, 2026);
    expect(change.summary).toBe("Save the Crucible's movie rows in Radarr");
    expect(change.settings.map((s) => s.name)).toContain("Turn down 4K over 25 GB");
    expect(change.settings.find((s) => s.name === "Big new releases")?.after).toBe(
      "4K up to 25 GB, else 1080p up to 10 GB, upgrades when a better one fits",
    );
    expect(change.settings.at(-1)).toMatchObject({
      name: "Movies you already have",
      after: expect.stringContaining("Unchanged"),
    });

    const r = await runCrucible(arr, "Radarr", params);
    expect(r).toMatchObject({ ok: true, verified: true });
    const profiles = await get<P[]>("/api/v3/qualityprofile");
    const big = profiles.find((p) => p.name === "Hearth · Big new releases")!;
    expect(big.formatItems.find((f) => f.name === "Hearth · 2160p over 25 GB")?.score).toBe(-10000);
    expect(big.formatItems.find((f) => f.name === "Hearth · 1080p over 4 GB")?.score).toBe(0);
    const allowed = big.items
      .flatMap((i) => (i.items?.length ? (i.items as typeof big.items) : [i]))
      .filter((i) => i.allowed)
      .map((i) => i.quality?.name);
    expect(allowed.some((n) => n?.includes("2160p"))).toBe(true);
    expect(allowed.some((n) => n?.includes("720p"))).toBe(false);
    // Radarr's own (or Recyclarr's) profiles are exactly as they were.
    expect(JSON.stringify(profiles.filter((p) => !p.name.startsWith("Hearth")))).toBe(ownBefore);
    const formats = await get<
      {
        name: string;
        specifications: { implementation: string; fields: { name: string; value: number }[] }[];
      }[]
    >("/api/v3/customformat");
    const cap = formats.find((f) => f.name === "Hearth · 2160p over 25 GB")!;
    expect(
      cap.specifications.find((s) => s.implementation === "SizeSpecification")?.fields,
    ).toEqual([
      { name: "min", value: 25 },
      { name: "max", value: 1000 },
    ]);
  });

  it("moves the movies you have only when asked, and Undo puts everything back", async () => {
    const { arr, get } = radarr();
    const before = await get<{ id: number; qualityProfileId: number }[]>("/api/v3/movie");
    const formatsBefore = (await get<{ name: string }[]>("/api/v3/customformat")).length;
    const [change, params] = await planCrucible(
      arr,
      "Radarr",
      { setup: storageSmart(), resort: true },
      2026,
    );
    expect(change.settings.at(-1)?.after).toMatch(/Each moves to its row's profile \(\d+ movies\)/);
    const moved = JSON.parse(String(params.moves)) as unknown[];
    expect(moved.length).toBeGreaterThan(0);
    expect(await runCrucible(arr, "Radarr", params)).toMatchObject({ ok: true, verified: true });
    const profiles = await get<P[]>("/api/v3/qualityprofile");
    const names = new Map(profiles.map((p) => [p.id, p.name]));
    const now =
      await get<{ id: number; title: string; year: number; qualityProfileId: number }[]>(
        "/api/v3/movie",
      );
    expect(now.every((m) => names.get(m.qualityProfileId)?.startsWith("Hearth · "))).toBe(true);

    const undone = await undoCrucible(arr, "Radarr", params as StepParams);
    expect(undone).toMatchObject({ ok: true, verified: true });
    const back = await get<{ id: number; qualityProfileId: number }[]>("/api/v3/movie");
    expect(back.map((m) => [m.id, m.qualityProfileId])).toEqual(
      before.map((m) => [m.id, m.qualityProfileId]),
    );
    expect(
      (await get<P[]>("/api/v3/qualityprofile")).some((p) => p.name.startsWith("Hearth")),
    ).toBe(false);
    expect((await get<{ name: string }[]>("/api/v3/customformat")).length).toBe(formatsBefore);
  });

  it("stops without changing anything when Hearth's profiles changed since the plan", async () => {
    const { arr, get } = radarr();
    const [, first] = await planCrucible(arr, "Radarr", { setup: storageSmart() }, 2026);
    await runCrucible(arr, "Radarr", first);
    const [, second] = await planCrucible(arr, "Radarr", { setup: storageSmart() }, 2026);
    // Someone edits a Hearth profile in Radarr itself.
    const p = (await get<P[]>("/api/v3/qualityprofile")).find(
      (x) => x.name === "Hearth · Newer movies",
    )!;
    await arr("PUT", `/api/v3/qualityprofile/${p.id}`, "test", {
      ...p,
      upgradeAllowed: !p.upgradeAllowed,
    });
    const r = await runCrucible(arr, "Radarr", second);
    expect(r).toMatchObject({ ok: false, stale: true });
    expect(r.result).toContain("changed since this plan was made");
  });

  it("refuses a setup it can't use", async () => {
    const { arr } = radarr();
    await expect(planCrucible(arr, "Radarr", { setup: "{}" })).rejects.toThrow("no movie rows");
    const bad = CRUCIBLE_PRESETS.balanced.setup();
    bad.movies[1]!.name = bad.movies[0]!.name;
    await expect(planCrucible(arr, "Radarr", { setup: JSON.stringify(bad) })).rejects.toThrow(
      "same name",
    );
  });
});

describe("the Crucible's keeper", () => {
  it("gives a movie added after Save its row's profile, once, and leaves the ones before alone", async () => {
    const { keepNewMovies } = await import("./crucible-keeper");
    const { arr, get } = radarr();
    const setup = CRUCIBLE_PRESETS["storage-smart"].setup();
    const [, params] = await planCrucible(arr, "Radarr", { setup: JSON.stringify(setup) }, 2026);
    await runCrucible(arr, "Radarr", params);
    const movies = await get<{ id: number; qualityProfileId: number }[]>("/api/v3/movie");
    const seen = Math.max(...movies.map((m) => m.id));
    // First look ever: nothing moves.
    expect((await keepNewMovies(arr, setup, undefined, 2026)).moved).toEqual([]);
    // A Seerr request lands in Radarr with its default profile.
    await arr("POST", "/api/v3/movie", "test", {
      title: "Old Harbour Tales",
      year: 1979,
      tmdbId: 424242,
      qualityProfileId: 1,
      rootFolderPath: "/movies",
      status: "released",
      genres: ["Drama"],
    });
    const r = await keepNewMovies(arr, setup, seen, 2026);
    expect(r.moved).toEqual([{ title: "Old Harbour Tales (1979)", to: "Classics (30+ years)" }]);
    const profiles = await get<{ id: number; name: string }[]>("/api/v3/qualityprofile");
    const now = await get<{ title: string; qualityProfileId: number }[]>("/api/v3/movie");
    const added = now.find((m) => m.title === "Old Harbour Tales")!;
    expect(profiles.find((p) => p.id === added.qualityProfileId)?.name).toBe(
      "Hearth · Classics (30+ years)",
    );
    // The movies there before keep their profiles; and the new one isn't touched again.
    for (const m of movies)
      expect(now.find((x) => (x as { id?: number }).id === m.id)?.qualityProfileId).toBe(
        m.qualityProfileId,
      );
    expect((await keepNewMovies(arr, setup, r.lastId, 2026)).moved).toEqual([]);
  });
});

describe("the Crucible wins the race with Radarr's first search", () => {
  const added = (search: boolean, profile = 1) => ({
    title: "Old Harbour Tales",
    year: 1979,
    tmdbId: 424242,
    qualityProfileId: profile,
    rootFolderPath: "/movies",
    status: "released",
    monitored: true,
    genres: ["Drama"],
    addOptions: { searchForMovie: search },
  });

  it("Save sets up Radarr's On Movie Added webhook to Hearth, and Undo removes it", async () => {
    const { arr, get } = radarr();
    const setup = JSON.stringify(CRUCIBLE_PRESETS["storage-smart"].setup());
    const [change, params] = await planCrucible(
      arr,
      "Radarr",
      { setup, hookBase: "http://192.168.1.77:7499/anything" },
      2026,
    );
    expect(change.settings.at(-1)).toMatchObject({
      name: "Tell Hearth the moment a movie is added",
      after: expect.stringContaining("http://192.168.1.77:7499 (a private link)"),
    });
    const url = "http://192.168.1.77:7499/api/crucible/hook/radarr?key=secret";
    expect(await runCrucible(arr, "Radarr", params, { hookUrl: url })).toMatchObject({
      ok: true,
      verified: true,
    });
    const hooks = (
      await get<
        { name: string; onMovieAdded: boolean; fields: { name: string; value: unknown }[] }[]
      >("/api/v3/notification")
    ).filter((n) => n.name === "Hearth · The Crucible");
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.onMovieAdded).toBe(true);
    expect(hooks[0]!.fields.find((f) => f.name === "url")?.value).toBe(url);
    await undoCrucible(arr, "Radarr", params);
    expect(
      (await get<{ name: string }[]>("/api/v3/notification")).some(
        (n) => n.name === "Hearth · The Crucible",
      ),
    ).toBe(false);
  });

  it("a Seerr request added without Seerr's search: sorted at once, then searched with its row's profile", async () => {
    const { sortOne } = await import("./crucible-keeper");
    const { arr, get, app } = radarr();
    const setup = { ...CRUCIBLE_PRESETS["storage-smart"].setup(), searchAfterSorting: true };
    const [, params] = await planCrucible(arr, "Radarr", { setup: JSON.stringify(setup) }, 2026);
    await runCrucible(arr, "Radarr", params);
    const classics = (await get<{ id: number; name: string }[]>("/api/v3/qualityprofile")).find(
      (p) => p.name === "Hearth · Classics (30+ years)",
    )!;
    // Seerr adds it (its automatic search off, so Radarr doesn't search on add)...
    const made = (await arr<{ id: number }>("POST", "/api/v3/movie", "test", added(false))).data;
    expect(app.searches().filter((x) => x.movieId === made.id)).toEqual([]);
    // ...Radarr's webhook arrives, and Hearth sorts it, then starts the search.
    const r = await sortOne(arr, setup, made.id, 2026);
    expect(r).toMatchObject({ to: "Classics (30+ years)", searched: true });
    expect(app.searches().filter((x) => x.movieId === made.id)).toEqual([
      { movieId: made.id, profileId: classics.id, on: "command" },
    ]);
  });

  it("added and searched immediately from Hearth: added with its row's profile, so the first search uses it", async () => {
    const { arr, get, app } = radarr();
    const setup = CRUCIBLE_PRESETS["storage-smart"].setup();
    const [, params] = await planCrucible(arr, "Radarr", { setup: JSON.stringify(setup) }, 2026);
    await runCrucible(arr, "Radarr", params);
    const { rowFor, rowProfileName } = await import("@dragon-control/core");
    const row = rowFor({ year: 1979, genres: ["Drama"] }, setup.movies, 2026)!;
    const profile = (await get<{ id: number; name: string }[]>("/api/v3/qualityprofile")).find(
      (p) => p.name === rowProfileName(row),
    )!;
    // What Hearth's Add movie sends (the Crucible's row chosen for it), with "search now" on.
    const made = (
      await arr<{ id: number }>("POST", "/api/v3/movie", "test", added(true, profile.id))
    ).data;
    expect(app.searches().filter((x) => x.movieId === made.id)).toEqual([
      { movieId: made.id, profileId: profile.id, on: "add" },
    ]);
  });

  it("added and searched immediately in Radarr's own page: sorted at once, but that first search already ran", async () => {
    const { sortOne } = await import("./crucible-keeper");
    const { arr, app } = radarr();
    const setup = CRUCIBLE_PRESETS["storage-smart"].setup();
    const [, params] = await planCrucible(arr, "Radarr", { setup: JSON.stringify(setup) }, 2026);
    await runCrucible(arr, "Radarr", params);
    const made = (await arr<{ id: number }>("POST", "/api/v3/movie", "test", added(true, 1))).data;
    const r = await sortOne(arr, setup, made.id, 2026);
    expect(r.to).toBe("Classics (30+ years)");
    // The one search Radarr started on add used the profile it was added with; Hearth doesn't
    // search again (searchAfterSorting is for Seerr with its own search off).
    expect(app.searches().filter((x) => x.movieId === made.id)).toEqual([
      { movieId: made.id, profileId: 1, on: "add" },
    ]);
  });
});

describe("the Crucible as the checkpoint for every request", () => {
  it("a Seerr request waits on the holding profile, RSS sync grabs nothing, then it gets its row and the first search", async () => {
    const { sortOne, keepNewMovies } = await import("./crucible-keeper");
    const { HOLD_PROFILE } = await import("@dragon-control/core");
    const { arr, get, app } = radarr();
    const setup = { ...CRUCIBLE_PRESETS["storage-smart"].setup(), searchAfterSorting: true };
    const [change, params] = await planCrucible(
      arr,
      "Radarr",
      { setup: JSON.stringify(setup) },
      2026,
    );
    expect(change.settings.map((s) => s.name)).toContain("Requests wait for the Crucible");
    expect(await runCrucible(arr, "Radarr", params)).toMatchObject({ ok: true, verified: true });
    const profiles = await get<{ id: number; name: string }[]>("/api/v3/qualityprofile");
    const hold = profiles.find((p) => p.name === HOLD_PROFILE)!;
    const classics = profiles.find((p) => p.name === "Hearth · Classics (30+ years)")!;
    expect(hold).toBeDefined();

    // Seerr (its automatic search off, its default profile the holding one) adds two requests.
    const add = async (title: string, tmdbId: number) =>
      (
        await arr<{ id: number }>("POST", "/api/v3/movie", "test", {
          title,
          year: 1979,
          tmdbId,
          qualityProfileId: hold.id,
          rootFolderPath: "/movies",
          monitored: true,
          genres: ["Drama"],
          addOptions: { searchForMovie: false },
        })
      ).data.id;
    const first = await add("Old Harbour Tales", 424242);
    const second = await add("Night Ferry", 424243);

    // Radarr's RSS sync runs before the Crucible does anything: nothing can be grabbed.
    await arr("POST", "/api/v3/command", "test", { name: "RssSync" });
    expect(app.grabs().filter((g) => [first, second].includes(g.movieId))).toEqual([]);

    // The webhook for the first: its row, then the search, which grabs under the row's profile.
    expect(await sortOne(arr, setup, first, 2026)).toMatchObject({
      to: "Classics (30+ years)",
      searched: true,
    });
    expect(app.searches().filter((x) => x.movieId === first)).toEqual([
      { movieId: first, profileId: classics.id, on: "command" },
    ]);
    expect(app.grabs().filter((g) => g.movieId === first)).toEqual([
      { movieId: first, profileId: classics.id, by: "search" },
    ]);

    // Hearth was down for the second (no webhook): the safety net catches it up, however old.
    const r = await keepNewMovies(arr, setup, 999_999, 2026);
    expect(r.moved).toEqual([{ title: "Night Ferry (1979)", to: "Classics (30+ years)" }]);
    expect(app.searches().filter((x) => x.movieId === second)).toEqual([
      { movieId: second, profileId: classics.id, on: "command" },
    ]);
  });
});

describe("never stranded on the holding profile (the clean exit)", () => {
  async function checkpointOn() {
    const { HOLD_PROFILE } = await import("@dragon-control/core");
    const { arr, get, app } = radarr();
    const setup = { ...CRUCIBLE_PRESETS["storage-smart"].setup(), searchAfterSorting: true };
    const [, params] = await planCrucible(arr, "Radarr", { setup: JSON.stringify(setup) }, 2026);
    await runCrucible(arr, "Radarr", params);
    const profiles = await get<{ id: number; name: string }[]>("/api/v3/qualityprofile");
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
    return { arr, get, app, setup, params, profiles, hold, held };
  }
  const profileOf = async (get: <T>(p: string) => Promise<T>, id: number) =>
    (await get<{ qualityProfileId: number }>(`/api/v3/movie/${id}`)).qualityProfileId;

  it("turning the checkpoint off gives waiting requests their row and searches them", async () => {
    const { arr, get, app, setup, profiles, held } = await checkpointOn();
    const off = { ...setup, searchAfterSorting: false };
    const [, p2] = await planCrucible(arr, "Radarr", { setup: JSON.stringify(off) }, 2026);
    const r = await runCrucible(arr, "Radarr", p2);
    expect(r.result).toContain("1 waiting request got their row");
    const classics = profiles.find((p) => p.name === "Hearth · Classics (30+ years)")!;
    expect(await profileOf(get, held)).toBe(classics.id);
    expect(app.grabs().filter((g) => g.movieId === held)).toEqual([
      { movieId: held, profileId: classics.id, by: "search" },
    ]);
  });

  it("Undo moves every movie off Hearth's profiles before removing them, and searches the waiting ones", async () => {
    const { arr, get, app, params, held } = await checkpointOn();
    const r = await undoCrucible(arr, "Radarr", params, { fallback: { id: 1 } });
    expect(r).toMatchObject({ ok: true, verified: true });
    expect(r.result).toContain("1 waiting request was moved off the holding profile and searched");
    expect(await profileOf(get, held)).toBe(1);
    expect(app.grabs().filter((g) => g.movieId === held)).toEqual([
      { movieId: held, profileId: 1, by: "search" },
    ]);
    const names = (await get<{ name: string }[]>("/api/v3/qualityprofile")).map((p) => p.name);
    expect(names.some((n) => n.startsWith("Hearth · "))).toBe(false);
  });

  it("automatic sorting off still releases a waiting request (and leaves other new movies alone)", async () => {
    const { keepNewMovies } = await import("./crucible-keeper");
    const { arr, get, setup, profiles, held } = await checkpointOn();
    const plain = (
      await arr<{ id: number }>("POST", "/api/v3/movie", "test", {
        title: "Night Ferry",
        year: 1979,
        tmdbId: 424243,
        qualityProfileId: 1,
        rootFolderPath: "/movies",
        monitored: true,
        genres: ["Drama"],
        addOptions: { searchForMovie: false },
      })
    ).data.id;
    const r = await keepNewMovies(arr, { ...setup, autoAssign: false }, 0, 2026, true);
    expect(r.moved.map((m) => m.title)).toEqual(["Old Harbour Tales (1979)"]);
    const classics = profiles.find((p) => p.name === "Hearth · Classics (30+ years)")!;
    expect(await profileOf(get, held)).toBe(classics.id);
    expect(await profileOf(get, plain)).toBe(1);
  });
});

describe("smaller wins when quality is equal (step 10)", () => {
  type Spec = { implementation: string; fields: { name: string; value: number }[] };
  type Format = { name: string; specifications: Spec[] };
  type Profile = {
    name: string;
    minUpgradeFormatScore: number;
    formatItems: { name: string; score: number }[];
  };

  it("adds size bands that score a smaller release of the same quality higher, never enough to upgrade", async () => {
    const { arr, get } = radarr();
    const setup = JSON.stringify(CRUCIBLE_PRESETS["storage-smart"].setup());
    const [change, params] = await planCrucible(arr, "Radarr", { setup }, 2026);
    expect(
      change.settings.find((s) => s.name === "Same quality: take the smaller one")?.after,
    ).toMatch(/^On: 10 size bands/);
    expect(await runCrucible(arr, "Radarr", params)).toMatchObject({ ok: true, verified: true });
    const bands = (await get<Format[]>("/api/v3/customformat")).filter((f) =>
      f.name.startsWith("Hearth · Smaller 1080p"),
    );
    expect(bands.map((f) => f.name).sort()).toEqual([
      "Hearth · Smaller 1080p (under 12 GB)",
      "Hearth · Smaller 1080p (under 4 GB)",
      "Hearth · Smaller 1080p (under 8 GB)",
    ]);
    // What a 1080p release scores from the bands: under more of them = smaller = higher.
    const under = (gb: number) =>
      bands.filter((f) => {
        const size = f.specifications.find((s) => s.implementation === "SizeSpecification")!;
        return gb <= size.fields.find((x) => x.name === "max")!.value;
      }).length;
    expect(under(3)).toBeGreaterThan(under(10));
    const profiles = (await get<Profile[]>("/api/v3/qualityprofile")).filter((p) =>
      p.name.startsWith("Hearth · "),
    );
    for (const p of profiles) {
      expect(
        p.formatItems.filter((f) => f.name.startsWith("Hearth · Smaller ") && f.score === 1),
      ).toHaveLength(10);
      // At most +3 from the bands, so they alone never trigger a re-download.
      expect(p.minUpgradeFormatScore).toBeGreaterThanOrEqual(4);
    }
  });

  it("is off when the owner turns it off", async () => {
    const { arr, get } = radarr();
    const setup = JSON.stringify({
      ...CRUCIBLE_PRESETS["storage-smart"].setup(),
      smallerWins: false,
    });
    const [change, params] = await planCrucible(arr, "Radarr", { setup }, 2026);
    expect(
      change.settings.find((s) => s.name === "Same quality: take the smaller one")?.after,
    ).toBe("Off");
    await runCrucible(arr, "Radarr", params);
    expect(
      (await get<Format[]>("/api/v3/customformat")).some((f) =>
        f.name.startsWith("Hearth · Smaller"),
      ),
    ).toBe(false);
  });
});

describe("wait for the best first (a row's waitHours)", () => {
  type Delay = {
    id: number;
    usenetDelay: number;
    torrentDelay: number;
    bypassIfHighestQuality: boolean;
    tags: number[];
  };
  type Tag = { id: number; label: string };
  type Movie = { id: number; title: string; tags: number[]; qualityProfileId: number };

  it("makes a delay profile on the row's tag, tags its movies before any search, and Undo removes it", async () => {
    const { sortOne } = await import("./crucible-keeper");
    const { arr, get } = radarr();
    const base = CRUCIBLE_PRESETS["storage-smart"].setup();
    const big = base.movies.find((r) => r.ladder.length > 1 && r.ladder[0]!.quality === "2160p")!;
    const setup = {
      ...base,
      movies: base.movies.map((r) => (r === big ? { ...r, waitHours: 48 } : r)),
    };
    const delaysBefore = await get<Delay[]>("/api/v3/delayprofile");
    const [change, params] = await planCrucible(
      arr,
      "Radarr",
      { setup: JSON.stringify(setup), resort: true },
      2026,
    );
    expect(
      change.settings.find((s) => s.name === `${big.name}: wait for the best first`)?.after,
    ).toMatch(/^Wait up to 2 days for 4K before settling for 1080p; no wait once it turns up/);
    expect(await runCrucible(arr, "Radarr", params)).toMatchObject({ ok: true, verified: true });

    const tag = (await get<Tag[]>("/api/v3/tag")).find((t) => t.label === `hearth-wait-${big.id}`)!;
    expect(tag).toBeDefined();
    const delay = (await get<Delay[]>("/api/v3/delayprofile")).find((d) =>
      d.tags.includes(tag.id),
    )!;
    expect(delay).toMatchObject({
      usenetDelay: 2880,
      torrentDelay: 2880,
      bypassIfHighestQuality: true,
    });
    const bigProfile = (await get<{ id: number; name: string }[]>("/api/v3/qualityprofile")).find(
      (p) => p.name === `Hearth · ${big.name}`,
    )!;
    const movies = await get<Movie[]>("/api/v3/movie");
    for (const m of movies)
      expect(m.tags.includes(tag.id)).toBe(m.qualityProfileId === bigProfile.id);

    // A new movie in that row gets the tag with its profile (before the first search).
    const made = (
      await arr<{ id: number }>("POST", "/api/v3/movie", "test", {
        title: "Brand New Spectacle",
        year: 2026,
        tmdbId: 990001,
        qualityProfileId: 1,
        rootFolderPath: "/movies",
        monitored: true,
        genres: ["Action"],
        popularity: 500,
        addOptions: { searchForMovie: false },
      })
    ).data;
    const r = await sortOne(arr, setup, made.id, 2026);
    expect(r.to).toBe(big.name);
    expect((await get<Movie>(`/api/v3/movie/${made.id}`)).tags).toContain(tag.id);

    // Undo: the delay profiles are back as they were.
    await undoCrucible(arr, "Radarr", params);
    expect(await get<Delay[]>("/api/v3/delayprofile")).toEqual(delaysBefore);
  });

  it("a row that stops waiting loses its delay profile", async () => {
    const { arr, get } = radarr();
    const base = CRUCIBLE_PRESETS["storage-smart"].setup();
    const big = base.movies.find((r) => r.ladder.length > 1)!;
    const waiting = {
      ...base,
      movies: base.movies.map((r) => (r === big ? { ...r, waitHours: 24 } : r)),
    };
    const [, p1] = await planCrucible(arr, "Radarr", { setup: JSON.stringify(waiting) }, 2026);
    await runCrucible(arr, "Radarr", p1);
    const count = async () => (await get<Delay[]>("/api/v3/delayprofile")).length;
    const withWait = await count();
    const [, p2] = await planCrucible(arr, "Radarr", { setup: JSON.stringify(base) }, 2026);
    expect(await runCrucible(arr, "Radarr", p2)).toMatchObject({ ok: true, verified: true });
    expect(await count()).toBe(withWait - 1);
  });
});
