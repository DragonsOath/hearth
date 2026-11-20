/** Demo fixture shapes: like the core domain, but with times as minutes ago. */

export type Health = "healthy" | "attention" | "offline";
export type Autonomy = "monitor" | "diagnose" | "ask" | "auto";
export type Severity = "info" | "warning" | "critical";

/** Times are stored as minutes-ago so demo data always reads as recent. */
export type MinutesAgo = number;

export interface Volume {
  id: string;
  label: string;
  mount: string;
  kind: "ssd" | "hdd" | "nas";
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
  connection: "this-machine" | "agent" | "network";
  docker: boolean;
  health: Health;
  lastSeen: MinutesAgo;
  volumes: Volume[];
}

export type ServiceCategory =
  "Media" | "Automation" | "Downloads" | "Network" | "Home" | "Files & Photos" | "System";

export interface Service {
  id: string;
  name: string;
  category: ServiceCategory;
  hostId: string;
  kind: "container" | "process" | "web";
  image?: string;
  version?: string;
  localUrl?: string;
  publicUrl?: string;
  proxyServiceId?: string;
  health: Health;
  responseMs?: number;
  uptimePct: number;
  dependsOn: string[];
  autonomyArea: string;
  note?: string;
}

export type TimelineKind =
  "detected" | "check" | "action" | "agent" | "approval" | "resolved" | "notified" | "escalated";

export interface TimelineEntry {
  at: MinutesAgo;
  kind: TimelineKind;
  text: string;
}

export interface Incident {
  id: string;
  title: string;
  serviceId?: string;
  hostId?: string;
  severity: Severity;
  status: "open" | "awaiting-approval" | "resolved";
  openedAt: MinutesAgo;
  resolvedAt?: MinutesAgo;
  summary: string;
  resolution?: string;
  handledBy: "runbook" | "agent" | "you" | "pending" | "recovered";
  monitorKey?: string;
  proposedAction?: string;
  timeline: TimelineEntry[];
}

export interface Activity {
  id: string;
  at: MinutesAgo;
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
  at: MinutesAgo;
  incidentId: string;
  summary: string;
  outcome: "resolved" | "proposed" | "escalated";
}

export interface NotificationChannel {
  id: string;
  name: string;
  status: "configured" | "available";
  detail?: string;
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

export interface AutonomyRule {
  id: string;
  label: string;
  description: string;
  level: Autonomy | "default";
}

export interface Workspace {
  instanceName: string;
  hosts: Host[];
  services: Service[];
  incidents: Incident[];
  activity: Activity[];
  agents: AgentProvider[];
  agentSessions: AgentSession[];
  channels: NotificationChannel[];
  routes: NotificationRoute[];
  integrations: Integration[];
  autonomyDefault: Autonomy;
  autonomyRules: AutonomyRule[];
}
