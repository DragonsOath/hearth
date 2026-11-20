import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import { useMemo, useState } from "react";
import { AlertTriangle, Film, FolderOpen, MessageCircle, Search } from "lucide-react";
import {
  REQUEST_STAGE_LABEL,
  type RequestedMovie,
  type RequestedShow,
  type RequestStage,
  type SeerrDashboard as Data,
} from "@dragon-control/core";
import { useDashboard } from "../../data/dashboards";
import { useCave } from "../shell/cave-context";
import { Button, Segmented, Skeleton, cx } from "../ui";
import { ChangeCard, useConfirmedChange } from "./ConfirmedChange";
import { EmberMark } from "../ember/EmberMark";

/**
 * Overseerr / Jellyseerr as a movie request dashboard: every request with its poster, digital
 * release date (never a theatrical one in its place), approval, and where it stands in Radarr
 * (which instance, root folder, quality profile, download). Overdue requests are marked: the
 * digital date passed and nothing is grabbed, which does not prove a release is on offer, so the
 * wording says only that. Reading changes nothing; Search proposes a plan you approve.
 */

type Scope = "mine" | "all";
type Filter = "any" | "overdue" | "active" | "waiting" | "library" | "trouble";
type Sort = "requested" | "digital" | "status" | "overdue";

const GOOD: RequestStage[] = ["imported"];
const MOVING: RequestStage[] = ["grabbed", "downloading", "awaiting-import"];
const TROUBLE: RequestStage[] = [
  "download-problem",
  "not-in-radarr",
  "request-failed",
  "not-monitored",
  "radarr-unknown",
];
/** Status order for sorting: what needs you first. */
const ORDER: RequestStage[] = [
  "download-problem",
  "request-failed",
  "not-in-radarr",
  "not-monitored",
  "awaiting-approval",
  "searching",
  "radarr-unknown",
  "waiting-release",
  "grabbed",
  "downloading",
  "awaiting-import",
  "imported",
  "declined",
];

const longDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

function stageTone(m: RequestedMovie) {
  if (m.overdueDays !== undefined || TROUBLE.includes(m.stage)) return "border-amber/50 text-amber";
  if (GOOD.includes(m.stage)) return "border-live/40 text-live";
  if (MOVING.includes(m.stage)) return "border-gold/50 text-gold";
  return "border-line-strong text-muted";
}

function Poster({ serviceId, m }: { serviceId: string; m: { poster?: string } }) {
  const [failed, setFailed] = useState(false);
  return m.poster && !failed ? (
    <img
      src={`/api/services/${serviceId}/dashboard/poster?path=${encodeURIComponent(m.poster)}`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="aspect-[2/3] w-full rounded-lg bg-raised object-cover"
    />
  ) : (
    <div
      aria-hidden="true"
      className="flex aspect-[2/3] w-full items-center justify-center rounded-lg bg-gradient-to-b from-raised to-bg text-faint"
    >
      <Film strokeWidth={1.2} className="h-8 w-8" />
    </div>
  );
}

function MovieCard({
  serviceId,
  m,
  showWho,
  showInstance,
  roots,
}: {
  serviceId: string;
  m: RequestedMovie;
  showWho: boolean;
  showInstance: boolean;
  /** The root folders of the Radarr that has this movie. */
  roots: string[];
}) {
  const cave = useCave();
  const c = useConfirmedChange(serviceId);
  const [moving, setMoving] = useState(false);
  const [newRoot, setNewRoot] = useState("");
  const [moveFiles, setMoveFiles] = useState(true);
  const act = useApproveHere(serviceId, "Proposed from the Overseerr dashboard.");
  const error = act.error;
  const radarr = m.radarr;
  const name = `${m.title}${m.year ? ` (${m.year})` : ""}`;
  const canSearch =
    radarr && !GOOD.includes(m.stage) && !MOVING.includes(m.stage) && m.stage !== "declined";
  const search = () =>
    act.propose(
      "app-arr-search",
      { movieId: radarr!.movieId },
      `Search for ${name}`,
      radarr!.serviceId,
    );

  return (
    <li
      className={cx(
        "flex gap-3 rounded-xl border bg-bg/50 p-3",
        m.overdueDays !== undefined ? "border-amber/50" : "border-line",
      )}
      data-testid="seerr-movie"
      data-overdue={m.overdueDays !== undefined ? "yes" : "no"}
      data-capture-item
      data-capture-label={name}
    >
      <div className="w-20 shrink-0 @md:w-24">
        <Poster serviceId={serviceId} m={m} />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-[0.95rem] leading-snug text-ink">{name}</p>
        <span
          className={cx(
            "fit-pill inline-flex rounded-full border px-2 py-0.5 text-[0.72rem]",
            stageTone(m),
          )}
          data-testid="seerr-stage"
        >
          {REQUEST_STAGE_LABEL[m.stage]}
          {m.stage === "downloading" && radarr?.progressPct !== undefined
            ? ` ${radarr.progressPct}%`
            : ""}
        </span>
        {m.overdueDays !== undefined && (
          <p
            className="flex items-start gap-1.5 text-[0.8rem] text-amber"
            data-testid="seerr-overdue"
          >
            <AlertTriangle strokeWidth={1.5} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {m.overdueDays === 0
              ? "Digital release is today. Not grabbed yet."
              : `Digital release was ${m.overdueDays} day${m.overdueDays === 1 ? "" : "s"} ago. Not grabbed yet.`}
          </p>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[0.78rem]">
          <dt className="text-faint">Digital</dt>
          <dd className="text-ink" data-testid="seerr-digital">
            {m.digital ? longDate(m.digital.date) : "Not announced"}
            {m.digital?.source === "radarr" && <span className="text-faint"> (from Radarr)</span>}
          </dd>
          {m.theatrical && (
            <>
              <dt className="text-faint">In cinemas</dt>
              <dd className="text-muted">{longDate(m.theatrical)}</dd>
            </>
          )}
          <dt className="text-faint">Requested</dt>
          <dd className="text-muted">
            {longDate(m.requestedAt.slice(0, 10))}
            {showWho && ` by ${m.mine ? "you" : m.requestedBy}`}
          </dd>
          {radarr?.rootFolder && (
            <>
              <dt className="text-faint">Goes to</dt>
              <dd className="flex min-w-0 items-center gap-1 text-ink">
                <FolderOpen strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0 text-faint" />
                <span
                  className="truncate font-mono text-[0.74rem]"
                  title={radarr.path}
                  data-testid="seerr-root"
                >
                  {radarr.rootFolder}
                </span>
                {roots.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setMoving((v) => !v)}
                    className="shrink-0 text-[0.72rem] text-gold underline underline-offset-2"
                    data-testid="seerr-change-root"
                  >
                    Change
                  </button>
                )}
              </dd>
            </>
          )}
          {radarr?.quality && (
            <>
              <dt className="text-faint">Quality</dt>
              <dd className="text-muted">
                {radarr.quality}
                {showInstance && ` · ${radarr.instance}`}
              </dd>
            </>
          )}
        </dl>
        {moving && radarr && (
          <form
            className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2 text-[0.78rem]"
            aria-label={`New root folder for ${name}`}
            onSubmit={(e) => {
              e.preventDefault();
              if (!newRoot) return;
              setMoving(false);
              void c.propose(
                "app-radarr-set-root-folder",
                { movieId: radarr.movieId, rootFolder: newRoot, moveFiles },
                `Change ${name}'s root folder`,
                radarr.serviceId,
              );
            }}
          >
            <select
              value={newRoot}
              onChange={(e) => setNewRoot(e.target.value)}
              aria-label="Root folder"
              className="min-h-9 rounded-lg border border-line bg-raised px-2 text-ink"
              data-testid="seerr-root-choice"
            >
              <option value="">Choose a root folder</option>
              {roots
                .filter((r) => r !== radarr.rootFolder)
                .map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
            </select>
            {radarr.hasFile && (
              <label className="inline-flex items-center gap-1.5 text-ink">
                <input
                  type="checkbox"
                  checked={moveFiles}
                  onChange={(e) => setMoveFiles(e.target.checked)}
                />
                Move its files too
              </label>
            )}
            <Button tone="primary" type="submit" disabled={!newRoot} data-testid="seerr-root-save">
              Change folder
            </Button>
          </form>
        )}
        {m.stage === "downloading" && radarr?.progressPct !== undefined && (
          <div
            className="h-1.5 overflow-hidden rounded-full bg-line"
            role="progressbar"
            aria-valuenow={radarr.progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${m.title} download`}
          >
            <div
              className="h-full rounded-full bg-gold"
              style={{ width: `${radarr.progressPct}%` }}
            />
          </div>
        )}
        <p className="text-[0.76rem] text-faint">{radarr?.problem ?? m.doing}</p>
        <div className="flex flex-wrap gap-2 pt-0.5">
          <button
            type="button"
            onClick={() =>
              cave.ask(
                `My Overseerr request for ${name} (TMDB ${m.tmdbId}) is "${REQUEST_STAGE_LABEL[m.stage]}"${m.overdueDays !== undefined ? `, ${m.overdueDays} days after its digital release` : ""}. What is actually happening with it in Radarr (indexers, download client, monitoring, quality profile), where will it be saved, and what should we do? Fix it if you can.`,
              )
            }
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
            data-testid="seerr-ask"
          >
            <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask why
            <EmberMark />
          </button>
          {canSearch && (
            <button
              type="button"
              disabled={act.pending}
              onClick={() => void search()}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.76rem] text-ink hover:border-gold hover:text-gold disabled:opacity-50"
              data-testid="seerr-search"
            >
              <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Search
            </button>
          )}
          {radarr && !radarr.monitored && (
            <Button
              tone="primary"
              disabled={c.busy}
              title="Radarr has this movie but is not looking for it. Monitor makes Radarr look for it again (it shows under Wanted once released)."
              onClick={() =>
                void c.propose(
                  "app-radarr-set-monitored",
                  { movieId: radarr.movieId, monitored: true },
                  `Monitor ${name} in Radarr`,
                  radarr.serviceId,
                )
              }
              data-testid="seerr-monitor"
            >
              Monitor
            </Button>
          )}
          {m.approval === "failed" && (
            <Button
              tone="primary"
              disabled={c.busy}
              title="Seerr could not hand this request to Radarr or Sonarr. Retry sends it again."
              onClick={() =>
                void c.propose("app-seerr-retry", { requestId: m.requestId }, `Retry ${name}`)
              }
              data-testid="seerr-retry"
            >
              Retry
            </Button>
          )}
          {m.approval !== "pending" && (
            <Button
              tone="outline"
              disabled={c.busy}
              title="Removes the request from Overseerr and stops Radarr monitoring it. The movie and its files stay."
              onClick={() =>
                void c.propose(
                  "app-seerr-remove",
                  { requestId: m.requestId },
                  `Stop tracking ${name}`,
                  undefined,
                  radarr?.monitored
                    ? [
                        {
                          kind: "app-radarr-set-monitored",
                          serviceId: radarr.serviceId,
                          params: { movieId: radarr.movieId, monitored: false },
                        },
                      ]
                    : [],
                )
              }
              data-testid="seerr-stop-tracking"
            >
              Stop tracking
            </Button>
          )}
          {m.approval === "pending" && (
            <>
              <Button
                tone="primary"
                disabled={c.busy}
                onClick={() =>
                  void c.propose("app-seerr-approve", { requestId: m.requestId }, `Approve ${name}`)
                }
                data-testid="seerr-approve"
              >
                Approve
              </Button>
              <Button
                tone="outline"
                disabled={c.busy}
                onClick={() =>
                  void c.propose("app-seerr-decline", { requestId: m.requestId }, `Decline ${name}`)
                }
                data-testid="seerr-decline"
              >
                Decline
              </Button>
            </>
          )}
        </div>
        {error && <p className="text-[0.76rem] text-amber">{error}</p>}
        <ApproveDialog c={act} />
        <ChangeCard c={c} />
      </div>
    </li>
  );
}

/** One show request: who asked, which seasons, and whether Sonarr is still looking for it. */
function ShowCard({
  serviceId,
  m,
  showWho,
}: {
  serviceId: string;
  m: RequestedShow;
  showWho: boolean;
}) {
  const c = useConfirmedChange(serviceId);
  const name = `${m.title}${m.year ? ` (${m.year})` : ""}`;
  const sonarr = m.sonarr;
  const all = sonarr && sonarr.episodes > 0 && sonarr.episodesOnDisk >= sonarr.episodes;
  return (
    <li
      className="flex gap-3 rounded-xl border border-line bg-bg/50 p-3"
      data-testid="seerr-show"
      data-capture-item
      data-capture-label={name}
    >
      <div className="w-20 shrink-0 @md:w-24">
        <Poster serviceId={serviceId} m={m} />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-[0.95rem] leading-snug text-ink">{name}</p>
        <p className="text-[0.8rem] text-muted">
          {m.seasons.length
            ? `Season${m.seasons.length > 1 ? "s" : ""} ${m.seasons.join(", ")}`
            : "The whole show"}
          {showWho ? ` · requested by ${m.requestedBy}` : ""}
          {m.approval === "pending" ? " · waiting for approval" : ""}
          {m.approval === "declined" ? " · declined" : ""}
        </p>
        <p className="text-[0.8rem] text-faint" data-testid="seerr-show-sonarr">
          {sonarr
            ? `${sonarr.instance}: ${sonarr.monitored ? "monitoring it" : "not monitoring it"} · ${sonarr.episodesOnDisk} of ${sonarr.episodes} episodes on disk${all ? " (all of them)" : ""}`
            : "Not in Sonarr"}
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {sonarr && !sonarr.monitored && (
            <Button
              tone="primary"
              disabled={c.busy}
              title="Sonarr has this show but is not looking for it. Monitor makes Sonarr look for its episodes again."
              onClick={() =>
                void c.propose(
                  "app-sonarr-set-monitored",
                  { seriesId: sonarr.seriesId, monitored: true },
                  `Monitor ${name} in Sonarr`,
                  sonarr.serviceId,
                )
              }
              data-testid="seerr-show-monitor"
            >
              Monitor
            </Button>
          )}
          {m.approval === "failed" && (
            <Button
              tone="primary"
              disabled={c.busy}
              title="Seerr could not hand this request to Radarr or Sonarr. Retry sends it again."
              onClick={() =>
                void c.propose("app-seerr-retry", { requestId: m.requestId }, `Retry ${name}`)
              }
              data-testid="seerr-retry"
            >
              Retry
            </Button>
          )}
          {m.approval !== "pending" && (
            <Button
              tone="outline"
              disabled={c.busy}
              title="Removes the request from Overseerr and stops Sonarr monitoring the show. The show and its files stay."
              onClick={() =>
                void c.propose(
                  "app-seerr-remove",
                  { requestId: m.requestId },
                  `Stop tracking ${name}`,
                  undefined,
                  sonarr?.monitored
                    ? [
                        {
                          kind: "app-sonarr-set-monitored",
                          serviceId: sonarr.serviceId,
                          params: { seriesId: sonarr.seriesId, monitored: false },
                        },
                      ]
                    : [],
                )
              }
              data-testid="seerr-stop-tracking"
            >
              Stop tracking
            </Button>
          )}
          {m.approval === "pending" && (
            <>
              <Button
                tone="primary"
                disabled={c.busy}
                onClick={() =>
                  void c.propose("app-seerr-approve", { requestId: m.requestId }, `Approve ${name}`)
                }
              >
                Approve
              </Button>
              <Button
                tone="outline"
                disabled={c.busy}
                onClick={() =>
                  void c.propose("app-seerr-decline", { requestId: m.requestId }, `Decline ${name}`)
                }
              >
                Decline
              </Button>
            </>
          )}
        </div>
        <ChangeCard c={c} />
      </div>
    </li>
  );
}

/**
 * Why the requests cannot be shown, and the way to fix it from here: a missing key is fetched by
 * a plan you approve (Hearth reads it from the app's own settings file into Secure Vault; Ember
 * never sees it), anything else goes to Ember to look into.
 */
function NotRead({
  serviceId,
  name,
  error,
}: {
  serviceId: string;
  name: string;
  error: { kind: string; message: string };
}) {
  const cave = useCave();
  // The key plan is confirmed right here (with a fresh "it's you"), not on another page.
  const c = useConfirmedChange(serviceId);
  const keyMissing = error.kind === "needs-key";
  const connect = () => c.propose("credential-import", {}, `Connect ${name}`.slice(0, 120));
  return (
    <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="seerr-error">
      <p className="text-amber">
        {keyMissing
          ? `Hearth is not connected to ${name} yet.`
          : `${name} could not be read right now.`}
      </p>
      <p className="mt-1 text-muted">
        {keyMissing
          ? `Its key is not in Secure Vault, so its movie requests cannot be shown. Hearth can take it from ${name}'s own settings file after you approve; Ember never sees it.`
          : error.message}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {keyMissing && (
          <Button
            tone="primary"
            disabled={c.busy}
            onClick={() => void connect()}
            data-testid="seerr-connect"
          >
            Connect {name}
          </Button>
        )}
        <Button
          tone="outline"
          onClick={() =>
            cave.ask(
              keyMissing
                ? `Connect ${name} and Radarr so the Overseerr panel can show my movie requests. Use a credential-import plan for whatever is missing.`
                : `The ${name} panel in Hearth says: "${error.message}". Find out why and fix it if you can (only Hearth's side; do not change ${name}).`,
            )
          }
          data-testid="seerr-ask-fix"
        >
          {keyMissing ? "Ask Ember to connect it" : "Ask Ember to look into it"}
          <EmberMark />
        </Button>
      </div>
      <ChangeCard c={c} />
    </div>
  );
}

export function SeerrDashboard({ serviceId, name }: { serviceId: string; name: string }) {
  const q = useDashboard(serviceId, true, 60_000);
  const d: Data | undefined = q.data?.data?.app === "seerr" ? q.data.data : undefined;
  const [scope, setScope] = useState<Scope>();
  const [filter, setFilter] = useState<Filter>("any");
  const [sort, setSort] = useState<Sort>("requested");
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"movies" | "shows">("movies");
  // Mine first, when Hearth's key belongs to someone who requested anything.
  const shownScope: Scope = scope ?? (d && d.totals.mine > 0 ? "mine" : "all");

  const list = useMemo(() => {
    if (!d) return [];
    const words = text.trim().toLowerCase();
    const rows = d.movies.filter(
      (m) =>
        (shownScope === "all" || m.mine) &&
        (!words ||
          m.title.toLowerCase().includes(words) ||
          m.requestedBy.toLowerCase().includes(words)) &&
        (filter === "any" ||
          (filter === "overdue" && m.overdueDays !== undefined) ||
          (filter === "active" && MOVING.includes(m.stage)) ||
          (filter === "waiting" &&
            ["awaiting-approval", "waiting-release", "searching"].includes(m.stage)) ||
          (filter === "library" && GOOD.includes(m.stage)) ||
          (filter === "trouble" && TROUBLE.includes(m.stage))),
    );
    const by: Record<Sort, (a: RequestedMovie, b: RequestedMovie) => number> = {
      requested: (a, b) => b.requestedAt.localeCompare(a.requestedAt),
      // Soonest first; not announced last.
      digital: (a, b) => (a.digital?.date ?? "9999").localeCompare(b.digital?.date ?? "9999"),
      status: (a, b) => ORDER.indexOf(a.stage) - ORDER.indexOf(b.stage),
      overdue: (a, b) => (b.overdueDays ?? -1) - (a.overdueDays ?? -1),
    };
    return [...rows].sort(by[sort]);
  }, [d, shownScope, filter, sort, text]);
  const shows = useMemo(() => {
    const words = text.trim().toLowerCase();
    return (d?.shows ?? []).filter(
      (m) =>
        (shownScope === "all" || m.mine) &&
        (!words ||
          m.title.toLowerCase().includes(words) ||
          m.requestedBy.toLowerCase().includes(words)),
    );
  }, [d, shownScope, text]);

  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error) return <NotRead serviceId={serviceId} name={name} error={q.data.error} />;
  if (!d) return null;
  const instances = new Set(d.movies.map((m) => m.radarr?.instance).filter(Boolean)).size;

  return (
    <section
      className="@container space-y-4"
      data-testid="seerr-dashboard"
      aria-label={`${name} requests`}
    >
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        {(
          [
            [
              "Overdue",
              d.totals.overdue,
              `${d.overdueAfterDays ? `${d.overdueAfterDays}+ days ` : ""}past digital, not grabbed`,
            ],
            ["My requests", d.totals.mine, d.me ? `as ${d.me}` : "movies"],
            ["All requests", d.totals.movies, "movies"],
            ["Awaiting approval", d.totals.awaitingApproval, "in Overseerr"],
          ] as const
        ).map(([label, value, sub]) => (
          <div key={label} className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
            <p className="text-[0.72rem] tracking-wide text-faint uppercase">{label}</p>
            <p
              className={cx(
                "stat-value text-ink tabular",
                label === "Overdue" && value > 0 && "text-amber",
              )}
              data-testid={label === "Overdue" ? "seerr-overdue-count" : undefined}
            >
              {value}
            </p>
            <p className="text-[0.74rem] text-faint">{sub}</p>
          </div>
        ))}
      </div>
      {d.notes.length > 0 && (
        <ul className="space-y-1" data-testid="seerr-notes">
          {d.notes.map((n) => (
            <li key={n} className="flex gap-2 text-[0.82rem] text-amber">
              <AlertTriangle strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0" /> {n}
            </li>
          ))}
        </ul>
      )}
      {(d.shows?.length ?? 0) > 0 && (
        <Segmented
          label="Movies or shows"
          value={kind}
          onChange={setKind}
          options={[
            { value: "movies", label: "Movies", count: d.movies.length },
            { value: "shows", label: "Shows", count: d.shows!.length },
          ]}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Whose requests"
          value={shownScope}
          onChange={setScope}
          options={[
            { value: "mine", label: "My requests", count: d.totals.mine },
            { value: "all", label: "All requests", count: d.totals.movies },
          ]}
        />
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search titles or people"
          aria-label="Search requests"
          className="min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-raised px-3 text-[0.84rem] text-ink"
          data-testid="seerr-search-box"
        />
        {kind === "movies" && (
          <>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as Filter)}
              aria-label="Show"
              className="min-h-9 rounded-lg border border-line bg-raised px-2 text-[0.82rem] text-ink"
              data-testid="seerr-filter"
            >
              <option value="any">Everything</option>
              <option value="overdue">Overdue</option>
              <option value="trouble">Needs a look</option>
              <option value="waiting">Waiting</option>
              <option value="active">Downloading</option>
              <option value="library">In your library</option>
            </select>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
              aria-label="Sort by"
              className="min-h-9 rounded-lg border border-line bg-raised px-2 text-[0.82rem] text-ink"
              data-testid="seerr-sort"
            >
              <option value="requested">Newest request</option>
              <option value="digital">Digital release</option>
              <option value="status">Status</option>
              <option value="overdue">Most overdue</option>
            </select>
          </>
        )}
      </div>
      <p className="text-[0.74rem] text-faint">
        {q.data?.sample ? "Sample data · " : ""}
        {d.version ? `${name} ${d.version} · ` : ""}release dates for {d.region} · refreshed every
        minute
      </p>
      {kind === "shows" ? (
        shows.length ? (
          <ul className="grid gap-3 @2xl:grid-cols-2" data-testid="seerr-shows">
            {shows.map((m) => (
              <ShowCard
                key={m.requestId}
                serviceId={serviceId}
                m={m}
                showWho={shownScope === "all"}
              />
            ))}
          </ul>
        ) : (
          <p className="text-[0.86rem] text-muted">No show requests match.</p>
        )
      ) : list.length ? (
        <ul className="grid gap-3 @2xl:grid-cols-2" data-testid="seerr-movies">
          {list.map((m) => (
            <MovieCard
              key={m.requestId}
              serviceId={serviceId}
              m={m}
              showWho={shownScope === "all"}
              showInstance={instances > 1}
              roots={d.radarrs?.find((r) => r.serviceId === m.radarr?.serviceId)?.rootFolders ?? []}
            />
          ))}
        </ul>
      ) : (
        <p className="text-[0.86rem] text-muted">
          {d.movies.length ? "No requests match." : "No movie requests yet."}
        </p>
      )}
    </section>
  );
}
