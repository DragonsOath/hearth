import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clapperboard,
  Play,
  Power,
  RefreshCw,
  Workflow,
  Zap,
} from "lucide-react";
import type { HomeAssistantDashboard as Data } from "@dragon-control/core";
import { api } from "../../data/api";
import { ago } from "../../lib/format";
import { cx } from "../ui";
import { ChangeCard, useConfirmedChange } from "./ConfirmedChange";

/**
 * Routines and automations, in the Home Assistant panel (10-26): see them by their real
 * names, run them, switch automations on or off, and read what each one does, without opening
 * Home Assistant.
 *
 * Words, for someone who does not know Home Assistant: a routine (a Home Assistant script) runs
 * only when started; an automation runs by itself when its triggers happen and can be switched
 * off; a scene puts devices back the way it saved them.
 *
 * Pressing Run is the owner's OK for routines that only touch lights, plugs, and the TV: Hearth
 * plans it and confirms it in one go. Anything else (doors, alarms, garage doors, web requests,
 * or steps Hearth could not read) shows the plan's warning and waits for Confirm.
 */

type Kind = "routine" | "automation" | "scene";
interface Item {
  entityId: string;
  name: string;
  kind: Kind;
  lastRan?: string;
  on?: boolean;
  running?: boolean;
  unavailable?: boolean;
}

interface Detail {
  name?: string;
  description?: string;
  triggers?: string[];
  conditions?: string[];
  steps?: string[];
  careful?: string[];
  needsInput?: string[];
  runs?: { at: string; result: string; ok: boolean; error?: string }[];
  note?: string;
}

const KIND_WORDS: Record<Kind, { label: string; icon: typeof Play; hint: string }> = {
  routine: {
    label: "Routine",
    icon: Workflow,
    hint: "Runs only when you start it (a Home Assistant script).",
  },
  automation: {
    label: "Automation",
    icon: Zap,
    hint: "Runs by itself when its triggers happen. Switch it off to stop that.",
  },
  scene: {
    label: "Scene",
    icon: Clapperboard,
    hint: "Puts its devices back the way the scene saved them.",
  },
};

const FILTERS = [
  ["all", "All"],
  ["routine", "Routines"],
  ["automation", "Automations"],
  ["scene", "Scenes"],
  ["off", "Switched off"],
  ["problem", "Problems"],
] as const;
type Filter = (typeof FILTERS)[number][0];

const btn =
  "inline-flex min-h-10 items-center gap-1.5 rounded-lg border px-3 text-[0.8rem] transition-colors disabled:opacity-40";

function useDetail(serviceId: string, entityId: string, open: boolean) {
  return useQuery({
    queryKey: ["ha-routine", serviceId, entityId],
    queryFn: () =>
      api<Detail>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/dashboard/ha-routine?entityId=${encodeURIComponent(entityId)}`,
      ),
    enabled: open,
    staleTime: 10_000,
  });
}

function Lines({ title, items, tone }: { title: string; items?: string[]; tone?: string }) {
  if (!items?.length) return null;
  return (
    <div>
      <p className="text-[0.7rem] tracking-wide text-faint uppercase">{title}</p>
      <ul className={cx("mt-0.5 space-y-0.5 text-[0.82rem]", tone ?? "text-ink")}>
        {items.map((t, i) => (
          <li key={i} className="break-words">
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Details({ serviceId, item }: { serviceId: string; item: Item }) {
  const q = useDetail(serviceId, item.entityId, true);
  if (q.isLoading)
    return <p className="text-[0.8rem] text-faint">Reading it from Home Assistant…</p>;
  if (q.error)
    return <p className="text-[0.8rem] text-amber">Could not read it: {q.error.message}</p>;
  const d = q.data ?? {};
  return (
    <div className="space-y-2 rounded-lg border border-line bg-bg/40 p-3" data-testid="ha-detail">
      {d.description && <p className="text-[0.82rem] text-muted">{d.description}</p>}
      {item.kind === "automation" && (
        <Lines title="Starts when" items={d.triggers?.length ? d.triggers : ["Only by hand"]} />
      )}
      <Lines title="Checks first" items={d.conditions} />
      <Lines title={item.kind === "scene" ? "What it does" : "Steps"} items={d.steps} />
      {d.careful && d.careful.length > 0 && (
        <Lines
          title="Look before running"
          items={d.careful.map((c) => `It ${c}.`)}
          tone="text-amber"
        />
      )}
      {d.needsInput && d.needsInput.length > 0 && (
        <p className="text-[0.8rem] text-muted">
          It needs {d.needsInput.join(", ")} each time it runs, so a voice assistant starts it, not
          a button.
        </p>
      )}
      {d.runs && (
        <div>
          <p className="text-[0.7rem] tracking-wide text-faint uppercase">Last runs</p>
          {d.runs.length ? (
            <ul className="mt-0.5 space-y-0.5 text-[0.8rem]" data-testid="ha-runs">
              {d.runs.map((r, i) => (
                <li key={i} className={r.ok ? "text-muted" : "text-alert"}>
                  {ago(r.at)} · {r.result}
                  {r.error ? `: ${r.error}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[0.8rem] text-faint">No runs Home Assistant still remembers.</p>
          )}
        </div>
      )}
      {d.note && <p className="text-[0.76rem] text-faint">{d.note}</p>}
    </div>
  );
}

function RoutineRow({ serviceId, item }: { serviceId: string; item: Item }) {
  const run = useConfirmedChange(serviceId);
  const sw = useConfirmedChange(serviceId);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const words = KIND_WORDS[item.kind];
  const Icon = words.icon;

  // The press is the owner's OK, for everyday routines only (the plan marks the others).
  const confirmed = useRef<string | undefined>(undefined);
  useEffect(() => {
    for (const c of [run, sw]) {
      const j = c.job;
      if (!j || j.status !== "awaiting-approval" || confirmed.current === j.id) continue;
      if (j.steps[0]?.params?.careful) continue;
      confirmed.current = j.id;
      void c.confirm();
    }
  }, [run, sw]);
  useEffect(() => {
    if (run.job?.status === "succeeded")
      void qc.invalidateQueries({ queryKey: ["ha-routine", serviceId, item.entityId] });
  }, [run.job?.status, qc, serviceId, item.entityId]);

  const runOp =
    item.kind === "routine" ? "run-script" : item.kind === "scene" ? "run-scene" : "run-automation";
  const runLabel = item.kind === "scene" ? "Activate" : "Run now";
  const busy = (c: typeof run) =>
    !c.error &&
    !c.approveError &&
    (c.busy || (c.job?.status === "awaiting-approval" && !c.job.steps[0]?.params?.careful));
  const done = (c: typeof run) =>
    c.job?.status === "succeeded" ? (c.job.steps[0]?.result ?? c.job.summary) : undefined;
  const waits = (c: typeof run) =>
    Boolean(
      c.error ||
      c.approveError ||
      ["failed", "refused", "partial"].includes(c.job?.status ?? "") ||
      (c.job?.status === "awaiting-approval" && c.job.steps[0]?.params?.careful),
    );

  const status = item.unavailable
    ? { text: "Unavailable", cls: "border-alert/50 text-alert" }
    : item.running
      ? { text: "Running", cls: "border-gold/50 text-gold" }
      : item.kind === "automation"
        ? item.on
          ? { text: "Runs by itself", cls: "border-live/40 text-live" }
          : { text: "Switched off", cls: "border-line-strong text-faint" }
        : undefined;

  return (
    <li
      className="space-y-2 py-3"
      data-testid="ha-routine"
      data-kind={item.kind}
      data-capture-item
      data-capture-label={item.name}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <Icon strokeWidth={1.5} className="h-4 w-4 shrink-0 text-gold" aria-hidden />
        <span className="min-w-0 flex-1 text-[0.92rem] break-words text-ink">{item.name}</span>
        <span
          className="fit-pill rounded-full border border-line-strong px-2 py-0.5 text-[0.7rem] text-muted"
          title={words.hint}
        >
          {words.label}
        </span>
        {status && (
          <span
            className={cx("fit-pill rounded-full border px-2 py-0.5 text-[0.7rem]", status.cls)}
            data-testid="ha-routine-status"
          >
            {status.text}
          </span>
        )}
      </div>
      <p className="text-[0.76rem] text-faint">
        {item.lastRan ? `Last ran ${ago(item.lastRan)}` : "Has not run yet"}
        {item.kind === "automation" ? "" : ` · ${words.hint}`}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={item.unavailable || busy(run)}
          className={cx(btn, "border-gold/50 text-gold hover:bg-gold/10")}
          data-testid="ha-run"
          title={
            item.kind === "automation"
              ? "Runs its steps now, without waiting for its triggers and skipping its checks"
              : undefined
          }
          onClick={() =>
            void run.propose(
              "app-homeassistant-control",
              { op: runOp, entityId: item.entityId },
              `${runLabel}: ${item.name}`,
            )
          }
        >
          <Play strokeWidth={1.75} className={cx("h-4 w-4", busy(run) && "animate-pulse")} />
          {busy(run) ? "Starting…" : runLabel}
        </button>
        {item.kind === "automation" && !item.unavailable && (
          <button
            type="button"
            disabled={busy(sw)}
            className={cx(
              btn,
              "border-line-strong text-muted hover:border-gold/60 hover:text-gold",
            )}
            data-testid={item.on ? "ha-switch-off" : "ha-switch-on"}
            onClick={() =>
              void sw.propose(
                "app-homeassistant-control",
                { op: item.on ? "automation-off" : "automation-on", entityId: item.entityId },
                `${item.on ? "Switch off" : "Switch on"}: ${item.name}`,
              )
            }
          >
            <Power strokeWidth={1.75} className="h-4 w-4" />
            {item.on ? "Switch off" : "Switch on"}
          </button>
        )}
        <button
          type="button"
          aria-expanded={open}
          className={cx(btn, "border-line text-muted hover:text-ink")}
          data-testid="ha-details"
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDown
            strokeWidth={1.75}
            className={cx("h-4 w-4 transition-transform", open && "rotate-180")}
          />
          Details
        </button>
      </div>
      {item.kind === "automation" && (
        <p className="text-[0.72rem] text-faint">
          Run now runs its steps straight away, without waiting for its triggers and skipping its
          checks.
        </p>
      )}
      {[run, sw].map((c, i) =>
        done(c) ? (
          <p
            key={i}
            role="status"
            className="flex items-start gap-1.5 text-[0.82rem] text-live"
            data-testid="ha-run-done"
          >
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">{done(c)}</span>
          </p>
        ) : waits(c) ? (
          <div key={i}>
            {c.job?.steps[0]?.params?.careful ? (
              <p className="mb-1.5 flex items-start gap-1.5 text-[0.8rem] text-amber">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>This one is not just lights and the TV, so it waits for your OK.</span>
              </p>
            ) : null}
            <ChangeCard c={c} />
          </div>
        ) : null,
      )}
      {open && <Details serviceId={serviceId} item={item} />}
    </li>
  );
}

export function HaRoutines({
  serviceId,
  d,
  refreshing,
}: {
  serviceId: string;
  d: Data;
  refreshing: boolean;
}) {
  const qc = useQueryClient();
  const [find, setFind] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const items: Item[] = [
    ...d.scripts.map((s) => ({ ...s, kind: "routine" as const })),
    ...d.automations.map((a) => ({ ...a, kind: "automation" as const })),
    ...d.scenes.map((s) => ({ ...s, kind: "scene" as const })),
  ];
  const f = find.trim().toLowerCase();
  const shown = items.filter(
    (i) =>
      (!f || i.name.toLowerCase().includes(f) || i.entityId.includes(f)) &&
      (filter === "all" ||
        i.kind === filter ||
        (filter === "off" && i.kind === "automation" && !i.on) ||
        (filter === "problem" && i.unavailable)),
  );
  const count = (k: Filter) =>
    k === "all"
      ? items.length
      : k === "off"
        ? items.filter((i) => i.kind === "automation" && !i.on).length
        : k === "problem"
          ? items.filter((i) => i.unavailable).length
          : items.filter((i) => i.kind === k).length;
  return (
    <div className="space-y-3" data-testid="ha-routines">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex-1 text-[0.8rem] tracking-wide text-faint uppercase">
          Routines and automations
        </h3>
        <button
          type="button"
          className={cx(btn, "border-line-strong text-muted hover:border-gold/60 hover:text-gold")}
          data-testid="ha-refresh"
          onClick={() => {
            void qc.invalidateQueries({ queryKey: ["dashboard", serviceId] });
            void qc.invalidateQueries({ queryKey: ["ha-routine", serviceId] });
          }}
        >
          <RefreshCw strokeWidth={1.75} className={cx("h-4 w-4", refreshing && "animate-spin")} />
          Refresh
        </button>
      </div>
      <input
        value={find}
        onChange={(e) => setFind(e.target.value)}
        aria-label="Find a routine, automation, or scene"
        placeholder="Find a routine, automation, or scene"
        className="min-h-10 w-full rounded-lg border border-line bg-raised px-3 text-[0.86rem] text-ink"
        data-testid="ha-routine-find"
      />
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
        {FILTERS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            aria-pressed={filter === k}
            onClick={() => setFilter(k)}
            className={cx(
              "min-h-9 rounded-full border px-3 text-[0.78rem]",
              filter === k
                ? "border-gold/60 bg-gold/10 text-gold"
                : "border-line text-muted hover:text-ink",
            )}
          >
            {label} · {count(k)}
          </button>
        ))}
      </div>
      {items.length === 0 ? (
        <p className="text-[0.86rem] text-muted">
          Home Assistant has no routines, automations, or scenes yet.
        </p>
      ) : shown.length === 0 ? (
        <p className="text-[0.86rem] text-muted">Nothing matches.</p>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((i) => (
            <RoutineRow key={i.entityId} serviceId={serviceId} item={i} />
          ))}
        </ul>
      )}
    </div>
  );
}
