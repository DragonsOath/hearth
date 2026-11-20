/**
 * The Hearth domain model, shared by the server (persistence, API)
 * and the web app (rendering). Timestamps are ISO 8601 strings.
 */

import type { ActionKind, Requester } from "./policy";
import type { AppReport } from "./apps";

export type Health = "healthy" | "attention" | "offline";
export type Autonomy = "monitor" | "diagnose" | "ask" | "auto";
export type Severity = "info" | "warning" | "critical";
export type IsoTime = string;

export const AUTONOMY_LEVELS: readonly Autonomy[] = ["monitor", "diagnose", "ask", "auto"];

/** High-impact operations that stay outside Auto Fix whatever the settings say. */
export const GUARDRAILS: readonly string[] = [
  "Deleting files in bulk",
  "Formatting or repartitioning drives",
  "Changing accounts, passwords, or keys",
  "Opening ports or exposing services to the internet",
];

export interface Volume {
  id: string;
  hostId: string;
  label: string;
  mount: string;
  kind: "ssd" | "hdd" | "nas" | "disk";
  totalTb: number;
  usedTb: number;
  smart: "ok" | "warning";
}

export interface Host {
  id: string;
  name: string;
  role: string;
  os: string;
  address: string;
  cpu: { model: string; cores: number; usagePct: number };
  memory: { totalGb: number; usedGb: number };
  uptimeHours: number;
  /** this-machine: Hearth runs here. network: another machine, checked over the network only. */
  connection: "this-machine" | "agent" | "network";
  /** On another PC in your Hearth (docs/design/ONE_ACCOUNT.md): that PC's id. */
  pcId?: string;
  docker: boolean;
  health: Health;
  lastSeenAt: IsoTime;
  volumes: Volume[];
}

export type ServiceCategory =
  "Media" | "Automation" | "Downloads" | "Network" | "Home" | "Files & Photos" | "System";

export interface Service {
  id: string;
  name: string;
  /** Set when it is not watched: paused (off on purpose for now) or retired (replaced or removed). */
  lifecycle?: "paused" | "retired";
  /** Why, in the owner's words ("Replaced by Seerr 3.5.0"). */
  lifecycleNote?: string;
  lifecycleAt?: IsoTime;
  category: ServiceCategory;
  hostId: string;
  /** On another PC in your Hearth (docs/design/ONE_ACCOUNT.md): that PC's id. */
  pcId?: string;
  kind: "container" | "process" | "web";
  image?: string;
  /** The Docker container's name, for containers on the machine Hearth watches. */
  container?: string;
  /** Its container was stopped on request: not checked or repaired until it is started. */
  stopped?: { at: IsoTime; by: string };
  /** A reverse proxy, VPN, DNS, or Docker access container: Hearth never stops it. */
  coreNetworking?: boolean;
  version?: string;
  /** Web interface on the local network, when the service has one. */
  localUrl?: string;
  /** Address reachable through a reverse proxy, without scheme (e.g. "watch.example.com"). */
  publicUrl?: string;
  /** The reverse proxy service that publishes publicUrl, when known. */
  proxyServiceId?: string;
  health: Health;
  responseMs?: number;
  /** Measured availability over 30 days; absent until monitoring has history. */
  uptimePct?: number;
  dependsOn: string[];
  /** Which autonomy rule governs this service. */
  autonomyArea: string;
  /** Effective level after applying the area rule and the default. */
  autonomy: Autonomy;
  /** The most recent monitoring check, once monitoring has run. */
  lastCheck?: {
    status: "ok" | "slow" | "failing";
    detail: string;
    at: IsoTime;
    consecutiveFailures: number;
  };
  note?: string;
}

/** A system you removed from Hearth: only what Settings needs to bring it back. */
export interface RemovedService {
  id: string;
  name: string;
  category: ServiceCategory;
  hostId: string;
  kind: Service["kind"];
  /** The container name or web address it was watched by, when it had one. */
  address?: string;
  removedAt?: IsoTime;
}

/** What kind of system you add by hand: a Docker container, an app with a web address, or other. */
export type ManualSystemKind = "container" | "web" | "other";

export const SERVICE_CATEGORIES: readonly ServiceCategory[] = [
  "Media",
  "Automation",
  "Downloads",
  "Network",
  "Home",
  "Files & Photos",
  "System",
];

/** A system you add yourself, when discovery missed it. */
export interface ManualSystemInput {
  name: string;
  kind: ManualSystemKind;
  /** The container's name for a container; a web address for a web app (optional for other). */
  address: string;
  category: ServiceCategory;
  /** Which machine it is on. Defaults to the machine Hearth runs on. */
  hostId?: string;
}

export type TimelineKind =
  "detected" | "check" | "action" | "agent" | "approval" | "resolved" | "notified" | "escalated";

export interface TimelineEntry {
  at: IsoTime;
  kind: TimelineKind;
  text: string;
}

export type IncidentStatus = "open" | "awaiting-approval" | "approved" | "resolved";

export interface Incident {
  id: string;
  title: string;
  serviceId?: string;
  hostId?: string;
  severity: Severity;
  status: IncidentStatus;
  openedAt: IsoTime;
  resolvedAt?: IsoTime;
  summary: string;
  resolution?: string;
  /** "recovered": the problem went away on its own before anything was done. */
  handledBy: "runbook" | "agent" | "you" | "pending" | "recovered";
  proposedAction?: string;
  /** Present while a proposal awaits approval: approving must send the fingerprint back. */
  approval?: ApprovalTicket;
  timeline: TimelineEntry[];
}

/**
 * Binds an approval to one exact proposal. Any change to the proposal makes
 * a new fingerprint; after expiresAt it can no longer be approved.
 */
export interface ApprovalTicket {
  fingerprint: string;
  expiresAt: IsoTime;
}

/** A job waiting for your decision, as Home and the nav count it. */
export interface PendingJob {
  id: string;
  title: string;
  requestedBy: Requester;
  createdAt: IsoTime;
  expiresAt?: IsoTime;
  steps: number;
}

/** A meaningful observation, shown as recent activity. */
export interface Activity {
  id: string;
  at: IsoTime;
  tone: "good" | "neutral" | "attention";
  text: string;
  incidentId?: string;
}

export interface AgentProvider {
  id: string;
  name: string;
  description: string;
  status: "connected" | "available" | "coming-later";
  detail?: string;
}

export interface AgentSession {
  id: string;
  at: IsoTime;
  incidentId?: string;
  conversationId?: string;
  provider?: string;
  summary: string;
  outcome: "resolved" | "proposed" | "escalated";
}

export interface NotificationChannel {
  id: string;
  name: string;
  status: "configured" | "available";
  detail?: string;
  /** False for channels listed as coming later. */
  supported?: boolean;
  /** Non-secret settings, for editing. Secrets stay in the vault. */
  config?: Record<string, string | number | boolean>;
  /** The kind of channel (discord, email...); the id for the built-in ones. */
  kind?: string;
  /** False while switched off (kept, nothing sent). */
  enabled?: boolean;
  /** "public": friends and family; only media announcements go there. */
  audience?: "private" | "public";
  /** A destination you added (it can be deleted, not just stopped). */
  added?: boolean;
  /**
   * Its last delivery was turned away for good (11-13: a Discord webhook deleted in Discord):
   * nothing reaches it until it is changed. A later delivery that works clears it.
   */
  broken?: { reason: string; at: string };
}

/** Route ids that a friends-and-family ("public") destination may receive. */
export const PUBLIC_ROUTES: readonly string[] = ["media-arrivals"];

/** One notification: sent, held for quiet hours, or failed. */
export interface NotificationLogEntry {
  id: number;
  at: IsoTime;
  event: string;
  incidentId?: string;
  channelId: string;
  title: string;
  status: "sent" | "held" | "failed";
  error?: string;
}

export interface NotificationRoute {
  id: string;
  event: string;
  description: string;
  channels: string[];
}

export interface Integration {
  id: string;
  name: string;
  category: ServiceCategory | "Infrastructure";
  description: string;
  status: "connected" | "discovered" | "available";
  instances?: number;
}

/** A container's state read live from Docker (read only), for the service workspace. */
export interface ServiceRuntime {
  available: boolean;
  /** Why nothing could be read (sample data, not a container, another machine, Docker down). */
  reason?: string;
  at: IsoTime;
  running?: boolean;
  startedAt?: IsoTime;
  restartCount?: number;
  /** Published ports, "host -> container/protocol". */
  ports?: string[];
  cpuPct?: number;
  memoryMb?: number;
  memoryLimitMb?: number;
}

/** One action requested of Hearth, and what came of it. */
export interface ActionRecord {
  id: string;
  kind: ActionKind;
  /** Plain words: "Restart the Jellyfin container". */
  label: string;
  serviceId: string;
  incidentId?: string;
  requestedBy: Requester;
  /** "requested": waiting for your approval. */
  status: "requested" | "refused" | "running" | "succeeded" | "failed";
  requestedAt: IsoTime;
  completedAt?: IsoTime;
  /** What happened, in plain words. */
  result?: string;
}

export interface AutonomyRule {
  id: string;
  label: string;
  description: string;
  level: Autonomy | "default";
}

export interface AuditRecord {
  id: number;
  at: IsoTime;
  actor: "you" | "dragon-control" | "agent";
  action: string;
  target: string;
  detail?: Record<string, unknown>;
}

export type DemoScenario = "calm" | "attention" | "fresh";
export const DEMO_SCENARIOS: readonly DemoScenario[] = ["calm", "attention", "fresh"];

/** The look of Hearth: a built-in theme, or your own two colors. */
export const THEME_PRESETS = [
  "hearth",
  "sapphire",
  "dragon-gold",
  "ember",
  "verdant",
  "custom",
] as const;
export type ThemePreset = (typeof THEME_PRESETS)[number];
export interface ThemeChoice {
  preset: ThemePreset;
  /** Custom only: the main color (buttons, highlights, focus), as #rrggbb. */
  primary?: string;
  /** Custom only: the color the backgrounds and panels are tinted with, as #rrggbb. */
  secondary?: string;
  /** Headings in a classic serif or a modern sans; absent means the theme's own. */
  headings?: "classic" | "modern";
  /** How service panels look (PANEL_LOOKS); absent means minimal, the plain look. */
  panels?: PanelLook;
}

/**
 * How service panels look: each service's own colors and artwork with Hearth's controls
 * ("service"), Hearth's own ember artwork on every panel ("hearth"), or the plain dark panel
 * ("minimal", the default). Decoration only: the panels work the same in every look.
 */
export const PANEL_LOOKS = ["minimal", "service", "hearth"] as const;
export type PanelLook = (typeof PANEL_LOOKS)[number];

export interface Workspace {
  instanceName: string;
  /**
   * Where "Open web UI" and a system's logo take you: its reverse proxy address when it has one
   * ("proxy", the default), or always its address on the host ("host").
   */
  webUiVia: "proxy" | "host";
  /** When you finished or skipped the first-run welcome ("Meet your AI"), if you have. */
  onboardingDoneAt?: string;
  /** The welcome's first choice: help building a first homelab, or an existing one. */
  journey?: "build" | "existing";
  /** The welcome step reached last, so closing the browser resumes there ("ai", "voice"...). */
  onboardingStep?: string;
  /**
   * Take the owner to the welcome: a newly claimed installation that has not finished or skipped
   * it, with none of the owner's own choices saved yet. Never true for an existing install.
   */
  onboardingNeeded: boolean;
  /** Your homelab rules: the do-not-touch list and reservations (Settings > Homelab rules). */
  rules: import("./profile").HomelabRules;
  /** The theme you chose; absent means the default (Hearth). A choice you made is always kept. */
  theme?: ThemeChoice;
  /**
   * The look on phones (11-16, the owner: "if you want your desktop to look a certain way, you
   * can also have your mobile layout in a different scheme"); absent means the same as `theme`.
   */
  phoneTheme?: ThemeChoice;
  /**
   * The Lair's systems in your order (Arrange), the same on every device you sign in from
   * (11-16, the owner: "the panels on mobile should be in the same order as the ones on the
   * desktop"); absent means most used first.
   */
  lairOrder?: string[];
  /** How often each system was opened in the Lair, from every device, for most used first. */
  lairUsage?: Record<string, { s: number; at: number }>;
  /** How companions refer to the owner; absent means "you". */
  ownerName?: string;
  /** When the owner's picture was set, if there is one (GET /api/owner/avatar). */
  ownerAvatarAt?: string;
  /**
   * The name you gave your AI administrator ("Warden"); absent means Ember (DEFAULT_AI_NAME),
   * whichever voice or look is in use. A display name only: the same assistant, conversations,
   * memory, permissions, and history.
   */
  aiName?: string;
  /** The AI's default pictures: Ember's flame, or the classic characters (installs from before Hearth). */
  aiLookStyle: import("./voice").LookStyle;
  /** When your AI's own picture was set, if there is one (AI_AVATAR_PATH). */
  aiAvatarAt?: string;
  quietHours: boolean;
  /** Sample data, your discovered systems, or nothing yet. */
  environment: "demo" | "real" | "empty";
  /** The sample scenario shown, when environment is "demo". */
  demoScenario: DemoScenario | null;
  /** When your systems were last discovered, when environment is "real". */
  discoveredAt?: IsoTime;
  hosts: Host[];
  /** Watched services. Paused and retired ones are in `inactiveServices`. */
  services: Service[];
  inactiveServices: Service[];
  /**
   * Systems you removed from Hearth. They are hidden everywhere else and
   * never watched; the real container or app is untouched. Settings can bring one back.
   */
  removedServices: RemovedService[];
  incidents: Incident[];
  activity: Activity[];
  agents: AgentProvider[];
  agentSessions: AgentSession[];
  channels: NotificationChannel[];
  routes: NotificationRoute[];
  integrations: Integration[];
  autonomyDefault: Autonomy;
  autonomyRules: AutonomyRule[];
  guardrails: readonly string[];
  storageLocations: StorageLocation[];
  disks: PhysicalDisk[];
  monitoring: MonitoringStatus;
  /** Recent actions, newest first. */
  actions: ActionRecord[];
  /** What Hearth read inside the apps it understands (M9), one per app. */
  apps: AppReport[];
  /** Jobs waiting for your approval, oldest first (details at /api/jobs/:id). */
  pendingJobs: PendingJob[];
  /** Automatic repairs may run on your real systems (sample data and test containers always may). */
  liveRepairs: boolean;
  /** Your picture and the AI's beside each message in conversations (Settings, on by default). */
  chatPictures: boolean;
  /** Recent notifications, newest first. */
  notifications: NotificationLogEntry[];
  /** The connected AI operator, and whether unresolved incidents are handed to it. */
  operator: { agentId?: string; escalate: boolean };
}

/** How Hearth is watching, shown in Settings and used by the UI to refresh. */
export interface MonitoringStatus {
  intervalSec: number;
  /** Consecutive failed checks before an incident opens. */
  failureThreshold: number;
  lastRunAt?: IsoTime;
  /** Simulated failures are active (sample data only). */
  simulated: string[];
}

/** The level that actually applies to an area: its own override, else the default. */
export function effectiveAutonomy(
  area: string,
  rules: Pick<AutonomyRule, "id" | "level">[],
  fallback: Autonomy,
): Autonomy {
  const rule = rules.find((r) => r.id === area);
  return !rule || rule.level === "default" ? fallback : rule.level;
}

/** Incidents still in progress; "approved" is waiting on Hearth, not on you. */
export function isOpen(incident: Pick<Incident, "status">): boolean {
  return incident.status !== "resolved";
}

export function needsYou(incident: Pick<Incident, "status">): boolean {
  return incident.status === "open" || incident.status === "awaiting-approval";
}

/* ---------- Discovery ---------- */

/** What a discovery scan found, before you decide what to adopt. Nothing here is saved. */
export interface DiscoveryReport {
  id: string;
  scannedAt: IsoTime;
  durationMs: number;
  host: Omit<Host, "health" | "lastSeenAt">;
  docker: { available: boolean; version?: string; endpoint?: string; error?: string };
  /** Physical drives behind the host's volumes. */
  disks: PhysicalDisk[];
  findings: DiscoveryFinding[];
  /** Non-fatal problems, phrased for people ("Docker did not answer..."). */
  notes: string[];
}

export type FindingGroup = "recognised" | "unrecognised-web" | "supporting" | "stopped";

export interface DiscoveryFinding {
  /** Stable key for this finding, e.g. "container:prowlarr". */
  key: string;
  source: "container" | "process";
  /** Container or process name as the system reports it. */
  sourceName: string;
  image?: string;
  composeProject?: string;
  state: "running" | "stopped" | "restarting" | "paused";
  health: Health;
  group: FindingGroup;
  /** Suggested identity; recognised from the catalogue or a placeholder to rename. */
  name: string;
  category: ServiceCategory;
  autonomyArea: string;
  recognised: boolean;
  localUrl?: string;
  /** Published only on loopback, so reachable from this machine alone. */
  localOnly: boolean;
  ports: string[];
  /** Keys of other findings this one depends on (network provider, compose depends_on). */
  dependsOn: string[];
  /** Plain-language reason for the suggestion. */
  reason: string;
  selectedByDefault: boolean;
  /** You removed this from Hearth; a scan never adds it back. */
  removed?: boolean;
}

export interface AdoptSelection {
  key: string;
  name: string;
}

/* ---------- Storage browsing (read only) ---------- */

/** A folder you chose to watch. Only watched folders can be browsed. */
export interface StorageLocation {
  id: string;
  hostId: string;
  label: string;
  /** Absolute path as the host writes it, e.g. "E:\Movies" or "/mnt/tank/movies". */
  path: string;
  /** "demo" locations are sample data with a made-up folder tree. */
  source: "fs" | "demo";
  addedAt: IsoTime;
}

export interface FileEntry {
  name: string;
  /** Path relative to the watched location, "/" separated. */
  path: string;
  kind: "folder" | "file";
  /** Files: their size. Folders: everything inside, when it could be counted in time. */
  sizeBytes?: number;
  modifiedAt?: IsoTime;
  /** Folders only: how many items are directly inside. */
  itemCount?: number;
}

export interface FolderListing {
  locationId: string;
  /** Relative path of this folder ("" is the watched location itself). */
  path: string;
  displayPath: string;
  breadcrumbs: { name: string; path: string }[];
  entries: FileEntry[];
  /** True when the folder holds more entries than are returned. */
  truncated: boolean;
  totals: { folders: number; files: number; fileBytes: number };
}

/** Roughly what a file manager's Properties dialog shows. */
export interface ItemProperties {
  name: string;
  kind: "folder" | "file";
  displayPath: string;
  extension?: string;
  sizeBytes: number;
  /** Folders: everything inside, at any depth. */
  files?: number;
  folders?: number;
  /** False when a very large folder was only partly counted within the time limit. */
  complete: boolean;
  createdAt?: IsoTime;
  modifiedAt?: IsoTime;
  accessedAt?: IsoTime;
  readOnly: boolean;
}

/** A physical drive and its health, roughly what CrystalDiskInfo shows. */
export interface PhysicalDisk {
  id: string;
  hostId: string;
  model: string;
  type: "ssd" | "hdd" | "unknown";
  /** Connection, e.g. "NVMe", "SATA", "USB". */
  bus: string;
  sizeTb: number;
  health: "healthy" | "warning" | "failing" | "unknown";
  temperatureC?: number;
  powerOnHours?: number;
  /** Percent of rated life used, for SSDs that report it. */
  wearPct?: number;
  readErrors?: number;
  writeErrors?: number;
  /** Drive letters or mount points on this disk. */
  volumes: string[];
  checkedAt: IsoTime;
  /** Plain-language reason some details are missing. */
  limitation?: string;
}

/** One SMART attribute that matters for health, in plain words. */
export interface SmartAttribute {
  /** The ATA attribute id (0 for NVMe health log fields). */
  id: number;
  name: string;
  /** The real count or reading (raw value). */
  value: number;
  /** The drive's own normalized score and failure threshold, when it has them. */
  normalized?: number;
  threshold?: number;
  attention?: boolean;
}

/** A drive's SMART report, read through the elevated executor (read only). */
export interface SmartReport {
  /** The whole drive, e.g. /dev/sda. */
  device: string;
  /** Mount points on it, to match Hearth's drive list. */
  mounts?: string[];
  readAt: IsoTime;
  verdict: "healthy" | "warning" | "failing" | "unknown";
  /** Why the verdict is what it is, from the drive's own figures. */
  reasons: string[];
  attributes: SmartAttribute[];
  model?: string;
  serial?: string;
  firmware?: string;
  /** How it was reached, when not direct (a USB bridge through SAT passthrough). */
  via?: string;
  temperatureC?: number;
  powerOnHours?: number;
  powerCycles?: number;
  lastSelfTest?: { kind: string; result: string; passed: boolean; atHours?: number };
  /** Asleep: not woken to be read. */
  asleep?: boolean;
  /** Why there is no health data, in plain words (a USB enclosure without passthrough, ...). */
  unavailable?: string;
}

/** One thing that happened to a service, for its History tab (newest first). */
export interface TimelineEvent {
  at: string;
  kind:
    | "incident"
    | "resolved"
    | "action"
    | "job"
    | "change"
    | "restart"
    | "stop"
    | "investigation"
    | "memory";
  title: string;
  detail?: string;
  tone: "good" | "neutral" | "attention";
  /** Where it opens in the app, when it has a page. */
  link?: string;
  /** Who did it, when known: "you", "the AI", "Hearth", "Docker". */
  by?: string;
}

/** A start or stop of a container, from restart history. */
export interface ContainerEventView {
  at: string;
  kind: "start" | "stop";
  text: string;
  cause: "first-seen" | "dragon-control" | "docker" | "outside" | "exit";
  exitCode?: number;
  oomKilled?: boolean;
  restartCount?: number;
}
