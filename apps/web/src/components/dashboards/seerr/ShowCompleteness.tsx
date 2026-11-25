import { useState } from "react";
import {
  CalendarClock,
  Check,
  ChevronDown,
  Layers,
  Library,
  Search,
  TriangleAlert,
} from "lucide-react";
import type { RequestedShow } from "@dragon-control/core";
import { Modal } from "../../workspace/dialogs";
import { cx } from "../../ui";
import { useSonarr } from "../sonarr/data";
import { Releases } from "../InteractiveSearch";
import { completeness, EPISODE_WORDS, type EpisodeState, type SeasonSummary } from "./missing";
import type { EpisodeRow } from "../sonarr/data";

/**
 * What's Missing (the Seerr panel, 11-24): one requested show's completeness, read from Sonarr
 * when opened. A header with the show and its numbers, then each season as a section to open,
 * every episode with where it stands, and Search on the ones missing: Sonarr's own interactive
 * search for that episode, where downloading the one you pick is a plan you approve.
 */

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

const TONE: Record<EpisodeState, string> = {
  "in-library": "text-live",
  downloading: "text-gold",
  missing: "text-amber",
  "not-monitored": "text-muted",
  next: "text-gold",
  upcoming: "text-muted",
  unknown: "text-faint",
};

function seasonBadge(s: SeasonSummary) {
  switch (s.state) {
    case "missing":
      return { text: `${s.missing} missing`, cls: "border-amber/50 text-amber" };
    case "complete":
      return { text: "Complete", cls: "border-live/40 text-live" };
    case "airing":
      return { text: `${s.present} of ${s.known}, airing`, cls: "border-gold/50 text-gold" };
    case "unreleased":
      return { text: "Not released", cls: "border-line-strong text-muted" };
    case "partial":
      return { text: `${s.notMonitored} not monitored`, cls: "border-line-strong text-muted" };
    default:
      return { text: "Dates unknown", cls: "border-line-strong text-faint" };
  }
}

export function ShowCompleteness({
  seerrId,
  show,
  onClose,
}: {
  seerrId: string;
  show: RequestedShow;
  onClose: () => void;
}) {
  const sonarr = show.sonarr!;
  const name = `${show.title}${show.year ? ` (${show.year})` : ""}`;
  const q = useSonarr(sonarr.serviceId, "series", { id: sonarr.seriesId });
  const c = q.data?.episodes ? completeness(q.data.episodes, q.data.queue ?? []) : undefined;
  const [searching, setSearching] = useState<EpisodeRow>();
  const img = (path: string, size?: string) =>
    `/api/services/${seerrId}/dashboard/poster?path=${encodeURIComponent(path)}${size ? `&size=${size}` : ""}`;

  return (
    <Modal title={name} onCancel={onClose} wide>
      <div className="mt-3 max-h-[75vh] space-y-4 overflow-y-auto" data-testid="seerr-completeness">
        <div className="relative overflow-hidden rounded-xl border border-line">
          {show.backdrop && (
            <img
              src={img(show.backdrop, "backdrop")}
              alt=""
              className="absolute inset-0 h-full w-full object-cover opacity-35"
            />
          )}
          <div className="relative flex gap-3 bg-gradient-to-t from-panel via-panel/80 to-transparent p-3">
            {show.poster && (
              <img
                src={img(show.poster)}
                alt=""
                className="aspect-[2/3] w-20 shrink-0 rounded-lg object-cover sm:w-24"
              />
            )}
            <div className="min-w-0 self-end">
              <p className="text-[0.82rem] text-muted">
                Requested by {show.mine ? "you" : show.requestedBy}
                {show.network ? ` · ${show.network}` : ""}
                {show.showStatus ? ` · ${show.showStatus}` : ""}
              </p>
              {show.genres && show.genres.length > 0 && (
                <p className="mt-1.5 flex flex-wrap gap-1">
                  {show.genres.map((g) => (
                    <span
                      key={g}
                      className="rounded-full border border-line-strong px-2 py-0.5 text-[0.7rem] text-muted"
                    >
                      {g}
                    </span>
                  ))}
                </p>
              )}
            </div>
          </div>
        </div>

        {q.isLoading && <p className="text-[0.85rem] text-muted">Asking {sonarr.instance}</p>}
        {q.error && (
          <p role="alert" className="text-[0.85rem] text-amber">
            {q.error.message}
          </p>
        )}

        {c && (
          <>
            <dl
              className="grid grid-cols-2 gap-2 sm:grid-cols-4"
              data-testid="seerr-completeness-stats"
            >
              <Stat icon={<Library className="h-4 w-4" />} label="In your library">
                {c.present} / {c.known}
              </Stat>
              <Stat icon={<Layers className="h-4 w-4" />} label="Seasons">
                {c.seasonsInLibrary} of {c.seasons.length}
              </Stat>
              <Stat
                icon={<TriangleAlert className="h-4 w-4" />}
                label="Missing"
                warn={c.missing > 0}
              >
                {c.missing ? `${c.missing} episode${c.missing === 1 ? "" : "s"}` : "None"}
              </Stat>
              <Stat icon={<CalendarClock className="h-4 w-4" />} label="Next episode">
                {c.next?.airDate
                  ? `${shortDate(c.next.airDate)} · ${c.next.code}`
                  : sonarr.ended
                    ? "The show has ended"
                    : "Not announced"}
              </Stat>
            </dl>

            <div className="space-y-2" data-testid="seerr-seasons">
              {c.seasons.map((s) => {
                const badge = seasonBadge(s);
                return (
                  <details
                    key={s.season}
                    open={s.missing > 0}
                    className="group rounded-xl border border-line bg-bg/40"
                    data-testid="seerr-season"
                  >
                    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2">
                      <ChevronDown
                        strokeWidth={1.5}
                        className="h-4 w-4 shrink-0 -rotate-90 text-muted transition-transform group-open:rotate-0"
                      />
                      <span className="text-[0.92rem] text-ink">Season {s.season}</span>
                      <span className="text-[0.76rem] text-faint">
                        {s.present} of {s.known} in library
                      </span>
                      <span
                        className={cx(
                          "ml-auto rounded-full border px-2 py-0.5 text-[0.7rem] whitespace-nowrap",
                          badge.cls,
                        )}
                      >
                        {badge.text}
                      </span>
                    </summary>
                    <ul className="divide-y divide-line border-t border-line">
                      {s.episodes.map(({ e, state, queued }) => (
                        <li
                          key={e.id}
                          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
                          data-testid="seerr-episode"
                          data-state={state}
                        >
                          <span className="w-14 shrink-0 font-mono text-[0.74rem] text-muted">
                            {e.code}
                          </span>
                          <span className="min-w-0 flex-1 basis-40 truncate text-[0.82rem] text-ink">
                            {e.title || "Untitled"}
                          </span>
                          <span className="text-[0.72rem] text-faint">
                            {e.airDate ? shortDate(e.airDate) : ""}
                          </span>
                          <span className={cx("text-[0.74rem]", TONE[state])}>
                            {state === "in-library" && (
                              <Check strokeWidth={2} className="mr-0.5 inline h-3.5 w-3.5" />
                            )}
                            {EPISODE_WORDS[state]}
                            {state === "downloading" && queued?.progressPct !== undefined
                              ? ` ${queued.progressPct}%`
                              : ""}
                          </span>
                          {(state === "missing" || state === "not-monitored") && (
                            <button
                              type="button"
                              onClick={() => setSearching(e)}
                              className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-gold/40 px-2.5 text-[0.74rem] text-gold hover:bg-gold/10"
                              data-testid="seerr-episode-search"
                            >
                              <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Search
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                );
              })}
            </div>
            {c.notMonitored > 0 && (
              <p className="text-[0.76rem] text-faint">
                {c.notMonitored} aired episode{c.notMonitored === 1 ? " isn't" : "s aren't"} on disk
                and Sonarr isn&apos;t monitoring {c.notMonitored === 1 ? "it" : "them"}, so they
                aren&apos;t counted as missing.
              </p>
            )}
          </>
        )}
      </div>
      {searching && (
        <Modal
          title="Interactive search"
          onCancel={() => {
            setSearching(undefined);
            void q.refetch();
          }}
          wide
        >
          <div
            className="mt-3 max-h-[75vh] space-y-3 overflow-y-auto"
            data-testid="seerr-episode-releases"
          >
            <div className="flex items-center gap-3">
              {show.poster && (
                <img
                  src={img(show.poster)}
                  alt=""
                  className="aspect-[2/3] w-12 shrink-0 rounded-md object-cover"
                />
              )}
              <div className="min-w-0">
                <p className="text-[0.95rem] text-ink">{name}</p>
                <p className="text-[0.82rem] text-muted">
                  {searching.code}
                  {searching.title ? ` · ${searching.title}` : ""}
                </p>
              </div>
            </div>
            <p className="text-[0.8rem] text-muted">
              Search results from {sonarr.instance} for this episode. Searching downloads nothing;
              the one you pick is a plan you approve.
            </p>
            <Releases
              serviceId={sonarr.serviceId}
              app="sonarr"
              scope={{ episodeId: searching.id }}
              label={`${show.title} ${searching.code}`}
            />
          </div>
        </Modal>
      )}
    </Modal>
  );
}

function Stat({
  icon,
  label,
  warn,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  warn?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cx(
        "rounded-xl border p-2.5",
        warn ? "border-amber/50 bg-amber/5" : "border-line bg-bg/40",
      )}
    >
      <dt
        className={cx(
          "flex items-center gap-1.5 text-[0.72rem]",
          warn ? "text-amber" : "text-faint",
        )}
      >
        {icon}
        {label}
      </dt>
      <dd className={cx("mt-0.5 text-[0.9rem] tabular", warn ? "text-amber" : "text-ink")}>
        {children}
      </dd>
    </div>
  );
}
