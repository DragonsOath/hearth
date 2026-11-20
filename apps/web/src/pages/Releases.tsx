import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ExternalLink } from "lucide-react";
import {
  RELEASE_NOTIFY_KINDS,
  formatDay,
  type MovieWatchState,
  type Watch,
  type WatchHistoryEntry,
  type WatchView,
} from "@dragon-control/core";
import { useAiName } from "../data/api";
import {
  useCheckWatches,
  useWatch,
  useWatchAction,
  useWatchSettings,
  useWatches,
} from "../data/watches";
import { ago, dateTime } from "../lib/format";
import {
  Button,
  EmptyState,
  LinkButton,
  PageHeader,
  PageSkeleton,
  Rows,
  Section,
  Segmented,
  Sheet,
  Switch,
  Tag,
  cx,
} from "../components/ui";

/**
 * Releases: movies requested in Seerr that Hearth follows until they are in the library
 * (docs/design/RELEASE_WATCH.md). The checks run on the server on their own; this page shows
 * where each movie stands and lets you snooze, dismiss, or ask Ember about one.
 */

const VIEWS: { value: WatchView; label: string }[] = [
  { value: "upcoming", label: "Upcoming" },
  { value: "attention", label: "Needs a look" },
  { value: "completed", label: "Arrived" },
  { value: "dismissed", label: "Dismissed" },
];

/** Status colors keep their meaning in every theme: green arrived, amber needs a look. */
const STATE_TONE: Record<MovieWatchState, string> = {
  unannounced: "text-muted",
  upcoming: "text-ink",
  "out-today": "text-gold",
  looking: "text-gold",
  downloading: "text-gold",
  "needs-look": "text-warn",
  arrived: "text-live",
  gone: "text-faint",
};

const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

/** "Digital release December 19 (announced, from TMDB)", or "Not announced yet". */
function releaseLine(w: Watch): string {
  const a = w.assessment;
  if (!a.homeDate)
    return `No digital release date yet${a.theatrical ? `. In cinemas ${formatDay(a.theatrical, today())}` : ""}`;
  const kind = a.homeKind === "physical" ? "Disc release" : "Digital release";
  const source = a.dateSource === "radarr" ? "Radarr" : "TMDB through Seerr";
  return `${kind} ${formatDay(a.homeDate, today())} (${a.dateStatus === "out" ? "out" : "announced"}, from ${source})`;
}

function nextCheck(w: Watch): string | undefined {
  if (!w.nextCheckAt) return undefined;
  const minutes = (Date.parse(w.nextCheckAt) - Date.now()) / 60_000;
  if (minutes <= 1) return "Next check: now";
  if (minutes < 60) return `Next check in ${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return `Next check in ${Math.round(hours)} h`;
  return `Next check in ${Math.round(hours / 24)} days`;
}

const SENT_LABEL: Record<WatchHistoryEntry["sent"], string | undefined> = {
  sent: "Sent to you",
  held: "Held (quiet hours or snoozed); sent when that ends",
  off: "Not sent: switched off, or no channel chosen",
  none: undefined,
};

function WatchRow({ w, onOpen }: { w: Watch; onOpen: () => void }) {
  const problem = w.assessment.problem;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full flex-col gap-1.5 px-5 py-4 text-left transition-colors duration-200 hover:bg-panel-2/60 focus-visible:bg-panel-2/60"
        data-testid="watch-row"
        data-state={w.state}
      >
        <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span className="min-w-0 text-[0.98rem] break-words text-ink">
            {w.title}
            {w.year ? <span className="text-faint"> ({w.year})</span> : null}
          </span>
          <span className={cx("text-[0.82rem]", STATE_TONE[w.state])}>
            {w.stateLabel}
            {w.snoozedUntil ? <span className="text-faint"> · snoozed</span> : null}
          </span>
        </span>
        <span className="text-[0.84rem] text-muted">{releaseLine(w)}</span>
        <span className="text-[0.84rem] break-words text-muted">{w.assessment.doing}</span>
        {problem && (
          <span className="text-[0.84rem] break-words text-warn">
            {problem.text}
            {!problem.confirmed && <span className="text-faint"> (not certain)</span>}
          </span>
        )}
        <span className="flex flex-wrap gap-x-3 text-[0.76rem] text-faint">
          {w.requestedAt && (
            <span>
              Requested {ago(w.requestedAt).toLowerCase()}
              {w.requestedBy ? ` by ${w.requestedBy}` : ""}
            </span>
          )}
          {nextCheck(w) && <span>{nextCheck(w)}</span>}
          {w.checkError && <span className="text-warn">Last check failed</span>}
        </span>
      </button>
    </li>
  );
}

function WatchSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const watch = useWatch(id);
  const act = useWatchAction();
  const aiName = useAiName();
  const w = watch.data;
  const a = w?.assessment;
  const ask = w
    ? `Why hasn't ${w.title} arrived yet? Its release watch says: ${a?.problem?.text ?? a?.doing ?? ""} Check Radarr's queue, history, and the releases on offer with their reasons, and tell me what you find. Do not change anything.`
    : "";
  return (
    <Sheet
      label={w ? `${w.title}, release watch` : "Release watch"}
      eyebrow="Release watch"
      title={w?.title ?? "Loading"}
      onClose={onClose}
      wide
    >
      {w && a && (
        <div className="grid gap-6" data-testid="watch-sheet">
          <p className={cx("text-[0.95rem]", STATE_TONE[w.state])}>
            {w.stateLabel}
            {w.snoozedUntil && (
              <span className="text-faint"> · snoozed until {dateTime(w.snoozedUntil)}</span>
            )}
          </p>
          <dl className="grid gap-3 text-[0.88rem]">
            <div>
              <dt className="text-faint">Release</dt>
              <dd className="text-ink">{releaseLine(w)}</dd>
            </div>
            {a.theatrical && (
              <div>
                <dt className="text-faint">In cinemas</dt>
                <dd className="text-ink">
                  {formatDay(a.theatrical, today())}{" "}
                  <span className="text-faint">(shown for reference; not the digital date)</span>
                </dd>
              </div>
            )}
            <div>
              <dt className="text-faint">Radarr</dt>
              <dd className="text-ink">{a.doing}</dd>
            </div>
            {a.problem && (
              <div>
                <dt className="text-faint">What is in the way</dt>
                <dd className="text-warn">
                  {a.problem.text}{" "}
                  <Tag tone={a.problem.confirmed ? "warn" : "neutral"}>
                    {a.problem.confirmed ? "Confirmed" : "Not certain"}
                  </Tag>
                </dd>
              </div>
            )}
            {w.requestedAt && (
              <div>
                <dt className="text-faint">Requested</dt>
                <dd className="text-ink">
                  {dateTime(w.requestedAt)}
                  {w.requestedBy ? ` by ${w.requestedBy}` : ""}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-faint">Checks</dt>
              <dd className="text-ink">
                {w.lastCheckedAt ? `Last checked ${ago(w.lastCheckedAt).toLowerCase()}. ` : ""}
                {nextCheck(w) ?? "No more checks: this watch is finished or dismissed."}
                {w.checkError && (
                  <span className="block text-warn">Last check failed: {w.checkError}</span>
                )}
              </dd>
            </div>
          </dl>

          <div className="flex flex-wrap gap-2">
            {w.view !== "completed" && w.view !== "dismissed" && (
              <LinkButton to={`/ask?q=${encodeURIComponent(ask)}`} tone="primary">
                Ask {aiName} about it
              </LinkButton>
            )}
            {w.links.seerr && (
              <a
                href={w.links.seerr}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-strong px-4 text-[0.85rem] text-ink hover:border-gold hover:text-gold"
              >
                Open in Seerr <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            )}
            {w.links.radarr && (
              <a
                href={w.links.radarr}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-strong px-4 text-[0.85rem] text-ink hover:border-gold hover:text-gold"
              >
                Open in Radarr <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {w.view !== "dismissed" && w.nextCheckAt && (
              <Button disabled={act.isPending} onClick={() => act.mutate({ id, action: "check" })}>
                Check now
              </Button>
            )}
            {w.view !== "dismissed" && w.view !== "completed" && !w.snoozedUntil && (
              <>
                <Button
                  disabled={act.isPending}
                  onClick={() => act.mutate({ id, action: "snooze", days: 1 })}
                >
                  Snooze a day
                </Button>
                <Button
                  disabled={act.isPending}
                  onClick={() => act.mutate({ id, action: "snooze", days: 7 })}
                >
                  Snooze a week
                </Button>
              </>
            )}
            {w.snoozedUntil && (
              <Button
                disabled={act.isPending}
                onClick={() => act.mutate({ id, action: "unsnooze" })}
              >
                Stop snoozing
              </Button>
            )}
            {w.view === "dismissed" ? (
              <Button
                disabled={act.isPending}
                onClick={() => act.mutate({ id, action: "restore" })}
              >
                Bring back
              </Button>
            ) : (
              <Button
                tone="quiet"
                disabled={act.isPending}
                onClick={() => act.mutate({ id, action: "dismiss" })}
              >
                Dismiss
              </Button>
            )}
          </div>
          {act.error && (
            <p role="alert" className="text-[0.85rem] text-bad">
              {act.error.message}
            </p>
          )}

          <div>
            <h3 className="eyebrow mb-3">History</h3>
            <ol className="grid gap-3" data-testid="watch-history">
              {w.history.map((e, i) => (
                <li key={`${e.at}-${i}`} className="text-[0.86rem]">
                  <p className="text-ink">{e.title}</p>
                  <p className="text-muted">{e.text}</p>
                  <p className="text-[0.76rem] text-faint">
                    {dateTime(e.at)}
                    {SENT_LABEL[e.sent] ? ` · ${SENT_LABEL[e.sent]}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </Sheet>
  );
}

function SettingsPanel({
  settings,
}: {
  settings: NonNullable<ReturnType<typeof useWatches>["data"]>["settings"];
}) {
  const save = useWatchSettings();
  const [region, setRegion] = useState(settings.region);
  return (
    <Section title="What to tell you">
      <ul className="grid gap-1" aria-label="Release watch settings">
        <li className="flex items-center justify-between gap-4">
          <span className="min-w-0">
            <span className="block text-[0.92rem] text-ink">Watch movie requests</span>
            <span className="block text-[0.8rem] text-muted">
              Follow every movie requested in Seerr until it is in your library.
            </span>
          </span>
          <Switch
            label="Watch movie requests"
            checked={settings.enabled}
            onChange={(enabled) => save.mutate({ enabled })}
          />
        </li>
        {RELEASE_NOTIFY_KINDS.map((k) => (
          <li key={k.id} className="flex items-center justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-[0.92rem] text-ink">{k.label}</span>
              <span className="block text-[0.8rem] text-muted">{k.detail}</span>
            </span>
            <Switch
              label={k.label}
              checked={settings.notify[k.id]}
              onChange={(on) => save.mutate({ notify: { ...settings.notify, [k.id]: on } })}
            />
          </li>
        ))}
        <li className="flex items-center justify-between gap-4">
          <span className="min-w-0">
            <label htmlFor="release-overdue" className="block text-[0.92rem] text-ink">
              Overdue after
            </label>
            <span className="block text-[0.8rem] text-muted">
              Days after the digital release date with nothing grabbed before a movie is marked
              overdue and you are told. The date passing does not prove a release is on offer.
            </span>
          </span>
          <select
            id="release-overdue"
            value={settings.overdueAfterDays}
            onChange={(e) => save.mutate({ overdueAfterDays: Number(e.target.value) })}
            className="min-h-11 rounded-lg border border-line-strong bg-bg px-2 text-[0.9rem] text-ink"
            data-testid="release-overdue"
          >
            {[0, 1, 2, 3, 5, 7, 14].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "On the day" : `${n} day${n === 1 ? "" : "s"}`}
              </option>
            ))}
          </select>
        </li>
      </ul>
      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ region });
        }}
      >
        <div>
          <label htmlFor="release-region" className="mb-1 block text-[0.8rem] text-faint">
            Country for release dates (two letters, empty for Seerr's own)
          </label>
          <input
            id="release-region"
            value={region}
            maxLength={2}
            onChange={(e) => setRegion(e.target.value.toUpperCase())}
            className="min-h-11 w-24 rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink uppercase focus:border-gold/60 focus:outline-none"
          />
        </div>
        <Button type="submit" disabled={save.isPending}>
          Save country
        </Button>
      </form>
      {save.error && (
        <p role="alert" className="mt-2 text-[0.85rem] text-bad">
          {save.error.message}
        </p>
      )}
      <p className="mt-4 text-[0.8rem] text-muted">
        Messages go to the channels chosen for "Movie releases" on the{" "}
        <Link to="/notifications" className="text-gold underline underline-offset-4">
          Notifications
        </Link>{" "}
        page.
      </p>
    </Section>
  );
}

export function ReleasesPage() {
  const watches = useWatches();
  const check = useCheckWatches();
  const [params, setParams] = useSearchParams();
  const view = (params.get("view") as WatchView | null) ?? "upcoming";
  const open = params.get("watch") ?? undefined;
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: k === "watch" ? false : true });
  };
  if (!watches.data) return <PageSkeleton />;
  const { watches: all, settings, seerr, radarr } = watches.data;
  const shown = all.filter((w) => w.view === view);
  const attention = all.filter((w) => w.view === "attention").length;
  return (
    <>
      <PageHeader
        eyebrow="Media"
        title="Releases"
        subtitle={
          attention
            ? `${attention} need${attention === 1 ? "s" : ""} a look. Movies you requested in Seerr, followed until they are in your library.`
            : "Movies you requested in Seerr, followed until they are in your library. Hearth checks the dates and Radarr on its own, and tells you when something happens."
        }
        actions={
          seerr > 0 ? (
            <Button tone="primary" disabled={check.isPending} onClick={() => check.mutate()}>
              {check.isPending ? "Checking…" : "Check now"}
            </Button>
          ) : undefined
        }
      />
      {seerr === 0 ? (
        <EmptyState
          title="Watch a Seerr first"
          action={<LinkButton to="/discover">Discover this machine</LinkButton>}
        >
          Release watch reads your movie requests from Seerr (or Overseerr, or Jellyseerr). Adopt
          it, and add its API key in Secure Vault.
        </EmptyState>
      ) : (
        <>
          {radarr === 0 && (
            <p className="mb-6 rounded-xl border border-warn/40 px-4 py-3 text-[0.88rem] text-warn">
              No Radarr is watched, so Hearth can follow release dates but cannot see downloads.
              Adopt Radarr and add its key in Secure Vault.
            </p>
          )}
          {!settings.enabled && (
            <p className="mb-6 rounded-xl border border-line-strong px-4 py-3 text-[0.88rem] text-muted">
              Watching is switched off: nothing is checked or sent. Switch it on below.
            </p>
          )}
          {check.data?.errors.length ? (
            <p role="alert" className="mb-6 text-[0.85rem] text-warn">
              {check.data.errors.join(" ")}
            </p>
          ) : null}
          <div className="mb-6">
            <Segmented
              label="Show"
              value={view}
              options={VIEWS.map((v) => ({
                ...v,
                count: all.filter((w) => w.view === v.value).length,
              }))}
              onChange={(v) => set("view", v === "upcoming" ? "" : v)}
            />
          </div>
          {shown.length === 0 ? (
            <EmptyState
              title={
                view === "attention"
                  ? "Nothing needs a look"
                  : view === "completed"
                    ? "Nothing has arrived yet"
                    : view === "dismissed"
                      ? "Nothing dismissed"
                      : "No movies on the way"
              }
            >
              {view === "upcoming"
                ? "When someone requests a movie in Seerr, it appears here on its own."
                : undefined}
            </EmptyState>
          ) : (
            <Rows className="mb-12 rounded-xl border border-line">
              {shown.map((w) => (
                <WatchRow key={w.id} w={w} onOpen={() => set("watch", w.id)} />
              ))}
            </Rows>
          )}
        </>
      )}
      {seerr > 0 && <SettingsPanel settings={settings} />}
      {open && <WatchSheet id={open} onClose={() => set("watch", "")} />}
    </>
  );
}
