import { describe, expect, it } from "vitest";
import { assessMovie, movieEvents, viewOf, type MovieAssessment, type MovieFacts } from "./watches";

const today = "2026-12-05";
const now = new Date("2026-12-05T15:00:00Z");

const radarr = (over: Partial<Extract<MovieFacts["radarr"], { found: true }>> = {}) =>
  ({
    found: true,
    serviceId: "radarr",
    movieId: 7,
    monitored: true,
    hasFile: false,
    ...over,
  }) as MovieFacts["radarr"];

const facts = (over: Partial<MovieFacts> = {}): MovieFacts => ({
  tmdbId: 1,
  title: "Sinners",
  year: 2026,
  request: {
    seerrServiceId: "seerr",
    requestId: 3,
    requestedAt: "2026-10-01T10:00:00Z",
    status: 2,
    mediaStatus: 3,
  },
  dates: { region: "US", digital: "2026-12-19", digitalSource: "tmdb", theatrical: "2026-10-10" },
  radarr: radarr(),
  ...over,
});

describe("movie watch: state from the facts", () => {
  it("is coming while the digital date is ahead, checked daily until close, then more often", () => {
    const a = assessMovie(facts(), now, today);
    expect(a).toMatchObject({
      state: "upcoming",
      homeDate: "2026-12-19",
      homeKind: "digital",
      dateSource: "tmdb",
      dateStatus: "announced",
      theatrical: "2026-10-10",
      nextCheckMinutes: 24 * 60,
    });
    const close = assessMovie(
      facts({ dates: { region: "US", digital: "2026-12-07", digitalSource: "tmdb" } }),
      now,
      today,
    );
    expect(close.nextCheckMinutes).toBe(6 * 60);
  });

  it("never treats a theatrical date as digital: with no home date it is not announced yet", () => {
    const a = assessMovie(facts({ dates: { region: "US", theatrical: "2026-10-10" } }), now, today);
    expect(a).toMatchObject({ state: "unannounced", dateStatus: "not-announced" });
    expect(a.homeDate).toBeUndefined();
    expect(a.problem).toBeUndefined();
  });

  it("uses the physical date when there is no digital one", () => {
    const a = assessMovie(
      facts({ dates: { region: "US", physical: "2026-12-20", physicalSource: "radarr" } }),
      now,
      today,
    );
    expect(a).toMatchObject({ homeKind: "physical", dateSource: "radarr", state: "upcoming" });
  });

  it("on the day itself it is out today, and looking for an hour at a time", () => {
    const a = assessMovie(facts({ dates: { region: "US", digital: today } }), now, today);
    expect(a).toMatchObject({ state: "out-today", dateStatus: "out", nextCheckMinutes: 60 });
  });

  it("is in the library when Radarr has the file or Seerr shows it available", () => {
    expect(assessMovie(facts({ radarr: radarr({ hasFile: true }) }), now, today).state).toBe(
      "arrived",
    );
    const r = facts();
    r.request!.mediaStatus = 5;
    expect(assessMovie(r, now, today)).toMatchObject({ state: "arrived", nextCheckMinutes: null });
  });

  it("closes quietly when the request is declined, removed, or deleted", () => {
    expect(assessMovie(facts({ request: undefined }), now, today).state).toBe("gone");
    const declined = facts();
    declined.request!.status = 3;
    expect(assessMovie(declined, now, today).state).toBe("gone");
  });

  const out = (over: Partial<MovieFacts> = {}, at = now) =>
    assessMovie(
      facts({ dates: { region: "US", digital: "2026-12-01", digitalSource: "tmdb" }, ...over }),
      at,
      today,
    );

  it("after the date, says what is in the way: confirmed causes first", () => {
    expect(out({ radarr: { found: false, reason: "not-added" } }).problem).toMatchObject({
      code: "not-in-radarr",
      confirmed: true,
    });
    expect(out({ radarr: { found: false, reason: "no-radarr" } }).problem?.code).toBe("no-radarr");
    expect(out({ radarr: { found: false, reason: "no-key" } }).problem?.code).toBe("no-radarr-key");
    expect(out({ radarr: radarr({ monitored: false }) }).problem?.code).toBe("not-monitored");
    const stuck = out({
      radarr: radarr({ queue: { status: "warning", state: "importBlocked", message: "No files" } }),
    });
    expect(stuck.problem).toMatchObject({ code: "download-stuck", confirmed: true });
    expect(stuck.problem!.text).toContain("No files");
    expect(
      out({ radarr: radarr({ lastEvent: { type: "downloadFailed", at: "2026-12-02T08:00:00Z" } }) })
        .problem?.code,
    ).toBe("download-failed");
    const pending = facts({ dates: { region: "US", digital: "2026-12-01" } });
    pending.request!.status = 1;
    expect(assessMovie(pending, now, today).problem?.code).toBe("awaiting-approval");
  });

  it("downloading is not a problem", () => {
    expect(out({ radarr: radarr({ queue: { status: "ok", progress: 40 } }) })).toMatchObject({
      state: "downloading",
      nextCheckMinutes: 15,
    });
    expect(out({ radarr: radarr({ queue: { status: "ok", progress: 40 } }) }).doing).toContain(
      "40%",
    );
  });

  it("only suspects the quality profile after 48 hours with nothing grabbed", () => {
    const early = assessMovie(
      facts({ dates: { region: "US", digital: "2026-12-04" } }),
      now,
      today,
    );
    expect(early).toMatchObject({ state: "looking" });
    expect(early.problem).toBeUndefined();
    const late = out();
    expect(late.problem).toMatchObject({ code: "nothing-accepted", confirmed: false });
    expect(late.problem!.text).toContain("may not meet your quality profile");
  });

  it("counts the wait from the request when an older movie is asked for later", () => {
    const r = facts({ dates: { region: "US", digital: "2025-03-01" } });
    r.request!.requestedAt = "2026-12-05T09:00:00Z";
    expect(assessMovie(r, now, today).problem).toBeUndefined();
  });

  it("keeps the last state when Radarr does not answer, so an outage raises nothing", () => {
    const prev = out({ radarr: radarr({ monitored: false }) });
    const a = out({ radarr: { found: false, reason: "unreachable" } });
    expect(a.problem).toBeUndefined();
    const kept = assessMovie(
      facts({
        dates: { region: "US", digital: "2026-12-01" },
        radarr: { found: false, reason: "unreachable" },
      }),
      now,
      today,
      prev,
    );
    expect(kept).toMatchObject({ state: "needs-look", problem: { code: "not-monitored" } });
    expect(kept.nextCheckMinutes).toBe(30);
  });

  it("lists each watch in the right place", () => {
    expect(viewOf("upcoming", false)).toBe("upcoming");
    expect(viewOf("needs-look", false)).toBe("attention");
    expect(viewOf("arrived", false)).toBe("completed");
    expect(viewOf("needs-look", true)).toBe("dismissed");
  });
});

describe("movie watch: what is news", () => {
  const coming = (date?: string): MovieAssessment =>
    assessMovie(facts({ dates: { region: "US", ...(date ? { digital: date } : {}) } }), now, today);

  it("starts with a history line and nothing sent", () => {
    const e = movieEvents("Sinners", undefined, coming("2026-12-19"), today);
    expect(e).toEqual([expect.objectContaining({ type: "watching" })]);
    expect(e[0]!.notify).toBeUndefined();
    expect(e[0]!.text).toContain("expected on December 19");
  });

  it("says when a date is announced, and when it moves, once each", () => {
    const announced = movieEvents("Sinners", coming(), coming("2026-12-19"), today);
    expect(announced).toEqual([
      expect.objectContaining({ type: "date-set", notify: "dates", key: "date:2026-12-19" }),
    ]);
    const moved = movieEvents("Sinners", coming("2026-12-05"), coming("2026-12-19"), today);
    expect(moved[0]).toMatchObject({ type: "date-moved", notify: "dates" });
    expect(moved[0]!.text).toBe(
      "The expected digital release date for Sinners has moved from December 5 to December 19. Its release watch has been updated.",
    );
    expect(movieEvents("Sinners", coming("2026-12-19"), coming("2026-12-19"), today)).toEqual([]);
    // Moving back is news again (each move has its own key).
    const back = movieEvents("Sinners", coming("2026-12-19"), coming("2026-12-05"), today);
    expect(back[0]).toMatchObject({ type: "date-moved", key: "date:2026-12-19>2026-12-05" });
    expect(back[0]!.key).not.toBe(moved[0]!.key);
    expect(back[0]!.title).toContain("moved earlier");
  });

  it("out today, a new problem, and arriving are news; the same problem again is not", () => {
    const day = assessMovie(facts({ dates: { region: "US", digital: today } }), now, today);
    expect(movieEvents("Sinners", coming("2026-12-19"), day, today).map((e) => e.type)).toEqual([
      "date-moved",
      "out-today",
    ]);
    const stuck = assessMovie(
      facts({
        dates: { region: "US", digital: "2026-12-01" },
        radarr: radarr({ monitored: false }),
      }),
      now,
      today,
    );
    const first = movieEvents("Sinners", day, stuck, today);
    expect(first.find((e) => e.type === "problem")).toMatchObject({ notify: "problems" });
    expect(movieEvents("Sinners", stuck, stuck, today)).toEqual([]);
    const arrived = assessMovie(facts({ radarr: radarr({ hasFile: true }) }), now, today);
    expect(movieEvents("Sinners", stuck, arrived, today)).toEqual([
      expect.objectContaining({
        type: "arrived",
        notify: "arrived",
        text: "Sinners, which you requested, has been downloaded and is now in your library.",
      }),
    ]);
  });

  it("a quiet first look keeps the history and sends nothing", () => {
    const stuck = assessMovie(
      facts({ dates: { region: "US", digital: "2026-11-01" } }),
      now,
      today,
    );
    const e = movieEvents("Sinners", undefined, stuck, today, { quiet: true });
    expect(e.map((x) => x.type)).toEqual(["watching", "problem"]);
    expect(e.every((x) => x.notify === undefined)).toBe(true);
  });
});
