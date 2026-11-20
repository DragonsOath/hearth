import { useDeferredValue, useState, type ReactNode } from "react";
import { FolderPlus, Search, Star } from "lucide-react";
import {
  MAX_JOB_STEPS,
  type MovieItem,
  type MovieTier,
  type RadarrLibrary,
} from "@dragon-control/core";
import { useMovieSearch } from "../../data/dashboards";
import { bytes } from "../../lib/format";
import { Segmented, cx } from "../ui";
import type { Propose } from "./ArrDashboard";

/**
 * Radarr's library views: the collection at a glance (how sharp, which codecs, how big, space
 * left), what is coming out, movies below the quality their profile asks for, collections you
 * have part of, and Find. Reading changes nothing; Search and Add only propose a plan.
 */

const btn =
  "inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.78rem] text-ink hover:border-gold hover:text-gold disabled:opacity-50";
const input =
  "min-h-10 min-w-0 flex-1 rounded-lg border border-line bg-raised px-3 text-[0.86rem] text-ink";

/** Sharper is stronger: one hue, so the bar reads as "how much of the library is how sharp". */
const TIER_FILL: Record<MovieTier, string> = {
  "4K": "bg-gold",
  "1080p": "bg-gold/70",
  "720p": "bg-gold/45",
  SD: "bg-gold/25",
  Unknown: "bg-line-strong",
};
const TIER_NAME: Record<MovieTier, string> = {
  "4K": "4K",
  "1080p": "1080p",
  "720p": "720p",
  SD: "Standard definition",
  Unknown: "Unknown",
};

const n = (x: number) => x.toLocaleString();
const name = (m: { title: string; year?: number }) => `${m.title}${m.year ? ` (${m.year})` : ""}`;
const day = (at: string) =>
  new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const inDays = (at: string) => {
  const d = Math.round((Date.parse(at) - Date.now()) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`;
};

export function LibrarySummary({ lib }: { lib: RadarrLibrary }) {
  // Folders on the same disk report the same free space: say it once.
  const disks = new Map<number, string[]>();
  for (const f of lib.folders)
    if (f.freeBytes !== undefined)
      disks.set(f.freeBytes, [...(disks.get(f.freeBytes) ?? []), f.path]);
  return (
    <div
      className="space-y-3 rounded-xl border border-line bg-bg/50 p-3"
      data-testid="radarr-library"
    >
      <p className="text-[0.86rem] text-ink">
        {n(lib.onDisk)} movies on disk · {bytes(lib.sizeBytes)}
        {[...disks].map(([free, paths]) => (
          <span key={free} className="text-muted">
            {" "}
            · {bytes(free)} free ({paths.join(", ")})
          </span>
        ))}
      </p>
      <div>
        <div
          className="flex h-2.5 overflow-hidden rounded-full bg-line"
          role="img"
          aria-label={`Quality: ${lib.tiers.map((t) => `${n(t.count)} ${TIER_NAME[t.tier]}`).join(", ")}`}
        >
          {lib.tiers.map((t) => (
            <div
              key={t.tier}
              className={cx("h-full border-r border-bg last:border-r-0", TIER_FILL[t.tier])}
              style={{ width: `${(t.count / Math.max(1, lib.onDisk)) * 100}%` }}
            />
          ))}
        </div>
        <ul
          className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.76rem] text-muted"
          data-testid="radarr-tiers"
        >
          {lib.tiers.map((t) => (
            <li key={t.tier} className="inline-flex items-center gap-1.5">
              <span className={cx("h-2.5 w-2.5 rounded-sm", TIER_FILL[t.tier])} aria-hidden />
              <span className="text-ink">{TIER_NAME[t.tier]}</span> {n(t.count)} ·{" "}
              {Math.round((t.count / Math.max(1, lib.onDisk)) * 100)}%
            </li>
          ))}
        </ul>
      </div>
      <p className="text-[0.76rem] text-faint">
        {lib.codecs.map((c) => `${c.name} ${n(c.count)}`).join(" · ")}
        {` · HDR or Dolby Vision ${n(lib.hdr)}`}
      </p>
      {lib.biggest.length > 0 && (
        <p className="text-[0.76rem] text-faint" data-testid="radarr-biggest">
          Biggest: {lib.biggest.map((m) => `${m.title} ${bytes(m.sizeBytes)}`).join(" · ")}
        </p>
      )}
    </div>
  );
}

export function ComingMovies({ lib }: { lib: RadarrLibrary }) {
  if (!lib.coming.length)
    return (
      <p className="text-[0.86rem] text-muted">Nothing you want comes out in the next 6 months.</p>
    );
  return (
    <ul className="divide-y divide-line">
      {lib.coming.map((c) => (
        <li
          key={c.movieId}
          className="flex flex-wrap items-baseline gap-x-3 py-2.5 text-[0.86rem]"
          data-testid="radarr-coming"
        >
          <span className="min-w-0 flex-1 text-ink">{name(c)}</span>
          <span className="text-[0.76rem] text-faint">
            {c.kind === "digital" ? "Digital" : c.kind === "physical" ? "Disc" : "In cinemas"}{" "}
            {day(c.on)} · {inDays(c.on)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function MovieRow({
  m,
  act,
  extra,
  testId,
}: {
  m: MovieItem;
  act: Propose;
  extra?: ReactNode;
  testId: string;
}) {
  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[0.86rem]"
      data-testid={testId}
      data-capture-item
      data-capture-label={name(m)}
    >
      <span className="min-w-0 flex-1">
        <span className="text-ink">{name(m)}</span>
        <span className="block text-[0.74rem] text-faint">
          {[
            m.hasFile ? (m.quality ?? m.tier) : "Not on disk",
            m.sizeBytes ? bytes(m.sizeBytes) : undefined,
            m.codec,
            m.hdr,
            m.monitored ? undefined : "not monitored",
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {extra}
      </span>
      {m.rating ? (
        <span className="inline-flex items-center gap-1 text-[0.76rem] text-muted tabular">
          <Star strokeWidth={1.5} className="h-3.5 w-3.5" /> {m.rating.toFixed(1)}
        </span>
      ) : null}
      {(!m.hasFile || m.belowCutoff) && (
        <button
          type="button"
          disabled={act.pending}
          onClick={() =>
            void act.propose(
              "app-arr-search",
              { movieId: m.movieId },
              m.hasFile ? `Search for a better copy of ${name(m)}` : `Search for ${name(m)}`,
            )
          }
          className={btn}
          data-testid="radarr-search-better"
        >
          <Search strokeWidth={1.5} className="h-3.5 w-3.5" />
          {m.hasFile ? "Search for better" : "Search"}
        </button>
      )}
    </li>
  );
}

export function UpgradeList({ lib, act }: { lib: RadarrLibrary; act: Propose }) {
  const tiers = lib.upgrades.byTier;
  const [tier, setTier] = useState<MovieTier | undefined>(
    tiers.find((t) => t.tier === "SD")?.tier ?? tiers[0]?.tier,
  );
  if (!lib.upgrades.total)
    return (
      <p className="text-[0.86rem] text-muted">
        Every movie meets the quality its profile asks for.
      </p>
    );
  const items = lib.upgrades.items.filter((m) => m.tier === tier);
  const count = tiers.find((t) => t.tier === tier)?.count ?? 0;
  const batch = items.slice(0, MAX_JOB_STEPS);
  return (
    <div className="space-y-2">
      <p className="text-[0.82rem] text-muted">
        Radarr says {n(lib.upgrades.total)} movies are below the quality their profile asks for.
        Searching all of them at once would download a lot, so pick a few: the best-rated come
        first.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          label="Quality now"
          value={tier ?? tiers[0]!.tier}
          onChange={setTier}
          options={tiers.map((t) => ({ value: t.tier, label: TIER_NAME[t.tier], count: t.count }))}
        />
        {batch.length > 1 && (
          <button
            type="button"
            disabled={act.pending}
            onClick={() =>
              void act.proposeMany(
                batch.map((m) => ({
                  kind: "app-arr-search" as const,
                  params: { movieId: m.movieId },
                })),
                `Search for better copies of ${batch.length} ${TIER_NAME[tier!]} movies`,
              )
            }
            className={btn}
            data-testid="radarr-upgrade-batch"
          >
            <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Search the top {batch.length}
          </button>
        )}
      </div>
      <ul className="divide-y divide-line" data-testid="radarr-upgrades">
        {items.map((m) => (
          <MovieRow key={m.movieId} m={m} act={act} testId="radarr-upgrade" />
        ))}
      </ul>
      {count > items.length && (
        <p className="text-[0.76rem] text-faint">
          Showing the {items.length} best-rated of {n(count)}. Find any movie by name in Find.
        </p>
      )}
    </div>
  );
}

export function CollectionList({ lib, act }: { lib: RadarrLibrary; act: Propose }) {
  const [find, setFind] = useState("");
  const [all, setAll] = useState(false);
  const q = find.trim().toLowerCase();
  const shown = lib.collections.filter(
    (c) =>
      !q ||
      c.title.toLowerCase().includes(q) ||
      c.missing.some((m) => m.title.toLowerCase().includes(q)),
  );
  const page = all || q ? shown : shown.slice(0, 40);
  if (!lib.collections.length)
    return (
      <p className="text-[0.86rem] text-muted">
        No collection you have part of is missing a released movie.
      </p>
    );
  return (
    <div className="space-y-2">
      <input
        value={find}
        onChange={(e) => setFind(e.target.value)}
        aria-label="Find a collection or movie"
        placeholder="Find a collection or movie"
        className={cx(input, "w-full")}
      />
      <ul className="divide-y divide-line">
        {page.map((c) => (
          <li
            key={c.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 text-[0.86rem]"
            data-testid="radarr-collection"
            data-capture-item
            data-capture-label={c.title}
          >
            <span className="min-w-0 flex-1">
              <span className="text-ink">{c.title}</span>{" "}
              <span className="text-[0.76rem] text-muted tabular">
                {c.have} of {c.total}
              </span>
              <span className="block text-[0.74rem] text-faint">
                Missing:{" "}
                {c.missing.map((m) => `${name(m)}${m.released ? "" : " (not out yet)"}`).join(", ")}
              </span>
            </span>
            <button
              type="button"
              disabled={act.pending}
              onClick={() =>
                void act.propose(
                  "app-arr-add-collection",
                  { collectionId: c.id },
                  `Add the movies missing from ${c.title}`,
                )
              }
              className={btn}
              data-testid="radarr-add-collection"
              data-hearth-target="collection:add"
            >
              <FolderPlus strokeWidth={1.5} className="h-3.5 w-3.5" /> Add missing (
              {c.missing.length})
            </button>
          </li>
        ))}
      </ul>
      {(lib.collectionsTotal ?? 0) > lib.collections.length && (
        <p className="text-[0.76rem] text-faint">
          Showing the {n(lib.collections.length)} closest to complete of {n(lib.collectionsTotal!)}.
        </p>
      )}
      {!all && !q && shown.length > page.length && (
        <button type="button" className={btn} onClick={() => setAll(true)}>
          Show all {n(shown.length)}
        </button>
      )}
    </div>
  );
}

export function FindMovies({ serviceId, act }: { serviceId: string; act: Propose }) {
  const [q, setQ] = useState("");
  const deferred = useDeferredValue(q.trim());
  const r = useMovieSearch(serviceId, deferred);
  return (
    <div className="space-y-2">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Find a movie in your library"
        placeholder="Find a movie by title or year"
        className={cx(input, "w-full")}
        autoFocus
      />
      {deferred.length < 2 ? (
        <p className="text-[0.82rem] text-muted">
          Type a title to see its quality, size, and where it is.
        </p>
      ) : r.error ? (
        <p className="text-[0.82rem] text-alert">Could not search: {r.error.message}</p>
      ) : r.data && !r.data.movies.length ? (
        <p className="text-[0.82rem] text-muted">No movie in Radarr matches "{deferred}".</p>
      ) : (
        <ul className="divide-y divide-line">
          {r.data?.movies.map((m) => (
            <MovieRow
              key={m.movieId}
              testId="radarr-find"
              m={m}
              act={act}
              extra={
                m.path ? (
                  <span
                    className="block truncate font-mono text-[0.7rem] text-faint"
                    title={m.path}
                  >
                    {m.path}
                  </span>
                ) : undefined
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}
