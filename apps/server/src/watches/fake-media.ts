import type { Fetch } from "../apps/http";

/**
 * Browser tests and safe previews only (DC_FAKE_APPS=1, never set in a real install): a stand-in
 * Seerr (port 5055) and Radarr (port 7878) with a few requested movies, one in each state a
 * release watch can be in. Dates are relative to today, so the states hold whenever it runs.
 * Tests steer it (a date moves, a movie arrives) through the fake apps' control route.
 */

interface FakeMovie {
  /** Its quality profile in Radarr, when changed (Upgrade quality). */
  profile?: number;
  /** Searches Radarr was asked to run for it. */
  searches?: number;
  /** Its root folder in Radarr, when changed from the default. */
  root?: string;
  /** Seerr's request status (1 waiting for approval, 2 approved, 3 declined); 2 unless set. */
  status?: number;
  tmdbId: number;
  requestId: number;
  title: string;
  /** Days from today; undefined when not announced. */
  digital?: number;
  theatrical: number;
  requestedDaysAgo: number;
  radarrId: number;
  monitored: boolean;
  hasFile: boolean;
  /** Download progress in percent, when queued. */
  queued?: number;
  grabbedDaysAgo?: number;
}

const initial = (): FakeMovie[] => [
  {
    tmdbId: 9001,
    requestId: 1,
    title: "The Long Road",
    digital: 10,
    theatrical: -30,
    requestedDaysAgo: 20,
    radarrId: 101,
    monitored: true,
    hasFile: false,
  },
  {
    tmdbId: 9002,
    requestId: 2,
    title: "Quiet Harbor",
    theatrical: -20,
    requestedDaysAgo: 12,
    radarrId: 102,
    monitored: true,
    hasFile: false,
  },
  {
    tmdbId: 9003,
    requestId: 3,
    title: "Night Signal",
    digital: -5,
    theatrical: -60,
    requestedDaysAgo: 40,
    radarrId: 103,
    monitored: true,
    hasFile: false,
  },
  {
    tmdbId: 9004,
    requestId: 4,
    title: "Paper Moons",
    digital: -2,
    theatrical: -50,
    requestedDaysAgo: 30,
    radarrId: 104,
    monitored: true,
    hasFile: false,
    queued: 40,
    grabbedDaysAgo: 0,
  },
  {
    tmdbId: 9005,
    requestId: 5,
    title: "Ember Lake",
    digital: -20,
    theatrical: -80,
    requestedDaysAgo: 90,
    radarrId: 105,
    monitored: true,
    hasFile: true,
  },
  {
    tmdbId: 9006,
    requestId: 6,
    title: "Static Bloom",
    digital: 0,
    theatrical: -45,
    requestedDaysAgo: 25,
    radarrId: 106,
    monitored: true,
    hasFile: false,
  },
];

/** Where Radarr keeps a movie: its own root folder once changed, else the default. */
const rootOf = (m: { tmdbId: number; root?: string }) =>
  m.root ?? (m.tmdbId === 9001 ? "/movies-4k" : "/movies");

/** Movies the owner requested himself. */
const OWNERS = new Set([9003, 9004, 9005]);

const day = (offset: number) => {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  local.setUTCDate(local.getUTCDate() + offset);
  return `${local.toISOString().slice(0, 10)}T00:00:00.000Z`;
};
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/**
 * Seerr's Discover, Issues and People for the native panel: two titles nobody requested yet (a
 * film and a three-season show), two issues on requested movies, and two users. Requests made here
 * are kept so a second one for the same title is refused, like Seerr.
 */
interface Discover {
  next: number;
  /** tmdbId -> media status (2 requested ... 5 available) and requested seasons. */
  media: Map<number, { status: number; seasons: number[] }>;
  made: Map<number, { tmdbId: number; type: string; seasons: number[] }>;
  issues: {
    id: number;
    status: number;
    issueType: number;
    tmdbId: number;
    by: string;
    comments: { id: number; message: string; by: string }[];
  }[];
}
const DISCOVER_FILM = { id: 9101, title: "Harbor Lights", releaseDate: "2019-05-01" };
const DISCOVER_SHOW = { id: 9102, name: "Signal Hill", firstAirDate: "2018-09-10" };
const initialDiscover = (): Discover => ({
  next: 100,
  media: new Map(),
  made: new Map(),
  issues: [
    {
      id: 1,
      status: 1,
      issueType: 3,
      tmdbId: 9005,
      by: "Alex",
      comments: [{ id: 1, message: "Subtitles drift after twenty minutes.", by: "Alex" }],
    },
    {
      id: 2,
      status: 2,
      issueType: 2,
      tmdbId: 9004,
      by: "Alex",
      comments: [{ id: 2, message: "No sound in the second half.", by: "Alex" }],
    },
  ],
});

export interface FakeMedia {
  fetch: Fetch;
  control(c: {
    reset?: boolean;
    moveDigital?: { tmdbId: number; days: number };
    arrive?: number;
    /** Puts a request back to waiting for approval (by TMDB id). */
    pending?: number;
    /** Radarr stops monitoring a requested movie (by TMDB id). */
    unmonitor?: number;
    /** Seerr forgets a requested movie (as after its request was removed early): not requested. */
    forget?: number;
    /** Seerr has a Discover title in the library, or not again (by TMDB id). */
    have?: { tmdbId: number; on: boolean };
  }): void;
  movies(): { tmdbId: number; title: string; hasFile: boolean }[];
}

/** The stand-in show request (Seerr) and its series (Sonarr's TVDB id). */
export const SHOW_REQUEST = 50;
const SHOW_TMDB = 9101;
export const SHOW_TVDB = 371980;
const showRequest = () => ({
  id: SHOW_REQUEST,
  status: 2,
  type: "tv",
  createdAt: ago(3),
  requestedBy: { id: 2, displayName: "Alex" },
  media: { tmdbId: SHOW_TMDB, tvdbId: SHOW_TVDB, status: 4 },
  seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }],
});

export function fakeMedia(): FakeMedia {
  let movies = initial();
  /** Seerr's "Enable Automatic Search" for its Radarr is on (preventSearch false) to start. */
  const freshDvr = () => ({
    radarr: { preventSearch: false, profile: { id: 4, name: "HD-1080p" } },
    sonarr: { preventSearch: false, profile: { id: 4, name: "HD-1080p" } },
  });
  let dvrState = freshDvr();
  /** Requests deleted in Seerr (Stop tracking); the movies stay in Radarr. */
  const removed = new Set<number>();
  // Seerr's own word for a movie: "processing" (3) until its scan catches up; like Seerr, removing
  // the last request before then resets it to not requested (1); Mark as Available makes it 5.
  const seerrStatus = new Map<number, number>();
  const statusOf = (m: FakeMovie) =>
    seerrStatus.get(m.tmdbId) ?? (removed.has(m.requestId) ? 1 : 3);
  let disc = initialDiscover();
  const reply = (status: number, data: unknown) => ({
    ok: status < 400,
    status,
    json: async () => data,
  });
  const request = (m: FakeMovie) => ({
    id: m.requestId,
    status: m.status ?? 2,
    type: "movie",
    createdAt: ago(m.requestedDaysAgo),
    // The owner (Seerr user 1, whom Hearth's key belongs to) asked for some; Alex for the rest.
    requestedBy: OWNERS.has(m.tmdbId)
      ? { id: 1, displayName: "Alex" }
      : { id: 2, displayName: "Alex" },
    // Seerr catches up with the library on its own schedule: "processing" until then.
    media: { id: 500 + m.tmdbId, tmdbId: m.tmdbId, status: statusOf(m) },
  });
  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname;
    if (u.port === "5055") {
      if (p === "/api/v1/status") return reply(200, { version: "2.7.3" });
      if (p === "/api/v1/auth/me") return reply(200, { id: 1, displayName: "Alex" });
      if (p === "/api/v1/settings/public") return reply(200, { discoverRegion: "US" });
      // Discover, Issues and People (the native panel's tabs).
      const method = init.method ?? "GET";
      const body = () => JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      const titleOf = (tmdbId: number) =>
        tmdbId === DISCOVER_FILM.id
          ? DISCOVER_FILM.title
          : tmdbId === DISCOVER_SHOW.id
            ? DISCOVER_SHOW.name
            : (movies.find((m) => m.tmdbId === tmdbId)?.title ?? `TMDB ${tmdbId}`);
      const catalog = () => [
        {
          id: DISCOVER_FILM.id,
          mediaType: "movie",
          title: DISCOVER_FILM.title,
          releaseDate: DISCOVER_FILM.releaseDate,
          overview: "A lighthouse keeper's last winter on the coast.",
          posterPath: `/poster${DISCOVER_FILM.id}.jpg`,
          backdropPath: `/backdrop${DISCOVER_FILM.id}.jpg`,
          mediaInfo: disc.media.has(DISCOVER_FILM.id)
            ? { status: disc.media.get(DISCOVER_FILM.id)!.status }
            : undefined,
        },
        {
          id: DISCOVER_SHOW.id,
          mediaType: "tv",
          name: DISCOVER_SHOW.name,
          firstAirDate: DISCOVER_SHOW.firstAirDate,
          overview: "A small-town radio station and the people who keep it on air.",
          posterPath: `/poster${DISCOVER_SHOW.id}.jpg`,
          mediaInfo: disc.media.has(DISCOVER_SHOW.id)
            ? { status: disc.media.get(DISCOVER_SHOW.id)!.status }
            : undefined,
        },
        ...movies.map((m) => ({
          id: m.tmdbId,
          mediaType: "movie",
          title: m.title,
          releaseDate: day(m.theatrical).slice(0, 10),
          overview: "",
          posterPath: `/poster${m.tmdbId}.jpg`,
          mediaInfo: { status: seerrStatus.get(m.tmdbId) ?? (m.hasFile ? 5 : 3) },
        })),
        { id: 1, mediaType: "person", name: "Not a title" },
      ];
      // Discover's rows (trending movies or shows, and the movie list by release date).
      if (
        p === "/api/v1/discover/trending" ||
        p === "/api/v1/discover/movies" ||
        p === "/api/v1/discover/movies/upcoming"
      ) {
        const list = p !== "/api/v1/discover/trending";
        const type = list ? "movie" : u.searchParams.get("mediaType");
        const results = catalog()
          .filter((x) => x.mediaType === type)
          .map((x) => (list ? { ...x, mediaType: undefined } : x));
        return reply(200, { page: 1, totalPages: 1, totalResults: results.length, results });
      }
      // Rotten Tomatoes and IMDb for the Discover film, as Seerr gathers them.
      if (p === `/api/v1/movie/${DISCOVER_FILM.id}/ratingscombined`)
        return reply(200, {
          rt: {
            criticsScore: 91,
            audienceScore: 84,
            url: "https://www.rottentomatoes.com/m/harbor_lights",
          },
          imdb: { criticsScore: 7.6, url: "https://www.imdb.com/title/tt9101000" },
        });
      // Seerr's "recommended" and "similar" lists for any film (Curator For You's Not in your
      // library): two films the sample Plex doesn't have, one already requested.
      if (/^\/api\/v1\/movie\/\d+\/(recommendations|similar)$/.test(p)) {
        const films = [
          { id: 9201, title: "Lantern Coast", releaseDate: "2022-03-01", genreIds: [18, 9648] },
          { id: 9202, title: "Tidewater", releaseDate: "2020-08-14", genreIds: [18] },
        ].map((x) => ({
          ...x,
          posterPath: `/poster${x.id}.jpg`,
          mediaInfo: { status: x.id === 9202 ? 2 : (disc.media.get(x.id)?.status ?? 1) },
        }));
        return reply(200, {
          page: 1,
          totalPages: 1,
          results: p.endsWith("similar") ? films.slice(1) : films,
        });
      }
      if (p === "/api/v1/search") {
        const q = (u.searchParams.get("query") ?? "").toLowerCase();
        const all = catalog();
        const results = all.filter((x) =>
          String((x as { title?: string }).title ?? (x as { name?: string }).name ?? "")
            .toLowerCase()
            .includes(q),
        );
        return reply(200, { page: 1, totalPages: 1, totalResults: results.length, results });
      }
      // The two Not-in-your-library films have their own pages too, so a request can find them.
      const nearby = /^\/api\/v1\/movie\/(9201|9202)$/.exec(p);
      if (nearby) {
        const id = Number(nearby[1]);
        const m = disc.media.get(id);
        return reply(200, {
          id,
          title: id === 9201 ? "Lantern Coast" : "Tidewater",
          releaseDate: id === 9201 ? "2022-03-01" : "2020-08-14",
          posterPath: `/poster${id}.jpg`,
          mediaInfo:
            id === 9202
              ? { id: 9202, status: 2, requests: [{ id: 0, status: 2 }] }
              : m
                ? { id: 503, status: m.status, requests: [{ id: 0, status: 2 }] }
                : undefined,
        });
      }
      if (p === `/api/v1/movie/${DISCOVER_FILM.id}`) {
        const m = disc.media.get(DISCOVER_FILM.id);
        return reply(200, {
          ...DISCOVER_FILM,
          posterPath: `/poster${DISCOVER_FILM.id}.jpg`,
          backdropPath: `/backdrop${DISCOVER_FILM.id}.jpg`,
          overview: "A lighthouse keeper's last winter on the coast.",
          tagline: "The light stays on.",
          runtime: 112,
          voteAverage: 7.4,
          genres: [{ name: "Drama" }],
          externalIds: { imdbId: "tt9101000" },
          releases: {
            results: [{ iso_3166_1: "US", release_dates: [{ certification: "PG-13" }] }],
          },
          credits: {
            cast: [
              { name: "Mara Quill", character: "Edda", profilePath: "/face1.jpg", order: 0 },
              { name: "Tobin Reyes", character: "Jonas", profilePath: "/face2.jpg", order: 1 },
            ],
            crew: [{ name: "Ines Varga", job: "Director" }],
          },
          relatedVideos: [
            { site: "YouTube", type: "Featurette", key: "harborfeat1" },
            { site: "YouTube", type: "Trailer", key: "harborTrl01", name: "Official Trailer" },
          ],
          mediaInfo: m
            ? { id: 501, status: m.status, requests: [{ id: 0, status: 2 }] }
            : undefined,
        });
      }
      if (p === `/api/v1/tv/${DISCOVER_SHOW.id}`) {
        const m = disc.media.get(DISCOVER_SHOW.id);
        return reply(200, {
          ...DISCOVER_SHOW,
          posterPath: `/poster${DISCOVER_SHOW.id}.jpg`,
          seasons: [0, 1, 2, 3].map((n) => ({
            seasonNumber: n,
            name: n ? `Season ${n}` : "Specials",
            episodeCount: 8,
          })),
          mediaInfo: m
            ? {
                id: 502,
                status: m.status,
                seasons: m.seasons.map((n) => ({ seasonNumber: n, status: 3 })),
                requests: [
                  { id: 0, status: 2, seasons: m.seasons.map((n) => ({ seasonNumber: n })) },
                ],
              }
            : undefined,
        });
      }
      // Seerr's own Radarr and Sonarr settings (admin): "Enable Automatic Search" is !preventSearch.
      const dvr = /^\/api\/v1\/settings\/(radarr|sonarr)(?:\/(\d+))?$/.exec(p);
      if (dvr) {
        const st = dvrState[dvr[1] as "radarr" | "sonarr"];
        const name = dvr[1] === "radarr" ? "Radarr" : "Sonarr";
        if (!dvr[2] && (init?.method ?? "GET") === "GET")
          return reply(200, [
            {
              id: 0,
              name,
              is4k: false,
              isDefault: true,
              preventSearch: st.preventSearch,
              activeProfileId: st.profile.id,
              activeProfileName: st.profile.name,
            },
          ]);
        if (dvr[2] && init?.method === "PUT") {
          const b = JSON.parse(String(init.body ?? "{}")) as {
            preventSearch?: boolean;
            activeProfileId?: number;
            activeProfileName?: string;
          };
          st.preventSearch = Boolean(b.preventSearch);
          if (b.activeProfileId !== undefined)
            st.profile = { id: b.activeProfileId, name: b.activeProfileName ?? "" };
          return reply(200, { id: Number(dvr[2]), name, preventSearch: st.preventSearch });
        }
      }
      // Where requests go: one Radarr and one Sonarr, two root folders each, two profiles.
      const svc = /^\/api\/v1\/service\/(radarr|sonarr)(?:\/(\d+))?$/.exec(p);
      if (svc) {
        const tv = svc[1] === "sonarr";
        const base = tv ? "/tv" : "/movies";
        const server = {
          id: 0,
          name: tv ? "Sonarr" : "Radarr",
          is4k: false,
          isDefault: true,
          activeDirectory: base,
          activeProfileId: 4,
        };
        if (!svc[2]) return reply(200, [server]);
        return reply(200, {
          server,
          rootFolders: [
            { id: 1, path: base, freeSpace: 2_400_000_000_000 },
            { id: 2, path: `${base}-archive`, freeSpace: 850_000_000_000 },
          ],
          profiles: [
            { id: 4, name: "HD-1080p" },
            { id: 5, name: "Ultra-HD" },
            // What the Crucible made in Radarr (Seerr lists Radarr's profiles as they are).
            ...(tv
              ? [
                  { id: 31, name: "Hearth · Waiting for the Crucible" },
                  { id: 32, name: "Hearth · All shows" },
                ]
              : [
                  { id: 21, name: "Hearth · Waiting for the Crucible" },
                  { id: 22, name: "Hearth · Classics (30+ years)" },
                  { id: 23, name: "Hearth · Newer movies" },
                ]),
          ],
        });
      }
      if (p === "/api/v1/request" && method === "POST") {
        const b = body();
        const tmdbId = Number(b.mediaId);
        const type = String(b.mediaType);
        const seasons = Array.isArray(b.seasons) ? (b.seasons as number[]) : [];
        const had = disc.media.get(tmdbId);
        if (type === "movie" && had)
          return reply(409, { message: "Request for this media already exists." });
        if (type === "tv" && had && seasons.some((n) => had.seasons.includes(n)))
          return reply(409, { message: "Request for this media already exists." });
        const id = disc.next++;
        disc.made.set(id, { tmdbId, type, seasons });
        disc.media.set(tmdbId, { status: 3, seasons: [...(had?.seasons ?? []), ...seasons] });
        return reply(201, { id, status: 2, type, media: { tmdbId } });
      }
      const madeOne = /^\/api\/v1\/request\/(\d+)$/.exec(p);
      if (madeOne && disc.made.has(Number(madeOne[1]))) {
        const r = disc.made.get(Number(madeOne[1]))!;
        return reply(200, {
          id: Number(madeOne[1]),
          status: 2,
          type: r.type,
          media: { tmdbId: r.tmdbId },
        });
      }
      if (p === "/api/v1/issue" && method === "GET") {
        const filter = u.searchParams.get("filter") ?? "open";
        const list = disc.issues.filter((i) =>
          filter === "all" ? true : filter === "resolved" ? i.status === 2 : i.status === 1,
        );
        return reply(200, {
          pageInfo: { pages: 1, results: list.length },
          results: list.map((i) => ({
            id: i.id,
            status: i.status,
            issueType: i.issueType,
            createdBy: { displayName: i.by },
            comments: i.comments.map((c) => ({ id: c.id })),
            media: { tmdbId: i.tmdbId, mediaType: "movie" },
          })),
        });
      }
      const issue = /^\/api\/v1\/issue\/(\d+)(?:\/(comment|resolved|open))?$/.exec(p);
      if (issue) {
        const i = disc.issues.find((x) => x.id === Number(issue[1]));
        // Like Seerr 3.5: a missing issue is a 500 "Issue not found."
        if (!i) return reply(500, { message: "Issue not found." });
        if (issue[2] === "comment" && method === "POST") {
          i.comments.push({
            id: 100 + i.comments.length,
            message: String(body().message ?? ""),
            by: "Alex",
          });
        } else if (issue[2] && method === "POST") {
          i.status = issue[2] === "resolved" ? 2 : 1;
        } else if (method === "DELETE") {
          disc.issues = disc.issues.filter((x) => x !== i);
          return reply(204, {});
        }
        return reply(200, {
          id: i.id,
          status: i.status,
          issueType: i.issueType,
          createdBy: { displayName: i.by },
          comments: i.comments.map((c) => ({
            id: c.id,
            message: c.message,
            user: { displayName: c.by },
          })),
          media: { tmdbId: i.tmdbId, mediaType: "movie", title: titleOf(i.tmdbId) },
        });
      }
      if (p === "/api/v1/user")
        return reply(200, {
          pageInfo: { pages: 1, results: 2 },
          results: [
            { id: 1, displayName: "Alex", userType: 1, permissions: 2, requestCount: 3 },
            {
              id: 2,
              displayName: "Alex",
              userType: 1,
              permissions: 32,
              requestCount: 4,
              movieQuotaLimit: 5,
              movieQuotaDays: 7,
            },
          ],
        });

      if (p === "/api/v1/request/count")
        return reply(200, {
          pending: 0,
          processing: movies.filter((m) => !m.hasFile).length,
          available: 1,
        });
      if (p === "/api/v1/issue/count") return reply(200, { open: 0 });
      if (p === "/api/v1/request") {
        // Like Overseerr 1.35: a parameter it does not know is refused, not ignored.
        const known = new Set(["take", "skip", "filter", "sort", "requestedBy"]);
        const unknown = [...u.searchParams.keys()].find((k) => !known.has(k));
        if (unknown) return reply(400, { message: `Unknown query parameter '${unknown}'` });
        const take = Number(u.searchParams.get("take") ?? 10);
        const skip = Number(u.searchParams.get("skip") ?? 0);
        // One show request too (Alex asked for two seasons of Ghosts), matched to the stand-in
        // Sonarr (8989) by its TVDB id.
        const listed = [
          ...movies.filter((m) => !removed.has(m.requestId)).map(request),
          ...(removed.has(SHOW_REQUEST) ? [] : [showRequest()]),
        ];
        const results = listed.slice(skip, skip + take);
        return reply(200, {
          pageInfo: { pages: Math.ceil(listed.length / take), results: listed.length },
          results,
        });
      }
      const decide = /^\/api\/v1\/request\/(\d+)\/(approve|decline)$/.exec(p);
      if (decide && init.method === "POST") {
        const m = movies.find((x) => x.requestId === Number(decide[1]));
        if (!m) return reply(404, {});
        m.status = decide[2] === "approve" ? 2 : 3;
        return reply(200, request(m));
      }
      if (p === `/api/v1/tv/${SHOW_TMDB}`)
        return reply(200, {
          name: "Ghosts (US)",
          firstAirDate: "2021-10-07",
          posterPath: `/poster${SHOW_TMDB}.jpg`,
          backdropPath: `/backdrop${SHOW_TMDB}.jpg`,
          genres: [{ name: "Comedy" }, { name: "Fantasy" }],
          networks: [{ name: "CBS" }],
          status: "Returning Series",
          externalIds: { tvdbId: SHOW_TVDB },
        });
      if (p === `/api/v1/request/${SHOW_REQUEST}`) {
        if (removed.has(SHOW_REQUEST)) return reply(404, {});
        if (init.method === "DELETE") {
          removed.add(SHOW_REQUEST);
          return reply(204, {});
        }
        return reply(200, showRequest());
      }
      const one = /^\/api\/v1\/request\/(\d+)$/.exec(p);
      if (one) {
        const id = Number(one[1]);
        const m = removed.has(id) ? undefined : movies.find((x) => x.requestId === id);
        if (!m) return reply(404, {});
        // Like Seerr: deleting a request takes it off the list; the movie stays in Radarr.
        if (init.method === "DELETE") {
          removed.add(id);
          return reply(204, {});
        }
        return reply(200, request(m));
      }
      const available = /^\/api\/v1\/media\/(\d+)\/available$/.exec(p);
      if (available && init.method === "POST") {
        const m = movies.find((x) => 500 + x.tmdbId === Number(available[1]));
        if (!m) return reply(404, { message: "Media does not exist." });
        seerrStatus.set(m.tmdbId, 5);
        return reply(200, { id: 500 + m.tmdbId, status: 5 });
      }
      const movie = /^\/api\/v1\/movie\/(\d+)$/.exec(p);
      if (movie) {
        const m = movies.find((x) => x.tmdbId === Number(movie[1]));
        if (!m) return reply(404, {});
        return reply(200, {
          title: m.title,
          posterPath: `/poster${m.tmdbId}.jpg`,
          releaseDate: day(m.theatrical),
          mediaInfo: { id: 500 + m.tmdbId, status: statusOf(m) },
          releases: {
            results: [
              {
                iso_3166_1: "US",
                release_dates: [
                  { type: 3, release_date: day(m.theatrical) },
                  ...(m.digital !== undefined ? [{ type: 4, release_date: day(m.digital) }] : []),
                ],
              },
            ],
          },
        });
      }
      return reply(404, {});
    }
    if (u.port === "7878") {
      if (p === "/api/v3/qualityprofile")
        return reply(200, [
          {
            id: 1,
            name: "HD-1080p",
            cutoff: 7,
            items: [{ quality: { id: 7, name: "Bluray-1080p" } }],
          },
          {
            id: 2,
            name: "Ultra-HD",
            cutoff: 19,
            items: [{ quality: { id: 19, name: "Bluray-2160p" } }],
          },
        ]);
      // A search Radarr was asked to run (MoviesSearch): finished at once, nothing grabbed.
      if (p === "/api/v3/command" && init.method === "POST") {
        const b = JSON.parse(init.body ?? "{}") as { name?: string; movieIds?: number[] };
        for (const m of movies)
          if (b.movieIds?.includes(m.radarrId)) m.searches = (m.searches ?? 0) + 1;
        return reply(201, { id: 77, name: b.name, status: "queued" });
      }
      if (/^\/api\/v3\/command\/\d+$/.test(p))
        return reply(200, { id: 77, status: "completed", message: "Completed" });
      if (p === "/api/v3/rootfolder")
        return reply(200, [
          { id: 1, path: "/movies", accessible: true },
          { id: 2, path: "/movies-4k", accessible: true },
          { id: 3, path: "/new releases", accessible: true },
        ]);
      const byId = /^\/api\/v3\/movie\/(\d+)$/.exec(p);
      if (byId && (init.method ?? "GET") === "GET") {
        const m = movies.find((x) => x.radarrId === Number(byId[1]));
        if (!m) return reply(404, {});
        return reply(200, {
          id: m.radarrId,
          title: m.title,
          year: 2026,
          hasFile: m.hasFile,
          monitored: m.monitored,
          rootFolderPath: rootOf(m),
          path: `${rootOf(m)}/${m.title} (2026)`,
          qualityProfileId: profileOf(m),
          ...(m.hasFile ? { movieFile: { quality: { quality: { name: "WEBDL-720p" } } } } : {}),
        });
      }
      // Saving one movie (Radarr takes the whole movie back): only monitoring is kept here.
      if (byId && init.method === "PUT") {
        const m = movies.find((x) => x.radarrId === Number(byId[1]));
        if (!m) return reply(404, {});
        const b = JSON.parse(init.body ?? "{}") as {
          monitored?: boolean;
          qualityProfileId?: number;
        };
        if (typeof b.monitored === "boolean") m.monitored = b.monitored;
        if (typeof b.qualityProfileId === "number") m.profile = b.qualityProfileId;
        return reply(202, { id: m.radarrId, title: m.title, monitored: m.monitored });
      }
      // Radarr's movie editor: a new root folder for the movies named.
      if (p === "/api/v3/movie/editor" && init.method === "PUT") {
        const b = JSON.parse(init.body ?? "{}") as { movieIds?: number[]; rootFolderPath?: string };
        for (const m of movies) if (b.movieIds?.includes(m.radarrId)) m.root = b.rootFolderPath;
        return reply(202, {});
      }
      if (p === "/api/v3/movie") {
        const tmdbId = Number(u.searchParams.get("tmdbId"));
        // Without tmdbId: every movie (the Seerr dashboard reads them all at once).
        const list = u.searchParams.has("tmdbId")
          ? movies.filter((x) => x.tmdbId === tmdbId)
          : movies;
        return reply(
          200,
          list.map((m) => ({
            id: m.radarrId,
            tmdbId: m.tmdbId,
            title: m.title,
            titleSlug: m.title.toLowerCase().replace(/\W+/g, "-"),
            monitored: m.monitored,
            hasFile: m.hasFile,
            inCinemas: day(m.theatrical),
            ...(m.digital !== undefined ? { digitalRelease: day(m.digital) } : {}),
            isAvailable: (m.digital ?? 1) <= 0,
            rootFolderPath: rootOf(m),
            path: `${rootOf(m)}/${m.title} (2026)`,
            qualityProfileId: profileOf(m),
          })),
        );
      }
      if (p === "/api/v3/queue") {
        // One movie's entry (movieIds), or the whole queue.
        const id = Number(u.searchParams.get("movieIds"));
        const list = u.searchParams.has("movieIds")
          ? movies.filter((x) => x.radarrId === id)
          : movies;
        return reply(200, {
          records: list
            .filter((m) => m.queued !== undefined && !m.hasFile)
            .map((m) => ({
              movieId: m.radarrId,
              status: "downloading",
              trackedDownloadStatus: "ok",
              trackedDownloadState: "downloading",
              size: 100,
              sizeleft: 100 - m.queued!,
            })),
        });
      }
      if (p === "/api/v3/history/movie") {
        const id = Number(u.searchParams.get("movieId"));
        const m = movies.find((x) => x.radarrId === id);
        return reply(
          200,
          m?.grabbedDaysAgo !== undefined
            ? [{ eventType: "grabbed", date: ago(m.grabbedDaysAgo), movieId: m.radarrId }]
            : [],
        );
      }
      return reply(404, {});
    }
    return reply(404, {});
  };
  return {
    fetch: fetchImpl,
    control(c) {
      if (c.reset) {
        movies = initial();
        removed.clear();
        seerrStatus.clear();
        disc = initialDiscover();
        dvrState = freshDvr();
      }
      if (c.moveDigital) {
        const m = movies.find((x) => x.tmdbId === c.moveDigital!.tmdbId);
        if (m) m.digital = c.moveDigital.days;
      }
      if (c.pending !== undefined) {
        const m = movies.find((x) => x.tmdbId === c.pending);
        if (m) m.status = 1;
      }
      if (c.forget !== undefined) seerrStatus.set(c.forget, 1);
      if (c.have?.on) disc.media.set(c.have.tmdbId, { status: 5, seasons: [] });
      else if (c.have) disc.media.delete(c.have.tmdbId);
      if (c.unmonitor !== undefined) {
        const m = movies.find((x) => x.tmdbId === c.unmonitor);
        if (m) m.monitored = false;
      }
      if (c.arrive !== undefined) {
        const m = movies.find((x) => x.tmdbId === c.arrive);
        if (m) {
          m.hasFile = true;
          m.queued = undefined;
        }
      }
    },
    movies: () =>
      movies.map((m) => ({
        tmdbId: m.tmdbId,
        title: m.title,
        hasFile: m.hasFile,
        profile: profileOf(m),
        monitored: m.monitored,
        searches: m.searches ?? 0,
      })),
  };
}
/** Radarr's quality profile for a stand-in movie (one starts on Ultra-HD). */
const profileOf = (m: FakeMovie) => m.profile ?? (m.tmdbId === 9001 ? 2 : 1);
