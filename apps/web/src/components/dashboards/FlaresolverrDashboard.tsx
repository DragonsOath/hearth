import { MessageCircle } from "lucide-react";
import { api } from "../../data/api";
import { ago } from "../../lib/format";
import { useCave } from "../shell/cave-context";
import { Skeleton, cx } from "../ui";
import { useLiveQuery } from "../panels/lifecycle";
import { EmberMark } from "../ember/EmberMark";

/**
 * FlareSolverr from Hearth: whether it is running, and from its own log what it solved for which
 * sites, what failed and why, and how long each took. It has no settings to change from here.
 */

interface Panel {
  available: boolean;
  reason?: string;
  at: string;
  running?: boolean;
  startedAt?: string;
  restarts?: number;
  version?: string;
  requests?: {
    at?: string;
    site: string;
    outcome: "solved" | "no-challenge" | "failed";
    seconds?: number;
    why?: string;
  }[];
  sites?: { site: string; requests: number; solved: number; failed: number; avgSeconds?: number }[];
}

const WORD = { solved: "Solved", "no-challenge": "No challenge", failed: "Failed" } as const;

export function FlaresolverrDashboard({ serviceId, name }: { serviceId: string; name: string }) {
  const q = useLiveQuery({
    queryKey: ["dashboard", serviceId, "flaresolverr"],
    queryFn: () => api<Panel>("GET", `/api/services/${serviceId}/flaresolverr`),
    refetchInterval: 60_000,
  });
  const cave = useCave();
  const d = q.data;
  if (q.isLoading) return <Skeleton className="h-48" />;
  if (q.error || !d?.available)
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="fs-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{d?.reason ?? q.error?.message}</p>
      </div>
    );
  const requests = d.requests ?? [];
  const failed = requests.filter((r) => r.outcome === "failed");
  return (
    <section
      className="@container space-y-4"
      data-testid="fs-dashboard"
      aria-label={`${name}: challenges`}
    >
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        {(
          [
            [
              "State",
              d.running ? "Running" : "Stopped",
              d.startedAt ? `since ${ago(d.startedAt)}` : "",
            ],
            ["Requests", `${requests.length}`, "recent, in its log"],
            [
              "Solved",
              `${requests.filter((r) => r.outcome === "solved").length}`,
              "challenges passed",
            ],
            ["Failed", `${failed.length}`, failed.length ? "need a look" : "none"],
          ] as const
        ).map(([label, value, sub]) => (
          <div key={label} className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
            <p className="text-[0.72rem] tracking-wide text-faint uppercase">{label}</p>
            <p
              className={cx(
                "stat-value text-ink tabular",
                label === "State" && (d.running ? "text-live" : "text-alert"),
                label === "Failed" && failed.length > 0 && "text-alert",
              )}
              data-testid={label === "Failed" ? "fs-failed" : undefined}
            >
              {value}
            </p>
            <p className="text-[0.74rem] text-faint">{sub}</p>
          </div>
        ))}
      </div>

      {(d.sites ?? []).length > 0 && (
        <div>
          <p className="mb-1 text-[0.72rem] tracking-wide text-faint uppercase">By site</p>
          <ul className="divide-y divide-line text-[0.84rem]" data-testid="fs-sites">
            {d.sites!.map((s) => (
              <li key={s.site} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
                <span className="min-w-0 flex-1 break-words text-ink">{s.site}</span>
                <span className="text-faint">
                  {s.requests} requests · {s.solved} solved
                  {s.failed ? <span className="text-alert"> · {s.failed} failed</span> : null}
                  {s.avgSeconds !== undefined ? ` · ${s.avgSeconds} s each` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <p className="mb-1 text-[0.72rem] tracking-wide text-faint uppercase">Latest</p>
        {requests.length ? (
          <ul className="divide-y divide-line text-[0.82rem]">
            {requests.map((r, i) => (
              <li key={i} className="py-1.5">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="min-w-0 flex-1 break-words text-ink">{r.site}</span>
                  <span
                    className={cx(
                      r.outcome === "failed"
                        ? "text-alert"
                        : r.outcome === "solved"
                          ? "text-live"
                          : "text-faint",
                    )}
                  >
                    {WORD[r.outcome]}
                    {r.seconds !== undefined ? ` · ${r.seconds} s` : ""}
                  </span>
                  {r.at && <span className="text-faint">{ago(r.at)}</span>}
                </div>
                {r.why && <p className="text-[0.78rem] break-words text-alert">{r.why}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[0.86rem] text-muted">
            Nothing has asked it to solve a challenge recently.
          </p>
        )}
        {failed.length > 0 && (
          <button
            type="button"
            className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
            onClick={() =>
              cave.ask(
                `FlareSolverr failed ${failed.length} recent challenges, for ${[...new Set(failed.map((f) => f.site))].join(", ")}: "${failed[0]?.why ?? ""}". Why, and which Prowlarr indexers are affected?`,
              )
            }
          >
            <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask why
            <EmberMark />
          </button>
        )}
      </div>
      <p className="text-[0.74rem] text-faint">
        {d.version ? `${name} ${d.version} · ` : ""}from its own log · checked {ago(d.at)}
      </p>
    </section>
  );
}
