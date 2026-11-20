import { useMemo, useState } from "react";
import { HOLD_PROFILE } from "@dragon-control/core";
import {
  ArrowLeft,
  LayoutGrid,
  List,
  RefreshCw,
  Search,
  Trash2,
  FolderSearch,
  FileSignature,
  Plus,
} from "lucide-react";
import { AddMovie } from "./RadarrAddMovie";
import type { AppViewProps } from "../../panels/registry";
import { usePanelSize } from "../../panels/size";
import { Releases } from "../InteractiveSearch";
import { cx } from "../../ui";
import { useRadarr, type MovieRow, type MovieView, type Named, type TagRef } from "./data";
import {
  AVAILABILITY,
  AskEmber,
  Check,
  EVENT_WORDS,
  Field,
  Guard,
  LoadError,
  Loading,
  Poster,
  ProposeError,
  btn,
  btnBad,
  btnGold,
  day,
  gb,
  input,
  inputAuto,
  usePropose,
  when,
} from "./common";

/**
 * Radarr's Library tab: every movie, searchable and filterable, as a list or posters; selecting
 * several changes them together; a movie opens on its own page (address "movie/<id>") with its
 * details, file, history, and everything Radarr lets you do to it. Every change is a plan step
 * shown for approval here, the same step Ember would plan.
 */

type Filter = "all" | "missing" | "downloaded" | "unmonitored" | "coming";
type Sort = "title" | "year" | "added" | "size" | "rating";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "missing", label: "Missing" },
  { value: "downloaded", label: "Downloaded" },
  { value: "unmonitored", label: "Not monitored" },
  { value: "coming", label: "Not released yet" },
];
const SORTS: { value: Sort; label: string }[] = [
  { value: "title", label: "Title" },
  { value: "year", label: "Year" },
  { value: "added", label: "Recently added" },
  { value: "size", label: "Size on disk" },
  { value: "rating", label: "Rating" },
];
const PAGE = 60;

function matches(m: MovieRow, f: Filter) {
  if (f === "missing") return m.monitored && !m.hasFile && m.isAvailable;
  if (f === "downloaded") return m.hasFile;
  if (f === "unmonitored") return !m.monitored;
  if (f === "coming") return !m.isAvailable && !m.hasFile;
  return true;
}

function sorter(s: Sort) {
  return (a: MovieRow, b: MovieRow) => {
    if (s === "year")
      return (b.year ?? 0) - (a.year ?? 0) || a.sortTitle.localeCompare(b.sortTitle);
    if (s === "added") return String(b.added ?? "").localeCompare(String(a.added ?? ""));
    if (s === "size") return b.sizeOnDisk - a.sizeOnDisk;
    if (s === "rating") return (b.rating ?? 0) - (a.rating ?? 0);
    return a.sortTitle.localeCompare(b.sortTitle);
  };
}

function StateChip({ m }: { m: MovieRow }) {
  const [text, tone] = m.hasFile
    ? [m.quality ?? "Downloaded", "border-ok/40 text-ok"]
    : !m.monitored
      ? ["Not monitored", "border-line text-faint"]
      : m.isAvailable
        ? ["Missing", "border-amber/50 text-amber"]
        : ["Not released", "border-line-strong text-muted"];
  return (
    <span className={cx("shrink-0 rounded-full border px-2 py-0.5 text-[0.7rem]", tone)}>
      {text}
    </span>
  );
}

export function RadarrLibrary({ serviceId, sub, onSub }: AppViewProps) {
  const movieId = /^movie\/(\d+)$/.exec(sub ?? "")?.[1];
  if (movieId)
    return <MoviePage serviceId={serviceId} id={Number(movieId)} onBack={() => onSub?.(null)} />;
  if (sub === "add")
    return (
      <AddMovie
        serviceId={serviceId}
        onBack={() => onSub?.(null)}
        onOpen={(id) => onSub?.(`movie/${id}`)}
      />
    );
  return (
    <LibraryList
      serviceId={serviceId}
      onOpen={(id) => onSub?.(`movie/${id}`)}
      onAdd={() => onSub?.("add")}
    />
  );
}

function LibraryList({
  serviceId,
  onOpen,
  onAdd,
}: {
  serviceId: string;
  onOpen: (id: number) => void;
  onAdd: () => void;
}) {
  const size = usePanelSize();
  const q = useRadarr(serviceId, "library");
  const [text, setText] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [profile, setProfile] = useState("");
  const [tag, setTag] = useState("");
  const [sort, setSort] = useState<Sort>("title");
  const [layout, setLayout] = useState<"list" | "posters">("list");
  const [shown, setShown] = useState(PAGE);
  const [picked, setPicked] = useState<number[]>([]);

  const list = useMemo(() => {
    const movies = q.data?.movies ?? [];
    const t = text.trim().toLowerCase();
    return movies
      .filter(
        (m) =>
          (!t || m.title.toLowerCase().includes(t) || String(m.year ?? "").includes(t)) &&
          matches(m, filter) &&
          (!profile || String(m.profileId) === profile) &&
          (!tag || m.tags.includes(Number(tag))),
      )
      .sort(sorter(sort));
  }, [q.data, text, filter, profile, tag, sort]);

  if (q.isPending) return <Loading />;
  if (q.isError) return <LoadError error={q.error} />;
  const d = q.data;
  const counts = Object.fromEntries(
    FILTERS.map((f) => [f.value, d.movies.filter((m) => matches(m, f.value)).length]),
  ) as Record<Filter, number>;
  const total = d.movies.reduce((n, m) => n + m.sizeOnDisk, 0);
  const posters = layout === "posters" && size !== "compact";

  return (
    <Guard meta={d.meta} sample={d.sample}>
      <div className="space-y-3" data-testid="radarr-library">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[0.8rem] text-muted">
            {d.movies.length} movies, {counts.downloaded} on disk ({gb(total)}), {counts.missing}{" "}
            missing.
          </p>
          <button
            type="button"
            className={btnGold}
            onClick={onAdd}
            data-hearth-target="library:add"
          >
            <Plus strokeWidth={1.5} className="h-3.5 w-3.5" /> Add a movie
          </button>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1">
            <label htmlFor={`lib-q-${serviceId}`} className="sr-only">
              Search the library
            </label>
            <div className="relative">
              <Search
                strokeWidth={1.5}
                className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint"
              />
              <input
                id={`lib-q-${serviceId}`}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setShown(PAGE);
                }}
                placeholder="Search by title or year"
                className={cx(input, "pl-9")}
                data-hearth-target="library:search"
              />
            </div>
          </div>
          <select
            aria-label="Show"
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
            className={inputAuto}
            data-hearth-target="library:filter"
          >
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label} ({counts[f.value]})
              </option>
            ))}
          </select>
          {size !== "compact" && (
            <>
              <select
                aria-label="Quality profile"
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
                className={inputAuto}
                data-hearth-target="library:profile"
              >
                <option value="">Any profile</option>
                {d.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {d.tags.length > 0 && (
                <select
                  aria-label="Tag"
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                  className={inputAuto}
                  data-hearth-target="library:tag"
                >
                  <option value="">Any tag</option>
                  {d.tags.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              )}
              <select
                aria-label="Sort by"
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
                className={inputAuto}
                data-hearth-target="library:sort"
              >
                {SORTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <div role="radiogroup" aria-label="Layout" className="flex gap-1">
                {(["list", "posters"] as const).map((l) => (
                  <button
                    key={l}
                    type="button"
                    role="radio"
                    aria-checked={layout === l}
                    aria-label={l === "list" ? "List" : "Posters"}
                    onClick={() => setLayout(l)}
                    data-hearth-target={`library:layout:${l}`}
                    className={cx(
                      "flex h-10 w-10 items-center justify-center rounded-lg border",
                      layout === l
                        ? "border-gold/60 bg-gold/10 text-gold"
                        : "border-line text-muted hover:text-ink",
                    )}
                  >
                    {l === "list" ? (
                      <List strokeWidth={1.5} className="h-4 w-4" />
                    ) : (
                      <LayoutGrid strokeWidth={1.5} className="h-4 w-4" />
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {picked.length > 0 && (
          <BulkBar
            serviceId={serviceId}
            ids={picked}
            movies={d.movies}
            profiles={d.profiles}
            onDone={() => setPicked([])}
          />
        )}

        {list.length === 0 ? (
          <p className="rounded-xl border border-line px-4 py-6 text-center text-[0.86rem] text-muted">
            No movie matches.
          </p>
        ) : posters ? (
          <ul
            className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-3"
            data-testid="radarr-posters"
          >
            {list.slice(0, shown).map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => onOpen(m.id)}
                  className="group w-full text-left"
                  data-hearth-target={`library:movie:${m.id}`}
                  data-capture-item
                  data-capture-label={m.title}
                >
                  <Poster
                    serviceId={serviceId}
                    poster={m.poster}
                    title={m.title}
                    className="aspect-[2/3] w-full group-hover:border-gold/60"
                  />
                  <p className="mt-1 truncate text-[0.8rem] text-ink">{m.title}</p>
                  <p className="text-[0.72rem] text-faint">
                    {m.year} · {m.hasFile ? m.quality : m.monitored ? "Missing" : "Not monitored"}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <ul
            className="divide-y divide-line rounded-xl border border-line"
            data-testid="radarr-movies"
          >
            {list.slice(0, shown).map((m) => (
              <li
                key={m.id}
                className="flex items-center gap-2 px-2 py-1.5"
                data-capture-item
                data-capture-label={m.title}
              >
                <input
                  type="checkbox"
                  aria-label={`Select ${m.title}`}
                  checked={picked.includes(m.id)}
                  onChange={(e) =>
                    setPicked((p) =>
                      e.target.checked ? [...p, m.id] : p.filter((x) => x !== m.id),
                    )
                  }
                  className="h-4 w-4 shrink-0 accent-[var(--color-gold)]"
                />
                <button
                  type="button"
                  onClick={() => onOpen(m.id)}
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-lg px-1 text-left hover:bg-raised"
                  data-hearth-target={`library:movie:${m.id}`}
                  data-testid="radarr-movie-row"
                >
                  {size !== "compact" && (
                    <Poster
                      serviceId={serviceId}
                      poster={m.poster}
                      title={m.title}
                      className="h-12 w-8"
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.88rem] text-ink">
                      {m.title} <span className="text-faint">{m.year}</span>
                    </span>
                    {size !== "compact" && (
                      <span className="block truncate text-[0.74rem] text-faint">
                        {[
                          // A request held until the Crucible gives it its row (then it searches).
                          d.profiles.find((p) => p.id === m.profileId)?.name === HOLD_PROFILE
                            ? "Waiting for the Crucible"
                            : d.profiles.find((p) => p.id === m.profileId)?.name,
                          m.hasFile ? gb(m.sizeOnDisk) : undefined,
                          m.codec,
                          m.hdr,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    )}
                  </span>
                  <StateChip m={m} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {list.length > shown && (
          <button type="button" className={btn} onClick={() => setShown((n) => n + PAGE)}>
            Show more ({list.length - shown} left)
          </button>
        )}
      </div>
    </Guard>
  );
}

/** Several movies at once: monitor, stop monitoring, or move to one quality profile. */
function BulkBar({
  serviceId,
  ids,
  movies,
  profiles,
  onDone,
}: {
  serviceId: string;
  ids: number[];
  movies: MovieRow[];
  profiles: Named[];
  onDone: () => void;
}) {
  const act = usePropose(serviceId);
  const [profile, setProfile] = useState("");
  const chosen = movies.filter((m) => ids.includes(m.id));
  const edit = (changes: (m: MovieRow) => Record<string, unknown> | null, title: string) => {
    const steps = chosen
      .map((m) => ({ m, c: changes(m) }))
      .filter((x): x is { m: MovieRow; c: Record<string, unknown> } => x.c !== null)
      .map(({ m, c }) => ({
        kind: "app-arr-edit" as const,
        params: { resource: "movie", id: m.id, changes: JSON.stringify(c) },
      }));
    act.proposeMany(steps, title);
  };
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-xl border border-gold/40 bg-gold/[0.04] px-3 py-2"
      data-testid="radarr-bulk"
    >
      <span className="text-[0.82rem] text-ink">{ids.length} selected</span>
      <button
        type="button"
        className={btn}
        disabled={!act.can || act.busy}
        data-hearth-target="library:bulk:monitor"
        onClick={() =>
          edit(
            (m) => (m.monitored ? null : { monitored: true }),
            `Monitor ${ids.length} movies in Radarr`,
          )
        }
      >
        Monitor
      </button>
      <button
        type="button"
        className={btn}
        disabled={!act.can || act.busy}
        data-hearth-target="library:bulk:unmonitor"
        onClick={() =>
          edit(
            (m) => (m.monitored ? { monitored: false } : null),
            `Stop monitoring ${ids.length} movies in Radarr`,
          )
        }
      >
        Stop monitoring
      </button>
      <select
        aria-label="Move to quality profile"
        value={profile}
        onChange={(e) => setProfile(e.target.value)}
        className={inputAuto}
      >
        <option value="">Quality profile...</option>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={btn}
        disabled={!act.can || act.busy || !profile}
        data-hearth-target="library:bulk:profile"
        onClick={() =>
          edit(
            (m) => (String(m.profileId) === profile ? null : { qualityProfileId: Number(profile) }),
            `Move ${ids.length} movies to the "${profiles.find((p) => String(p.id) === profile)?.name}" profile`,
          )
        }
      >
        Apply profile
      </button>
      <button type="button" className={btn} onClick={onDone}>
        Clear
      </button>
      <ProposeError error={act.error} />
      {act.dialog}
    </div>
  );
}

function MoviePage({
  serviceId,
  id,
  onBack,
}: {
  serviceId: string;
  id: number;
  onBack: () => void;
}) {
  const q = useRadarr(serviceId, "movie", { id });
  if (q.isPending) return <Loading />;
  if (q.isError)
    return (
      <div className="space-y-3">
        <button type="button" className={btn} onClick={onBack}>
          <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> Library
        </button>
        <LoadError error={q.error} />
      </div>
    );
  return (
    <Guard meta={q.data.meta} sample={q.data.sample}>
      <MovieDetail serviceId={serviceId} d={q.data} onBack={onBack} />
    </Guard>
  );
}

function MovieDetail({
  serviceId,
  d,
  onBack,
}: {
  serviceId: string;
  d: MovieView;
  onBack: () => void;
}) {
  const m = d.movie;
  const act = usePropose(serviceId);
  const [releases, setReleases] = useState(false);
  const name = `${m.title}${m.year ? ` (${m.year})` : ""}`;
  const command = (command: string, words: string) =>
    act.propose("app-arr-command", { command, movieIds: String(m.id) }, `${words}: ${name}`);

  if (releases)
    return (
      <div className="space-y-3">
        <button type="button" className={btn} onClick={() => setReleases(false)}>
          <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> {m.title}
        </button>
        <Releases serviceId={serviceId} app="radarr" scope={{ movieId: m.id }} label={name} />
      </div>
    );

  return (
    <div className="space-y-4" data-testid="radarr-movie" data-hearth-target={`movie:${m.id}`}>
      <button type="button" className={btn} onClick={onBack} data-hearth-target="movie:back">
        <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> Library
      </button>
      <div className="flex gap-4">
        <Poster serviceId={serviceId} poster={m.poster} title={m.title} className="h-36 w-24" />
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="font-display text-[1.35rem] leading-tight text-ink">{m.title}</h3>
          <p className="text-[0.8rem] text-muted">
            {[m.year, m.runtime ? `${m.runtime} min` : undefined, m.certification, m.studio]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <div className="flex flex-wrap gap-1.5 pt-1">
            <StateChip m={m} />
            {m.genres.slice(0, 3).map((g) => (
              <span
                key={g}
                className="rounded-full border border-line px-2 py-0.5 text-[0.7rem] text-muted"
              >
                {g}
              </span>
            ))}
            {m.rating !== undefined && (
              <span className="rounded-full border border-line px-2 py-0.5 text-[0.7rem] text-muted">
                ★ {m.rating.toFixed(1)}
              </span>
            )}
          </div>
          {m.overview && (
            <p className="line-clamp-4 pt-1 text-[0.82rem] text-muted">{m.overview}</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={btnGold}
          disabled={!act.can || act.busy}
          data-hearth-target="movie:search"
          onClick={() => act.propose("app-arr-search", { movieId: m.id }, `Search for ${name}`)}
        >
          <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Search now
        </button>
        <button
          type="button"
          className={btn}
          disabled={d.sample}
          data-hearth-target="movie:releases"
          onClick={() => setReleases(true)}
        >
          <FolderSearch strokeWidth={1.5} className="h-3.5 w-3.5" /> Pick a release
        </button>
        <button
          type="button"
          className={btn}
          disabled={!act.can || act.busy}
          data-hearth-target="movie:refresh"
          onClick={() => command("RefreshMovie", "Refresh")}
        >
          <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" /> Refresh
        </button>
        {m.hasFile && (
          <button
            type="button"
            className={btn}
            disabled={!act.can || act.busy}
            data-hearth-target="movie:rename"
            onClick={() => command("RenameMovie", "Rename files")}
          >
            <FileSignature strokeWidth={1.5} className="h-3.5 w-3.5" /> Rename files
          </button>
        )}
        <AskEmber
          question={`Tell me about ${name} in Radarr (service ${serviceId}): its file, quality, and anything wrong.`}
        />
      </div>
      <ProposeError error={act.error} />

      <MovieEdit serviceId={serviceId} d={d} />

      <section className="space-y-2" aria-labelledby={`file-${m.id}`}>
        <h4 id={`file-${m.id}`} className="eyebrow">
          File
        </h4>
        {d.file ? (
          <div className="space-y-1 rounded-xl border border-line p-3 text-[0.82rem]">
            <p className="break-all text-ink">{d.file.path}</p>
            <p className="text-muted">
              {[d.file.quality, gb(d.file.size), d.file.video, d.file.audio]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {d.file.formats.length > 0 && (
              <p className="text-muted">
                Custom formats: {d.file.formats.join(", ")} (score {d.file.score})
              </p>
            )}
            <p className="text-faint">Added {day(d.file.added)}</p>
            <button
              type="button"
              className={btnBad}
              disabled={!act.can || act.busy}
              data-hearth-target="movie:delete-file"
              onClick={() =>
                act.propose(
                  "app-radarr-delete-file",
                  { movieId: m.id, movieFileId: d.file!.id },
                  `Delete the file of ${name}`,
                )
              }
            >
              <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Delete this file
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[0.82rem] text-muted">
              No file yet.{" "}
              {m.monitored
                ? m.isAvailable
                  ? "Radarr is looking for it."
                  : "Radarr waits until it is released."
                : "Radarr is not looking for it (not monitored)."}
            </p>
            {/* The fix right beside the reason: monitored, a released movie joins Wanted. */}
            {!m.monitored && (
              <button
                type="button"
                className={btn}
                disabled={!act.can || act.busy}
                data-hearth-target="movie:monitor"
                data-testid="radarr-movie-monitor"
                onClick={() =>
                  act.propose(
                    "app-radarr-set-monitored",
                    { movieId: m.id, monitored: true },
                    `Monitor ${name} in Radarr`,
                  )
                }
              >
                Monitor
              </button>
            )}
          </div>
        )}
      </section>

      <section className="space-y-2" aria-labelledby={`hist-${m.id}`}>
        <h4 id={`hist-${m.id}`} className="eyebrow">
          History
        </h4>
        {d.history.length === 0 ? (
          <p className="text-[0.82rem] text-muted">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line text-[0.8rem]">
            {d.history.map((h) => (
              <li key={h.id} className="px-3 py-2">
                <p className="text-ink">
                  {EVENT_WORDS[h.event] ?? h.event}
                  <span className="ml-2 text-faint">{when(h.date)}</span>
                </p>
                <p className="break-all text-muted">
                  {[h.release, h.quality, h.indexer, h.message].filter(Boolean).join(" · ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <RemoveMovie serviceId={serviceId} id={m.id} name={name} hasFile={m.hasFile} />
      {act.dialog}
    </div>
  );
}

/** Monitoring, quality profile, minimum availability and tags, changed together in one plan. */
function MovieEdit({ serviceId, d }: { serviceId: string; d: MovieView }) {
  const m = d.movie;
  const act = usePropose(serviceId);
  const [monitored, setMonitored] = useState(m.monitored);
  const [profile, setProfile] = useState(String(m.profileId ?? ""));
  const [avail, setAvail] = useState(m.minimumAvailability ?? "released");
  const [tags, setTags] = useState<number[]>(m.tags);
  const changes: Record<string, unknown> = {};
  if (monitored !== m.monitored) changes.monitored = monitored;
  if (profile && Number(profile) !== m.profileId) changes.qualityProfileId = Number(profile);
  if (avail !== m.minimumAvailability) changes.minimumAvailability = avail;
  const sortedNow = [...m.tags].sort().join(",");
  if ([...tags].sort().join(",") !== sortedNow) changes.tags = tags;
  const dirty = Object.keys(changes).length > 0;
  const name = `${m.title}${m.year ? ` (${m.year})` : ""}`;
  return (
    <section
      className="space-y-3 rounded-xl border border-line p-3"
      aria-labelledby={`edit-${m.id}`}
    >
      <h4 id={`edit-${m.id}`} className="eyebrow">
        Settings
      </h4>
      <Check
        checked={monitored}
        onChange={setMonitored}
        target="movie:monitored"
        label={
          <span>
            Monitored <span className="text-faint">(Radarr looks for it and its upgrades)</span>
          </span>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Quality profile" htmlFor={`prof-${m.id}`}>
          <select
            id={`prof-${m.id}`}
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            className={input}
            data-hearth-target="movie:profile"
          >
            {d.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Minimum availability"
          htmlFor={`avail-${m.id}`}
          hint="When Radarr starts looking."
        >
          <select
            id={`avail-${m.id}`}
            value={avail}
            onChange={(e) => setAvail(e.target.value)}
            className={input}
            data-hearth-target="movie:availability"
          >
            {AVAILABILITY.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {d.tags.length > 0 && (
        <fieldset className="space-y-1">
          <legend className="text-[0.8rem] text-muted">Tags</legend>
          <div className="flex flex-wrap gap-x-4" data-hearth-target="movie:tags">
            {d.tags.map((t: TagRef) => (
              <Check
                key={t.id}
                checked={tags.includes(t.id)}
                onChange={(on) => setTags((x) => (on ? [...x, t.id] : x.filter((y) => y !== t.id)))}
                label={t.label}
              />
            ))}
          </div>
        </fieldset>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={btnGold}
          disabled={!dirty || !act.can || act.busy}
          data-hearth-target="movie:save"
          onClick={() =>
            act.propose(
              "app-arr-edit",
              { resource: "movie", id: m.id, changes: JSON.stringify(changes) },
              `Change ${name} in Radarr`,
            )
          }
        >
          Review change
        </button>
        {dirty && (
          <span className="text-[0.76rem] text-faint">You approve the exact change next.</span>
        )}
      </div>
      <ProposeError error={act.error} />
      {act.dialog}
    </section>
  );
}

function RemoveMovie({
  serviceId,
  id,
  name,
  hasFile,
}: {
  serviceId: string;
  id: number;
  name: string;
  hasFile: boolean;
}) {
  const act = usePropose(serviceId);
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState(false);
  const [exclude, setExclude] = useState(false);
  return (
    <section className="space-y-2 border-t border-line pt-3">
      {!open ? (
        <button
          type="button"
          className={btnBad}
          disabled={!act.can}
          data-hearth-target="movie:remove"
          onClick={() => setOpen(true)}
        >
          <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove from Radarr...
        </button>
      ) : (
        <div className="space-y-2 rounded-xl border border-alert/40 p-3">
          <p className="text-[0.84rem] text-ink">Remove {name} from Radarr?</p>
          {hasFile && (
            <Check
              checked={files}
              onChange={setFiles}
              target="movie:remove:files"
              label="Also delete its files from disk"
            />
          )}
          <Check
            checked={exclude}
            onChange={setExclude}
            target="movie:remove:exclude"
            label="Stop import lists adding it again"
          />
          <div className="flex gap-2">
            <button
              type="button"
              className={btnBad}
              disabled={act.busy}
              data-hearth-target="movie:remove:confirm"
              onClick={() =>
                act.propose(
                  "app-arr-delete",
                  { resource: "movie", id, deleteFiles: files, addImportExclusion: exclude },
                  `Remove ${name} from Radarr${files ? " with its files" : ""}`,
                )
              }
            >
              Review removal
            </button>
            <button type="button" className={btn} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <ProposeError error={act.error} />
      {act.dialog}
    </section>
  );
}
