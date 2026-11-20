import { useState } from "react";
import { Clock, Send } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../data/api";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import type { SearchResult } from "../dashboards/seerr/data";

/** Seerr statuses a title can still be requested from (as Seerr's Discover has them). */
const OPEN = new Set(["not requested", "partly available", "deleted"]);

interface Awaiting {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  year?: number;
  requestedAt: string;
}

/**
 * The Forge (11-07): a title the library doesn't have can be requested from the sheet. Once it
 * is in Plex it joins the sheet in Selected by itself, and Ember is told so it can propose the
 * change. Request, download and add-to-list in one step; the request is a plan you approve.
 */
export function RequestMissing({ workspaceId, typed }: { workspaceId: string; typed: string }) {
  const qc = useQueryClient();
  const found = useQuery({
    queryKey: ["forge-request-search", typed],
    queryFn: () =>
      api<{ seerrServiceId: string | null; results: SearchResult[] }>(
        "GET",
        `/api/forge/request-search?q=${encodeURIComponent(typed)}`,
      ),
    enabled: typed.length >= 2,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
  const waiting = useQuery({
    queryKey: ["forge-awaiting", workspaceId],
    queryFn: () => api<{ awaiting: Awaiting[] }>("GET", `/api/workspaces/${workspaceId}/awaiting`),
  });
  const remember = useMutation({
    mutationFn: (r: SearchResult) =>
      api("POST", `/api/workspaces/${workspaceId}/awaiting`, {
        tmdbId: r.tmdbId,
        mediaType: r.mediaType,
        title: r.title,
        ...(r.year ? { year: r.year } : {}),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["forge-awaiting", workspaceId] }),
  });
  const seerr = found.data?.seerrServiceId ?? "";
  const act = useApproveHere(seerr, "Requested from a Forge sheet.");
  const [asked, setAsked] = useState<number[]>([]);
  const awaiting = waiting.data?.awaiting ?? [];
  const isWaiting = (id: number) => awaiting.some((a) => a.tmdbId === id) || asked.includes(id);
  const results = (found.data?.results ?? []).filter((r) => r.status !== "available").slice(0, 6);

  if (!seerr && !awaiting.length) return null;
  return (
    <section
      aria-label="Not in your library"
      className="rounded-lg border border-line p-2"
      data-testid="pick-request"
    >
      <h3 className="px-1 pb-1.5 text-[0.76rem] tracking-wide text-muted uppercase">
        Not in your library
      </h3>
      {seerr && results.length > 0 && (
        <ul className="grid gap-1.5">
          {results.map((r) => {
            const open = OPEN.has(r.status);
            const mine = isWaiting(r.tmdbId);
            return (
              <li
                key={`${r.mediaType}-${r.tmdbId}`}
                className="flex items-center gap-2 rounded-lg border border-line/70 px-2.5 py-1.5"
                data-testid="pick-request-item"
              >
                {r.poster && (
                  <img
                    src={`/api/services/${seerr}/dashboard/poster?path=${encodeURIComponent(r.poster)}`}
                    alt=""
                    loading="lazy"
                    className="aspect-[2/3] w-9 shrink-0 rounded border border-line object-cover"
                    onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.84rem] text-ink">{r.title}</span>
                  <span className="block text-[0.72rem] text-faint">
                    {[r.year, r.mediaType === "tv" ? "Show" : "Movie", open ? "" : r.status]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                {mine ? (
                  <span className="inline-flex items-center gap-1 text-[0.74rem] text-gold">
                    <Clock strokeWidth={1.75} className="h-3.5 w-3.5" /> Joins when it arrives
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={act.busy || remember.isPending}
                    onClick={() => {
                      // Already requested by someone: only wait for it. Otherwise ask first.
                      if (open)
                        void act.propose(
                          "app-seerr-request",
                          { mediaType: r.mediaType, tmdbId: r.tmdbId },
                          `Request ${r.title}`,
                        );
                      setAsked((a) => [...a, r.tmdbId]);
                      remember.mutate(r);
                    }}
                    className="inline-flex min-h-8 items-center gap-1 rounded-md border border-gold/50 px-2 text-[0.76rem] text-gold hover:bg-gold/10 disabled:opacity-50"
                    aria-label={open ? `Request ${r.title}` : `Add ${r.title} when it arrives`}
                    data-testid="pick-request-go"
                  >
                    <Send strokeWidth={1.5} className="h-3.5 w-3.5" />
                    {open ? "Request it" : "Add when it arrives"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {seerr && found.isSuccess && !results.length && (
        <p className="px-1 py-2 text-[0.8rem] text-faint">
          Seerr finds nothing else for &ldquo;{typed}&rdquo;.
        </p>
      )}
      {awaiting.length > 0 && (
        <p className="px-1 pt-1.5 text-[0.76rem] text-muted" data-testid="pick-awaiting">
          Requested, joins Selected when it arrives:{" "}
          {awaiting.map((a) => `${a.title}${a.year ? ` (${a.year})` : ""}`).join(", ")}
        </p>
      )}
      {(act.error || remember.isError) && (
        <p className="px-1 pt-1 text-[0.78rem] text-amber" role="alert">
          {act.error ?? (remember.error as Error).message}
        </p>
      )}
      <ApproveDialog c={act} />
    </section>
  );
}
