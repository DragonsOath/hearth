import { useState } from "react";
import { Film, Search, Tv } from "lucide-react";
import type { AppViewProps } from "../../panels/registry";
import { ApproveDialog, useApproveHere } from "../../jobs/ApproveHere";
import { Button, Skeleton, cx } from "../../ui";
import { HAVE, posterSrc, useSeerrView, type SearchResult } from "./data";
import { DiscoverRows, TitleSheet } from "./DiscoverRows";
import { REQUESTABLE } from "./request";

/**
 * Seerr's Discover: find a movie or show the way Seerr does (TMDB, through Seerr) and request it,
 * a show by season. Each request is a plan you approve; Seerr then sends it to Radarr or Sonarr.
 * What is already in the library or requested says so instead of offering a request.
 */

/** The search term kept in the panel's address (discover/<term>). */
const safeDecode = (sub?: string | null) => {
  try {
    return sub ? decodeURIComponent(sub) : "";
  } catch {
    return sub ?? "";
  }
};

export function SeerrDiscover({ serviceId, name, sub, onSub }: AppViewProps) {
  const [text, setText] = useState(safeDecode(sub));
  const query = safeDecode(sub);
  const q = useSeerrView<{ results: SearchResult[] }>(
    serviceId,
    "search",
    { query },
    Boolean(query),
  );
  const act = useApproveHere(serviceId, "Requested from Seerr's Discover tab.");
  // Requesting opens the title's details, which ask where to save it (and a show's seasons).
  const [detail, setDetail] = useState<SearchResult>();
  // Posters that could not load show the plain tile instead of a broken image.
  const [broken, setBroken] = useState<Set<string>>(() => new Set());
  return (
    <section className="@container space-y-3" aria-label={`${name} discover`}>
      <ApproveDialog c={act} />
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) onSub?.(encodeURIComponent(text.trim()));
        }}
      >
        <label className="relative min-w-0 flex-1 basis-56">
          <Search
            strokeWidth={1.5}
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint"
          />
          <input
            type="search"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              // Clearing the search brings Discover's rows back.
              if (!e.target.value.trim() && query) onSub?.("");
            }}
            placeholder="Find a movie or show"
            aria-label="Find a movie or show"
            className="min-h-10 w-full rounded-lg border border-line bg-raised pr-3 pl-9 text-[0.86rem] text-ink"
            data-hearth-target="discover:search"
          />
        </label>
        <Button tone="primary" type="submit" data-hearth-target="discover:find">
          Find
        </Button>
      </form>
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      {!query ? (
        <DiscoverRows serviceId={serviceId} name={name} act={act} />
      ) : q.isLoading ? (
        <Skeleton className="h-40" />
      ) : q.error ? (
        <p className="text-[0.84rem] text-amber">Could not search: {q.error.message}</p>
      ) : !q.data?.results.length ? (
        <p className="text-[0.84rem] text-muted">Nothing found for &ldquo;{query}&rdquo;.</p>
      ) : (
        <ul className="grid gap-2 @2xl:grid-cols-2">
          {q.data.results.map((r) => {
            const can = REQUESTABLE.has(r.status);
            const key = `${r.mediaType}-${r.tmdbId}`;
            const src = broken.has(key) ? undefined : posterSrc(serviceId, r.poster);
            return (
              <li
                key={`${r.mediaType}-${r.tmdbId}`}
                className="flex gap-3 rounded-xl border border-line p-2.5"
                data-testid="seerr-result"
                data-hearth-target={`discover:${r.tmdbId}`}
                data-capture-item
                data-capture-label={r.title}
              >
                {src ? (
                  <img
                    src={src}
                    alt=""
                    loading="lazy"
                    onError={() => setBroken((b) => new Set(b).add(key))}
                    className="h-24 w-16 shrink-0 rounded-md object-cover"
                  />
                ) : (
                  <div className="flex h-24 w-16 shrink-0 items-center justify-center rounded-md bg-raised text-faint">
                    {r.mediaType === "tv" ? (
                      <Tv className="h-5 w-5" />
                    ) : (
                      <Film className="h-5 w-5" />
                    )}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-[0.88rem] text-ink">
                    {r.title}
                    {r.year ? <span className="text-faint"> ({r.year})</span> : null}
                  </p>
                  <p className="text-[0.74rem] text-faint">
                    {r.mediaType === "tv" ? "Show" : "Movie"} ·{" "}
                    <span className={cx(HAVE.has(r.status) && "text-live")}>{r.status}</span>
                  </p>
                  {r.overview && (
                    <p className="mt-1 line-clamp-2 text-[0.78rem] text-muted">{r.overview}</p>
                  )}
                  {can && (
                    <Button
                      tone="primary"
                      className="mt-2"
                      disabled={act.busy}
                      data-hearth-target={`discover:${r.tmdbId}:details`}
                      onClick={() => setDetail(r)}
                    >
                      {r.mediaType === "tv" ? "Choose seasons" : "Request"}
                    </Button>
                  )}
                  {/* In your library: Details (Tell Seerr you have it, Upgrade quality). */}
                  {HAVE.has(r.status) && (
                    <Button
                      tone="outline"
                      className="mt-2"
                      data-hearth-target={`discover:${r.tmdbId}:details`}
                      onClick={() => setDetail(r)}
                    >
                      Details
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {detail && (
        <TitleSheet
          serviceId={serviceId}
          r={detail}
          act={act}
          onClose={() => setDetail(undefined)}
        />
      )}
    </section>
  );
}
