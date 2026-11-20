import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CaptureFolderField } from "../components/settings/CaptureFolderField";
import { AddonSlot } from "../components/AddonSlot";
import { useLocation, useNavigate } from "react-router";
import { OwnerAvatarField } from "../components/shell/OwnerAvatar";
import { ChatPicturesSwitch } from "../components/shell/MessagePicture";
import { ThemePicker } from "../components/settings/ThemePicker";
import { NameField } from "../components/settings/NameField";
import { WebUiVia } from "../components/settings/WebUiVia";
import { HomelabRules } from "../components/settings/HomelabRules";
import { CaveSettings } from "./CaveSettings";
import { useHealth } from "../useHealth";
import {
  useAudit,
  useSetScenario,
  useSimulatedOutage,
  useUpdateSettings,
  useWorkspace,
  type ScenarioChoice,
  useAiName,
} from "../data/api";
import {
  Button,
  FoldContext,
  foldDefaultOpen,
  LinkButton,
  PageHeader,
  Rows,
  SaveNote,
  Section,
  setFoldDefault,
  Switch,
  cx,
} from "../components/ui";
import { ago } from "../lib/format";
import { SUPPORT_URL } from "../lib/support";
import { SecuritySettings } from "./auth/Security";
import { DevicesContent } from "./Devices";
import { PcBadge } from "../components/devices/PcBadge";
import { usePcs } from "../data/pcs";
import { UpdateDetails } from "../components/updates/UpdateNotice";
import { useUpdateAuto, useUpdates } from "../data/updates";
import { AccessKeysSection } from "./auth/AccessKeys";
import { BackupsSection } from "./BackupsSection";
import { BlueprintSection } from "./BlueprintSection";
import { PremiumSettings } from "../components/settings/PremiumSettings";
import { RemovedSystems } from "../components/systems/ManageSystems";
import { GettingStartedList, MeetButton } from "../components/GettingStarted";
import {
  formatBytes,
  useResourceHistory,
  useRestartHistory,
  useSetResourceHistory,
  useSetRestartHistory,
} from "../data/history";

const SCENARIOS: { id: ScenarioChoice; label: string; description: string }[] = [
  { id: "calm", label: "All clear", description: "A healthy homelab with a quiet history." },
  {
    id: "attention",
    label: "Needs attention",
    description: "An unresolved incident and a filling disk.",
  },
  { id: "fresh", label: "Fresh install", description: "Nothing connected yet." },
  {
    id: "unreachable",
    label: "Server unreachable",
    description: "Simulated in this browser only.",
  },
];

function Field({
  label,
  children,
  hint,
  wide,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  /** A longer value (a folder path): more room on the right. */
  wide?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 py-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <p className="text-[0.95rem] text-ink">{label}</p>
        {hint && <p className="text-[0.8rem] text-faint">{hint}</p>}
      </div>
      <div className={wide ? "sm:w-[26rem] sm:shrink-0" : "sm:w-72"}>{children}</div>
    </div>
  );
}

function About() {
  const { state } = useHealth();
  const report = state.kind === "ready" ? state.report : null;
  const rows: [string, string][] = [
    ["Version", report?.version ?? "…"],
    ["Mode", report?.mode ?? "…"],
    [
      "Control plane",
      state.kind === "unreachable" ? "Not responding" : report?.status === "ok" ? "Healthy" : "…",
    ],
    ["Database", report?.database.status === "ok" ? "Healthy" : (report?.database.status ?? "…")],
    ["Installation", report?.database.installId?.slice(0, 8).toUpperCase() ?? "…"],
  ];
  return (
    <dl className="divide-y divide-line">
      {rows.map(([k, v]) => (
        <div key={k} className="flex min-h-12 items-center justify-between py-3">
          <dt className="text-[0.85rem] text-faint">{k}</dt>
          <dd
            className="text-[0.88rem] text-ink capitalize tabular"
            data-testid={`about-${k.toLowerCase().replace(/ /g, "-")}`}
          >
            {v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function RecentChanges() {
  const { data, error } = useAudit(8);
  if (error)
    return <p className="py-2 text-[0.88rem] text-muted">History is unavailable right now.</p>;
  if (!data) return <p className="py-2 text-[0.88rem] text-faint">Loading</p>;
  if (data.length === 0) {
    return (
      <p className="py-2 text-[0.9rem] text-muted">
        No changes yet. Everything you change is recorded here.
      </p>
    );
  }
  const who = { you: "You", "dragon-control": "Hearth", agent: "AI agent" };
  return (
    <Rows>
      {data.map((r) => (
        <li key={r.id} className="flex min-h-12 items-center gap-4 py-3" data-testid="audit-row">
          <span className="flex-1 text-[0.9rem] text-ink">
            <span className="text-muted">{who[r.actor]} · </span>
            {r.action}
          </span>
          <span className="text-[0.78rem] whitespace-nowrap text-faint">{ago(r.at)}</span>
        </li>
      ))}
    </Rows>
  );
}

function DemoScenarios() {
  const { data } = useWorkspace();
  const outage = useSimulatedOutage();
  const scenarios = useSetScenario();
  const active: ScenarioChoice | null = outage ? "unreachable" : (data?.demoScenario ?? null);

  return (
    <Section title="Demo environment">
      <p className="mb-5 max-w-lg text-[0.85rem] leading-relaxed text-muted">
        You are looking at sample data, not your own systems. Discover this machine to replace it
        with what you actually run; your name and preferences are kept.
      </p>
      <div className="mb-8">
        <LinkButton to="/discover" tone="primary">
          Discover this machine
        </LinkButton>
      </div>
      <p className="eyebrow mb-3">Sample scenarios</p>
      <div role="radiogroup" aria-label="Demo scenario" className="grid gap-3 sm:grid-cols-2">
        {SCENARIOS.map((s) => {
          const on = s.id === active;
          return (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={scenarios.isPending}
              onClick={() => scenarios.choose(s.id)}
              className={cx(
                "min-h-11 rounded-xl border px-5 py-4 text-left transition-colors duration-200 disabled:opacity-60",
                on
                  ? "border-gold/60 bg-gold/[0.06]"
                  : "border-line bg-panel hover:border-line-strong",
              )}
            >
              <span className={cx("block text-[0.95rem]", on ? "text-gold" : "text-ink")}>
                {s.label}
              </span>
              <span className="mt-0.5 block text-[0.8rem] text-faint">{s.description}</span>
            </button>
          );
        })}
      </div>
      {scenarios.error && (
        <p role="alert" className="mt-3 text-[0.85rem] text-bad">
          {scenarios.error.message}
        </p>
      )}
    </Section>
  );
}

const intervals = [
  [15, "Every 15 seconds"],
  [30, "Every 30 seconds"],
  [60, "Every minute"],
  [300, "Every 5 minutes"],
  [900, "Every 15 minutes"],
] as const;

function MonitoringSettings() {
  const { data } = useWorkspace();
  const save = useUpdateSettings();
  if (!data) return null;
  const m = data.monitoring;
  const selectClass =
    "min-h-11 w-full rounded-lg border border-line bg-panel px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none";
  return (
    <Section title="Monitoring">
      <div className="divide-y divide-line">
        <Field label="Check services" hint="Each check is a read-only look; nothing is changed.">
          <label className="sr-only" htmlFor="monitor-interval">
            Check services
          </label>
          <select
            id="monitor-interval"
            value={m.intervalSec}
            onChange={(e) => save.mutate({ monitorIntervalSec: Number(e.target.value) })}
            className={selectClass}
          >
            {intervals.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
            {!intervals.some(([v]) => v === m.intervalSec) && (
              <option value={m.intervalSec}>Every {m.intervalSec} seconds</option>
            )}
          </select>
        </Field>
        <Field
          label="Open an incident after"
          hint="A single failed check is usually a blip. Requiring a few in a row avoids false alarms."
        >
          <label className="sr-only" htmlFor="failure-threshold">
            Open an incident after
          </label>
          <select
            id="failure-threshold"
            value={m.failureThreshold}
            onChange={(e) => save.mutate({ failureThreshold: Number(e.target.value) })}
            className={selectClass}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n === 1 ? "The first failed check" : `${n} failed checks in a row`}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p className="mt-3 text-[0.8rem] text-faint">
        {m.lastRunAt
          ? `Last checked ${ago(m.lastRunAt).toLowerCase()}.`
          : "The first check runs shortly."}
      </p>
      <SaveNote status={save.status} error={save.error} />
    </Section>
  );
}

/**
 * Resource history: off until switched on here, with what it will keep and
 * cost shown before it starts (server: monitor/history.ts).
 */
function ResourceHistorySettings() {
  const { data } = useResourceHistory();
  const save = useSetResourceHistory();
  if (!data) return null;
  const e = data.estimates[String(data.retentionDays)] ?? data.estimate;
  const selectClass =
    "min-h-11 w-full rounded-lg border border-line bg-panel px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none";
  return (
    <Section title="Resource history">
      <div data-testid="resource-history">
        <p className="text-[0.85rem] leading-relaxed text-muted">
          Keeps hourly CPU, memory, and disk activity (average and peak) for this machine and each
          watched container, so Ember can see what happened before a slowdown instead of only what
          is happening now. It reads each container's counters every {data.sampleMinutes} minutes
          (one quick read, nothing changed) and stores one row per container per hour.
        </p>
        <div className="divide-y divide-line">
          <Field label="Keep" hint="Older hours are deleted once a day.">
            <label className="sr-only" htmlFor="history-retention">
              Keep resource history for
            </label>
            <select
              id="history-retention"
              value={data.retentionDays}
              onChange={(ev) => save.mutate({ retentionDays: Number(ev.target.value) })}
              className={selectClass}
            >
              {data.retentionChoices.map((d) => (
                <option key={d} value={d}>
                  {d} days (about {formatBytes(data.estimates[String(d)]?.bytes ?? 0)})
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className="text-[0.8rem] text-faint" data-testid="resource-history-estimate">
          {data.enabled ? "Estimated size when full" : "What it would keep"}: {e.subjects} subjects
          (this machine and {e.containers} containers) x 24 hours x {data.retentionDays} days ={" "}
          {e.rows.toLocaleString()} rows, about {formatBytes(e.bytes)}.
          {data.stored.rows > 0 &&
            ` Stored now: ${data.stored.rows.toLocaleString()} rows (about ${formatBytes(data.stored.bytes)}).`}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            tone={data.enabled ? "outline" : "primary"}
            onClick={() => save.mutate({ enabled: !data.enabled })}
            disabled={save.isPending}
          >
            {data.enabled ? "Turn off resource history" : "Turn on resource history"}
          </Button>
          <p className="text-[0.8rem] text-faint">
            {data.enabled
              ? `On. Recording since ${data.stored.oldest ? ago(data.stored.oldest).toLowerCase() : "the next sample"}.`
              : "Off: nothing is recorded."}
          </p>
        </div>
        <SaveNote status={save.status} error={save.error} />
      </div>
    </Section>
  );
}

/**
 * Restart history: on by default (tiny rows), with its limits and a switch
 * (server: monitor/restarts.ts).
 */
function RestartHistorySettings() {
  const { data } = useRestartHistory();
  const save = useSetRestartHistory();
  if (!data) return null;
  const selectClass =
    "min-h-11 w-full rounded-lg border border-line bg-panel px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none";
  return (
    <Section title="Restart history">
      <div data-testid="restart-history-settings">
        <p className="text-[0.85rem] leading-relaxed text-muted">
          Records each start and stop of a watched container (when, how the previous run ended, exit
          code, out of memory, and whether Hearth, Docker, or something else started it), from
          Docker's own state every {data.sweepMinutes} minutes. Shown on each service's Health and
          History tabs and used by Ember to investigate restarts.
        </p>
        <div className="divide-y divide-line">
          <Field
            label="Keep"
            hint={`Older entries are deleted once a day, and at most ${data.keepPerService} are kept per service.`}
          >
            <label className="sr-only" htmlFor="restart-retention">
              Keep restart history for
            </label>
            <select
              id="restart-retention"
              value={data.retentionDays}
              onChange={(ev) => save.mutate({ retentionDays: Number(ev.target.value) })}
              className={selectClass}
            >
              {data.retentionChoices.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className="text-[0.8rem] text-faint">
          Stored now: {data.stored.rows.toLocaleString()} entries (about{" "}
          {formatBytes(data.stored.bytes)}).
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            tone={data.enabled ? "outline" : "primary"}
            onClick={() => save.mutate({ enabled: !data.enabled })}
            disabled={save.isPending}
          >
            {data.enabled ? "Turn off restart history" : "Turn on restart history"}
          </Button>
          <p className="text-[0.8rem] text-faint">
            {data.enabled
              ? "On."
              : "Off: nothing new is recorded; what is kept stays until its time is up."}
          </p>
        </div>
        <SaveNote status={save.status} error={save.error} />
      </div>
    </Section>
  );
}

function YourSystems() {
  const { data } = useWorkspace();
  const scenarios = useSetScenario();
  const [confirming, setConfirming] = useState(false);
  if (data?.environment !== "real") return null;
  const host = data.hosts[0]?.name;

  return (
    <Section title="Your systems">
      <p className="mb-5 max-w-lg text-[0.88rem] leading-relaxed text-muted">
        {data.services.length} services on {host ?? "this machine"}
        {data.discoveredAt ? `, discovered ${ago(data.discoveredAt).toLowerCase()}` : ""}. Scan
        again after adding or removing apps.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <LinkButton to="/discover">Scan again</LinkButton>
        {confirming ? (
          <>
            <Button
              tone="outline"
              className="border-bad/60 text-bad hover:border-bad hover:text-bad"
              onClick={() => scenarios.choose("calm", { replaceYourSystems: true })}
            >
              Replace with sample data
            </Button>
            <Button tone="quiet" onClick={() => setConfirming(false)}>
              Keep my systems
            </Button>
          </>
        ) : (
          <Button tone="quiet" onClick={() => setConfirming(true)}>
            Show sample data instead
          </Button>
        )}
      </div>
      {confirming && (
        <p role="status" className="mt-3 max-w-lg text-[0.82rem] text-muted">
          Your discovered systems will be replaced by sample data until you scan again. Settings and
          history are kept. Nothing on your machines is affected.
        </p>
      )}
      {scenarios.error && (
        <p role="alert" className="mt-3 text-[0.85rem] text-bad">
          {scenarios.error.message}
        </p>
      )}
    </Section>
  );
}

/** The tabs, in order. Each is a link too: /settings#security opens Security. */
const TABS = [
  "general",
  "devices",
  "cave",
  "security",
  "backups",
  "monitoring",
  "systems",
  "premium",
  "about",
] as const;
type SettingsTab = (typeof TABS)[number];
/** Links to one section inside a tab (/settings#ollama): the tab it is on. */
const SECTION_TABS: Record<string, SettingsTab> = {
  ollama: "cave",
  "full-access": "cave",
  "show-and-tell": "cave",
  blueprint: "backups",
};

/** This PC's icon and name, with a way to change them (Settings, PCs and devices). */
function ThisPcField({ onEdit }: { onEdit: () => void }) {
  const hub = usePcs().data?.hub;
  if (!hub) return <p className="text-[0.9rem] text-faint sm:text-right">Unavailable</p>;
  return (
    <div className="flex items-center gap-4 sm:justify-end" data-testid="this-pc">
      {hub.icon ? (
        <PcBadge pc={hub} size={44} />
      ) : (
        <span className="text-[0.88rem] text-muted">{hub.name}: no icon yet</span>
      )}
      <Button onClick={onEdit}>{hub.icon ? "Change" : "Choose its icon"}</Button>
    </div>
  );
}

/** Settings, About: this Hearth's version, whether a newer one is out, and Update now. */
function UpdatesSection() {
  const s = useUpdates().data;
  const auto = useUpdateAuto();
  if (!s) return <p className="text-[0.9rem] text-faint">Checking…</p>;
  const on = auto.isPending ? (auto.variables ?? s.auto !== false) : s.auto !== false;
  return (
    <>
      <div
        className="mb-3 flex flex-wrap items-center justify-between gap-2"
        data-testid="update-auto"
      >
        <p className="text-[0.9rem] text-muted">
          {on
            ? "Hearth asks GitHub every few hours whether a newer Hearth is out."
            : "Hearth never checks on its own. Press Check now when you want to know."}
        </p>
        <div className="flex items-center gap-2">
          <Switch checked={on} onChange={(next) => auto.mutate(next)} label="Check for updates" />
          <SaveNote status={auto.status} error={auto.error} />
        </div>
      </div>
      <UpdateDetails s={s} />
    </>
  );
}

export function SettingsPage() {
  // Folded sections (the owner, 11-13): Open all / Close all for the whole page, remembered.
  const [fold, setFold] = useState(() => ({ open: foldDefaultOpen(), at: 0 }));
  const allOpen = fold.open;
  const { data } = useWorkspace();
  const aiName = useAiName();
  const outage = useSimulatedOutage();
  const { hash } = useLocation();
  const navigate = useNavigate();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Demo controls stay reachable during a simulated outage so it can be undone.
  const showDemo = outage || data?.demoScenario != null;

  const asked = hash.slice(1) as SettingsTab;
  const section = SECTION_TABS[asked];
  const tab: SettingsTab = TABS.includes(asked) ? asked : (section ?? "general");
  const labels: Record<SettingsTab, string> = {
    general: "General",
    devices: "PCs and devices",
    cave: "Ember",
    security: "Security",
    backups: "Backups",
    monitoring: "Monitoring",
    systems: "Systems",
    premium: "Premium",
    about: "About",
  };
  // Coming from a link (/settings#security) or switching tabs keeps the tabs in view, rather
  // than leaving the page scrolled to wherever the last page or tab was.
  useEffect(() => {
    // In braces: newer browsers return a promise here, which React would take for a cleanup.
    // The chosen tab itself, so on a phone a tab past the edge of the bar slides into view too.
    void tabRefs.current[TABS.indexOf(tab)]?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [tab]);
  // A link to a section: once its tab is showing, bring the section into view.
  useEffect(() => {
    if (!section) return;
    const id = window.requestAnimationFrame(() =>
      document.getElementById(asked)?.scrollIntoView({ block: "start" }),
    );
    return () => window.cancelAnimationFrame(id);
  }, [section, asked]);
  const open = (t: SettingsTab) => navigate({ hash: t === "general" ? "" : t }, { replace: true });
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.indexOf(tab);
    const next =
      e.key === "ArrowRight"
        ? (i + 1) % TABS.length
        : e.key === "ArrowLeft"
          ? (i - 1 + TABS.length) % TABS.length
          : -1;
    if (next < 0) return;
    e.preventDefault();
    open(TABS[next]!);
    tabRefs.current[next]?.focus();
  };

  return (
    <>
      <PageHeader eyebrow="Settings" title="Settings" />

      <div
        role="tablist"
        aria-label="Settings sections"
        onKeyDown={onKey}
        className="-mt-4 mb-10 flex gap-1 overflow-x-auto border-b border-line"
      >
        {TABS.map((t, i) => (
          <button
            key={t}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`settings-tab-${t}`}
            aria-selected={t === tab}
            aria-controls="settings-panel"
            tabIndex={t === tab ? 0 : -1}
            onClick={() => open(t)}
            className={cx(
              "relative min-h-11 shrink-0 scroll-mt-24 scroll-mx-4 px-3 text-[0.9rem] transition-colors",
              t === tab
                ? "text-gold after:absolute after:inset-x-2 after:bottom-0 after:h-[2px] after:rounded-full after:bg-gold"
                : "text-muted hover:text-ink",
            )}
          >
            {labels[t]}
          </button>
        ))}
      </div>

      <div className="-mt-6 mb-4 flex justify-end">
        <Button
          tone="quiet"
          onClick={() => {
            const next = !allOpen;
            setFoldDefault(next);
            setFold({ open: next, at: Date.now() });
          }}
          data-testid="settings-fold-all"
        >
          {allOpen ? "Close all" : "Open all"}
        </Button>
      </div>

      <FoldContext.Provider value={{ all: fold, tabs: TABS }}>
        <div
          role="tabpanel"
          id="settings-panel"
          aria-labelledby={`settings-tab-${tab}`}
          // A new #section link shows its section open (Section reads the address when it appears).
          key={hash || tab}
        >
          {tab === "devices" && <DevicesContent />}
          {tab === "general" && (
            <>
              <Section title="General">
                <div className="divide-y divide-line">
                  <Field
                    label="Support Hearth"
                    hint="Hearth is free. If it helps you, you can buy its maker a coffee."
                  >
                    <div className="sm:text-right">
                      <a
                        href={SUPPORT_URL}
                        target="_blank"
                        rel="noreferrer"
                        data-testid="support-hearth"
                        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-line-strong px-5 text-[0.85rem] font-medium tracking-wide text-ink transition-colors duration-200 hover:border-gold hover:text-gold"
                      >
                        ☕ Buy me a coffee
                      </a>
                    </div>
                  </Field>
                  <Field
                    label="This PC"
                    hint="Its name and icon mark its projects in the War Room and its systems everywhere."
                  >
                    <ThisPcField onEdit={() => open("devices")} />
                  </Field>
                  <Field label="Name" hint="Shown in notifications and the browser tab.">
                    {data ? (
                      <NameField current={data.instanceName} />
                    ) : (
                      <p className="text-[0.9rem] text-faint sm:text-right">Unavailable</p>
                    )}
                  </Field>
                  <Field
                    label="Your name"
                    hint="How your AI companion refers to you. Leave it empty and it says “you”."
                  >
                    {data ? (
                      <NameField
                        current={data.ownerName ?? ""}
                        field="ownerName"
                        label="Your name"
                        placeholder="Optional"
                      />
                    ) : (
                      <p className="text-[0.9rem] text-faint sm:text-right">Unavailable</p>
                    )}
                  </Field>
                  <Field
                    label="Your picture"
                    hint="Shown in your circle in conversations and beside your name. On a phone, the picker can open your Immich photos too."
                  >
                    <OwnerAvatarField />
                  </Field>
                  <Field
                    label="Pictures beside messages"
                    hint={`Your picture next to what you write, and ${aiName}'s next to its replies, in the Lair and the War Room. Turn off for more room.`}
                  >
                    <ChatPicturesSwitch />
                  </Field>
                  <Field
                    label="Screen captures"
                    wide
                    hint="Where the camera's Save puts them: a folder on the computer Hearth runs on, like /home/you/Pictures/Hearth or D:\Pictures\Hearth. Hearth makes it if it isn't there. Leave it empty to download them in the browser."
                  >
                    <CaptureFolderField />
                  </Field>
                  <Field
                    label="Open web UIs"
                    hint="Where “Open web UI” and a system’s logo take you: its reverse proxy address (like radarr.example.com) when it has one, or always its address on the host."
                  >
                    <WebUiVia />
                  </Field>
                  <Field
                    label="First-run setup"
                    hint="Connecting Ember's AI, then your name and picture, your AI's name, look, voice, and personality, and your theme, one step at a time."
                  >
                    <div className="sm:text-right">
                      <LinkButton to="/welcome?step=ai">Run the setup again</LinkButton>
                    </div>
                  </Field>
                  <Field label="Time zone" hint="Detected from this browser.">
                    <p className="text-[0.9rem] text-muted sm:text-right">
                      {Intl.DateTimeFormat().resolvedOptions().timeZone}
                    </p>
                  </Field>
                </div>
              </Section>

              <Section title="Getting started" collapsible="getting-started">
                <GettingStartedList settings />
                <MeetButton tone="outline" className="mt-4" label={`Meet ${aiName} again`} />
              </Section>

              <ThemePicker />
            </>
          )}
          {tab === "cave" && (
            <>
              <CaveSettings />
              <HomelabRules />
            </>
          )}
          {tab === "security" && (
            <>
              <SecuritySettings />
              <AccessKeysSection />
            </>
          )}
          {tab === "backups" && (
            <>
              <BackupsSection />
              <BlueprintSection />
            </>
          )}
          {tab === "monitoring" && (
            <>
              <MonitoringSettings />
              <ResourceHistorySettings />
              <RestartHistorySettings />
            </>
          )}
          {tab === "systems" && (
            <>
              <YourSystems />
              {data && (
                <Section title="Removed systems">
                  <RemovedSystems ws={data} />
                </Section>
              )}
              {showDemo && <DemoScenarios />}
            </>
          )}
          {tab === "premium" && <PremiumSettings />}
          {tab === "about" && (
            <>
              <Section title="Updates">
                <UpdatesSection />
              </Section>
              <Section title="Recent changes">
                <RecentChanges />
              </Section>
              <Section title="About">
                <About />
                {/* Who made the panel skins (the Premium package's credits). */}
                <AddonSlot name="about.credits" fallback={null} />
              </Section>
            </>
          )}
        </div>
      </FoldContext.Provider>
    </>
  );
}
