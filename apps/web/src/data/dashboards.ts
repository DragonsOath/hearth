import { useQuery } from "@tanstack/react-query";
import type { AppDashboard, MovieItem, TorrentDetail } from "@dragon-control/core";
import { api } from "./api";
import { useLiveQuery } from "../components/panels/lifecycle";

/** How often an open live dashboard refreshes (paused while the browser tab is hidden). */
export const DASHBOARD_REFRESH_MS = 2_000;

/** A service's live dashboard, read through the broker; only while it is on screen. */
export function useDashboard(serviceId: string, enabled = true, refreshMs = DASHBOARD_REFRESH_MS) {
  return useLiveQuery({
    queryKey: ["dashboard", serviceId],
    queryFn: () =>
      api<AppDashboard>("GET", `/api/services/${encodeURIComponent(serviceId)}/dashboard`),
    enabled,
    refetchInterval: refreshMs,
    refetchIntervalInBackground: false,
  });
}

/** Movies in Radarr by title (its panel's Find), from the library Hearth last read. */
export function useMovieSearch(serviceId: string, q: string) {
  return useQuery({
    queryKey: ["movies", serviceId, q],
    queryFn: () =>
      api<{ at?: string; sample?: boolean; movies: MovieItem[] }>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/dashboard/movies?q=${encodeURIComponent(q)}`,
      ),
    enabled: q.length >= 2,
    staleTime: 60_000,
  });
}

/** One torrent in depth (trackers, peers), while it is selected. */
export function useTorrentDetail(
  serviceId: string,
  hash: string | undefined,
  /** Also its files or peers, read only while that view is open. */
  more?: "files" | "peers",
) {
  return useLiveQuery({
    // Under the dashboard key, so an approved change refreshes it with the panel.
    queryKey: ["dashboard", serviceId, "torrent", hash, more ?? ""],
    queryFn: () =>
      api<TorrentDetail>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/dashboard/torrents/${hash}${more ? `?with=${more}` : ""}`,
      ),
    enabled: Boolean(hash),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
}

/** A Plex picture through Hearth (the token stays on the server). */
export const plexArt = (serviceId: string, path: string) =>
  `/api/services/${encodeURIComponent(serviceId)}/dashboard/art?path=${encodeURIComponent(path)}`;
