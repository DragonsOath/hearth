import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  BarChart3,
  ChevronRight,
  Clock,
  Database,
  FileText,
  FileVideo,
  FolderOpen,
  HardDrive,
  HeartPulse,
  Layers,
  MessageCircle,
  MoreHorizontal,
  RefreshCw,
  Route,
  Thermometer,
} from "lucide-react";
import {
  featuresOnStorage,
  type Blocker,
  type PhysicalDisk,
  type SmartReport,
  trend,
} from "@dragon-control/core";
import { api, useRefreshDisks } from "../../data/api";
import { ago, bytes, hoursAsDuration, tb } from "../../lib/format";
import { BlockerCard } from "../blockers/BlockerCard";
import { WorkspaceFrame, type TabDef } from "../command/WorkspaceFrame";
import { useCave } from "../shell/cave-context";
import { Button, Skeleton, cx } from "../ui";
import { CollectionCatalog } from "./CollectionCatalog";
import { FileManager, type FileRootInfo, type FileTarget } from "./FileManager";
import { ChangeCard, useConfirmedChange } from "../dashboards/ConfirmedChange";
import { RaidTab } from "./RaidTab";
import { PcPicker } from "./PcPicker";
import { usePcs } from "../../data/pcs";
import { StoragePc, onPc, useStoragePc } from "./pc";
import { useLiveQuery } from "../panels/lifecycle";
import { ToolImage } from "../panels/ToolImage";
import { EmberMark } from "../ember/EmberMark";

/**
 * Storage & Files (docs/design/STORAGE_CENTER.md, from HEARTH_STORAGE_RAID_MANAGEMENT_SPEC): a
 * Lair panel like a service's, for the homelab's storage, laid out from the owner's mockup.
 * Overview, Drives, Files (a file manager over this machine's drives), Recent activity, File
 * journeys, Volumes and arrays, Health and history. Read only: it shows what Hearth can actually
 * see, says where each fact came from, and offers the fix in place when something stands in the
 * way. It never invents a health percentage or calls a seeding download failed.
 */

type Tab =
  "overview" | "drives" | "files" | "recent" | "journeys" | "volumes" | "history" | "catalog";
const ic = "h-4 w-4";
const TABS: TabDef<Tab>[] = [
  { id: "overview", label: "Overview", icon: <BarChart3 className={ic} aria-hidden /> },
  { id: "drives", label: "Drives", icon: <HardDrive className={ic} aria-hidden /> },
  { id: "files", label: "Files", icon: <FolderOpen className={ic} aria-hidden /> },
  { id: "recent", label: "Recently Added", icon: <Clock className={ic} aria-hidden /> },
  { id: "journeys", label: "File Journeys", icon: <Route className={ic} aria-hidden /> },
  { id: "volumes", label: "RAID / Arrays", icon: <Layers className={ic} aria-hidden /> },
  { id: "history", label: "Health & History", icon: <HeartPulse className={ic} aria-hidden /> },
  { id: "catalog", label: "Collection PDF", icon: <FileText className={ic} aria-hidden /> },
];

interface LayoutNode {
  name: string;
  type: string;
  sizeBytes: number;
  rotational?: boolean;
  transport?: string;
  fstype?: string;
  mount?: string;
  model?: string;
  children: LayoutNode[];
}
interface JourneyEvent {
  at?: string;
  text: string;
  evidence: "confirmed" | "inferred";
  source: string;
}
type OpenAt = { rootId: string; folder: string; name: string };
interface PathRef {
  path: string;
  source: string;
  serviceId?: string;
  hostPath?: string;
  open?: OpenAt;
}
interface JourneyStep {
  key: "grabbed" | "download" | "import" | "library" | "media";
  label: string;
  state: "done" | "now" | "waiting" | "failed" | "unknown" | "skipped";
  at?: string;
  evidence: "confirmed" | "inferred" | "none";
  source?: string;
  detail?: string;
}
interface Journey {
  key: string;
  title: string;
  release?: string;
  outcome: string;
  stage: string;
  attention: boolean;
  problem?: string;
  stoppedAt?: string;
  steps: JourneyStep[];
  manager?: { app: string; serviceId: string };
  client?: { app: string; serviceId?: string; name?: string };
  source?: PathRef;
  destination?: PathRef;
  paths: (PathRef & { where: string })[];
  progressPct?: number;
  sizeBytes?: number;
  timeLeft?: string;
  seeding?: boolean;
  startedAt?: string;
  updatedAt?: string;
  queueId?: number;
  downloadId?: string;
  events: JourneyEvent[];
}
interface Center {
  checkedAt: string;
  hosts: {
    id: string;
    name: string;
    os: string;
    connection: string;
    health: string;
    lastSeenAt: string;
    local: boolean;
  }[];
  drives: PhysicalDisk[];
  smart?: Blocker;
  volumes: {
    id: string;
    hostId: string;
    label: string;
    mount: string;
    kind: string;
    totalTb: number;
    usedTb: number;
    history: { day: string; usedTb: number }[];
  }[];
  layout: { available: true; disks: LayoutNode[] } | { available: false; why: string };
  arrays: {
    found: { kind: string; name: string; state: string; detail: string }[];
    checked: {
      kind: string;
      seen: string;
      support?: "read" | "detect";
      verified?: "live" | "fixtures" | "none";
    }[];
  };
  locations: { id: string; hostId: string; label: string; path: string; source: string }[];
  roots: FileRootInfo[];
  /** Your names for drives, by mount ("/mnt/f" -> "Film"). */
  names: Record<string, string>;
  journeys: Journey[];
  journeyGaps: { name: string; why: string }[];
  findings: {
    id: string;
    title: string;
    severity: string;
    summary: string;
    at: string;
    analyzer: string;
  }[];
  incidents: { id: string; title: string; severity: string; status: string; openedAt: string }[];
  capabilities: {
    area: string;
    state: "available" | "partial" | "needs-approval" | "not-applicable" | "not-built";
    note: string;
  }[];
}

const STATE_WORD: Record<Center["capabilities"][number]["state"], string> = {
  available: "Available",
  partial: "Partly",
  "needs-approval": "Needs your OK",
  "not-applicable": "Not applicable here",
  "not-built": "Not built yet",
};
const STATE_TONE: Record<Center["capabilities"][number]["state"], string> = {
  available: "border-live/40 text-live",
  partial: "border-gold/40 text-gold",
  "needs-approval": "border-amber/50 text-amber",
  "not-applicable": "border-line-strong text-faint",
  "not-built": "border-line-strong text-muted",
};
const HEALTH_WORD: Record<PhysicalDisk["health"], string> = {
  healthy: "Healthy (the drive's own verdict)",
  warning: "Warning",
  failing: "Failing",
  unknown: "Not reported",
};
const HEALTH_TONE: Record<PhysicalDisk["health"], string> = {
  healthy: "text-live",
  warning: "text-amber",
  failing: "text-alert",
  unknown: "text-faint",
};

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="mb-1.5 text-[0.72rem] tracking-wide text-faint uppercase">{children}</p>;
}

/** A path on this machine with your drive name in front ("Film › New Releases/…"). */
function friendly(roots: FileRootInfo[], hostPath: string | undefined): string | undefined {
  if (!hostPath) return undefined;
  const r = roots
    .filter((x) => x.kind === "drive" && (hostPath === x.path || hostPath.startsWith(`${x.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!r || r.label === r.path) return hostPath;
  const rest = hostPath.slice(r.path.length).replace(/^\//, "");
  return rest ? `${r.label} › ${rest}` : r.label;
}

const toTarget = (o: OpenAt): FileTarget => ({
  rootId: o.rootId,
  folder: o.folder,
  highlight: o.name,
});

export function StorageCenterPanel({
  tab,
  onTab,
  onClose,
}: {
  tab: string | null;
  onTab: (t: string) => void;
  onClose: () => void;
}) {
  const current: Tab = TABS.some((t) => t.id === tab) ? (tab as Tab) : "overview";
  // The PC shown: "" is this one; a joined PC's drives and files are read on that PC.
  const [pc, setPc] = useState("");
  const q = useLiveQuery({
    queryKey: ["storage-center", pc],
    queryFn: () => api<Center>("GET", onPc(pc, "/api/storage-center")),
    refetchInterval: 120_000,
  });
  const [target, setTarget] = useState<FileTarget>();
  const openFolder = (t: FileTarget) => {
    setTarget(t);
    onTab("files");
  };
  const d = q.data;
  const local = d?.hosts.find((h) => h.local) ?? d?.hosts[0];
  const host = local;
  // Named as the PC picker names it (your name for the PC), else as the machine calls itself.
  const pcs = usePcs().data;
  const shownName = (pc ? pcs?.pcs.find((p) => p.id === pc) : pcs?.hub)?.name ?? host?.name;
  return (
    <WorkspaceFrame
      label="Storage & Files"
      testId="storage-center"
      icon={<ToolImage id="storage" />}
      title="Storage & Files"
      subtitle={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span>Drives, files, and recent activity{shownName ? ` on ${shownName}` : ""}.</span>
          <PcPicker
            value={pc}
            onChange={(next) => {
              setPc(next);
              setTarget(undefined);
            }}
          />
        </span>
      }
      tabs={TABS}
      tab={current}
      onTab={(t) => onTab(t)}
      onClose={onClose}
      capture={{ panel: "Storage & Files", tab: current }}
      help={featuresOnStorage(current).map((f) => f.id)}
    >
      <StoragePc.Provider value={pc}>
        {q.isLoading ? (
          <Skeleton className="h-64" />
        ) : q.error || !d ? (
          <div
            className="rounded-xl border border-amber/40 p-4 text-[0.88rem]"
            data-testid="storage-error"
          >
            <p className="text-amber">Storage could not be read right now.</p>
            <p className="mt-1 text-muted">{q.error?.message}</p>
          </div>
        ) : (
          <div className="@container space-y-5">
            {current === "overview" && (
              <Overview
                d={d}
                hostId={host?.id}
                hostName={host?.name}
                onTab={(t) => onTab(t)}
                onOpen={openFolder}
              />
            )}
            {current === "drives" && <Drives d={d} />}
            {current === "files" && (
              <FileManager roots={d.roots} hostName={local?.name} target={target} />
            )}
            {current === "recent" && <RecentlyAdded onOpen={openFolder} roots={d.roots} />}
            {current === "journeys" && <Journeys d={d} onOpen={openFolder} />}
            {current === "volumes" && (
              <RaidTab
                layout={
                  d.layout.available ? (
                    <LayoutTree nodes={d.layout.disks} names={d.names} />
                  ) : (
                    <p className="text-[0.84rem] text-muted">{d.layout.why}</p>
                  )
                }
              />
            )}
            {current === "history" && <History d={d} />}
            {current === "catalog" && <CollectionCatalog roots={d.roots} />}
            <p className="text-[0.74rem] text-faint">
              Read only · checked {ago(d.checkedAt)} ·{" "}
              <button
                type="button"
                className="text-gold underline-offset-2 hover:underline"
                onClick={() => void q.refetch()}
                data-testid="storage-recheck"
              >
                {q.isFetching ? "Checking…" : "Check again"}
              </button>
            </p>
          </div>
        )}
      </StoragePc.Provider>
    </WorkspaceFrame>
  );
}

// ------------------------------------------------------------------------------------------------

/** A drive's space: the volumes on it, matched by mount (Linux) or drive letter (Windows). */
function driveSpace(d: Center, x: PhysicalDisk) {
  const vols = d.volumes.filter(
    (v) =>
      v.hostId === x.hostId &&
      x.volumes.some((m) => v.mount === m || v.mount.toUpperCase().startsWith(m.toUpperCase())),
  );
  if (!vols.length) return undefined;
  return {
    used: vols.reduce((n, v) => n + v.usedTb, 0),
    total: vols.reduce((n, v) => n + v.totalTb, 0),
  };
}

function Section({
  title,
  icon,
  action,
  children,
  testId,
}: {
  title: string;
  icon: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="rounded-2xl border border-line bg-bg/40 p-3 @md:p-4" data-testid={testId}>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-gold" aria-hidden>
          {icon}
        </span>
        <h3 className="min-w-0 flex-1 text-[1rem] text-ink">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function ViewAll({ onClick, label = "View all" }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-line-strong px-3 text-[0.78rem] text-ink hover:border-gold hover:text-gold"
    >
      {label} <ChevronRight className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}

function Pill({
  tone,
  children,
}: {
  tone: "live" | "amber" | "alert" | "info" | "muted";
  children: ReactNode;
}) {
  const cls = {
    live: "border-live/40 bg-live/10 text-live",
    amber: "border-amber/50 bg-amber/10 text-amber",
    alert: "border-alert/50 bg-alert/10 text-alert",
    info: "border-gold/40 bg-gold/10 text-gold",
    muted: "border-line-strong text-muted",
  }[tone];
  return (
    <span
      className={cx(
        "fit-pill inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[0.74rem] whitespace-nowrap",
        cls,
      )}
    >
      {children}
    </span>
  );
}

const STAGE_PILL: Record<
  string,
  { tone: "live" | "amber" | "alert" | "info" | "muted"; text: string }
> = {
  downloading: { tone: "info", text: "Downloading" },
  queued: { tone: "muted", text: "Queued" },
  downloaded: { tone: "muted", text: "Downloaded" },
  "awaiting import": { tone: "info", text: "Waiting for import" },
  importing: { tone: "info", text: "Importing" },
  "import blocked": { tone: "alert", text: "Import blocked" },
  failed: { tone: "alert", text: "Failed" },
  imported: { tone: "live", text: "Imported" },
  "in plex": { tone: "live", text: "In Plex" },
};

type ActivityFilter = "all" | "downloads" | "imported" | "waiting" | "issues";
const inFilter = (j: Journey, f: ActivityFilter) =>
  f === "all"
    ? true
    : f === "issues"
      ? j.attention
      : f === "imported"
        ? j.stage === "imported" || j.stage === "in plex"
        : f === "waiting"
          ? j.stage === "awaiting import" || j.stage === "importing"
          : j.stage === "downloading" || j.stage === "queued" || j.stage === "downloaded";
const latestAt = (j: Journey) =>
  j.events
    .map((e) => e.at)
    .filter((x): x is string => Boolean(x))
    .sort()
    .at(-1);

function Overview({
  d,
  hostId,
  hostName,
  onTab,
  onOpen,
}: {
  d: Center;
  hostId?: string;
  hostName?: string;
  onTab: (t: Tab) => void;
  onOpen: (t: FileTarget) => void;
}) {
  const cave = useCave();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const drives = d.drives.filter((x) => !hostId || x.hostId === hostId);
  const volumes = d.volumes.filter((v) => !hostId || v.hostId === hostId);
  const counts = { healthy: 0, warning: 0, failing: 0, unknown: 0 };
  for (const x of drives) counts[x.health] += 1;
  // Volumes are separate mounts, so their sizes add up; drive sizes are never added on top.
  const total = volumes.reduce((n, v) => n + v.totalTb, 0);
  const used = volumes.reduce((n, v) => n + v.usedTb, 0);
  const temps = drives.map((x) => x.temperatureC).filter((t): t is number => t !== undefined);
  const attention = d.journeys.filter((j) => j.attention);
  const overall =
    counts.failing || d.incidents.some((i) => i.severity === "critical")
      ? {
          word: "Problem",
          tone: "text-alert",
          sub: "a drive is failing or a critical incident is open",
        }
      : counts.warning || d.incidents.length || attention.length
        ? {
            word: "Needs a look",
            tone: "text-amber",
            sub: [
              counts.warning && `${counts.warning} drive warning`,
              d.incidents.length && `${d.incidents.length} open incidents`,
              attention.length && `${attention.length} downloads or imports`,
            ]
              .filter(Boolean)
              .join(", "),
          }
        : counts.unknown === drives.length && drives.length
          ? {
              word: "Not reported",
              tone: "text-faint",
              sub: "the drives share no health verdict here",
            }
          : { word: "Healthy", tone: "text-live", sub: "no warnings or open incidents" };
  const activity = d.journeys.filter((j) => inFilter(j, filter));
  const chips: { id: ActivityFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "downloads", label: "Downloads" },
    { id: "imported", label: "Imported" },
    { id: "waiting", label: "Waiting" },
    { id: "issues", label: "Issues" },
  ];
  const operations = d.journeys.filter(
    (j) => (j.stage === "downloading" || j.stage === "importing") && j.progressPct !== undefined,
  );
  return (
    <div className="space-y-4" data-testid="storage-overview">
      <Section
        title="Storage overview"
        icon={<HardDrive className="h-5 w-5" />}
        testId="storage-summary"
      >
        <div className="grid grid-cols-2 gap-3 @lg:grid-cols-4">
          <div className="flex gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line-strong text-muted">
              <HardDrive className="h-5 w-5" aria-hidden />
            </span>
            <div className="text-[0.78rem]">
              <p className="text-[1.3rem] text-ink tabular">{drives.length}</p>
              <p className="text-muted">Physical drives</p>
              {counts.healthy > 0 && <p className="text-live">● {counts.healthy} healthy</p>}
              {counts.warning > 0 && <p className="text-amber">● {counts.warning} warning</p>}
              {counts.failing > 0 && <p className="text-alert">● {counts.failing} failing</p>}
              {counts.unknown > 0 && <p className="text-faint">● {counts.unknown} not reported</p>}
            </div>
          </div>
          <div className="flex gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line-strong text-muted">
              <Database className="h-5 w-5" aria-hidden />
            </span>
            <div className="text-[0.78rem]">
              <p className="text-[1.3rem] text-ink tabular">{total ? tb(total) : "None"}</p>
              <p className="text-muted">Total capacity</p>
              {total > 0 && <p className="text-gold">● {tb(used)} used</p>}
              {total > 0 && <p className="text-faint">● {tb(Math.max(0, total - used))} free</p>}
            </div>
          </div>
          <div className="flex gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line-strong text-muted">
              <Activity className="h-5 w-5" aria-hidden />
            </span>
            <div className="text-[0.78rem]">
              <p className={cx("text-[1.3rem]", overall.tone)} data-testid="storage-overall">
                {overall.word}
              </p>
              <p className="text-muted">Overall status</p>
              <p className="text-faint">{overall.sub}</p>
            </div>
          </div>
          <div className="flex gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line-strong text-muted">
              <Thermometer className="h-5 w-5" aria-hidden />
            </span>
            <div className="text-[0.78rem]">
              <p
                className={cx(
                  "text-[1.3rem] text-ink tabular",
                  Math.max(0, ...temps) >= 55 && "text-amber",
                )}
              >
                {temps.length
                  ? `${Math.round(temps.reduce((a, b) => a + b, 0) / temps.length)}°C`
                  : "Not shared"}
              </p>
              <p className="text-muted">Average temperature</p>
              {temps.length > 0 ? (
                <>
                  <p className="text-faint">
                    Min {Math.round(Math.min(...temps))}°C · Max {Math.round(Math.max(...temps))}°C
                  </p>
                  <p className="text-faint">
                    {temps.length} of {drives.length} drives report it
                  </p>
                </>
              ) : (
                <p className="text-faint">needs SMART access</p>
              )}
            </div>
          </div>
        </div>
      </Section>

      <Section
        title="Drives"
        icon={<HardDrive className="h-5 w-5" />}
        action={<ViewAll onClick={() => onTab("drives")} />}
        testId="storage-overview-drives"
      >
        <ul className="divide-y divide-line">
          {drives.map((x) => {
            const space = driveSpace(d, x);
            const p =
              space && space.total ? Math.round((space.used / space.total) * 100) : undefined;
            return (
              <li key={x.id}>
                <button
                  type="button"
                  onClick={() => onTab("drives")}
                  className="grid w-full grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 py-2 text-left @lg:grid-cols-[minmax(0,1.4fr)_auto_auto_minmax(0,1fr)_auto]"
                  data-testid="storage-overview-drive"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line-strong text-muted">
                      <HardDrive className="h-4 w-4" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[0.88rem] text-ink">
                        {driveName(x, d.names)}
                      </span>
                      {driveName(x, d.names) !== x.model && (
                        <span className="block truncate text-[0.74rem] text-faint">
                          {x.model} · {x.volumes.join(", ")}
                        </span>
                      )}
                      <span className="block text-[0.76rem] text-faint">
                        {x.type === "ssd" ? "SSD" : x.type === "hdd" ? "HDD" : "Drive"} · {x.bus}
                      </span>
                    </span>
                  </span>
                  <Pill
                    tone={
                      x.health === "healthy"
                        ? "live"
                        : x.health === "warning"
                          ? "amber"
                          : x.health === "failing"
                            ? "alert"
                            : "muted"
                    }
                  >
                    {x.health === "healthy"
                      ? "Healthy"
                      : x.health === "warning"
                        ? "Warning"
                        : x.health === "failing"
                          ? "Failing"
                          : "Not reported"}
                  </Pill>
                  <span
                    className={cx(
                      "text-[0.8rem] tabular",
                      (x.temperatureC ?? 0) >= 55 ? "text-amber" : "text-muted",
                    )}
                  >
                    <Thermometer className="mr-0.5 inline h-3.5 w-3.5" aria-hidden />
                    {x.temperatureC !== undefined ? `${Math.round(x.temperatureC)}°C` : "n/a"}
                  </span>
                  <span className="col-span-2 flex items-center gap-2 @lg:col-span-1">
                    {p !== undefined ? (
                      <>
                        <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-line">
                          <span
                            className={cx(
                              "block h-full rounded-full",
                              p >= 90 ? "bg-alert" : p >= 80 ? "bg-amber" : "bg-gold/80",
                            )}
                            style={{ width: `${p}%` }}
                          />
                        </span>
                        <span className="text-[0.78rem] whitespace-nowrap text-muted tabular">
                          {tb(space!.used)} / {tb(space!.total)}
                        </span>
                      </>
                    ) : (
                      <span className="text-[0.78rem] text-faint">
                        {tb(x.sizeTb)} · no mounted volume
                      </span>
                    )}
                  </span>
                  <ChevronRight className="hidden h-4 w-4 text-faint @lg:block" aria-hidden />
                </button>
              </li>
            );
          })}
          {!drives.length && (
            <li className="py-2 text-[0.84rem] text-muted">No drives read on this machine yet.</li>
          )}
        </ul>
      </Section>

      <Section
        title="Recent file activity"
        icon={<Clock className="h-5 w-5" />}
        action={<ViewAll onClick={() => onTab("journeys")} />}
        testId="storage-overview-activity"
      >
        <div className="mb-2 flex flex-wrap gap-2" role="group" aria-label="Show">
          {chips.map((c) => {
            const n = d.journeys.filter((j) => inFilter(j, c.id)).length;
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={filter === c.id}
                onClick={() => setFilter(c.id)}
                className={cx(
                  "min-h-9 rounded-lg border px-3 text-[0.78rem]",
                  filter === c.id
                    ? "border-gold bg-gold/10 text-gold"
                    : c.id === "issues" && n
                      ? "border-alert/40 text-alert"
                      : "border-line text-muted hover:text-ink",
                )}
              >
                {c.label} ({n})
              </button>
            );
          })}
        </div>
        <ul className="divide-y divide-line">
          {activity.slice(0, 8).map((j) => {
            const pill = STAGE_PILL[j.stage] ?? { tone: "muted" as const, text: j.stage };
            const at = latestAt(j);
            const where = j.paths[0];
            return (
              <li
                key={j.key}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2 @2xl:grid-cols-[minmax(0,1.7fr)_7rem_10rem_5rem_5.5rem_2.25rem]"
                data-testid="storage-overview-activity-row"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span
                    className={cx(
                      "grid h-9 w-9 shrink-0 place-items-center rounded-lg border",
                      j.attention ? "border-alert/40 text-alert" : "border-line-strong text-gold",
                    )}
                  >
                    <FileVideo className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[0.86rem] text-ink">
                      {j.release ?? j.title}
                    </span>
                    <span className="block truncate text-[0.74rem] text-faint">
                      {friendly(d.roots, where?.hostPath) ??
                        where?.path ??
                        (j.release ? j.title : "")}
                    </span>
                  </span>
                </span>
                <span className="hidden truncate text-[0.8rem] text-muted @2xl:block">
                  {j.client?.name ?? j.client?.app ?? j.manager?.app ?? ""}
                </span>
                <Pill tone={j.attention ? "alert" : pill.tone}>
                  {pill.text}
                  {j.stage === "downloading" && j.progressPct !== undefined
                    ? ` ${j.progressPct}%`
                    : ""}
                </Pill>
                <span className="hidden text-[0.8rem] text-muted tabular @2xl:block">
                  {j.sizeBytes !== undefined ? bytes(j.sizeBytes) : ""}
                </span>
                <span className="hidden text-[0.76rem] whitespace-nowrap text-faint @2xl:block">
                  {at ? ago(at) : ""}
                </span>
                <RowMenu
                  label={j.title}
                  items={[
                    ...(where?.open
                      ? [{ label: "Open in folder", run: () => onOpen(toTarget(where.open!)) }]
                      : []),
                    { label: "See its journey", run: () => onTab("journeys") },
                    {
                      label: "Ask Ember about it",
                      ember: true,
                      run: () =>
                        cave.ask(
                          `"${j.title}" is at "${j.stage}" in Hearth's Storage panel${j.problem ? `: ${j.problem}` : ""}.${where ? ` Its files: ${where.hostPath ?? where.path}.` : ""} What is going on with it? Investigate only.`,
                        ),
                    },
                  ]}
                />
              </li>
            );
          })}
          {!activity.length && (
            <li className="py-2 text-[0.84rem] text-muted">
              {d.journeys.length
                ? "Nothing in this group."
                : "No downloads or imports reported right now."}
            </li>
          )}
        </ul>
        {d.journeyGaps.length > 0 && (
          <p className="mt-2 text-[0.76rem] text-amber">
            Not read just now: {d.journeyGaps.map((g) => g.name).join(", ")}.
          </p>
        )}
      </Section>

      <Section
        title="File explorer"
        icon={<FolderOpen className="h-5 w-5" />}
        testId="storage-overview-files"
      >
        <FileManager
          roots={d.roots}
          {...(hostName ? { hostName } : {})}
          compact
          onOpenFull={(t) => onOpen(t)}
        />
      </Section>

      <Section
        title="Current storage operations"
        icon={<Database className="h-5 w-5" />}
        testId="storage-overview-operations"
      >
        {operations.length ? (
          <ul className="space-y-3">
            {operations.slice(0, 5).map((j) => (
              <li
                key={j.key}
                className="grid items-center gap-2 rounded-xl border border-line p-3 @lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[0.9rem] text-ink">{j.title}</span>
                  <span className="block text-[0.78rem] text-muted">
                    {j.stage === "importing"
                      ? `Importing by ${j.manager?.app ?? "its manager"}`
                      : `Downloading in ${j.client?.name ?? j.client?.app ?? "its client"}`}
                  </span>
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-line">
                      <span
                        className="block h-full rounded-full bg-gold"
                        style={{ width: `${j.progressPct}%` }}
                      />
                    </span>
                    <span className="text-[0.84rem] text-ink tabular">{j.progressPct}%</span>
                  </span>
                  <span className="text-[0.74rem] text-faint">
                    {j.timeLeft ? `About ${j.timeLeft} left, as the app reports it` : ""}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label={`${j.title}: its journey`}
                  onClick={() => onTab("journeys")}
                  className="hidden text-faint hover:text-gold @lg:block"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[0.84rem] text-muted">
            Nothing running right now. Downloads, imports, scrubs, parity checks, and rebuilds show
            here while they run.
          </p>
        )}
      </Section>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
          onClick={() =>
            cave.ask(
              `Look over my storage in Hearth's Storage & Files panel: ${drives.length} drives, ${volumes.length} volumes (${tb(used)} of ${tb(total)} used), ${attention.length} downloads or imports needing a look, ${d.findings.length} storage findings. What matters most, and what would you check first? Investigate only; change nothing.`,
            )
          }
          data-testid="storage-ask"
        >
          <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask Ember about my storage
          <EmberMark />
        </button>
        <ViewAll label="What this panel can do here" onClick={() => onTab("history")} />
      </div>
      <p className="text-[0.76rem] text-faint">
        RAID and pools keep a drive failure from taking data offline. They are not a backup.
      </p>
    </div>
  );
}

function RowMenu({
  label,
  items,
}: {
  label: string;
  /** `ember`: the item starts Ember (it carries the Ember mark). */
  items: { label: string; run: () => void; ember?: boolean }[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <button
        type="button"
        aria-label={`More for ${label}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-raised hover:text-ink"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <span
          role="menu"
          className="absolute right-0 z-20 mt-1 flex min-w-44 flex-col rounded-lg border border-line-strong bg-panel p-1 shadow-xl"
          onMouseLeave={() => setOpen(false)}
        >
          {items.map((i) => (
            <button
              key={i.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                i.run();
              }}
              className="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-[0.82rem] text-ink hover:bg-raised"
            >
              {i.label}
              {i.ember && <EmberMark />}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

function Capabilities({ d, compact }: { d: Center; compact?: boolean }) {
  return (
    <ul
      className={cx("grid gap-2", !compact && "@lg:grid-cols-2")}
      data-testid="storage-capabilities"
    >
      {d.capabilities.map((c) => (
        <li key={c.area} className="rounded-lg border border-line p-2.5 text-[0.82rem]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-ink">{c.area}</span>
            <span
              className={cx(
                "fit-pill rounded-full border px-2 py-0.5 text-[0.7rem]",
                STATE_TONE[c.state],
              )}
            >
              {STATE_WORD[c.state]}
            </span>
          </div>
          {!compact && <p className="mt-1 text-muted">{c.note}</p>}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------------------------------------

/** A drive's name ("Film") with its real mount beside it, renamed in place. Display only. */
function VolumeName({
  mount,
  names,
  editable,
}: {
  mount: string;
  names: Record<string, string>;
  editable?: boolean;
}) {
  const qc = useQueryClient();
  const name = names[mount];
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name ?? "");
  const [error, setError] = useState<string>();
  const pc = useStoragePc();
  const save = async (next: string | null) => {
    setError(undefined);
    try {
      await api("PUT", onPc(pc, "/api/storage-center/names"), { mount, name: next });
      setEditing(false);
      await qc.invalidateQueries({ queryKey: ["storage-center"] });
      await qc.invalidateQueries({ queryKey: ["files"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  if (editing)
    return (
      <form
        className="inline-flex flex-wrap items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void save(value.trim() || null);
        }}
      >
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={`Name for ${mount}`}
          placeholder="Name"
          autoFocus
          className="min-h-8 w-36 rounded-md border border-line-strong bg-raised px-2 text-[0.82rem] text-ink"
          data-testid="volume-name-input"
        />
        <button type="submit" className="text-[0.78rem] text-gold hover:underline">
          Save
        </button>
        {name && (
          <button
            type="button"
            className="text-[0.78rem] text-muted hover:underline"
            onClick={() => void save(null)}
          >
            Clear
          </button>
        )}
        <button
          type="button"
          className="text-[0.78rem] text-muted hover:underline"
          onClick={() => setEditing(false)}
        >
          Cancel
        </button>
        {error && <span className="text-[0.76rem] text-amber">{error}</span>}
      </form>
    );
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5" data-testid="volume-name">
      <span className="text-ink">{name ?? mount}</span>
      {name && <span className="text-[0.74rem] text-faint">{mount}</span>}
      {editable && (
        <button
          type="button"
          aria-label={`Rename ${name ?? mount}`}
          className="text-[0.74rem] text-gold hover:underline"
          onClick={() => {
            setValue(name ?? "");
            setEditing(true);
          }}
          data-testid="volume-rename"
        >
          {name ? "Rename" : "Name it"}
        </button>
      )}
    </span>
  );
}

const SMART_TONE: Record<SmartReport["verdict"], string> = {
  healthy: "text-live",
  warning: "text-amber",
  failing: "text-alert",
  unknown: "text-muted",
};
const SMART_WORD: Record<SmartReport["verdict"], string> = {
  healthy: "Healthy by its own figures",
  warning: "Worth watching",
  failing: "Failing: back it up now",
  unknown: "Not known",
};

/** The drive's own SMART report (read through the elevated executor), behind a disclosure. */
function SmartDetail({ r }: { r: SmartReport }) {
  return (
    <details
      className="rounded-lg border border-line bg-raised/40 px-2.5 py-2"
      data-testid="drive-smart"
    >
      <summary className="cursor-pointer text-[0.8rem] text-ink">
        Drive's own health report (SMART):{" "}
        <span className={SMART_TONE[r.verdict]}>
          {r.unavailable
            ? r.asleep
              ? "asleep, not woken"
              : "not readable"
            : SMART_WORD[r.verdict]}
        </span>
      </summary>
      <div className="mt-2 space-y-2 text-[0.78rem]">
        {r.unavailable && <p className="text-muted">{r.unavailable}</p>}
        {r.reasons.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-4 text-amber">
            {r.reasons.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        )}
        {r.attributes.length > 0 && (
          <table className="w-full text-left">
            <thead className="text-faint">
              <tr>
                <th className="font-normal">Measure</th>
                <th className="text-right font-normal">Value</th>
              </tr>
            </thead>
            <tbody>
              {r.attributes.map((a) => (
                <tr key={`${a.id}-${a.name}`} className={a.attention ? "text-amber" : "text-ink"}>
                  <td>{a.name}</td>
                  <td className="text-right tabular-nums">{a.value.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5">
          {r.lastSelfTest && (
            <>
              <dt className="text-faint">Last self-test</dt>
              <dd className={r.lastSelfTest.passed ? "text-ink" : "text-amber"}>
                {r.lastSelfTest.kind}: {r.lastSelfTest.result}
              </dd>
            </>
          )}
          {r.powerCycles !== undefined && (
            <>
              <dt className="text-faint">Power cycles</dt>
              <dd className="text-ink">{r.powerCycles.toLocaleString()}</dd>
            </>
          )}
          {r.firmware && (
            <>
              <dt className="text-faint">Firmware</dt>
              <dd className="text-ink">{r.firmware}</dd>
            </>
          )}
        </dl>
        <p className="text-faint">
          {r.device}
          {r.via ? `, ${r.via}` : ""}, read {ago(r.readAt)} through Hearth's elevated executor (read
          only).
        </p>
      </div>
    </details>
  );
}

/** A drive by your name for it ("Film"); the system drive says so; otherwise its model. */
function driveName(x: PhysicalDisk, names: Record<string, string>): string {
  const mine = x.volumes.map((m) => names[m.replace(/[\\/]+$/, "") || m]).filter(Boolean);
  if (mine.length) return mine.join(", ");
  if (x.volumes.some((m) => m === "/" || /^[A-Z]:\\?$/i.test(m))) return "System drive";
  return x.model;
}

function Drives({ d }: { d: Center }) {
  const refresh = useRefreshDisks();
  const qc = useQueryClient();
  const cave = useCave();
  const hostName = (id: string) => d.hosts.find((h) => h.id === id)?.name ?? id;
  const pc = useStoragePc();
  const smart = useQuery({
    queryKey: ["storage-center", "smart", pc],
    queryFn: () =>
      api<{ reports: SmartReport[]; blocker?: Blocker }>(
        "GET",
        onPc(pc, "/api/storage-center/smart"),
      ),
    staleTime: 5 * 60_000,
  });
  const reportOf = (x: PhysicalDisk) =>
    smart.data?.reports.find((r) => r.mounts?.some((m) => x.volumes.includes(m)));
  const blocker = smart.data ? smart.data.blocker : d.smart;
  return (
    <div className="space-y-4" data-testid="storage-drives">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-[0.82rem] text-muted">
          Each drive's own health verdict and what the system shares. Hard drives have no single
          health percentage, so none is shown.
        </p>
        <Button
          tone="outline"
          disabled={refresh.isPending}
          onClick={() =>
            refresh.mutate(undefined, {
              onSettled: async () => {
                await api("GET", onPc(pc, "/api/storage-center/smart?refresh=1")).catch(
                  () => undefined,
                );
                await qc.invalidateQueries({ queryKey: ["storage-center"] });
              },
            })
          }
          data-testid="storage-drives-refresh"
        >
          <RefreshCw className="h-4 w-4" /> {refresh.isPending ? "Reading…" : "Read drives again"}
        </Button>
      </div>
      {blocker && <BlockerCard blocker={blocker} serviceName="Storage" />}
      {d.drives.length === 0 ? (
        <p className="text-[0.86rem] text-muted">No drives read yet. Read drives to see them.</p>
      ) : (
        <ul className="grid gap-3 @lg:grid-cols-2">
          {d.drives.map((x) => (
            <li
              key={x.id}
              className="space-y-2 rounded-xl border border-line bg-bg/40 p-3"
              data-testid="storage-drive"
            >
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span
                  className="min-w-0 flex-1 break-words text-[0.92rem] text-ink"
                  data-testid="storage-drive-name"
                >
                  {driveName(x, d.names)}
                </span>
                <span className="text-[0.76rem] text-faint">{hostName(x.hostId)}</span>
              </div>
              <p className="-mt-1 text-[0.74rem] break-words text-faint">
                {x.model}
                {x.volumes.length ? ` · ${x.volumes.join(", ")}` : ""}
              </p>
              <p className={cx("text-[0.84rem]", HEALTH_TONE[x.health])}>{HEALTH_WORD[x.health]}</p>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[0.8rem]">
                <dt className="text-faint">Type</dt>
                <dd className="text-ink">
                  {x.type === "ssd"
                    ? "Solid state"
                    : x.type === "hdd"
                      ? "Hard drive"
                      : "Not reported"}
                </dd>
                <dt className="text-faint">Connection</dt>
                <dd className="text-ink">{x.bus}</dd>
                <dt className="text-faint">Size</dt>
                <dd className="text-ink">{tb(x.sizeTb)}</dd>
                <dt className="text-faint">Temperature</dt>
                <dd className={cx("text-ink", (x.temperatureC ?? 0) >= 55 && "text-amber")}>
                  {x.temperatureC !== undefined ? `${Math.round(x.temperatureC)}°C` : "Not shared"}
                </dd>
                <dt className="text-faint">Powered on</dt>
                <dd className="text-ink">
                  {x.powerOnHours !== undefined ? hoursAsDuration(x.powerOnHours) : "Not shared"}
                </dd>
                {x.type === "ssd" && (
                  <>
                    <dt className="text-faint">Rated life used</dt>
                    <dd className="text-ink">
                      {x.wearPct !== undefined
                        ? `${x.wearPct}% (the SSD's own figure)`
                        : "Not shared"}
                    </dd>
                  </>
                )}
                <dt className="text-faint">Read and write errors</dt>
                <dd
                  className={cx(
                    "text-ink",
                    (x.readErrors ?? 0) + (x.writeErrors ?? 0) > 0 && "text-amber",
                  )}
                >
                  {x.readErrors !== undefined || x.writeErrors !== undefined
                    ? `${x.readErrors ?? 0} read, ${x.writeErrors ?? 0} write`
                    : "Not shared"}
                </dd>
                <dt className="text-faint">Holds</dt>
                <dd className="break-all text-ink">
                  {x.volumes.length ? (
                    <span className="flex flex-col gap-0.5">
                      {x.volumes.map((m) => (
                        <VolumeName key={m} mount={m} names={d.names} editable />
                      ))}
                    </span>
                  ) : (
                    "No mounted volume"
                  )}
                </dd>
              </dl>
              {x.limitation && <p className="text-[0.76rem] text-faint">{x.limitation}</p>}
              {reportOf(x) && <SmartDetail r={reportOf(x)!} />}
              <div className="flex flex-wrap items-center gap-2 text-[0.74rem] text-faint">
                <span>Read {ago(x.checkedAt)}</span>
                <button
                  type="button"
                  className="text-gold hover:underline"
                  onClick={() =>
                    cave.ask(
                      `Tell me about my ${driveName(x, d.names)} drive (${x.model}, ${tb(x.sizeTb)}, ${x.bus}) in Hearth's Storage panel: its health verdict is "${x.health}"${x.temperatureC !== undefined ? `, ${Math.round(x.temperatureC)}°C` : ""}. What does that mean, what can't Hearth see yet, and should I worry? Investigate only.`,
                    )
                  }
                >
                  Ask Ember
                  <EmberMark />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------

interface AddedFile {
  name: string;
  path: string;
  folder: string;
  drive: string;
  sizeBytes: number;
  kind: "video" | "audio" | "book" | "image" | "subtitle" | "other";
  addedAt: string;
  basis: "observed" | "timestamp";
  modifiedAt: string;
  partial: boolean;
  goneAt?: string;
  movedFrom?: string;
  place?: { path: string; label: string; role: "library" | "downloads"; apps: string[] };
  open?: OpenAt;
  seenAfter?: string;
  sameFileAs?: string[];
}
interface Added {
  files: AddedFile[];
  total: number;
  indexed: number;
  last?: {
    at: string;
    tookMs: number;
    files: number;
    added: number;
    gone: number;
    complete: boolean;
  };
}

/**
 * Recently Added: every new file on this machine's drives, newest first, with its full path,
 * size, the folder it landed in (a library folder your apps use, or a download folder), and Open
 * in folder. Request a movie, it downloads, Radarr renames it into New Releases: it shows here
 * under "In your library", and the seeding copy under "Downloads".
 */
const clock = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });

/** When a file arrived, honestly: seen arriving (and in what window), or already there. */
function arrival(f: AddedFile): { main: string; sub?: string } {
  if (f.basis === "timestamp")
    return {
      main: "Before Hearth was watching",
      sub: `file date ${ago(f.modifiedAt)}`,
    };
  if (f.seenAfter) {
    const gap = Date.parse(f.addedAt) - Date.parse(f.seenAfter);
    return gap > 30 * 60_000
      ? {
          main: `Arrived between ${clock(f.seenAfter)} and ${clock(f.addedAt)}`,
          sub: "Hearth was not checking in between",
        }
      : {
          main: `Arrived ${ago(f.addedAt)}`,
          sub: `between ${clock(f.seenAfter)} and ${clock(f.addedAt)}`,
        };
  }
  return { main: `Arrived ${ago(f.addedAt)}` };
}

function RecentlyAdded({
  onOpen,
  roots,
}: {
  onOpen: (t: FileTarget) => void;
  roots: FileRootInfo[];
}) {
  const cave = useCave();
  const qc = useQueryClient();
  const [role, setRole] = useState<"library" | "downloads" | "all">("library");
  const [days, setDays] = useState(7);
  const [kind, setKind] = useState("all");
  const [find, setFind] = useState("");
  const [gone, setGone] = useState(false);
  const [before, setBefore] = useState(false);
  const query = new URLSearchParams({
    ...(before ? { arrivals: "all" } : {}),
    days: String(days),
    kind,
    role,
    q: find.trim(),
    ...(gone ? { gone: "1" } : {}),
  }).toString();
  const pc = useStoragePc();
  const q = useLiveQuery({
    queryKey: ["storage-center", "added", query, pc],
    queryFn: () => api<Added>("GET", onPc(pc, `/api/storage-center/added?${query}`)),
    refetchInterval: 120_000,
  });
  const [checking, setChecking] = useState(false);
  const checkNow = async () => {
    setChecking(true);
    try {
      await api("POST", onPc(pc, "/api/storage-center/added/refresh"));
      await qc.invalidateQueries({ queryKey: ["storage-center", "added"] });
    } finally {
      setChecking(false);
    }
  };
  const roles: { id: typeof role; label: string }[] = [
    { id: "library", label: "In your library" },
    { id: "downloads", label: "Downloads" },
    { id: "all", label: "Everything" },
  ];
  const d = q.data;
  return (
    <div className="space-y-3" data-testid="storage-added">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Where">
          {roles.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={role === r.id}
              onClick={() => setRole(r.id)}
              className={cx(
                "min-h-9 rounded-lg border px-3 text-[0.8rem]",
                role === r.id
                  ? "border-gold bg-gold/10 text-gold"
                  : "border-line text-muted hover:text-ink",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          aria-label="Added within"
          className="min-h-9 rounded-lg border border-line bg-raised px-2 text-[0.82rem] text-ink"
        >
          <option value={1}>Last day</option>
          <option value={3}>Last 3 days</option>
          <option value={7}>Last week</option>
          <option value={30}>Last month</option>
          <option value={90}>Last 3 months</option>
        </select>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          aria-label="Kind of file"
          className="min-h-9 rounded-lg border border-line bg-raised px-2 text-[0.82rem] text-ink"
        >
          <option value="all">All files</option>
          <option value="video">Video</option>
          <option value="audio">Audio</option>
          <option value="book">Books</option>
          <option value="image">Images</option>
          <option value="subtitle">Subtitles</option>
          <option value="other">Other</option>
        </select>
        <input
          value={find}
          onChange={(e) => setFind(e.target.value)}
          aria-label="Find by name or folder"
          placeholder="Find by name or folder"
          className="min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-raised px-3 text-[0.84rem] text-ink"
        />
        <Button
          tone="outline"
          disabled={checking}
          onClick={() => void checkNow()}
          data-testid="storage-added-check"
        >
          <RefreshCw className={cx("h-4 w-4", checking && "animate-spin")} />{" "}
          {checking ? "Checking…" : "Check now"}
        </Button>
      </div>
      {q.isLoading ? (
        <Skeleton className="h-48" />
      ) : q.error || !d ? (
        <p className="text-[0.84rem] text-amber">{q.error?.message}</p>
      ) : (
        <>
          <div className="hidden grid-cols-[minmax(0,1fr)_9rem_6rem_7.5rem_7.5rem] gap-3 border-b border-line px-2 pb-1.5 text-[0.74rem] text-faint @3xl:grid">
            <span>Name and path</span>
            <span>Where</span>
            <span>Size</span>
            <span>Added</span>
            <span />
          </div>
          <ul className="divide-y divide-line/60">
            {d.files.map((f) => (
              <li
                key={f.path}
                className={cx(
                  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-2 py-2 text-[0.84rem] @3xl:grid-cols-[minmax(0,1fr)_9rem_6rem_7.5rem_7.5rem]",
                  f.goneAt && "opacity-60",
                )}
                data-testid="storage-added-file"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <FileVideo
                    className={cx(
                      "h-4 w-4 shrink-0",
                      f.kind === "video" ? "text-rose-400" : "text-muted",
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-ink">
                      {f.name}
                      {f.partial && <span className="text-amber"> · still downloading</span>}
                      {f.goneAt && <span className="text-faint"> · moved or deleted</span>}
                    </span>
                    <span className="block truncate text-[0.74rem] text-faint" title={f.path}>
                      {friendly(roots, f.path) ?? f.path}
                    </span>
                    {f.movedFrom && (
                      <span className="block truncate text-[0.72rem] text-faint">
                        {/\.(!qb|part|partial|crdownload|tmp)$/i.test(f.movedFrom)
                          ? "finished downloading"
                          : `moved here from ${friendly(roots, f.movedFrom) ?? f.movedFrom}`}
                      </span>
                    )}
                    {f.sameFileAs?.length ? (
                      <span className="block truncate text-[0.72rem] text-faint">
                        same file as {friendly(roots, f.sameFileAs[0]) ?? f.sameFileAs[0]} (a
                        hardlink: no extra space)
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="hidden @3xl:block">
                  {f.place ? (
                    <Pill tone={f.place.role === "library" ? "live" : "info"}>{f.place.label}</Pill>
                  ) : (
                    <span className="text-[0.78rem] text-faint">{f.drive}</span>
                  )}
                </span>
                <span className="hidden text-muted tabular @3xl:block">{bytes(f.sizeBytes)}</span>
                <span
                  className="hidden text-[0.8rem] text-muted @3xl:block"
                  title={
                    f.basis === "timestamp"
                      ? "It was already there when Hearth first looked; this is its own date."
                      : "When Hearth saw it arrive."
                  }
                >
                  {arrival(f).main}
                  {arrival(f).sub && (
                    <span className="block text-[0.72rem] text-faint">{arrival(f).sub}</span>
                  )}
                </span>
                <span className="flex items-center justify-end gap-1">
                  {f.open && (
                    <button
                      type="button"
                      className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-line-strong px-2 text-[0.76rem] text-ink hover:border-gold hover:text-gold"
                      onClick={() => onOpen(toTarget(f.open!))}
                      data-testid="storage-added-open"
                    >
                      <FolderOpen className="h-3.5 w-3.5" aria-hidden /> Open in folder
                    </button>
                  )}
                  <RowMenu
                    label={f.name}
                    items={[
                      {
                        label: "Copy path",
                        run: () => void navigator.clipboard?.writeText(f.path),
                      },
                      {
                        label: "Ask Ember about it",
                        ember: true,
                        run: () =>
                          cave.ask(
                            `A new file appeared on my drives: ${f.path} (${bytes(f.sizeBytes)}, ${f.place ? `in ${f.place.label}, used by ${f.place.apps.join(" and ")}` : f.drive}). Has Plex picked it up, and is anything wrong with it? Investigate only.`,
                          ),
                      },
                    ]}
                  />
                </span>
              </li>
            ))}
            {!d.files.length && (
              <li className="px-2 py-3 text-[0.86rem] text-muted">
                {d.indexed
                  ? before
                    ? "Nothing here in this time."
                    : "No new files seen arriving in this time. Files that were already there when Hearth started watching are left out; tick the box below to include them by their file date."
                  : "Hearth has not looked at the drives yet. It does every ten minutes; press Check now to look straight away."}
              </li>
            )}
          </ul>
          <p className="text-[0.74rem] text-faint">
            {d.total > d.files.length ? `Showing ${d.files.length} of ${d.total}. ` : ""}
            {d.indexed.toLocaleString()} files on the drives known
            {d.last
              ? `; last checked ${ago(d.last.at)} in ${Math.round(d.last.tookMs / 100) / 10} s${d.last.complete ? "" : " (stopped early)"}`
              : ""}
            . Checked every ten minutes, reading names and sizes only.{" "}
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={gone} onChange={(e) => setGone(e.target.checked)} />
              Show moved and deleted
            </label>{" "}
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={before}
                onChange={(e) => setBefore(e.target.checked)}
                data-testid="storage-added-before"
              />
              Include files already there when Hearth started watching (by their file date)
            </label>
          </p>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------

const OUTCOME_GROUPS: { id: string; label: string; test: (j: Journey) => boolean }[] = [
  { id: "attention", label: "Needs a look", test: (j) => j.attention },
  {
    id: "waiting",
    label: "Waiting or in progress",
    test: (j) =>
      !j.attention && ["waiting", "importing", "downloading", "queued"].includes(j.outcome),
  },
  { id: "done", label: "Done", test: (j) => ["imported", "in plex"].includes(j.outcome) },
  { id: "downloads", label: "Downloads only", test: (j) => !j.manager },
  { id: "all", label: "All", test: () => true },
];

const STEP_TONE: Record<JourneyStep["state"], string> = {
  done: "border-live/50 bg-live/10 text-live",
  now: "border-gold/60 bg-gold/10 text-gold",
  waiting: "border-amber/50 bg-amber/10 text-amber",
  failed: "border-alert/50 bg-alert/10 text-alert",
  unknown: "border-line-strong text-faint",
  skipped: "border-line text-faint opacity-60",
};
const STEP_MARK: Record<JourneyStep["state"], string> = {
  done: "✓",
  now: "…",
  waiting: "⏸",
  failed: "!",
  unknown: "?",
  skipped: "–",
};

function JourneyPath({
  label,
  r,
  roots,
  onOpen,
}: {
  label: string;
  r: PathRef;
  roots: FileRootInfo[];
  onOpen: (t: FileTarget) => void;
}) {
  const nice = friendly(roots, r.hostPath);
  return (
    <div className="min-w-0 text-[0.78rem]">
      <p className="text-faint">{label}</p>
      <p className="break-all text-ink" title={r.hostPath ?? r.path}>
        {nice ?? r.path}
      </p>
      <p className="break-all text-faint">
        {r.hostPath ? `${r.hostPath} · ` : ""}
        {r.source} calls it {r.path}
      </p>
      {r.open && (
        <button
          type="button"
          className="mt-0.5 inline-flex items-center gap-1 text-gold hover:underline"
          onClick={() => onOpen(toTarget(r.open!))}
          data-testid="journey-open"
        >
          <FolderOpen className="h-3.5 w-3.5" aria-hidden /> Open in folder
        </button>
      )}
    </div>
  );
}

function JourneyCard({
  j,
  roots,
  onOpen,
}: {
  j: Journey;
  roots: FileRootInfo[];
  onOpen: (t: FileTarget) => void;
}) {
  const cave = useCave();
  const [open, setOpen] = useState(j.attention);
  const fix = useConfirmedChange(j.manager?.serviceId ?? "");
  const canImport =
    j.manager && j.queueId !== undefined && ["waiting", "blocked"].includes(j.outcome);
  const evidence = j.steps
    .filter((s) => s.evidence !== "none" || s.state !== "skipped")
    .map(
      (s) =>
        `${s.label}: ${s.state}${s.evidence !== "none" ? ` (${s.evidence}${s.source ? `, ${s.source}` : ""})` : ""}${s.at ? ` at ${s.at}` : ""}${s.detail ? `. ${s.detail}` : ""}`,
    )
    .join("\n");
  return (
    <li
      className={cx(
        "rounded-xl border p-3 text-[0.84rem]",
        j.attention ? "border-amber/50" : "border-line",
      )}
      data-testid="storage-journey"
    >
      <button
        type="button"
        className="flex w-full flex-wrap items-baseline gap-x-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="min-w-0 flex-1 break-words text-ink">{j.title}</span>
        <Pill
          tone={
            j.attention
              ? "alert"
              : j.outcome === "in plex" || j.outcome === "imported"
                ? "live"
                : j.outcome === "waiting"
                  ? "amber"
                  : "info"
          }
        >
          {j.outcome === "in plex" ? "In Plex" : j.stage[0]!.toUpperCase() + j.stage.slice(1)}
          {j.outcome === "downloading" && j.progressPct !== undefined ? ` ${j.progressPct}%` : ""}
        </Pill>
        {j.updatedAt && <span className="text-[0.74rem] text-faint">{ago(j.updatedAt)}</span>}
        <ChevronRight
          className={cx("h-4 w-4 text-faint transition-transform", open && "rotate-90")}
          aria-hidden
        />
      </button>
      {/* The steps at a glance */}
      <ol className="mt-2 flex flex-wrap items-center gap-1" aria-label="Steps">
        {j.steps.map((s, i) => (
          <li key={s.key} className="flex items-center gap-1">
            {i > 0 && <span className="h-px w-3 bg-line-strong" aria-hidden />}
            <span
              className={cx(
                "fit-pill inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.72rem]",
                STEP_TONE[s.state],
              )}
              title={s.detail}
              data-testid="journey-step"
              data-state={s.state}
            >
              <span aria-hidden>{STEP_MARK[s.state]}</span> {s.label}
            </span>
          </li>
        ))}
      </ol>
      {j.problem && <p className="mt-1.5 text-amber">{j.problem}</p>}
      {j.stoppedAt && !j.attention && j.outcome !== "imported" && (
        <p className="mt-1 text-[0.76rem] text-faint">Stopped at: {j.stoppedAt}</p>
      )}
      {open && (
        <div className="mt-3 space-y-3" data-testid="journey-detail">
          {j.release && <p className="text-[0.76rem] break-all text-faint">{j.release}</p>}
          {(j.source || j.destination) && (
            <div className="grid gap-3 @lg:grid-cols-2">
              {j.source && (
                <JourneyPath
                  label={j.seeding ? "Download (still seeding)" : "Download"}
                  r={j.source}
                  roots={roots}
                  onOpen={onOpen}
                />
              )}
              {j.destination && (
                <JourneyPath
                  label="In the library"
                  r={j.destination}
                  roots={roots}
                  onOpen={onOpen}
                />
              )}
            </div>
          )}
          <ol className="space-y-1 border-l border-line pl-3 text-[0.78rem]">
            {j.steps.map((s) => (
              <li key={s.key} className="text-muted">
                <span className="text-ink">{s.label}</span>{" "}
                {s.evidence === "confirmed" ? (
                  <span className="text-live">confirmed</span>
                ) : s.evidence === "inferred" ? (
                  <span className="text-gold">inferred</span>
                ) : (
                  <span className="text-faint">
                    {s.state === "skipped" ? "not reached" : "not known"}
                  </span>
                )}
                {s.source ? <span className="text-faint"> · {s.source}</span> : null}
                {s.at ? <span className="text-faint"> · {ago(s.at)}</span> : null}
                {s.detail ? <span className="block text-faint">{s.detail}</span> : null}
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            {canImport && (
              <Button
                tone="primary"
                disabled={fix.busy}
                onClick={() =>
                  void fix.propose(
                    "app-arr-import",
                    { queueId: j.queueId! },
                    `Import ${j.title} in ${j.manager!.app}`,
                  )
                }
                data-testid="journey-import"
              >
                Import it in {j.manager!.app}
              </Button>
            )}
            <button
              type="button"
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
              onClick={() =>
                cave.ask(
                  `Investigate this file journey in Hearth's Storage panel and tell me what happened and what you would do. Change nothing until I approve it.\n\nTitle: ${j.title}${j.release ? `\nRelease: ${j.release}` : ""}${j.downloadId ? `\nDownload id: ${j.downloadId}` : ""}\nWhere it got to: ${j.outcome}${j.stoppedAt ? ` (stopped at ${j.stoppedAt})` : ""}${j.problem ? `\nProblem: ${j.problem}` : ""}${j.source ? `\nDownload: ${j.source.hostPath ?? j.source.path} (${j.source.source} calls it ${j.source.path})` : ""}${j.destination ? `\nLibrary: ${j.destination.hostPath ?? j.destination.path}` : ""}\nSteps:\n${evidence}`,
                )
              }
              data-testid="journey-ask"
            >
              <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask Ember to investigate
              <EmberMark />
            </button>
          </div>
          <ChangeCard c={fix} />
        </div>
      )}
    </li>
  );
}

function Journeys({ d, onOpen }: { d: Center; onOpen: (t: FileTarget) => void }) {
  const [group, setGroup] = useState(d.journeys.some((j) => j.attention) ? "attention" : "all");
  const [find, setFind] = useState("");
  const f = find.trim().toLowerCase();
  const g = OUTCOME_GROUPS.find((x) => x.id === group) ?? OUTCOME_GROUPS.at(-1)!;
  const shown = d.journeys.filter(
    (j) =>
      g.test(j) &&
      (!f ||
        `${j.title} ${j.release ?? ""} ${j.source?.hostPath ?? ""} ${j.destination?.hostPath ?? ""}`
          .toLowerCase()
          .includes(f)),
  );
  return (
    <div className="space-y-3" data-testid="storage-journeys">
      <p className="text-[0.82rem] text-muted">
        Each download from the grab to Plex, from Radarr, Sonarr, qBittorrent, SABnzbd, and Plex's
        own records. Confirmed means an app said so; inferred means Hearth worked it out from two
        reports. A download left in the downloads folder after its import is still seeding or a
        copy, not failed.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
          {OUTCOME_GROUPS.map((x) => (
            <button
              key={x.id}
              type="button"
              aria-pressed={group === x.id}
              onClick={() => setGroup(x.id)}
              className={cx(
                "min-h-9 rounded-lg border px-3 text-[0.78rem]",
                group === x.id
                  ? "border-gold bg-gold/10 text-gold"
                  : "border-line text-muted hover:text-ink",
              )}
            >
              {x.label} ({d.journeys.filter(x.test).length})
            </button>
          ))}
        </div>
        <input
          value={find}
          onChange={(e) => setFind(e.target.value)}
          aria-label="Find a title, release, or path"
          placeholder="Find a title, release, or path"
          className="min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-raised px-3 text-[0.84rem] text-ink"
        />
      </div>
      {d.journeyGaps.length > 0 && (
        <p className="text-[0.8rem] text-amber" data-testid="storage-journey-gaps">
          Not read just now: {d.journeyGaps.map((x) => `${x.name} (${x.why})`).join("; ")}. Journeys
          through them may be missing or incomplete.
        </p>
      )}
      <ul className="space-y-2">
        {shown.map((j) => (
          <JourneyCard key={j.key} j={j} roots={d.roots} onOpen={onOpen} />
        ))}
        {!shown.length && (
          <li className="text-[0.86rem] text-muted">
            {d.journeys.length
              ? "Nothing in this group."
              : "No downloads or imports in the last two weeks."}
          </li>
        )}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------

function LayoutTree({
  nodes,
  names,
  depth = 0,
}: {
  nodes: LayoutNode[];
  names: Record<string, string>;
  depth?: number;
}) {
  return (
    <ul className={cx("space-y-1", depth > 0 && "mt-1 border-l border-line pl-3")}>
      {nodes.map((n) => (
        <li key={n.name} className="text-[0.82rem]">
          <span className="text-ink">{n.type === "disk" ? (n.model ?? n.name) : n.name}</span>{" "}
          <span className="text-faint">
            {n.type} · {bytes(n.sizeBytes)}
            {n.transport ? ` · ${n.transport.toUpperCase()}` : ""}
            {n.rotational !== undefined && n.type === "disk"
              ? n.rotational
                ? " · spinning"
                : " · solid state"
              : ""}
            {n.fstype ? ` · ${n.fstype}` : ""}
          </span>
          {n.mount && (
            <span className="text-gold">
              {" "}
              → {names[n.mount] ? `${names[n.mount]} (${n.mount})` : n.mount}
            </span>
          )}
          {n.children.length > 0 && (
            <LayoutTree nodes={n.children} names={names} depth={depth + 1} />
          )}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------------------------------------

const TREND_TONE = { fine: "text-muted", watch: "text-amber", alert: "text-alert" } as const;

/** Space used over time, plotted by date (a missing day is a gap), with the drive's size above. */
function Growth({ v, names }: { v: Center["volumes"][number]; names: Record<string, string> }) {
  const t = trend(v.history, v.totalTb, v.usedTb);
  const name = names[v.mount] ?? v.mount;
  const pts = v.history;
  const W = 300;
  const H = 64;
  const first = pts[0] ? Date.parse(`${pts[0].day}T00:00:00Z`) : 0;
  const last = pts.at(-1) ? Date.parse(`${pts.at(-1)!.day}T00:00:00Z`) : 0;
  const span = Math.max(last - first, 86_400_000);
  const top = Math.max(v.totalTb, ...pts.map((p) => p.usedTb), 0.001);
  const x = (day: string) => ((Date.parse(`${day}T00:00:00Z`) - first) / span) * W;
  const y = (tbUsed: number) => H - (tbUsed / top) * H;
  // Consecutive days join; a gap of more than a day breaks the line.
  const runs: (typeof pts)[] = [];
  for (const p of pts) {
    const prev = runs.at(-1)?.at(-1);
    if (prev && Date.parse(p.day) - Date.parse(prev.day) <= 86_400_000) runs.at(-1)!.push(p);
    else runs.push([p]);
  }
  const date = (day: string) =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  return (
    <div data-testid="storage-growth">
      <div className="flex flex-wrap items-baseline gap-x-3 text-[0.82rem]">
        <span className="min-w-0 flex-1 break-all text-ink">
          {name}
          {names[v.mount] && <span className="text-[0.74rem] text-faint"> {v.mount}</span>}
        </span>
        <span className="text-faint">
          {tb(v.usedTb)} of {tb(v.totalTb)} used
        </span>
      </div>
      {pts.length >= 2 && (
        <figure className="mt-1">
          <svg
            viewBox={`-2 -4 ${W + 4} ${H + 8}`}
            className="h-16 w-full overflow-visible"
            preserveAspectRatio="none"
            role="img"
            aria-label={`${name}: space used from ${date(pts[0]!.day)} to ${date(pts.at(-1)!.day)}. ${t.words}`}
          >
            <line
              x1={0}
              x2={W}
              y1={y(v.totalTb)}
              y2={y(v.totalTb)}
              className="stroke-line-strong"
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
            {runs.map((r) => (
              <polyline
                key={r[0]!.day}
                points={r.map((p) => `${x(p.day)},${y(p.usedTb)}`).join(" ")}
                fill="none"
                className="stroke-gold"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {pts.map((p) => (
              <circle key={p.day} cx={x(p.day)} cy={y(p.usedTb)} r={1.6} className="fill-gold">
                <title>{`${date(p.day)}: ${tb(p.usedTb)} used`}</title>
              </circle>
            ))}
          </svg>
          <figcaption className="flex justify-between text-[0.7rem] text-faint">
            <span>{date(pts[0]!.day)}</span>
            <span>dashed: the drive's size</span>
            <span>{date(pts.at(-1)!.day)}</span>
          </figcaption>
        </figure>
      )}
      <p className={cx("text-[0.76rem]", TREND_TONE[t.tone])} data-testid="storage-trend">
        {t.words}
      </p>
    </div>
  );
}

function History({ d }: { d: Center }) {
  return (
    <div className="space-y-5" data-testid="storage-history">
      <div>
        <Eyebrow>Open incidents and findings</Eyebrow>
        {d.incidents.length + d.findings.length === 0 ? (
          <p className="text-[0.84rem] text-muted">Nothing open about storage.</p>
        ) : (
          <ul className="space-y-1.5 text-[0.84rem]">
            {d.incidents.map((i) => (
              <li key={i.id}>
                <span className={i.severity === "critical" ? "text-alert" : "text-amber"}>
                  {i.title}
                </span>{" "}
                <span className="text-faint">
                  · incident, {i.status}, opened {ago(i.openedAt)}
                </span>
              </li>
            ))}
            {d.findings.map((f) => (
              <li key={f.id}>
                <span className="text-ink">{f.title}</span>{" "}
                <span className="text-faint">· {f.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <Eyebrow>Space over time</Eyebrow>
        <div className="space-y-3">
          {d.volumes.map((v) => (
            <Growth key={v.id} v={v} names={d.names} />
          ))}
        </div>
      </div>
      <details className="rounded-xl border border-line p-3" data-testid="storage-about">
        <summary className="cursor-pointer text-[0.82rem] text-muted">
          About this panel: what works here and what is not built yet
        </summary>
        <div className="mt-3">
          <Capabilities d={d} />
        </div>
      </details>
    </div>
  );
}
