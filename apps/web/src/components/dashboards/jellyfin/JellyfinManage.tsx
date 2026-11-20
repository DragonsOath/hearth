import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Download,
  Film,
  FolderPlus,
  Music,
  Power,
  RefreshCw,
  Search,
  Trash2,
  Tv,
} from "lucide-react";
import { Link } from "react-router";
import { api } from "../../../data/api";
import { usePanelHref } from "../../desk/links";
import { PlanMovieNightButton } from "../../notify/PlanMovieNight";
import { ago } from "../../../lib/format";
import type { AppViewProps } from "../../panels/registry";
import { ApproveDialog, useApproveHere } from "../../jobs/ApproveHere";
import { Button, Skeleton, cx } from "../../ui";
import { useServerWord } from "./brand";
import { MakePlaylist } from "../../music/MakePlaylist";

/**
 * Jellyfin's panel as Plex's (11-04): Library (browse, search, a title's details and files,
 * watched, edits, a refresh), Manage (libraries and their folders, scans), Plugins (installed,
 * updates, the catalog, enable, disable, remove, restart) and Settings (everyday server and
 * playback settings). Every change is a plan you approve right here, read back from Jellyfin.
 */

const KIND = "app-jellyfin-control";

function useJf<T>(
  serviceId: string,
  view: string,
  q: Record<string, string | number | undefined> = {},
  enabled = true,
) {
  const params = new URLSearchParams(
    Object.entries(q)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  return useQuery({
    // Under "dashboard": a finished plan refreshes it with the rest of the panel.
    queryKey: ["dashboard", serviceId, "jellyfin", view, params],
    queryFn: () =>
      api<T & { sample?: boolean }>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/jellyfin/${view}${params ? `?${params}` : ""}`,
      ),
    enabled,
    staleTime: 20_000,
    // A new search keeps showing the last results until the new ones come, so the page (and
    // the search box you are typing in) stays put (11-07: it lost the box every letter).
    placeholderData: keepPreviousData,
  });
}

const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.78rem] text-muted hover:border-gold/50 hover:text-ink disabled:opacity-50";
const input =
  "min-h-9 rounded-lg border border-line bg-raised px-2.5 text-[0.84rem] text-ink placeholder:text-faint";

function Poster({
  serviceId,
  id,
  title,
  type,
  has,
}: {
  serviceId: string;
  id: string;
  title: string;
  type?: string;
  has: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const Icon =
    type === "series" || type === "season" ? Tv : type?.startsWith("music") ? Music : Film;
  if (!has || failed)
    return (
      <div className="flex aspect-[2/3] w-full items-center justify-center rounded-lg bg-raised text-faint">
        <Icon strokeWidth={1.25} className="h-7 w-7" aria-hidden />
      </div>
    );
  return (
    <img
      src={`/api/services/${encodeURIComponent(serviceId)}/dashboard/jellyfin-poster?item=${encodeURIComponent(id)}`}
      alt={title}
      loading="lazy"
      onError={() => setFailed(true)}
      className="aspect-[2/3] w-full rounded-lg bg-raised object-cover"
    />
  );
}

interface Card {
  id: string;
  title: string;
  year?: number;
  type?: string;
  watched: boolean;
  unwatched?: number;
  poster?: boolean;
}

interface Item {
  id: string;
  title: string;
  type: string;
  year?: number;
  sortTitle: string;
  summary: string;
  genres: string[];
  rating?: string;
  watched: boolean;
  lastWatched?: string;
  added?: string;
  parent?: { id?: string; title?: string };
  children: (Card & { index?: number; episodes?: number; episodesWatched?: number })[];
  files: { file: string; size: number; resolution?: string; video?: string; audio?: string }[];
}

const size = (b: number) =>
  !b
    ? ""
    : b >= 1e9
      ? `${(b / 1e9).toFixed(1)} GB`
      : b >= 1e6
        ? `${Math.round(b / 1e6)} MB`
        : `${Math.max(1, Math.round(b / 1e3))} KB`;

function WatchedButton({
  item,
  act,
  target,
}: {
  item: Pick<Card, "id" | "title" | "watched">;
  act: ReturnType<typeof useApproveHere>;
  target: string;
}) {
  return (
    <button
      type="button"
      className={btn}
      disabled={act.busy}
      data-hearth-target={target}
      onClick={() =>
        void act.propose(
          KIND,
          { op: item.watched ? "unwatched" : "watched", itemId: item.id },
          `Mark ${item.title} ${item.watched ? "unwatched" : "watched"}`,
        )
      }
    >
      <Check strokeWidth={1.5} className="h-3.5 w-3.5" />
      {item.watched ? "Mark unwatched" : "Mark watched"}
    </button>
  );
}

function EditDetails({ item, act }: { item: Item; act: ReturnType<typeof useApproveHere> }) {
  const [title, setTitle] = useState(item.title);
  const [sortTitle, setSortTitle] = useState(item.sortTitle);
  const [year, setYear] = useState(item.year ? String(item.year) : "");
  const [summary, setSummary] = useState(item.summary);
  const body: Record<string, string> = {};
  if (title !== item.title) body.title = title;
  if (sortTitle !== item.sortTitle) body.sortTitle = sortTitle;
  if (year !== (item.year ? String(item.year) : "")) body.year = year;
  if (summary !== item.summary) body.summary = summary;
  const changed = Object.keys(body).length > 0;
  return (
    <div className="space-y-2 rounded-xl border border-line bg-bg/50 p-3" data-testid="jf-edit">
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_6rem]">
        <label className="grid gap-1 text-[0.76rem] text-faint">
          Title
          <input
            className={cx(input, "w-full min-w-0")}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            data-hearth-target="item:edit:title"
          />
        </label>
        <label className="grid gap-1 text-[0.76rem] text-faint">
          Sort title
          <input
            className={cx(input, "w-full min-w-0")}
            value={sortTitle}
            onChange={(e) => setSortTitle(e.target.value)}
            data-hearth-target="item:edit:sort"
          />
        </label>
        <label className="grid gap-1 text-[0.76rem] text-faint">
          Year
          <input
            className={cx(input, "w-full min-w-0")}
            inputMode="numeric"
            value={year}
            onChange={(e) => setYear(e.target.value)}
            data-hearth-target="item:edit:year"
          />
        </label>
      </div>
      <label className="grid gap-1 text-[0.76rem] text-faint">
        Summary
        <textarea
          className={cx(input, "min-h-20 py-2")}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          data-hearth-target="item:edit:summary"
        />
      </label>
      <Button
        tone="primary"
        disabled={act.busy || !changed}
        data-hearth-target="item:edit:save"
        onClick={() =>
          void act.propose(
            KIND,
            { op: "edit-item", itemId: item.id, body: JSON.stringify(body) },
            `Edit ${item.title}`,
          )
        }
      >
        Review changes
      </Button>
      <p className="text-[0.74rem] text-faint">
        The server keeps what you set here when it refreshes the title.
      </p>
    </div>
  );
}

function JellyfinItem({
  serviceId,
  id,
  onOpen,
  onBack,
}: {
  serviceId: string;
  id: string;
  onOpen: (id: string) => void;
  onBack: (parent?: string) => void;
}) {
  const server = useServerWord(serviceId);
  const q = useJf<Item>(serviceId, "item", { id });
  const act = useApproveHere(serviceId, `From ${server}'s Library tab.`);
  const [editing, setEditing] = useState(false);
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error || !q.data)
    return (
      <div className="space-y-2">
        <button type="button" className={btn} onClick={() => onBack()}>
          <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> Library
        </button>
        <p className="text-[0.84rem] text-amber">{server} does not have that title any more.</p>
      </div>
    );
  const m = q.data;
  return (
    <section className="space-y-4" aria-label={m.title} data-testid="jf-item">
      <ApproveDialog c={act} />
      <button
        type="button"
        className={btn}
        onClick={() => onBack(m.parent?.id)}
        data-hearth-target="item:back"
      >
        <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> {m.parent?.title ?? "Library"}
      </button>
      <div className="flex flex-wrap gap-4">
        <div className="w-28 shrink-0">
          <Poster serviceId={serviceId} id={m.id} title={m.title} type={m.type} has />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <h3 className="text-[1.05rem] text-ink" data-testid="jf-item-title">
            {m.title}
            {m.year ? <span className="text-faint"> ({m.year})</span> : null}
          </h3>
          <p className="text-[0.78rem] text-faint">
            {[
              m.watched ? "Watched" : "Not watched",
              m.lastWatched ? `last ${ago(m.lastWatched)}` : "",
              m.added ? `added ${ago(m.added)}` : "",
              m.rating,
              m.genres.slice(0, 3).join(", "),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {m.summary && <p className="text-[0.84rem] text-muted">{m.summary}</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            <WatchedButton item={m} act={act} target="item:watched" />
            {m.type.toLowerCase() === "movie" && (
              <PlanMovieNightButton title={m.title} className={btn} />
            )}
            <button
              type="button"
              className={btn}
              disabled={act.busy}
              data-hearth-target="item:refresh"
              onClick={() =>
                void act.propose(KIND, { op: "refresh-item", itemId: m.id }, `Refresh ${m.title}`)
              }
            >
              <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" /> Refresh details
            </button>
            <button
              type="button"
              className={btn}
              aria-expanded={editing}
              onClick={() => setEditing(!editing)}
              data-hearth-target="item:edit"
            >
              Edit details
            </button>
          </div>
        </div>
      </div>
      {editing && <EditDetails key={`${m.id}-${m.title}-${m.sortTitle}`} item={m} act={act} />}
      {m.children.length > 0 && (
        <ul className="divide-y divide-line" data-testid="jf-children">
          {m.children.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[0.86rem]"
              data-testid="jf-child"
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left text-ink hover:text-gold"
                onClick={() => onOpen(c.id)}
                data-hearth-target={`item:child:${c.id}`}
              >
                {c.type === "episode" && c.index !== undefined ? `${c.index}. ` : ""}
                {c.title}
                <span className="block text-[0.76rem] text-faint">
                  {c.episodes !== undefined
                    ? `${c.episodesWatched ?? 0} of ${c.episodes} watched`
                    : c.watched
                      ? "Watched"
                      : "Not watched"}
                </span>
              </button>
              <WatchedButton item={c} act={act} target={`item:child:${c.id}:watched`} />
            </li>
          ))}
        </ul>
      )}
      {m.files.length > 0 && (
        <div>
          <p className="eyebrow mb-1">Files</p>
          <ul className="space-y-1 text-[0.78rem] text-muted" data-testid="jf-files">
            {m.files.map((f) => (
              <li key={f.file} className="break-all">
                {f.file}
                <span className="text-faint">
                  {" · "}
                  {[f.resolution, f.video, f.audio, size(f.size)].filter(Boolean).join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** The Library tab: every library's titles with posters, a search, sorting and Not watched. */
export function JellyfinLibrary({ serviceId, name, sub, onSub }: AppViewProps) {
  const server = useServerWord(serviceId);
  const [section, setSection] = useState<string>();
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [sort, setSort] = useState("added");
  const [unwatched, setUnwatched] = useState(false);
  const [page, setPage] = useState(1);
  const [localSub, setLocalSub] = useState<string | null>(null);
  const where = onSub ? (sub ?? null) : localSub;
  const go = (s: string | null) => (onSub ? onSub(s) : setLocalSub(s));
  // Searches as you type, a moment after you stop.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (search.trim() === term) return;
      setTerm(search.trim());
      setPage(1);
    }, 350);
    return () => window.clearTimeout(t);
  }, [search, term]);
  const q = useJf<{
    sections: { id: string; title: string; type: string }[];
    section?: string;
    items: Card[];
    total: number;
    page: number;
  }>(serviceId, "library", {
    section,
    q: term,
    sort,
    filter: unwatched ? "unwatched" : undefined,
    page,
  });
  const act = useApproveHere(serviceId, `From ${server}'s Library tab.`);
  const itemId = where?.startsWith("item/") ? where.slice(5) : undefined;
  if (itemId)
    return (
      <JellyfinItem
        serviceId={serviceId}
        id={itemId}
        onOpen={(i) => go(`item/${i}`)}
        onBack={(parent) => go(parent ? `item/${parent}` : null)}
      />
    );
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error || !q.data)
    return <p className="text-[0.84rem] text-amber">Could not read {name}&apos;s libraries.</p>;
  const d = q.data;
  const current = d.sections.find((s) => s.id === d.section);
  const pages = Math.max(1, Math.ceil(d.total / 60));
  return (
    <section className="space-y-3" aria-label={`${name} library`} data-testid="jf-library">
      <ApproveDialog c={act} />
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Libraries">
        {d.sections.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={s.id === d.section}
            className={cx(btn, s.id === d.section && "border-gold/60 text-ink")}
            onClick={() => {
              setSection(s.id);
              setPage(1);
            }}
            data-hearth-target={`library:section:${s.id}`}
          >
            {s.title}
          </button>
        ))}
      </div>
      {current?.type?.toLowerCase().startsWith("music") && (
        <MakePlaylist
          app={server}
          serviceId={serviceId}
          serviceName={name}
          library={current.title}
        />
      )}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(search.trim());
          setPage(1);
        }}
      >
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Find a title</span>
          <Search
            strokeWidth={1.5}
            className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-faint"
          />
          <input
            className={cx(input, "w-full pl-8")}
            placeholder="Find a title"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              if (!e.target.value) setTerm("");
            }}
            data-hearth-target="library:search"
          />
        </label>
        <select
          className={input}
          aria-label="Sort"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          data-hearth-target="library:sort"
        >
          <option value="added">Recently added</option>
          <option value="title">Title</option>
          <option value="year">Year</option>
          <option value="watched">Recently watched</option>
        </select>
        <label className="inline-flex min-h-9 items-center gap-2 text-[0.8rem] text-muted">
          <input
            type="checkbox"
            checked={unwatched}
            onChange={(e) => setUnwatched(e.target.checked)}
            data-hearth-target="library:unwatched"
          />
          Not watched
        </label>
      </form>
      {d.items.length === 0 ? (
        <p className="text-[0.84rem] text-muted">
          {term
            ? `Nothing in ${current?.title ?? "this library"} matches.`
            : "This library is empty."}
        </p>
      ) : (
        <ul
          className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-3"
          data-testid="jf-items"
        >
          {d.items.map((x) => (
            <li key={x.id} data-testid="jf-card">
              <button
                type="button"
                className="group w-full text-left"
                onClick={() => go(`item/${x.id}`)}
                data-hearth-target={`library:item:${x.id}`}
              >
                <Poster
                  serviceId={serviceId}
                  id={x.id}
                  title={x.title}
                  type={x.type}
                  has={Boolean(x.poster)}
                />
                <span className="mt-1 block truncate text-[0.82rem] text-ink group-hover:text-gold">
                  {x.title}
                </span>
                <span className="block text-[0.72rem] text-faint">
                  {[
                    x.year,
                    x.unwatched !== undefined && x.type === "series"
                      ? x.unwatched
                        ? `${x.unwatched} not watched`
                        : "all watched"
                      : x.watched
                        ? "watched"
                        : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {pages > 1 && (
        <div className="flex items-center gap-2 text-[0.78rem] text-muted">
          <button
            type="button"
            className={btn}
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
            data-hearth-target="library:prev"
          >
            Previous
          </button>
          <span>
            Page {page} of {pages}
          </span>
          <button
            type="button"
            className={btn}
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
            data-hearth-target="library:next"
          >
            Next
          </button>
        </div>
      )}
      {current && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          <button
            type="button"
            className={btn}
            disabled={act.busy}
            data-hearth-target="library:scan"
            onClick={() =>
              void act.propose(
                KIND,
                { op: "scan-library", libraryId: current.id },
                `Scan ${current.title}`,
              )
            }
          >
            <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" /> Scan {current.title}
          </button>
        </div>
      )}
    </section>
  );
}

interface Library {
  id?: string;
  name: string;
  type: string;
  folders: string[];
  scanning: boolean;
}

/** Manage: each library with its folders (add one, stop reading one), scans, and a new library. */
/** Home rows for Jellyfin: each person's home screen, in its own panel (as Plex's Manage tab). */
function HomeRowsLink({ serviceId }: { serviceId: string }) {
  const href = usePanelHref()("tool:home-rows", serviceId);
  const server = useServerWord(serviceId);
  if (!href) return null;
  return (
    <p className="text-[0.82rem] text-muted">
      Arrange what everyone sees on their {server} home screen:{" "}
      <Link
        to={href}
        className="text-gold underline-offset-2 hover:underline"
        data-testid="jellyfin-home-rows"
      >
        open Home rows
      </Link>
    </p>
  );
}

export function JellyfinManage({ serviceId, name }: AppViewProps) {
  const server = useServerWord(serviceId);
  const q = useJf<{ libraries: Library[]; types: { id: string; label: string }[] }>(
    serviceId,
    "libraries",
  );
  const act = useApproveHere(serviceId, `From ${server}'s Manage tab.`);
  const [adding, setAdding] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [newLib, setNewLib] = useState({ name: "", type: "movies", path: "" });
  const [creating, setCreating] = useState(false);
  if (q.isLoading) return <Skeleton className="h-48" />;
  if (q.error || !q.data)
    return <p className="text-[0.84rem] text-amber">Could not read {name}&apos;s libraries.</p>;
  const d = q.data;
  const typeName = (t: string) => d.types.find((x) => x.id === t)?.label ?? t;
  return (
    <section className="space-y-4" aria-label={`Manage ${name}`} data-testid="jf-manage">
      <ApproveDialog c={act} />
      <div className="flex flex-wrap items-center gap-2">
        <p className="eyebrow mr-auto">
          {d.libraries.length} {d.libraries.length === 1 ? "library" : "libraries"}
        </p>
        <button
          type="button"
          className={btn}
          disabled={act.busy || !d.libraries.length}
          data-hearth-target="manage:scan-all"
          onClick={() =>
            void act.propose(KIND, { op: "scan-all" }, `Scan all libraries in ${name}`)
          }
        >
          <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" /> Scan all
        </button>
        <button
          type="button"
          className={btn}
          aria-expanded={creating}
          onClick={() => setCreating(!creating)}
          data-hearth-target="manage:add-library"
        >
          <FolderPlus strokeWidth={1.5} className="h-3.5 w-3.5" /> Add a library
        </button>
      </div>
      <HomeRowsLink serviceId={serviceId} />
      {creating && (
        <div
          className="grid gap-2 rounded-xl border border-line bg-bg/50 p-3 sm:grid-cols-[1fr_12rem]"
          data-testid="jf-new-library"
        >
          <label className="grid gap-1 text-[0.76rem] text-faint">
            Name
            <input
              className={input}
              value={newLib.name}
              placeholder="A name, like Concerts"
              onChange={(e) => setNewLib({ ...newLib, name: e.target.value })}
              data-hearth-target="manage:new:name"
            />
          </label>
          <label className="grid gap-1 text-[0.76rem] text-faint">
            Kind
            <select
              className={input}
              value={newLib.type}
              onChange={(e) => setNewLib({ ...newLib, type: e.target.value })}
              data-hearth-target="manage:new:type"
            >
              {d.types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-[0.76rem] text-faint sm:col-span-2">
            Folder, as {server} sees it
            <input
              className={input}
              value={newLib.path}
              placeholder="/media/library-folder"
              onChange={(e) => setNewLib({ ...newLib, path: e.target.value })}
              data-hearth-target="manage:new:path"
            />
          </label>
          <div className="sm:col-span-2">
            <Button
              tone="primary"
              disabled={act.busy || !newLib.name.trim() || !newLib.path.trim()}
              data-hearth-target="manage:new:review"
              onClick={() =>
                void act
                  .propose(
                    KIND,
                    { op: "add-library", ...newLib },
                    `Add the ${newLib.name.trim()} library`,
                  )
                  .then(() => setCreating(false))
              }
            >
              Review
            </Button>
          </div>
        </div>
      )}
      <ul className="space-y-3" data-testid="jf-libraries">
        {d.libraries.map((l) => (
          <li
            key={l.name}
            className="rounded-xl border border-line p-3"
            data-testid="jf-library-row"
            data-library={l.name}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 text-[0.9rem] text-ink">
                {l.name}
                <span className="text-[0.76rem] text-faint">
                  {" "}
                  · {typeName(l.type)}
                  {l.scanning ? " · scanning now" : ""}
                </span>
              </span>
              {l.id && (
                <button
                  type="button"
                  className={btn}
                  disabled={act.busy}
                  data-hearth-target={`manage:library:${l.name}:scan`}
                  onClick={() =>
                    void act.propose(
                      KIND,
                      { op: "scan-library", libraryId: l.id! },
                      `Scan ${l.name}`,
                    )
                  }
                >
                  Scan
                </button>
              )}
              <button
                type="button"
                className={btn}
                aria-expanded={adding === l.name}
                onClick={() => {
                  setAdding(adding === l.name ? null : l.name);
                  setPath("");
                }}
                data-hearth-target={`manage:library:${l.name}:add-folder`}
              >
                <FolderPlus strokeWidth={1.5} className="h-3.5 w-3.5" /> Add a folder
              </button>
              <button
                type="button"
                className={btn}
                disabled={act.busy}
                data-hearth-target={`manage:library:${l.name}:remove`}
                onClick={() =>
                  void act.propose(
                    KIND,
                    { op: "remove-library", library: l.name },
                    `Remove the ${l.name} library`,
                  )
                }
              >
                <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove
              </button>
            </div>
            <ul className="mt-2 space-y-1">
              {l.folders.map((f) => (
                <li
                  key={f}
                  className="flex flex-wrap items-center gap-2 text-[0.8rem] text-muted"
                  data-testid="jf-folder"
                >
                  <span className="min-w-0 flex-1 break-all">{f}</span>
                  {l.folders.length > 1 && (
                    <button
                      type="button"
                      className={btn}
                      disabled={act.busy}
                      data-hearth-target={`manage:folder:${f}:remove`}
                      onClick={() =>
                        void act.propose(
                          KIND,
                          { op: "remove-folder", library: l.name, path: f },
                          `Stop ${l.name} reading ${f}`,
                        )
                      }
                    >
                      Stop reading it
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {adding === l.name && (
              <form
                className="mt-2 flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act
                    .propose(
                      KIND,
                      { op: "add-folder", library: l.name, path: path.trim() },
                      `Add a folder to ${l.name}`,
                    )
                    .then(() => setAdding(null));
                }}
              >
                <input
                  className={cx(input, "min-w-0 flex-1")}
                  value={path}
                  placeholder="/media/another-folder"
                  aria-label={`A folder for ${l.name}`}
                  onChange={(e) => setPath(e.target.value)}
                  data-hearth-target={`manage:library:${l.name}:path`}
                />
                <Button type="submit" tone="primary" disabled={act.busy || !path.trim()}>
                  Review
                </Button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <p className="text-[0.76rem] text-faint">
        Folders are paths as {server} sees them (inside its container). Removing a library or a
        folder never deletes files.
      </p>
    </section>
  );
}

interface Plugin {
  id?: string;
  name: string;
  version?: string;
  status?: string;
  description: string;
  canRemove: boolean;
  update?: string;
  guid?: string;
}
interface CatalogEntry {
  guid?: string;
  name: string;
  overview: string;
  category?: string;
  owner?: string;
  version?: string;
  repository?: string;
  installed?: string;
}

/** Plugins: what is installed (updates, enable, disable, remove), the catalog, and a restart. */
export function JellyfinPlugins({ serviceId, name }: AppViewProps) {
  const server = useServerWord(serviceId);
  const [find, setFind] = useState("");
  const q = useJf<{
    restartNeeded: boolean;
    installed: Plugin[];
    catalog: CatalogEntry[];
    catalogError?: string;
    repositories: { name?: string; url?: string; enabled: boolean }[];
  }>(serviceId, "plugins");
  const act = useApproveHere(serviceId, `From ${server}'s Plugins tab.`);
  const catalog = useMemo(() => {
    const f = find.trim().toLowerCase();
    return (q.data?.catalog ?? []).filter(
      (k) =>
        !k.installed && (!f || `${k.name} ${k.overview} ${k.category}`.toLowerCase().includes(f)),
    );
  }, [q.data, find]);
  if (q.isLoading) return <Skeleton className="h-48" />;
  if (q.error || !q.data)
    return <p className="text-[0.84rem] text-amber">Could not read {name}&apos;s plugins.</p>;
  const d = q.data;
  const updates = d.installed.filter((p) => p.update);
  return (
    <section className="space-y-5" aria-label={`${name} plugins`} data-testid="jf-plugins-tab">
      <ApproveDialog c={act} />
      {d.restartNeeded && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-xl border border-amber/40 bg-amber/10 p-3 text-[0.84rem] text-ink"
          data-testid="jf-restart-needed"
        >
          <span className="min-w-0 flex-1">
            {name} needs a restart to finish plugin changes. Anyone watching is cut off for about a
            minute.
          </span>
          <Button
            tone="primary"
            disabled={act.busy}
            data-hearth-target="plugins:restart"
            onClick={() => void act.propose(KIND, { op: "restart" }, `Restart ${name}`)}
          >
            <Power strokeWidth={1.5} className="h-4 w-4" /> Restart {name}
          </Button>
        </div>
      )}
      <div>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <p className="eyebrow mr-auto">Installed ({d.installed.length})</p>
          {updates.length > 0 && (
            <span className="text-[0.76rem] text-gold" data-testid="jf-updates">
              {updates.length} {updates.length === 1 ? "update" : "updates"}
            </span>
          )}
        </div>
        <ul className="divide-y divide-line" data-testid="jf-plugins">
          {d.installed.map((p) => {
            const off = p.status?.toLowerCase() === "disabled";
            return (
              <li
                key={p.id ?? p.name}
                className="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2.5"
                data-testid="jf-plugin"
                data-plugin={p.name}
              >
                <span className="min-w-0 flex-1">
                  <span className="text-[0.86rem] text-ink">{p.name}</span>
                  <span className="text-[0.76rem] text-faint">
                    {" "}
                    {[p.version, p.status].filter(Boolean).join(" · ")}
                  </span>
                  {p.description && (
                    <span className="block text-[0.76rem] text-faint">{p.description}</span>
                  )}
                </span>
                <span className="flex flex-wrap gap-1.5">
                  {p.update && p.guid && (
                    <button
                      type="button"
                      className={cx(btn, "border-gold/50 text-gold")}
                      disabled={act.busy}
                      data-hearth-target={`plugin:${p.name}:update`}
                      onClick={() =>
                        void act.propose(
                          KIND,
                          { op: "plugin-install", guid: p.guid! },
                          `Update ${p.name} to ${p.update}`,
                        )
                      }
                    >
                      <Download strokeWidth={1.5} className="h-3.5 w-3.5" /> Update to {p.update}
                    </button>
                  )}
                  {/* Emby lists no status: it has no switch to turn a plugin off, only removing it. */}
                  {p.id && p.status !== undefined && (
                    <button
                      type="button"
                      className={btn}
                      disabled={act.busy}
                      data-hearth-target={`plugin:${p.name}:${off ? "enable" : "disable"}`}
                      onClick={() =>
                        void act.propose(
                          KIND,
                          { op: off ? "plugin-enable" : "plugin-disable", pluginId: p.id! },
                          `${off ? "Enable" : "Disable"} ${p.name}`,
                        )
                      }
                    >
                      {off ? "Enable" : "Disable"}
                    </button>
                  )}
                  {p.id && p.canRemove && (
                    <button
                      type="button"
                      className={btn}
                      disabled={act.busy}
                      data-hearth-target={`plugin:${p.name}:remove`}
                      onClick={() =>
                        void act.propose(
                          KIND,
                          { op: "plugin-uninstall", pluginId: p.id! },
                          `Remove ${p.name}`,
                        )
                      }
                    >
                      <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <p className="eyebrow mr-auto">Catalog</p>
          <label className="relative min-w-0 flex-1 sm:max-w-xs">
            <span className="sr-only">Find a plugin</span>
            <Search
              strokeWidth={1.5}
              className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-faint"
            />
            <input
              className={cx(input, "w-full pl-8")}
              placeholder="Find a plugin"
              value={find}
              onChange={(e) => setFind(e.target.value)}
              data-hearth-target="plugins:find"
            />
          </label>
        </div>
        {d.catalogError ? (
          <p className="text-[0.84rem] text-amber">{d.catalogError}</p>
        ) : catalog.length === 0 ? (
          <p className="text-[0.84rem] text-muted">
            {find ? "No plugin in the catalog matches." : "Everything in the catalog is installed."}
          </p>
        ) : (
          <ul className="divide-y divide-line" data-testid="jf-catalog">
            {catalog.map((k) => (
              <li
                key={k.guid ?? k.name}
                className="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2.5"
                data-testid="jf-catalog-entry"
                data-plugin={k.name}
              >
                <span className="min-w-0 flex-1">
                  <span className="text-[0.86rem] text-ink">{k.name}</span>
                  <span className="text-[0.76rem] text-faint">
                    {" "}
                    {[k.version, k.category, k.repository].filter(Boolean).join(" · ")}
                  </span>
                  {k.overview && (
                    <span className="block text-[0.76rem] text-faint">{k.overview}</span>
                  )}
                </span>
                {k.guid && (
                  <button
                    type="button"
                    className={btn}
                    disabled={act.busy}
                    data-hearth-target={`catalog:${k.name}:install`}
                    onClick={() =>
                      void act.propose(
                        KIND,
                        { op: "plugin-install", guid: k.guid! },
                        `Install ${k.name}`,
                      )
                    }
                  >
                    <Download strokeWidth={1.5} className="h-3.5 w-3.5" /> Install
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[0.76rem] text-faint">
          From{" "}
          {d.repositories
            .filter((r) => r.enabled)
            .map((r) => r.name)
            .join(", ") || "no repository"}
          . Adding other repositories, and each plugin&apos;s own settings, stay in {server}.
        </p>
      </div>
    </section>
  );
}

interface Setting {
  id: string;
  label: string;
  summary?: string;
  group: string;
  type: "bool" | "text" | "int";
  options?: { value: string; label: string }[];
  advanced?: boolean;
  value: unknown;
}

/** Settings: the everyday server and playback settings, collected and sent as one plan. */
export function JellyfinSettings({ serviceId, name }: AppViewProps) {
  const server = useServerWord(serviceId);
  const q = useJf<{ settings: Setting[] }>(serviceId, "settings");
  const act = useApproveHere(serviceId, `From ${server}'s Settings tab.`);
  const [advanced, setAdvanced] = useState(false);
  const [edits, setEdits] = useState<Record<string, string | number | boolean>>({});
  const groups = useMemo(() => {
    const by = new Map<string, Setting[]>();
    for (const s of q.data?.settings ?? [])
      if (advanced || !s.advanced) by.set(s.group, [...(by.get(s.group) ?? []), s]);
    return [...by.entries()];
  }, [q.data, advanced]);
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error || !q.data)
    return <p className="text-[0.84rem] text-amber">Could not read {name}&apos;s settings.</p>;
  const changed = Object.keys(edits).length;
  const set = (s: Setting, v: string | number | boolean) =>
    setEdits((e) => {
      const next = { ...e };
      if (String(v) === String(s.value ?? "")) delete next[s.id];
      else next[s.id] = v;
      return next;
    });
  return (
    <section className="space-y-4" aria-label={`${name} settings`} data-testid="jf-settings">
      <ApproveDialog c={act} />
      <label className="inline-flex min-h-9 items-center gap-2 text-[0.8rem] text-muted">
        <input
          type="checkbox"
          checked={advanced}
          onChange={(e) => setAdvanced(e.target.checked)}
          data-hearth-target="settings:advanced"
        />
        Show advanced
      </label>
      {groups.map(([group, list]) => (
        <div key={group}>
          <p className="eyebrow mb-1">{group}</p>
          <ul className="divide-y divide-line">
            {list.map((s) => {
              const value = s.id in edits ? edits[s.id] : s.value;
              return (
                <li
                  key={s.id}
                  className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5"
                  data-testid="jf-setting"
                  data-setting={s.id}
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-[0.86rem] text-ink">{s.label}</span>
                    {s.summary && (
                      <span className="block text-[0.76rem] text-faint">{s.summary}</span>
                    )}
                  </span>
                  <span className="shrink-0">
                    {s.type === "bool" ? (
                      <input
                        type="checkbox"
                        aria-label={s.label}
                        checked={Boolean(value)}
                        onChange={(e) => set(s, e.target.checked)}
                        data-hearth-target={`setting:${s.id}`}
                        className="h-5 w-5"
                      />
                    ) : s.options ? (
                      <select
                        className={input}
                        aria-label={s.label}
                        value={String(value ?? "")}
                        onChange={(e) => set(s, e.target.value)}
                        data-hearth-target={`setting:${s.id}`}
                      >
                        {s.options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className={cx(input, "w-48 max-w-full")}
                        aria-label={s.label}
                        inputMode={s.type === "int" ? "numeric" : undefined}
                        value={String(value ?? "")}
                        onChange={(e) =>
                          set(
                            s,
                            s.type === "int" ? e.target.value.replace(/\D/g, "") : e.target.value,
                          )
                        }
                        data-hearth-target={`setting:${s.id}`}
                      />
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-line bg-panel py-2">
        <Button
          tone="primary"
          disabled={act.busy || !changed}
          data-hearth-target="settings:review"
          onClick={() =>
            void act
              .propose(
                KIND,
                { op: "set-settings", settings: JSON.stringify(edits) },
                changed === 1
                  ? `Change a ${server} setting`
                  : `Change ${changed} ${server} settings`,
              )
              .then(() => setEdits({}))
          }
        >
          {changed ? `Review ${changed} ${changed === 1 ? "change" : "changes"}` : "Review changes"}
        </Button>
        <span className="text-[0.76rem] text-faint">
          Networking, remote access and anything with a password stay in {server}.
        </span>
      </div>
    </section>
  );
}
