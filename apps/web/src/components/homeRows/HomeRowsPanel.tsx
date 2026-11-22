import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Flame,
  LayoutGrid,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  Undo2,
  X,
  Zap,
} from "lucide-react";
import { JOB_DONE, type HomeRow, type StepParams } from "@dragon-control/core";
import { api, useWorkspace } from "../../data/api";
import { plexArt } from "../../data/dashboards";
import {
  useDeleteLayout,
  useHomeLayouts,
  useHomeRowOptions,
  useHomeRows,
  useLibraryOrder,
  useRenameLayout,
  useContinuePosters,
  useRowPosters,
  useSaveLayout,
  isHomeQuery,
  type HomeRowsOptions,
} from "../../data/homeRows";
import { useJobs } from "../../data/jobs";
import { JobCard } from "../cave/Progress";
import { WorkspaceFrame, type TabDef } from "../command/WorkspaceFrame";
import { appKindOf } from "../command/Diagnostics";
import { ChangeCard, useConfirmedChange } from "../dashboards/ConfirmedChange";
import { useDesk, usePanelHref } from "../desk/links";
import { ToolImage } from "../panels/ToolImage";
import { targetProps } from "../panels/targets";
import { useCave } from "../shell/cave-context";
import { Skeleton, cx } from "../ui";
import { agoWords } from "../../lib/format";
import { EmbyHomeEditor } from "./EmbyHome";
import { ScreenRow, type ScreenItem } from "./HomeScreen";
import { JellyfinScreen } from "./JellyfinScreen";
import { JellyfinHomeEditor } from "./JellyfinHome";
import { AddTitleToCollection } from "./AddTitle";
import {
  HomeSetup,
  extraAdded,
  pickedOf,
  plexKeyOf,
  rowOf,
  setupFrom,
  onHome,
  setupOf,
  setupSteps,
  type Kind,
  type Picked,
  type Setup,
} from "./HomeSetup";
import "./homeRows.css";
import { EmberMark } from "../ember/EmberMark";

/**
 * Home rows, the editor (rebuilt 11-07 from the mockup the owner chose). Left: your Home, the rows in
 * Plex's order, each with its posters, to move, take off, or choose who sees it. Right: add a row:
 * Ember for a row or a collection (a short walkthrough), Plex's own rows, every collection, ideas,
 * rows from your apps, or anything typed. Changes collect in a bar; one "Save to Plex" is one plan
 * you approve, with what it changes shown first. Plex keeps movies and shows apart, so a mixed
 * theme is one row per library.
 */

type Tab = "rows";
type Flags = { home: boolean; shared: boolean; recommended: boolean };
interface Entry {
  /** Plex's row id; for a collection that is not a row yet, the id its row will have. */
  id: string;
  title: string;
  flags: Flags;
  /** The Hearth row behind it (Ember made it). */
  hearth?: string;
  /** A collection that becomes a row when this is sent. */
  newKey?: string;
}
export type Draft = Record<string, Entry[]>;

const field =
  "min-h-10 rounded-lg border border-line-strong bg-bg px-2.5 text-[0.85rem] text-ink focus-visible:border-gold";
const chip =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-[0.8rem] text-muted hover:border-gold/60 hover:text-gold disabled:opacity-50";
const iconBtn =
  "hr-lift grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-line hover:text-ink disabled:pointer-events-none disabled:opacity-30";

const codeOf = (f: Flags) =>
  `${f.recommended ? "r" : "-"}${f.home ? "h" : "-"}${f.shared ? "s" : "-"}`;
/**
 * On your Home: Plex's own "Home" flag. A row only on Friends' Home isn't on yours (11-07:
 * Hearth listed those too, so Your Home didn't match Plex); those are listed apart.
 */
const shows = (e: Entry) => e.flags.home;
const friendsOnly = (e: Entry) => !e.flags.home && e.flags.shared;
/** Listed under a library: Continue Watching is the fixed line at the top, never a row to move (11-11). */
const listed = (e: Entry) => shows(e) && plexKeyOf(e.id) !== "inprogress";
const collectionKeyOf = (id: string) => /^custom\.collection\.\d+\.(\d+)$/.exec(id)?.[1];
const kindOf = (e: Entry) =>
  e.hearth ? "ember" : e.newKey || collectionKeyOf(e.id) ? "collection" : "plex";

/** Plex's own rows by the middle of their id (movie.recentlyadded.1), named the same everywhere. */
const PLEX_ROWS: Record<string, string> = {
  inprogress: "Continue Watching",
  ondeck: "On Deck",
  recentlyadded: "Recently Added",
  recentlyreleased: "Recently Released",
  recentlyviewed: "Recently Played",
  rediscover: "Rediscover",
  topunwatched: "Top Unwatched",
  topwatched: "Most Watched",
  recentlyaired: "Recently Aired",
  newestepisodes: "Recently Released Episodes",
};
const BADGE: Record<ReturnType<typeof kindOf>, { label: string; cls: string }> = {
  plex: { label: "Plex", cls: "bg-gold/15 text-gold-bright" },
  collection: { label: "Collection", cls: "bg-tint-violet/20 text-[#cdb6ff]" },
  ember: { label: "Ember", cls: "bg-[#ff7a3d]/15 text-[#ffab80]" },
};

const IDEAS = [
  { id: "christmas", title: "Christmas classics", sub: "The holiday favorites", dot: "#ff7a3d" },
  { id: "halloween", title: "Halloween horror", sub: "Scary season", dot: "#e3a948" },
  { id: "oscars", title: "Oscar winners", sub: "Best Picture you own", dot: "#d8b25e" },
  { id: "short", title: "Under 90 minutes", sub: "Quick watches", dot: "#5fbf7a" },
  { id: "actor", title: "One actor's movies", sub: "You name them", dot: "#6aa7ff" },
  { id: "80s", title: "80s throwbacks", sub: "A decade night", dot: "#cdb6ff" },
];

const APP_ROWS: { kind: string; app: string; title: string; ask: string }[] = [
  {
    kind: "seerr",
    app: "Seerr",
    title: "Requested by family, now ready",
    ask: "titles people requested in Seerr that are now in the library",
  },
  {
    kind: "sonarr",
    app: "Sonarr",
    title: "New episodes this week",
    ask: "shows that got new episodes this week, from Sonarr",
  },
  {
    kind: "radarr",
    app: "Radarr",
    title: "Just downloaded",
    ask: "movies Radarr downloaded in the last two weeks",
  },
  {
    kind: "tautulli",
    app: "Tautulli",
    title: "Most watched this month",
    ask: "the most watched titles on the server this month, from Tautulli",
  },
  {
    kind: "tautulli",
    app: "Tautulli",
    title: "What friends are watching",
    ask: "what the people I share with watched lately, from Tautulli",
  },
];

/** Plex's rows as the editor's starting point: every row of every library, in Plex's order. */
function draftOf(o: HomeRowsOptions): Draft {
  const d: Draft = {};
  for (const l of o.libraries)
    d[l.id] = (o.rows[l.id] ?? []).map((h) => ({
      id: h.id,
      title: h.title,
      flags: { home: h.home, shared: h.shared, recommended: h.recommended },
      ...(h.hearth ? { hearth: h.hearth } : {}),
    }));
  return d;
}

/** What one "Save to Plex" does: per library, the rows' places and order, then new rows. */
function stepsOf(
  o: HomeRowsOptions,
  was: Draft,
  now: Draft,
  skip: (lib: string, id?: string) => boolean = () => false,
): StepParams[] {
  const steps: StepParams[] = [];
  for (const l of o.libraries) {
    // Combined or separated in Home screen setup: that step changes this library's rows.
    if (skip(l.id)) continue;
    const list = now[l.id] ?? [];
    const before = was[l.id] ?? [];
    const existing = list.filter((e) => !e.newKey);
    const changed = existing.filter((e) => {
      const w = before.find((x) => x.id === e.id);
      return w && !skip(l.id, e.id) && codeOf(w.flags) !== codeOf(e.flags);
    });
    const moved = existing.map((e) => e.id).join("|") !== before.map((e) => e.id).join("|");
    if (changed.length || moved)
      steps.push({
        op: "set-rows",
        libraryId: l.id,
        rows: JSON.stringify(Object.fromEntries(changed.map((e) => [e.id, e.flags]))),
        ...(moved ? { order: JSON.stringify(existing.map((e) => e.id)) } : {}),
      });
    list.forEach((e, i) => {
      if (e.newKey)
        steps.push({
          op: "home-collection-row",
          libraryId: l.id,
          collectionKey: e.newKey,
          flags: codeOf(e.flags),
          after: i ? list[i - 1]!.id : "",
        });
    });
  }
  return steps;
}

export function HomeRowsPanel({
  tab,
  onTab,
  onClose,
}: {
  tab: string | null;
  onTab: (tab: string) => void;
  onClose: () => void;
}) {
  const ws = useWorkspace();
  const services = ws.data?.services ?? [];
  const plexes = services.filter((s) => appKindOf(s) === "plex");
  // Jellyfin and Emby: each person's home screen, in their own editors.
  const others = services.filter((s) => {
    const k = appKindOf(s);
    return k === "jellyfin" || k === "emby";
  });
  const isEmby = (id?: string) => others.some((p) => p.id === id && appKindOf(p) === "emby");
  const jellyfin = others.find((p) => p.id === tab);
  const serviceId =
    jellyfin?.id ?? plexes.find((p) => p.id === tab)?.id ?? plexes[0]?.id ?? others[0]?.id;
  const isJellyfin = Boolean(serviceId && others.some((p) => p.id === serviceId));
  const tabs: TabDef<Tab>[] = [{ id: "rows", label: "Rows" }];
  return (
    <WorkspaceFrame
      label="Home rows"
      testId="home-rows-panel"
      icon={<ToolImage id="home-rows" />}
      title="Home rows"
      subtitle="Build your home screen: add rows, arrange them, send it."
      tabs={tabs}
      tab="rows"
      onTab={() => undefined}
      onClose={onClose}
      capture={{ panel: "Home rows", tab: "rows" }}
      help={["home-rows"]}
    >
      {ws.isLoading ? (
        <Skeleton className="h-40" />
      ) : !serviceId ? (
        <p className="text-[0.9rem] text-muted" data-testid="home-rows-no-plex">
          Add Plex, Jellyfin or Emby to Hearth first; its rows show here once it is linked.
        </p>
      ) : (
        <div className="hr-panel space-y-5">
          {(plexes.length > 1 || others.length > 0) && (
            <div
              role="group"
              aria-label="Media server"
              className="flex flex-wrap items-center gap-1 rounded-xl border border-line bg-panel p-1"
            >
              {plexes.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onTab(p.id)}
                  aria-pressed={p.id === serviceId}
                  className={cx(
                    "hr-lift flex min-h-10 items-center gap-2 rounded-lg px-3 text-[0.85rem] font-semibold",
                    p.id === serviceId ? "bg-line text-ink" : "text-muted hover:text-ink",
                  )}
                >
                  <span className="h-2 w-2 rounded-full bg-[#e5a00d]" aria-hidden />
                  {p.name}
                </button>
              ))}
              {others.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onTab(p.id)}
                  aria-pressed={p.id === serviceId}
                  className={cx(
                    "hr-lift flex min-h-10 items-center gap-2 rounded-lg px-3 text-[0.85rem] font-semibold",
                    p.id === serviceId ? "bg-line text-ink" : "text-muted hover:text-ink",
                  )}
                  data-testid="home-rows-jellyfin"
                >
                  <span
                    className={cx(
                      "h-2 w-2 rounded-full",
                      appKindOf(p) === "emby" ? "bg-[#52b54b]" : "bg-[#b48cff]",
                    )}
                    aria-hidden
                  />
                  {p.name}
                </button>
              ))}
            </div>
          )}
          {isEmby(serviceId) ? (
            <EmbyHomeEditor key={serviceId} serviceId={serviceId} />
          ) : isJellyfin ? (
            <JellyfinHomeEditor key={serviceId} serviceId={serviceId} />
          ) : (
            <Editor key={serviceId} serviceId={serviceId} />
          )}
        </div>
      )}
    </WorkspaceFrame>
  );
}

/**
 * A media server's own Home tab (11-21, the owner: "we need to see the home screen and its rows",
 * the page Plex, Jellyfin and Emby open on). 11-22: the home screen itself, laid out as the server
 * shows it (rows of posters, nothing to edit), not Home rows' editor. Refresh reads it again, so
 * a row made or moved in Home rows, or a movie or show that just landed, shows here at once.
 */
export function ServerHome({
  serviceId,
  onConnect,
}: {
  serviceId: string;
  /** Opens Overview, where an app Hearth cannot read yet is connected (its key or sign-in). */
  onConnect?: () => void;
}) {
  const ws = useWorkspace();
  const service = ws.data?.services.find((s) => s.id === serviceId);
  const kind = service ? appKindOf(service) : undefined;
  const qc = useQueryClient();
  const busy = useIsFetching({ predicate: (q) => isHomeQuery(q.queryKey, serviceId) }) > 0;
  const [read, setRead] = useState(() => new Date().toISOString());
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const refresh = () => {
    void qc
      .invalidateQueries({ predicate: (q) => isHomeQuery(q.queryKey, serviceId) })
      .then(() => setRead(new Date().toISOString()));
  };
  const change = usePanelHref()("tool:home-rows", serviceId);
  // The same reads the views make (shared): when they fail, say why and how to fix it here.
  const plexRead = useHomeRowOptions(kind === "plex" ? serviceId : undefined);
  const jfRead = useQuery({
    queryKey: ["dashboard", serviceId, "jellyfin", "home", ""],
    queryFn: () =>
      api<unknown>("GET", `/api/services/${encodeURIComponent(serviceId)}/jellyfin/home`),
    enabled: kind === "jellyfin" || kind === "emby",
    retry: false,
  });
  const readError = kind === "plex" ? plexRead.error : jfRead.error;
  const name = service?.name ?? "this server";
  return (
    <div className="space-y-5" data-testid="server-home">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-[0.8rem] text-faint" data-testid="server-home-read">
          {busy ? "Reading it now…" : `Read ${agoWords(read)}.`}
        </p>
        {change && (
          <Link
            to={change}
            className="hr-lift inline-flex min-h-10 items-center gap-2 rounded-lg border border-line px-3 text-[0.85rem] font-semibold text-ink hover:border-gold/60 hover:text-gold"
            data-testid="server-home-change"
          >
            <Pencil size={15} aria-hidden />
            Change rows
          </Link>
        )}
        <button
          type="button"
          onClick={refresh}
          disabled={busy}
          className="hr-lift inline-flex min-h-10 items-center gap-2 rounded-lg border border-line px-3 text-[0.85rem] font-semibold text-ink hover:border-line-strong disabled:opacity-60"
          data-testid="server-home-refresh"
        >
          <RefreshCw
            size={15}
            className={cx(busy && "animate-spin motion-reduce:animate-none")}
            aria-hidden
          />
          Refresh
        </button>
      </div>
      {ws.isLoading ? (
        <Skeleton className="h-64" />
      ) : readError ? (
        <div className="rounded-xl border border-line p-4" data-testid="server-home-unread">
          <p className="text-[0.9rem] text-ink">
            Hearth can&apos;t read {name}&apos;s home screen yet: it needs to be connected first.
          </p>
          <p className="mt-1 text-[0.82rem] text-muted">{readError.message}</p>
          {onConnect && (
            <button
              type="button"
              onClick={onConnect}
              className="mt-3 inline-flex min-h-10 items-center rounded-lg bg-gold px-4 text-[0.86rem] font-semibold text-bg"
              data-testid="server-home-connect"
            >
              Connect {name}
            </button>
          )}
        </div>
      ) : kind === "emby" || kind === "jellyfin" ? (
        <JellyfinScreen serviceId={serviceId} />
      ) : (
        <PlexScreen serviceId={serviceId} />
      )}
    </div>
  );
}

const ROW_COUNT = 24;

/** Plex's Home, top to bottom: Continue Watching, then each library's rows in Plex's order. */
function PlexScreen({ serviceId }: { serviceId: string }) {
  const opts = useHomeRowOptions(serviceId);
  if (opts.error)
    return (
      <p className="text-[0.88rem] text-amber" role="alert">
        Plex couldn&apos;t be read: {opts.error.message}
      </p>
    );
  const o = opts.data;
  if (!o) return <Skeleton className="h-64" />;
  const setup = setupOf(o);
  const draft = opened(o, draftOf(o), setup).draft;
  const libs = o.libraries.filter(
    (l) => !setup.joins.some((j) => j.from === l.id) && (draft[l.id] ?? []).some(shows),
  );
  const cont = libs.flatMap((l) =>
    (draft[l.id] ?? [])
      .filter((e) => shows(e) && plexKeyOf(e.id) === "inprogress")
      .map((e) => ({ lib: l.id, row: e.id })),
  );
  const rows = libs.flatMap((l) =>
    (draft[l.id] ?? []).filter(listed).map((e) => ({ lib: l.id, e })),
  );
  return (
    <div className="space-y-6">
      {cont.length > 0 && <PlexContinue serviceId={serviceId} rows={cont} />}
      {rows.map(({ lib, e }) => (
        <PlexRow
          key={`${lib}-${e.id}`}
          serviceId={serviceId}
          lib={lib}
          row={e.id}
          title={e.title}
        />
      ))}
      {!cont.length && !rows.length && (
        <p className="text-[0.88rem] text-muted">Nothing is on Plex&apos;s Home right now.</p>
      )}
    </div>
  );
}

type PlexTitle = { ratingKey: string; title: string; year?: number; sub?: string; thumb?: string };
const plexItems = (serviceId: string, list: PlexTitle[]): ScreenItem[] =>
  list.map((t) => ({
    key: t.ratingKey,
    title: t.title,
    ...(t.sub ? { sub: t.sub } : t.year ? { sub: String(t.year) } : {}),
    ...(t.thumb ? { src: plexArt(serviceId, t.thumb) } : {}),
  }));

function PlexRow({
  serviceId,
  lib,
  row,
  title,
}: {
  serviceId: string;
  lib: string;
  row: string;
  title: string;
}) {
  const q = useRowPosters(serviceId, lib, row, title, [], ROW_COUNT);
  return (
    <ScreenRow
      title={title}
      loading={q.isLoading}
      items={plexItems(serviceId, q.data?.titles ?? [])}
      empty="Plex fills this row when it has something for it."
    />
  );
}

function PlexContinue({
  serviceId,
  rows,
}: {
  serviceId: string;
  rows: { lib: string; row: string }[];
}) {
  const p = useContinuePosters(serviceId, rows);
  return (
    <ScreenRow
      title="Continue Watching"
      loading={p.loading}
      items={plexItems(serviceId, p.titles)}
    />
  );
}

/** The panel's width, so it can put Home and Add side by side or as two tabs. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState<number>();
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, w };
}

function Editor({ serviceId }: { serviceId: string }) {
  const opts = useHomeRowOptions(serviceId);
  const rows = useHomeRows(serviceId);
  const { ref, w } = useWidth();
  const wide = w === undefined || w >= 740;
  const [side, setSide] = useState<"home" | "add">("home");
  return (
    <div ref={ref} className="space-y-4">
      {!wide && (
        <div
          role="tablist"
          aria-label="Home rows"
          className="flex gap-1 rounded-xl border border-line bg-panel p-1"
        >
          {(["home", "add"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={side === s}
              onClick={() => setSide(s)}
              className={cx(
                "hr-lift min-h-11 flex-1 rounded-lg text-[0.9rem] font-semibold",
                side === s ? "bg-gold text-bg" : "text-muted",
              )}
              data-testid={`home-rows-tab-${s}`}
            >
              {s === "home" ? "Your Home" : "Add a row"}
            </button>
          ))}
        </div>
      )}
      {opts.error ? (
        <p className="text-[0.88rem] text-amber" role="alert">
          Plex couldn&apos;t be read: {opts.error.message}
        </p>
      ) : !opts.data || !rows.data ? (
        <Skeleton className="h-64" />
      ) : (
        <Board
          serviceId={serviceId}
          options={opts.data}
          hearthRows={rows.data}
          wide={wide}
          side={side}
          onSide={setSide}
        />
      )}
    </div>
  );
}

/**
 * One shared Recently Added shows the same titles in every library's row: only the first stays,
 * by itself (11-10, the owner: "no one wants two posters in one row"). Also when Plex has it so.
 */
function oneAdded(o: HomeRowsOptions, base: Setup, s: Setup, d: Draft) {
  for (const lib of extraAdded(o, base, s, d)) {
    const x = rowOf(d, lib, "recentlyadded") as Entry | undefined;
    if (x) x.flags = { ...x.flags, home: false, shared: false };
  }
  return d;
}
function opened(o: HomeRowsOptions, base: Draft, setup: Setup) {
  const d = oneAdded(o, setup, setup, structuredClone(base));
  const fixed = extraAdded(o, setup, setup, base).length > 0;
  return {
    draft: fixed ? d : base,
    log: fixed ? ["Took off the duplicate Recently Added row"] : [],
  };
}

function Board({
  serviceId,
  options,
  hearthRows,
  wide,
  side,
  onSide,
}: {
  serviceId: string;
  options: HomeRowsOptions;
  hearthRows: HomeRow[];
  wide: boolean;
  side: "home" | "add";
  onSide: (s: "home" | "add") => void;
}) {
  const base = useMemo(() => draftOf(options), [options]);
  // Home screen setup (Merge Recently Added, shared Recently Released): a draft too, sent with
  // the rows in the one Save to Plex.
  const baseSetup = useMemo(() => setupOf(options), [options]);
  const [draft, setDraft] = useState(() => opened(options, base, baseSetup).draft);
  const [setup, setSetup] = useState<Setup>(baseSetup);
  const [picked, setPicked] = useState<Picked>(() => pickedOf(options, baseSetup));
  const [keep, setKeep] = useState<Partial<Record<Kind, string>>>({});
  const [log, setLog] = useState<string[]>(() => opened(options, base, baseSetup).log);
  const [flash, setFlash] = useState("");
  const [open, setOpen] = useState("");
  const [toast, setToast] = useState("");
  // Plex read again (after a send, or a change elsewhere): start from it unless you have changes.
  const [seen, setSeen] = useState(base);
  if (seen !== base) {
    setSeen(base);
    if (!log.length) {
      const o = opened(options, base, baseSetup);
      setDraft(o.draft);
      setLog(o.log);
      setSetup(baseSetup);
      setPicked(pickedOf(options, baseSetup));
      setKeep({});
    }
  }
  const qc = useQueryClient();
  const c = useConfirmedChange(serviceId);
  const status = c.job?.status;
  // Sent: your changes are Plex's now, so the bar clears and Plex is read again.
  const [handled, setHandled] = useState<string>();
  if (c.job && status === "succeeded" && handled !== c.job.id) {
    setHandled(c.job.id);
    setLog([]);
    setToast("Sent. Your Plex Home now looks like this.");
  }
  const cancel = useRef(c.cancel);
  useEffect(() => {
    cancel.current = c.cancel;
  });
  useEffect(() => {
    if (status !== "succeeded" && status !== "failed" && status !== "partial") return;
    for (const key of ["home-rows-options", "home-rows", "home-layouts", "home-rows-posters"])
      void qc.invalidateQueries({ queryKey: [key] });
    if (status !== "succeeded") return;
    const t = setTimeout(() => void cancel.current(), 1200);
    return () => clearTimeout(t);
  }, [status, qc]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  const flashT = useRef<ReturnType<typeof setTimeout>>(undefined);

  const act = (text: string, fn: (d: Draft) => void, glow?: string) => {
    setDraft((d) => {
      const next = structuredClone(d);
      fn(next);
      return next;
    });
    setLog((l) => [...l, text]);
    if (glow) {
      setFlash(glow);
      clearTimeout(flashT.current);
      flashT.current = setTimeout(() => setFlash(""), 2600);
    }
    if (!wide) onSide("home");
  };
  const libName = (id: string) => options.libraries.find((l) => l.id === id)?.title ?? "Library";

  const move = (lib: string, id: string, dir: -1 | 1) => {
    const list = draft[lib] ?? [];
    const vis = list.filter(listed);
    const i = vis.findIndex((e) => e.id === id);
    const other = vis[i + dir];
    if (!other) return;
    act(`Moved “${vis[i]!.title}” ${dir < 0 ? "up" : "down"}`, (d) => {
      const l = d[lib]!;
      const a = l.findIndex((e) => e.id === id);
      const b = l.findIndex((e) => e.id === other.id);
      [l[a], l[b]] = [l[b]!, l[a]!];
    });
  };
  const takeOff = (lib: string, e: Entry) =>
    act(`Took “${e.title}” off Home`, (d) => {
      const l = d[lib]!;
      const i = l.findIndex((x) => x.id === e.id);
      if (e.newKey) l.splice(i, 1);
      else l[i]!.flags = { ...l[i]!.flags, home: false, shared: false };
    });
  const setFlags = (lib: string, e: Entry, flags: Flags, text: string) =>
    act(text, (d) => {
      const x = d[lib]!.find((y) => y.id === e.id);
      if (x) x.flags = flags;
    });
  /** A row that exists in Plex: shown on Home, first in its library. */
  const addRow = (lib: string, id: string, title: string) =>
    act(
      `Added “${title}” to ${libName(lib)}`,
      (d) => {
        const l = d[lib]!;
        const i = l.findIndex((e) => e.id === id);
        const [e] = l.splice(i, 1);
        l.unshift({ ...e!, flags: { ...e!.flags, home: true } });
      },
      id,
    );
  const addCollection = (lib: string, key: string, title: string) => {
    const has = (draft[lib] ?? []).find((e) => collectionKeyOf(e.id) === key);
    if (has) return addRow(lib, has.id, title);
    const id = `custom.collection.${lib}.${key}`;
    act(
      `Added the collection “${title}”`,
      (d) => {
        d[lib]!.unshift({
          id,
          title,
          newKey: key,
          flags: { home: true, shared: false, recommended: false },
        });
      },
      id,
    );
  };

  const showRow = (d: Draft, lib: string, key: string, on: boolean) => {
    const x = rowOf(d, lib, key) as Entry | undefined;
    if (x) x.flags = on ? { ...x.flags, home: true } : { ...x.flags, home: false, shared: false };
  };
  // A library joining a shared row goes back to Plex's state: the combine step changes it.
  const restore = (d: Draft, lib: string) => {
    d[lib] = structuredClone(base[lib] ?? []);
  };
  const wasJoined = (lib: string) => baseSetup.joins.some((j) => j.from === lib);
  // Separating puts the other library's new-title rows back on Home (the step does it in Plex).
  const reopen = (d: Draft, lib: string) => {
    restore(d, lib);
    if (!wasJoined(lib)) return;
    showRow(d, lib, "recentlyadded", true);
    showRow(d, lib, "recentlyreleased", true);
  };
  // Tapping a library in or out: the rows below change at once (a library merged into another
  // leaves Home; one taken out comes back with its new-title rows).
  const applySetup = (
    text: string,
    nextPicked: Picked,
    nextKeep: typeof keep,
    nextMerge: boolean | null = setup.merge,
  ) => {
    const next = setupFrom(options, baseSetup, nextPicked, nextKeep, nextMerge);
    const prev = setup;
    setPicked(nextPicked);
    setKeep(nextKeep);
    setSetup(next);
    const into = next.joins.map((j) => j.into);
    act(
      text,
      (d) => {
        for (const j of next.joins)
          if (!prev.joins.some((x) => x.from === j.from)) restore(d, j.from);
        for (const j of prev.joins)
          if (!next.joins.some((x) => x.from === j.from)) reopen(d, j.from);
        for (const k of new Set(into)) {
          showRow(d, k, "recentlyadded", true);
          showRow(d, k, "recentlyreleased", true);
        }
        // Back to a row per library: each library on Home gets its Recently Added back.
        if (prev.merge && !next.merge)
          for (const t of ["movie", "show"] as Kind[])
            for (const l of onHome(options, baseSetup, next, t))
              showRow(d, l.id, "recentlyadded", true);
        oneAdded(options, baseSetup, next, d);
      },
      into[0] ? rowOf(draft, into[0], "recentlyreleased")?.id : undefined,
    );
  };
  const setupOps = {
    onToggle: (type: Kind, lib: string) => {
      const on = picked[type].includes(lib);
      // In the sidebar's order, so the first one picked is the natural one to show the rows.
      const list = on
        ? picked[type].filter((x) => x !== lib)
        : options.libraries.map((l) => l.id).filter((x) => x === lib || picked[type].includes(x));
      applySetup(
        on ? `${libName(lib)}: not merged` : `${libName(lib)}: merged`,
        { ...picked, [type]: list },
        keep,
      );
    },
    onKeeper: (type: Kind, lib: string) =>
      applySetup(`Merged rows show in ${libName(lib)}`, picked, { ...keep, [type]: lib }),
    onDigital: (on: boolean) =>
      void c.propose(
        "app-plex-control",
        { op: "digital-dates", on },
        on ? "Sort Recently Released by home release" : "Sort Recently Released by release date",
      ),
    onDates: (into: string, from: string[]) =>
      void c.propose(
        "app-plex-control",
        { op: "merge-dates", intoId: into, fromIds: from.join(",") },
        `Put back the added dates in ${libName(into)}`,
      ),
    onMerge: (on: boolean) =>
      applySetup(
        on ? "Recently Added: one merged row" : "Recently Added: separate row for each library",
        picked,
        keep,
        on,
      ),
  };
  const setupPlan = useMemo(
    () => setupSteps(options, baseSetup, setup),
    [options, baseSetup, setup],
  );

  const removed = options.libraries.flatMap((l) =>
    (base[l.id] ?? [])
      .filter(shows)
      .filter((e) => {
        const now = draft[l.id]?.find((x) => x.id === e.id);
        return now && !shows(now);
      })
      .map((e) => ({ lib: l.id, e })),
  );
  const visibleCount = Object.values(draft).reduce((n, l) => n + l.filter(shows).length, 0);
  const steps = useMemo(
    () => [
      ...setupPlan.before,
      ...stepsOf(options, base, draft, setupPlan.skip),
      ...setupPlan.after,
    ],
    [options, base, draft, setupPlan],
  );
  const pending = steps.length > 0 && log.length > 0;
  const send = () => {
    const [first, ...rest] = steps;
    if (!first) return;
    void c.propose(
      "app-plex-control",
      first,
      `Update the Plex home screen (${log.length} ${log.length === 1 ? "change" : "changes"})`,
      undefined,
      rest.map((params) => ({ kind: "app-plex-control" as const, serviceId, params })),
    );
  };
  const reviewing = Boolean(c.job && !JOB_DONE.includes(c.job.status));
  // A merge you changed but have not saved: its rows show what Plex will show after saving
  // (11-13, the owner: "if it's not showing the same thing ... my panel is useless").
  const pendingMerge = (lib: string) => {
    const of = (x: Setup) =>
      x.joins
        .filter((j) => j.into === lib)
        .map((j) => j.from)
        .sort();
    const now = of(setup);
    return now.length && now.join(",") !== of(baseSetup).join(",") ? now : undefined;
  };
  const order = useLibraryOrder();
  // A library joining a shared row leaves Home: it goes from the preview at once.
  const shown = options.libraries.filter(
    (l) => !setup.joins.some((j) => j.from === l.id) && (draft[l.id] ?? []).some(shows),
  );
  const moveLibrary = (id: string, dir: -1 | 1) => {
    const ids = options.libraries.map((l) => l.id);
    const vis = shown.map((l) => l.id);
    const other = vis[vis.indexOf(id) + dir];
    if (!other) return;
    const a = ids.indexOf(id);
    const b = ids.indexOf(other);
    [ids[a], ids[b]] = [ids[b]!, ids[a]!];
    order.mutate({ serviceId, order: ids });
  };

  const home = (
    <section
      aria-label="Your Home"
      className="min-w-0 space-y-4"
      data-testid="home-rows-home"
      {...targetProps("your-home")}
    >
      <Building serviceId={serviceId} />
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 className="font-display text-[1.25rem] font-bold text-ink">Your Home</h3>
        <span className="text-[0.8rem] text-faint">
          {visibleCount} {visibleCount === 1 ? "row" : "rows"} · in the order Plex shows them
        </span>
        <span className="basis-full text-[0.75rem] text-faint">
          Libraries go in your Plex sidebar's order: set it once with the arrows beside each library
          name.
        </span>
      </div>
      <details
        className="rounded-xl border border-gold/30 bg-bg/30 px-3 py-2"
        data-testid="home-rows-saved"
      >
        <summary className="cursor-pointer py-1 text-[0.9rem] text-gold select-none hover:text-gold-bright">
          Save this home screen, or switch to a saved one
        </summary>
        <div className="pt-2">
          <Layouts serviceId={serviceId} />
        </div>
      </details>
      <HomeSetup
        options={options}
        base={baseSetup}
        setup={setup}
        picked={picked}
        busy={reviewing}
        {...setupOps}
      />
      <ContinueRow
        serviceId={serviceId}
        rows={options.libraries.flatMap((l) =>
          (draft[l.id] ?? [])
            .filter((e) => shows(e) && plexKeyOf(e.id) === "inprogress")
            .map((e) => ({ lib: l.id, row: e.id })),
        )}
      />
      {shown.map((l, li) => {
        const list = (draft[l.id] ?? []).filter(listed);
        return (
          <div key={l.id} className="space-y-2.5" data-testid="home-rows-library">
            <div className="flex items-center gap-2.5">
              <h4 className="text-[0.75rem] font-bold tracking-[0.14em] text-muted uppercase">
                {l.title}
              </h4>
              <span className="h-px flex-1 bg-line" aria-hidden />
              {shown.length > 1 && (
                <span
                  className="flex items-center gap-0.5"
                  title="Match the order of your Plex sidebar"
                >
                  <button
                    type="button"
                    className={cx(iconBtn, "h-8 w-8")}
                    disabled={li === 0 || order.isPending}
                    onClick={() => moveLibrary(l.id, -1)}
                    aria-label={`Move the ${l.title} library up`}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className={cx(iconBtn, "h-8 w-8")}
                    disabled={li === shown.length - 1 || order.isPending}
                    onClick={() => moveLibrary(l.id, 1)}
                    aria-label={`Move the ${l.title} library down`}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                </span>
              )}
            </div>
            {list.map((e, i) => (
              <RowCard
                key={e.id}
                serviceId={serviceId}
                lib={l.id}
                entry={e}
                first={i === 0}
                last={i === list.length - 1}
                fresh={flash === e.id}
                open={open === e.id}
                onOpen={() => setOpen(open === e.id ? "" : e.id)}
                onUp={() => move(l.id, e.id, -1)}
                onDown={() => move(l.id, e.id, 1)}
                onRemove={() => takeOff(l.id, e)}
                onFlags={(f, text) => setFlags(l.id, e, f, text)}
                hearthRow={hearthRows.find((r) => r.id === e.hearth)}
                locked={reviewing}
                mergedWith={pendingMerge(l.id)}
              />
            ))}
          </div>
        );
      })}
      {(() => {
        const friends = options.libraries.flatMap((l) =>
          (draft[l.id] ?? []).filter(friendsOnly).map((e) => ({ l, e })),
        );
        if (!friends.length) return null;
        return (
          <details
            className="rounded-xl border border-line bg-bg/30 px-3 py-2"
            data-testid="home-rows-friends-only"
          >
            <summary className="cursor-pointer py-1 text-[0.85rem] text-muted select-none hover:text-gold">
              Only on Friends&apos; Home ({friends.length}), not on yours
            </summary>
            <ul className="space-y-1 pt-2 text-[0.82rem]">
              {friends.map(({ l, e }) => (
                <li key={`${l.id}:${e.id}`} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 text-ink">
                    {e.title} <span className="text-faint">· {l.title}</span>
                  </span>
                  <button
                    type="button"
                    className="hr-lift min-h-9 rounded-full border border-line-strong px-3 text-muted hover:border-gold hover:text-ink"
                    onClick={() =>
                      setFlags(l.id, e, { ...e.flags, home: true }, `Put “${e.title}” on your Home`)
                    }
                  >
                    Put on my Home too
                  </button>
                </li>
              ))}
            </ul>
          </details>
        );
      })()}
      {removed.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[0.8rem] text-faint">
          <span>Taken off:</span>
          {removed.map(({ lib, e }) => (
            <button
              key={e.id}
              type="button"
              className="hr-lift min-h-9 rounded-full border border-dashed border-line-strong px-3 text-muted hover:border-gold hover:text-ink"
              onClick={() => {
                const was = base[lib]!.find((x) => x.id === e.id)!;
                setFlags(lib, e, was.flags, `Put “${e.title}” back`);
              }}
            >
              <Undo2 className="mr-1 inline h-3.5 w-3.5" aria-hidden />
              {e.title}
            </button>
          ))}
        </div>
      )}
    </section>
  );

  const add = (
    <AddPanel
      serviceId={serviceId}
      options={options}
      draft={draft}
      onAddRow={addRow}
      onAddCollection={addCollection}
    />
  );

  return (
    <div className="relative">
      {wide ? (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(290px,400px)] items-start gap-5">
          {home}
          <SideScroll>{add}</SideScroll>
        </div>
      ) : side === "home" ? (
        home
      ) : (
        add
      )}

      {(pending || c.job || toast || c.error) && (
        <div className="sticky bottom-2 z-10 mt-5 space-y-2">
          {c.error && !c.job && (
            <p
              role="alert"
              className="hr-rise rounded-2xl border border-amber/50 bg-panel/95 px-4 py-3 text-[0.86rem] text-amber"
              data-testid="home-rows-error"
            >
              Plex wasn&apos;t changed: {c.error}
            </p>
          )}
          {c.job && (
            <div
              className="hr-rise max-h-[50vh] space-y-2 overflow-y-auto rounded-2xl border border-line-strong bg-panel/95 p-3 shadow-2xl backdrop-blur"
              data-testid="home-rows-review"
            >
              <PlanList c={c} testId="home-rows-plan" />
              <ChangeCard c={c} confirmLabel="Save to Plex" />
              {!reviewing && (
                <button type="button" className={chip} onClick={() => void c.cancel()}>
                  Close
                </button>
              )}
            </div>
          )}
          {pending && !reviewing && (
            <div
              className="hr-rise flex flex-wrap items-center gap-3 rounded-2xl border border-[#5a2e1a] bg-panel/95 p-2.5 pl-4 shadow-2xl backdrop-blur"
              data-testid="home-rows-bar"
            >
              <span
                key={log.length}
                className="hr-pop grid h-8 min-w-8 place-items-center rounded-full bg-[#ff7a3d] px-2 text-[0.85rem] font-extrabold text-[#1a0d05]"
              >
                {log.length}
              </span>
              <span className="min-w-0 flex-1 basis-48 truncate text-[0.85rem] text-ink/85">
                {log.length === 1 ? log[0] : `${log.at(-1)} and ${log.length - 1} more`}
              </span>
              <button
                type="button"
                className="hr-lift min-h-11 rounded-xl border border-line-strong px-3.5 text-[0.85rem] text-muted hover:text-ink"
                onClick={() => {
                  const o = opened(options, base, baseSetup);
                  setDraft(o.draft);
                  setSetup(baseSetup);
                  setPicked(pickedOf(options, baseSetup));
                  setKeep({});
                  setLog(o.log);
                }}
              >
                Undo all
              </button>
              <button
                type="button"
                className="hr-lift hr-send flex min-h-11 items-center gap-2 rounded-xl bg-[#ff7a3d] px-4 text-[0.9rem] font-bold text-[#1a0d05] disabled:opacity-50"
                onClick={send}
                disabled={c.busy}
                data-testid="home-rows-send"
              >
                Save to Plex
              </button>
            </div>
          )}
          {toast && !pending && !c.job && (
            <p
              role="status"
              className="hr-rise rounded-2xl border border-live/40 bg-[#0f2418] px-4 py-3 text-[0.88rem] text-[#d9f5e2]"
            >
              {toast}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** One row as Home shows it: its posters, and what you can do with it. */
function RowCard({
  serviceId,
  lib,
  entry: e,
  first,
  last,
  fresh,
  open,
  onOpen,
  onUp,
  onDown,
  onRemove,
  onFlags,
  hearthRow,
  locked,
  mergedWith,
}: {
  serviceId: string;
  lib: string;
  /** Libraries a change not saved yet merges into this one: its posters show the merged row. */
  mergedWith?: string[];
  entry: Entry;
  first: boolean;
  last: boolean;
  fresh: boolean;
  open: boolean;
  onOpen: () => void;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
  onFlags: (f: Flags, text: string) => void;
  hearthRow?: HomeRow;
  locked: boolean;
}) {
  const kind = kindOf(e);
  const badge = BADGE[kind];
  // A collection you keep by hand, or one of Ember's rows of hand-picked titles (11-11: the
  // Thanksgiving row had no +). Ember's filter rows change with their rules, so they get none.
  const handPicked =
    (kind === "collection" && !hearthRow && Boolean(collectionKeyOf(e.id))) ||
    Boolean(hearthRow?.rules.titles);
  const cave = useCave();
  const del = useConfirmedChange(serviceId);
  // A row that is a Plex collection (yours or Ember's) can be renamed; Plex's own rows cannot.
  const renameKey = collectionKeyOf(e.id) ?? hearthRow?.published?.collectionKey;
  const toggle = (k: keyof Flags, label: string) => {
    const f = { ...e.flags, [k]: !e.flags[k] };
    if (!f.home && !f.shared) return;
    onFlags(f, `“${e.title}”: ${f[k] ? "" : "not "}${label}`);
  };
  const who: { k: keyof Flags; label: string; text: string }[] = [
    { k: "home", label: "Me", text: "on your Home" },
    { k: "shared", label: "Friends", text: "on Friends' Home" },
    { k: "recommended", label: "In the library", text: "in the library's own page" },
  ];
  return (
    <article
      className={cx(
        "hr-row space-y-3 rounded-2xl border bg-panel p-3.5 transition-colors",
        open ? "border-gold" : "border-line hover:border-line-strong",
        fresh && "hr-new",
      )}
      data-testid="home-row"
      {...targetProps(`row:${e.title.toLowerCase()}`)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={cx("rounded-md px-2 py-0.5 text-[0.68rem] font-bold", badge.cls)}>
          {badge.label}
        </span>
        <h5 className="min-w-0 flex-1 basis-40 truncate text-[0.98rem] font-semibold text-ink">
          {e.title}
        </h5>
        {fresh && (
          <span className="hr-pop rounded-full bg-[#ff7a3d] px-2 py-0.5 text-[0.65rem] font-extrabold text-[#1a0d05]">
            NEW
          </span>
        )}
        <div className="flex gap-0.5">
          <button
            type="button"
            className={iconBtn}
            onClick={onUp}
            disabled={first || locked}
            aria-label={`Move ${e.title} up`}
          >
            <ArrowUp className="h-[18px] w-[18px]" />
          </button>
          <button
            type="button"
            className={iconBtn}
            onClick={onDown}
            disabled={last || locked}
            aria-label={`Move ${e.title} down`}
          >
            <ArrowDown className="h-[18px] w-[18px]" />
          </button>
          {handPicked && (
            <button
              type="button"
              className={iconBtn}
              onClick={() => !open && onOpen()}
              disabled={locked}
              aria-label={`Add a title to ${e.title}`}
              title="Add a title"
              data-testid="home-row-add-title"
            >
              <Plus className="h-[18px] w-[18px]" />
            </button>
          )}
          <button
            type="button"
            className={cx(iconBtn, open && "bg-line text-ink")}
            onClick={onOpen}
            aria-expanded={open}
            aria-label={`Settings for ${e.title}`}
          >
            <SlidersHorizontal className="h-[18px] w-[18px]" />
          </button>
          <button
            type="button"
            className={cx(iconBtn, "hover:bg-bad/20 hover:text-bad")}
            onClick={onRemove}
            disabled={locked}
            aria-label={`Take ${e.title} off Home`}
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>
      </div>
      <Posters
        serviceId={serviceId}
        lib={lib}
        row={e.id}
        title={e.title}
        merged={/\.(recentlyadded|recentlyreleased)(\.\d+)?$/.test(e.id) ? mergedWith : undefined}
      />
      {open && (
        <div className="hr-rise grid gap-3 rounded-xl border border-line bg-bg/60 p-3 sm:grid-cols-2">
          {renameKey && (
            <RenameRow
              serviceId={serviceId}
              collectionKey={renameKey}
              name={e.title}
              locked={locked}
            />
          )}
          <div className="space-y-2">
            <p className="text-[0.72rem] font-bold tracking-wider text-muted uppercase">
              Who sees it
            </p>
            <div className="flex flex-wrap gap-1.5">
              {who.map((x) => (
                <button
                  key={x.k}
                  type="button"
                  aria-pressed={e.flags[x.k]}
                  disabled={locked}
                  onClick={() => toggle(x.k, x.text)}
                  className={cx(
                    "hr-lift min-h-9 rounded-full border px-3.5 text-[0.8rem] font-semibold",
                    e.flags[x.k]
                      ? "border-gold bg-gold/15 text-ink"
                      : "border-line-strong text-muted hover:text-ink",
                  )}
                >
                  {x.label}
                </button>
              ))}
            </div>
            <p className="text-[0.75rem] text-faint">
              Plex rows are shared: everyone using this library sees the same Home.
            </p>
          </div>
          {handPicked && (
            <AddTitleToCollection
              serviceId={serviceId}
              libraryId={lib}
              collection={e.title}
              {...(hearthRow?.rules.titles ? { rowId: hearthRow.id } : {})}
            />
          )}
          {hearthRow && (
            <div className="space-y-2">
              <p className="text-[0.72rem] font-bold tracking-wider text-muted uppercase">
                Made by Ember
              </p>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  className={chip}
                  onClick={() =>
                    cave.ask(
                      `Change the titles in my Plex home row “${hearthRow.name}” (Home row ${hearthRow.id}): open them in the Forge with its titles selected.`,
                    )
                  }
                >
                  <Pencil className="h-4 w-4" /> Change titles with Ember
                  <EmberMark />
                </button>
                {hearthRow.undoable && (
                  <button
                    type="button"
                    className={cx(chip, "hover:border-bad/60 hover:text-bad")}
                    disabled={del.busy}
                    onClick={() =>
                      void del.propose(
                        "app-plex-control",
                        { op: "home-row-undo", rowId: hearthRow.id },
                        `Delete the row “${hearthRow.name}” and its collection`,
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4" /> Delete row and collection
                  </button>
                )}
              </div>
              <ChangeCard c={del} confirmLabel="Delete it" />
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/** The row's name, changed in place: one approved plan renames its collection on Plex (11-19). */
function RenameRow({
  serviceId,
  collectionKey,
  name,
  locked,
}: {
  serviceId: string;
  collectionKey: string;
  name: string;
  locked: boolean;
}) {
  const [value, setValue] = useState(name);
  const c = useConfirmedChange(serviceId);
  // Once Plex reads back the new name, the box shows it (adjusted while rendering, not in an effect).
  const [shown, setShown] = useState(name);
  if (shown !== name) {
    setShown(name);
    setValue(name);
  }
  const next = value.replace(/\s+/g, " ").trim();
  const ready = Boolean(next) && next !== name && !locked && !c.busy;
  const go = () => {
    if (!ready) return;
    void c.propose(
      "app-plex-control",
      { op: "collection-rename", collectionKey, collection: next },
      `Rename “${name}” to “${next}”`,
    );
  };
  return (
    <div className="space-y-2 sm:col-span-2" data-testid="home-row-rename">
      <label
        className="block text-[0.72rem] font-bold tracking-wider text-muted uppercase"
        htmlFor={`rename-${collectionKey}`}
      >
        Row name
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id={`rename-${collectionKey}`}
          value={value}
          maxLength={120}
          disabled={locked}
          onChange={(ev) => setValue(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") go();
            if (ev.key === "Escape") setValue(name);
          }}
          className="min-h-10 min-w-0 flex-1 basis-56 rounded-lg border border-line-strong bg-raised px-2.5 text-[0.9rem] text-ink outline-none focus:border-gold"
        />
        <button type="button" className={chip} disabled={!ready} onClick={go}>
          <Pencil className="h-4 w-4" /> Rename
        </button>
      </div>
      <ChangeCard c={c} confirmLabel="Rename it" />
    </div>
  );
}

const TILE = [
  "bg-[#3b1d2a] text-[#ffb3c7]",
  "bg-[#1d2f4a] text-[#a9cbff]",
  "bg-[#2a2a12] text-[#f0e48a]",
  "bg-[#13322a] text-[#8fe3c4]",
  "bg-[#331f12] text-[#ffbf8f]",
  "bg-[#251a3b] text-[#cdb6ff]",
];

/** Continue Watching: Plex always puts it first, across every library, so it is a fixed row (11-11). */
function ContinueRow({
  serviceId,
  rows,
}: {
  serviceId: string;
  rows: { lib: string; row: string }[];
}) {
  const p = useContinuePosters(serviceId, rows);
  return (
    <article
      className="space-y-3 rounded-2xl border border-line bg-panel p-3.5"
      data-testid="home-rows-continue"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={cx("rounded-md px-2 py-0.5 text-[0.68rem] font-bold", BADGE.plex.cls)}>
          Plex
        </span>
        <h5 className="min-w-0 flex-1 basis-40 truncate text-[0.98rem] font-semibold text-ink">
          Continue Watching
        </h5>
        <span className="inline-flex items-center gap-1 rounded-full bg-line px-2.5 py-1 text-[0.72rem] font-bold text-muted">
          <Lock className="h-3 w-3" aria-hidden /> Always first
        </span>
      </div>
      {p.loading ? (
        <div className="hr-strip flex gap-2.5 overflow-hidden" aria-hidden>
          {Array.from({ length: 7 }, (_, i) => (
            <span
              key={i}
              className="aspect-[2/3] w-[86px] shrink-0 animate-pulse rounded-lg bg-raised"
            />
          ))}
        </div>
      ) : p.titles.length ? (
        <div
          className="hr-strip flex gap-2.5 overflow-hidden"
          aria-label="Some of Continue Watching"
        >
          {p.titles.slice(0, 9).map((x, i) => (
            <Poster
              key={`${x.ratingKey}-${i}`}
              serviceId={serviceId}
              t={x}
              tone={TILE[i % TILE.length]!}
            />
          ))}
        </div>
      ) : null}
      <p className="text-[0.78rem] text-faint">
        Plex puts this row first on Home, with what you are watching from every library. It can't be
        moved.
      </p>
    </article>
  );
}

/**
 * The side panel scrolls on its own, beside the rows (11-11, the owner: "2 scroll bars one for
 * the side panel and one for the rows"). It is as tall as the panel's visible area, so its
 * bottom is always reachable.
 */
function SideScroll({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number>();
  useEffect(() => {
    let p = ref.current?.parentElement ?? null;
    while (p && !/(auto|scroll)/.test(getComputedStyle(p).overflowY)) p = p.parentElement;
    if (!p) return;
    const box = p;
    const fit = () => setH(Math.max(240, box.clientHeight - 16));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className="sticky top-2 overflow-y-auto overscroll-contain pr-1"
      style={{ maxHeight: h }}
      data-testid="home-rows-side"
    >
      {children}
    </div>
  );
}

function Posters({
  serviceId,
  lib,
  row,
  title,
  merged,
}: {
  serviceId: string;
  lib: string;
  row: string;
  title: string;
  merged?: string[];
}) {
  const q = useRowPosters(serviceId, lib, row, title, merged);
  const list = q.data?.titles ?? [];
  if (q.isLoading)
    return (
      <div className="hr-strip flex gap-2.5 overflow-hidden" aria-hidden>
        {Array.from({ length: 7 }, (_, i) => (
          <span
            key={i}
            className="aspect-[2/3] w-[86px] shrink-0 animate-pulse rounded-lg bg-raised"
          />
        ))}
      </div>
    );
  if (!list.length)
    return (
      <p className="text-[0.78rem] text-faint">
        Plex fills this row when it shows it ({title.toLowerCase()}).
      </p>
    );
  return (
    <div className="hr-strip flex gap-2.5 overflow-hidden" aria-label={`Some of ${title}`}>
      {list.slice(0, 9).map((t, i) => (
        <Poster
          key={`${t.ratingKey}-${i}`}
          serviceId={serviceId}
          t={t}
          tone={TILE[i % TILE.length]!}
        />
      ))}
    </div>
  );
}

function Poster({
  serviceId,
  t,
  tone,
}: {
  serviceId: string;
  t: { title: string; thumb?: string };
  tone: string;
}) {
  const [failed, setFailed] = useState(false);
  return t.thumb && !failed ? (
    <img
      src={plexArt(serviceId, t.thumb)}
      alt={t.title}
      title={t.title}
      loading="lazy"
      onError={() => setFailed(true)}
      className="aspect-[2/3] w-[86px] shrink-0 rounded-lg border border-line object-cover"
      data-testid="row-poster"
    />
  ) : (
    <span
      className={cx(
        "flex aspect-[2/3] w-[86px] shrink-0 items-end rounded-lg border border-white/5 p-2 text-[0.72rem] leading-tight font-bold",
        tone,
      )}
      data-testid="row-poster"
    >
      {t.title}
    </span>
  );
}

/** Home-row plans waiting or running (or just finished): Ember's row being put together, live. */
function Building({ serviceId }: { serviceId: string }) {
  const jobs = useJobs();
  const [opened] = useState(() => Date.now() - 10 * 60_000);
  // Plans for this Plex's home rows made elsewhere (Ember's): the panel's own show in place.
  const list = (jobs.data ?? []).filter(
    (j) =>
      j.reason !== "From the app's panel in Hearth." &&
      j.steps.some(
        (s) =>
          s.kind === "app-plex-control" &&
          s.serviceId === serviceId &&
          /^home-(row|layout|collection)-/.test(String(s.params?.op ?? "")),
      ) &&
      (!JOB_DONE.includes(j.status) || Date.parse(j.finishedAt ?? j.createdAt) > opened),
  );
  const qc = useQueryClient();
  const done = list
    .filter((j) => JOB_DONE.includes(j.status))
    .map((j) => j.id)
    .join(",");
  useEffect(() => {
    if (!done) return;
    for (const key of ["home-rows", "home-rows-options", "home-layouts", "home-rows-posters"])
      void qc.invalidateQueries({ queryKey: [key] });
  }, [done, qc]);
  if (!list.length) return null;
  return (
    <section className="space-y-2" aria-label="Being built" data-testid="home-rows-building">
      {list.some((j) => !JOB_DONE.includes(j.status)) && (
        <h3 className="flex items-center gap-2 font-display text-[1rem] text-[#ffab80]">
          <Flame className="hr-flame h-4 w-4" aria-hidden /> Ember is building
        </h3>
      )}
      {list
        .filter((j) => !JOB_DONE.includes(j.status))
        .slice(0, 3)
        .map((j) => (
          <JobCard key={j.id} id={j.id} inRows />
        ))}
      {list
        .filter((j) => JOB_DONE.includes(j.status))
        .slice(0, 3)
        .map((j) => (
          <p
            key={j.id}
            className={cx(
              "hr-rise flex items-center gap-2 rounded-xl border px-3 py-2 text-[0.85rem]",
              j.status === "succeeded"
                ? "border-live/40 bg-live/10 text-ink"
                : "border-amber/40 bg-amber/10 text-ink",
            )}
          >
            <span aria-hidden>{j.status === "succeeded" ? "✓" : "!"}</span>
            <span className="min-w-0 flex-1 truncate">
              {j.title.replace(/^Put /, "").replace(/ on the Plex home screen$/, "")}:{" "}
              {j.status === "succeeded" ? "done, on Plex now" : (j.summary ?? "did not finish")}
            </span>
          </p>
        ))}
    </section>
  );
}

/** The right half: everything that can become a row. */
function AddPanel({
  serviceId,
  options,
  draft,
  onAddRow,
  onAddCollection,
}: {
  serviceId: string;
  options: HomeRowsOptions;
  draft: Draft;
  onAddRow: (lib: string, id: string, title: string) => void;
  onAddCollection: (lib: string, key: string, title: string) => void;
}) {
  const ws = useWorkspace();
  const cave = useCave();
  const desk = useDesk();
  const [, setParams] = useSearchParams();
  const [wiz, setWiz] = useState<{ mode: "row" | "collection"; theme?: string }>();
  const [quick, setQuick] = useState("");
  const [picked, setPicked] = useState("");
  const [search, setSearch] = useState("");
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("hearth.homeRows.dismissed") ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const dismiss = (id: string) => {
    const next = [...dismissed, id];
    setDismissed(next);
    try {
      localStorage.setItem("hearth.homeRows.dismissed", JSON.stringify(next));
    } catch {
      // Only remembered on this device.
    }
  };
  const ask = (text: string) => {
    cave.ask(text);
    // On a phone the panel fills the screen: show the conversation, where Ember answers.
    if (!desk)
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("view", "chat");
        return next;
      });
  };
  const showing = (lib: string, id: string) =>
    Boolean(draft[lib]?.find((e) => e.id === id && shows(e)));

  // Plex's own rows, by kind, with the libraries that have each.
  const quicks = new Map<string, { label: string; at: { lib: string; id: string }[] }>();
  for (const l of options.libraries)
    for (const e of draft[l.id] ?? []) {
      const k = plexKeyOf(e.id);
      if (!k) continue;
      const q = quicks.get(k) ?? { label: PLEX_ROWS[k] ?? e.title, at: [] };
      q.at.push({ lib: l.id, id: e.id });
      quicks.set(k, q);
    }
  const openQuick = quicks.get(quick);

  const collections = options.libraries
    .map((l) => ({
      l,
      items: (options.collections[l.id] ?? []).map((c) => ({
        ...c,
        on: Boolean(
          draft[l.id]?.find(
            (e) => (collectionKeyOf(e.id) === c.key || e.newKey === c.key) && shows(e),
          ),
        ),
      })),
    }))
    .filter((g) => g.items.length);
  const allCollections = collections.flatMap((g) => g.items.map((c) => ({ ...c, lib: g.l.id })));
  const pick = allCollections.find((c) => `${c.lib}:${c.key}` === picked);

  const kinds = new Set((ws.data?.services ?? []).map((s) => appKindOf(s)));
  const appRows = APP_ROWS.filter((a) => kinds.has(a.kind as never));

  const words = search.trim().toLowerCase();
  const matches = !words
    ? []
    : [
        ...allCollections
          .filter((c) => !c.on && c.title.toLowerCase().includes(words))
          .slice(0, 4)
          .map((c) => ({
            kind: "Collection",
            label: c.title,
            add: () => {
              onAddCollection(c.lib, c.key, c.title);
              setSearch("");
            },
          })),
        ...[...quicks.entries()]
          .filter(([, q]) => q.label.toLowerCase().includes(words))
          .slice(0, 2)
          .map(([k, q]) => ({
            kind: "Plex row",
            label: q.label,
            add: () => {
              setQuick(k);
              setSearch("");
            },
          })),
      ];

  const head = (icon: ReactNode, tone: string, title: string, sub: string) => (
    <div className="flex items-center gap-2">
      <span className={cx("grid h-7 w-7 place-items-center rounded-lg", tone)}>{icon}</span>
      <h4 className="text-[0.95rem] font-semibold text-ink">{title}</h4>
      <span className="text-[0.78rem] text-faint">{sub}</span>
    </div>
  );

  return (
    <aside
      aria-label="Add a row"
      className="space-y-6 rounded-3xl border border-line bg-panel p-4"
      data-testid="home-rows-add"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="flex-1 font-display text-[1.25rem] font-bold text-ink">Add a row</h3>
        <span className="text-[0.75rem] text-faint">
          Tap to add. Nothing changes until you send.
        </span>
      </div>

      {wiz ? (
        <Walkthrough
          serviceId={serviceId}
          mode={wiz.mode}
          theme={wiz.theme}
          onAsk={ask}
          onClose={() => setWiz(undefined)}
        />
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2" data-testid="home-rows-ember">
          <button
            type="button"
            className="hr-lift hr-idea flex items-center gap-3 rounded-2xl border border-[#5a2e1a] bg-[#1c120c] p-4 text-left"
            onClick={() => setWiz({ mode: "row" })}
            data-testid="home-rows-ask-go"
          >
            <span className="hr-flame grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[#ff7a3d] text-[#1a0d05]">
              <Flame className="h-5 w-5" aria-hidden />
            </span>
            <span>
              <span className="block text-[0.95rem] font-bold text-ink">Ask Ember for a row</span>
              <span className="block text-[0.78rem] text-[#c9a58f]">
                A few questions, Ember builds it
              </span>
            </span>
          </button>
          <button
            type="button"
            className="hr-lift flex items-center gap-3 rounded-2xl border border-[#3b2f66] bg-[#161229] p-4 text-left hover:border-[#8b6cff]"
            onClick={() => setWiz({ mode: "collection" })}
            data-testid="home-rows-collection-go"
          >
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[#8b6cff] text-[#0c0620]">
              <Copy className="h-5 w-5" aria-hidden />
            </span>
            <span>
              <span className="block text-[0.95rem] font-bold text-ink">Make a collection</span>
              <span className="block text-[0.78rem] text-[#b6a8e0]">On Home or not, your call</span>
            </span>
          </button>
        </div>
      )}

      {quicks.size > 0 && (
        <div className="space-y-2.5" data-testid="home-rows-quick">
          {head(
            <Zap className="h-4 w-4" aria-hidden />,
            "bg-gold/15 text-gold-bright",
            "Quick picks",
            "Plex's own rows",
          )}
          <div className="flex flex-wrap gap-2">
            {[...quicks.entries()].map(([k, q]) => (
              <button
                key={k}
                type="button"
                aria-expanded={quick === k}
                onClick={() => setQuick(quick === k ? "" : k)}
                className={cx(
                  "hr-lift min-h-10 rounded-full border px-4 text-[0.85rem] font-semibold",
                  quick === k
                    ? "border-gold bg-gold/15 text-ink"
                    : "border-line-strong bg-raised text-ink/80 hover:border-gold",
                )}
              >
                {q.label}
              </button>
            ))}
          </div>
          {openQuick && (
            <div className="hr-rise flex flex-wrap items-center gap-2 rounded-xl border border-line-strong bg-bg/60 p-3">
              <span className="text-[0.82rem] text-muted">
                “{openQuick.label}” from which library?
              </span>
              {openQuick.at.map((a) => {
                const on = showing(a.lib, a.id);
                const name = options.libraries.find((l) => l.id === a.lib)?.title ?? a.lib;
                return (
                  <button
                    key={a.id}
                    type="button"
                    disabled={on}
                    onClick={() => {
                      onAddRow(a.lib, a.id, openQuick.label);
                      setQuick("");
                    }}
                    className={cx(
                      "hr-lift min-h-10 rounded-lg px-3.5 text-[0.82rem] font-bold",
                      on ? "bg-line text-faint" : "bg-gold text-bg",
                    )}
                  >
                    {name}
                    {on ? " ✓" : ""}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="space-y-2.5" data-testid="home-rows-collections">
        {head(
          <LayoutGrid className="h-4 w-4" aria-hidden />,
          "bg-tint-violet/20 text-[#cdb6ff]",
          "Your collections",
          `${allCollections.length} on your server`,
        )}
        {allCollections.length ? (
          <div className="flex flex-wrap gap-2">
            <label className="min-w-0 flex-1 basis-52">
              <span className="sr-only">Choose a collection</span>
              <select
                className={cx(field, "min-h-11 w-full")}
                value={picked}
                onChange={(ev) => setPicked(ev.target.value)}
                data-testid="home-rows-collection"
              >
                <option value="">Choose a collection…</option>
                {collections.map((g) => (
                  <optgroup key={g.l.id} label={g.l.title}>
                    {g.items.map((c) => (
                      <option key={c.key} value={`${g.l.id}:${c.key}`} disabled={c.on}>
                        {c.title} ({c.count}){c.on ? " · on Home" : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={!pick}
              onClick={() => {
                if (!pick) return;
                onAddCollection(pick.lib, pick.key, pick.title);
                setPicked("");
              }}
              className="hr-lift min-h-11 rounded-xl bg-[#8b6cff] px-5 text-[0.88rem] font-bold text-[#0c0620] disabled:bg-line disabled:text-faint"
              data-testid="home-rows-collection-add"
            >
              Add
            </button>
          </div>
        ) : (
          <p className="text-[0.82rem] text-muted">
            No collections yet. <b className="text-ink">Make a collection</b> above and Ember builds
            one.
          </p>
        )}
      </div>

      {IDEAS.some((i) => !dismissed.includes(i.id)) && (
        <div className="space-y-2.5">
          {head(
            <Flame className="h-4 w-4" aria-hidden />,
            "bg-[#ff7a3d]/15 text-[#ffab80]",
            "Ideas",
            "Ember picks the titles",
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
            {IDEAS.filter((i) => !dismissed.includes(i.id)).map((i) => (
              <div key={i.id} className="relative">
                <button
                  type="button"
                  onClick={() => setWiz({ mode: "row", theme: i.title })}
                  className="hr-lift hr-idea flex min-h-24 w-full flex-col justify-end gap-1 rounded-2xl border border-line-strong bg-raised p-3.5 text-left"
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ background: i.dot, boxShadow: `0 0 14px ${i.dot}` }}
                    aria-hidden
                  />
                  <span className="text-[0.9rem] font-semibold text-ink">{i.title}</span>
                  <span className="text-[0.75rem] text-muted">{i.sub}</span>
                </button>
                <button
                  type="button"
                  className="absolute top-1.5 right-1.5 grid h-7 w-7 place-items-center rounded-lg text-faint hover:bg-line hover:text-ink"
                  onClick={() => dismiss(i.id)}
                  aria-label={`Hide the idea ${i.title}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {appRows.length > 0 && (
        <div className="space-y-2.5">
          {head(
            <LayoutGrid className="h-4 w-4" aria-hidden />,
            "bg-live/15 text-live",
            "From your apps",
            "Ember builds it from them",
          )}
          <div className="space-y-2">
            {appRows.map((a) => (
              <button
                key={a.title}
                type="button"
                onClick={() =>
                  ask(
                    `Make me a row on my Plex home screen (Plex service ${serviceId}) called “${a.title}”: ${a.ask}. Open your picks in the Forge so I can swap, then build it.`,
                  )
                }
                className="hr-lift hr-app flex w-full items-center gap-3 rounded-xl border border-line-strong bg-raised p-2.5 text-left"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-live/20 text-[0.9rem] font-extrabold text-live">
                  {a.app[0]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.88rem] font-semibold text-ink">{a.title}</span>
                  <span className="block text-[0.75rem] text-muted">From {a.app}</span>
                </span>
                <EmberMark />
                <Plus className="h-4 w-4 text-live" aria-hidden />
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2.5 border-t border-line pt-5">
        <label htmlFor="hr-search" className="block text-[0.95rem] font-semibold text-ink">
          Something else?
        </label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-faint"
            aria-hidden
          />
          <input
            id="hr-search"
            className={cx(field, "min-h-12 w-full rounded-xl pl-10")}
            value={search}
            onChange={(ev) => setSearch(ev.target.value)}
            placeholder="Search, or describe a row"
            data-testid="home-rows-search"
          />
        </div>
        {words && (
          <div className="hr-rise space-y-1.5">
            {matches.map((m) => (
              <button
                key={`${m.kind}-${m.label}`}
                type="button"
                onClick={m.add}
                className="hr-lift flex w-full items-center gap-3 rounded-xl border border-line-strong bg-raised px-3 py-2.5 text-left text-[0.88rem] text-ink hover:border-gold"
              >
                <span className="min-w-20 text-[0.68rem] font-bold tracking-wider text-muted uppercase">
                  {m.kind}
                </span>
                <span className="flex-1">{m.label}</span>
                <span className="font-semibold text-gold-bright">Add</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                ask(
                  `Make me a row on my Plex home screen (Plex service ${serviceId}): ${search.trim()}. Ask me anything you need first, one short question at a time, then open your picks in the Forge.`,
                );
                setSearch("");
              }}
              className="hr-lift flex w-full items-center gap-3 rounded-xl bg-[#ff7a3d] px-3.5 py-3 text-left text-[0.88rem] font-semibold text-[#1a0d05]"
            >
              <Flame className="h-4 w-4" aria-hidden />
              Ask Ember to make “{search.trim()}”
              <EmberMark className="ml-auto" />
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * Ember's walkthrough (11-07: "click ask ember ... and then get a walk thru"): a few quick
 * questions here, then one complete request to Ember, which picks the titles and lays them out
 * in the Forge; its plan shows up under "Ember is building".
 */
function Walkthrough({
  serviceId,
  mode,
  theme: preset,
  onAsk,
  onClose,
}: {
  serviceId: string;
  mode: "row" | "collection";
  theme?: string;
  onAsk: (text: string) => void;
  onClose: () => void;
}) {
  const isRow = mode === "row";
  const steps = isRow
    ? (["theme", "count", "kind"] as const)
    : (["theme", "count", "kind", "home"] as const);
  type Step = (typeof steps)[number] | "sent";
  const [step, setStep] = useState<Step>(preset ? "count" : "theme");
  const [theme, setTheme] = useState(preset ?? "");
  const [count, setCount] = useState("");
  const [kind, setKind] = useState("");
  const [home, setHome] = useState<boolean>();
  const accent = isRow ? "#ff7a3d" : "#8b6cff";
  const t = theme.trim();
  const finish = (k: string, h?: boolean) => {
    const many = count === "you decide" ? "as many as fit well" : `about ${count} titles`;
    const what = k === "both" ? "movies and shows" : k;
    onAsk(
      isRow
        ? `Make me a row on my Plex home screen (Plex service ${serviceId}): “${t}”, ${many}, ${what}. Open your picks in the Forge so I can swap, then build it.`
        : `Make me a collection on Plex (Plex service ${serviceId}): “${t}”, ${many}, ${what}. ${h ? "Put it on my Home screen too." : "Collection only: do not put it on Home."} Open your picks in the Forge so I can swap, then build it.`,
    );
    setStep("sent");
  };
  const Q: Record<Step, string> = {
    theme: isRow
      ? "What should the row be? A holiday, a mood, an actor, anything."
      : "What should the collection be? A holiday, a mood, an actor, anything.",
    count: `Got it, “${t}”. About how many titles?`,
    kind: "Movies, shows, or both?",
    home: "Put it on your Home screen too, or just keep it as a collection?",
    sent: `On it. I'm picking from your library and laying them out in the Forge beside the chat. Swap whatever you like and send them back; the ${isRow ? "row" : "collection"} shows up here for you to approve.`,
  };
  const answers = [
    step !== "theme" && t,
    count && (count === "you decide" ? "You decide" : `${count} titles`),
    kind && (kind === "both" ? "Both" : kind === "shows" ? "Shows" : "Movies"),
    home !== undefined && (home ? "On Home" : "Collection only"),
  ].filter(Boolean) as string[];
  const at = step === "sent" ? steps.length : (steps as readonly string[]).indexOf(step);
  const choice = (label: string, fn: () => void) => (
    <button
      key={label}
      type="button"
      onClick={fn}
      className="hr-lift min-h-11 rounded-xl border border-[#5a3a26] bg-[#241912] px-4 text-[0.88rem] font-semibold text-[#f3e6dc] hover:border-[#ff7a3d]"
    >
      {label}
    </button>
  );
  return (
    <div
      className="hr-rise space-y-3.5 rounded-2xl border bg-[#120d0a] p-4"
      style={{ borderColor: isRow ? "#5a2e1a" : "#3b2f66" }}
      data-testid="home-rows-walkthrough"
    >
      <div className="flex items-center gap-2">
        <span
          className="text-[0.72rem] font-bold tracking-widest uppercase"
          style={{ color: accent }}
        >
          {isRow ? "Ember · new row" : "Ember · new collection"}
        </span>
        <span className="flex flex-1 justify-center gap-1.5" aria-hidden>
          {[...steps, "sent"].map((s, i) => (
            <span
              key={s}
              className="h-2 rounded-full transition-all duration-300"
              style={{
                width: i === at ? 22 : 8,
                background: i <= at ? accent : "var(--color-line-strong)",
              }}
            />
          ))}
        </span>
        <button
          type="button"
          className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-line hover:text-ink"
          onClick={onClose}
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex items-start gap-2.5">
        <span className="hr-flame grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-[#5a2e1a] bg-[#2a1810] text-[#ff7a3d]">
          <Flame className="h-4 w-4" aria-hidden />
        </span>
        <p
          key={step}
          className="hr-rise rounded-[4px_16px_16px_16px] border border-[#3a2a20] bg-[#1d1612] px-3.5 py-2.5 text-[0.9rem] leading-relaxed text-[#f3e6dc]"
          data-testid="home-rows-question"
        >
          {Q[step]}
        </p>
      </div>
      {answers.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {answers.map((a) => (
            <span
              key={a}
              className="hr-rise rounded-[12px_12px_4px_12px] bg-gold/20 px-2.5 py-1 text-[0.78rem] text-ink"
            >
              {a}
            </span>
          ))}
        </div>
      )}
      {step === "theme" && (
        <form
          className="space-y-2.5"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (t) setStep("count");
          }}
        >
          <div className="flex gap-2">
            <label className="min-w-0 flex-1">
              <span className="sr-only">Theme</span>
              <input
                className="min-h-11 w-full rounded-xl border border-[#4a3324] bg-[#1a1411] px-3.5 text-[0.9rem] text-[#f3e6dc] placeholder:text-[#8a7466] focus-visible:border-[#ff7a3d]"
                value={theme}
                onChange={(ev) => setTheme(ev.target.value)}
                placeholder="Christmas movies, 90s comedies, anything"
                autoFocus
                data-testid="home-rows-theme"
              />
            </label>
            <button
              type="submit"
              disabled={!t}
              className="hr-lift min-h-11 rounded-xl px-4 text-[0.88rem] font-bold text-[#120a06] disabled:bg-line disabled:text-faint"
              style={t ? { background: accent } : undefined}
            >
              Next
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {["Christmas movies", "Horror night", "90s comedies", "A franchise in order"].map(
              (x) => (
                <button
                  key={x}
                  type="button"
                  onClick={() => {
                    setTheme(x);
                    setStep("count");
                  }}
                  className="hr-lift min-h-9 rounded-full border border-[#4a3324] px-3 text-[0.78rem] text-[#e2c9b8] hover:border-[#ff7a3d]"
                >
                  {x}
                </button>
              ),
            )}
          </div>
        </form>
      )}
      {step === "count" && (
        <div className="flex flex-wrap gap-2">
          {["10", "25", "50", "100"].map((n) =>
            choice(n === "50" ? "About 50" : n, () => {
              setCount(n);
              setStep("kind");
            }),
          )}
          {choice("You decide", () => {
            setCount("you decide");
            setStep("kind");
          })}
        </div>
      )}
      {step === "kind" && (
        <div className="flex flex-wrap gap-2">
          {[
            ["Movies", "movies"],
            ["Shows", "shows"],
            ["Both", "both"],
          ].map(([label, k]) =>
            choice(label!, () => {
              setKind(k!);
              if (isRow) finish(k!);
              else setStep("home");
            }),
          )}
        </div>
      )}
      {step === "home" && (
        <div className="flex flex-wrap gap-2">
          {choice("Put it on Home", () => {
            setHome(true);
            finish(kind, true);
          })}
          {choice("Just the collection", () => {
            setHome(false);
            finish(kind, false);
          })}
        </div>
      )}
      {step === "sent" && (
        <button
          type="button"
          onClick={onClose}
          className="hr-lift min-h-11 rounded-xl border border-line-strong px-4 text-[0.88rem] text-muted hover:text-ink"
        >
          Done
        </button>
      )}
    </div>
  );
}

/** The plan before it is approved: what each step changes, before anything is sent. */
function PlanList({ c, testId }: { c: ReturnType<typeof useConfirmedChange>; testId: string }) {
  if (c.job?.status !== "awaiting-approval") return null;
  const steps = c.job.steps.filter((s) => s.change?.settings.length);
  if (!steps.length) return null;
  return (
    <div className="space-y-2" data-testid={testId}>
      {steps.map((s, n) => (
        <dl
          key={n}
          className="grid grid-cols-[minmax(0,9rem)_1fr] gap-x-3 gap-y-1 rounded-lg border border-line bg-bg/60 p-3 text-[0.8rem]"
        >
          {s.change!.settings.map((x, i) => (
            <div key={i} className="contents">
              <dt className="text-faint">{x.name}</dt>
              <dd className="text-ink">
                {x.before && <span className="text-muted">{x.before} → </span>}
                {x.after}
              </dd>
            </div>
          ))}
        </dl>
      ))}
    </div>
  );
}

/**
 * Saved home screens (11-06: "build one out and then save it, give it a name ... toggle one
 * or another"): what Plex shows now, kept under a name; switching is a plan you approve.
 */
function Layouts({ serviceId }: { serviceId: string }) {
  const q = useHomeLayouts(serviceId);
  const save = useSaveLayout();
  const rename = useRenameLayout();
  const del = useDeleteLayout();
  const c = useConfirmedChange(serviceId);
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string }>();
  const [asked, setAsked] = useState<"switch" | "undo">("switch");
  const status = c.job?.status;
  useEffect(() => {
    if (status === "succeeded" || status === "failed") {
      void qc.invalidateQueries({ queryKey: ["home-layouts"] });
      void qc.invalidateQueries({ queryKey: ["home-rows-options"] });
      void qc.invalidateQueries({ queryKey: ["home-rows"] });
    }
  }, [status, qc]);
  const list = q.data?.layouts ?? [];
  return (
    <section className="space-y-2" aria-label="Saved home screens" data-testid="home-layouts">
      {list.length === 0 && (
        <p className="text-[0.85rem] text-muted">
          Save the home screen as it is now, give it a name, and switch back to it any time. Build
          another, save that too, and switch between them.
        </p>
      )}
      <ul className="grid gap-1.5">
        {list.map((l) => (
          <li
            key={l.id}
            className={cx(
              "flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2",
              l.active ? "border-live/50 bg-live/5" : "border-line bg-bg/50",
            )}
            data-testid="home-layout"
          >
            {renaming?.id === l.id ? (
              <form
                className="flex min-w-0 flex-1 gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  rename.mutate(renaming, { onSuccess: () => setRenaming(undefined) });
                }}
              >
                <input
                  className={cx(field, "min-w-0 flex-1")}
                  value={renaming.name}
                  maxLength={60}
                  onChange={(e) => setRenaming({ id: l.id, name: e.target.value })}
                  aria-label="New name"
                  autoFocus
                />
                <button type="submit" className={chip} disabled={!renaming.name.trim()}>
                  Save
                </button>
              </form>
            ) : (
              <span className="min-w-0 flex-1 text-[0.92rem] text-ink">
                {l.name}
                {l.active && (
                  <span className="ml-2 rounded-full border border-live/50 px-2 py-0.5 text-[0.7rem] text-live">
                    On now
                  </span>
                )}
              </span>
            )}
            <div className="flex flex-wrap gap-1.5">
              {!l.active && (
                <button
                  type="button"
                  className={chip}
                  disabled={c.busy}
                  onClick={() => {
                    setAsked("switch");
                    void c.propose(
                      "app-plex-control",
                      { op: "home-layout-apply", layoutId: l.id },
                      `Switch the home screen to “${l.name}”`,
                    );
                  }}
                  data-testid="home-layout-switch"
                >
                  Switch to this
                </button>
              )}
              <button
                type="button"
                className={chip}
                disabled={save.isPending}
                onClick={() => save.mutate({ serviceId, name: l.name, id: l.id })}
                title="Save what Plex shows now over this one"
              >
                Save over
              </button>
              <button
                type="button"
                className={chip}
                onClick={() => setRenaming({ id: l.id, name: l.name })}
                aria-label={`Rename ${l.name}`}
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                type="button"
                className={chip}
                disabled={del.isPending}
                onClick={() => del.mutate(l.id)}
                aria-label={`Delete ${l.name}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ serviceId, name }, { onSuccess: () => setName("") });
        }}
      >
        <input
          className={cx(field, "min-w-0 flex-1")}
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name this home screen, like Holidays"
          aria-label="Name for the home screen as it is now"
          data-testid="home-layout-name"
        />
        <button
          type="submit"
          className={chip}
          disabled={!name.trim() || save.isPending}
          data-testid="home-layout-save"
        >
          <Plus className="h-4 w-4" /> Save this home screen
        </button>
        {q.data?.undoable && (
          <button
            type="button"
            className={chip}
            disabled={c.busy}
            onClick={() => {
              setAsked("undo");
              void c.propose(
                "app-plex-control",
                { op: "home-layout-undo" },
                "Put the last home screen back",
              );
            }}
            data-testid="home-layout-undo"
          >
            <Undo2 className="h-4 w-4" /> Undo last switch
          </button>
        )}
      </form>
      {(save.error ?? rename.error ?? del.error) && (
        <p className="text-[0.8rem] text-amber" role="alert">
          {(save.error ?? rename.error ?? del.error)!.message}
        </p>
      )}
      <PlanList c={c} testId="home-layout-plan" />
      <ChangeCard c={c} confirmLabel={asked === "undo" ? "Put it back" : "Switch on Plex"} />
    </section>
  );
}
