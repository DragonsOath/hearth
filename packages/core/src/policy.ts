import type { Autonomy } from "./domain";

/**
 * Actions Hearth can carry out, and the single rule that decides
 * whether one may run. The server enforces this; the web app only uses it
 * to explain. An agent never decides its own permissions.
 */

/** How long a proposed repair can be approved before it lapses and needs proposing again. */
export const APPROVAL_WINDOW_HOURS = 24;

export type ActionKind =
  | "run-check"
  | "test-endpoint"
  | "inspect-logs"
  | "restart-container"
  | "start-container"
  | "stop-container"
  | "app-test-indexer"
  | "app-set-indexer-enabled"
  | "app-qbt-resume"
  | "app-qbt-pause"
  | "app-qbt-reannounce"
  | "app-qbt-recheck"
  | "app-radarr-set-monitored"
  | "app-radarr-set-upgrades"
  | "app-radarr-delete-file"
  | "app-plex-delete-media"
  | "app-plex-control"
  | "app-sonarr-set-monitored"
  | "app-sonarr-set-upgrades"
  | "app-sonarr-delete-file"
  | "app-arr-import"
  | "app-arr-search"
  | "app-arr-grab"
  | "app-arr-queue-remove"
  | "app-arr-add-collection"
  | "app-arr-set-cutoff-score"
  | "app-arr-set-naming"
  | "app-arr-unmonitor-owned"
  | "app-arr-edit"
  | "app-arr-create"
  | "app-arr-delete"
  | "app-arr-command"
  | "app-crucible-apply"
  | "app-qbt-remove"
  | "app-qbt-remove-with-data"
  | "app-qbt-set-preferences"
  | "app-qbt-set-share-limits"
  | "app-qbt-set-category"
  | "app-qbt-set-tags"
  | "app-qbt-set-priority"
  | "app-qbt-force-start"
  | "app-qbt-add"
  | "app-qbt-file-priority"
  | "app-qbt-category"
  | "app-qbt-manual-sort"
  | "config-edit"
  | "config-restore"
  | "vpn-switch-server"
  | "app-recyclarr-sync"
  | "compose-update-image"
  | "compose-install"
  | "compose-remove"
  | "credential-import"
  | "app-wizarr-invite"
  | "app-wizarr-invite-delete"
  | "app-wizarr-user"
  | "app-wizarr-setup"
  | "app-seerr-approve"
  | "app-seerr-decline"
  | "app-seerr-remove"
  | "app-seerr-request"
  | "app-seerr-retry"
  | "app-seerr-mark-available"
  | "app-seerr-search-on-add"
  | "app-seerr-issue"
  | "app-radarr-set-root-folder"
  | "tinyauth-users"
  | "app-tautulli-stop-stream"
  | "app-tautulli-control"
  | "app-sabnzbd-control"
  | "app-prowlarr-indexer"
  | "app-bazarr-subtitles"
  | "app-homeassistant-control"
  | "app-syncthing-control"
  | "app-lidarr-control"
  | "app-chaptarr-control"
  | "app-jellyfin-control"
  | "app-immich-control"
  | "app-deluge-control"
  | "app-transmission-control"
  | "app-nzbget-control"
  | "app-audiobookshelf-control"
  | "app-kavita-control"
  | "app-portainer-control"
  | "app-uptimekuma-control"
  | "app-nextcloud-control"
  | "app-paperless-control"
  | "app-vaultwarden-control"
  | "app-tailscale-control"
  | "app-wgeasy-control"
  | "app-navidrome-control"
  | "app-komga-control"
  | "app-gitea-control"
  | "app-mealie-control"
  | "app-authentik-control"
  | "app-frigate-control"
  | "app-npm-control"
  | "app-proxmox-control"
  | "app-adguard-control"
  | "app-pihole-control"
  | "app-romm-control"
  | "app-ersatztv-control"
  | "file-manage"
  | "storage-raid"
  | "app-api-call"
  | "hearth-api-call"
  | "free-memory"
  | "browser-change"
  | "lab-transfer"
  | "build-docker"
  | "build-tailscale"
  | "build-app"
  | "build-connect";

export const ACTION_KINDS: readonly ActionKind[] = [
  "run-check",
  "test-endpoint",
  "inspect-logs",
  "restart-container",
  "start-container",
  "stop-container",
  "app-test-indexer",
  "app-set-indexer-enabled",
  "app-qbt-resume",
  "app-qbt-pause",
  "app-qbt-reannounce",
  "app-qbt-recheck",
  "app-radarr-set-monitored",
  "app-radarr-set-upgrades",
  "app-radarr-delete-file",
  "app-plex-delete-media",
  "app-sonarr-set-monitored",
  "app-sonarr-set-upgrades",
  "app-sonarr-delete-file",
  "app-arr-import",
  "app-arr-search",
  "app-arr-grab",
  "app-arr-queue-remove",
  "app-arr-add-collection",
  "app-arr-set-cutoff-score",
  "app-arr-set-naming",
  "app-arr-unmonitor-owned",
  "app-arr-edit",
  "app-arr-create",
  "app-arr-delete",
  "app-arr-command",
  "app-crucible-apply",
  "app-qbt-remove",
  "app-qbt-remove-with-data",
  "app-qbt-set-preferences",
  "app-qbt-set-share-limits",
  "app-qbt-set-category",
  "app-qbt-set-tags",
  "app-qbt-set-priority",
  "app-qbt-force-start",
  "app-qbt-add",
  "app-qbt-file-priority",
  "app-qbt-category",
  "app-qbt-manual-sort",
  "config-edit",
  "config-restore",
  "vpn-switch-server",
  "app-recyclarr-sync",
  "compose-update-image",
  "compose-install",
  "compose-remove",
  "credential-import",
  "app-wizarr-invite",
  "app-wizarr-invite-delete",
  "app-wizarr-user",
  "app-wizarr-setup",
  "app-seerr-approve",
  "app-seerr-decline",
  "app-seerr-remove",
  "app-seerr-request",
  "app-seerr-retry",
  "app-seerr-mark-available",
  "app-seerr-search-on-add",
  "app-seerr-issue",
  "app-radarr-set-root-folder",
  "tinyauth-users",
  "app-tautulli-stop-stream",
  "app-tautulli-control",
  "app-sabnzbd-control",
  "app-prowlarr-indexer",
  "app-bazarr-subtitles",
  "app-homeassistant-control",
  "app-syncthing-control",
  "app-lidarr-control",
  "app-chaptarr-control",
  "app-jellyfin-control",
  "app-immich-control",
  "app-deluge-control",
  "app-transmission-control",
  "app-nzbget-control",
  "app-audiobookshelf-control",
  "app-adguard-control",
  "app-kavita-control",
  "app-portainer-control",
  "app-uptimekuma-control",
  "app-nextcloud-control",
  "app-paperless-control",
  "app-vaultwarden-control",
  "app-tailscale-control",
  "app-wgeasy-control",
  "app-navidrome-control",
  "app-komga-control",
  "app-gitea-control",
  "app-mealie-control",
  "app-authentik-control",
  "app-frigate-control",
  "app-npm-control",
  "app-proxmox-control",
  "app-pihole-control",
  "app-romm-control",
  "app-ersatztv-control",
  "app-plex-control",
  "file-manage",
  "storage-raid",
  "app-api-call",
  "hearth-api-call",
  "free-memory",
  "browser-change",
  "build-docker",
  "build-tailscale",
  "build-app",
  "build-connect",
];

/**
 * Operations inside an application, through its own API (never its files, a
 * shell, or Docker). They need parameters, so they only run as plan steps.
 */
export const APP_ACTIONS: readonly ActionKind[] = [
  "app-test-indexer",
  "app-set-indexer-enabled",
  "app-qbt-resume",
  "app-qbt-pause",
  "app-qbt-reannounce",
  "app-qbt-recheck",
  "app-radarr-set-monitored",
  "app-radarr-set-upgrades",
  "app-radarr-delete-file",
  "app-plex-delete-media",
  "app-sonarr-set-monitored",
  "app-sonarr-set-upgrades",
  "app-sonarr-delete-file",
  "app-arr-import",
  "app-arr-search",
  "app-arr-grab",
  "app-arr-queue-remove",
  "app-arr-add-collection",
  "app-arr-set-cutoff-score",
  "app-arr-set-naming",
  "app-arr-unmonitor-owned",
  "app-arr-edit",
  "app-arr-create",
  "app-arr-delete",
  "app-arr-command",
  "app-crucible-apply",
  "app-qbt-remove",
  "app-qbt-remove-with-data",
  "app-qbt-set-preferences",
  "app-qbt-set-share-limits",
  "app-qbt-set-category",
  "app-qbt-set-tags",
  "app-qbt-set-priority",
  "app-qbt-force-start",
  "app-qbt-add",
  "app-qbt-file-priority",
  "app-qbt-category",
  "app-qbt-manual-sort",
  "app-wizarr-invite",
  "app-wizarr-invite-delete",
  "app-wizarr-user",
  "app-wizarr-setup",
  "app-seerr-approve",
  "app-seerr-decline",
  "app-seerr-remove",
  "app-seerr-request",
  "app-seerr-retry",
  "app-seerr-mark-available",
  "app-seerr-search-on-add",
  "app-seerr-issue",
  "app-radarr-set-root-folder",
  "app-tautulli-stop-stream",
  "app-tautulli-control",
  "app-sabnzbd-control",
  "app-prowlarr-indexer",
  "app-bazarr-subtitles",
  "app-homeassistant-control",
  "app-syncthing-control",
  "app-lidarr-control",
  "app-chaptarr-control",
  "app-jellyfin-control",
  "app-immich-control",
  "app-adguard-control",
  "app-deluge-control",
  "app-transmission-control",
  "app-nzbget-control",
  "app-audiobookshelf-control",
  "app-kavita-control",
  "app-portainer-control",
  "app-uptimekuma-control",
  "app-nextcloud-control",
  "app-paperless-control",
  "app-vaultwarden-control",
  "app-tailscale-control",
  "app-wgeasy-control",
  "app-navidrome-control",
  "app-komga-control",
  "app-gitea-control",
  "app-mealie-control",
  "app-authentik-control",
  "app-frigate-control",
  "app-npm-control",
  "app-proxmox-control",
  "app-pihole-control",
  "app-romm-control",
  "app-ersatztv-control",
  "app-plex-control",
  "app-api-call",
];

/** Seerr (Overseerr, Jellyseerr): approve or decline one request waiting for approval. */
/** Seerr: approve or decline a request waiting for approval, or remove a request (Stop tracking). */
export const SEERR_ACTIONS: readonly ActionKind[] = [
  "app-seerr-approve",
  "app-seerr-decline",
  "app-seerr-remove",
  "app-seerr-request",
  "app-seerr-retry",
  "app-seerr-mark-available",
  "app-seerr-search-on-add",
  "app-seerr-issue",
];

/**
 * Wizarr: create an invitation (which servers and libraries, how long the link works, how long
 * the access lasts) and delete one nobody used; and a person's access: disable, enable, extend, set
 * or clear its end date, or remove them. Plan steps you approve; each is read back where Wizarr can.
 */
export const WIZARR_ACTIONS: readonly ActionKind[] = [
  "app-wizarr-invite",
  "app-wizarr-invite-delete",
  "app-wizarr-user",
  "app-wizarr-setup",
];

/**
 * Sonarr and Radarr work on one queue item, episode, or movie: import a stuck download, search
 * for one missing item, or remove one queue item. Never blocklists, never deletes library files,
 * never changes paths; removing the download from the client too is a separate, explicit choice.
 */
export const ARR_ACTIONS: readonly ActionKind[] = [
  "app-arr-import",
  "app-arr-search",
  "app-arr-grab",
  "app-arr-queue-remove",
  "app-arr-add-collection",
];

/**
 * A Servarr app's own objects (native Radarr panel, checklist 46.9): change, add or remove one
 * object (a movie, quality profile, custom format, tag, delay or release profile, connection,
 * naming or media management), or run one of its own commands. Always plan steps you approve
 * (D5); the plan shows the exact before and after, the step re-reads before acting and reads back
 * after. Logins, API keys and app updates are never among them (D6).
 */
export const ARR_RESOURCE_ACTIONS: readonly ActionKind[] = [
  "app-arr-edit",
  "app-arr-create",
  "app-arr-delete",
  "app-arr-command",
  "app-crucible-apply",
];

/**
 * qBittorrent through its Web API: repairs on one torrent (by hash), and (10-12) its global
 * seeding, speed, and queue settings, torrents' limits, category, tags, priority, force start,
 * and adding torrents. Each is a change:
 * always a plan step you approve, never automatic. Never the Web UI login, networking, the
 * VPN, or save paths (qbittorrent-control.ts refuses those settings by name).
 */
export const TORRENT_ACTIONS: readonly ActionKind[] = [
  "app-qbt-resume",
  "app-qbt-pause",
  "app-qbt-reannounce",
  "app-qbt-recheck",
  "app-qbt-remove",
  "app-qbt-remove-with-data",
  "app-qbt-set-preferences",
  "app-qbt-set-share-limits",
  "app-qbt-set-category",
  "app-qbt-set-tags",
  "app-qbt-set-priority",
  "app-qbt-force-start",
  "app-qbt-add",
  "app-qbt-file-priority",
  "app-qbt-category",
  "app-qbt-manual-sort",
];

/**
 * Configuration management (feature request 21): edits to a configuration file you registered,
 * restoring one from its backup, and running an app's own sync (Recyclarr). Always plan steps you
 * approve; the file and the app are re-checked before anything changes.
 */
export const CONFIG_ACTIONS: readonly ActionKind[] = [
  "config-edit",
  "config-restore",
  "vpn-switch-server",
  "app-recyclarr-sync",
  "compose-update-image",
  "compose-install",
  "compose-remove",
];

/**
 * Compose administration: update a container's image, install a new app as its own Compose
 * project, and remove a project's containers (keeping its files and data). Always plan steps
 * you approve; each is validated by Compose and the mount guard, verified by checking the
 * containers and the app, and put back when that fails.
 */
export const COMPOSE_ACTIONS: readonly ActionKind[] = [
  "compose-update-image",
  "compose-install",
  "compose-remove",
];

/**
 * File operations from the file manager (create a folder, rename, move, copy) on this machine.
 * Always plan steps you approve; nothing is deleted or replaced, and folders the download and
 * library apps manage are left to those apps.
 */
export const FILE_ACTIONS: readonly ActionKind[] = ["file-manage"];

/**
 * Freeing memory on this machine (Systems, Memory): close an app the normal way (or, said
 * plainly, force it), or free Hearth's voice. Always a plan step you approve.
 */
export const MEMORY_ACTIONS: readonly ActionKind[] = ["free-memory"];

/**
 * RAID (Storage > RAID / Arrays): one action on one array or drive per step, planned from the
 * machine's state, approved, carried out by the elevated executor, and read back.
 */
export const RAID_ACTIONS: readonly ActionKind[] = ["storage-raid"];

/**
 * Hearth Transfer was removed (the owner, 11-11). Its plan kind is kept only so old plans in the
 * job history still read; nothing offers it, and the plan engine refuses it.
 */
export const TRANSFER_ACTIONS: readonly ActionKind[] = ["lab-transfer"];

/**
 * Building a beginner's homelab plan (docs/design/BUILDER.md): install Docker or Tailscale through
 * the admin helper, install one app from Hearth's reviewed recipe and make its account, and connect
 * the apps to each other. Always plan steps the owner approves; the parameters come from Hearth's
 * own recipes and the saved plan, never from the AI. Docker, Tailscale and the VPN are protected:
 * approving asks the owner to confirm it's them.
 */
export const BUILD_ACTIONS: readonly ActionKind[] = [
  "build-docker",
  "build-tailscale",
  "build-app",
  "build-connect",
];

/** The service id a step uses when it acts on the machine rather than an existing service. */
export const THIS_HOST = "this-host";

/**
 * Library repairs on one title: Radarr (monitor or not, upgrades in one
 * quality profile, delete one movie file) and Plex (delete one duplicate
 * version). Always plan steps you approve; deletions cannot be undone by
 * Hearth and say where (if anywhere) the file can be restored from.
 */
export const MEDIA_ACTIONS: readonly ActionKind[] = [
  "app-radarr-set-monitored",
  "app-radarr-set-upgrades",
  "app-radarr-delete-file",
  "app-plex-delete-media",
  "app-sonarr-set-monitored",
  "app-sonarr-set-upgrades",
  "app-sonarr-delete-file",
  "app-arr-set-cutoff-score",
  "app-arr-set-naming",
  "app-arr-unmonitor-owned",
];

/**
 * How much an operation can affect. Investigation only reads. Configuration
 * changes settings through an app's API, always with your approval of the
 * exact change, verified and undone if a later step fails. Infrastructure
 * (VPN routing, Gluetun, firewalls, reverse proxies, Docker networking) has
 * no operations: it needs a separate, explicit authorization first.
 */
export type RiskTier = "investigation" | "configuration" | "infrastructure";

export function riskOf(kind: ActionKind): RiskTier {
  return ACTIONS[kind].changes ? "configuration" : "investigation";
}

/** Start and stop: only you directly, or an approved plan (never automatic, never ad hoc). */
export const POWER_ACTIONS: readonly ActionKind[] = ["start-container", "stop-container"];

/**
 * Containers that carry other things: reverse proxies, VPNs and tunnels, DNS,
 * Docker access, Hearth itself. Stopping one takes remote access or
 * other services down with it, so Hearth never stops them.
 */
const CORE_NETWORKING =
  /caddy|traefik|nginx-proxy|gluetun|wireguard|wg-easy|tailscale|headscale|cloudflared|socket-proxy|pihole|adguard|dragon-control/i;

export function isCoreNetworking(name: string, image?: string | null): boolean {
  return CORE_NETWORKING.test(name) || (image ? CORE_NETWORKING.test(image) : false);
}

export interface ActionDefinition {
  kind: ActionKind;
  /** Plain words, completed with the service name: "Restart the Jellyfin container". */
  describe: (serviceName: string) => string;
  /** True when the action changes something; read-only actions only look. */
  changes: boolean;
  /** High-impact: never automatic, whatever the autonomy level says. */
  guardrail?: boolean;
}

export const ACTIONS: Record<ActionKind, ActionDefinition> = {
  "run-check": {
    kind: "run-check",
    describe: (name) => `Run the health check for ${name}`,
    changes: false,
  },
  "test-endpoint": {
    kind: "test-endpoint",
    describe: (name) => `Test ${name}'s web address`,
    changes: false,
  },
  "inspect-logs": {
    kind: "inspect-logs",
    describe: (name) => `Read ${name}'s recent logs`,
    changes: false,
  },
  "restart-container": {
    kind: "restart-container",
    describe: (name) => `Restart the ${name} container`,
    changes: true,
  },
  "start-container": {
    kind: "start-container",
    describe: (name) => `Start the ${name} container`,
    changes: true,
    guardrail: true,
  },
  "stop-container": {
    kind: "stop-container",
    describe: (name) => `Stop the ${name} container`,
    changes: true,
    guardrail: true,
  },
  "app-test-indexer": {
    kind: "app-test-indexer",
    describe: (name) => `Test an indexer in ${name}`,
    changes: false,
  },
  "app-set-indexer-enabled": {
    kind: "app-set-indexer-enabled",
    describe: (name) => `Turn an indexer on or off in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-qbt-resume": {
    kind: "app-qbt-resume",
    describe: (name) => `Resume a torrent in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-qbt-pause": {
    kind: "app-qbt-pause",
    describe: (name) => `Pause a torrent in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-qbt-reannounce": {
    kind: "app-qbt-reannounce",
    describe: (name) => `Ask a torrent's trackers again in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-qbt-recheck": {
    kind: "app-qbt-recheck",
    describe: (name) => `Recheck a torrent's files in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-qbt-set-preferences": {
    kind: "app-qbt-set-preferences",
    describe: (name) => `Change qBittorrent's seeding, speed, or queue settings in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-qbt-set-share-limits": {
    kind: "app-qbt-set-share-limits",
    describe: (name) => `Set torrents' seeding limits in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-qbt-set-category": {
    kind: "app-qbt-set-category",
    describe: (name) => `Change torrents' category in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-qbt-set-tags": {
    kind: "app-qbt-set-tags",
    describe: (name) => `Change torrents' tags in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-qbt-set-priority": {
    kind: "app-qbt-set-priority",
    describe: (name) => `Move torrents in the queue in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-qbt-force-start": {
    kind: "app-qbt-force-start",
    describe: (name) => `Force start torrents in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-qbt-add": {
    kind: "app-qbt-add",
    describe: (name) => `Add torrents to ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-qbt-file-priority": {
    kind: "app-qbt-file-priority",
    describe: (name) => `Change which files of a torrent download in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-qbt-category": {
    kind: "app-qbt-category",
    describe: (name) => `Create or remove a category in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-qbt-manual-sort": {
    kind: "app-qbt-manual-sort",
    describe: (name) => `Sort manual downloads in ${name} (set up, file, undo or retry)`,
    changes: true,
    guardrail: true,
  },
  "app-radarr-set-monitored": {
    kind: "app-radarr-set-monitored",
    describe: (name) => `Monitor or unmonitor a movie in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-radarr-set-upgrades": {
    kind: "app-radarr-set-upgrades",
    describe: (name) => `Allow or stop upgrades in a quality profile in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-radarr-delete-file": {
    kind: "app-radarr-delete-file",
    describe: (name) => `Delete a movie file in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-plex-delete-media": {
    kind: "app-plex-delete-media",
    describe: (name) => `Delete a duplicate version in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-sonarr-set-monitored": {
    kind: "app-sonarr-set-monitored",
    describe: (name) => `Monitor or unmonitor an episode in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-sonarr-set-upgrades": {
    kind: "app-sonarr-set-upgrades",
    describe: (name) => `Allow or stop upgrades in a quality profile in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-sonarr-delete-file": {
    kind: "app-sonarr-delete-file",
    describe: (name) => `Delete an episode file in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-arr-import": {
    kind: "app-arr-import",
    describe: (name) => `Import a stuck download in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-arr-search": {
    kind: "app-arr-search",
    describe: (name) => `Search for a missing item in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-arr-grab": {
    kind: "app-arr-grab",
    describe: (name) => `Download one release you picked in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-arr-queue-remove": {
    kind: "app-arr-queue-remove",
    describe: (name) => `Remove one item from the download queue in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-arr-add-collection": {
    kind: "app-arr-add-collection",
    describe: (name) => `Add a collection's missing movies in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-arr-set-cutoff-score": {
    kind: "app-arr-set-cutoff-score",
    describe: (name) => `Set where a quality profile stops upgrading in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-arr-set-naming": {
    kind: "app-arr-set-naming",
    describe: (name) => `Change one naming setting in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-arr-edit": {
    kind: "app-arr-edit",
    describe: (name) => `Change settings of one object in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-arr-create": {
    kind: "app-arr-create",
    describe: (name) => `Add one object to ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-arr-delete": {
    kind: "app-arr-delete",
    describe: (name) => `Remove one object from ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-arr-command": {
    kind: "app-arr-command",
    describe: (name) => `Run one of ${name}'s own commands`,
    changes: true,
    guardrail: true,
  },
  "app-crucible-apply": {
    kind: "app-crucible-apply",
    describe: (name) => `Save the Crucible's quality and size rows in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-arr-unmonitor-owned": {
    kind: "app-arr-unmonitor-owned",
    describe: (name) => `Stop monitoring everything you already have in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-qbt-remove": {
    kind: "app-qbt-remove",
    describe: (name) => `Remove a torrent from ${name}, keeping its downloaded data`,
    changes: true,
    guardrail: true,
  },
  "app-qbt-remove-with-data": {
    kind: "app-qbt-remove-with-data",
    describe: (name) => `Remove a torrent from ${name} and delete its downloaded data`,
    changes: true,
    guardrail: true,
  },
  "config-edit": {
    kind: "config-edit",
    describe: (name) => `Edit a configuration file of ${name}`,
    changes: true,
    guardrail: true,
  },
  "config-restore": {
    kind: "config-restore",
    describe: (name) => `Restore a configuration file of ${name} from its backup`,
    changes: true,
    guardrail: true,
  },
  "vpn-switch-server": {
    kind: "vpn-switch-server",
    describe: (name) => `Switch ${name} to a different VPN server`,
    changes: true,
    guardrail: true,
  },
  "app-recyclarr-sync": {
    kind: "app-recyclarr-sync",
    describe: (name) => `Run ${name}'s sync now`,
    changes: true,
    guardrail: true,
  },
  "compose-update-image": {
    kind: "compose-update-image",
    describe: (name) => `Update ${name}'s container image`,
    changes: true,
    guardrail: true,
  },
  "compose-install": {
    kind: "compose-install",
    describe: () => "Install a new app as its own Compose project",
    changes: true,
    guardrail: true,
  },
  "compose-remove": {
    kind: "compose-remove",
    describe: (name) => `Remove ${name}'s containers (keeping its files and data)`,
    changes: true,
    guardrail: true,
  },
  "app-wizarr-invite": {
    kind: "app-wizarr-invite",
    describe: (name) => `Create an invitation in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-wizarr-invite-delete": {
    kind: "app-wizarr-invite-delete",
    describe: (name) => `Delete an invitation in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-wizarr-user": {
    kind: "app-wizarr-user",
    describe: (name) => `Change someone's access in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-wizarr-setup": {
    kind: "app-wizarr-setup",
    describe: (name) => `Change the invite steps or settings in ${name}`,
    changes: true,
    guardrail: true,
  },
  "file-manage": {
    kind: "file-manage",
    describe: () => "Create a folder, or rename, move, or copy a file or folder",
    changes: true,
    guardrail: true,
  },
  "storage-raid": {
    kind: "storage-raid",
    describe: () =>
      "Manage a RAID array: add, replace, or remove a drive, run or pause a check, set its speed, grow it, or create one",
    changes: true,
    guardrail: true,
  },
  "app-ersatztv-control": {
    kind: "app-ersatztv-control",
    describe: (name) => `Rebuild a channel's schedule or stop a channel's stream in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-romm-control": {
    kind: "app-romm-control",
    describe: (name) => `Scan the game library or change a favourite in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-pihole-control": {
    kind: "app-pihole-control",
    describe: (name) =>
      `Pause or turn on ad blocking, update the blocklists, allow or block a domain or a pattern, add, switch, or remove a blocklist, or add or remove a local DNS name in ${name} (protected: approving asks you to confirm it is you)`,
    changes: true,
    guardrail: true,
  },
  "app-adguard-control": {
    kind: "app-adguard-control",
    describe: (name) =>
      `Pause or turn on protection, update filter lists, allow or block a domain, add, switch, or remove a filter list, change DNS rewrites, blocked services, safe browsing, parental control, or safe search in ${name} (protected: approving asks you to confirm it is you)`,
    changes: true,
    guardrail: true,
  },
  "app-proxmox-control": {
    kind: "app-proxmox-control",
    describe: (name) =>
      `Start, shut down, restart or force-stop a VM or container, back one up now, or take a snapshot in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-npm-control": {
    kind: "app-npm-control",
    describe: (name) =>
      `Switch a site on or off, change where it forwards, add or remove a site, or renew a certificate in ${name} (protected: approving asks you to confirm it is you)`,
    changes: true,
    guardrail: true,
  },
  "app-portainer-control": {
    kind: "app-portainer-control",
    describe: (name) =>
      `Start, stop or update a stack, or start, stop or restart a container through ${name} (protected when it runs networking)`,
    changes: true,
    guardrail: true,
  },
  "app-uptimekuma-control": {
    kind: "app-uptimekuma-control",
    describe: (name) =>
      `Pause, resume, add or remove a monitor, or pause or resume a maintenance window in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-nextcloud-control": {
    kind: "app-nextcloud-control",
    describe: (name) =>
      `Turn an account off or on, set its quota or groups, turn an app off or on, or change how background jobs run or public links work in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-paperless-control": {
    kind: "app-paperless-control",
    describe: (name) =>
      `Sort the inbox, tag documents, set correspondents and types, move documents to the trash or back, or run maintenance in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-vaultwarden-control": {
    kind: "app-vaultwarden-control",
    describe: (name) =>
      `Turn an account off or on, sign it out everywhere, turn off its two-step sign-in, invite someone, or delete an account in ${name} (protected: approving asks you to confirm it is you)`,
    changes: true,
    guardrail: true,
  },
  "app-tailscale-control": {
    kind: "app-tailscale-control",
    describe: (name) =>
      `Approve a device or take its access away, turn key expiry off or on, approve or withdraw an exit node or subnet routes, rename or remove a device on ${name}'s tailnet (protected: approving asks you to confirm it is you)`,
    changes: true,
    guardrail: true,
  },
  "app-wgeasy-control": {
    kind: "app-wgeasy-control",
    describe: (name) =>
      `Turn a WireGuard client on or off, add, rename, give an end date to or remove one, or restart WireGuard in ${name} (protected: approving asks you to confirm it is you)`,
    changes: true,
    guardrail: true,
  },
  "app-navidrome-control": {
    kind: "app-navidrome-control",
    describe: (name) =>
      `Scan the library, forget missing files, or make a user an administrator, an ordinary user, or remove them in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-gitea-control": {
    kind: "app-gitea-control",
    describe: (name) =>
      `Sync a mirror, run a workflow's failed jobs again, turn an Actions runner off, on or remove it, or run a scheduled task now in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-frigate-control": {
    kind: "app-frigate-control",
    describe: (name) =>
      `Turn a camera's detection or recording on or off, keep or delete an event, or restart ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-authentik-control": {
    kind: "app-authentik-control",
    describe: (name) =>
      `Turn a person's account off or on, or retry a failed background task in ${name} (protected: approving asks you to confirm it is you)`,
    changes: true,
    guardrail: true,
  },
  "app-mealie-control": {
    kind: "app-mealie-control",
    describe: (name) =>
      `Make a backup, clean temporary files, delete unused images, remove empty recipe folders, or unlock locked accounts in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-komga-control": {
    kind: "app-komga-control",
    describe: (name) =>
      `Scan or deep scan a library, analyze its books again, refresh their metadata, empty its trash, or read a broken book again in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-kavita-control": {
    kind: "app-kavita-control",
    describe: (name) => `Scan libraries or back up the database in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-audiobookshelf-control": {
    kind: "app-audiobookshelf-control",
    describe: (name) =>
      `Scan a library, make a backup, or make a playlist and add, move, or take out books in your lists in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-nzbget-control": {
    kind: "app-nzbget-control",
    describe: (name) =>
      `Pause, resume, reorder, prioritize, categorize, retry, add or remove downloads, or change the speed limit in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-transmission-control": {
    kind: "app-transmission-control",
    describe: (name) =>
      `Pause, resume, recheck, reorder, label, add, or remove torrents (keeping or deleting their files), or change speed, queue, seeding and ratio settings in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-deluge-control": {
    kind: "app-deluge-control",
    describe: (name) =>
      `Pause, resume, recheck, reorder, label, add, or remove torrents (keeping or deleting their files), or change speed, queue, and seeding settings in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-immich-control": {
    kind: "app-immich-control",
    describe: (name) =>
      `Pause, resume, or run job queues, clear failed jobs, back up the database, share a photo, make or fill albums, or flip and rotate photos (Immich's own edits, the original file untouched) in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-plex-control": {
    kind: "app-plex-control",
    describe: (name) =>
      `Scan libraries, mark titles watched, edit or refresh a title, empty a library's trash, run Plex's maintenance, or change server settings in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-jellyfin-control": {
    kind: "app-jellyfin-control",
    describe: (name) =>
      `Scan libraries, stop a stream, or run, stop, or turn off a scheduled task in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-lidarr-control": {
    kind: "app-lidarr-control",
    describe: (name) => `Search for albums or replace a stuck download in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-api-call": {
    kind: "app-api-call",
    describe: (name) => `A request to ${name}'s own API`,
    changes: true,
    guardrail: true,
  },
  "free-memory": {
    kind: "free-memory",
    describe: () => "Free memory: close an app on this machine, or free Hearth's voice",
    changes: true,
    guardrail: true,
  },
  "lab-transfer": {
    kind: "lab-transfer",
    describe: () => "Hearth Transfer (removed from Hearth)",
    changes: true,
    guardrail: true,
  },
  "build-docker": {
    kind: "build-docker",
    describe: () => "Install Docker on this computer",
    changes: true,
    guardrail: true,
  },
  "build-tailscale": {
    kind: "build-tailscale",
    describe: () => "Install Tailscale on this computer",
    changes: true,
    guardrail: true,
  },
  "build-app": {
    kind: "build-app",
    describe: (name) => `Set up ${name} from Hearth's recipe`,
    changes: true,
    guardrail: true,
  },
  "build-connect": {
    kind: "build-connect",
    describe: () => "Connect your new apps to each other",
    changes: true,
    guardrail: true,
  },
  "browser-change": {
    kind: "browser-change",
    describe: (name) => `Changes in ${name}'s own web page, from Ember's browser`,
    changes: true,
    guardrail: true,
  },
  "hearth-api-call": {
    kind: "hearth-api-call",
    describe: () => "A change to Hearth itself (its settings, services, or notifications)",
    changes: true,
    guardrail: true,
  },
  "app-chaptarr-control": {
    kind: "app-chaptarr-control",
    describe: (name) => `Request or search for books, or replace a stuck download, in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-syncthing-control": {
    kind: "app-syncthing-control",
    describe: (name) => `Rescan, pause, or resume folders and devices in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-homeassistant-control": {
    kind: "app-homeassistant-control",
    describe: (name) =>
      `Run or switch automations, scripts, scenes, lights, or switches in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-bazarr-subtitles": {
    kind: "app-bazarr-subtitles",
    describe: (name) => `Search subtitles or reset providers in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-prowlarr-indexer": {
    kind: "app-prowlarr-indexer",
    describe: (name) => `Test, switch on or off, or sync indexers in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-sabnzbd-control": {
    kind: "app-sabnzbd-control",
    describe: (name) =>
      `Add, pause, resume, retry, or remove downloads, or clear warnings, in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-tautulli-control": {
    kind: "app-tautulli-control",
    describe: (name) =>
      `Change a person or a library, delete play records, back up the database, or read the lists from Plex again in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-tautulli-stop-stream": {
    kind: "app-tautulli-stop-stream",
    describe: (name) => `Stop a stream (through ${name})`,
    changes: true,
    guardrail: true,
  },
  "tinyauth-users": {
    kind: "tinyauth-users",
    describe: (name) => `Change who can sign in to ${name} (a password or a user)`,
    changes: true,
    guardrail: true,
  },
  "app-radarr-set-root-folder": {
    kind: "app-radarr-set-root-folder",
    describe: (name) => `Change a movie's root folder in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-seerr-approve": {
    kind: "app-seerr-approve",
    describe: (name) => `Approve a request in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-seerr-request": {
    kind: "app-seerr-request",
    describe: (name) => `Request a movie or show in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-seerr-mark-available": {
    kind: "app-seerr-mark-available",
    describe: (name) => `Tell ${name} a title is already in the library`,
    changes: true,
    guardrail: true,
  },
  "app-seerr-retry": {
    kind: "app-seerr-retry",
    describe: (name) => `Retry a failed request in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-seerr-search-on-add": {
    kind: "app-seerr-search-on-add",
    describe: (name) => `Change whether ${name} searches as soon as a movie is requested`,
    changes: true,
    guardrail: true,
  },
  "app-seerr-issue": {
    kind: "app-seerr-issue",
    describe: (name) => `Comment on, resolve, reopen or delete an issue in ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-seerr-remove": {
    kind: "app-seerr-remove",
    describe: (name) => `Remove a request from ${name}`,
    changes: true,
    guardrail: true,
  },
  "app-seerr-decline": {
    kind: "app-seerr-decline",
    describe: (name) => `Decline a request in ${name}`,
    changes: true,
    guardrail: true,
  },
  "credential-import": {
    kind: "credential-import",
    describe: (name) => `Store ${name}'s key in Secure Vault, from its own settings file`,
    changes: true,
    guardrail: true,
  },
};

export type Requester = "you" | "dragon-control" | "agent";

export type PolicyDecision =
  | { outcome: "allow"; reason: string }
  | { outcome: "approve-first"; reason: string }
  | { outcome: "refuse"; reason: string };

export const AUTONOMY_TITLES: Record<Autonomy, string> = {
  monitor: "Monitor",
  diagnose: "Diagnose",
  ask: "Ask before fixing",
  auto: "Fix automatically",
};

export interface PolicyInput {
  action: ActionDefinition;
  requestedBy: Requester;
  /** Effective level for the service's area. */
  level: Autonomy;
  /** The area's name, for explanations ("Media servers"). */
  area: string;
  /** You approved this specific action. */
  approved?: boolean;
  /** The target is one of your real systems, not sample data. */
  live: boolean;
  /** You switched on automatic repairs for your real systems. */
  liveRepairs: boolean;
  /** The container is labelled as a disposable test container. */
  sandbox: boolean;
  /** The owner put this service on the do-not-touch list (Settings > Homelab rules), with why. */
  doNotTouch?: string;
}

/**
 * The whole policy. You can always act on your own systems (the UI asks
 * you to confirm). Anything else is held to the autonomy level of the
 * service's area, re-checked at the moment of execution.
 */
export function decideAction(p: PolicyInput): PolicyDecision {
  const levelName = AUTONOMY_TITLES[p.level];

  if (p.requestedBy === "you") return { outcome: "allow", reason: "You asked for it." };

  if (!p.action.changes) {
    if (p.action.kind === "inspect-logs" && p.level === "monitor") {
      return {
        outcome: "refuse",
        reason: `${p.area} is set to Monitor, so Hearth only watches and does not investigate.`,
      };
    }
    return { outcome: "allow", reason: "It only looks; nothing changes." };
  }

  // Before approvals and autonomy: the list means "only I change this", so even a plan the
  // owner approved earlier stops here once the service is on it.
  if (p.doNotTouch !== undefined) {
    return {
      outcome: "refuse",
      reason: `You put this on your do-not-touch list${p.doNotTouch ? ` (${p.doNotTouch})` : ""}, so only you change it.`,
    };
  }

  if (p.level === "monitor" || p.level === "diagnose") {
    return {
      outcome: "refuse",
      reason: `${p.area} is set to ${levelName}, so Hearth does not change anything there.`,
    };
  }

  if (p.approved) return { outcome: "allow", reason: "You approved it." };

  if (p.action.guardrail) {
    return {
      outcome: "approve-first",
      reason: "This kind of change always needs your approval, whatever the settings say.",
    };
  }

  if (p.level === "ask") {
    return {
      outcome: "approve-first",
      reason: `${p.area} is set to Ask before fixing.`,
    };
  }

  if (p.live && !p.liveRepairs && !p.sandbox) {
    return {
      outcome: "approve-first",
      reason:
        "Automatic repairs on your own systems are switched off, so this waits for your approval.",
    };
  }

  return {
    outcome: "allow",
    reason: p.sandbox
      ? `Allowed: ${p.area} is set to Fix automatically, and this is a test container.`
      : `Allowed: ${p.area} is set to Fix automatically.`,
  };
}
