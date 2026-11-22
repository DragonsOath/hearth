import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import {
  BUILD_QUESTIONS,
  comparePlans,
  includeAnywayEffects,
  leaveOutEffects,
  planGroups,
  recommendBuild,
  type BuildAnswers,
  type BuildApp,
  type BuildCapability,
  type BuildChoice,
  type BuildPlan,
  type BuildRequirement,
  type GoalChoice,
  type GoalDecisions,
  type IncludeEffect,
  type BuildWant,
  type HostScan,
  type LeaveOutEffect,
} from "@dragon-control/core";
import { useAiName } from "../data/api";
import { usePlan, useSavePlan, useScanComputer, useStartOver } from "../data/plan";
import { Button, LinkButton, PageHeader, PageSkeleton, Tag, cx } from "../components/ui";
import { FormError } from "./auth/AuthFrame";
import { YourHomelab } from "../components/plan/YourHomelab";

/**
 * "Help me build my first homelab": a few human questions, a look at this computer (only after
 * the owner says yes), and a starter plan with the options explained. Answers save as they go,
 * so it can be left and picked up again. Plans only: nothing is installed from here
 * (docs/design/BEGINNER_JOURNEY.md, stage 1).
 */

type Key = keyof typeof BUILD_QUESTIONS;

const watches = (a: BuildAnswers) =>
  !a.wants.length || a.wants.some((w) => w === "watch" || w === "request" || w === "explore");

const SCREENS: { title: string; lead: string; keys: Key[] }[] = [
  {
    title: "What would you love to do?",
    lead: "No server knowledge needed. Tell me what sounds fun, and I'll work out the rest.",
    keys: ["wants"],
  },
  {
    title: "A little about you",
    lead: "So I explain things at the right pace.",
    keys: ["experience", "budget", "pace"],
  },
  {
    title: "What you already have",
    lead: "Anything you have stays exactly where it is. Nothing is moved or deleted.",
    keys: [
      "media",
      "existingServer",
      "plexPass",
      "plexServer",
      "existingVpn",
      "downloadSites",
      "importance",
      "dedicated",
    ],
  },
  {
    title: "How you'll enjoy it",
    lead: "Where and how you'll use it.",
    keys: ["devices", "streams", "quality", "away"],
  },
];
const LOOK_STEP = SCREENS.length + 1;
const PLAN_STEP = SCREENS.length + 2;
const HOMELAB_STEP = SCREENS.length + 3;

/** Whether a question makes sense for the answers so far. */
function shown(k: Key, a: BuildAnswers): boolean {
  if (k === "existingServer") return a.media !== undefined && a.media !== "none";
  if (k === "plexPass" || k === "plexServer") return a.existingServer === "plex";
  if (k === "downloadSites")
    return !a.wants.length || a.wants.some((w) => w === "request" || w === "explore");
  if (k === "importance")
    return (
      a.wants.includes("photos") ||
      a.wants.includes("files") ||
      (a.media !== undefined && a.media !== "none")
    );
  if (k === "devices" || k === "streams" || k === "quality" || k === "existingVpn")
    return watches(a);
  return true;
}

const GB = 1024 ** 3;
const size = (bytes: number) =>
  bytes >= 1000 * GB ? `${(bytes / 1024 ** 4).toFixed(1)} TB` : `${Math.round(bytes / GB)} GB`;

function Question({
  k,
  answers,
  set,
}: {
  k: Key;
  answers: BuildAnswers;
  set: (a: BuildAnswers) => void;
}) {
  const q = BUILD_QUESTIONS[k];
  const multi = k === "wants" || k === "devices";
  const current = answers[k] as string | string[] | undefined;
  const on = (v: string) => (multi ? ((current as string[]) ?? []).includes(v) : current === v);
  const pick = (v: string) => {
    if (!multi) return set({ ...answers, [k]: v });
    const list = (current as string[]) ?? [];
    // "Not sure" stands alone: choosing it clears the others, and choosing another clears it.
    const lone = k === "wants" ? "explore" : "unsure";
    const next =
      v === lone
        ? list.includes(lone)
          ? []
          : [lone]
        : list.includes(v)
          ? list.filter((x) => x !== v)
          : [...list.filter((x) => x !== lone), v];
    set({ ...answers, [k]: next });
  };
  return (
    <fieldset className="mb-8" data-testid={`plan-q-${k}`}>
      <legend className="mb-1 text-[1rem] text-ink">{q.question}</legend>
      {"help" in q && <p className="mb-2 text-[0.82rem] leading-relaxed text-faint">{q.help}</p>}
      <div className={cx("mt-3 grid gap-2", multi ? "sm:grid-cols-2" : "")}>
        {q.options.map(([value, label]) => {
          const id = `plan-${k}-${value}`;
          return (
            <label
              key={value}
              htmlFor={id}
              className={cx(
                "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-[0.88rem] transition-colors",
                on(value)
                  ? "border-gold bg-gold/10 text-ink"
                  : "border-line text-muted hover:border-line-strong",
              )}
            >
              <input
                id={id}
                type={multi ? "checkbox" : "radio"}
                name={`plan-${k}`}
                checked={on(value)}
                onChange={() => pick(value)}
                className="h-4 w-4 shrink-0 accent-[var(--color-gold)]"
              />
              {label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** When they would rather not have the computer looked at: one question, an estimate. */
const MANUAL: [string, string, number][] = [
  ["4", "4 GB or less", 4],
  ["8", "About 8 GB", 8],
  ["16", "16 GB or more", 16],
  ["unsure", "I don't know", 4],
];
function manualScan(gb: number): HostScan {
  return {
    os: "Not looked at",
    platform: "unknown",
    cpu: "Not looked at",
    cores: 4,
    memoryBytes: gb * GB,
    gpus: [],
    disks: [],
    network: "unknown",
    docker: false,
    running: [],
  };
}

function LookAtComputer({
  scan,
  onScan,
  busy,
  manual,
  onManual,
  error,
}: {
  scan: HostScan | null;
  onScan: () => void;
  busy: boolean;
  manual: string | null;
  onManual: (v: string) => void;
  error: Error | null;
}) {
  const [declined, setDeclined] = useState(false);
  if (!scan && !declined)
    return (
      <div data-testid="plan-permission">
        <p className="mb-4 text-[0.95rem] leading-relaxed text-ink">
          Can I look at this computer to see what it can handle? I&apos;ll check its processor,
          memory, drives, graphics, and what&apos;s already running. I won&apos;t change, move, or
          open anything.
        </p>
        <p className="mb-5 text-[0.85rem] leading-relaxed text-muted">
          This looks at the computer Hearth is running on, which may not be the phone or browser
          you&apos;re reading this on. Nothing else on your network is looked at.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button tone="primary" disabled={busy} onClick={onScan}>
            {busy ? "Looking…" : "Yes, take a look"}
          </Button>
          <Button tone="quiet" disabled={busy} onClick={() => setDeclined(true)}>
            No, I&apos;ll answer myself
          </Button>
        </div>
        <FormError error={error} />
      </div>
    );
  if (!scan)
    return (
      <fieldset data-testid="plan-manual">
        <legend className="mb-3 text-[1rem] text-ink">
          How much memory does this computer have?
        </legend>
        <p className="mb-3 text-[0.82rem] text-faint">
          On Windows: Settings, System, About. The plan will be an estimate; you can let me look any
          time for a better one.
        </p>
        <div className="grid gap-2">
          {MANUAL.map(([v, label]) => (
            <label
              key={v}
              className={cx(
                "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-[0.88rem]",
                manual === v ? "border-gold bg-gold/10 text-ink" : "border-line text-muted",
              )}
            >
              <input
                type="radio"
                name="plan-manual-memory"
                checked={manual === v}
                onChange={() => onManual(v)}
                className="h-4 w-4 accent-[var(--color-gold)]"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
    );
  const free = scan.freeMemoryBytes;
  const graphics = scan.gpus.length
    ? scan.gpus
        .map(
          (g) =>
            `${g.name}${g.memoryBytes ? ` (${size(g.memoryBytes)})` : ""}${g.vendor === "intel" || g.vendor === "nvidia" ? ": can convert video for TVs that need it" : ""}`,
        )
        .join("; ")
    : "None that can convert video";
  const mediaText = (m?: { videos: number; audio: number; photos: number }) => {
    if (!m) return "";
    const parts = [
      m.videos && `${m.videos} videos`,
      m.audio && `${m.audio} songs or audiobooks`,
      m.photos && `${m.photos} photos`,
    ].filter(Boolean);
    return parts.length ? ` (${parts.join(", ")})` : "";
  };
  const rows: [string, ReactNode][] = [
    ["System", scan.os],
    ["Processor", `${scan.cpu}, ${scan.cores} cores`],
    [
      "Memory",
      `${size(scan.memoryBytes)}${free !== undefined ? `, ${size(free)} free right now` : ""}`,
    ],
    ["Graphics", graphics],
    [
      "Drives",
      scan.disks.length
        ? scan.disks
            .map(
              (d) =>
                `${d.name}: ${size(d.freeBytes)} free of ${size(d.totalBytes)}${mediaText(d.media)}`,
            )
            .join("; ")
        : "Could not read the drives",
    ],
    [
      "Network",
      scan.network === "wired"
        ? "Connected by cable"
        : scan.network === "wifi"
          ? "On Wi-Fi"
          : "Could not tell",
    ],
    ["Docker", scan.docker ? "Installed" : "Not installed (that's fine)"],
    ["Already running", scan.running.length ? scan.running.join(", ") : "Nothing yet"],
  ];
  return (
    <>
      <p className="mb-4 text-[0.92rem] leading-relaxed text-muted">
        I looked at <span className="text-ink">{scan.hostname ?? "this computer"}</span>, the
        computer Hearth is running on. Nothing was changed. Everything below was measured.
      </p>
      <dl
        className="mb-5 divide-y divide-line rounded-xl border border-line"
        data-testid="plan-scan"
      >
        {rows.map(([k, v]) => (
          <div key={k} className="grid gap-1 px-4 py-3 sm:grid-cols-[9rem_1fr]">
            <dt className="text-[0.82rem] text-faint">{k}</dt>
            <dd className="text-[0.9rem] text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <Button tone="quiet" disabled={busy} onClick={onScan}>
        {busy ? "Looking…" : "Look again"}
      </Button>
    </>
  );
}

const FIT: Record<BuildApp["fit"], { label: string; tone: "gold" | "warn" | "neutral" }> = {
  comfortable: { label: "Runs comfortably here", tone: "gold" },
  slow: { label: "Possible with trade-offs", tone: "warn" },
  wait: { label: "Better later", tone: "neutral" },
};

function AppCard({
  app,
  removed,
  onToggle,
  aiName,
  check,
  onConfirm,
  onKeep,
}: {
  app: BuildApp;
  removed: boolean;
  onToggle: () => void;
  aiName: string;
  /** What leaving it out would do, shown for a yes or no before it happens. */
  check?: LeaveOutEffect;
  onConfirm: () => void;
  onKeep: () => void;
}) {
  const ask = `In my homelab plan, what would ${app.name} do for me, and what will I need for it?`;
  return (
    <li
      className={cx(
        "rounded-xl border p-4",
        removed ? "border-dashed border-line bg-bg/40" : "border-line-strong",
      )}
      data-testid={`plan-item-${app.id}`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h4 className="text-[1rem] text-ink">{app.name}</h4>
        {app.installed ? (
          <Tag tone="gold">
            {app.elsewhere
              ? "Yours already, where it runs: used as it is"
              : "Already running: reused"}
          </Tag>
        ) : (
          <Tag tone={FIT[app.fit].tone}>{FIT[app.fit].label}</Tag>
        )}
        {removed && <Tag>Left out</Tag>}
      </div>
      <p className="text-[0.88rem] leading-relaxed text-muted">{app.what}</p>
      {app.fitReason && !app.installed && (
        <p className="mt-2 text-[0.85rem] leading-relaxed text-warn">{app.fitReason}</p>
      )}
      <p className="mt-2 text-[0.85rem] leading-relaxed text-ink">
        <span className="text-faint">Why: </span>
        {app.why}
      </p>
      <p className="mt-1 text-[0.82rem] text-muted">
        <span className="text-faint">Cost: </span>
        {app.cost}. <span className="text-faint">Memory: </span>about {app.memoryGb} GB (estimate).{" "}
        <span className="text-faint">Installed with: </span>
        {app.install === "docker" ? "Docker" : "its own installer"}.
      </p>
      {app.needs.length > 0 && (
        <p className="mt-1 text-[0.82rem] text-muted">
          <span className="text-faint">Needs from you: </span>
          {app.needs.join("; ")}.
        </p>
      )}
      {check && (
        <div
          role="group"
          aria-label={`Before you leave out ${app.name}`}
          className="mt-3 rounded-lg border border-warn/50 bg-warn/5 px-3 py-3 text-[0.85rem] leading-relaxed"
          data-testid="leave-out-check"
        >
          <p className="text-ink">{check.summary}</p>
          {(check.lost.length > 0 || check.gained.length > 0) && (
            <ul className="mt-2 space-y-1 text-muted">
              {[...check.gained, ...check.lost].map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button tone="outline" onClick={onConfirm}>
              Leave it out anyway
            </Button>
            <Button tone="quiet" onClick={onKeep}>
              Keep it
            </Button>
          </div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <LinkButton to={`/ask?q=${encodeURIComponent(ask)}`} tone="quiet">
          Ask {aiName} about this
        </LinkButton>
        <Button tone="quiet" onClick={onToggle} aria-pressed={!removed}>
          {removed ? "Add it back" : "Leave this out"}
        </Button>
      </div>
    </li>
  );
}

/** Said plainly, once (VPN rule): what Hearth costs and what the person brings. */
export function FreeLine() {
  return (
    <p
      className="mb-6 rounded-lg border border-line px-3 py-2 text-[0.84rem] leading-relaxed text-muted"
      data-testid="hearth-free"
    >
      Hearth is free. You bring your own AI (Ollama is free and runs at home) and, for automatic
      downloads, your own VPN.
    </p>
  );
}

function ChoiceCard({
  choice,
  value,
  onPick,
}: {
  choice: BuildChoice;
  value: string;
  onPick: (v: string) => void;
}) {
  return (
    <fieldset
      className="mb-6 rounded-xl border border-line p-4"
      data-testid={`plan-choice-${choice.id}`}
    >
      <legend className="px-1 text-[1rem] text-ink">{choice.question}</legend>
      {choice.notice && (
        <div
          className="mt-2 space-y-2 rounded-lg border border-gold/40 bg-gold/5 px-3 py-3 text-[0.86rem] leading-relaxed text-ink"
          data-testid={`plan-notice-${choice.id}`}
        >
          {choice.notice.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      )}
      {choice.mustPick && !value && (
        <p className="mt-2 text-[0.82rem] text-gold" role="status">
          Pick one to go on: nothing is assumed for you.
        </p>
      )}
      <div className="mt-2 grid gap-2">
        {choice.options.map((o) => (
          <label
            key={o.id}
            className={cx(
              "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3",
              value === o.id ? "border-gold bg-gold/10" : "border-line hover:border-line-strong",
            )}
          >
            <input
              type="radio"
              name={`plan-choice-${choice.id}`}
              checked={value === o.id}
              onChange={() => onPick(o.id)}
              className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-gold)]"
            />
            <span className="text-[0.88rem] leading-relaxed">
              <span className="text-ink">{o.name}</span>
              {o.id === choice.recommended && (
                <span className="ml-2 align-middle">
                  <Tag tone="gold">Recommended for you</Tag>
                </span>
              )}
              <span className="block text-muted">{o.summary}</span>
              <span className="block text-faint">Cost: {o.cost}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="mt-3 text-[0.82rem] leading-relaxed text-muted">
        <span className="text-faint">Why I recommend it: </span>
        {choice.why} It&apos;s your call.
      </p>
    </fieldset>
  );
}

/**
 * A second opinion from the AI: the answers, the machine, and the plan, as a question Ember
 * answers in a conversation. The rules make the plan; Ember can say what it would add or change.
 */
function reviewQuestion(a: BuildAnswers, scan: HostScan, plan: BuildPlan, removed: string[]) {
  const apps = plan.capabilities
    .filter((c) => c.starter)
    .flatMap((c) => c.apps)
    .filter((x) => !removed.includes(x.id))
    .map((x) => x.name);
  const gb = (b: number) => `${Math.round(b / 1024 ** 3)} GB`;
  return [
    "Please review my homelab plan and tell me what you would add, remove, or change, and why.",
    `What I want: ${a.wants.join(", ") || "not sure"}. Experience: ${a.experience ?? "not said"}. Budget: ${a.budget ?? "not said"}. Watching on: ${a.devices.join(", ") || "not said"}, ${a.streams ?? "?"} at once, ${a.quality ?? "?"} quality. Away from home: ${a.away ?? "not said"}.`,
    `My computer: ${scan.os}, ${scan.cpu}, ${scan.cores} cores, ${gb(scan.memoryBytes)} memory${scan.freeMemoryBytes ? ` (${gb(scan.freeMemoryBytes)} free)` : ""}, graphics: ${scan.gpus.map((g) => g.name).join(", ") || "none found"}, Docker ${scan.docker ? "installed" : "not installed"}.`,
    `The plan: ${apps.join(", ")}.`,
    ...plan.requirements
      .filter((r) => r.status !== "included")
      .map((r) => `Not fully met: "${r.wording}" (${r.status}). ${r.reason}`),
  ].join("\n");
}

function checklist(plan: BuildPlan, removed: string[]): string {
  const line = (a: BuildApp) =>
    `- [ ] ${a.name}: ${a.what}${a.needs.length ? ` Needs: ${a.needs.join("; ")}.` : ""}`;
  const starter = plan.capabilities.filter((c) => c.starter);
  const later = plan.capabilities.filter((c) => !c.starter);
  return [
    "My homelab plan (from Hearth)",
    "",
    ...starter.flatMap((c) => [
      c.title,
      ...c.apps.filter((a) => !removed.includes(a.id)).map(line),
    ]),
    ...(later.length ? ["", "Later, if I like:", ...later.flatMap((c) => c.apps.map(line))] : []),
    ...(plan.warnings.length ? ["", "Worth knowing:", ...plan.warnings.map((w) => `- ${w}`)] : []),
  ].join("\n");
}

const wantWords = (w: BuildWant) =>
  BUILD_QUESTIONS.wants.options.find(([id]) => id === w)?.[1] ?? w;

/**
 * "What matters most?": their wishes in order, moved with buttons (works with a keyboard and a
 * screen reader, no dragging). The plan fills in this order, and what changed is said plainly.
 */
function Priorities({ a, onRank }: { a: BuildAnswers; onRank: (order: BuildWant[]) => void }) {
  const wants: BuildWant[] = a.wants.filter((w) => w !== "explore");
  if (wants.length < 2) return null;
  const ranked = (a.priorities ?? []).filter((w) => wants.includes(w));
  const order = [...ranked, ...wants.filter((w) => !ranked.includes(w))];
  const move = (i: number, by: number) => {
    const next = [...order];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    onRank(next);
  };
  return (
    <section
      className="mb-6 rounded-xl border border-line p-4"
      aria-labelledby="plan-priorities-title"
      data-testid="plan-priorities"
    >
      <h3 id="plan-priorities-title" className="text-[1rem] text-ink">
        What matters most to you?
      </h3>
      <p className="mt-1 mb-3 text-[0.82rem] leading-relaxed text-muted">
        When this computer can&apos;t comfortably run everything, the top of this list goes in
        first. Nothing lower down is forgotten: it&apos;s saved for later, with what it would take.
      </p>
      <ol className="space-y-2">
        {order.map((w, i) => (
          <li
            key={w}
            className="flex min-h-11 items-center gap-3 rounded-lg border border-line px-3 py-2"
            data-testid={`plan-rank-${w}`}
          >
            <span className="w-5 text-[0.85rem] text-gold tabular">{i + 1}</span>
            <span className="flex-1 text-[0.88rem] text-ink">{wantWords(w)}</span>
            <Button
              tone="quiet"
              disabled={i === 0}
              aria-label={`Move "${wantWords(w)}" up`}
              onClick={() => move(i, -1)}
            >
              Up
            </Button>
            <Button
              tone="quiet"
              disabled={i === order.length - 1}
              aria-label={`Move "${wantWords(w)}" down`}
              onClick={() => move(i, 1)}
            >
              Down
            </Button>
          </li>
        ))}
      </ol>
    </section>
  );
}

const STATUS: Record<
  BuildRequirement["status"],
  { label: string; tone: "gold" | "warn" | "neutral" }
> = {
  included: { label: "Included", tone: "gold" },
  partial: { label: "Partly, with trade-offs", tone: "warn" },
  substituted: { label: "Met another way", tone: "neutral" },
  deferred: { label: "Waiting for room", tone: "neutral" },
  infeasible: { label: "Not possible here yet", tone: "warn" },
  declined: { label: "Left out by you", tone: "neutral" },
};

/**
 * One goal they asked for, with what became of it and why. In "Requested but not included"
 * it carries their choices: include it anyway (when that's possible), save it for later, or
 * accept the substitute. Nothing here installs anything.
 */
function GoalCard({
  r,
  aiName,
  adds = [],
  actions,
  include,
  onConfirmInclude,
  onCancelInclude,
}: {
  r: BuildRequirement;
  aiName: string;
  /** The apps it would add, when it isn't in the starter. */
  adds?: BuildApp[];
  actions?: ReactNode;
  include?: IncludeEffect | null;
  onConfirmInclude?: () => void;
  onCancelInclude?: () => void;
}) {
  const s =
    r.decision === "include"
      ? { label: "Included anyway", tone: "warn" as const }
      : STATUS[r.status];
  const ask = `In my homelab plan I asked for "${r.wording}". What are my options?`;
  return (
    <li className="rounded-xl border border-line p-4" data-testid={`goal-${r.id}`}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h4 className="text-[0.95rem] text-ink">&ldquo;{r.wording}&rdquo;</h4>
        <Tag tone={s.tone}>{r.decision === "later" ? "Saved for later" : s.label}</Tag>
        {r.source === "cove" && <Tag>{aiName}&apos;s suggestion</Tag>}
        {r.priority && <Tag>Ranked {r.priority}</Tag>}
      </div>
      <p className="text-[0.85rem] leading-relaxed text-muted">{r.reason}</p>
      {adds.length > 0 && (
        <p className="mt-1 text-[0.82rem] text-muted" data-testid="goal-adds">
          <span className="text-faint">Would add: </span>
          {adds.map((x) => `${x.name} (about ${x.memoryGb} GB, an estimate)`).join(", ")}
        </p>
      )}
      {r.alternatives && (
        <div className="mt-2 text-[0.82rem] leading-relaxed text-muted">
          <p className="text-ink">Other ways to get it:</p>
          <ul className="list-disc pl-5">
            {r.alternatives.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      )}
      {include && (
        <div
          role="group"
          aria-label={`Before you include "${r.wording}" anyway`}
          className="mt-3 rounded-lg border border-warn/50 bg-warn/5 px-3 py-3 text-[0.85rem] leading-relaxed"
          data-testid="include-check"
        >
          <p className="mb-1 text-ink">
            {include.allowed ? "Before you include it anyway:" : "This can't be included anyway:"}
          </p>
          <ul className="list-disc space-y-1 pl-5 text-muted">
            {[...include.risks, ...include.lost, ...include.gained].map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            {include.allowed && (
              <Button tone="outline" onClick={onConfirmInclude}>
                I understand, include it
              </Button>
            )}
            <Button tone="quiet" onClick={onCancelInclude}>
              {include.allowed ? "Not now" : "Close"}
            </Button>
          </div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {actions}
        <LinkButton to={`/ask?q=${encodeURIComponent(ask)}`} tone="quiet">
          Ask {aiName}
        </LinkButton>
      </div>
    </li>
  );
}

function CapabilityBlock({
  c,
  removed,
  toggle,
  aiName,
  alternatives = [],
  check,
  onConfirm,
  onKeep,
}: {
  c: BuildCapability;
  removed: string[];
  toggle: (id: string) => void;
  aiName: string;
  alternatives?: string[];
  check: LeaveOutEffect | null;
  onConfirm: () => void;
  onKeep: () => void;
}) {
  return (
    <section className="mb-6" aria-label={c.title} data-testid={`plan-cap-${c.id}`}>
      <h3 className="mb-2 text-[1.05rem] text-ink">{c.title}</h3>
      {c.waitReason && <p className="mb-2 text-[0.82rem] text-muted">{c.waitReason}</p>}
      {alternatives.length > 0 && (
        <div
          className="mb-3 text-[0.82rem] leading-relaxed text-muted"
          data-testid="plan-alternatives"
        >
          <p className="text-ink">Other ways to get it:</p>
          <ul className="list-disc pl-5">
            {alternatives.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      )}
      <ul className="space-y-3">
        {c.apps.map((a) => (
          <AppCard
            key={a.id}
            app={a}
            aiName={aiName}
            removed={removed.includes(a.id)}
            onToggle={() => toggle(a.id)}
            {...(check?.app === a.id ? { check } : {})}
            onConfirm={onConfirm}
            onKeep={onKeep}
          />
        ))}
      </ul>
    </section>
  );
}

export function PlanPage() {
  const aiName = useAiName();
  const plan = usePlan();
  const save = useSavePlan();
  const look = useScanComputer();
  const startOver = useStartOver();
  const [params, setParams] = useSearchParams();
  const step = Math.min(Math.max(Number(params.get("step")) || 1, 1), HOMELAB_STEP);
  const [answers, setAnswers] = useState<BuildAnswers | null>(null);
  const [chosen, setChosen] = useState<Record<string, string> | null>(null);
  const [removed, setRemoved] = useState<string[] | null>(null);
  const [manual, setManual] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [changes, setChanges] = useState<string[] | null>(null);
  const [check, setCheck] = useState<LeaveOutEffect | null>(null);
  const [decided, setDecided] = useState<Record<string, GoalChoice> | null>(null);
  const [including, setIncluding] = useState<IncludeEffect | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [step]);

  if (!plan.data) return plan.error ? <FormError error={plan.error} /> : <PageSkeleton />;
  const saved = plan.data.saved;
  const a: BuildAnswers = answers ?? saved?.answers ?? { wants: [], devices: [] };
  const picks = chosen ?? saved?.chosen ?? {};
  const off = removed ?? saved?.removed ?? [];
  const choices: Record<string, GoalChoice> =
    decided ??
    Object.fromEntries(Object.entries(saved?.decisions ?? {}).map(([k, d]) => [k, d.choice]));
  // When each was decided is recorded by the server; here only the choice matters.
  const decisions: GoalDecisions = Object.fromEntries(
    Object.entries(choices).map(([k, choice]) => [k, { choice, at: "" }]),
  );
  const scan =
    plan.data.scan ?? (manual ? manualScan(MANUAL.find(([v]) => v === manual)![2]) : null);
  const persist = (confirmed = false) =>
    save.mutateAsync({ answers: a, chosen: picks, removed: off, decisions: choices, confirmed });
  const go = (n: number) => {
    // Save as they go, so they can stop and pick up here later.
    void persist();
    setParams({ step: String(n) });
  };
  const result = scan ? recommendBuild(a, scan, picks, off, decisions) : null;
  const groups = result ? planGroups(result) : null;
  const addsFor = (r: BuildRequirement) =>
    (result?.capabilities ?? [])
      .filter((c) => !c.starter)
      .flatMap((c) => c.apps)
      .filter((x) => r.apps.includes(x.id) && !x.installed);
  // Any change replans from scratch, so nothing shown can go stale: open checks close, and the
  // "what changed" line describes the change just made.
  const replan = (next: {
    answers?: BuildAnswers;
    removed?: string[];
    choices?: Record<string, GoalChoice>;
  }) => {
    if (!result || !scan) return;
    const after = recommendBuild(
      next.answers ?? a,
      scan,
      picks,
      next.removed ?? off,
      next.choices
        ? Object.fromEntries(
            Object.entries(next.choices).map(([k, choice]) => [k, { choice, at: "" }]),
          )
        : decisions,
    );
    setChanges(comparePlans(result, after));
    setCheck(null);
    setIncluding(null);
    if (next.answers) setAnswers(next.answers);
    if (next.removed) setRemoved(next.removed);
    if (next.choices) setDecided(next.choices);
  };
  const decide = (goal: string, choice: GoalChoice | null) => {
    const next = { ...choices };
    if (choice) next[goal] = choice;
    else delete next[goal];
    replan({ choices: next });
  };
  const title =
    step <= SCREENS.length
      ? SCREENS[step - 1]!.title
      : step === LOOK_STEP
        ? "Your computer"
        : step === PLAN_STEP
          ? "Your plan"
          : "Your homelab";
  const starter = result?.capabilities.filter((c) => c.starter) ?? [];
  const setOff = (id: string) =>
    replan({ removed: off.includes(id) ? off.filter((x) => x !== id) : [...off, id] });
  // Adding back is immediate. Leaving out first says what it would break, lose, and free, and
  // asks, unless it touches nothing at all.
  const toggle = (id: string) => {
    if (off.includes(id) || !scan) return setOff(id);
    const e = leaveOutEffects(a, scan, picks, off, id, decisions);
    if (e.breaks.length || e.lost.length || e.gained.length) setCheck(e);
    else setOff(id);
  };
  const blockProps = (c: BuildCapability) => ({
    c,
    removed: off,
    toggle,
    aiName,
    check,
    onConfirm: () => {
      if (check) setOff(check.app);
      setCheck(null);
    },
    onKeep: () => setCheck(null),
    alternatives: [
      ...new Set(
        (result?.requirements ?? [])
          .filter((r) => r.alternatives && r.apps.some((id) => c.apps.some((x) => x.id === id)))
          .flatMap((r) => r.alternatives!),
      ),
    ],
  });

  return (
    <>
      <PageHeader
        eyebrow="Help me build"
        title="Your first homelab"
        subtitle={`Tell ${aiName} what you'd love to do. It looks at this computer, works out what's realistic, and explains every option. Nothing is installed from here, and you can stop and come back any time.`}
      />
      <div className="mx-auto max-w-2xl">
        <p className="mb-2 text-[0.82rem] text-muted" data-testid="plan-progress">
          Step {step} of {HOMELAB_STEP}: {title}
        </p>
        <div
          role="progressbar"
          aria-label="Plan progress"
          aria-valuemin={1}
          aria-valuemax={HOMELAB_STEP}
          aria-valuenow={step}
          className="mb-6 h-1.5 w-full overflow-hidden rounded-full bg-line"
        >
          <div
            className="h-full rounded-full bg-gold"
            style={{ width: `${(step / HOMELAB_STEP) * 100}%` }}
          />
        </div>
        <section className="rounded-2xl border border-line bg-panel p-5 sm:p-8">
          <h2
            ref={heading}
            tabIndex={-1}
            className="mb-2 font-display text-[1.8rem] leading-tight text-ink focus:outline-none"
          >
            {title}
          </h2>
          {step <= SCREENS.length && (
            <>
              <p className="mb-6 text-[0.92rem] text-muted">{SCREENS[step - 1]!.lead}</p>
              {step === 1 && <FreeLine />}
              {SCREENS[step - 1]!.keys.filter((k) => shown(k, a)).map((k) => (
                <Question key={k} k={k} answers={a} set={setAnswers} />
              ))}
            </>
          )}
          {step === LOOK_STEP && (
            <LookAtComputer
              scan={plan.data.scan}
              busy={look.isPending}
              onScan={() => look.mutate()}
              manual={manual}
              onManual={setManual}
              error={look.error}
            />
          )}
          {step === PLAN_STEP && !result && (
            <div>
              <p className="mb-4 text-[0.92rem] text-muted">
                I need to know a little about this computer first.
              </p>
              <Button tone="primary" onClick={() => setParams({ step: String(LOOK_STEP) })}>
                Back to your computer
              </Button>
            </div>
          )}
          {step === PLAN_STEP && result && (
            <div data-testid="plan-result">
              <p
                className="mb-3 text-[0.98rem] leading-relaxed text-ink"
                data-testid="plan-summary"
              >
                {result.summary}
              </p>
              {!plan.data.scan && (
                <p className="mb-3 text-[0.82rem] text-warn">
                  This is an estimate from your answer, since I didn&apos;t look at the computer.
                </p>
              )}
              {result.warnings.length > 0 && (
                <ul className="mb-4 space-y-2" data-testid="plan-warnings">
                  {result.warnings.map((w) => (
                    <li
                      key={w}
                      className="rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-[0.85rem] leading-relaxed text-ink"
                    >
                      {w}
                    </li>
                  ))}
                </ul>
              )}
              {result.notes.length > 0 && (
                <ul className="mb-5 space-y-1 text-[0.85rem] leading-relaxed text-muted">
                  {result.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              <Priorities
                a={a}
                onRank={(order) => replan({ answers: { ...a, priorities: order } })}
              />
              {result.choices.map((c) => (
                <ChoiceCard
                  key={c.id}
                  choice={c}
                  value={picks[c.id] ?? (c.mustPick ? "" : c.recommended)}
                  onPick={(v) => {
                    setChosen({ ...picks, [c.id]: v });
                    setChanges(null);
                    setCheck(null);
                    setIncluding(null);
                  }}
                />
              ))}
              {changes && (
                <div
                  role="status"
                  className="mb-5 rounded-lg border border-line px-3 py-3 text-[0.85rem] leading-relaxed"
                  data-testid="plan-changes"
                >
                  {changes.length ? (
                    <>
                      <p className="mb-1 text-ink">What changed:</p>
                      <ul className="space-y-1 text-muted">
                        {changes.map((c) => (
                          <li key={c}>{c}</li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="text-muted">
                      Nothing you asked for changed: the plan is the same.
                    </p>
                  )}
                </div>
              )}

              <section aria-labelledby="group-included" data-testid="group-included">
                <h3 id="group-included" className="eyebrow mb-3">
                  Included in your plan
                </h3>
                {groups!.included.length > 0 && (
                  <ul className="mb-5 space-y-3">
                    {groups!.included.map((r) => (
                      <GoalCard
                        key={r.id}
                        r={r}
                        aiName={aiName}
                        actions={
                          r.decision === "include" || r.decision === "accept" ? (
                            <Button tone="quiet" onClick={() => decide(r.id, null)}>
                              Undo my choice
                            </Button>
                          ) : r.source === "customer" && r.id.startsWith("want:") ? (
                            <Button tone="quiet" onClick={() => decide(r.id, "later")}>
                              Save for later
                            </Button>
                          ) : undefined
                        }
                      />
                    ))}
                  </ul>
                )}
                <p className="mb-3 text-[0.9rem] text-ink">What gets set up:</p>
                {starter.map((c) => (
                  <CapabilityBlock key={c.title} {...blockProps(c)} />
                ))}
              </section>

              <section
                aria-labelledby="group-not-included"
                className="mt-8"
                data-testid="group-not-included"
              >
                <h3 id="group-not-included" className="eyebrow mb-3">
                  Requested but not included
                </h3>
                {groups!.notIncluded.length === 0 ? (
                  <p className="mb-5 text-[0.85rem] text-muted">
                    Nothing: everything you asked for is in your plan or saved for later.
                  </p>
                ) : (
                  <>
                    <p className="mb-3 text-[0.85rem] leading-relaxed text-muted">
                      You asked for these, and they aren&apos;t in the plan yet. Each says why, what
                      went first, and what you can do. Your call on each.
                    </p>
                    <ul className="mb-5 space-y-3">
                      {groups!.notIncluded.map((r) => (
                        <GoalCard
                          key={r.id}
                          r={r}
                          aiName={aiName}
                          adds={addsFor(r)}
                          include={including?.goal === r.id ? including : null}
                          onConfirmInclude={() => decide(r.id, "include")}
                          onCancelInclude={() => setIncluding(null)}
                          actions={
                            <>
                              {r.status === "substituted" ? (
                                <Button tone="outline" onClick={() => decide(r.id, "accept")}>
                                  That&apos;s fine
                                </Button>
                              ) : (
                                r.status === "deferred" && (
                                  <Button
                                    tone="outline"
                                    onClick={() =>
                                      setIncluding(
                                        includeAnywayEffects(a, scan!, picks, off, decisions, r.id),
                                      )
                                    }
                                  >
                                    Include it anyway
                                  </Button>
                                )
                              )}
                              {r.status !== "substituted" && (
                                <Button tone="quiet" onClick={() => decide(r.id, "later")}>
                                  Save for later
                                </Button>
                              )}
                            </>
                          }
                        />
                      ))}
                    </ul>
                  </>
                )}
              </section>

              <section aria-labelledby="group-later" className="mt-8" data-testid="group-later">
                <h3 id="group-later" className="eyebrow mb-3">
                  Saved for later
                </h3>
                {groups!.later.length === 0 && groups!.suggestions.length === 0 ? (
                  <p className="mb-5 text-[0.85rem] text-muted">Nothing saved for later.</p>
                ) : (
                  <>
                    <p className="mb-3 text-[0.85rem] leading-relaxed text-muted">
                      Kept on your list, not forgotten. {aiName} can look again when this computer
                      changes.
                    </p>
                    <ul className="mb-5 space-y-3">
                      {groups!.later.map((r) => (
                        <GoalCard
                          key={r.id}
                          r={r}
                          aiName={aiName}
                          adds={addsFor(r)}
                          actions={
                            r.decision === "later" ? (
                              <Button tone="outline" onClick={() => decide(r.id, null)}>
                                Bring it back
                              </Button>
                            ) : r.status === "declined" && r.apps.some((x) => off.includes(x)) ? (
                              <Button
                                tone="outline"
                                onClick={() =>
                                  replan({ removed: off.filter((x) => !r.apps.includes(x)) })
                                }
                              >
                                Add it back
                              </Button>
                            ) : undefined
                          }
                        />
                      ))}
                    </ul>
                    {groups!.suggestions.map((c) => (
                      <CapabilityBlock key={c.title} {...blockProps(c)} />
                    ))}
                  </>
                )}
              </section>
              <div className="mb-5 rounded-lg border border-line px-3 py-3 text-[0.85rem] leading-relaxed text-muted">
                <p className="mb-1 text-ink">How the apps would be installed</p>
                {result.installMethod.why}
              </div>
              <div
                className="mb-6 rounded-lg border border-line px-3 py-3"
                data-testid="plan-approvals"
              >
                <p className="mb-2 text-[0.9rem] text-ink">
                  Before anything happens, {aiName} will ask you about:
                </p>
                <ul className="list-disc space-y-1 pl-5 text-[0.85rem] leading-relaxed text-muted">
                  {result.approvals.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
              <div className="flex flex-wrap gap-3">
                <Button disabled={save.isPending} onClick={() => void persist(true)}>
                  {saved?.confirmed ? "Plan saved" : "Save this plan"}
                </Button>
                <LinkButton
                  tone="outline"
                  to={`/ask?q=${encodeURIComponent(reviewQuestion(a, scan!, result, off))}`}
                >
                  Have {aiName} review my plan
                </LinkButton>
                <Button
                  tone="quiet"
                  onClick={() =>
                    void navigator.clipboard
                      ?.writeText(checklist(result, off))
                      .then(() => setCopied(true))
                  }
                >
                  {copied ? "Copied" : "Copy as a checklist"}
                </Button>
              </div>
              <FormError error={save.error} />
            </div>
          )}
          {step === HOMELAB_STEP && result && (
            <YourHomelab
              aiName={aiName}
              apps={starter
                .flatMap((c) => c.apps)
                // Only what gets set up here: not what they left out or already run elsewhere.
                .filter((x) => !off.includes(x.id) && !x.elsewhere)}
            />
          )}
          {step === HOMELAB_STEP && !result && (
            <Button tone="primary" onClick={() => setParams({ step: String(LOOK_STEP) })}>
              Back to your computer
            </Button>
          )}
        </section>
        {/* Back and Next stay on screen while the step scrolls, so a laptop never has to scroll
            down to move on (11-22). */}
        <nav
          aria-label="Plan steps"
          className="sticky bottom-0 z-10 mt-4 flex items-center justify-between gap-3 border-t border-line bg-bg/95 py-3 backdrop-blur-sm"
        >
          <div className="flex flex-wrap gap-2">
            <Button disabled={step === 1} onClick={() => go(step - 1)}>
              Back
            </Button>
            {saved && (
              <Button
                tone="quiet"
                disabled={startOver.isPending}
                onClick={() =>
                  void startOver.mutateAsync().then(() => {
                    setAnswers(null);
                    setChosen(null);
                    setRemoved(null);
                    setManual(null);
                    setParams({ step: "1" });
                  })
                }
              >
                Start over
              </Button>
            )}
          </div>
          {step < PLAN_STEP && (
            <Button
              tone="primary"
              disabled={step === LOOK_STEP && !scan}
              onClick={() => go(step + 1)}
            >
              {step === LOOK_STEP ? "See my plan" : "Next"}
            </Button>
          )}
          {step === PLAN_STEP && result && (
            <Button
              tone="primary"
              disabled={save.isPending}
              onClick={() =>
                void persist(true).then(() => setParams({ step: String(HOMELAB_STEP) }))
              }
            >
              Next: your apps and accounts
            </Button>
          )}
        </nav>
      </div>
    </>
  );
}
