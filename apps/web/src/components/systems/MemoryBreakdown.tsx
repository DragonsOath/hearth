import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessageCircle, RefreshCw, Zap } from "lucide-react";
import type { ActionKind, StepParams } from "@dragon-control/core";
import { api } from "../../data/api";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import { useCave } from "../shell/cave-context";
import { Button, Skeleton, cx } from "../ui";
import { EmberMark } from "../ember/EmberMark";

/**
 * Where a machine's memory goes (the owner, 2026-11-02: "what every GB is going toward", a quick
 * win, and Ember shutting down what can be shut down once you press OK). One bar for the whole
 * machine, every app, container and Hearth part by size, the quick win (the safe part, one plan),
 * and Ask Ember for the rest. Another PC's comes through the link, and its plans run there.
 */

type Kind = "app" | "container" | "hearth" | "system" | "cache" | "free";
interface Step {
  kind: ActionKind;
  serviceId: string;
  params?: StepParams;
}
interface Item {
  id: string;
  name: string;
  kind: Kind;
  mb: number;
  count?: number;
  detail?: string;
  stop?: { step: Step; label: string };
  keep?: string;
}
interface Breakdown {
  machine: string;
  os: string;
  totalMb: number;
  usedMb: number;
  cacheMb: number;
  freeMb: number;
  swap?: { totalMb: number; usedMb: number };
  items: Item[];
  quickWin: { mb: number; steps: Step[]; names: string[] };
  note: string;
}

// Categorical colors in a checked order (blue, gold, violet, teal pass the color-blind checks
// next to each other); cache and free are neutral. Each also has a labelled legend.
const GROUPS: { kind: Kind; label: string; color: string }[] = [
  { kind: "container", label: "Containers", color: "var(--color-tint-blue)" },
  { kind: "hearth", label: "Hearth", color: "var(--color-tint-gold)" },
  { kind: "app", label: "Apps", color: "var(--color-tint-violet)" },
  { kind: "system", label: "System", color: "var(--color-tint-teal)" },
  { kind: "cache", label: "Cache", color: "var(--color-line-strong)" },
  { kind: "free", label: "Free", color: "transparent" },
];

const withParams = (s: Step) => ({ ...s, params: s.params ?? {} });

export const gb = (mb: number) =>
  mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(0, Math.round(mb))} MB`;

export function MemoryBreakdown({ name, pcId }: { name: string; pcId?: string }) {
  const [all, setAll] = useState(false);
  const cave = useCave();
  const path = pcId ? `/api/on/${encodeURIComponent(pcId)}/machine/memory` : "/api/machine/memory";
  const q = useQuery({
    queryKey: ["dashboard", "machine-memory", pcId ?? ""],
    queryFn: () => api<Breakdown>("GET", path),
    refetchInterval: 20_000,
  });
  const act = useApproveHere("this-host", "From Systems, Memory.", pcId);
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.error || !q.data)
    return (
      <p className="text-[0.84rem] text-amber">
        Could not read where {name}&apos;s memory goes
        {q.error instanceof Error ? `: ${q.error.message}` : "."}
      </p>
    );
  const b = q.data;
  const sums = GROUPS.map((g) => ({
    ...g,
    mb: b.items.filter((i) => i.kind === g.kind).reduce((n, i) => n + i.mb, 0),
  })).filter((g) => g.mb > 0);
  const total = Math.max(b.totalMb, 1);
  const rows = b.items.filter((i) => i.kind !== "free" && i.kind !== "cache");
  const shown = all ? rows : rows.slice(0, 12);
  const swapTight = b.swap && b.swap.totalMb > 0 && b.swap.usedMb / b.swap.totalMb >= 0.8;
  const ask = () =>
    cave.ask(
      `${name}'s memory: ${gb(b.usedMb)} of ${gb(b.totalMb)} used${swapTight ? ", swap nearly full" : ""}. Look at where it goes (Systems, Memory) and tell me what I can safely shut down to free memory, then propose it as one plan I can approve.`,
    );
  return (
    <section aria-label={`${name} memory`} className="space-y-4" data-testid="memory-breakdown">
      <ApproveDialog c={act} />
      <div>
        <div
          className="flex h-4 w-full gap-[2px] overflow-hidden rounded-full bg-raised ring-1 ring-line"
          role="img"
          aria-label={sums.map((s) => `${s.label} ${gb(s.mb)}`).join(", ")}
        >
          {sums.map((s) => (
            <span
              key={s.kind}
              title={`${s.label}: ${gb(s.mb)}`}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{ width: `${(s.mb / total) * 100}%`, background: s.color }}
            />
          ))}
        </div>
        <ul
          className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.78rem]"
          data-testid="memory-legend"
        >
          {sums.map((s) => (
            <li key={s.kind} className="flex items-center gap-1.5 text-muted">
              <span
                aria-hidden
                className="h-2.5 w-2.5 rounded-sm ring-1 ring-line"
                style={{ background: s.color }}
              />
              {s.label} <span className="text-ink tabular">{gb(s.mb)}</span>
            </li>
          ))}
        </ul>
        {swapTight && (
          <p className="mt-2 text-[0.8rem] text-amber" data-testid="memory-swap">
            Swap is {gb(b.swap!.usedMb)} of {gb(b.swap!.totalMb)} used: {name} is short on memory
            and slows down while it moves things to disk.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gold/35 bg-gold/5 p-3">
        <Zap strokeWidth={1.5} className="h-4 w-4 shrink-0 text-gold" aria-hidden />
        <p className="min-w-0 flex-1 text-[0.84rem] text-ink" data-testid="memory-quick-win">
          {b.quickWin.steps.length ? (
            <>
              Quick win: free about <strong>{gb(b.quickWin.mb)}</strong> by stopping{" "}
              {b.quickWin.names.join(", ")}.
            </>
          ) : (
            "No quick win right now: nothing is safe to stop without a closer look."
          )}
        </p>
        {b.quickWin.steps.length > 0 && (
          <Button
            tone="primary"
            disabled={act.busy}
            data-hearth-target="memory:quick-win"
            onClick={() =>
              void act.proposeMany(
                b.quickWin.steps.map(withParams),
                `Free about ${gb(b.quickWin.mb)} on ${name}`,
              )
            }
          >
            Free {gb(b.quickWin.mb)}
          </Button>
        )}
        <button
          type="button"
          onClick={ask}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.78rem] text-gold hover:bg-gold/10"
          data-hearth-target="memory:ask"
        >
          <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" />
          Ask Ember what else can go
          <EmberMark />
        </button>
      </div>
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}

      <div>
        <div className="mb-1 flex items-center gap-2">
          <p className="eyebrow mr-auto">What&apos;s using it</p>
          <button
            type="button"
            className="inline-flex min-h-8 items-center gap-1 text-[0.76rem] text-muted hover:text-gold"
            onClick={() => void q.refetch()}
            disabled={q.isFetching}
          >
            <RefreshCw
              strokeWidth={1.5}
              className={cx("h-3.5 w-3.5", q.isFetching && "animate-spin")}
            />
            Refresh
          </button>
        </div>
        <ul className="divide-y divide-line" data-testid="memory-items">
          {shown.map((i) => {
            const g = GROUPS.find((x) => x.kind === i.kind)!;
            return (
              <li
                key={i.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[0.84rem]"
                data-testid="memory-item"
                data-item={i.id}
              >
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ background: g.color }}
                />
                <span className="min-w-0 flex-1">
                  <span className="text-ink">{i.name}</span>
                  {i.count ? <span className="text-faint"> · {i.count} processes</span> : null}
                  <span className="block truncate text-[0.74rem] text-faint">
                    {[g.label.replace(/s$/, ""), i.detail, i.keep && `Stays: ${i.keep}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="w-16 shrink-0 text-right text-ink tabular">{gb(i.mb)}</span>
                <span className="w-24 shrink-0 text-right">
                  {i.stop && (
                    <button
                      type="button"
                      className="inline-flex min-h-8 items-center rounded-lg border border-line-strong px-2 text-[0.76rem] text-muted hover:border-gold/50 hover:text-ink disabled:opacity-50"
                      disabled={act.busy}
                      data-hearth-target={`memory:stop:${i.id}`}
                      onClick={() =>
                        void act.proposeMany(
                          [withParams(i.stop!.step)],
                          `${i.stop!.label} on ${name}`,
                        )
                      }
                    >
                      {i.kind === "container" ? "Stop" : i.kind === "hearth" ? "Free" : "Close"}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        {rows.length > 12 && (
          <button
            type="button"
            className="mt-1 min-h-9 text-[0.8rem] text-gold hover:underline"
            onClick={() => setAll(!all)}
          >
            {all ? "Show fewer" : `Show all ${rows.length}`}
          </button>
        )}
        <p className="mt-2 text-[0.74rem] text-faint">
          {b.cacheMb > 0 &&
            `Cache (${gb(b.cacheMb)}) is recently used files; the system hands it back by itself. `}
          {b.note}
        </p>
      </div>
    </section>
  );
}
