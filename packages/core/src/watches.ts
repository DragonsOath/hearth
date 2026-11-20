/**
 * Watches: things Hearth follows over days or weeks on its own, checking each one when it
 * is due (docs/design/RELEASE_WATCH.md). The first kind is a movie requested in Seerr, followed
 * until it is in the library. The rules here are pure: the server gathers the facts, these decide
 * the state, what is wrong, when to look again, and what is new enough to tell the owner.
 */

export type WatchKind = "movie-release";

/** Where a watch is listed on the page. */
export type WatchView = "upcoming" | "attention" | "completed" | "dismissed";

/** The kinds of news a movie watch can send; each can be switched off. */
export type ReleaseNotifyKind = "dates" | "out-today" | "problems" | "arrived";

export const RELEASE_NOTIFY_KINDS: { id: ReleaseNotifyKind; label: string; detail: string }[] = [
  { id: "dates", label: "Release dates", detail: "When a date is announced, or moves." },
  { id: "out-today", label: "Out today", detail: "On the day a movie comes out." },
  {
    id: "problems",
    label: "Needs a look",
    detail: "When a movie is late, stuck, or something is in its way.",
  },
  { id: "arrived", label: "In your library", detail: "When a movie arrives." },
];

export type MovieWatchState =
  | "unannounced"
  | "upcoming"
  | "out-today"
  | "looking"
  | "downloading"
  | "needs-look"
  | "arrived"
  | "gone";

export const MOVIE_STATE_LABEL: Record<MovieWatchState, string> = {
  unannounced: "Not announced yet",
  upcoming: "Coming",
  "out-today": "Out today",
  looking: "Looking for it",
  downloading: "Downloading",
  "needs-look": "Needs a look",
  arrived: "In your library",
  gone: "Request gone",
};

/** Seerr's request status: 1 pending, 2 approved, 3 declined, 4 failed, 5 completed. */
export const SEERR_REQUEST = { pending: 1, approved: 2, declined: 3, failed: 4, completed: 5 };
/** Seerr's media status: 5 available, 6 blocklisted, 7 deleted. */
export const SEERR_MEDIA = { available: 5, blocklisted: 6, deleted: 7 };

/** What Hearth read about one requested movie, at one check. Never a secret. */
export interface MovieFacts {
  tmdbId: number;
  title: string;
  year?: number;
  /** The Seerr request; absent when it no longer exists. */
  request?: {
    seerrServiceId: string;
    requestId: number;
    requestedAt: string;
    requestedBy?: string;
    status: number;
    mediaStatus: number;
  };
  /** Release dates (YYYY-MM-DD) for the owner's country, and where each came from. */
  dates: {
    region: string;
    digital?: string;
    digitalSource?: "tmdb" | "radarr";
    physical?: string;
    physicalSource?: "tmdb" | "radarr";
    theatrical?: string;
  };
  radarr:
    | {
        found: false;
        /** No Radarr watched; no usable key; not added to Radarr; or no answer at this check. */
        reason: "no-radarr" | "no-key" | "not-added" | "unreachable";
        detail?: string;
      }
    | {
        found: true;
        serviceId: string;
        movieId: number;
        titleSlug?: string;
        monitored: boolean;
        hasFile: boolean;
        /** Its entry in Radarr's download queue, when there is one. */
        queue?: { state?: string; status?: string; message?: string; progress?: number };
        /** The latest thing in its history (grabbed, downloadFailed, ...). */
        lastEvent?: { type: string; at: string };
      };
}

export interface MovieProblem {
  code: string;
  text: string;
  /** Confirmed from what Radarr or Seerr says, or only suspected. */
  confirmed: boolean;
}

export interface MovieAssessment {
  state: MovieWatchState;
  /** The home release this watch waits for: digital, or physical when there is no digital date. */
  homeDate?: string;
  homeKind?: "digital" | "physical";
  dateSource?: "tmdb" | "radarr";
  dateStatus: "not-announced" | "announced" | "out";
  theatrical?: string;
  problem?: MovieProblem;
  /** What Radarr is doing, in a sentence. */
  doing: string;
  /** Minutes until the next check; null when the watch is finished. */
  nextCheckMinutes: number | null;
}

/** Hours after the home release before "nothing accepted yet" is worth a look. */
export const GRACE_HOURS = 48;

const DAY = 24 * 60;

/** "December 5", with the year when it is not this year. */
export function formatDay(date: string, today: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const sameYear = date.slice(0, 4) === today.slice(0, 4);
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

const daysBetween = (from: string, to: string) =>
  Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000,
  );

function doingText(f: MovieFacts): string {
  const r = f.radarr;
  if (!r.found)
    return {
      "no-radarr": "Hearth is not watching a Radarr.",
      "no-key": "Radarr's key is not in Secure Vault, so Hearth cannot look.",
      "not-added": "Not in Radarr yet.",
      unreachable: "Radarr did not answer at the last check.",
    }[r.reason];
  if (r.hasFile) return "Radarr has it.";
  if (r.queue) {
    const pct = r.queue.progress !== undefined ? ` (${Math.round(r.queue.progress)}%)` : "";
    if (r.queue.status === "error" || r.queue.status === "warning")
      return `Its download needs attention${pct}${r.queue.message ? `: ${r.queue.message}` : "."}`;
    return r.queue.state && /import/i.test(r.queue.state)
      ? "Radarr is importing it."
      : `Radarr is downloading it${pct}.`;
  }
  if (!r.monitored) return "In Radarr, but not monitored.";
  if (r.lastEvent?.type === "grabbed") return "Radarr grabbed a release; waiting for the download.";
  return "Radarr is monitoring it and has not grabbed a release yet.";
}

/**
 * The state of one movie watch from the facts. `today` is the owner's local date (YYYY-MM-DD);
 * `prev` is the last assessment, kept when Radarr does not answer, so a passing outage raises
 * nothing.
 */
export function assessMovie(
  f: MovieFacts,
  now: Date,
  today: string,
  prev?: MovieAssessment,
  graceHours = GRACE_HOURS,
): MovieAssessment {
  const homeDate = f.dates.digital ?? f.dates.physical;
  const homeKind: MovieAssessment["homeKind"] = f.dates.digital
    ? "digital"
    : f.dates.physical
      ? "physical"
      : undefined;
  const dateSource = f.dates.digital ? f.dates.digitalSource : f.dates.physicalSource;
  const dateStatus: MovieAssessment["dateStatus"] = !homeDate
    ? "not-announced"
    : homeDate > today
      ? "announced"
      : "out";
  const base = {
    ...(homeDate ? { homeDate, homeKind, dateSource } : {}),
    dateStatus,
    ...(f.dates.theatrical ? { theatrical: f.dates.theatrical } : {}),
    doing: doingText(f),
  };
  const req = f.request;
  const r = f.radarr;

  // Finished: in the library, or the request is gone (declined, deleted, or blocklisted).
  if ((r.found && r.hasFile) || req?.mediaStatus === SEERR_MEDIA.available)
    return { ...base, state: "arrived", nextCheckMinutes: null };
  if (
    !req ||
    req.status === SEERR_REQUEST.declined ||
    req.mediaStatus === SEERR_MEDIA.deleted ||
    req.mediaStatus === SEERR_MEDIA.blocklisted
  )
    return { ...base, state: "gone", nextCheckMinutes: null };

  const problem = (code: string, text: string, confirmed = true): MovieAssessment => ({
    ...base,
    state: "needs-look",
    problem: { code, text, confirmed },
    nextCheckMinutes: 6 * 60,
  });

  // Seerr could not hand the request to Radarr: worth saying whatever the date.
  if (req.status === SEERR_REQUEST.failed)
    return problem("request-failed", "Seerr could not send the request to Radarr.");

  if (dateStatus === "not-announced")
    return { ...base, state: "unannounced", nextCheckMinutes: DAY };
  if (dateStatus === "announced") {
    const days = daysBetween(today, homeDate!);
    return { ...base, state: "upcoming", nextCheckMinutes: days > 3 ? DAY : 6 * 60 };
  }

  // The home release is out: what is in the way, confirmed first, suspected last.
  if (r.found && r.queue) {
    if (
      r.queue.status === "error" ||
      r.queue.status === "warning" ||
      r.queue.state === "failed" ||
      r.queue.state === "importBlocked"
    )
      return problem(
        "download-stuck",
        `Its download is stuck${r.queue.message ? `: ${r.queue.message}` : "."}`,
      );
    return { ...base, state: "downloading", nextCheckMinutes: 15 };
  }
  if (req.status === SEERR_REQUEST.pending)
    return problem("awaiting-approval", "The request is still waiting for approval in Seerr.");
  if (!r.found) {
    if (r.reason === "unreachable")
      return {
        ...base,
        state: prev?.state && prev.state !== "out-today" ? prev.state : "looking",
        ...(prev?.problem ? { problem: prev.problem } : {}),
        nextCheckMinutes: 30,
      };
    if (r.reason === "no-radarr")
      return problem("no-radarr", "Hearth is not watching a Radarr, so it cannot check.");
    if (r.reason === "no-key")
      return problem("no-radarr-key", "Radarr's key is not in Secure Vault, so it cannot check.");
    return problem(
      "not-in-radarr",
      "Radarr does not have it. Seerr may not have sent it, or it was removed.",
    );
  }
  if (!r.monitored) return problem("not-monitored", "Radarr is not monitoring it.");
  if (r.lastEvent?.type === "downloadFailed" && r.lastEvent.at.slice(0, 10) >= homeDate!)
    return problem("download-failed", "Its download failed.");
  if (r.lastEvent?.type === "grabbed" && r.lastEvent.at.slice(0, 10) >= homeDate!)
    return { ...base, state: "downloading", nextCheckMinutes: 15 };
  // The wait counts from the release, or from the request when an older movie was asked for later
  // (Radarr searches when it is added).
  const since = Math.max(
    new Date(`${homeDate}T00:00:00Z`).getTime(),
    new Date(req.requestedAt).getTime() || 0,
  );
  if ((now.getTime() - since) / 3_600_000 >= graceHours)
    return problem(
      "nothing-accepted",
      "Radarr has not found a release it accepts yet. Releases on offer may not meet your quality profile, or none are out yet.",
      false,
    );
  return {
    ...base,
    state: homeDate === today ? "out-today" : "looking",
    nextCheckMinutes: 60,
  };
}

/** Where a watch is listed. */
export function viewOf(state: string, dismissed: boolean): WatchView {
  if (dismissed) return "dismissed";
  if (state === "arrived" || state === "gone") return "completed";
  if (state === "needs-look") return "attention";
  return "upcoming";
}

/** Something new about a watch: kept in its history, and sent once when `notify` is set. */
export interface WatchEventDraft {
  /** Stable, so the same news is never sent twice. */
  key: string;
  type: "date-set" | "date-moved" | "out-today" | "problem" | "arrived" | "gone" | "watching";
  notify?: ReleaseNotifyKind;
  title: string;
  text: string;
}

/**
 * What changed between two assessments of one movie, in the owner's words. `quiet` keeps it all
 * in the history without sending anything: used for requests found the first time watching
 * starts, so switching it on does not send a note for every old request at once.
 */
export function movieEvents(
  title: string,
  prev: MovieAssessment | undefined,
  next: MovieAssessment,
  today: string,
  opts: { quiet?: boolean } = {},
): WatchEventDraft[] {
  const out: WatchEventDraft[] = [];
  const what = next.homeKind === "physical" ? "home (disc)" : "digital";
  if (!prev)
    out.push({
      key: "watching",
      type: "watching",
      title: `Watching ${title}`,
      text: next.homeDate
        ? `Requested in Seerr. Its ${what} release ${next.dateStatus === "out" ? "came out on" : "is expected on"} ${formatDay(next.homeDate, today)}.`
        : "Requested in Seerr. No digital release date has been announced yet; Hearth checks daily.",
    });
  else if (next.homeDate && next.homeDate !== prev.homeDate && next.state !== "arrived") {
    if (!prev.homeDate)
      out.push({
        key: `date:${next.homeDate}`,
        type: "date-set",
        notify: "dates",
        title: `${title}: release date announced`,
        text: `The ${what} release of ${title} is expected on ${formatDay(next.homeDate, today)}. Hearth is watching it.`,
      });
    else
      out.push({
        // The move itself, so a date that moves back is told again.
        key: `date:${prev.homeDate}>${next.homeDate}`,
        type: "date-moved",
        notify: "dates",
        title: `${title}: release date ${next.homeDate > prev.homeDate ? "moved later" : "moved earlier"}`,
        text: `The expected ${what} release date for ${title} has moved from ${formatDay(prev.homeDate, today)} to ${formatDay(next.homeDate, today)}. Its release watch has been updated.`,
      });
  }
  if (next.state === "out-today" && next.homeDate)
    out.push({
      key: `out-today:${next.homeDate}`,
      type: "out-today",
      notify: "out-today",
      title: `${title} is out today`,
      text: `${title} is scheduled for ${what} release today. Hearth is watching for Radarr to get it.`,
    });
  if (next.problem && next.problem.code !== prev?.problem?.code)
    out.push({
      key: `problem:${next.problem.code}:${next.homeDate ?? ""}`,
      type: "problem",
      notify: "problems",
      title: `${title} needs a look`,
      text: `${next.homeDate && next.dateStatus === "out" ? `${title} reached its ${what} release date, ${formatDay(next.homeDate, today)}. ` : ""}${next.problem.text}${next.problem.code === "download-failed" || next.problem.code === "nothing-accepted" || next.problem.code === "download-stuck" ? " Ember can look into why." : ""}`,
    });
  if (next.state === "arrived" && prev && prev.state !== "arrived")
    out.push({
      key: "arrived",
      type: "arrived",
      notify: "arrived",
      title: `${title} is in your library`,
      text: `${title}, which you requested, has been downloaded and is now in your library.`,
    });
  if (next.state === "gone" && prev && prev.state !== "gone")
    out.push({
      key: "gone",
      type: "gone",
      title: `Stopped watching ${title}`,
      text: "Its request was declined or removed in Seerr.",
    });
  return opts.quiet ? out.map(({ notify: _notify, ...e }) => e) : out;
}

/** One watch, as the page and the AI see it. */
export interface Watch {
  id: string;
  kind: WatchKind;
  title: string;
  year?: number;
  state: MovieWatchState;
  stateLabel: string;
  view: WatchView;
  requestedAt?: string;
  requestedBy?: string;
  assessment: MovieAssessment;
  /** Links to the movie in Seerr and Radarr, when their addresses are known. */
  links: { seerr?: string; radarr?: string };
  lastCheckedAt?: string;
  nextCheckAt?: string;
  checkError?: string;
  snoozedUntil?: string;
  dismissedAt?: string;
  latest?: { at: string; title: string; text: string };
}

export interface WatchHistoryEntry {
  at: string;
  type: string;
  title: string;
  text: string;
  /** Sent to a channel, held by quiet hours or a snooze, switched off, or not news. */
  sent: "sent" | "held" | "off" | "none";
}

/** The owner's choices for movie watches. */
export interface ReleaseWatchSettings {
  enabled: boolean;
  /** Two-letter country for release dates; empty means Seerr's own region (else US). */
  region: string;
  notify: Record<ReleaseNotifyKind, boolean>;
  /**
   * Days after the digital release date before a movie with nothing grabbed counts as overdue
   * (0 = on the day). The date passing does not prove a release is on offer.
   */
  overdueAfterDays: number;
}

export const RELEASE_WATCH_DEFAULTS: ReleaseWatchSettings = {
  enabled: true,
  region: "",
  notify: { dates: true, "out-today": true, problems: true, arrived: true },
  overdueAfterDays: 2,
};
