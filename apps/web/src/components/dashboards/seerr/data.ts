import { useQuery } from "@tanstack/react-query";
import { api } from "../../../data/api";

/** One view of the Seerr panel's tabs, under "dashboard" so a finished plan refreshes it. */
export function useSeerrView<T>(
  serviceId: string,
  view:
    | "search"
    | "discover"
    | "title"
    | "servers"
    | "issues"
    | "issue"
    | "users"
    | "similar"
    | "ratings",
  q: Record<string, string | number | undefined> = {},
  enabled = true,
  /** How long an answer is fresh (Discover's rows: minutes, not seconds). */
  staleTime = 20_000,
) {
  const params = new URLSearchParams(
    Object.entries(q)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  return useQuery({
    queryKey: ["dashboard", serviceId, "seerr", view, params],
    queryFn: () =>
      api<T & { sample?: boolean }>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/seerr/${view}${params ? `?${params}` : ""}`,
      ),
    enabled,
    staleTime,
  });
}

/** One of Discover's rows (seerr-panel.ts DISCOVER_ROWS). */
export interface DiscoverRowView {
  id: "trending-movies" | "recent-movies" | "upcoming-movies" | "trending-tv";
  title: string;
  page: number;
  pages: number;
  results: SearchResult[];
  error?: string;
}
export interface SearchResult {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  year?: number;
  overview: string;
  poster?: string;
  /** The wide picture behind a hero or a title's banner. */
  backdrop?: string;
  status: string;
  /** Radarr or Sonarr has it on disk though Seerr calls it not requested (seerr-library.ts). */
  library?: LibraryNote;
}
export interface UpgradeInfo {
  app: "radarr" | "sonarr";
  serviceId: string;
  service: string;
  arrId: number;
  profileId?: number;
  monitored: boolean;
  quality?: string;
  profiles: { id: number; name: string; cutoff?: string }[];
}
export interface LibraryNote {
  app: "Radarr" | "Sonarr";
  service: string;
  files: number;
}
/** Seerr's words for a title you already have (Hearth's "in your library": Radarr has it). */
export const HAVE = new Set(["available", "in your library"]);
export interface TitleView {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  year?: number;
  status: string;
  overview?: string;
  /** Release or first air date (YYYY-MM-DD). */
  released?: string;
  /** TMDB's average score out of 10, as Seerr reports it. */
  rating?: number;
  runtime?: number;
  genres?: string[];
  poster?: string;
  /** The YouTube trailer, when TMDB has one for this title. */
  trailer?: string;
  backdrop?: string;
  tagline?: string;
  /** The US age rating: PG-13, TV-MA. */
  certification?: string;
  director?: string;
  createdBy?: string;
  cast?: { name: string; character?: string; photo?: string }[];
  imdbId?: string;
  library?: LibraryNote;
  /** Seerr's own record of the title (for Tell Seerr you have it). */
  mediaId?: number;
  /** In Radarr or Sonarr: its quality now and the profiles it could move to (Upgrade quality). */
  upgrade?: UpgradeInfo;
  seasons: { number: number; name: string; episodes: number; status: string }[];
}
export interface IssueRow {
  id: number;
  open: boolean;
  type: string;
  title: string;
  where?: string;
  by: string;
  createdAt?: string;
  updatedAt?: string;
  comments: number;
}
export interface IssueView {
  id: number;
  open: boolean;
  type: string;
  title: string;
  by: string;
  createdAt?: string;
  comments: { id: number; by: string; at?: string; message: string }[];
}
export interface UserRow {
  id: number;
  name: string;
  account: string;
  admin: boolean;
  requests: number;
  movieLimit: string;
  tvLimit: string;
  joined?: string;
}

/** A poster through Hearth (never loaded from TMDB by the browser); a backdrop or face size too. */
export const posterSrc = (serviceId: string, path?: string, size?: "backdrop" | "face") =>
  path
    ? `/api/services/${serviceId}/dashboard/poster?path=${encodeURIComponent(path)}${size ? `&size=${size}` : ""}`
    : undefined;

/** IMDb and Rotten Tomatoes for one title, as Seerr gathers them (often partly missing). */
export interface RatingsView {
  imdb?: { score: number; url?: string };
  rottenTomatoes?: { critics?: number; audience?: number; url?: string };
}
