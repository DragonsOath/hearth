import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import { InteractiveSearch } from "./InteractiveSearch";
import { DownloadTrails } from "./DownloadTrail";
import { useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  Download,
  MessageCircle,
  Search,
  Trash2,
} from "lucide-react";
import { MAX_JOB_STEPS, type ArrDashboard as Data, type ArrQueueItem } from "@dragon-control/core";
import { useDashboard } from "../../data/dashboards";
import { ago, bytes } from "../../lib/format";
import { useCave } from "../shell/cave-context";
import {
  CollectionList,
  ComingMovies,
  FindMovies,
  LibrarySummary,
  UpgradeList,
} from "./MovieViews";
import { Segmented, Skeleton, cx } from "../ui";
import { healthFix } from "./radarr/healthFix";
import { EmberMark } from "../ember/EmberMark";

/**
 * Sonarr's and Radarr's live dashboard (feature request 7): totals, the download queue with
 * progress and what is stuck and why, missing items, the next week, recent imports. Failed
 * downloads (a failed usenet repair, an aborted job) are shown as failed, with Remove (also clears
 * them from the download client's history, so they stop showing for good), Search again, and
 * Clear all failed. Radarr also shows its whole library (MovieViews): quality at a glance, what is
 * coming, upgrades, collections, and Find. Reading changes nothing; every button only proposes a
 * plan, which you approve on its own page before anything runs.
 */

type View =
  | "queue"
  | "trail"
  | "missing"
  | "upcoming"
  | "coming"
  | "upgrades"
  | "collections"
  | "find"
  | "search"
  | "recent";
const VIEWS: readonly View[] = [
  "queue",
  "trail",
  "missing",
  "upcoming",
  "coming",
  "upgrades",
  "collections",
  "find",
  "search",
  "recent",
];

export type Propose = ReturnType<typeof usePropose>;

function Ask({ question, label = "Ask" }: { question: string; label?: string }) {
  const cave = useCave();
  return (
    <button
      type="button"
      onClick={() => cave.ask(question)}
      className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
    >
      <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" />
      {label}
      <EmberMark />
    </button>
  );
}

/** Plans a change and asks for your approval in a pop-up, right here. */
function usePropose(serviceId: string) {
  return useApproveHere(serviceId);
}

const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.78rem] text-ink hover:border-gold hover:text-gold disabled:opacity-50";

/** Remove a failed download from the queue and from the client's history, so it is gone for good. */
const removeFailed = (q: ArrQueueItem) => ({
  kind: "app-arr-queue-remove" as const,
  params: { queueId: q.queueId, removeFromClient: true },
});

function QueueRow({
  q,
  name,
  act,
}: {
  q: ArrQueueItem;
  name: string;
  act: ReturnType<typeof usePropose>;
}) {
  const searchId = q.episodeId ?? q.movieId;
  return (
    <li
      className={cx(
        "rounded-xl border p-3",
        q.stuckImport
          ? "border-amber/50 bg-amber/[0.04]"
          : q.failed
            ? "border-alert/50 bg-alert/[0.04]"
            : q.problem
              ? "border-alert/40"
              : "border-line",
      )}
      data-testid="arr-queue-item"
      data-capture-item
      data-capture-label={q.title}
      data-stuck={q.stuckImport ? "yes" : "no"}
      data-failed={q.failed ? "yes" : "no"}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="min-w-0 text-[0.92rem] text-ink">{q.title}</p>
        <span
          className={cx(
            "text-[0.76rem]",
            q.stuckImport ? "text-amber" : q.failed ? "text-alert" : "text-muted",
          )}
        >
          {q.stuckImport
            ? "Stuck: not imported"
            : q.failed
              ? `Failed${q.client ? ` in ${q.client}` : ""}${q.onDisk ? " · already on disk" : ""}`
              : (q.state ?? q.status)}
        </span>
      </div>
      {q.release && (
        <p className="truncate font-mono text-[0.72rem] text-faint" title={q.release}>
          {q.release}
        </p>
      )}
      {q.progressPct !== undefined && !q.stuckImport && (
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-line"
          role="progressbar"
          aria-valuenow={q.progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${q.title} progress`}
        >
          <div
            className="h-full rounded-full bg-gold transition-[width] duration-700"
            style={{ width: `${q.progressPct}%` }}
          />
        </div>
      )}
      <p className="mt-1.5 text-[0.76rem] text-faint">
        {[
          q.progressPct !== undefined ? `${q.progressPct}%` : undefined,
          q.sizeBytes ? bytes(q.sizeBytes) : undefined,
          q.timeLeft && !q.failed ? `${q.timeLeft} left` : undefined,
          q.failed ? undefined : q.client,
          q.indexer,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {q.problem && (
        <p className={cx("mt-1.5 text-[0.8rem]", q.failed ? "text-alert" : "text-amber")}>
          {q.problem}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {q.stuckImport && (
          <button
            type="button"
            disabled={act.pending}
            onClick={() =>
              void act.propose(
                "app-arr-import",
                { queueId: q.queueId },
                `Import the stuck download of ${q.title}`,
              )
            }
            className={btn}
            data-testid="arr-import"
            data-hearth-target="queue:import"
          >
            <Download strokeWidth={1.5} className="h-3.5 w-3.5" /> Import
          </button>
        )}
        {q.failed && (
          <button
            type="button"
            disabled={act.pending}
            onClick={() =>
              void act.proposeMany([removeFailed(q)], `Remove the failed download of ${q.title}`)
            }
            className={btn}
            data-testid="arr-remove-failed"
            data-hearth-target="queue:remove"
          >
            <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove
          </button>
        )}
        {q.failed && !q.onDisk && searchId !== undefined && (
          <button
            type="button"
            disabled={act.pending}
            onClick={() =>
              void act.propose(
                "app-arr-search",
                q.episodeId !== undefined ? { episodeId: searchId } : { movieId: searchId },
                `Search again for ${q.title}`,
              )
            }
            className={btn}
            data-testid="arr-search-again"
            data-hearth-target="queue:search"
          >
            <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Search again
          </button>
        )}
        {(q.stuckImport || q.problem) && (
          <Ask
            question={`In ${name}, "${q.title}" (queue item ${q.queueId}, release ${q.release ?? "unknown"}) is ${q.stuckImport ? "stuck and not imported" : "having trouble"}: ${q.problem ?? ""} Why, and what should we do? Fix it if you can.`}
          />
        )}
      </div>
    </li>
  );
}

export type ArrView = View;

/**
 * The Overview's short "Right now" (Radarr's panel, which has Activity and Wanted tabs): what
 * needs you, what is downloading, what just arrived. Each part opens the tab with the whole list.
 */
function RightNow({
  d,
  name,
  failed,
  stuck,
  tabs,
}: {
  d: Data;
  name: string;
  failed: number;
  stuck: number;
  tabs: { activity: (part?: string) => void; wanted: () => void };
}) {
  const downloading = d.queue.filter((i) => !i.failed && !i.stuckImport).slice(0, 3);
  const link =
    "inline-flex min-h-9 items-center text-[0.78rem] text-gold underline-offset-4 hover:underline";
  return (
    <div className="grid gap-3 @lg:grid-cols-3" data-testid="arr-right-now">
      <section className="rounded-xl border border-line p-3" aria-label="Needs you">
        <p className="eyebrow mb-1.5">Needs you</p>
        {failed + stuck + d.totals.missing === 0 ? (
          <p className="text-[0.84rem] text-muted">Nothing. {name} is keeping up.</p>
        ) : (
          <ul className="space-y-1 text-[0.84rem]">
            {failed > 0 && (
              <li className="text-alert">
                {failed} failed download{failed === 1 ? "" : "s"}
              </li>
            )}
            {stuck > 0 && <li className="text-amber">{stuck} stuck after downloading</li>}
            {d.totals.missing > 0 && <li className="text-ink">{d.totals.missing} missing</li>}
          </ul>
        )}
        <div className="mt-1 flex flex-wrap gap-x-3">
          {failed + stuck > 0 && (
            <button
              type="button"
              className={link}
              onClick={() => tabs.activity()}
              data-hearth-target="overview:to-activity"
            >
              Fix in Activity
            </button>
          )}
          {d.totals.missing > 0 && (
            <button
              type="button"
              className={link}
              onClick={() => tabs.wanted()}
              data-hearth-target="overview:to-wanted"
            >
              See what is missing
            </button>
          )}
        </div>
      </section>
      <section className="rounded-xl border border-line p-3" aria-label="Downloading now">
        <p className="eyebrow mb-1.5">Downloading now</p>
        {downloading.length === 0 ? (
          <p className="text-[0.84rem] text-muted">Nothing is downloading.</p>
        ) : (
          <ul className="space-y-2">
            {downloading.map((i) => (
              <li key={i.queueId} className="text-[0.82rem]">
                <p className="truncate text-ink">{i.title}</p>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-line">
                  <div
                    className="h-full rounded-full bg-gold/80"
                    style={{ width: `${i.progressPct ?? 0}%` }}
                  />
                </div>
                <p className="text-[0.72rem] text-faint">
                  {i.progressPct ?? 0}%{i.timeLeft ? ` · ${i.timeLeft} left` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-x-3">
          <button
            type="button"
            className={link}
            onClick={() => tabs.activity()}
            data-hearth-target="overview:queue"
          >
            The whole queue
          </button>
          {/* Each download's way from grab to import (11-07: as easy to find as Chaptarr's). */}
          <button
            type="button"
            className={link}
            onClick={() => tabs.activity("queue/trail")}
            data-hearth-target="overview:trail"
            data-testid="arr-overview-trail"
          >
            Download trail{d.trails?.length ? ` (${d.trails.length})` : ""}
          </button>
        </div>
      </section>
      <section className="rounded-xl border border-line p-3" aria-label="Just arrived">
        <p className="eyebrow mb-1.5">Just arrived</p>
        {d.recent.length === 0 ? (
          <p className="text-[0.84rem] text-muted">Nothing new lately.</p>
        ) : (
          <ul className="space-y-1 text-[0.82rem]">
            {d.recent.slice(0, 4).map((r, i) => (
              <li key={`${r.title}-${i}`} className="flex justify-between gap-2">
                <span className="truncate text-ink">{r.title}</span>
                {r.at && <span className="shrink-0 text-faint">{ago(r.at)}</span>}
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className={link}
          onClick={() => tabs.activity("queue/recent")}
          data-hearth-target="overview:recent"
        >
          Recently imported
        </button>
      </section>
    </div>
  );
}

export function ArrDashboard({
  serviceId,
  name,
  section,
  onSection,
  views,
  bare = false,
  tabs,
  onFix,
}: {
  serviceId: string;
  name: string;
  /** The section named in the address ("overview/missing"), so links and Ember can open it. */
  section?: string | null;
  onSection?: (section: string) => void;
  /** Only these views (the Radarr panel's Activity tab shows queue, trail and recent imports). */
  views?: readonly View[];
  /** Without the totals, health and library summary (another tab shows those). */
  bare?: boolean;
  /**
   * The panel has its own Activity and Wanted tabs (Radarr): the Overview then shows a short
   * "Right now" summary that opens them, instead of the full queue.
   */
  tabs?: { activity: (part?: string) => void; wanted: () => void };
  /** Opens a tab of the panel at a place (a health warning's fix). */
  onFix?: (tab: string, sub: string | null) => void;
}) {
  const q = useDashboard(serviceId, true, 5000);
  const allowed = views ?? VIEWS;
  const [own, setOwn] = useState<View>(allowed[0] ?? "queue");
  const view = (section && allowed.includes(section as View) ? section : own) as View;
  const setView = (v: View) => {
    setOwn(v);
    onSection?.(v);
  };
  const act = usePropose(serviceId);
  const d: Data | undefined =
    q.data?.data?.app === "sonarr" || q.data?.data?.app === "radarr" ? q.data.data : undefined;

  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="arr-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
      </div>
    );
  if (!d) return null;
  const sonarr = d.app === "sonarr";
  const stuck = d.queue.filter((i) => i.stuckImport);
  const failed = d.queue.filter((i) => i.failed);
  const rest = d.queue.filter((i) => !i.stuckImport && !i.failed);
  const attention = d.totals.stuckImports + (d.totals.failed ?? failed.length);
  const clearing = failed.slice(0, MAX_JOB_STEPS);
  const lib = d.library;

  return (
    <section
      className="@container space-y-4"
      data-testid="arr-dashboard"
      aria-label={`${name} live`}
    >
      {!bare && (
        <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
          {[
            [sonarr ? "Series" : "Movies", `${d.totals.titles}`, `${d.totals.monitored} monitored`],
            ["Missing", `${d.totals.missing}`, sonarr ? "episodes" : "movies"],
            ["Downloading", `${d.totals.queue - failed.length}`, "in the queue"],
            [
              "Need attention",
              `${attention}`,
              attention
                ? [
                    failed.length ? `${failed.length} failed` : "",
                    d.totals.stuckImports ? `${d.totals.stuckImports} stuck` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : "none",
            ],
          ].map(([label, value, sub]) => (
            <div key={label} className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
              <p className="text-[0.72rem] tracking-wide text-faint uppercase">{label}</p>
              <p
                className={cx(
                  "stat-value text-ink tabular",
                  label === "Need attention" && attention > 0 && "text-amber",
                )}
              >
                {value}
              </p>
              <p className="text-[0.74rem] text-faint">{sub}</p>
            </div>
          ))}
        </div>
      )}
      {!bare && d.health.length > 0 && (
        <ul className="space-y-1" data-testid="arr-health">
          {d.health.map((h, i) => {
            const fix = onFix ? healthFix(h.source) : undefined;
            return (
              <li
                key={i}
                className={cx(
                  "flex flex-wrap items-start gap-x-2 text-[0.82rem]",
                  h.level === "error" ? "text-alert" : "text-amber",
                )}
              >
                <AlertTriangle strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">{h.text}</span>
                {fix && (
                  <button
                    type="button"
                    onClick={() => onFix?.(fix.tab, fix.sub)}
                    className="inline-flex min-h-8 items-center text-[0.78rem] text-gold underline-offset-4 hover:underline"
                    data-hearth-target="health:fix"
                  >
                    {fix.label}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {tabs && (
        <RightNow d={d} name={name} failed={failed.length} stuck={stuck.length} tabs={tabs} />
      )}
      {!bare && lib && <LibrarySummary lib={lib} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          target="view"
          label="Show"
          value={view}
          onChange={setView}
          options={(
            (lib
              ? [
                  { value: "queue", label: "Queue", count: d.queue.length },
                  { value: "trail", label: "Download trail", count: d.trails?.length ?? 0 },
                  { value: "missing", label: "Missing", count: d.totals.missing },
                  { value: "coming", label: "Coming", count: lib.coming.length },
                  { value: "upgrades", label: "Upgrades", count: lib.upgrades.total },
                  {
                    value: "collections",
                    label: "Collections",
                    count: lib.collectionsTotal ?? lib.collections.length,
                  },
                  { value: "find", label: "Find" },
                  { value: "search", label: "Search releases" },
                  { value: "recent", label: "Recently imported", count: d.recent.length },
                ]
              : [
                  { value: "queue", label: "Queue", count: d.queue.length },
                  { value: "trail", label: "Download trail", count: d.trails?.length ?? 0 },
                  { value: "missing", label: "Missing", count: d.totals.missing },
                  { value: "upcoming", label: "Next 7 days", count: d.upcoming.length },
                  { value: "search", label: "Search releases" },
                  { value: "recent", label: "Recently imported", count: d.recent.length },
                ]) as { value: View; label: string; count?: number }[]
          ).filter((o) => allowed.includes(o.value))}
        />
        <span className="text-[0.74rem] text-faint" data-testid="arr-freshness">
          {q.data?.sample ? "Sample data · " : ""}
          {d.version ? `${name} ${d.version} · ` : ""}live, every 5 s
        </span>
      </div>
      {act.error && (
        <p className="text-[0.82rem] text-amber" data-testid="arr-plan-error">
          {act.error}
        </p>
      )}
      <ApproveDialog c={act} />

      {view === "queue" && failed.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-alert/40 bg-alert/[0.04] p-3"
          data-testid="arr-failed-summary"
        >
          <p className="min-w-0 flex-1 text-[0.84rem] text-ink">
            {failed.length === 1 ? "1 download" : `${failed.length} downloads`} failed and will sit
            here until removed. Removing also clears {failed.length === 1 ? "it" : "them"} from{" "}
            {[...new Set(failed.map((f) => f.client).filter(Boolean))].join(" and ") ||
              "the download client"}
            .
          </p>
          <button
            type="button"
            disabled={act.pending}
            onClick={() =>
              void act.proposeMany(
                clearing.map(removeFailed),
                `Clear ${clearing.length} failed download${clearing.length === 1 ? "" : "s"} from ${name}`,
              )
            }
            className={btn}
            data-testid="arr-clear-failed"
          >
            <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" />
            {failed.length > clearing.length
              ? `Clear ${clearing.length} of ${failed.length} failed`
              : "Clear all failed"}
          </button>
        </div>
      )}

      {view === "queue" &&
        (d.queue.length ? (
          <ul className="space-y-2">
            {[...stuck, ...failed, ...rest].map((i) => (
              <QueueRow key={i.queueId} q={i} name={name} act={act} />
            ))}
          </ul>
        ) : (
          <p className="text-[0.86rem] text-muted">Nothing is downloading.</p>
        ))}

      {view === "missing" &&
        (d.missing.length ? (
          <ul className="divide-y divide-line">
            {d.missing.map((m) => {
              const id = sonarr ? m.episodeId : m.movieId;
              return (
                <li
                  key={`${m.title}-${id}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[0.86rem]"
                  data-testid="arr-missing"
                  data-capture-item
                  data-capture-label={m.title}
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-ink">{m.title}</span>
                    <span className="block text-[0.74rem] text-faint">
                      {m.airedAt ? `Aired ${ago(m.airedAt).toLowerCase()}` : "Released"}
                      {m.monitored ? "" : " · not monitored"}
                    </span>
                  </span>
                  {id !== undefined && (
                    <button
                      type="button"
                      disabled={act.pending}
                      onClick={() =>
                        void act.propose(
                          "app-arr-search",
                          sonarr ? { episodeId: id } : { movieId: id },
                          `Search for ${m.title}`,
                        )
                      }
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.78rem] text-ink hover:border-gold hover:text-gold disabled:opacity-50"
                      data-testid="arr-search"
                      data-hearth-target="missing:search"
                    >
                      <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Search
                    </button>
                  )}
                  <Ask
                    question={`${m.title} is missing in ${name} (${sonarr ? "episodeId" : "movieId"} ${id}). Is it available on the indexers, and why has it not been downloaded? Search for it if that would help.`}
                  />
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[0.86rem] text-muted">Nothing is missing.</p>
        ))}

      {lib && view === "coming" && <ComingMovies lib={lib} />}
      {lib && view === "upgrades" && <UpgradeList lib={lib} act={act} />}
      {lib && view === "collections" && <CollectionList lib={lib} act={act} />}
      {lib && view === "find" && <FindMovies serviceId={serviceId} act={act} />}
      {view === "search" && (
        <InteractiveSearch serviceId={serviceId} app={sonarr ? "sonarr" : "radarr"} />
      )}

      {view === "upcoming" &&
        (d.upcoming.length ? (
          <ul className="divide-y divide-line">
            {d.upcoming.map((u, i) => (
              <li key={i} className="flex items-center gap-3 py-2.5 text-[0.86rem]">
                <CalendarClock strokeWidth={1.5} className="h-4 w-4 text-faint" />
                <span className="flex-1 text-ink">{u.title}</span>
                <span className="text-[0.76rem] text-faint">
                  {u.at
                    ? new Date(u.at).toLocaleString(undefined, {
                        weekday: "short",
                        hour: "numeric",
                        minute: "2-digit",
                      })
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[0.86rem] text-muted">Nothing due in the next 7 days.</p>
        ))}

      {view === "trail" && <DownloadTrails trails={d.trails} app={name} />}

      {view === "recent" &&
        (d.recent.length ? (
          <ul className="divide-y divide-line">
            {d.recent.map((r, i) => (
              <li key={i} className="flex flex-wrap items-center gap-x-3 py-2.5 text-[0.86rem]">
                <span className="flex-1 text-ink">{r.title}</span>
                <span className="text-[0.76rem] text-faint">
                  {r.quality ? `${r.quality} · ` : ""}
                  {r.at ? ago(r.at) : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[0.86rem] text-muted">Nothing imported recently.</p>
        ))}
      <p className="text-[0.74rem] text-faint">
        Import, Search, Remove{lib ? ", and Add missing" : ""} propose a plan; you see exactly what
        happens and approve it first. The blocklist is in Activity, and deleting an item&apos;s
        files is on its page in Library.
      </p>
    </section>
  );
}
