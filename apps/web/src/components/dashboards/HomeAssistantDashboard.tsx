import { useState } from "react";
import { MessageCircle, Play, Power, RotateCcw } from "lucide-react";
import type { HomeAssistantDashboard as Data } from "@dragon-control/core";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { useCave } from "../shell/cave-context";
import { Skeleton, cx } from "../ui";
import { ChangeCard, useConfirmedChange } from "./ConfirmedChange";
import { HaRoutines } from "./HaRoutines";
import { EmberMark } from "../ember/EmberMark";

/**
 * Home Assistant from Hearth: routines, automations, and scenes (HaRoutines: run them, switch
 * automations, read what each does and its last runs), lights and switches, what is unavailable,
 * and integrations that failed to load. Toggling a light or switch and reloading a failing
 * integration are plans confirmed here. Locks, alarms, and covers are never switched directly.
 */

type Op =
  | "automation-on"
  | "automation-off"
  | "run-automation"
  | "run-script"
  | "run-scene"
  | "toggle"
  | "reload-integration";

const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.76rem] text-muted hover:border-gold/60 hover:text-gold";
const SHOWN = 30;

function Row({
  serviceId,
  name,
  testId,
  detail,
  state,
  actions,
}: {
  serviceId: string;
  name: string;
  testId: string;
  detail?: string;
  state?: { on: boolean; label: string };
  actions: { op: Op; label: string; params: Record<string, string>; icon: React.ReactNode }[];
}) {
  const c = useConfirmedChange(serviceId);
  return (
    <li
      className="space-y-1.5 py-2.5"
      data-testid={testId}
      data-capture-item
      data-capture-label={name}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[0.88rem] break-words text-ink">{name}</span>
        {state && (
          <span
            className={cx(
              "fit-pill rounded-full border px-2 py-0.5 text-[0.7rem]",
              state.on ? "border-live/40 text-live" : "border-line-strong text-faint",
            )}
            data-testid="ha-state"
          >
            {state.label}
          </span>
        )}
        {actions.map((a) => (
          <button
            key={a.op}
            type="button"
            className={btn}
            data-testid={`ha-${a.op}`}
            onClick={() =>
              void c.propose(
                "app-homeassistant-control",
                { op: a.op, ...a.params },
                `${a.label} ${name}`,
              )
            }
          >
            {a.icon} {a.label}
          </button>
        ))}
      </div>
      {detail && <p className="text-[0.76rem] text-faint">{detail}</p>}
      <ChangeCard c={c} />
    </li>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1 text-[0.72rem] tracking-wide text-faint uppercase">
        {title} · {count}
        {count > SHOWN ? ` (first ${SHOWN}; search to find others)` : ""}
      </p>
      <ul className="divide-y divide-line">{children}</ul>
    </div>
  );
}

export function HomeAssistantDashboard({ serviceId, name }: { serviceId: string; name: string }) {
  const q = useDashboard(serviceId, true, 15_000);
  const cave = useCave();
  const [find, setFind] = useState("");
  const d: Data | undefined = q.data?.data?.app === "homeassistant" ? q.data.data : undefined;
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="ha-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
      </div>
    );
  if (!d) return null;
  const f = find.trim().toLowerCase();
  const match = <T extends { name: string; entityId: string }>(xs: T[]) =>
    (f ? xs.filter((x) => x.name.toLowerCase().includes(f) || x.entityId.includes(f)) : xs).slice(
      0,
      SHOWN,
    );
  const icon = (I: typeof Play) => <I strokeWidth={1.5} className="h-3.5 w-3.5" />;
  return (
    <section
      className="@container space-y-4"
      data-testid="ha-dashboard"
      aria-label={`${name}: the home`}
    >
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        {(
          [
            ["Status", d.running ? "Running" : "Starting", d.version ?? ""],
            ["Automations", `${d.totals.automationsOn}`, `on, of ${d.totals.automations}`],
            ["Unavailable", `${d.totals.unavailable}`, `of ${d.totals.entities} entities`],
            [
              "Integrations",
              d.totals.integrationsFailing === undefined ? "?" : `${d.totals.integrationsFailing}`,
              d.totals.integrationsFailing === undefined ? "needs an admin token" : "failing",
            ],
          ] as const
        ).map(([label, value, sub]) => (
          <div key={label} className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
            <p className="text-[0.72rem] tracking-wide text-faint uppercase">{label}</p>
            <p
              className={cx(
                "stat-value text-ink tabular",
                label === "Integrations" && (d.totals.integrationsFailing ?? 0) > 0 && "text-alert",
                label === "Unavailable" && d.totals.unavailable > 0 && "text-amber",
              )}
              data-testid={
                label === "Integrations"
                  ? "ha-failing"
                  : label === "Automations"
                    ? "ha-auto-on"
                    : undefined
              }
            >
              {value}
            </p>
            <p className="text-[0.74rem] text-faint">{sub}</p>
          </div>
        ))}
      </div>

      {d.integrations.length > 0 && (
        <Section title="Integrations not working" count={d.integrations.length}>
          {d.integrations.map((i) => (
            <Row
              key={i.entryId}
              serviceId={serviceId}
              name={`${i.name} (${i.domain})`}
              testId="ha-integration"
              detail={i.problem}
              actions={[
                {
                  op: "reload-integration",
                  label: "Reload",
                  params: { entryId: i.entryId },
                  icon: icon(RotateCcw),
                },
              ]}
            />
          ))}
        </Section>
      )}

      <HaRoutines serviceId={serviceId} d={d} refreshing={q.isFetching} />

      <input
        value={find}
        onChange={(e) => setFind(e.target.value)}
        aria-label="Find a light or switch"
        placeholder="Find a light or switch"
        className="min-h-10 w-full rounded-lg border border-line bg-raised px-3 text-[0.86rem] text-ink"
      />
      <Section title="Lights and switches" count={d.switches.length}>
        {match(d.switches).map((s) => (
          <Row
            key={s.entityId}
            serviceId={serviceId}
            name={s.name}
            testId="ha-switch"
            state={{ on: s.on, label: s.on ? "On" : "Off" }}
            detail={s.kind.replace("_", " ")}
            actions={[
              {
                op: "toggle",
                label: s.on ? "Turn off" : "Turn on",
                params: { entityId: s.entityId },
                icon: icon(Power),
              },
            ]}
          />
        ))}
      </Section>

      {d.unavailable.length > 0 && (
        <div>
          <p className="mb-1.5 text-[0.72rem] tracking-wide text-faint uppercase">
            Unavailable · {d.totals.unavailable}
          </p>
          <ul className="flex flex-wrap gap-2" data-testid="ha-unavailable">
            {d.unavailable.map((u) => (
              <li
                key={u.entityId}
                className="rounded-lg border border-amber/40 px-2.5 py-1 text-[0.8rem] text-amber"
              >
                {u.name}
                {u.since ? <span className="text-faint"> · {ago(u.since)}</span> : null}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
            onClick={() =>
              cave.ask(
                `In Home Assistant, ${d.totals.unavailable} entities are unavailable, including ${d.unavailable
                  .slice(0, 8)
                  .map((u) => u.name)
                  .join(
                    ", ",
                  )}. Which devices or integrations do they belong to, and why are they down?`,
              )
            }
          >
            <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask why they are down
            <EmberMark />
          </button>
        </div>
      )}

      {d.note && <p className="text-[0.78rem] text-muted">{d.note}</p>}
      <p className="text-[0.74rem] text-faint">
        {q.data?.sample ? "Sample data · " : ""}
        {d.version ? `${name} ${d.version} · ` : ""}live, every 15 s
      </p>
    </section>
  );
}
