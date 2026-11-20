import { RotateCcw, Search } from "lucide-react";
import type { BazarrDashboard as Data } from "@dragon-control/core";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { Button, Skeleton, cx } from "../ui";
import { ChangeCard, useConfirmedChange } from "./ConfirmedChange";

/**
 * Bazarr from Hearth: which movies and episodes are missing subtitles and in which languages,
 * whether each provider works or is throttled (and when it is tried again), and recent downloads.
 * Searching one item, searching everything, and resetting throttled providers are plans
 * confirmed here.
 */

const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.76rem] text-muted hover:border-gold/60 hover:text-gold";

function Wanted({
  serviceId,
  title,
  missing,
  params,
}: {
  serviceId: string;
  title: string;
  missing: string[];
  params: { op: "search-movie"; radarrId: number } | { op: "search-episode"; episodeId: number };
}) {
  const c = useConfirmedChange(serviceId);
  return (
    <li
      className="space-y-1.5 py-2.5"
      data-testid="bazarr-wanted"
      data-capture-item
      data-capture-label={title}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[0.88rem] break-words text-ink">{title}</span>
        <button
          type="button"
          className={btn}
          data-testid="bazarr-search"
          onClick={() =>
            void c.propose("app-bazarr-subtitles", params, `Search subtitles for ${title}`)
          }
        >
          <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Search
        </button>
      </div>
      <p className="flex flex-wrap gap-1.5">
        {missing.map((m) => (
          <span
            key={m}
            className="rounded-full border border-amber/40 px-2 py-0.5 text-[0.7rem] text-amber"
          >
            {m}
          </span>
        ))}
      </p>
      <ChangeCard c={c} />
    </li>
  );
}

export function BazarrDashboard({ serviceId, name }: { serviceId: string; name: string }) {
  const q = useDashboard(serviceId, true, 30_000);
  const all = useConfirmedChange(serviceId);
  const d: Data | undefined = q.data?.data?.app === "bazarr" ? q.data.data : undefined;
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return (
      <div
        className="rounded-xl border border-amber/40 p-4 text-[0.88rem]"
        data-testid="bazarr-error"
      >
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
      </div>
    );
  if (!d) return null;
  const section = (label: string, n: number, shown: number) => (
    <p className="mb-1 text-[0.72rem] tracking-wide text-faint uppercase">
      {label} · {n}
      {n > shown ? ` (first ${shown} shown)` : ""}
    </p>
  );
  return (
    <section
      className="@container space-y-4"
      data-testid="bazarr-dashboard"
      aria-label={`${name}: subtitles`}
    >
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        {(
          [
            ["Movies missing", `${d.totals.movies}`, "subtitles"],
            ["Episodes missing", `${d.totals.episodes}`, "subtitles"],
            [
              "Providers",
              `${d.totals.providers - d.totals.throttled}`,
              `working, of ${d.totals.providers}`,
            ],
            [
              "Throttled",
              `${d.totals.throttled}`,
              d.totals.throttled ? "paused by Bazarr" : "none",
            ],
          ] as const
        ).map(([label, value, sub]) => (
          <div key={label} className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
            <p className="text-[0.72rem] tracking-wide text-faint uppercase">{label}</p>
            <p
              className={cx(
                "stat-value text-ink tabular",
                label === "Throttled" && d.totals.throttled > 0 && "text-amber",
              )}
              data-testid={
                label === "Movies missing"
                  ? "bazarr-movies"
                  : label === "Throttled"
                    ? "bazarr-throttled"
                    : undefined
              }
            >
              {value}
            </p>
            <p className="text-[0.74rem] text-faint">{sub}</p>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {d.totals.movies + d.totals.episodes > 0 && (
            <Button
              tone="outline"
              data-testid="bazarr-search-all"
              onClick={() =>
                void all.propose(
                  "app-bazarr-subtitles",
                  { op: "search-all" },
                  "Search all missing subtitles",
                )
              }
            >
              <Search className="h-4 w-4" /> Search everything missing
            </Button>
          )}
          {d.totals.throttled > 0 && (
            <Button
              tone="outline"
              data-testid="bazarr-reset"
              onClick={() =>
                void all.propose(
                  "app-bazarr-subtitles",
                  { op: "reset-providers" },
                  "Reset throttled providers",
                )
              }
            >
              <RotateCcw className="h-4 w-4" /> Reset throttled providers
            </Button>
          )}
        </div>
        <ChangeCard c={all} />
      </div>

      <div className="grid gap-4 @2xl:grid-cols-2">
        <div>
          {section("Movies", d.totals.movies, d.movies.length)}
          {d.movies.length ? (
            <ul className="divide-y divide-line">
              {d.movies.map((m) => (
                <Wanted
                  key={m.radarrId}
                  serviceId={serviceId}
                  title={m.title}
                  missing={m.missing}
                  params={{ op: "search-movie", radarrId: m.radarrId }}
                />
              ))}
            </ul>
          ) : (
            <p className="text-[0.86rem] text-muted">Every movie has its subtitles.</p>
          )}
        </div>
        <div>
          {section("Episodes", d.totals.episodes, d.episodes.length)}
          {d.episodes.length ? (
            <ul className="divide-y divide-line">
              {d.episodes.map((e) => (
                <Wanted
                  key={e.episodeId}
                  serviceId={serviceId}
                  title={e.title}
                  missing={e.missing}
                  params={{ op: "search-episode", episodeId: e.episodeId }}
                />
              ))}
            </ul>
          ) : (
            <p className="text-[0.86rem] text-muted">Every episode has its subtitles.</p>
          )}
        </div>
      </div>

      {d.providers.length > 0 && (
        <div>
          <p className="mb-1.5 text-[0.72rem] tracking-wide text-faint uppercase">Providers</p>
          <ul className="flex flex-wrap gap-2" data-testid="bazarr-providers">
            {d.providers.map((p) => (
              <li
                key={p.name}
                className={cx(
                  "rounded-lg border px-2.5 py-1 text-[0.8rem]",
                  p.ok ? "border-line text-ink" : "border-amber/50 text-amber",
                )}
              >
                {p.name}
                <span className="text-faint">
                  {p.ok
                    ? " · working"
                    : ` · ${p.why ?? "throttled"}${p.retry ? `, tries again ${p.retry}` : ""}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {d.history.length > 0 && (
        <div>
          <p className="mb-1.5 text-[0.72rem] tracking-wide text-faint uppercase">
            Recently downloaded
          </p>
          <ul className="divide-y divide-line" data-testid="bazarr-history">
            {d.history.map((h, i) => (
              <li key={i} className="flex flex-wrap items-center gap-x-3 py-2 text-[0.84rem]">
                <span className="min-w-0 flex-1 text-ink">{h.title}</span>
                <span className="text-[0.76rem] text-faint">
                  {[h.text, h.at ? ago(h.at) : ""].filter(Boolean).join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[0.74rem] text-faint">
        {q.data?.sample ? "Sample data · " : ""}
        {d.version ? `${name} ${d.version} · ` : ""}live, every 30 s
      </p>
    </section>
  );
}
