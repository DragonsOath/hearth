/**
 * Recommend, Discover (checklist 48.1): you say what you're in the mood for, Ember
 * suggests titles, and Hearth checks each one against the real catalogue (so an invented title is
 * dropped) and against your library (so what you own is hidden), with a way to request the rest.
 * Movies and shows through Seerr, music through Lidarr, books and audiobooks through Chaptarr.
 */

export const RECOMMEND_KINDS = ["movie", "show", "book", "audiobook", "music"] as const;
export type RecommendKind = (typeof RECOMMEND_KINDS)[number];

export const RECOMMEND_KIND_NAMES: Record<RecommendKind, { one: string; many: string }> = {
  movie: { one: "movie", many: "Movies" },
  show: { one: "show", many: "Shows" },
  book: { one: "book", many: "Books" },
  audiobook: { one: "audiobook", many: "Audiobooks" },
  music: { one: "artist", many: "Music" },
};

/** Genres offered as filters, per kind (Ember may still suggest across them). */
export const RECOMMEND_GENRES: Record<RecommendKind, string[]> = {
  movie: [
    "Comedy",
    "Romance",
    "Action",
    "Drama",
    "Horror",
    "Thriller",
    "Sci-fi",
    "Fantasy",
    "Animation",
    "Family",
    "Documentary",
    "Crime",
  ],
  show: [
    "Comedy",
    "Drama",
    "Crime",
    "Sci-fi",
    "Fantasy",
    "Animation",
    "Reality",
    "Documentary",
    "Mystery",
    "Family",
  ],
  book: [
    "Fantasy",
    "Sci-fi",
    "Romance",
    "Mystery",
    "Thriller",
    "Horror",
    "Historical",
    "Biography",
    "Self-help",
    "Young adult",
  ],
  audiobook: [
    "Fantasy",
    "Sci-fi",
    "Romance",
    "Mystery",
    "Thriller",
    "Horror",
    "Historical",
    "Biography",
    "Self-help",
    "Comedy",
  ],
  music: [
    "Rock",
    "Pop",
    "Hip hop",
    "Country",
    "Jazz",
    "Electronic",
    "Classical",
    "Metal",
    "R&B",
    "Folk",
  ],
};

export interface RecommendFilters {
  fromYear?: number;
  toYear?: number;
  genres?: string[];
  /** Out of 10 (TMDB for movies and shows). */
  minRating?: number;
  /** Movies: short under 90 minutes, long over 2 hours. Books: short under 300 pages. */
  length?: "short" | "medium" | "long";
}

export interface RecommendRequest {
  kind: RecommendKind;
  /** What you're in the mood for ("Christmas movies"). */
  interest: string;
  filters?: RecommendFilters;
  /** Titles already shown or requested in this session: never suggested again. */
  exclude?: string[];
  /**
   * "missing" (the default) hides what you have; "both" shows it, marked as in your library;
   * "have" picks only from your library (its titles, names and years only, go to Ember then).
   */
  show?: RecommendShow;
  /** Why you're here (11-09): each asks Ember a little differently. */
  mode?: RecommendMode;
  /**
   * Think outside the box (the owner, 11-10): adjacent titles too, sharing the theme's feel,
   * season, setting and values without being about it (family snow films for Christmas).
   */
  wide?: boolean;
}

export const RECOMMEND_SHOW = ["have", "missing", "both"] as const;
export type RecommendShow = (typeof RECOMMEND_SHOW)[number];

/**
 * What you're here for: something new to try (discover), a gap to fill ("my brother says I
 * have no kids movies"), a niche to complete ("time loop movies"), or a genre to go deeper in.
 */
export const RECOMMEND_MODES = ["discover", "gap", "niche", "expand"] as const;
export type RecommendMode = (typeof RECOMMEND_MODES)[number];

/** How it was, when you say you've seen it (all optional). */
export const RECOMMEND_REACTIONS = ["loved", "ok", "not-for-me", "horrible"] as const;
export type RecommendReaction = (typeof RECOMMEND_REACTIONS)[number];
export const RECOMMEND_REACTION_NAMES: Record<RecommendReaction, string> = {
  loved: "Loved it",
  ok: "OK",
  "not-for-me": "Not for me",
  horrible: "Horrible",
};
export interface RecommendRating {
  /** 1 to 5. */
  stars?: number;
  reaction?: RecommendReaction;
  /** Your own words, kept in Hearth (Ember's ratings). */
  note?: string;
}

/** A title you said you've seen (or read, or know): never suggested again. */
export interface RecommendSeen {
  kind: RecommendKind;
  title: string;
  year?: number;
  rating?: RecommendRating;
}

/** Marking a seen title watched on one of your media servers: a plan step you approve. */
export interface RecommendWatchStep {
  serviceId: string;
  /** The server's name, for the question ("on Plex"). */
  server: string;
  step: "app-plex-control" | "app-jellyfin-control";
  /** What it does: mark it watched, or put your rating there. */
  does: "watched" | "rating";
  params: Record<string, string>;
  title: string;
}

export interface RecommendSeenResult {
  /**
   * Changes offered on your Plex and Jellyfin, never done without approval: marking it watched
   * where it isn't yet, and your rating (Plex: the stars; Jellyfin: a like, and Favorite).
   */
  markWatched: RecommendWatchStep[];
}

/** How a suggestion is requested: a plan step to propose, or the app's own page to open. */
export type RecommendAction =
  | {
      kind: "plan";
      serviceId: string;
      step: string;
      params: Record<string, string | number | boolean>;
      label: string;
    }
  | { kind: "open"; url: string; label: string };

export interface RecommendItem {
  /** Stable within a result: kind and catalogue id. */
  key: string;
  kind: RecommendKind;
  title: string;
  year?: number;
  /** Director, author or artist, when known. */
  creator?: string;
  /** Ember's reason, one line. */
  why: string;
  /** A picture through Hearth (never an outside address in the page). */
  image?: string;
  /** Already asked for in Seerr, or monitored in the app without files yet. */
  requested?: boolean;
  /** Already in your library (shown when you ask for your library, or both). */
  have?: boolean;
  /** A show you have some seasons of: the request is for the missing ones. */
  partial?: boolean;
  request?: RecommendAction;
  /** Think outside the box: Ember's nearby pick (shown with Ember thinking, 11-24). */
  outside?: boolean;
  /** Movies and shows: the title in Seerr, for its full page (trailer, ratings, cast). */
  tmdbId?: number;
  mediaType?: "movie" | "tv";
}

export interface RecommendResult {
  kind: RecommendKind;
  items: RecommendItem[];
  /** Suggestions you already have, hidden from the list (said, never silent). */
  owned: { title: string; year?: number }[];
  /** Suggestions the catalogue couldn't find (dropped, never shown as real). */
  unverified: string[];
  /** Why there is no way to check or request this kind here (app not connected). */
  missingApp?: string;
  /** Said plainly about this answer ("Ember chose from 412 titles in your library"). */
  note?: string;
  /** Music: Lidarr's quality profiles, to choose which one a new artist gets. */
  qualityProfiles?: { id: number; name: string }[];
}
