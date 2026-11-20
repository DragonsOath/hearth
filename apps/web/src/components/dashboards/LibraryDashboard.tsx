import { useState } from "react";
import { InteractiveSearch } from "./InteractiveSearch";
import { DownloadTrails } from "./DownloadTrail";
import { AlertTriangle, CalendarClock, MessageCircle, Replace, Search } from "lucide-react";
import type { LibraryDashboard as Data } from "@dragon-control/core";
import { useDashboard } from "../../data/dashboards";
import { ago, bytes } from "../../lib/format";
import { useCave } from "../shell/cave-context";
import { Button, Segmented, Skeleton, cx } from "../ui";
import { AuthorList, CollectionSummary, ComingList, WantedList, formatTiles } from "./BookViews";
import { ChangeCard, useConfirmedChange } from "./ConfirmedChange";
import { EmberMark } from "../ember/EmberMark";

/**
 * Lidarr and Chaptarr from Hearth, laid out like Sonarr's and Radarr's panel: totals, then one
 * list at a time (the queue with stuck downloads first and the app's reason, what is missing,
 * what comes out in the next two weeks, recent history). Searching for one missing album or
 * book or for all of them, and replacing a stuck download with another release, are each a
 * plan confirmed here. Chaptarr also shows its whole collection (BookViews): wanted books per
 * format and what is on disk, what is coming out, and each author.
 */

type View =
  | "queue"
  | "trail"
  | "wanted"
  | "missing"
  | "upcoming"
  | "coming"
  | "authors"
  | "search"
  | "recent";

const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.78rem] text-ink hover:border-gold hover:text-gold disabled:opacity-50";
const kind = (app: Data["app"]) =>
  app === "lidarr" ? "app-lidarr-control" : "app-chaptarr-control";
const appName = (app: Data["app"]) => (app === "lidarr" ? "Lidarr" : "Chaptarr");

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

function QueueRow({ serviceId, d, q }: { serviceId: string; d: Data; q: Data["queue"][number] }) {
  const c = useConfirmedChange(serviceId);
  return (
    <li
      className={cx(
        "rounded-xl border p-3",
        q.stuck ? "border-amber/50 bg-amber/[0.04]" : "border-line",
      )}
      data-testid="lib-queue"
      data-capture-item
      data-capture-label={q.title}
      data-stuck={q.stuck ? "yes" : "no"}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="min-w-0 text-[0.92rem] break-words text-ink">{q.title}</p>
        <span className={cx("text-[0.76rem]", q.stuck ? "text-amber" : "text-muted")}>
          {q.stuck ? "Stuck" : q.status}
        </span>
      </div>
      {q.release && (
        <p className="truncate font-mono text-[0.72rem] text-faint" title={q.release}>
          {q.release}
        </p>
      )}
      {q.progressPct !== undefined && !q.stuck && (
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
          q.progressPct !== undefined && !q.stuck ? `${q.progressPct}%` : undefined,
          q.sizeBytes ? bytes(q.sizeBytes) : undefined,
          q.timeLeft && !q.stuck ? `${q.timeLeft} left` : undefined,
          q.via,
          q.indexer,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {q.problem && (
        <p className="mt-1.5 text-[0.8rem] break-words text-amber" data-testid="lib-problem">
          {q.problem}
        </p>
      )}
      {q.stuck && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            className={btn}
            data-testid="lib-replace"
            onClick={() =>
              void c.propose(
                kind(d.app),
                { op: "replace-download", queueId: q.id },
                `Replace ${q.title}`,
              )
            }
          >
            <Replace strokeWidth={1.5} className="h-3.5 w-3.5" /> Find another release
          </button>
          <Ask
            label="Ask why"
            question={`${appName(d.app)} has a stuck download, ${q.title} (release ${q.release ?? "unknown"}): "${q.problem ?? q.status}". Why, and should I import it by hand or find another release?`}
          />
        </div>
      )}
      <div className="mt-2 empty:hidden">
        <ChangeCard c={c} />
      </div>
    </li>
  );
}

function MissingRow({
  serviceId,
  d,
  m,
}: {
  serviceId: string;
  d: Data;
  m: Data["missing"][number];
}) {
  const c = useConfirmedChange(serviceId);
  return (
    <li
      className="space-y-1.5 py-2.5"
      data-testid="lib-missing"
      data-capture-item
      data-capture-label={m.title}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.86rem]">
        <span className="min-w-0 flex-1">
          <span className="break-words text-ink">{m.title}</span>
          <span className="block text-[0.74rem] text-faint">
            {m.released
              ? new Date(m.released) > new Date()
                ? `Out ${new Date(m.released).toLocaleDateString()}`
                : `Released ${new Date(m.released).getFullYear()}`
              : "Release date unknown"}
          </span>
        </span>
        <button
          type="button"
          className={btn}
          data-testid="lib-search"
          onClick={() =>
            void c.propose(kind(d.app), { op: "search", itemId: m.id }, `Search for ${m.title}`)
          }
        >
          <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Search
        </button>
        <Ask
          question={`${m.title} is missing in ${appName(d.app)} (${d.words.what} id ${m.id}). Is it available on the indexers, and why has it not been downloaded? Search for it if that would help.`}
        />
      </div>
      <ChangeCard c={c} />
    </li>
  );
}

export function LibraryDashboard({ serviceId, name }: { serviceId: string; name: string }) {
  const q = useDashboard(serviceId, true, 5000);
  const all = useConfirmedChange(serviceId);
  const [view, setView] = useState<View>("queue");
  const d: Data | undefined =
    q.data?.data?.app === "lidarr" || q.data?.data?.app === "chaptarr" ? q.data.data : undefined;
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="lib-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
      </div>
    );
  if (!d) return null;
  const W = d.words;
  const who = `${W.who[0]!.toUpperCase()}${W.who.slice(1)}s`;
  const books = d.collection !== undefined;
  const tiles: { label: string; value: string; sub: string; testId?: string; warn?: boolean }[] =
    books
      ? [
          {
            label: who,
            value: `${d.totals.people}`,
            sub: `${d.totals.monitored ?? d.totals.people} followed`,
          },
          ...formatTiles(d),
          {
            label: "Downloading",
            value: `${d.totals.queue}`,
            sub: d.totals.stuck ? `${d.totals.stuck} stuck` : "none stuck",
            testId: "lib-downloading",
            warn: d.totals.stuck > 0,
          },
        ]
      : [
          {
            label: who,
            value: `${d.totals.people}`,
            sub:
              d.totals.monitored !== undefined
                ? `${d.totals.monitored} monitored`
                : "in the library",
          },
          {
            label: "Missing",
            value: `${d.totals.missing}`,
            sub: W.whats,
            testId: "lib-missing-count",
          },
          { label: "Downloading", value: `${d.totals.queue}`, sub: "in the queue" },
          {
            label: "Stuck",
            value: `${d.totals.stuck}`,
            sub: d.totals.stuck ? "need attention" : "none",
            testId: "lib-stuck",
            warn: d.totals.stuck > 0,
          },
        ];
  return (
    <section
      className="@container space-y-4"
      data-testid="lib-dashboard"
      aria-label={`${name}: library`}
    >
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
            <p className="text-[0.72rem] tracking-wide text-faint uppercase">{t.label}</p>
            <p
              className={cx("stat-value text-ink tabular", t.warn && "text-amber")}
              data-testid={t.testId}
            >
              {t.value}
            </p>
            <p className="text-[0.74rem] text-faint">{t.sub}</p>
          </div>
        ))}
      </div>

      <CollectionSummary d={d} />

      {d.health.length > 0 && (
        <ul className="space-y-1" data-testid="lib-health">
          {d.health.map((h, i) => (
            <li
              key={i}
              className={cx(
                "flex gap-2 text-[0.82rem]",
                h.level === "error" ? "text-alert" : "text-amber",
              )}
            >
              <AlertTriangle strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0" /> {h.text}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          label="Show"
          value={view}
          onChange={setView}
          options={
            books
              ? [
                  { value: "queue", label: "Queue", count: d.queue.length },
                  { value: "trail", label: "Download trail", count: d.trails?.length ?? 0 },
                  { value: "wanted", label: "Wanted", count: d.wanted?.length ?? 0 },
                  { value: "missing", label: "Missing", count: d.totals.missing },
                  { value: "coming", label: "Coming", count: d.coming?.length ?? 0 },
                  { value: "authors", label: "Authors", count: d.authors?.length ?? 0 },
                  { value: "search", label: "Search releases" },
                  { value: "recent", label: "Recent activity", count: d.recent.length },
                ]
              : [
                  { value: "queue", label: "Queue", count: d.queue.length },
                  { value: "trail", label: "Download trail", count: d.trails?.length ?? 0 },
                  { value: "missing", label: "Missing", count: d.totals.missing },
                  { value: "upcoming", label: "Next 14 days", count: d.upcoming.length },
                  { value: "search", label: "Search releases" },
                  { value: "recent", label: "Recent activity", count: d.recent.length },
                ]
          }
        />
        <span className="text-[0.74rem] text-faint" data-testid="lib-freshness">
          {q.data?.sample ? "Sample data · " : ""}
          {d.version ? `${name} ${d.version} · ` : ""}live, every 5 s
        </span>
      </div>

      {view === "queue" &&
        (d.queue.length ? (
          <ul className="space-y-2">
            {d.queue.map((x) => (
              <QueueRow key={x.id} serviceId={serviceId} d={d} q={x} />
            ))}
          </ul>
        ) : (
          <p className="text-[0.86rem] text-muted">Nothing is downloading.</p>
        ))}

      {view === "trail" && <DownloadTrails trails={d.trails} app={name} />}
      {view === "wanted" && <WantedList serviceId={serviceId} d={d} />}
      {view === "coming" && <ComingList serviceId={serviceId} d={d} />}
      {view === "authors" && <AuthorList d={d} />}

      {view === "missing" && (
        <div>
          {d.totals.missing > 0 && (
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <p className="flex-1 text-[0.76rem] text-faint">
                {d.totals.missing > d.missing.length
                  ? `The newest ${d.missing.length} of ${d.totals.missing}.`
                  : `All ${d.totals.missing}.`}
              </p>
              <Button
                tone="outline"
                data-testid="lib-search-all"
                onClick={() =>
                  void all.propose(
                    kind(d.app),
                    { op: "search-missing" },
                    `Search all missing ${W.whats}`,
                  )
                }
              >
                <Search className="h-4 w-4" /> Search all
              </Button>
            </div>
          )}
          <ChangeCard c={all} />
          {d.missing.length ? (
            <ul className="divide-y divide-line">
              {d.missing.map((m) => (
                <MissingRow key={m.id} serviceId={serviceId} d={d} m={m} />
              ))}
            </ul>
          ) : (
            <p className="text-[0.86rem] text-muted">Nothing monitored is missing.</p>
          )}
        </div>
      )}

      {view === "upcoming" &&
        (d.upcoming.length ? (
          <ul className="divide-y divide-line" data-testid="lib-upcoming">
            {d.upcoming.map((u) => (
              <li key={u.id} className="flex items-center gap-3 py-2.5 text-[0.86rem]">
                <CalendarClock strokeWidth={1.5} className="h-4 w-4 shrink-0 text-faint" />
                <span className="min-w-0 flex-1 break-words text-ink">{u.title}</span>
                <span className="text-[0.76rem] text-faint">
                  {u.on
                    ? new Date(u.on).toLocaleDateString(undefined, {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                      })
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[0.86rem] text-muted">Nothing comes out in the next two weeks.</p>
        ))}

      {view === "search" && <InteractiveSearch serviceId={serviceId} app={d.app} />}
      {view === "recent" &&
        (d.recent.length ? (
          <ul className="divide-y divide-line" data-testid="lib-recent">
            {d.recent.map((r, i) => (
              <li key={i} className="flex flex-wrap items-center gap-x-3 py-2.5 text-[0.86rem]">
                <span className="min-w-0 flex-1">
                  <span className={cx("break-words", r.failed ? "text-alert" : "text-ink")}>
                    {r.title ?? r.text}
                  </span>
                  {r.event && (
                    <span
                      className={cx(
                        "block text-[0.74rem] first-letter:uppercase",
                        r.failed ? "text-alert" : "text-faint",
                      )}
                    >
                      {r.event}
                    </span>
                  )}
                </span>
                <span className="text-[0.76rem] text-faint">
                  {r.quality ? `${r.quality} · ` : ""}
                  {r.at ? ago(r.at) : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[0.86rem] text-muted">Nothing happened recently.</p>
        ))}

      <p className="text-[0.74rem] text-faint">
        Search, Find another release{books ? ", and Want it" : ""} propose a plan for that one item;
        you see exactly what happens and confirm it first. Deleting {W.whats} or files is not done
        from here.
      </p>
    </section>
  );
}
