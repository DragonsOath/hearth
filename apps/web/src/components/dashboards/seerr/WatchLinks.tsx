import { useQuery } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { api } from "../../../data/api";
import { Skeleton } from "../../ui";

/** Where a title you have can be watched (server: /api/recommend/watch). */
interface WatchPlace {
  serviceId: string;
  server: string;
  app: "plex" | "jellyfin" | "emby";
  url: string;
  watched: boolean;
}
const APP_NAME = { plex: "Plex", jellyfin: "Jellyfin", emby: "Emby" } as const;

/**
 * Watch it (Curator, the owner 11-24): one button per server that has the title, opening it in
 * that app. Plex opens in Plex's own app (app.plex.tv), Jellyfin and Emby at their address.
 */
export function WatchLinks({
  type,
  title,
  year,
}: {
  type: "movie" | "tv";
  title: string;
  year?: number;
}) {
  const q = useQuery({
    queryKey: ["recommend-watch", type, title, year],
    queryFn: () =>
      api<{ places: WatchPlace[] }>(
        "GET",
        `/api/recommend/watch?kind=${type === "tv" ? "show" : "movie"}&title=${encodeURIComponent(title)}${year ? `&year=${year}` : ""}`,
      ),
    staleTime: 5 * 60_000,
  });
  if (q.isLoading) return <Skeleton className="h-10 w-40" />;
  const places = q.data?.places ?? [];
  if (!places.length)
    return (
      <p className="self-center text-[0.8rem] text-muted" data-testid="watch-none">
        In your library. Hearth couldn&apos;t find it by name on your Plex, Jellyfin or Emby to link
        to it.
      </p>
    );
  const many = new Set(places.map((p) => p.app)).size < places.length;
  return (
    <>
      {places.map((p, i) => (
        <a
          key={p.serviceId}
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          className={
            i === 0
              ? "inline-flex min-h-11 items-center gap-2 rounded-lg bg-gold px-4 text-[0.88rem] font-semibold text-bg hover:brightness-110"
              : "inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-strong px-4 text-[0.88rem] text-ink hover:border-gold"
          }
          data-testid="watch-link"
        >
          <Play className="h-4 w-4" fill="currentColor" aria-hidden />
          Watch on {APP_NAME[p.app]}
          {many ? ` (${p.server})` : ""}
          {p.watched && <span className="text-[0.72rem] opacity-75">· seen</span>}
        </a>
      ))}
    </>
  );
}
