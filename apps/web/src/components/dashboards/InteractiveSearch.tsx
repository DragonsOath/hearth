import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, Download, Search, X } from "lucide-react";
import { BLOCK_WORDS, blockReason } from "@dragon-control/core";
import type {
  ReleaseOption,
  ReleaseScope,
  ReleaseSearchResult,
  SearchApp,
  SearchEpisode,
  SearchTitle,
} from "@dragon-control/core";
import { api } from "../../data/api";
import { Skeleton, cx } from "../ui";
import { ChangeCard, useConfirmedChange } from "./ConfirmedChange";

/**
 * Interactive search (10-26), its own tab in the Sonarr, Radarr, Lidarr and Chaptarr panels:
 * find a title in the library, search every indexer for it (Sonarr: a season or one episode),
 * and send the release you pick to the download client. Searching downloads nothing; the
 * download is a plan you confirm right here.
 */

const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.78rem] text-ink hover:border-gold hover:text-gold disabled:opacity-50";

const NAME: Record<SearchApp, string> = {
  sonarr: "Sonarr",
  radarr: "Radarr",
  lidarr: "Lidarr",
  chaptarr: "Chaptarr",
};
const WHAT: Record<SearchApp, string> = {
  sonarr: "a series",
  radarr: "a movie",
  lidarr: "an album or artist",
  chaptarr: "a book or author",
};

const query = (scope: ReleaseScope) =>
  Object.entries(scope)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

/** Why the owner's own rules (the Crucible's settings in the app) turned a release down, plainly. */
export function ruleWords(x: ReleaseOption): { words: string; blocklisted: boolean } {
  const why = [...new Set(x.rejections.map(blockReason))];
  return {
    words: why.map((w) => BLOCK_WORDS[w]).join(", ") || "turned down for another reason",
    blocklisted: why.includes("blocklist"),
  };
}

const age = (h?: number) =>
  h === undefined ? "" : h < 48 ? `${h} h old` : `${Math.round(h / 24)} days old`;

/** Where the search is: choosing a title, then (Sonarr) what of it, then the releases. */
type Pick = {
  title: SearchTitle;
  scope?: ReleaseScope;
  /** What the releases are for, in words ("Ghosts (US) season 2"). */
  label?: string;
};

export function InteractiveSearch({ serviceId, app }: { serviceId: string; app: SearchApp }) {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<Pick>();
  const titles = useQuery({
    queryKey: ["search-titles", serviceId, q],
    queryFn: () =>
      api<{ titles: SearchTitle[]; sample?: boolean }>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/search/titles?q=${encodeURIComponent(q)}`,
      ),
    enabled: q.length > 0,
    staleTime: 60_000,
  });

  if (pick)
    return (
      <div className="space-y-3" data-testid="interactive-search">
        <button type="button" className={btn} onClick={() => setPick(undefined)}>
          <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> Back to the titles
        </button>
        {app === "sonarr" && !pick.scope ? (
          <SeriesPicker
            serviceId={serviceId}
            series={pick.title}
            onPick={(scope, label) => setPick({ ...pick, scope, label })}
          />
        ) : (
          <Releases
            serviceId={serviceId}
            app={app}
            scope={pick.scope ?? scopeOf(app, pick.title)}
            label={pick.label ?? titleWords(pick.title)}
            onBack={app === "sonarr" ? () => setPick({ title: pick.title }) : undefined}
          />
        )}
      </div>
    );

  return (
    <div className="space-y-3" data-testid="interactive-search">
      <p className="text-[0.8rem] text-muted">
        Search every indexer for {WHAT[app]} in {NAME[app]}, see each release and what {NAME[app]}{" "}
        thinks of it, and pick the one to download.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(text.trim());
        }}
      >
        <label htmlFor={`isearch-${serviceId}`} className="sr-only">
          Title to search for
        </label>
        <input
          id={`isearch-${serviceId}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Title"
          autoComplete="off"
          className="min-h-10 min-w-0 flex-1 rounded-lg border border-line-strong bg-bg px-3 text-[0.88rem] text-ink focus:border-gold/60 focus:outline-none"
          data-testid="isearch-input"
        />
        <button type="submit" className={btn} disabled={!text.trim()}>
          <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Find
        </button>
      </form>
      {titles.isFetching && <Skeleton className="h-16" />}
      {titles.isError && (
        <p role="alert" className="text-[0.82rem] text-bad">
          {(titles.error as Error).message}
        </p>
      )}
      {titles.data && !titles.isFetching && (
        <>
          {titles.data.titles.length === 0 ? (
            <p className="text-[0.86rem] text-muted">
              Nothing in {NAME[app]}&apos;s library matches &ldquo;{q}&rdquo;. Add it in {NAME[app]}{" "}
              first; then it can be searched for here.
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {titles.data.titles.map((t) =>
                t.notInLibrary ? (
                  <li
                    key={t.notInLibrary.foreignBookId}
                    className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-2.5"
                    data-testid="isearch-outside"
                  >
                    <span className="min-w-0 text-[0.9rem] text-muted">{titleWords(t)}</span>
                    <span className="flex items-baseline gap-2 text-[0.74rem] text-faint">
                      {[t.format, "not in Chaptarr yet"].filter(Boolean).join(" · ")}
                      {t.notInLibrary.addUrl && (
                        <a
                          href={t.notInLibrary.addUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-gold underline"
                        >
                          Add in Chaptarr
                        </a>
                      )}
                    </span>
                  </li>
                ) : (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => setPick({ title: t })}
                      className="flex w-full flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2.5 text-left hover:bg-gold/5"
                      data-testid="isearch-title"
                    >
                      <span className="min-w-0 text-[0.9rem] text-ink">{titleWords(t)}</span>
                      <span className="text-[0.74rem] text-faint">
                        {[
                          t.format,
                          t.hasFile === undefined ? "" : t.hasFile ? "on disk" : "missing",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </button>
                  </li>
                ),
              )}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

const titleWords = (t: SearchTitle) =>
  `${t.title}${t.year ? ` (${t.year})` : ""}${t.by ? ` by ${t.by}` : ""}`;

function scopeOf(app: SearchApp, t: SearchTitle): ReleaseScope {
  return app === "radarr"
    ? { movieId: t.id }
    : app === "lidarr"
      ? { albumId: t.id }
      : { bookId: t.id };
}

/** Sonarr: a whole season (a season pack), or one episode. */
function SeriesPicker({
  serviceId,
  series,
  onPick,
}: {
  serviceId: string;
  series: SearchTitle;
  onPick: (scope: ReleaseScope, label: string) => void;
}) {
  const eps = useQuery({
    queryKey: ["search-episodes", serviceId, series.id],
    queryFn: () =>
      api<{ episodes: SearchEpisode[] }>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/search/episodes?seriesId=${series.id}`,
      ),
  });
  const seasons = [...new Set((eps.data?.episodes ?? []).map((e) => e.season))];
  return (
    <div className="space-y-3">
      <p className="text-[0.92rem] text-ink">{titleWords(series)}</p>
      {eps.isPending && <Skeleton className="h-16" />}
      {eps.isError && (
        <p role="alert" className="text-[0.82rem] text-bad">
          {(eps.error as Error).message}
        </p>
      )}
      {seasons.map((s) => (
        <details key={s} className="rounded-xl border border-line" data-testid="isearch-season">
          <summary className="flex min-h-11 cursor-pointer items-center px-3 text-[0.88rem] text-ink">
            Season {s}
          </summary>
          <div className="border-t border-line px-3 py-2">
            <button
              type="button"
              className={btn}
              onClick={() =>
                onPick({ seriesId: series.id, seasonNumber: s }, `${series.title} season ${s}`)
              }
              data-testid="isearch-whole-season"
            >
              <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Search the whole season
            </button>
          </div>
          <ul className="divide-y divide-line border-t border-line">
            {(eps.data?.episodes ?? [])
              .filter((e) => e.season === s)
              .map((e) => {
                const code = `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")}`;
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => onPick({ episodeId: e.id }, `${series.title} ${code}`)}
                      className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-[0.84rem] hover:bg-gold/5"
                      data-testid="isearch-episode"
                    >
                      <span className="text-ink">
                        {code}
                        {e.title ? ` · ${e.title}` : ""}
                      </span>
                      <span className="text-[0.74rem] text-faint">
                        {e.hasFile ? "on disk" : "missing"}
                      </span>
                    </button>
                  </li>
                );
              })}
          </ul>
        </details>
      ))}
    </div>
  );
}

/** Every release the indexers offer for one item, best first, each with a Download button. */
export function Releases({
  serviceId,
  app,
  scope,
  label,
  onBack,
}: {
  serviceId: string;
  app: SearchApp;
  scope: ReleaseScope;
  label: string;
  onBack?: () => void;
}) {
  const [chosen, setChosen] = useState<string>();
  const [showRejected, setShowRejected] = useState(false);
  const c = useConfirmedChange(serviceId);
  const r = useQuery({
    queryKey: ["search-releases", serviceId, query(scope)],
    queryFn: () =>
      api<ReleaseSearchResult>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/search/releases?${query(scope)}`,
      ),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const list = r.data?.releases ?? [];
  const accepted = list.filter((x) => x.approved);
  const shown = showRejected ? list : accepted.length ? accepted : list;
  const download = (x: ReleaseOption) => {
    setChosen(x.guid);
    const params = {
      guid: x.guid,
      indexerId: x.indexerId,
      release: x.title,
      title: label,
      ...(x.quality ? { quality: x.quality } : {}),
      ...(x.sizeGB !== undefined ? { sizeGB: x.sizeGB } : {}),
      ...(x.indexer ? { indexer: x.indexer } : {}),
      // Against the owner's own rules: the plan says it is a one-time exception (rules unchanged).
      ...(!x.approved ? { exception: ruleWords(x).words } : {}),
    };
    void (app === "sonarr" || app === "radarr"
      ? c.propose("app-arr-grab", params, `Download ${x.title}`)
      : c.propose(
          app === "lidarr" ? "app-lidarr-control" : "app-chaptarr-control",
          { op: "grab", ...params },
          `Download ${x.title}`,
        ));
  };
  return (
    <div className="space-y-3" data-testid="isearch-releases">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.92rem] text-ink">{label}</p>
        {onBack && (
          <button type="button" className={btn} onClick={onBack}>
            Choose another episode or season
          </button>
        )}
      </div>
      {r.isFetching && (
        <div className="space-y-2">
          <p className="text-[0.8rem] text-muted">
            Searching every indexer. This can take up to a minute.
          </p>
          <Skeleton className="h-24" />
        </div>
      )}
      {r.isError && (
        <p role="alert" className="text-[0.82rem] text-bad">
          {(r.error as Error).message}
        </p>
      )}
      {r.data && !r.isFetching && (
        <>
          <p className="text-[0.78rem] text-faint">
            {r.data.found} found
            {r.data.found
              ? `, ${accepted.length} ${NAME[app]} would take on its own`
              : ". Nothing on the indexers right now."}
            {r.data.sample ? " · sample data" : ""}
          </p>
          {r.data.nearMiss && r.data.nearMiss.kind === "blocked" && (
            <div
              className="rounded-xl border border-amber/40 bg-amber/5 p-3"
              role="status"
              data-testid="near-miss"
            >
              <p className="text-[0.86rem] text-ink">{r.data.nearMiss.sentence}</p>
              {r.data.nearMiss.closest ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={btn}
                    disabled={chosen !== undefined}
                    onClick={() => {
                      const nm = r.data?.nearMiss;
                      if (nm?.kind === "blocked" && nm.closest) download(nm.closest);
                    }}
                    data-testid="near-miss-grab"
                  >
                    Grab it anyway
                  </button>
                  <span className="text-[0.76rem] text-faint">
                    Just this once, for this title. Your rules stay as they are.
                  </span>
                </div>
              ) : (
                <p className="mt-1 text-[0.76rem] text-faint">
                  Each release below says why {NAME[app]} skipped it.
                </p>
              )}
            </div>
          )}
          {accepted.length > 0 && accepted.length < list.length && (
            <button type="button" className={btn} onClick={() => setShowRejected((v) => !v)}>
              {showRejected
                ? `Show only the ${accepted.length} ${NAME[app]} would take`
                : `Show all ${list.length}, with why ${NAME[app]} would skip the rest`}
            </button>
          )}
          <ul className="space-y-2">
            {shown.map((x) => (
              <li
                key={x.guid}
                className={cx(
                  "rounded-xl border p-3",
                  x.approved ? "border-line" : "border-line bg-bg/40",
                )}
                data-testid="isearch-release"
              >
                <p className="font-mono text-[0.76rem] break-all text-ink">{x.title}</p>
                {x.hidden && (
                  <p className="mt-1 text-[0.72rem] text-muted" data-testid="isearch-hidden">
                    Hidden by {NAME[app]}: usually a collection or pack. Check the size before you
                    download it.
                  </p>
                )}
                {(x.resolution || x.source || x.codec || x.audio || x.hdr) && (
                  <p className="mt-1.5 flex flex-wrap gap-1" data-testid="isearch-details">
                    {[x.resolution, x.source, x.codec, x.hdr, x.audio].filter(Boolean).map((d) => (
                      <span
                        key={d}
                        className="rounded-md border border-line-strong px-1.5 py-0.5 text-[0.7rem] text-muted"
                      >
                        {d}
                      </span>
                    ))}
                  </p>
                )}
                <p className="mt-1 text-[0.76rem] text-faint">
                  {[
                    x.quality,
                    x.sizeGB !== undefined ? `${x.sizeGB} GB` : "",
                    x.indexer,
                    x.protocol === "torrent"
                      ? `${x.seeders ?? 0} seeders`
                      : x.protocol === "usenet"
                        ? "usenet"
                        : "",
                    age(x.ageHours),
                    x.score !== undefined ? `score ${x.score}` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {x.approved ? (
                    <span className="inline-flex items-center gap-1 text-[0.76rem] text-live">
                      <Check strokeWidth={2} className="h-3.5 w-3.5" /> {NAME[app]} would take it
                    </span>
                  ) : (
                    <span
                      className="inline-flex items-start gap-1 text-[0.76rem] text-amber"
                      data-testid="isearch-rule"
                    >
                      <X strokeWidth={2} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        Your rules turned it down: {ruleWords(x).words}
                        {x.rejections.length > 0 && (
                          <span className="block text-faint">
                            {NAME[app]}: {x.rejections.join("; ")}
                          </span>
                        )}
                      </span>
                    </span>
                  )}
                  {ruleWords(x).blocklisted && !x.approved ? (
                    <span className="ml-auto text-[0.74rem] text-faint">
                      Blocklisted, so Hearth won&apos;t download it
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={cx(btn, "ml-auto")}
                      disabled={c.busy}
                      onClick={() => download(x)}
                      title={
                        x.approved
                          ? undefined
                          : "A one-time exception for this release only. Your quality rules stay as they are."
                      }
                      data-testid="isearch-download"
                      data-hearth-target="release:grab"
                    >
                      <Download strokeWidth={1.5} className="h-3.5 w-3.5" />{" "}
                      {x.approved ? "Download this" : "Download anyway"}
                    </button>
                  )}
                </div>
                {chosen === x.guid && !x.approved && (
                  <p className="mt-2 text-[0.76rem] text-ink" data-testid="isearch-exception">
                    A one-time exception: {NAME[app]} downloads this release even though your rules
                    turned it down ({ruleWords(x).words}). Your rules stay as they are, for this and
                    everything else.
                  </p>
                )}
                {chosen === x.guid && (
                  <div className="mt-2 empty:hidden">
                    <ChangeCard c={c} />
                  </div>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className={btn} onClick={() => void r.refetch()}>
            <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Search again
          </button>
        </>
      )}
    </div>
  );
}
