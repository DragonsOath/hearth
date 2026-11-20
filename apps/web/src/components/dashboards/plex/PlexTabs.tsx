import { useEffect, useMemo, useState } from "react";
import { AddToCollection } from "../../homeRows/AddTitle";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Film,
  Image,
  Lock,
  Music,
  RefreshCw,
  Search,
  Tv,
} from "lucide-react";
import { api, useWorkspace } from "../../../data/api";
import { plexArt } from "../../../data/dashboards";
import { Link } from "react-router";
import { usePanelHref } from "../../desk/links";
import { PlanMovieNightButton } from "../../notify/PlanMovieNight";
import { ago } from "../../../lib/format";
import { keyPageHref } from "../../../lib/keyPage";
import type { AppViewProps } from "../../panels/registry";
import { ApproveDialog, useApproveHere } from "../../jobs/ApproveHere";
import { Button, Skeleton, cx } from "../../ui";
import { MakePlaylist } from "../../music/MakePlaylist";

/**
 * Plex's Library, History, Tasks and Settings tabs. Every change is a plan you approve (watched,
 * edit a title's details, refresh it, empty a library's trash, run maintenance, change settings);
 * Ember plans the same steps. Sharing, users and remote access need a plex.tv account or are
 * networking: they stay in Plex, linked from here.
 */

function usePlex<T>(
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
    queryKey: ["dashboard", serviceId, "plex", view, params],
    queryFn: () =>
      api<T & { sample?: boolean }>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/plex/${view}${params ? `?${params}` : ""}`,
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

/** A link into Plex's own web app, for what stays there. */
function InPlex({
  serviceId,
  path,
  children,
}: {
  serviceId: string;
  path: string;
  children: React.ReactNode;
}) {
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  const href = keyPageHref(service, path);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-h-9 items-center gap-1.5 text-[0.8rem] text-gold underline-offset-2 hover:underline"
    >
      {children} <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
    </a>
  );
}

function Poster({
  serviceId,
  path,
  title,
  type,
}: {
  serviceId: string;
  path?: string;
  title: string;
  type?: string;
}) {
  const [failed, setFailed] = useState(false);
  const Icon = type === "movie" ? Film : Tv;
  if (!path || failed)
    return (
      <div className="flex aspect-[2/3] w-full items-center justify-center rounded-lg bg-raised text-faint">
        <Icon strokeWidth={1.25} className="h-7 w-7" aria-hidden />
      </div>
    );
  return (
    <img
      src={plexArt(serviceId, path)}
      alt={title}
      loading="lazy"
      onError={() => setFailed(true)}
      className="aspect-[2/3] w-full rounded-lg bg-raised object-cover"
    />
  );
}

interface Card {
  id: string;
  type?: string;
  title: string;
  year?: number;
  thumb?: string;
  added?: string;
  watched: boolean;
  episodes?: number;
  episodesWatched?: number;
  index?: number;
}

interface Item extends Card {
  sortTitle: string;
  summary: string;
  show?: string;
  lastWatched?: string;
  viewCount: number;
  section?: string;
  versions: {
    id?: number;
    resolution?: string;
    video?: string;
    audio?: string;
    bitrate?: number;
    container?: string;
    files: { file?: string; size?: number }[];
  }[];
  children: Card[];
}

const size = (b?: number) =>
  b === undefined
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
          "app-plex-control",
          { op: item.watched ? "unwatched" : "watched", ratingKey: item.id },
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
    <div className="space-y-2 rounded-xl border border-line bg-bg/50 p-3" data-testid="plex-edit">
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_6rem]">
        <label className="grid gap-1 text-[0.76rem] text-faint">
          Title
          <input
            className={input}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            data-hearth-target="item:edit:title"
          />
        </label>
        <label className="grid gap-1 text-[0.76rem] text-faint">
          Sort title
          <input
            className={input}
            value={sortTitle}
            onChange={(e) => setSortTitle(e.target.value)}
            data-hearth-target="item:edit:sort"
          />
        </label>
        {(item.type === "movie" || item.type === "show") && (
          <label className="grid gap-1 text-[0.76rem] text-faint">
            Year
            <input
              className={input}
              inputMode="numeric"
              value={year}
              onChange={(e) => setYear(e.target.value)}
            />
          </label>
        )}
      </div>
      <label className="grid gap-1 text-[0.76rem] text-faint">
        Summary
        <textarea
          className={cx(input, "min-h-20 py-2")}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
      </label>
      <Button
        tone="primary"
        disabled={act.busy || !changed}
        data-hearth-target="item:edit:save"
        onClick={() =>
          void act.propose(
            "app-plex-control",
            { op: "edit-item", ratingKey: item.id, body: JSON.stringify(body) },
            `Edit ${item.title}`,
          )
        }
      >
        Review changes
      </Button>
      <p className="text-[0.74rem] text-faint">
        Plex keeps what you set here when it refreshes the title.
      </p>
    </div>
  );
}

function PlexItem({
  serviceId,
  id,
  onOpen,
  onBack,
}: {
  serviceId: string;
  id: string;
  onOpen: (id: string) => void;
  onBack: () => void;
}) {
  const q = usePlex<Item>(serviceId, "item", { id });
  const act = useApproveHere(serviceId, "From Plex's Library tab.");
  const [editing, setEditing] = useState(false);
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error || !q.data)
    return (
      <div className="space-y-2">
        <button type="button" className={btn} onClick={onBack}>
          <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> Library
        </button>
        <p className="text-[0.84rem] text-amber">Plex does not have that title any more.</p>
      </div>
    );
  const m = q.data;
  return (
    <section className="space-y-4" aria-label={m.title} data-testid="plex-item">
      <ApproveDialog c={act} />
      <button type="button" className={btn} onClick={onBack} data-hearth-target="item:back">
        <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> {m.show ?? "Library"}
      </button>
      <div className="flex flex-wrap gap-4">
        <div className="w-28 shrink-0">
          <Poster serviceId={serviceId} path={m.thumb} title={m.title} type={m.type} />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <h3 className="text-[1.05rem] text-ink" data-testid="plex-item-title">
            {m.title}
            {m.year ? <span className="text-faint"> ({m.year})</span> : null}
          </h3>
          <p className="text-[0.78rem] text-faint">
            {[
              m.watched ? "Watched" : "Not watched",
              m.lastWatched ? `last ${ago(m.lastWatched)}` : "",
              m.added ? `added ${ago(m.added)}` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {m.summary && <p className="text-[0.84rem] text-muted">{m.summary}</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            <WatchedButton item={m} act={act} target="item:watched" />
            {m.type?.toLowerCase() === "movie" && (
              <PlanMovieNightButton title={m.title} className={btn} />
            )}
            <button
              type="button"
              className={btn}
              disabled={act.busy}
              data-hearth-target="item:refresh"
              onClick={() =>
                void act.propose(
                  "app-plex-control",
                  { op: "refresh-item", ratingKey: m.id },
                  `Refresh ${m.title}`,
                )
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
      {m.section && (m.type === "movie" || m.type === "show") && (
        <AddToCollection
          serviceId={serviceId}
          libraryId={m.section}
          ratingKey={m.id}
          title={m.title}
          propose={act.propose}
          busy={act.busy}
        />
      )}
      {m.children.length > 0 && (
        <ul className="divide-y divide-line" data-testid="plex-children">
          {m.children.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[0.86rem]"
              data-testid="plex-child"
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
      {m.versions.length > 0 && (
        <div>
          <p className="eyebrow mb-1">Files</p>
          <ul className="space-y-1 text-[0.78rem] text-muted" data-testid="plex-files">
            {m.versions.flatMap((v) =>
              v.files.map((f) => (
                <li key={`${v.id}-${f.file}`} className="break-all">
                  {f.file}
                  <span className="text-faint">
                    {" "}
                    ·{" "}
                    {[
                      v.resolution && `${v.resolution}${/^\d+$/.test(v.resolution) ? "p" : ""}`,
                      v.video,
                      v.audio,
                      size(f.size),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </li>
              )),
            )}
          </ul>
        </div>
      )}
    </section>
  );
}

export function PlexLibrary({ serviceId, name, sub, onSub }: AppViewProps) {
  const [section, setSection] = useState<string>();
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [sort, setSort] = useState("added");
  const [unwatched, setUnwatched] = useState(false);
  const [page, setPage] = useState(1);
  const [localSub, setLocalSub] = useState<string | null>(null);
  const where = onSub ? (sub ?? null) : localSub;
  const go = (s: string | null) => (onSub ? onSub(s) : setLocalSub(s));
  // Searches as you type, a moment after you stop (Enter still searches at once).
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (search.trim() === term) return;
      setTerm(search.trim());
      setPage(1);
    }, 350);
    return () => window.clearTimeout(t);
  }, [search, term]);
  const q = usePlex<{
    sections: { id: string; title: string; type?: string }[];
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
  const act = useApproveHere(serviceId, "From Plex's Library tab.");
  const itemId = where?.startsWith("item/") ? where.slice(5) : undefined;
  if (itemId)
    return (
      <PlexItem
        serviceId={serviceId}
        id={itemId}
        onOpen={(i) => go(`item/${i}`)}
        onBack={() => go(null)}
      />
    );
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error || !q.data)
    return <p className="text-[0.84rem] text-amber">Could not read {name}&apos;s libraries.</p>;
  const d = q.data;
  const current = d.sections.find((s) => s.id === d.section);
  const pages = Math.max(1, Math.ceil(d.total / 60));
  return (
    <section className="space-y-3" aria-label={`${name} library`}>
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
      {current?.type === "artist" && (
        <MakePlaylist app="Plex" serviceId={serviceId} serviceName={name} library={current.title} />
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
          data-testid="plex-items"
        >
          {d.items.map((x) => (
            <li key={x.id} data-testid="plex-card">
              <button
                type="button"
                className="group w-full text-left"
                onClick={() => go(`item/${x.id}`)}
                data-hearth-target={`library:item:${x.id}`}
              >
                <Poster serviceId={serviceId} path={x.thumb} title={x.title} type={x.type} />
                <span className="mt-1 block truncate text-[0.82rem] text-ink group-hover:text-gold">
                  {x.title}
                </span>
                <span className="block text-[0.72rem] text-faint">
                  {[
                    x.year,
                    x.episodes !== undefined
                      ? `${x.episodesWatched ?? 0}/${x.episodes} watched`
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
                "app-plex-control",
                { op: "scan-library", libraryId: current.id },
                `Scan ${current.title}`,
              )
            }
          >
            Scan {current.title}
          </button>
          <button
            type="button"
            className={btn}
            disabled={act.busy}
            data-hearth-target="library:empty-trash"
            onClick={() =>
              void act.propose(
                "app-plex-control",
                { op: "empty-trash", libraryId: current.id },
                `Empty ${current.title}'s trash`,
              )
            }
          >
            Empty trash
          </button>
        </div>
      )}
    </section>
  );
}

export function PlexHistory({ serviceId, name }: AppViewProps) {
  const [page, setPage] = useState(1);
  const q = usePlex<{
    entries: { id: string; item?: string; title: string; who?: string; at?: string }[];
    total: number;
  }>(serviceId, "history", { page });
  if (q.isLoading) return <Skeleton className="h-48" />;
  if (q.error || !q.data)
    return <p className="text-[0.84rem] text-amber">Could not read {name}&apos;s history.</p>;
  const pages = Math.max(1, Math.ceil(q.data.total / 50));
  return (
    <section className="space-y-3" aria-label={`${name} history`}>
      {q.data.entries.length === 0 ? (
        <p className="text-[0.84rem] text-muted">Nothing has been watched yet.</p>
      ) : (
        <ul
          className="divide-y divide-line"
          data-testid="plex-history"
          data-hearth-target="history:list"
        >
          {q.data.entries.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap items-baseline gap-x-3 py-2 text-[0.86rem]"
              data-testid="plex-history-entry"
            >
              <span className="min-w-0 flex-1 text-ink">{e.title}</span>
              <span className="text-[0.76rem] text-faint">
                {[e.who, e.at ? ago(e.at) : ""].filter(Boolean).join(" · ")}
              </span>
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
          >
            Newer
          </button>
          <span>
            Page {page} of {pages}
          </span>
          <button
            type="button"
            className={btn}
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
          >
            Older
          </button>
        </div>
      )}
    </section>
  );
}

export function PlexTasks({ serviceId, name }: AppViewProps) {
  const q = usePlex<{
    tasks: {
      name: string;
      title: string;
      description?: string;
      everyDays?: number;
      enabled: boolean;
    }[];
    activities: { id?: string; title: string; detail?: string; progress?: number }[];
  }>(serviceId, "tasks");
  const act = useApproveHere(serviceId, "From Plex's Tasks tab.");
  if (q.isLoading) return <Skeleton className="h-48" />;
  if (q.error || !q.data)
    return <p className="text-[0.84rem] text-amber">Could not read {name}&apos;s tasks.</p>;
  const maintenance = (op: "clean-bundles" | "optimize-db", label: string, target: string) => (
    <button
      type="button"
      className={btn}
      disabled={act.busy}
      data-hearth-target={target}
      onClick={() => void act.propose("app-plex-control", { op }, label)}
    >
      {label}
    </button>
  );
  return (
    <section className="space-y-4" aria-label={`${name} tasks`}>
      <ApproveDialog c={act} />
      <div>
        <p className="eyebrow mb-1">Working now</p>
        {q.data.activities.length === 0 ? (
          <p className="text-[0.84rem] text-muted">Plex is not working on anything.</p>
        ) : (
          <ul className="space-y-1.5" data-testid="plex-activities">
            {q.data.activities.map((a) => (
              <li key={a.id ?? a.title} className="text-[0.84rem] text-ink">
                {a.title}
                {a.detail ? <span className="text-faint"> · {a.detail}</span> : null}
                {a.progress !== undefined ? (
                  <span className="text-faint"> · {Math.round(a.progress)}%</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {maintenance("clean-bundles", "Clean bundles", "tasks:clean-bundles")}
        {maintenance("optimize-db", "Optimize database", "tasks:optimize")}
      </div>
      <div>
        <p className="eyebrow mb-1">Scheduled maintenance</p>
        <ul
          className="divide-y divide-line"
          data-testid="plex-tasks"
          data-hearth-target="tasks:list"
        >
          {q.data.tasks.map((t) => (
            <li
              key={t.name}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[0.86rem]"
              data-testid="plex-task"
            >
              <span className="min-w-0 flex-1">
                <span className="text-ink">{t.title}</span>
                <span className="block text-[0.76rem] text-faint">
                  {[
                    t.enabled
                      ? t.everyDays
                        ? `every ${t.everyDays === 1 ? "day" : `${t.everyDays} days`}`
                        : "scheduled"
                      : "off",
                    t.description,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <button
                type="button"
                className={btn}
                disabled={act.busy}
                data-hearth-target={`task:${t.name}:run`}
                onClick={() =>
                  void act.propose(
                    "app-plex-control",
                    { op: "run-task", taskId: t.name },
                    `Run ${t.title}`,
                  )
                }
              >
                Run now
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[0.76rem] text-faint">
          Schedules and the maintenance window are set in Plex.{" "}
          <InPlex serviceId={serviceId} path="/web/index.html#!/settings/server">
            Open Plex settings
          </InPlex>
        </p>
      </div>
    </section>
  );
}

interface Setting {
  id: string;
  label: string;
  summary?: string;
  type?: string;
  group: string;
  advanced: boolean;
  value?: unknown;
  default?: unknown;
  options?: { value: string; label: string }[];
  locked: boolean;
}

const GROUPS: Record<string, string> = {
  general: "General",
  library: "Library",
  transcoder: "Transcoder",
  network: "Network",
  dlna: "DLNA",
  extras: "Extras",
  butler: "Scheduled tasks",
  channels: "Live TV",
  agents: "Agents",
};

export function PlexSettings({ serviceId, name }: AppViewProps) {
  const q = usePlex<{ settings: Setting[] }>(serviceId, "settings");
  const act = useApproveHere(serviceId, "From Plex's Settings tab.");
  const [advanced, setAdvanced] = useState(false);
  const [find, setFind] = useState("");
  const [edits, setEdits] = useState<Record<string, string | number | boolean>>({});
  const groups = useMemo(() => {
    const all = (q.data?.settings ?? []).filter(
      (s) =>
        (advanced || !s.advanced || find) &&
        (!find || `${s.label} ${s.summary ?? ""}`.toLowerCase().includes(find.toLowerCase())),
    );
    const by = new Map<string, Setting[]>();
    for (const s of all) by.set(s.group, [...(by.get(s.group) ?? []), s]);
    return [...by.entries()];
  }, [q.data, advanced, find]);
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error || !q.data)
    return <p className="text-[0.84rem] text-amber">Could not read {name}&apos;s settings.</p>;
  const changed = Object.keys(edits).length;
  const set = (s: Setting, v: string | number | boolean) =>
    setEdits((e) => {
      const next = { ...e };
      if (String(v) === String(s.value)) delete next[s.id];
      else next[s.id] = v;
      return next;
    });
  return (
    <section className="space-y-4" aria-label={`${name} settings`}>
      <ApproveDialog c={act} />
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Find a setting</span>
          <Search
            strokeWidth={1.5}
            className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-faint"
          />
          <input
            className={cx(input, "w-full pl-8")}
            placeholder="Find a setting"
            value={find}
            onChange={(e) => setFind(e.target.value)}
            data-hearth-target="settings:find"
          />
        </label>
        <label className="inline-flex min-h-9 items-center gap-2 text-[0.8rem] text-muted">
          <input
            type="checkbox"
            checked={advanced}
            onChange={(e) => setAdvanced(e.target.checked)}
            data-hearth-target="settings:advanced"
          />
          Show advanced
        </label>
      </div>
      {groups.map(([group, list]) => (
        <div key={group} data-testid="plex-setting-group">
          <p className="eyebrow mb-1">{GROUPS[group] ?? group}</p>
          <ul className="divide-y divide-line">
            {list.map((s) => {
              const value = s.id in edits ? edits[s.id] : s.value;
              return (
                <li
                  key={s.id}
                  className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5"
                  data-testid="plex-setting"
                  data-setting={s.id}
                >
                  <span className="min-w-0 flex-1">
                    <span className="inline-flex items-center gap-1.5 text-[0.86rem] text-ink">
                      {s.label}
                      {s.locked && (
                        <Lock
                          strokeWidth={1.5}
                          className="h-3.5 w-3.5 text-faint"
                          aria-label="Changed in Plex only"
                        />
                      )}
                    </span>
                    {s.summary && (
                      <span className="block text-[0.76rem] text-faint">{s.summary}</span>
                    )}
                  </span>
                  <span className="shrink-0">
                    {s.locked ? (
                      <span className="text-[0.8rem] text-muted">
                        {s.value === undefined
                          ? "set in Plex"
                          : s.type === "bool"
                            ? s.value
                              ? "On"
                              : "Off"
                            : String(s.value || "(empty)")}
                      </span>
                    ) : s.type === "bool" ? (
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
                        inputMode={s.type === "int" || s.type === "double" ? "numeric" : undefined}
                        value={String(value ?? "")}
                        onChange={(e) => set(s, e.target.value)}
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
                "app-plex-control",
                { op: "set-settings", preferences: JSON.stringify(edits) },
                changed === 1 ? "Change a Plex setting" : `Change ${changed} Plex settings`,
              )
              .then(() => setEdits({}))
          }
        >
          {changed ? `Review ${changed} ${changed === 1 ? "change" : "changes"}` : "Review changes"}
        </Button>
        <span className="text-[0.76rem] text-faint">
          Network, remote access and anything with a password stay in Plex (locked).
        </span>
        <InPlex serviceId={serviceId} path="/web/index.html#!/settings/server">
          Open in Plex
        </InPlex>
      </div>
    </section>
  );
}

interface ManageRow {
  id: string;
  title: string;
  recommended: boolean;
  home: boolean;
  shared: boolean;
}
interface ManageView {
  sections: { id: string; title: string; type?: string }[];
  section?: string;
  rows: ManageRow[];
  rowsError?: string;
  merge: boolean | null;
}
type Place = "recommended" | "home" | "shared";
const PLACES: { id: Place; label: string; short: string; hint: string }[] = [
  {
    id: "recommended",
    label: "Library Recommended",
    short: "Recommended",
    hint: "Shows on the library's own Recommended page",
  },
  { id: "home", label: "Home", short: "Home", hint: "Shows on your Home screen" },
  {
    id: "shared",
    label: "Friends' Home",
    short: "Friends",
    hint: "Shows on the Home screen of people you share with",
  },
];
const LIB_ICON: Record<string, typeof Film> = {
  movie: Film,
  show: Tv,
  artist: Music,
  photo: Image,
};

/**
 * Manage (the owner, 2026-11-02): Plex's Manage Libraries page in Hearth. The libraries (scan one
 * or all), Merge Recently Added Items, and each library's rows: where each shows (Library
 * Recommended, Home, Friends' Home) and in what order. Changes collect here and go to Plex as one
 * plan you approve. Sharing stays in Plex for now (it needs plex.tv), linked from here.
 */
export function PlexManage({ serviceId, name }: AppViewProps) {
  const [section, setSection] = useState<string>();
  const q = usePlex<ManageView>(serviceId, "manage", { section });
  const act = useApproveHere(serviceId, "From Plex's Manage tab.");
  if (q.isLoading) return <Skeleton className="h-48" />;
  if (q.error || !q.data)
    return <p className="text-[0.84rem] text-amber">Could not read {name}&apos;s libraries.</p>;
  const d = q.data;
  const current = d.sections.find((s) => s.id === d.section);
  return (
    <section className="space-y-5" aria-label={`Manage ${name}`} data-testid="plex-manage">
      <ApproveDialog c={act} />
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <p className="eyebrow mr-auto">
            {d.sections.length} {d.sections.length === 1 ? "library" : "libraries"}
          </p>
          <button
            type="button"
            className={btn}
            disabled={act.busy || !d.sections.length}
            data-hearth-target="manage:scan-all"
            onClick={() =>
              void act.propose(
                "app-plex-control",
                { op: "scan-all" },
                `Scan all libraries in ${name}`,
              )
            }
          >
            <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" /> Scan all
          </button>
          <InPlex serviceId={serviceId} path="/web/index.html#!/settings/server">
            Add a library in Plex
          </InPlex>
        </div>
        <ul
          className="divide-y divide-line rounded-xl border border-line"
          data-testid="plex-libraries"
        >
          {d.sections.map((s) => {
            const Icon = LIB_ICON[s.type ?? ""] ?? Film;
            const on = s.id === d.section;
            return (
              <li
                key={s.id}
                className="flex items-center gap-2 px-2 py-1"
                data-testid="plex-library"
              >
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => setSection(s.id)}
                  className={cx(
                    "flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 text-left text-[0.88rem]",
                    on ? "text-gold" : "text-ink hover:text-gold",
                  )}
                  data-hearth-target={`manage:library:${s.id}`}
                >
                  <Icon strokeWidth={1.5} className="h-4 w-4 shrink-0" />
                  <span className="truncate">{s.title}</span>
                  {on && <span className="text-[0.72rem] text-faint">rows below</span>}
                </button>
                <button
                  type="button"
                  className={btn}
                  disabled={act.busy}
                  data-hearth-target={`manage:library:${s.id}:scan`}
                  onClick={() =>
                    void act.propose(
                      "app-plex-control",
                      { op: "scan-library", libraryId: s.id },
                      `Scan ${s.title}`,
                    )
                  }
                >
                  Scan
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {d.merge !== null && (
        <label
          className="flex items-start gap-2.5 text-[0.86rem] text-ink"
          data-hearth-target="manage:merge"
        >
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 accent-[var(--color-gold)]"
            checked={d.merge}
            disabled={act.busy}
            data-testid="plex-merge"
            onChange={(e) =>
              void act.propose(
                "app-plex-control",
                { op: "merge-recent", on: e.target.checked },
                `Turn ${e.target.checked ? "on" : "off"} Merge Recently Added Items`,
              )
            }
          />
          <span>
            Merge Recently Added Items
            <span className="block text-[0.76rem] text-faint">
              Recently added from libraries of the same type show as one row on Home. Only libraries
              pinned in the app&apos;s sidebar are merged.
            </span>
          </span>
        </label>
      )}
      <HomeRowsLink serviceId={serviceId} />
      {current && (
        <ManageRows
          // A fresh copy of the rows each time Plex's change: nothing stale stays staged.
          key={`${current.id}:${d.rows.map((r) => `${r.id}${+r.recommended}${+r.home}${+r.shared}`).join("|")}`}
          library={current}
          rows={d.rows}
          error={d.rowsError}
          serviceId={serviceId}
          act={act}
        />
      )}
      <PlexAccess serviceId={serviceId} />
    </section>
  );
}

/** Home rows (design "Home Rows: design for DC"): design your own rows, in their own panel. */
function HomeRowsLink({ serviceId }: { serviceId: string }) {
  const href = usePanelHref()("tool:home-rows", serviceId);
  if (!href) return null;
  return (
    <p className="text-[0.82rem] text-muted">
      Want a row of your own, like 80s horror nobody has watched?{" "}
      <Link
        to={href}
        className="text-gold underline-offset-2 hover:underline"
        data-testid="plex-home-rows"
      >
        Design it in Home rows
      </Link>
    </p>
  );
}

interface Friend {
  id: string;
  name: string;
  username?: string;
  thumb?: string;
  home: boolean;
  restricted: boolean;
  pending: boolean;
  allLibraries: boolean;
  libraries: string[];
  numLibraries: number;
}

/**
 * Who has access (the owner, 2026-11-02), as Plex's Manage Library Access page: each friend or
 * Home member and the libraries they can see, read from plex.tv with this server's own token.
 * Changing who sees what stays in Plex for now, linked here.
 */
function PlexAccess({ serviceId }: { serviceId: string }) {
  const q = usePlex<{ server: string; friends: Friend[] }>(serviceId, "access");
  const [open, setOpen] = useState<string>();
  return (
    <div className="rounded-xl border border-line p-3 text-[0.84rem]" data-testid="plex-access">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-ink">Who has access</p>
        <InPlex serviceId={serviceId} path="/web/index.html#!/settings/manage-library-access">
          Change sharing in Plex
        </InPlex>
      </div>
      {q.isLoading ? (
        <Skeleton className="mt-2 h-16" />
      ) : q.error || !q.data ? (
        <p className="mt-1 text-[0.8rem] text-amber">
          Could not read who has access
          {q.error instanceof Error ? `: ${q.error.message}` : "."}
        </p>
      ) : q.data.friends.length === 0 ? (
        <p className="mt-1 text-[0.8rem] text-muted">
          Nobody else has access to {q.data.server} yet.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-line" data-testid="plex-friends">
          {q.data.friends.map((f) => {
            const what = f.home
              ? f.restricted
                ? "Managed user in your Plex Home"
                : "In your Plex Home"
              : f.allLibraries
                ? "All libraries"
                : `${f.numLibraries || f.libraries.length} ${
                    (f.numLibraries || f.libraries.length) === 1 ? "library" : "libraries"
                  }`;
            return (
              <li key={f.id} className="py-2" data-testid="plex-friend">
                <button
                  type="button"
                  className="flex w-full items-center gap-3 text-left"
                  aria-expanded={open === f.id}
                  disabled={!f.libraries.length}
                  onClick={() => setOpen(open === f.id ? undefined : f.id)}
                >
                  <span
                    aria-hidden
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gold/15 text-[0.8rem] text-gold uppercase"
                  >
                    {f.name.slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ink">{f.name}</span>
                    {f.username && f.username !== f.name && (
                      <span className="block truncate text-[0.74rem] text-faint">{f.username}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-right text-[0.78rem] text-muted">
                    {what}
                    {f.pending && <span className="block text-amber">Invite not accepted yet</span>}
                  </span>
                </button>
                {open === f.id && f.libraries.length > 0 && (
                  <p className="mt-1.5 pl-11 text-[0.78rem] text-muted">{f.libraries.join(", ")}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ManageRows({
  library,
  rows,
  error,
  serviceId,
  act,
}: {
  library: { id: string; title: string };
  rows: ManageRow[];
  error?: string;
  serviceId: string;
  act: ReturnType<typeof useApproveHere>;
}) {
  const [draft, setDraft] = useState<ManageRow[]>(rows);
  const changed = draft.filter((r) => {
    const was = rows.find((x) => x.id === r.id)!;
    return PLACES.some((p) => r[p.id] !== was[p.id]);
  });
  const reordered = draft.some((r, i) => r.id !== rows[i]?.id);
  const dirty = changed.length > 0 || reordered;
  const set = (id: string, place: Place, v: boolean) =>
    setDraft((d) => d.map((r) => (r.id === id ? { ...r, [place]: v } : r)));
  const move = (i: number, by: -1 | 1) =>
    setDraft((d) => {
      const n = [...d];
      const [r] = n.splice(i, 1);
      n.splice(i + by, 0, r!);
      return n;
    });
  const all = (place: Place) => draft.length > 0 && draft.every((r) => r[place]);
  if (error)
    return (
      <div>
        <p className="eyebrow mb-1">Rows in {library.title}</p>
        <p className="text-[0.84rem] text-amber">{error}</p>
        <InPlex serviceId={serviceId} path="/web/index.html#!/settings/server">
          Open Plex
        </InPlex>
      </div>
    );
  return (
    <div data-testid="plex-rows">
      <p className="eyebrow mb-1">Rows in {library.title}</p>
      <p className="mb-2 text-[0.78rem] text-faint">
        Where each row shows, and in what order. Changes go to Plex together when you save.
      </p>
      {draft.length === 0 ? (
        <p className="text-[0.84rem] text-muted">Plex lists no rows for this library.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full sm:min-w-[30rem] text-[0.84rem]">
            <thead>
              <tr className="border-b border-line text-[0.74rem] text-muted">
                <th className="px-3 py-2 text-left font-normal">Row</th>
                {PLACES.map((p) => (
                  <th
                    key={p.id}
                    className="px-0.5 py-2 sm:w-24 sm:px-1 text-center font-normal"
                    title={p.hint}
                  >
                    <span className="hidden sm:inline">{p.label}</span>
                    <span className="sm:hidden">{p.short}</span>
                    <input
                      type="checkbox"
                      className="mx-auto mt-1 block h-3.5 w-3.5 accent-[var(--color-gold)]"
                      aria-label={`${p.label}: all rows`}
                      checked={all(p.id)}
                      onChange={(e) =>
                        setDraft((d) => d.map((r) => ({ ...r, [p.id]: e.target.checked })))
                      }
                    />
                  </th>
                ))}
                <th className="px-0.5 py-2 font-normal sm:w-20 sm:px-1">
                  <span className="sr-only">Order</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {draft.map((r, i) => (
                <tr
                  key={r.id}
                  className={cx(
                    "border-b border-line last:border-0",
                    i % 2 === 1 && "bg-raised/40",
                  )}
                  data-testid="plex-row"
                  data-row={r.id}
                >
                  <td className="px-2 py-1.5 break-words text-ink sm:px-3">{r.title}</td>
                  {PLACES.map((p) => (
                    <td key={p.id} className="text-center">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--color-gold)]"
                        aria-label={`${r.title}: ${p.label}`}
                        checked={r[p.id]}
                        onChange={(e) => set(r.id, p.id, e.target.checked)}
                        data-hearth-target={`manage:row:${r.id}:${p.id}`}
                      />
                    </td>
                  ))}
                  <td className="text-center whitespace-nowrap">
                    <button
                      type="button"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:text-gold disabled:opacity-30"
                      aria-label={`Move ${r.title} up`}
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      <ChevronUp strokeWidth={1.5} className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:text-gold disabled:opacity-30"
                      aria-label={`Move ${r.title} down`}
                      disabled={i === draft.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ChevronDown strokeWidth={1.5} className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dirty && (
        <div
          className="sticky bottom-0 mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-gold/40 bg-panel p-2.5"
          data-testid="plex-rows-save"
        >
          <span className="mr-auto text-[0.82rem] text-muted">
            {[
              changed.length &&
                `${changed.length} ${changed.length === 1 ? "row" : "rows"} changed`,
              reordered && "new order",
            ]
              .filter(Boolean)
              .join(", ")}
          </span>
          <Button onClick={() => setDraft(rows)}>Undo</Button>
          <Button
            tone="primary"
            disabled={act.busy}
            data-hearth-target="manage:rows:save"
            onClick={() =>
              void act.propose(
                "app-plex-control",
                {
                  op: "set-rows",
                  libraryId: library.id,
                  rows: JSON.stringify(
                    Object.fromEntries(
                      changed.map((r) => [
                        r.id,
                        { recommended: r.recommended, home: r.home, shared: r.shared },
                      ]),
                    ),
                  ),
                  ...(reordered ? { order: JSON.stringify(draft.map((r) => r.id)) } : {}),
                },
                `Change rows in ${library.title}`,
              )
            }
          >
            Save
          </Button>
        </div>
      )}
    </div>
  );
}
