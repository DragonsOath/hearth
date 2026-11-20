import { MessageCircle, Power, RefreshCw, Send, Stethoscope } from "lucide-react";
import type { ProwlarrDashboard as Data } from "@dragon-control/core";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { useCave } from "../shell/cave-context";
import { Button, Skeleton, cx } from "../ui";
import { ChangeCard, useConfirmedChange } from "./ConfirmedChange";
import { EmberMark } from "../ember/EmberMark";

/**
 * Prowlarr from Hearth: every indexer with whether it works and why not, this week's searches and
 * grabs, which apps Prowlarr feeds, and testing one or all indexers, switching one on or off, and
 * sending the list to the apps. Each control is a plan confirmed here.
 */

type Ix = Data["indexers"][number];

const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.76rem] text-muted hover:border-gold/60 hover:text-gold";

function IndexerRow({ serviceId, ix }: { serviceId: string; ix: Ix }) {
  const c = useConfirmedChange(serviceId);
  const cave = useCave();
  const tone = !ix.enabled ? "off" : ix.failing ? "bad" : "ok";
  const until = ix.pausedUntil
    ? new Date(ix.pausedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "";
  return (
    <li
      className={cx(
        "space-y-2 rounded-xl border bg-bg/50 p-3",
        tone === "bad" ? "border-alert/40" : "border-line",
        tone === "off" && "opacity-75",
      )}
      data-testid="prowlarr-indexer"
      data-hearth-target={`indexer:${ix.id}`}
      data-capture-item
      data-capture-label={ix.name}
    >
      <p className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 text-[0.92rem] break-words text-ink">{ix.name}</span>
        <span
          className={cx(
            "fit-pill rounded-full border px-2 py-0.5 text-[0.7rem]",
            tone === "bad"
              ? "border-alert/50 text-alert"
              : tone === "ok"
                ? "border-live/40 text-live"
                : "border-line-strong text-faint",
          )}
          data-testid="prowlarr-state"
        >
          {tone === "bad" ? "Failing" : tone === "ok" ? "Working" : "Off"}
        </span>
        <span className="text-[0.74rem] text-faint">
          {[
            ix.protocol,
            ix.privacy === "semiPrivate" ? "semi-private" : ix.privacy,
            ix.proxies?.length ? `through ${ix.proxies.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </p>
      {ix.failing && (
        <p className="text-[0.78rem] text-alert" data-testid="prowlarr-why">
          {ix.pausedUntil
            ? `Prowlarr paused it after failures and tries again at ${until}.`
            : "It failed recently."}
          {ix.lastFailure ? ` Last failure ${ago(ix.lastFailure)}.` : ""}
        </p>
      )}
      <p className="text-[0.76rem] text-faint">
        This week: {ix.queries} searches · {ix.grabs} grabs
        {ix.failedQueries ? ` · ${ix.failedQueries} searches failed` : ""}
        {ix.failedGrabs ? ` · ${ix.failedGrabs} grabs failed` : ""}
        {ix.avgMs ? ` · answers in ${(ix.avgMs / 1000).toFixed(1)} s` : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        {ix.enabled && (
          <button
            type="button"
            className={btn}
            data-testid="prowlarr-test"
            data-hearth-target="indexer:test"
            onClick={() =>
              void c.propose(
                "app-prowlarr-indexer",
                { op: "test", indexerId: ix.id },
                `Test ${ix.name}`,
              )
            }
          >
            <Stethoscope strokeWidth={1.5} className="h-3.5 w-3.5" /> Test
          </button>
        )}
        <button
          type="button"
          className={cx(btn, ix.enabled && "hover:border-alert/60 hover:text-alert")}
          data-testid={ix.enabled ? "prowlarr-disable" : "prowlarr-enable"}
          data-hearth-target="indexer:switch"
          onClick={() => {
            const op = ix.enabled ? "disable" : "enable";
            void c.propose(
              "app-prowlarr-indexer",
              { op, indexerId: ix.id },
              `${ix.enabled ? "Turn off" : "Turn on"} ${ix.name}`,
            );
          }}
        >
          <Power strokeWidth={1.5} className="h-3.5 w-3.5" /> {ix.enabled ? "Turn off" : "Turn on"}
        </button>
        {ix.failing && (
          <button
            type="button"
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
            onClick={() =>
              cave.ask(
                `The Prowlarr indexer ${ix.name} (${ix.protocol ?? "indexer"}${ix.proxies?.length ? `, through ${ix.proxies.join(", ")}` : ""}) is failing${ix.pausedUntil ? " and Prowlarr paused it" : ""}: ${ix.failedQueries} of ${ix.queries} searches failed this week. Test it, read Prowlarr's logs, and tell me why and how to fix it.`,
              )
            }
          >
            <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask why
            <EmberMark />
          </button>
        )}
      </div>
      <ChangeCard c={c} />
    </li>
  );
}

export function ProwlarrDashboard({ serviceId, name }: { serviceId: string; name: string }) {
  const q = useDashboard(serviceId, true, 30_000);
  const all = useConfirmedChange(serviceId);
  const d: Data | undefined = q.data?.data?.app === "prowlarr" ? q.data.data : undefined;
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
        data-testid="prowlarr-error"
      >
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
      </div>
    );
  if (!d) return null;
  return (
    <section
      className="@container space-y-4"
      data-testid="prowlarr-dashboard"
      aria-label={`${name}: indexers`}
    >
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        {(
          [
            ["Indexers", `${d.totals.enabled}`, `on, of ${d.totals.indexers}`],
            ["Failing", `${d.totals.failing}`, d.totals.failing ? "need a look" : "all working"],
            ["Searches", `${d.totals.queries}`, "this week"],
            ["Grabs", `${d.totals.grabs}`, "this week"],
          ] as const
        ).map(([label, value, sub]) => (
          <div key={label} className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
            <p className="text-[0.72rem] tracking-wide text-faint uppercase">{label}</p>
            <p
              className={cx(
                "stat-value text-ink tabular",
                label === "Failing" && d.totals.failing > 0 && "text-alert",
              )}
              data-testid={label === "Failing" ? "prowlarr-failing" : undefined}
            >
              {value}
            </p>
            <p className="text-[0.74rem] text-faint">{sub}</p>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Button
            tone="outline"
            data-testid="prowlarr-test-all"
            data-hearth-target="indexers:test-all"
            onClick={() =>
              void all.propose("app-prowlarr-indexer", { op: "test-all" }, "Test all indexers")
            }
          >
            <RefreshCw className="h-4 w-4" /> Test all
          </Button>
          {d.apps.length > 0 && (
            <Button
              tone="outline"
              data-testid="prowlarr-sync"
              data-hearth-target="indexers:sync"
              onClick={() =>
                void all.propose(
                  "app-prowlarr-indexer",
                  { op: "sync-apps" },
                  "Send indexers to apps",
                )
              }
            >
              <Send className="h-4 w-4" /> Send to apps
            </Button>
          )}
        </div>
        <ChangeCard c={all} />
      </div>

      {d.health.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-amber/40 p-3 text-[0.8rem]">
          {d.health.map((h, i) => (
            <li key={i} className={h.level === "error" ? "text-alert" : "text-amber"}>
              {h.text}
            </li>
          ))}
        </ul>
      )}

      {d.indexers.length ? (
        <ul className="grid gap-3 @2xl:grid-cols-2">
          {d.indexers.map((ix) => (
            <IndexerRow key={ix.id} serviceId={serviceId} ix={ix} />
          ))}
        </ul>
      ) : (
        <p className="text-[0.86rem] text-muted">No indexers in {name} yet.</p>
      )}

      {d.apps.length > 0 && (
        <div>
          <p className="mb-1.5 text-[0.72rem] tracking-wide text-faint uppercase">
            Feeds these apps
          </p>
          <ul className="flex flex-wrap gap-2" data-testid="prowlarr-apps">
            {d.apps.map((a) => (
              <li
                key={a.name}
                className="rounded-lg border border-line px-2.5 py-1 text-[0.8rem] text-ink"
              >
                {a.name}
                <span className="text-faint">
                  {" "}
                  ·{" "}
                  {a.sync === "full"
                    ? "kept in sync"
                    : a.sync === "add only"
                      ? "adds only"
                      : "sync off"}
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
