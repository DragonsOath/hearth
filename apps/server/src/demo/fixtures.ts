import type {
  Activity,
  AgentProvider,
  AgentSession,
  AutonomyRule,
  Host,
  Incident,
  Integration,
  NotificationChannel,
  NotificationRoute,
  Service,
  Workspace,
} from "./types";
import type { DemoScenario } from "@dragon-control/core";

/** Which autonomy rule governs each kind of service in the demo. */
function areaFor(id: string, category: Service["category"]): string {
  if (id === "caddy") return "proxy";
  if (category === "Media") return "media";
  if (category === "Automation" || category === "Downloads") return "automation";
  if (category === "Network") return "network";
  return "containers";
}

/**
 * Demo environment, seeded into the database by ./seed.ts. Times are
 * "minutes ago" and become real timestamps at seed time. Deliberately generic (not the
 * developer's own machines) so the product never grows assumptions about
 * one homelab. Scenarios exercise the calm, attention, and empty states.
 */

const hosts: Host[] = [
  {
    id: "obsidian",
    name: "Obsidian",
    role: "Primary server",
    os: "Windows 11 Pro",
    address: "192.168.1.20",
    cpu: { model: "AMD Ryzen 7 8845HS", cores: 16, usagePct: 14 },
    memory: { totalGb: 32, usedGb: 19.4 },
    uptimeHours: 412,
    connection: "this-machine",
    docker: true,
    health: "healthy",
    lastSeen: 0,
    volumes: [
      {
        id: "obs-c",
        label: "System",
        mount: "C:",
        kind: "ssd",
        totalTb: 1,
        usedTb: 0.41,
        smart: "ok",
      },
      {
        id: "obs-d",
        label: "Scratch",
        mount: "D:",
        kind: "ssd",
        totalTb: 2,
        usedTb: 0.62,
        smart: "ok",
      },
    ],
  },
  {
    id: "atlas",
    name: "Atlas",
    role: "Storage",
    os: "TrueNAS SCALE",
    address: "192.168.1.30",
    cpu: { model: "Intel Core i3-12100", cores: 8, usagePct: 6 },
    memory: { totalGb: 64, usedGb: 41.2 },
    uptimeHours: 2210,
    connection: "agent",
    docker: false,
    health: "healthy",
    lastSeen: 0,
    volumes: [
      {
        id: "atl-movies",
        label: "Movies",
        mount: "/mnt/tank/movies",
        kind: "nas",
        totalTb: 22,
        usedTb: 18.2,
        smart: "ok",
      },
      {
        id: "atl-shows",
        label: "Shows",
        mount: "/mnt/tank/shows",
        kind: "nas",
        totalTb: 22,
        usedTb: 16.7,
        smart: "ok",
      },
      {
        id: "atl-photos",
        label: "Photos",
        mount: "/mnt/tank/photos",
        kind: "nas",
        totalTb: 8,
        usedTb: 3.1,
        smart: "ok",
      },
      {
        id: "atl-books",
        label: "Books & Audio",
        mount: "/mnt/tank/books",
        kind: "nas",
        totalTb: 14,
        usedTb: 8.1,
        smart: "ok",
      },
    ],
  },
  {
    id: "studio",
    name: "Studio",
    role: "Workstation",
    os: "Windows 11 Pro",
    address: "192.168.1.42",
    cpu: { model: "AMD Ryzen 9 7950X", cores: 32, usagePct: 3 },
    memory: { totalGb: 64, usedGb: 12.8 },
    uptimeHours: 30,
    connection: "agent",
    docker: false,
    health: "healthy",
    lastSeen: 1,
    volumes: [
      {
        id: "stu-c",
        label: "System",
        mount: "C:",
        kind: "ssd",
        totalTb: 2,
        usedTb: 0.9,
        smart: "ok",
      },
      {
        id: "stu-g",
        label: "Games",
        mount: "G:",
        kind: "ssd",
        totalTb: 8,
        usedTb: 5.9,
        smart: "ok",
      },
    ],
  },
];

type ServiceSeed = [
  id: string,
  name: string,
  category: Service["category"],
  port: number,
  image: string,
  extra?: Partial<Service>,
];

const serviceSeeds: ServiceSeed[] = [
  [
    "jellyfin",
    "Jellyfin",
    "Media",
    8096,
    "jellyfin/jellyfin",
    { publicUrl: "watch.example.com", dependsOn: ["caddy"] },
  ],
  ["plex", "Plex", "Media", 32400, "plexinc/pms-docker"],
  ["tautulli", "Tautulli", "Media", 8181, "tautulli/tautulli", { dependsOn: ["plex"] }],
  [
    "audiobookshelf",
    "Audiobookshelf",
    "Media",
    13378,
    "advplyr/audiobookshelf",
    { publicUrl: "listen.example.com", dependsOn: ["caddy"] },
  ],
  ["kavita", "Kavita", "Media", 5000, "jvmilazz0/kavita"],
  [
    "overseerr",
    "Overseerr",
    "Media",
    5055,
    "sctx/overseerr",
    { publicUrl: "request.example.com", dependsOn: ["sonarr", "radarr", "caddy"] },
  ],
  [
    "sonarr",
    "Sonarr",
    "Automation",
    8989,
    "linuxserver/sonarr",
    { dependsOn: ["prowlarr", "qbittorrent", "sabnzbd"] },
  ],
  [
    "radarr",
    "Radarr",
    "Automation",
    7878,
    "linuxserver/radarr",
    { dependsOn: ["prowlarr", "qbittorrent", "sabnzbd"] },
  ],
  ["lidarr", "Lidarr", "Automation", 8686, "linuxserver/lidarr", { dependsOn: ["prowlarr"] }],
  ["readarr", "Readarr", "Automation", 8787, "linuxserver/readarr", { dependsOn: ["prowlarr"] }],
  [
    "bazarr",
    "Bazarr",
    "Automation",
    6767,
    "linuxserver/bazarr",
    { dependsOn: ["sonarr", "radarr"] },
  ],
  [
    "prowlarr",
    "Prowlarr",
    "Automation",
    9696,
    "linuxserver/prowlarr",
    { dependsOn: ["flaresolverr", "gluetun"] },
  ],
  ["flaresolverr", "FlareSolverr", "Automation", 8191, "flaresolverr/flaresolverr"],
  ["recyclarr", "Recyclarr", "Automation", 0, "recyclarr/recyclarr", { kind: "container" }],
  [
    "qbittorrent",
    "qBittorrent",
    "Downloads",
    8080,
    "linuxserver/qbittorrent",
    { dependsOn: ["gluetun"] },
  ],
  ["sabnzbd", "SABnzbd", "Downloads", 8085, "linuxserver/sabnzbd"],
  ["gluetun", "Gluetun VPN", "Downloads", 8000, "qmcgaw/gluetun"],
  ["caddy", "Caddy", "Network", 443, "caddy", { publicUrl: "*.example.com" }],
  ["adguard", "AdGuard Home", "Network", 3000, "adguard/adguardhome"],
  ["tailscale", "Tailscale", "Network", 0, "tailscale/tailscale", { kind: "process" }],
  ["uptime-kuma", "Uptime Kuma", "Network", 3001, "louislam/uptime-kuma"],
  [
    "home-assistant",
    "Home Assistant",
    "Home",
    8123,
    "homeassistant/home-assistant",
    { publicUrl: "home.example.com", dependsOn: ["caddy"] },
  ],
  ["zigbee2mqtt", "Zigbee2MQTT", "Home", 8099, "koenkk/zigbee2mqtt", { dependsOn: ["mosquitto"] }],
  ["mosquitto", "Mosquitto", "Home", 1883, "eclipse-mosquitto"],
  [
    "immich",
    "Immich",
    "Files & Photos",
    2283,
    "immich-app/immich-server",
    { publicUrl: "photos.example.com", dependsOn: ["immich-db", "caddy"] },
  ],
  ["immich-db", "Immich Database", "Files & Photos", 5432, "tensorchord/pgvecto-rs"],
  ["nextcloud", "Nextcloud", "Files & Photos", 8443, "nextcloud"],
  ["paperless", "Paperless-ngx", "Files & Photos", 8010, "paperless-ngx/paperless-ngx"],
  ["syncthing", "Syncthing", "Files & Photos", 8384, "syncthing/syncthing"],
  [
    "vaultwarden",
    "Vaultwarden",
    "System",
    8222,
    "vaultwarden/server",
    { publicUrl: "vault.example.com", dependsOn: ["caddy"] },
  ],
  ["backrest", "Backrest", "System", 9898, "garethgeorge/backrest"],
  ["homarr", "Homarr", "System", 7575, "homarr-labs/homarr"],
];

const versions = ["10.11.2", "1.42.1", "2.14.4", "4.0.15", "5.21.1", "1.9.3", "0.24.0", "3.1.2"];

/** Services whose port is not a web interface (MQTT, Postgres, the proxy itself). */
const noWebInterface = new Set(["mosquitto", "immich-db", "caddy"]);

function buildServices(): Service[] {
  return serviceSeeds.map(([id, name, category, port, image, extra], i) => {
    const host = id === "syncthing" ? hosts[1]! : hosts[0]!;
    return {
      id,
      name,
      category,
      hostId: host.id,
      kind: "container",
      image,
      version: versions[i % versions.length],
      localUrl: port && !noWebInterface.has(id) ? `http://${host.address}:${port}` : undefined,
      health: "healthy",
      responseMs: port ? 18 + ((i * 37) % 140) : undefined,
      uptimePct: 99.2 + ((i * 13) % 8) / 10,
      dependsOn: [],
      autonomyArea: areaFor(id, category),
      ...extra,
      // Everything with a public address is published through Caddy in the demo.
      proxyServiceId: extra?.publicUrl && id !== "caddy" ? "caddy" : undefined,
    } satisfies Service;
  });
}

const resolvedIncidents: Incident[] = [
  {
    id: "inc-1042",
    title: "Jellyfin stopped responding",
    serviceId: "jellyfin",
    hostId: "obsidian",
    severity: "warning",
    status: "resolved",
    openedAt: 134,
    resolvedAt: 131,
    handledBy: "runbook",
    summary:
      "Jellyfin failed two consecutive health checks while the container still reported running.",
    resolution:
      "Restarted the Jellyfin container and confirmed playback endpoints responded. No action is required.",
    timeline: [
      { at: 134, kind: "detected", text: "Jellyfin stopped responding on port 8096." },
      { at: 133, kind: "check", text: "Health check failed again after 60 seconds." },
      { at: 133, kind: "action", text: "Known recovery started: restart the Jellyfin container." },
      { at: 132, kind: "check", text: "Health check passed. Response in 41 ms." },
      { at: 131, kind: "resolved", text: "Incident resolved automatically." },
      { at: 131, kind: "notified", text: "Summary sent by email." },
    ],
  },
  {
    id: "inc-1039",
    title: "Indexer searches failing in Prowlarr",
    serviceId: "prowlarr",
    hostId: "obsidian",
    severity: "warning",
    status: "resolved",
    openedAt: 2890,
    resolvedAt: 2884,
    handledBy: "runbook",
    summary: "Three indexers returned challenge errors. FlareSolverr was unresponsive.",
    resolution: "Restarted FlareSolverr, retested all indexers, and closed the incident.",
    timeline: [
      { at: 2890, kind: "detected", text: "Three indexers failed their scheduled test." },
      { at: 2889, kind: "check", text: "Prowlarr API healthy. FlareSolverr not answering." },
      { at: 2888, kind: "action", text: "Restarted FlareSolverr (permitted by Auto Fix)." },
      { at: 2885, kind: "check", text: "All indexers passed their retest." },
      { at: 2884, kind: "resolved", text: "Incident resolved automatically." },
      { at: 2884, kind: "notified", text: "Summary sent by email." },
    ],
  },
  {
    id: "inc-1031",
    title: "Atlas unreachable for four minutes",
    hostId: "atlas",
    severity: "critical",
    status: "resolved",
    openedAt: 8650,
    resolvedAt: 8646,
    handledBy: "you",
    summary:
      "The Atlas agent stopped reporting and its shares were unavailable to Jellyfin and Plex.",
    resolution: "Atlas came back after a scheduled firmware update. Confirmed by you.",
    timeline: [
      { at: 8650, kind: "detected", text: "Atlas agent stopped reporting." },
      {
        at: 8649,
        kind: "escalated",
        text: "Host availability is outside Auto Fix. You were notified.",
      },
      { at: 8646, kind: "check", text: "Atlas reporting again. All shares mounted." },
      { at: 8646, kind: "resolved", text: "Marked resolved: planned firmware update." },
    ],
  },
];

const attentionIncident: Incident = {
  id: "inc-1047",
  title: "Two indexers failing after automatic recovery",
  serviceId: "prowlarr",
  hostId: "obsidian",
  severity: "warning",
  status: "awaiting-approval",
  openedAt: 46,
  handledBy: "agent",
  summary:
    "Two indexers in Prowlarr have failed every search for 46 minutes. Restarting FlareSolverr did not help. Claude traced the failures to both sites moving to a new address.",
  proposedAction:
    "Update the base URL for the two affected indexers in Prowlarr, then retest them.",
  timeline: [
    { at: 46, kind: "detected", text: "Two indexers failed their scheduled test." },
    { at: 45, kind: "check", text: "Prowlarr API healthy. FlareSolverr healthy." },
    { at: 44, kind: "action", text: "Known recovery: restarted FlareSolverr." },
    { at: 41, kind: "check", text: "Retest failed. Runbook exhausted." },
    { at: 40, kind: "agent", text: "Escalated to Claude Code for diagnosis." },
    {
      at: 37,
      kind: "agent",
      text: "Diagnosis: both indexers return permanent redirects to new domains. Proposed updating their base URLs.",
    },
    { at: 37, kind: "approval", text: "Configuration changes to Prowlarr require your approval." },
    { at: 36, kind: "notified", text: "You were notified by email." },
  ],
};

const diskIncident: Incident = {
  id: "inc-1048",
  monitorKey: "volume:atl-movies",
  title: "Movies volume is 93% full",
  hostId: "atlas",
  severity: "warning",
  status: "open",
  openedAt: 190,
  handledBy: "pending",
  summary:
    "The Movies volume on Atlas has 1.5 TB left. At the current rate of about 210 GB a week it fills in roughly seven weeks.",
  timeline: [
    { at: 190, kind: "detected", text: "Movies crossed the 90% capacity threshold." },
    {
      at: 190,
      kind: "escalated",
      text: "Storage is set to Diagnose. No changes will be made automatically.",
    },
    { at: 189, kind: "notified", text: "You were notified by email." },
  ],
};

const baseActivity: Activity[] = [
  {
    id: "a1",
    at: 131,
    tone: "good",
    text: "Jellyfin recovered automatically",
    incidentId: "inc-1042",
  },
  { id: "a2", at: 305, tone: "neutral", text: "Nightly backup completed · 214 GB" },
  { id: "a3", at: 480, tone: "neutral", text: "Sonarr imported 6 episodes" },
  { id: "a4", at: 1320, tone: "neutral", text: "Radarr imported 2 films" },
  {
    id: "a5",
    at: 2884,
    tone: "good",
    text: "Prowlarr indexers restored automatically",
    incidentId: "inc-1039",
  },
];

const agents: AgentProvider[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Anthropic's coding agent, connected through Hearth's tool interface.",
    status: "connected",
    detail: "Diagnose and repair through structured tools only. No shell access.",
  },
  {
    id: "codex",
    name: "Codex",
    description: "OpenAI's coding agent.",
    status: "available",
  },
  {
    id: "openai-compatible",
    name: "OpenAI-compatible endpoint",
    description: "Any hosted or local model that speaks the OpenAI API.",
    status: "available",
  },
  {
    id: "ollama",
    name: "Ollama",
    description: "Local models running on your own hardware.",
    status: "coming-later",
  },
];

const agentSessions: AgentSession[] = [
  {
    id: "s1",
    at: 37,
    incidentId: "inc-1047",
    summary: "Found two indexers redirecting to new domains. Proposed updating their base URLs.",
    outcome: "proposed",
  },
  {
    id: "s2",
    at: 20200,
    incidentId: "inc-0998",
    summary:
      "Traced repeated Immich restarts to an exhausted database connection pool and raised the limit.",
    outcome: "resolved",
  },
];

const channels: NotificationChannel[] = [
  { id: "email", name: "Email", status: "configured", detail: "you@example.com" },
  { id: "discord", name: "Discord", status: "available" },
  { id: "ntfy", name: "ntfy", status: "available" },
  { id: "telegram", name: "Telegram", status: "available" },
  { id: "push", name: "Browser push", status: "available" },
  { id: "gotify", name: "Gotify", status: "available" },
  { id: "slack", name: "Slack", status: "available" },
];

const routes: NotificationRoute[] = [
  {
    id: "needs-you",
    event: "Needs your attention",
    description: "Anything Hearth cannot resolve on its own.",
    channels: ["email"],
  },
  {
    id: "auto-repaired",
    event: "Repaired automatically",
    description: "A short account of what happened and what was done.",
    channels: ["email"],
  },
  {
    id: "repair-failed",
    event: "Repair unsuccessful",
    description: "An automatic repair was attempted and did not hold.",
    channels: ["email"],
  },
  {
    id: "critical",
    event: "Critical",
    description: "Hosts offline, storage failing, or data at risk.",
    channels: ["email"],
  },
  {
    id: "weekly",
    event: "Weekly summary",
    description: "One quiet note each Sunday morning.",
    channels: [],
  },
];

const integrations: Integration[] = [
  {
    id: "docker",
    name: "Docker",
    category: "Infrastructure",
    description: "Containers, health, logs, and restarts.",
    status: "connected",
    instances: 1,
  },
  {
    id: "windows",
    name: "Windows host",
    category: "Infrastructure",
    description: "System health, disks, and services.",
    status: "connected",
    instances: 2,
  },
  {
    id: "linux",
    name: "Linux host",
    category: "Infrastructure",
    description: "System health, disks, and services.",
    status: "connected",
    instances: 1,
  },
  {
    id: "http",
    name: "Web endpoint",
    category: "Infrastructure",
    description: "Checks any HTTP service for availability.",
    status: "connected",
    instances: 24,
  },
  {
    id: "prowlarr",
    name: "Prowlarr",
    category: "Automation",
    description: "Indexer health, tests, and recovery.",
    status: "connected",
    instances: 1,
  },
  {
    id: "jellyfin",
    name: "Jellyfin",
    category: "Media",
    description: "Server health, sessions, and libraries.",
    status: "connected",
    instances: 1,
  },
  {
    id: "sonarr",
    name: "Sonarr",
    category: "Automation",
    description: "Queue, imports, and health warnings.",
    status: "discovered",
  },
  {
    id: "radarr",
    name: "Radarr",
    category: "Automation",
    description: "Queue, imports, and health warnings.",
    status: "discovered",
  },
  {
    id: "plex",
    name: "Plex",
    category: "Media",
    description: "Server health, sessions, and libraries.",
    status: "discovered",
  },
  {
    id: "caddy",
    name: "Caddy",
    category: "Network",
    description: "Routes, certificates, and reachability.",
    status: "discovered",
  },
  {
    id: "home-assistant",
    name: "Home Assistant",
    category: "Home",
    description: "Instance health and integrations.",
    status: "available",
  },
  {
    id: "immich",
    name: "Immich",
    category: "Files & Photos",
    description: "Server, jobs, and storage.",
    status: "available",
  },
  {
    id: "traefik",
    name: "Traefik",
    category: "Network",
    description: "Routers, services, and certificates.",
    status: "available",
  },
  {
    id: "audiobookshelf",
    name: "Audiobookshelf",
    category: "Media",
    description: "Libraries and listening sessions.",
    status: "available",
  },
];

const autonomyRules: AutonomyRule[] = [
  {
    id: "containers",
    label: "Containers",
    description: "Restarting a stopped or unresponsive container.",
    level: "auto",
  },
  {
    id: "media",
    label: "Media servers",
    description: "Jellyfin, Plex, and similar.",
    level: "auto",
  },
  {
    id: "automation",
    label: "Media automation",
    description: "Sonarr, Radarr, Prowlarr, and indexers.",
    level: "default",
  },
  {
    id: "proxy",
    label: "Reverse proxy",
    description: "Routes, certificates, and reloads.",
    level: "ask",
  },
  { id: "network", label: "Networking", description: "DNS, VPN, and remote access.", level: "ask" },
  {
    id: "storage",
    label: "Storage and files",
    description: "Volumes, shares, and anything touching data.",
    level: "diagnose",
  },
  { id: "hosts", label: "Hosts", description: "Reboots and system services.", level: "diagnose" },
];

/**
 * What a real installation starts with: every agent, channel, and
 * integration listed but none claimed as connected or configured.
 */
export function baseCatalog() {
  return {
    agents: agents.map((a) => ({
      ...a,
      status: a.status === "connected" ? ("available" as const) : a.status,
    })),
    channels: channels.map((c) => ({ ...c, status: "available" as const, detail: undefined })),
    routes: routes.map((r) => ({ ...r, channels: [] as string[] })),
    integrations: integrations.map((i) => ({
      ...i,
      status: "available" as const,
      instances: undefined,
    })),
    autonomyRules: autonomyRules.map((r) => ({ ...r })),
  };
}

export function buildWorkspace(scenario: DemoScenario): Workspace {
  const shared = {
    instanceName: "Home",
    agents,
    channels,
    routes,
    autonomyDefault: "ask" as const,
    autonomyRules,
  };

  if (scenario === "fresh") {
    return {
      ...shared,
      hosts: [{ ...hosts[0]!, volumes: hosts[0]!.volumes }],
      services: [],
      incidents: [],
      activity: [],
      ...baseCatalog(),
      agentSessions: [],
    };
  }

  const services = buildServices();
  const workspaceHosts = structuredClone(hosts);
  const incidents = [...resolvedIncidents];
  const activity = [...baseActivity];

  if (scenario === "attention") {
    const prowlarr = services.find((s) => s.id === "prowlarr")!;
    prowlarr.health = "attention";
    prowlarr.note = "Two of eleven indexers failing";
    const movies = workspaceHosts[1]!.volumes[0]!;
    movies.usedTb = 20.5;
    workspaceHosts[1]!.health = "attention";
    incidents.unshift(attentionIncident, diskIncident);
    activity.unshift(
      {
        id: "a0",
        at: 37,
        tone: "attention",
        text: "Approval requested for a Prowlarr change",
        incidentId: "inc-1047",
      },
      {
        id: "a00",
        at: 190,
        tone: "attention",
        text: "Movies volume passed 90%",
        incidentId: "inc-1048",
      },
    );
    activity.sort((a, b) => a.at - b.at);
  }

  return {
    ...shared,
    hosts: workspaceHosts,
    services,
    incidents,
    activity,
    agentSessions,
    integrations,
  };
}
