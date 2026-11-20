import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  FileSignature,
  FolderSearch,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import type { AppViewProps } from "../../panels/registry";
import { usePanelSize } from "../../panels/size";
import { Releases } from "../InteractiveSearch";
import { cx } from "../../ui";
import type { ReleaseScope } from "@dragon-control/core";
import {
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
  gb,
  input,
  inputAuto,
  usePropose,
  when,
} from "../radarr/common";
import { airDay, useSonarr, type SeriesRow, type SeriesView, type ShowLookupView } from "./data";

/**
 * Sonarr's Library tab: every series, searchable and filterable; a series opens on its own page
 * (address "series/<id>") with its settings, seasons and episodes (monitoring, search, files),
 * history and removal; "add" finds a show through Sonarr's own search. Every change is a plan step
 * shown for approval, the same step Ember plans.
 */

type Filter = "all" | "missing" | "complete" | "continuing" | "ended" | "unmonitored";
type Sort = "title" | "added" | "size" | "next";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "missing", label: "Missing episodes" },
  { value: "complete", label: "Complete" },
  { value: "continuing", label: "Still airing" },
  { value: "ended", label: "Ended" },
  { value: "unmonitored", label: "Not monitored" },
];
const SORTS: { value: Sort; label: string }[] = [
  { value: "title", label: "Title" },
  { value: "next", label: "Next episode" },
  { value: "added", label: "Recently added" },
  { value: "size", label: "Size on disk" },
];
const TYPES = [
  { value: "standard", label: "Standard (S01E01)" },
  { value: "daily", label: "Daily (by air date)" },
  { value: "anime", label: "Anime (absolute numbers)" },
];
const NEW_SEASONS = [
  { value: "all", label: "Monitor new seasons" },
  { value: "none", label: "Leave new seasons unmonitored" },
];

function matches(s: SeriesRow, f: Filter) {
  if (f === "missing") return s.monitored && s.episodeFiles < s.episodes;
  if (f === "complete") return s.episodes > 0 && s.episodeFiles >= s.episodes;
  if (f === "continuing") return s.status === "continuing" || s.status === "upcoming";
  if (f === "ended") return s.status === "ended";
  if (f === "unmonitored") return !s.monitored;
  return true;
}

function sorter(s: Sort) {
  return (a: SeriesRow, b: SeriesRow) => {
    if (s === "added") return String(b.added ?? "").localeCompare(String(a.added ?? ""));
    if (s === "size") return b.sizeOnDisk - a.sizeOnDisk;
    if (s === "next")
      return String(a.nextAiring ?? "9999").localeCompare(String(b.nextAiring ?? "9999"));
    return a.sortTitle.localeCompare(b.sortTitle);
  };
}

function Progress({ s }: { s: Pick<SeriesRow, "episodeFiles" | "episodes" | "monitored"> }) {
  const pct = s.episodes ? Math.round((s.episodeFiles / s.episodes) * 100) : 0;
  const tone = !s.monitored ? "bg-line-strong" : pct >= 100 ? "bg-ok" : "bg-amber";
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-line" aria-hidden="true">
        <span className={cx("block h-full", tone)} style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      <span className="text-[0.72rem] text-faint tabular">
        {s.episodeFiles}/{s.episodes}
      </span>
    </span>
  );
}

export function SonarrLibrary({ serviceId, sub, onSub }: AppViewProps) {
  const seriesId = /^series\/(\d+)$/.exec(sub ?? "")?.[1];
  if (seriesId)
    return <SeriesPage serviceId={serviceId} id={Number(seriesId)} onBack={() => onSub?.(null)} />;
  if (sub === "add")
    return (
      <AddShow
        serviceId={serviceId}
        onBack={() => onSub?.(null)}
        onOpen={(id) => onSub?.(`series/${id}`)}
      />
    );
  return (
    <SeriesList
      serviceId={serviceId}
      onOpen={(id) => onSub?.(`series/${id}`)}
      onAdd={() => onSub?.("add")}
    />
  );
}

function SeriesList({
  serviceId,
  onOpen,
  onAdd,
}: {
  serviceId: string;
  onOpen: (id: number) => void;
  onAdd: () => void;
}) {
  const size = usePanelSize();
  const q = useSonarr(serviceId, "library");
  const [text, setText] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [profile, setProfile] = useState("");
  const [sort, setSort] = useState<Sort>("title");
  const list = useMemo(() => {
    const all = q.data?.series ?? [];
    const t = text.trim().toLowerCase();
    return all
      .filter(
        (s) =>
          (!t ||
            s.title.toLowerCase().includes(t) ||
            (s.network ?? "").toLowerCase().includes(t)) &&
          matches(s, filter) &&
          (!profile || String(s.profileId) === profile),
      )
      .sort(sorter(sort));
  }, [q.data, text, filter, profile, sort]);
  if (q.isPending) return <Loading />;
  if (q.isError) return <LoadError error={q.error} />;
  const d = q.data;
  const counts = Object.fromEntries(
    FILTERS.map((f) => [f.value, d.series.filter((s) => matches(s, f.value)).length]),
  ) as Record<Filter, number>;
  const total = d.series.reduce((n, s) => n + s.sizeOnDisk, 0);
  const files = d.series.reduce((n, s) => n + s.episodeFiles, 0);
  return (
    <Guard meta={d.meta} sample={d.sample}>
      <div className="space-y-3" data-testid="sonarr-library">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[0.8rem] text-muted">
            {d.series.length} series, {files} episodes on disk ({gb(total)}), {counts.missing} with
            missing episodes.
          </p>
          <button
            type="button"
            className={btnGold}
            onClick={onAdd}
            data-hearth-target="library:add"
          >
            <Plus strokeWidth={1.5} className="h-3.5 w-3.5" /> Add a show
          </button>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1">
            <label htmlFor={`slib-q-${serviceId}`} className="sr-only">
              Search the library
            </label>
            <div className="relative">
              <Search
                strokeWidth={1.5}
                className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint"
              />
              <input
                id={`slib-q-${serviceId}`}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Search by title or network"
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
            </>
          )}
        </div>
        {list.length === 0 ? (
          <p className="rounded-xl border border-line px-4 py-6 text-center text-[0.86rem] text-muted">
            No series matches.
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {list.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onOpen(s.id)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-raised"
                  data-testid="sonarr-series-row"
                  data-hearth-target={`library:series:${s.id}`}
                  data-capture-item
                  data-capture-label={s.title}
                >
                  <Poster
                    serviceId={serviceId}
                    poster={s.poster}
                    title={s.title}
                    className="h-12 w-8"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.88rem] text-ink">
                      {s.title} <span className="text-faint">{s.year}</span>
                    </span>
                    <span className="block truncate text-[0.74rem] text-faint">
                      {[
                        s.network,
                        `${s.seasons} season${s.seasons === 1 ? "" : "s"}`,
                        s.status === "ended"
                          ? "Ended"
                          : s.nextAiring
                            ? `Next ${airDay(s.nextAiring)}`
                            : "Airing",
                        s.monitored ? undefined : "Not monitored",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <Progress s={s} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Guard>
  );
}

function SeriesPage({
  serviceId,
  id,
  onBack,
}: {
  serviceId: string;
  id: number;
  onBack: () => void;
}) {
  const q = useSonarr(serviceId, "series", { id });
  if (q.isPending) return <Loading />;
  if (q.isError)
    return (
      <div className="space-y-2">
        <button type="button" className={btn} onClick={onBack}>
          <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> Library
        </button>
        <LoadError error={q.error} />
      </div>
    );
  return (
    <Guard meta={q.data.meta} sample={q.data.sample}>
      <SeriesDetail serviceId={serviceId} d={q.data} onBack={onBack} />
    </Guard>
  );
}

function SeriesDetail({
  serviceId,
  d,
  onBack,
}: {
  serviceId: string;
  d: SeriesView;
  onBack: () => void;
}) {
  const s = d.series;
  const act = usePropose(serviceId);
  const [releases, setReleases] = useState<{ scope: ReleaseScope; label: string }>();
  const name = `${s.title}${s.year ? ` (${s.year})` : ""}`;
  const command = (command: string, words: string) =>
    act.propose("app-arr-command", { command, seriesId: s.id }, `${words}: ${name}`);
  if (releases)
    return (
      <div className="space-y-3">
        <button type="button" className={btn} onClick={() => setReleases(undefined)}>
          <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> {s.title}
        </button>
        <Releases
          serviceId={serviceId}
          app="sonarr"
          scope={releases.scope}
          label={releases.label}
        />
      </div>
    );
  return (
    <div className="space-y-4" data-testid="sonarr-series" data-hearth-target={`series:${s.id}`}>
      <button type="button" className={btn} onClick={onBack} data-hearth-target="series:back">
        <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> Library
      </button>
      <div className="flex gap-4">
        <Poster serviceId={serviceId} poster={s.poster} title={s.title} className="h-36 w-24" />
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="font-display text-[1.35rem] leading-tight text-ink">{s.title}</h3>
          <p className="text-[0.8rem] text-muted">
            {[
              s.year,
              s.network,
              s.status === "ended" ? "Ended" : "Still airing",
              `${s.seasons} seasons`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <div className="pt-1">
            <Progress s={s} />
          </div>
          {s.overview && (
            <p className="line-clamp-4 pt-1 text-[0.82rem] text-muted">{s.overview}</p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={btnGold}
          disabled={!act.can || act.busy}
          data-hearth-target="series:search"
          onClick={() => command("SeriesSearch", "Search for every missing episode")}
        >
          <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Search missing
        </button>
        <button
          type="button"
          className={btn}
          disabled={!act.can || act.busy}
          data-hearth-target="series:refresh"
          onClick={() => command("RefreshSeries", "Refresh")}
        >
          <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" /> Refresh
        </button>
        {s.episodeFiles > 0 && (
          <button
            type="button"
            className={btn}
            disabled={!act.can || act.busy}
            data-hearth-target="series:rename"
            onClick={() => command("RenameSeries", "Rename files")}
          >
            <FileSignature strokeWidth={1.5} className="h-3.5 w-3.5" /> Rename files
          </button>
        )}
        <AskEmber
          question={`Tell me about ${name} in Sonarr (service ${serviceId}): its seasons, missing episodes, and anything wrong.`}
        />
      </div>
      <ProposeError error={act.error} />
      <SeriesEdit serviceId={serviceId} d={d} />
      <Seasons
        serviceId={serviceId}
        d={d}
        onReleases={(scope, label) => setReleases({ scope, label })}
      />
      <section className="space-y-2" aria-labelledby={`shist-${s.id}`}>
        <h4 id={`shist-${s.id}`} className="eyebrow">
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
                  {h.episode && <span className="ml-2 text-gold">{h.episode}</span>}
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
      <RemoveSeries serviceId={serviceId} id={s.id} name={name} files={s.episodeFiles} />
      {act.dialog}
    </div>
  );
}

/** Monitoring, quality profile, series type, season folders, new seasons and tags in one plan. */
function SeriesEdit({ serviceId, d }: { serviceId: string; d: SeriesView }) {
  const s = d.series;
  const act = usePropose(serviceId);
  const [monitored, setMonitored] = useState(s.monitored);
  const [profile, setProfile] = useState(String(s.profileId ?? ""));
  const [type, setType] = useState(s.seriesType);
  const [folders, setFolders] = useState(s.seasonFolder);
  const [newSeasons, setNewSeasons] = useState(s.monitorNewItems ?? "all");
  const [tags, setTags] = useState<number[]>(s.tags);
  const changes: Record<string, unknown> = {};
  if (monitored !== s.monitored) changes.monitored = monitored;
  if (profile && Number(profile) !== s.profileId) changes.qualityProfileId = Number(profile);
  if (type !== s.seriesType) changes.seriesType = type;
  if (folders !== s.seasonFolder) changes.seasonFolder = folders;
  if (s.monitorNewItems && newSeasons !== s.monitorNewItems) changes.monitorNewItems = newSeasons;
  if ([...tags].sort().join(",") !== [...s.tags].sort().join(",")) changes.tags = tags;
  const dirty = Object.keys(changes).length > 0;
  const name = `${s.title}${s.year ? ` (${s.year})` : ""}`;
  return (
    <section
      className="space-y-3 rounded-xl border border-line p-3"
      aria-labelledby={`sedit-${s.id}`}
    >
      <h4 id={`sedit-${s.id}`} className="eyebrow">
        Settings
      </h4>
      <Check
        checked={monitored}
        onChange={setMonitored}
        target="series:monitored"
        label={
          <span>
            Monitored <span className="text-faint">(Sonarr looks for its monitored episodes)</span>
          </span>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Quality profile" htmlFor={`sprof-${s.id}`}>
          <select
            id={`sprof-${s.id}`}
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            className={input}
            data-hearth-target="series:profile"
          >
            {d.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Series type" htmlFor={`stype-${s.id}`} hint="How episodes are numbered.">
          <select
            id={`stype-${s.id}`}
            value={type}
            onChange={(e) => setType(e.target.value)}
            className={input}
            data-hearth-target="series:type"
          >
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        {s.monitorNewItems && (
          <Field label="New seasons" htmlFor={`snew-${s.id}`}>
            <select
              id={`snew-${s.id}`}
              value={newSeasons}
              onChange={(e) => setNewSeasons(e.target.value)}
              className={input}
              data-hearth-target="series:new-seasons"
            >
              {NEW_SEASONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <Check
        checked={folders}
        onChange={setFolders}
        target="series:season-folders"
        label="Season folders"
      />
      {d.tags.length > 0 && (
        <fieldset className="space-y-1">
          <legend className="text-[0.8rem] text-muted">Tags</legend>
          <div className="flex flex-wrap gap-x-4" data-hearth-target="series:tags">
            {d.tags.map((t) => (
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
          data-hearth-target="series:save"
          onClick={() =>
            act.propose(
              "app-arr-edit",
              { resource: "series", id: s.id, changes: JSON.stringify(changes) },
              `Change ${name} in Sonarr`,
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

/** Seasons with their monitoring (one plan for all changes), search, and episodes when opened. */
function Seasons({
  serviceId,
  d,
  onReleases,
}: {
  serviceId: string;
  d: SeriesView;
  onReleases: (scope: ReleaseScope, label: string) => void;
}) {
  const s = d.series;
  const act = usePropose(serviceId);
  const [on, setOn] = useState<number[]>(d.seasons.filter((x) => x.monitored).map((x) => x.number));
  const [open, setOpen] = useState<number | undefined>(d.seasons.find((x) => x.number > 0)?.number);
  const now = d.seasons
    .filter((x) => x.monitored)
    .map((x) => x.number)
    .sort((a, b) => a - b);
  const want = [...on].sort((a, b) => a - b);
  const dirty = now.join(",") !== want.join(",");
  const name = `${s.title}${s.year ? ` (${s.year})` : ""}`;
  return (
    <section className="space-y-2" aria-labelledby={`seasons-${s.id}`} data-testid="sonarr-seasons">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={`seasons-${s.id}`} className="eyebrow">
          Seasons
        </h4>
        {dirty && (
          <button
            type="button"
            className={btnGold}
            disabled={!act.can || act.busy}
            data-hearth-target="seasons:save"
            onClick={() =>
              act.propose(
                "app-arr-edit",
                {
                  resource: "series",
                  id: s.id,
                  changes: JSON.stringify({ monitoredSeasons: want }),
                },
                `Change which seasons of ${name} Sonarr monitors`,
              )
            }
          >
            Review season monitoring
          </button>
        )}
      </div>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {d.seasons.map((season) => {
          const label = season.number === 0 ? "Specials" : `Season ${season.number}`;
          const eps = d.episodes.filter((e) => e.season === season.number);
          return (
            <li key={season.number} data-testid="sonarr-season">
              <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  aria-expanded={open === season.number}
                  onClick={() => setOpen(open === season.number ? undefined : season.number)}
                  data-hearth-target={`season:${season.number}:open`}
                >
                  {open === season.number ? (
                    <ChevronDown strokeWidth={1.5} className="h-4 w-4 text-faint" />
                  ) : (
                    <ChevronRight strokeWidth={1.5} className="h-4 w-4 text-faint" />
                  )}
                  <span className="text-[0.88rem] text-ink">{label}</span>
                  <Progress
                    s={{
                      episodeFiles: season.files,
                      episodes: season.episodes,
                      monitored: season.monitored,
                    }}
                  />
                  <span className="text-[0.72rem] text-faint">
                    {season.size ? gb(season.size) : ""}
                  </span>
                </button>
                <Check
                  checked={on.includes(season.number)}
                  onChange={(v) =>
                    setOn((x) => (v ? [...x, season.number] : x.filter((n) => n !== season.number)))
                  }
                  target={`season:${season.number}:monitored`}
                  label="Monitored"
                />
                <button
                  type="button"
                  className={btn}
                  disabled={!act.can || act.busy}
                  data-hearth-target={`season:${season.number}:search`}
                  onClick={() =>
                    act.propose(
                      "app-arr-command",
                      { command: "SeasonSearch", seriesId: s.id, seasonNumber: season.number },
                      `Search for ${name}, ${label.toLowerCase()}`,
                    )
                  }
                >
                  <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Search
                </button>
                <button
                  type="button"
                  className={btn}
                  disabled={d.sample}
                  data-hearth-target={`season:${season.number}:releases`}
                  onClick={() =>
                    onReleases({ seriesId: s.id, seasonNumber: season.number }, `${name}, ${label}`)
                  }
                >
                  <FolderSearch strokeWidth={1.5} className="h-3.5 w-3.5" /> Pick a release
                </button>
              </div>
              {open === season.number && (
                <ul className="divide-y divide-line border-t border-line bg-raised/40 text-[0.8rem]">
                  {eps.map((e) => (
                    <Episode
                      key={e.id}
                      serviceId={serviceId}
                      e={e}
                      show={name}
                      onReleases={onReleases}
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      <ProposeError error={act.error} />
      {act.dialog}
    </section>
  );
}

function Episode({
  serviceId,
  e,
  show,
  onReleases,
}: {
  serviceId: string;
  e: SeriesView["episodes"][number];
  show: string;
  onReleases: (scope: ReleaseScope, label: string) => void;
}) {
  const act = usePropose(serviceId);
  const label = `${show} ${e.code}`;
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-1.5" data-testid="sonarr-episode">
      <span className="w-14 shrink-0 text-gold tabular">{e.code}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ink">{e.title || "(no title yet)"}</span>
        <span className="block truncate text-faint">
          {[
            airDay(e.airDate),
            e.hasFile ? `${e.quality ?? "On disk"}${e.size ? ` · ${gb(e.size)}` : ""}` : "No file",
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
      <button
        type="button"
        className={cx(btn, "min-h-8")}
        disabled={!act.can || act.busy}
        aria-pressed={e.monitored}
        data-hearth-target={`episode:${e.id}:monitored`}
        onClick={() =>
          act.propose(
            "app-arr-edit",
            { resource: "episode", id: e.id, changes: JSON.stringify({ monitored: !e.monitored }) },
            `${e.monitored ? "Stop monitoring" : "Monitor"} ${label}`,
          )
        }
      >
        {e.monitored ? "Monitored" : "Not monitored"}
      </button>
      <button
        type="button"
        className={cx(btn, "min-h-8")}
        disabled={!act.can || act.busy}
        aria-label={`Search for ${label}`}
        data-hearth-target={`episode:${e.id}:search`}
        onClick={() =>
          act.propose(
            "app-arr-command",
            { command: "EpisodeSearch", episodeIds: String(e.id) },
            `Search for ${label}`,
          )
        }
      >
        <Search strokeWidth={1.5} className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className={cx(btn, "min-h-8")}
        aria-label={`Pick a release for ${label}`}
        data-hearth-target={`episode:${e.id}:releases`}
        onClick={() => onReleases({ episodeId: e.id }, label)}
      >
        <FolderSearch strokeWidth={1.5} className="h-3.5 w-3.5" />
      </button>
      {e.hasFile && e.fileId && (
        <button
          type="button"
          className={cx(btnBad, "min-h-8")}
          disabled={!act.can || act.busy}
          aria-label={`Delete the file of ${label}`}
          data-hearth-target={`episode:${e.id}:delete-file`}
          onClick={() =>
            act.propose(
              "app-sonarr-delete-file",
              { episodeFileId: e.fileId! },
              `Delete the file of ${label}`,
            )
          }
        >
          <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" />
        </button>
      )}
      {act.dialog}
    </li>
  );
}

function RemoveSeries({
  serviceId,
  id,
  name,
  files,
}: {
  serviceId: string;
  id: number;
  name: string;
  files: number;
}) {
  const act = usePropose(serviceId);
  const [open, setOpen] = useState(false);
  const [del, setDel] = useState(false);
  const [exclude, setExclude] = useState(false);
  return (
    <section className="space-y-2 border-t border-line pt-3">
      {!open ? (
        <button
          type="button"
          className={btnBad}
          disabled={!act.can}
          data-hearth-target="series:remove"
          onClick={() => setOpen(true)}
        >
          <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove from Sonarr...
        </button>
      ) : (
        <div className="space-y-2 rounded-xl border border-alert/40 p-3">
          <p className="text-[0.84rem] text-ink">Remove {name} from Sonarr?</p>
          {files > 0 && (
            <Check
              checked={del}
              onChange={setDel}
              target="series:remove:files"
              label={`Also delete its ${files} episode files from disk`}
            />
          )}
          <Check
            checked={exclude}
            onChange={setExclude}
            target="series:remove:exclude"
            label="Stop import lists adding it again"
          />
          <div className="flex gap-2">
            <button
              type="button"
              className={btnBad}
              disabled={act.busy}
              data-hearth-target="series:remove:confirm"
              onClick={() =>
                act.propose(
                  "app-arr-delete",
                  { resource: "series", id, deleteFiles: del, addImportExclusion: exclude },
                  `Remove ${name} from Sonarr${del ? " with its files" : ""}`,
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

/* ---------- Add a show ---------- */

const MONITOR = [
  { value: "all", label: "Every episode" },
  { value: "future", label: "Future episodes only" },
  { value: "missing", label: "Missing episodes" },
  { value: "existing", label: "Episodes I already have" },
  { value: "firstSeason", label: "The first season" },
  { value: "lastSeason", label: "The latest season" },
  { value: "pilot", label: "Just the first episode" },
  { value: "none", label: "Nothing for now" },
];

function AddShow({
  serviceId,
  onBack,
  onOpen,
}: {
  serviceId: string;
  onBack: () => void;
  onOpen: (id: number) => void;
}) {
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  const q = useSonarr(serviceId, "lookup", { title: term }, term.length > 0);
  const [pick, setPick] = useState<ShowLookupView["results"][number]>();
  return (
    <div className="space-y-3" data-testid="sonarr-add">
      <button type="button" className={btn} onClick={onBack}>
        <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> Library
      </button>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPick(undefined);
          setTerm(text.trim());
        }}
      >
        <label className="sr-only" htmlFor={`sadd-q-${serviceId}`}>
          Show to add
        </label>
        <input
          id={`sadd-q-${serviceId}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Show title"
          className={cx(input, "flex-1")}
          data-hearth-target="add:search"
        />
        <button type="submit" className={btn} disabled={!text.trim()}>
          <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Find
        </button>
      </form>
      {q.isFetching && !q.data && <p className="text-[0.82rem] text-faint">Asking Sonarr...</p>}
      {q.isError && <LoadError error={q.error} />}
      {q.data && (
        <Guard meta={q.data.meta} sample={q.data.sample}>
          {pick ? (
            <AddForm
              serviceId={serviceId}
              d={q.data}
              pick={pick}
              onCancel={() => setPick(undefined)}
            />
          ) : q.data.results.length === 0 ? (
            <p className="text-[0.84rem] text-muted">
              Sonarr found nothing for &ldquo;{term}&rdquo;.
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {q.data.results.map((r) => (
                <li
                  key={r.tvdbId}
                  className="flex items-center gap-3 px-3 py-2"
                  data-testid="sonarr-lookup"
                >
                  <Poster
                    serviceId={serviceId}
                    poster={r.poster}
                    title={r.title}
                    className="h-14 w-10"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-[0.88rem] text-ink">
                      {r.title} <span className="text-faint">{r.year}</span>
                    </p>
                    <p className="truncate text-[0.74rem] text-faint">
                      {[r.network, r.seasons ? `${r.seasons} seasons` : undefined]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {r.overview && (
                      <p className="line-clamp-2 text-[0.74rem] text-faint">{r.overview}</p>
                    )}
                  </div>
                  {r.inLibrary ? (
                    <button
                      type="button"
                      className={btn}
                      onClick={() => r.libraryId && onOpen(r.libraryId)}
                    >
                      In your library
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={btnGold}
                      onClick={() => setPick(r)}
                      data-hearth-target={`add:pick:${r.tvdbId}`}
                    >
                      <Plus strokeWidth={1.5} className="h-3.5 w-3.5" /> Add
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Guard>
      )}
    </div>
  );
}

function AddForm({
  serviceId,
  d,
  pick,
  onCancel,
}: {
  serviceId: string;
  d: ShowLookupView;
  pick: ShowLookupView["results"][number];
  onCancel: () => void;
}) {
  const act = usePropose(serviceId);
  const [root, setRoot] = useState(d.rootFolders[0]?.path ?? "");
  const [profile, setProfile] = useState(String(d.profiles[0]?.id ?? ""));
  const [monitor, setMonitor] = useState("all");
  const [type, setType] = useState("standard");
  const [folders, setFolders] = useState(true);
  const [search, setSearch] = useState(true);
  const [tags, setTags] = useState<number[]>([]);
  const name = `${pick.title}${pick.year ? ` (${pick.year})` : ""}`;
  return (
    <div className="space-y-3 rounded-xl border border-gold/40 p-3" data-testid="sonarr-add-form">
      <p className="text-[0.92rem] text-ink">Add {name}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Root folder" htmlFor="sadd-root">
          <select
            id="sadd-root"
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            className={input}
          >
            {d.rootFolders.map((r) => (
              <option key={r.path} value={r.path}>
                {r.path}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Quality profile" htmlFor="sadd-profile">
          <select
            id="sadd-profile"
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            className={input}
          >
            {d.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Monitor" htmlFor="sadd-monitor" hint="Which episodes Sonarr looks for.">
          <select
            id="sadd-monitor"
            value={monitor}
            onChange={(e) => setMonitor(e.target.value)}
            className={input}
          >
            {MONITOR.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Series type" htmlFor="sadd-type">
          <select
            id="sadd-type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            className={input}
          >
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Check checked={folders} onChange={setFolders} label="Season folders" />
      <Check
        checked={search && monitor !== "none"}
        onChange={setSearch}
        label="Search for missing episodes as soon as it is added"
      />
      {d.tags.length > 0 && (
        <div className="flex flex-wrap gap-x-4">
          {d.tags.map((t) => (
            <Check
              key={t.id}
              checked={tags.includes(t.id)}
              onChange={(on) => setTags((x) => (on ? [...x, t.id] : x.filter((y) => y !== t.id)))}
              label={t.label}
            />
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className={btnGold}
          disabled={!act.can || act.busy || !root || !profile}
          data-hearth-target="add:review"
          onClick={() =>
            act.propose(
              "app-arr-create",
              {
                resource: "series",
                body: JSON.stringify({
                  tvdbId: pick.tvdbId,
                  qualityProfileId: Number(profile),
                  rootFolderPath: root,
                  monitor,
                  seriesType: type,
                  seasonFolder: folders,
                  tags,
                  searchForMissingEpisodes: search && monitor !== "none",
                }),
              },
              `Add ${name} to Sonarr`,
            )
          }
        >
          Review
        </button>
        <button type="button" className={btn} onClick={onCancel}>
          Back to results
        </button>
      </div>
      <ProposeError error={act.error} />
      {act.dialog}
    </div>
  );
}
