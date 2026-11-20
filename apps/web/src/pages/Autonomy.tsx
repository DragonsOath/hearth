import { Lock } from "lucide-react";
import { WithWorkspace } from "../components/WithWorkspace";
import { PageHeader, Panel, SaveNote, Section, Switch, cx } from "../components/ui";
import { useSaveAutonomy, useUpdateSettings } from "../data/api";
import type { Autonomy, AutonomyRule, Workspace } from "@dragon-control/core";
import { MonitoringTabs } from "../components/shell/MonitoringTabs";

export const autonomyLabels: Record<Autonomy, { title: string; description: string }> = {
  monitor: {
    title: "Monitor",
    description: "Watch and tell you. Nothing is investigated or changed.",
  },
  diagnose: {
    title: "Diagnose",
    description: "Investigate and explain the problem, without changing anything.",
  },
  ask: {
    title: "Ask before fixing",
    description: "Prepare a repair and wait for your approval.",
  },
  auto: {
    title: "Fix automatically",
    description: "Carry out routine repairs, verify them, then tell you what was done.",
  },
};

const levels: Autonomy[] = ["monitor", "diagnose", "ask", "auto"];

function LevelPicker({ value, onChange }: { value: Autonomy; onChange: (v: Autonomy) => void }) {
  return (
    <div role="radiogroup" aria-label="Default autonomy" className="grid gap-3 sm:grid-cols-2">
      {levels.map((level, i) => {
        const active = level === value;
        return (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(level)}
            className={cx(
              "rounded-xl border p-5 text-left transition-colors duration-200 sm:p-6",
              active
                ? "border-gold/60 bg-gold/[0.06]"
                : "border-line bg-panel hover:border-line-strong",
            )}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span
                className={cx("font-display text-[1.45rem]", active ? "text-gold" : "text-ink")}
              >
                {autonomyLabels[level].title}
              </span>
              <span className="text-[0.72rem] text-faint tabular">{`0${i + 1}`}</span>
            </div>
            <p className="mt-2 text-[0.85rem] leading-relaxed text-muted">
              {autonomyLabels[level].description}
            </p>
          </button>
        );
      })}
    </div>
  );
}

function RuleRow({
  rule,
  fallback,
  onChange,
}: {
  rule: AutonomyRule;
  fallback: Autonomy;
  onChange: (level: AutonomyRule["level"]) => void;
}) {
  const id = `rule-${rule.id}`;
  return (
    <li className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <label htmlFor={id} className="text-[0.95rem] text-ink">
          {rule.label}
        </label>
        <p className="text-[0.8rem] text-faint">{rule.description}</p>
      </div>
      <select
        id={id}
        value={rule.level}
        onChange={(e) => onChange(e.target.value as AutonomyRule["level"])}
        className="min-h-11 rounded-lg border border-line bg-panel px-3 text-[0.85rem] text-ink focus:border-gold/60 focus:outline-none sm:w-64"
      >
        <option value="default">Default ({autonomyLabels[fallback].title})</option>
        {levels.map((l) => (
          <option key={l} value={l}>
            {autonomyLabels[l].title}
          </option>
        ))}
      </select>
    </li>
  );
}

/** The one switch between "Fix automatically" in principle and in practice on your own systems. */
function LiveRepairs({ ws }: { ws: Workspace }) {
  const update = useUpdateSettings();
  const on =
    update.status === "pending" || update.status === "success"
      ? (update.variables?.liveRepairs ?? ws.liveRepairs)
      : ws.liveRepairs;
  return (
    <Section title="Your own systems">
      <Panel className="p-6 sm:p-8">
        <div className="flex items-start justify-between gap-6">
          <div className="max-w-lg">
            <p className="text-[0.95rem] text-ink">Automatic repairs on your systems</p>
            <p className="mt-2 text-[0.85rem] leading-relaxed text-muted">
              {on
                ? "On. Areas set to Fix automatically are repaired without asking, then verified, and you are told what was done."
                : "Off. On your own systems, repairs that Fix automatically would make wait for your approval instead. Turn this on once you have watched a few repairs and trust them."}
            </p>
            <p className="mt-3 text-[0.78rem] leading-relaxed text-faint">
              Sample data, and containers you label{" "}
              <code className="text-muted">dragon-control.sandbox=true</code> for testing, can
              always be repaired automatically.
            </p>
          </div>
          <Switch
            checked={on}
            label="Automatic repairs on your systems"
            onChange={(next) => update.mutate({ liveRepairs: next })}
          />
        </div>
        <div className="mt-3">
          <SaveNote status={update.status} error={update.error} />
        </div>
      </Panel>
    </Section>
  );
}

function AutonomyContent({ ws }: { ws: Workspace }) {
  const save = useSaveAutonomy();
  // What you last submitted wins until it fails; otherwise show what the server has.
  const submitted =
    save.status === "pending" || save.status === "success" ? save.variables : undefined;
  const level: Autonomy = submitted?.default ?? ws.autonomyDefault;
  const rules: AutonomyRule[] = ws.autonomyRules.map((r) => ({
    ...r,
    level: submitted?.rules.find((x) => x.id === r.id)?.level ?? r.level,
  }));

  const commit = (nextLevel: Autonomy, nextRules: AutonomyRule[]) =>
    save.mutate({
      default: nextLevel,
      rules: nextRules.map(({ id, level: l }) => ({ id, level: l })),
    });

  return (
    <>
      <MonitoringTabs />
      <PageHeader
        eyebrow="Monitoring"
        title="How much to handle"
        subtitle="Decide how far Hearth and your agent may go before asking you. Every decision is enforced by Hearth, never by the agent."
      />

      <Section title="Default">
        <LevelPicker value={level} onChange={(next) => commit(next, rules)} />
        <div className="mt-3">
          <SaveNote status={save.status} error={save.error} />
        </div>
      </Section>

      <Section title="By area">
        <ul className="divide-y divide-line">
          {rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              fallback={level}
              onChange={(next) =>
                commit(
                  level,
                  rules.map((r) => (r.id === rule.id ? { ...r, level: next } : r)),
                )
              }
            />
          ))}
        </ul>
      </Section>

      <LiveRepairs ws={ws} />

      <Section title="Always asks you">
        <Panel className="p-6 sm:p-8">
          <p className="mb-5 max-w-lg text-[0.88rem] leading-relaxed text-muted">
            Some actions are too consequential to automate, whatever the settings above say.
          </p>
          <ul className="grid gap-3 sm:grid-cols-2">
            {ws.guardrails.map((g) => (
              <li key={g} className="flex items-center gap-3 text-[0.9rem] text-ink">
                <Lock strokeWidth={1.25} className="h-4 w-4 shrink-0 text-gold" />
                {g}
              </li>
            ))}
          </ul>
        </Panel>
      </Section>
    </>
  );
}

export function AutonomyPage() {
  return <WithWorkspace>{(ws) => <AutonomyContent ws={ws} />}</WithWorkspace>;
}
