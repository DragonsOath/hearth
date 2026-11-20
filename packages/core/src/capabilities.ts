import type { AppKind } from "./apps";
import type { ActionKind } from "./policy";

/**
 * What Hearth can do in each app, where it is on screen, and how it was verified (native panels
 * Phase 1; private/docs/HEARTH_NATIVE_PANELS_ARCHITECTURE.md section 2.4).
 *
 * This list DESCRIBES. It never grants anything: whether a change may run, and whether it needs the
 * owner's approval, is decided by the backend policy (`ACTIONS`, `decideAction`), the vault and Full
 * access, exactly as before. A capability here that the policy does not allow is a documentation
 * bug, not a permission. One capability serves the panel, Ember (the same typed operation, or
 * `app_api`), task verification, and Show & Tell (its `panel` says where to look).
 */

/**
 * How much a capability can affect, finer than the policy's investigation/configuration split so
 * that a future, owner-authorized "routine changes" scope can be expressed as data (refinement B).
 * Nothing reads this to skip an approval today.
 *
 * - read: only reads.
 * - routine: a small, reversible change to the app's own state (switch an indexer on or off).
 * - consequential: makes the app act or reach outside (search indexers, grab, import, invite).
 * - destructive: removes something that cannot simply be put back (delete a file, an invitation).
 * - protected: networking, VPN, proxy, firewall (never through an app panel).
 * - security-sensitive: logins, keys, password resets.
 */
export type CapabilityRisk =
  "read" | "routine" | "consequential" | "destructive" | "protected" | "security-sensitive";

/** How a capability is checked against a real app. */
export interface CapabilityEvidence {
  /** The app version it was checked on. */
  version: string;
  /**
   * production-read: read on the owner's installation through Hearth's reader (read-only).
   * official-spec: the endpoint is in the app's official API document for that exact version.
   * stand-in: Hearth's tests against its stand-in app.
   */
  how: "production-read" | "official-spec" | "stand-in" | "test-instance";
  date: string;
}

export interface AppCapability {
  /** Stable id: "<app>.<area>.<verb>". */
  id: string;
  app: AppKind;
  /** Plain words, as the owner would say it. */
  label: string;
  risk: CapabilityRisk;
  /** The typed operation that performs a change (the same one Ember plans). Absent for reads. */
  operation?: ActionKind;
  /** The app's endpoints involved (method and path, no keys). */
  api: string[];
  /**
   * Where it is in Hearth's panel: the tab (with an optional position inside it) and the stable
   * target of the view or control (data-hearth-target). Absent when there is no panel control
   * yet: Ember can still do it (through `operation` or app_api), the owner cannot click it.
   */
  panel?: { tab: string; target: string };
  evidence: CapabilityEvidence[];
}

/** The major versions each app's panel is built and verified for (D8). */
export const SUPPORTED_MAJORS: Partial<Record<AppKind, number[]>> = {
  radarr: [6],
  sonarr: [4],
  prowlarr: [2],
  lidarr: [3],
  wizarr: [2],
  tautulli: [2],
  plex: [1],
  jellyfin: [12],
  sabnzbd: [5],
  seerr: [3],
  qbittorrent: [5],
  romm: [5],
  pihole: [6],
  adguard: [0],
  proxmox: [9],
  npm: [2],
  traefik: [3],
  portainer: [2],
  uptimekuma: [1, 2],
  nextcloud: [35],
  paperless: [2, 3],
  vaultwarden: [1],
  tailscale: [2],
  wgeasy: [15],
  navidrome: [0],
  komga: [1],
  mealie: [3],
  actual: [26],
  authentik: [2026],
  frigate: [0],
  authelia: [4],
  // Gitea 1, and Forgejo 13 (which answers Gitea's API under its own version).
  gitea: [1, 13],
  transmission: [3, 4],
  nzbget: [21, 22, 23, 24, 25, 26],
  emby: [4],
};

const PROD = (version: string): CapabilityEvidence => ({
  version,
  how: "production-read",
  date: "2026-10-31",
});
const SPEC = (version: string): CapabilityEvidence => ({
  version,
  how: "official-spec",
  date: "2026-10-31",
});
const RADARR = "6.4.4.10685";
const SONARR = "4.0.20.3014";
const PROWLARR = "2.6.5.5623";
const LIDARR = "3.1.0.4875";
const WIZARR = "2.2.1";
/** Wizarr's admin pages, checked against its source at this tag (the owner's version). */
const WIZARR_ADMIN = "2026.9.1";
const SAB = "5.1.3";
/** Checked on the disposable test SABnzbd (internal network, no Usenet servers). */
const SAB_TESTED: CapabilityEvidence = { version: SAB, how: "test-instance", date: "2026-11-01" };
const SAB_DOWNLOADS_TESTED: CapabilityEvidence = {
  version: SAB,
  how: "test-instance",
  date: "2026-11-02",
};
const ROMM = "5.3.1";
/** Checked on the disposable test RomM (internal network, invented games, no metadata sources). */
const ROMM_TESTED: CapabilityEvidence = { version: ROMM, how: "test-instance", date: "2026-11-02" };
const SEERR = "3.5.0";
/** Checked on the disposable test Seerr (wired to the test Radarr, Sonarr and Jellyfin). */
const SEERR_TESTED: CapabilityEvidence = {
  version: SEERR,
  how: "test-instance",
  date: "2026-11-01",
};
const QBT = "5.2.4";
/** Checked on the disposable test qBittorrent (internal network, no internet). */
const QBT_TESTED: CapabilityEvidence = { version: QBT, how: "test-instance", date: "2026-11-01" };
const QBT_TORRENTS_TESTED: CapabilityEvidence = {
  version: QBT,
  how: "test-instance",
  date: "2026-11-02",
};

const PIHOLE = "6.5 (FTL 6.8)";
/** Checked on a disposable pihole/pihole container (pihole-real.test.ts), then removed. */
const PIHOLE_TESTED: CapabilityEvidence = {
  version: PIHOLE,
  how: "test-instance",
  date: "2026-11-07",
};
/** Proxmox VE's own API schema (pve-docs), read from its GitHub mirror: no real Proxmox could run here. */
const PROXMOX_SPEC: CapabilityEvidence = {
  version: "9-api",
  how: "official-spec",
  date: "2026-11-08",
};
const PROXMOX_STAND: CapabilityEvidence = { version: "9-api", how: "stand-in", date: "2026-11-08" };
/** Checked on a disposable jc21/nginx-proxy-manager container (npm-real.test.ts), then removed. */
const NPM_TESTED: CapabilityEvidence = {
  version: "2.16.0",
  how: "test-instance",
  date: "2026-11-08",
};
/** Read from a disposable traefik:v3 container (traefik-real.test.ts), then removed. */
const TRAEFIK_TESTED: CapabilityEvidence = {
  version: "3.7.17",
  how: "test-instance",
  date: "2026-11-08",
};
/** Checked on a disposable portainer/portainer-ce container (portainer-real.test.ts), then removed. */
const PORTAINER_TESTED: CapabilityEvidence = {
  version: "2.45.3",
  how: "test-instance",
  date: "2026-11-08",
};
/** Checked on a disposable emby/embyserver container (emby-real.test.ts), then removed. */
const EMBY_TESTED: CapabilityEvidence = {
  version: "4.10.2.0",
  how: "test-instance",
  date: "2026-11-08",
};
/** Checked on a disposable linuxserver/nzbget container (nzbget-real.test.ts), then removed. */
const NZBGET_TESTED: CapabilityEvidence = {
  version: "26.3",
  how: "test-instance",
  date: "2026-11-08",
};
/** Checked on a disposable linuxserver/transmission container (transmission-real.test.ts). */
const TRANSMISSION_TESTED: CapabilityEvidence = {
  version: "4.1.4",
  how: "test-instance",
  date: "2026-11-08",
};
/** Checked on a disposable gitea/gitea container with two act_runner runners (gitea-real.test.ts), then removed. */
const GITEA_TESTED: CapabilityEvidence = {
  version: "1.27.3",
  how: "test-instance",
  date: "2026-11-08",
};
/** Checked on a disposable codeberg.org/forgejo/forgejo container (forgejo-real.test.ts), then removed. */
const FORGEJO_TESTED: CapabilityEvidence = {
  version: "13.0.5+gitea-1.22.0",
  how: "test-instance",
  date: "2026-11-08",
};
/** Checked on a disposable ghcr.io/authelia/authelia container (authelia-real.test.ts), then removed. */
const AUTHELIA_TESTED: CapabilityEvidence = {
  version: "4.39.28",
  how: "test-instance",
  date: "2026-11-09",
};
/** Checked on a disposable ghcr.io/blakeblackshear/frigate container (frigate-real.test.ts), then removed. */
const FRIGATE_TESTED: CapabilityEvidence = {
  version: "0.18.2",
  how: "test-instance",
  date: "2026-11-09",
};
/** Checked on a disposable ghcr.io/goauthentik/server container (authentik-real.test.ts), then removed. */
const AUTHENTIK_TESTED: CapabilityEvidence = {
  version: "2026.8.5",
  how: "test-instance",
  date: "2026-11-09",
};
/** Checked on a disposable actualbudget/actual-server container (actual-real.test.ts), then removed. */
const ACTUAL_TESTED: CapabilityEvidence = {
  version: "26.11.0",
  how: "test-instance",
  date: "2026-11-08",
};
/** Checked on a disposable ghcr.io/mealie-recipes/mealie container (mealie-real.test.ts), then removed. */
const MEALIE_TESTED: CapabilityEvidence = {
  version: "3.30.0",
  how: "test-instance",
  date: "2026-11-08",
};
/** Checked on a disposable gotson/komga container (komga-real.test.ts), then removed. */
const KOMGA_TESTED: CapabilityEvidence = {
  version: "1.30.0",
  how: "test-instance",
  date: "2026-11-08",
};
/** Checked on a disposable deluan/navidrome container (navidrome-real.test.ts), then removed. */
const NAVIDROME_TESTED: CapabilityEvidence = {
  version: "0.64.2",
  how: "test-instance",
  date: "2026-11-08",
};
/** Checked on a disposable ghcr.io/wg-easy/wg-easy:15 container (wgeasy-real.test.ts), then removed. */
const WGEASY_TESTED: CapabilityEvidence = {
  version: "15",
  how: "test-instance",
  date: "2026-11-08",
};
/**
 * Tailscale's API v2 as its official client (tailscale-client-go-v2 at f9e92a8) calls it: not yet
 * run against a real tailnet, which was out of reach where this was built.
 */
const TAILSCALE_SPEC: CapabilityEvidence = {
  version: "2",
  how: "official-spec",
  date: "2026-11-08",
};
/** Checked on a disposable vaultwarden/server container (vaultwarden-real.test.ts), then removed. */
const VAULTWARDEN_TESTED: CapabilityEvidence = {
  version: "1.37.5",
  how: "test-instance",
  date: "2026-11-08",
};
/** Checked on a disposable paperlessngx/paperless-ngx container (paperless-real.test.ts), then removed. */
const PAPERLESS_TESTED: CapabilityEvidence = {
  version: "3.4.2",
  how: "test-instance",
  date: "2026-11-08",
};
/** Checked on a disposable nextcloud:apache container (nextcloud-real.test.ts), then removed. */
const NEXTCLOUD_TESTED: CapabilityEvidence = {
  version: "35.0.2",
  how: "test-instance",
  date: "2026-11-08",
};
/** Checked on disposable louislam/uptime-kuma containers, 1.x and 2.x (uptimekuma-real.test.ts). */
const KUMA_TESTED: CapabilityEvidence[] = ["2.5.9", "1.23.17"].map((version) => ({
  version,
  how: "test-instance",
  date: "2026-11-08",
}));
const ADGUARD = "0.107.80";
/** Checked on a disposable adguard/adguardhome container (adguard-real.test.ts), then removed. */
const ADGUARD_TESTED: CapabilityEvidence = {
  version: ADGUARD,
  how: "test-instance",
  date: "2026-11-07",
};

/** The same Radarr/Sonarr capability for both apps (one engine, one Hearth module). */
function arr(
  area: string,
  label: string,
  rest: Omit<AppCapability, "id" | "app" | "label" | "evidence"> & {
    evidence?: "read" | "spec";
    /**
     * Where it is in the native panel's own tabs (Activity, Wanted), which Radarr and Sonarr share
     * (Phases 2 and 3); `panel` is the older Overview place, kept for the record.
     */
    tabbed?: AppCapability["panel"];
    /** Sonarr's place when its target differs (its own item ids). */
    sonarrTabbed?: AppCapability["panel"];
  },
): AppCapability[] {
  return (["radarr", "sonarr"] as const).map((app) => {
    const v = app === "radarr" ? RADARR : SONARR;
    const { evidence = "read", tabbed, sonarrTabbed, ...cap } = rest;
    const place = app === "sonarr" ? (sonarrTabbed ?? tabbed) : tabbed;
    return {
      id: `${app}.${area}`,
      app,
      label,
      ...cap,
      ...(place ? { panel: place } : {}),
      evidence: evidence === "read" ? [PROD(v), SPEC(v)] : [SPEC(v)],
    };
  });
}

/** Checked against Hearth's stand-in Radarr 6.4 in tests; the real test Radarr adds more. */
const STAND: CapabilityEvidence = { version: RADARR, how: "stand-in", date: "2026-11-01" };

/** Exercised against the real disposable test Radarr (radarr-real.test.ts, D12). */
const TESTED: CapabilityEvidence = { version: RADARR, how: "test-instance", date: "2026-11-01" };
/** Capabilities radarr-real.test.ts covers on the real test Radarr. */
export const REAL_TESTED = new Set([
  "library.read",
  "movie.add",
  "movie.read",
  "movie.edit",
  "movie.refresh",
  "movie.remove",
  "profile.edit",
  "profile.add",
  "format.add",
  "format.preview",
  "tag.add",
  "media.edit",
  "rootfolder.add",
  "connections.edit",
  "backup.now",
  "sizes.edit",
  "exclusions.edit",
  "import.files",
]);

/** A Sonarr panel capability (Phase 3): in the official spec, and tested on the stand-in. */
function sonarr(
  area: string,
  label: string,
  risk: CapabilityRisk,
  rest: Omit<AppCapability, "id" | "app" | "label" | "risk" | "evidence">,
): AppCapability[] {
  return [
    { id: `sonarr.${area}`, app: "sonarr", label, risk, ...rest, evidence: [SPEC(SONARR), STAND] },
  ];
}

/**
 * A Prowlarr panel capability (Phase 3): in the official spec, tested on the stand-in Prowlarr
 * 2.6, and exercised on the real disposable test Prowlarr (prowlarr-real.test.ts).
 */
function prowlarr(
  area: string,
  label: string,
  risk: CapabilityRisk,
  rest: Omit<AppCapability, "id" | "app" | "label" | "risk" | "evidence">,
): AppCapability[] {
  return [
    {
      id: `prowlarr.${area}`,
      app: "prowlarr",
      label,
      risk,
      ...rest,
      evidence: [
        SPEC(PROWLARR),
        { version: PROWLARR, how: "stand-in", date: "2026-11-01" },
        { version: PROWLARR, how: "test-instance", date: "2026-11-01" },
      ],
    },
  ];
}

/**
 * A Lidarr panel capability (Phase 3): in the official spec, tested on the stand-in Lidarr 3.1,
 * and exercised on the real disposable test Lidarr (lidarr-real.test.ts).
 */
function lidarr(
  area: string,
  label: string,
  risk: CapabilityRisk,
  rest: Omit<AppCapability, "id" | "app" | "label" | "risk" | "evidence">,
): AppCapability[] {
  return [
    {
      id: `lidarr.${area}`,
      app: "lidarr",
      label,
      risk,
      ...rest,
      evidence: [
        SPEC(LIDARR),
        { version: LIDARR, how: "stand-in", date: "2026-11-01" },
        { version: LIDARR, how: "test-instance", date: "2026-11-01" },
      ],
    },
  ];
}

const JELLYFIN = "12.2.0";

/**
 * A Jellyfin panel capability (People, Devices, Activity, System): its endpoints are in the test
 * Jellyfin's own OpenAPI document, tested on the stand-in and on the real disposable test Jellyfin
 * (jellyfin-real.test.ts). Controls for one person open from their "Change access" button.
 */
function jellyfin(
  area: string,
  label: string,
  risk: CapabilityRisk,
  rest: Omit<AppCapability, "id" | "app" | "label" | "risk" | "evidence">,
): AppCapability[] {
  return [
    {
      id: `jellyfin.${area}`,
      app: "jellyfin",
      label,
      risk,
      ...rest,
      evidence: [
        { version: JELLYFIN, how: "stand-in", date: "2026-11-01" },
        { version: JELLYFIN, how: "test-instance", date: "2026-11-01" },
      ],
    },
  ];
}

const PLEX = "1.43.4.10903";

/**
 * A Plex panel capability (Library, History, Tasks, Settings): its endpoints are in Plex's official
 * PMS API document, tested on the stand-in and on the real disposable test Plex
 * (plex-real.test.ts). Sharing, users and remote access stay in Plex.
 */
function plex(
  area: string,
  label: string,
  risk: CapabilityRisk,
  rest: Omit<AppCapability, "id" | "app" | "label" | "risk" | "evidence">,
): AppCapability[] {
  return [
    {
      id: `plex.${area}`,
      app: "plex",
      label,
      risk,
      ...rest,
      evidence: [
        SPEC(PLEX),
        { version: PLEX, how: "stand-in", date: "2026-11-02" },
        { version: PLEX, how: "test-instance", date: "2026-11-02" },
      ],
    },
  ];
}

const TAUTULLI = "2.18.2";

/**
 * A Tautulli panel capability (History, People, Libraries, Graphs, System). Tautulli has one
 * endpoint and a command per call, written "GET /api/v2?cmd=<command>": each is in the test
 * Tautulli's own command list, tested on the stand-in and on the real disposable test Tautulli.
 */
function tautulli(
  area: string,
  label: string,
  risk: CapabilityRisk,
  rest: Omit<AppCapability, "id" | "app" | "label" | "risk" | "evidence">,
): AppCapability[] {
  return [
    {
      id: `tautulli.${area}`,
      app: "tautulli",
      label,
      risk,
      ...rest,
      evidence: [
        { version: TAUTULLI, how: "stand-in", date: "2026-11-02" },
        { version: TAUTULLI, how: "test-instance", date: "2026-11-02" },
      ],
    },
  ];
}

/** A Radarr panel capability (Phase 2): in the official spec, and tested on the stand-in. */
function radarr(
  area: string,
  label: string,
  risk: CapabilityRisk,
  rest: Omit<AppCapability, "id" | "app" | "label" | "risk" | "evidence">,
): AppCapability[] {
  return [
    {
      id: `radarr.${area}`,
      app: "radarr",
      label,
      risk,
      ...rest,
      evidence: [SPEC(RADARR), STAND, ...(REAL_TESTED.has(area) ? [TESTED] : [])],
    },
  ];
}

export const CAPABILITIES: readonly AppCapability[] = [
  // Emby: the Jellyfin panel's code (Emby speaks the same API), for what a real Emby passed.
  {
    id: "emby.people.read",
    app: "emby",
    label: "See everyone who can sign in, and the libraries each can open",
    risk: "read",
    api: ["GET /Users", "GET /Library/VirtualFolders"],
    panel: { tab: "people", target: "people:list" },
    evidence: [EMBY_TESTED],
  },
  {
    id: "emby.user.access",
    app: "emby",
    label: "Turn someone's account off or on, or change which libraries they can open",
    risk: "consequential",
    operation: "app-jellyfin-control",
    api: ["GET /Users/{Id}", "POST /Users/{Id}/Policy"],
    panel: { tab: "people", target: "people:list" },
    evidence: [EMBY_TESTED],
  },
  {
    id: "emby.user.remove",
    app: "emby",
    label: "Remove someone's account (never an administrator's)",
    risk: "destructive",
    operation: "app-jellyfin-control",
    api: ["GET /Users/{Id}", "DELETE /Users/{Id}"],
    panel: { tab: "people", target: "people:list" },
    evidence: [EMBY_TESTED],
  },
  {
    id: "emby.devices",
    app: "emby",
    label: "See the apps and devices signed in, and sign one out",
    risk: "consequential",
    operation: "app-jellyfin-control",
    api: ["GET /Devices", "DELETE /Devices"],
    panel: { tab: "devices", target: "devices:list" },
    evidence: [EMBY_TESTED],
  },
  {
    id: "emby.activity.read",
    app: "emby",
    label: "See Emby's activity and read its own logs, keys hidden",
    risk: "read",
    api: ["GET /System/ActivityLog/Entries", "GET /System/Logs", "GET /System/Logs/Log"],
    panel: { tab: "activity", target: "activity:list" },
    evidence: [EMBY_TESTED],
  },
  {
    id: "emby.library.read",
    app: "emby",
    label: "Browse each library and open a title: details, files, watched",
    risk: "read",
    api: ["GET /Items", "GET /Users/{UserId}/Items/{Id}"],
    panel: { tab: "library", target: "tab:library" },
    evidence: [EMBY_TESTED],
  },
  {
    id: "emby.item.edit",
    app: "emby",
    label: "Mark a title watched or not, edit its details, refresh it",
    risk: "consequential",
    operation: "app-jellyfin-control",
    api: [
      "POST /Users/{UserId}/PlayedItems/{Id}",
      "DELETE /Users/{UserId}/PlayedItems/{Id}",
      "POST /Items/{ItemId}",
      "POST /Items/{Id}/Refresh",
    ],
    panel: { tab: "library", target: "tab:library" },
    evidence: [EMBY_TESTED],
  },
  {
    id: "emby.libraries",
    app: "emby",
    label: "Add a library or a folder to one, stop reading a folder, remove a library",
    risk: "destructive",
    operation: "app-jellyfin-control",
    api: [
      "POST /Environment/ValidatePath",
      "POST /Library/VirtualFolders",
      "POST /Library/VirtualFolders/Paths",
      "POST /Library/VirtualFolders/Paths/Delete",
      "POST /Library/VirtualFolders/Delete",
    ],
    panel: { tab: "manage", target: "tab:manage" },
    evidence: [EMBY_TESTED],
  },
  {
    id: "emby.settings",
    app: "emby",
    label: "Change Emby's everyday server and converting settings",
    risk: "consequential",
    operation: "app-jellyfin-control",
    api: [
      "GET /System/Configuration",
      "POST /System/Configuration",
      "GET /System/Configuration/{Key}",
      "POST /System/Configuration/{Key}",
    ],
    panel: { tab: "config", target: "tab:config" },
    evidence: [EMBY_TESTED],
  },
  {
    id: "emby.plugins",
    app: "emby",
    label: "See installed plugins, remove one, and restart Emby to finish",
    risk: "consequential",
    operation: "app-jellyfin-control",
    api: ["GET /Plugins", "POST /Plugins/{Id}/Delete", "POST /System/Restart"],
    panel: { tab: "plugins", target: "tab:plugins" },
    evidence: [EMBY_TESTED],
  },
  {
    id: "emby.tasks",
    app: "emby",
    label: "Scan every library, and run Emby's scheduled tasks",
    risk: "routine",
    operation: "app-jellyfin-control",
    api: ["GET /ScheduledTasks", "POST /ScheduledTasks/Running/{Id}", "POST /Library/Refresh"],
    panel: { tab: "tasks", target: "tab:tasks" },
    evidence: [EMBY_TESTED],
  },
  // NZBGet: SABnzbd's screens, through its JSON-RPC.
  {
    id: "nzbget.read",
    app: "nzbget",
    label: "See the queue, speed, free space, history with why each failed, and NZBGet's warnings",
    risk: "read",
    api: [
      "RPC version",
      "RPC status",
      "RPC listgroups",
      "RPC history",
      "RPC listfiles",
      "RPC config",
      "RPC systemhealth",
      "RPC log",
    ],
    panel: { tab: "downloads", target: "downloads:search" },
    evidence: [NZBGET_TESTED],
  },
  {
    id: "nzbget.pause",
    app: "nzbget",
    label: "Pause or resume everything, pause for a while, or limit the speed",
    risk: "routine",
    operation: "app-nzbget-control",
    api: ["RPC pausedownload", "RPC resumedownload", "RPC scheduleresume", "RPC rate"],
    panel: { tab: "overview", target: "sab:speed-limit" },
    evidence: [NZBGET_TESTED],
  },
  {
    id: "nzbget.job",
    app: "nzbget",
    label: "Pause, resume, prioritize, move, categorize or remove a download; retry a failed one",
    risk: "consequential",
    operation: "app-nzbget-control",
    api: ["RPC editqueue"],
    panel: { tab: "downloads/1", target: "job:priority" },
    evidence: [NZBGET_TESTED],
  },
  {
    id: "nzbget.add",
    app: "nzbget",
    label: "Add NZBs: links or .nzb files, with a category, a priority or paused",
    risk: "consequential",
    operation: "app-nzbget-control",
    api: ["RPC append"],
    panel: { tab: "downloads", target: "downloads:add" },
    evidence: [NZBGET_TESTED],
  },
  // Transmission: the shared torrent screens, through its RPC.
  {
    id: "transmission.torrents.read",
    app: "transmission",
    label:
      "See every torrent: progress, speeds, time left, ratio, labels, tracker; find and filter",
    risk: "read",
    api: [
      "RPC session-get",
      "RPC session-stats",
      "RPC torrent-get",
      "RPC free-space",
      "RPC port-test",
    ],
    panel: { tab: "torrents", target: "torrents:search" },
    evidence: [TRANSMISSION_TESTED],
  },
  {
    id: "transmission.torrent.control",
    app: "transmission",
    label: "Pause, resume, recheck, ask trackers again, reorder the queue, label, choose files",
    risk: "routine",
    operation: "app-transmission-control",
    api: [
      "RPC torrent-start",
      "RPC torrent-stop",
      "RPC torrent-verify",
      "RPC torrent-reannounce",
      "RPC queue-move-top",
      "RPC queue-move-up",
      "RPC queue-move-down",
      "RPC queue-move-bottom",
      "RPC torrent-set",
    ],
    panel: { tab: `torrents/${"01".repeat(20)}`, target: "torrent:pause-resume" },
    evidence: [TRANSMISSION_TESTED],
  },
  {
    id: "transmission.torrent.add",
    app: "transmission",
    label:
      "Add torrents: magnet links, .torrent addresses or files, with a label, started or paused",
    risk: "consequential",
    operation: "app-transmission-control",
    api: ["RPC torrent-add"],
    panel: { tab: "torrents", target: "torrents:add" },
    evidence: [TRANSMISSION_TESTED],
  },
  {
    id: "transmission.torrent.remove",
    app: "transmission",
    label: "Remove a torrent, keeping its files or deleting them",
    risk: "destructive",
    operation: "app-transmission-control",
    api: ["RPC torrent-remove"],
    panel: { tab: `torrents/${"01".repeat(20)}`, target: "torrent:remove" },
    evidence: [TRANSMISSION_TESTED],
  },
  {
    id: "transmission.settings",
    app: "transmission",
    label: "Change speed limits, the turtle, share ratio and idle limits, queue and peer limits",
    risk: "consequential",
    operation: "app-transmission-control",
    api: ["RPC session-get", "RPC session-set"],
    panel: { tab: "config", target: "settings:review" },
    evidence: [TRANSMISSION_TESTED],
  },
  // Uptime Kuma: its socket's events (it has no REST API for monitors).
  {
    id: "uptimekuma.read",
    app: "uptimekuma",
    label:
      "See every monitor up or down, its recent checks, response time, uptime and certificate, and recent state changes",
    risk: "read",
    api: ["SOCKET login", "SOCKET loginByToken"],
    panel: { tab: "overview", target: "tab:monitors:open" },
    evidence: KUMA_TESTED,
  },
  {
    id: "uptimekuma.monitors",
    app: "uptimekuma",
    label: "Pause or resume a monitor",
    risk: "routine",
    operation: "app-uptimekuma-control",
    api: ["SOCKET pauseMonitor", "SOCKET resumeMonitor"],
    panel: { tab: "monitors", target: "monitors:find" },
    evidence: KUMA_TESTED,
  },
  {
    id: "uptimekuma.add",
    app: "uptimekuma",
    label: "Add a website monitor",
    risk: "consequential",
    operation: "app-uptimekuma-control",
    api: ["SOCKET add"],
    panel: { tab: "monitors", target: "add:url" },
    evidence: KUMA_TESTED,
  },
  {
    id: "uptimekuma.remove",
    app: "uptimekuma",
    label: "Remove a monitor and its history",
    risk: "destructive",
    operation: "app-uptimekuma-control",
    api: ["SOCKET deleteMonitor"],
    panel: { tab: "monitors", target: "monitors:find" },
    evidence: KUMA_TESTED,
  },
  {
    id: "uptimekuma.maintenance",
    app: "uptimekuma",
    label: "Pause or resume a maintenance window",
    risk: "routine",
    operation: "app-uptimekuma-control",
    api: ["SOCKET pauseMaintenance", "SOCKET resumeMaintenance"],
    panel: { tab: "overview", target: "tab:monitors:open" },
    evidence: KUMA_TESTED,
  },
  // Navidrome: its own API and its Subsonic API, after one sign-in.
  {
    id: "navidrome.read",
    app: "navidrome",
    label:
      "See the library and its last scan, who is listening now, users and their players, and files it can no longer find",
    risk: "read",
    api: [
      "POST /auth/login",
      "GET /rest/getScanStatus",
      "GET /rest/getNowPlaying",
      "GET /api/library",
      "GET /api/user",
      "GET /api/player",
      "GET /api/missing",
      "GET /api/playlist",
      "GET /api/share",
    ],
    panel: { tab: "overview", target: "tab:people:open" },
    evidence: [NAVIDROME_TESTED],
  },
  {
    id: "navidrome.scan",
    app: "navidrome",
    label: "Scan the library, quick or full",
    risk: "routine",
    operation: "app-navidrome-control",
    api: ["GET /rest/startScan", "GET /rest/getScanStatus"],
    panel: { tab: "overview", target: "navidrome:scan" },
    evidence: [NAVIDROME_TESTED],
  },
  {
    id: "navidrome.missing",
    app: "navidrome",
    label: "Forget files it can no longer find",
    risk: "destructive",
    operation: "app-navidrome-control",
    api: ["DELETE /api/missing"],
    panel: { tab: "overview", target: "navidrome:scan" },
    evidence: [NAVIDROME_TESTED],
  },
  {
    id: "navidrome.users",
    app: "navidrome",
    label: "Make a user an administrator or an ordinary user, or remove them",
    risk: "consequential",
    operation: "app-navidrome-control",
    api: ["GET /api/user/{id}", "PUT /api/user/{id}", "DELETE /api/user/{id}"],
    panel: { tab: "people", target: "people:find" },
    evidence: [NAVIDROME_TESTED],
  },
  // Gitea: its REST API with an administrator's access token. Never a registration token or secret.
  {
    id: "gitea.read",
    app: "gitea",
    label:
      "See repositories and mirrors, Actions runners and recent runs, people and scheduled tasks",
    risk: "read",
    api: [
      "GET /api/v1/version",
      "GET /api/v1/repos/search",
      "GET /api/v1/admin/users",
      "GET /api/v1/admin/orgs",
      "GET /api/v1/admin/cron",
      "GET /api/v1/repos/{id}/{id}/actions/runs",
    ],
    panel: { tab: "overview", target: "gitea:repos" },
    evidence: [GITEA_TESTED, FORGEJO_TESTED],
  },
  {
    // Forgejo has neither list: its runners show only on its own page, its runs per repository.
    id: "gitea.actions-read",
    app: "gitea",
    label: "See every Actions runner and the recent runs across all repositories",
    risk: "read",
    api: ["GET /api/v1/admin/actions/runners", "GET /api/v1/admin/actions/runs"],
    panel: { tab: "actions", target: "actions:runners" },
    evidence: [GITEA_TESTED],
  },
  {
    id: "gitea.mirror",
    app: "gitea",
    label: "Sync a pull mirror now",
    risk: "routine",
    operation: "app-gitea-control",
    api: ["POST /api/v1/repos/{id}/{id}/mirror-sync", "GET /api/v1/repos/{id}/{id}"],
    panel: { tab: "overview", target: "gitea:mirrors" },
    evidence: [GITEA_TESTED, FORGEJO_TESTED],
  },
  {
    id: "gitea.rerun",
    app: "gitea",
    label: "Run a workflow run's failed jobs again",
    risk: "routine",
    operation: "app-gitea-control",
    api: [
      "POST /api/v1/repos/{id}/{id}/actions/runs/{id}/rerun-failed-jobs",
      "GET /api/v1/repos/{id}/{id}/actions/runs/{id}",
    ],
    panel: { tab: "actions", target: "actions:runs" },
    evidence: [GITEA_TESTED],
  },
  {
    id: "gitea.runners",
    app: "gitea",
    label: "Turn an Actions runner off or on, or remove it",
    risk: "consequential",
    operation: "app-gitea-control",
    api: [
      "GET /api/v1/admin/actions/runners/{id}",
      "PATCH /api/v1/admin/actions/runners/{id}",
      "DELETE /api/v1/admin/actions/runners/{id}",
    ],
    panel: { tab: "actions", target: "actions:runners" },
    evidence: [GITEA_TESTED],
  },
  {
    id: "gitea.tasks",
    app: "gitea",
    label: "Run one of Gitea's scheduled tasks now",
    risk: "routine",
    operation: "app-gitea-control",
    api: ["POST /api/v1/admin/cron/{id}"],
    panel: { tab: "actions", target: "actions:tasks" },
    evidence: [GITEA_TESTED, FORGEJO_TESTED],
  },
  // Authelia, a light panel: its health check and metrics, no key and nothing personal.
  {
    id: "authelia.read",
    app: "authelia",
    label:
      "See whether sign-in is healthy, and sign-ins, failed and banned sign-ins since it started",
    risk: "read",
    api: ["GET /api/health", "GET /metrics"],
    panel: { tab: "overview", target: "authelia:sign-ins" },
    evidence: [AUTHELIA_TESTED],
  },
  // Frigate: its API on the signed-in port. Never /api/config, which holds camera stream addresses.
  {
    id: "frigate.read",
    app: "frigate",
    label:
      "See each camera and its detection, the detectors, recent events, today's alerts and storage",
    risk: "read",
    api: [
      "POST /api/login",
      "GET /api/stats",
      "GET /api/events",
      "GET /api/review/summary",
      "GET /api/recordings/storage",
      "GET /api/version",
    ],
    panel: { tab: "overview", target: "frigate:cameras" },
    evidence: [FRIGATE_TESTED],
  },
  {
    id: "frigate.cameras",
    app: "frigate",
    label: "Turn a camera's detection or recording on or off",
    risk: "consequential",
    operation: "app-frigate-control",
    api: ["PUT /api/camera/{id}/set/{id}", "GET /api/stats"],
    panel: { tab: "overview", target: "frigate:cameras" },
    evidence: [FRIGATE_TESTED],
  },
  {
    id: "frigate.events",
    app: "frigate",
    label: "Keep an event forever, stop keeping it, or delete it",
    risk: "destructive",
    operation: "app-frigate-control",
    api: [
      "GET /api/events/{id}",
      "POST /api/events/{id}/retain",
      "DELETE /api/events/{id}/retain",
      "DELETE /api/events/{id}",
    ],
    panel: { tab: "overview", target: "frigate:events" },
    evidence: [FRIGATE_TESTED],
  },
  {
    id: "frigate.restart",
    app: "frigate",
    label: "Restart Frigate",
    risk: "consequential",
    operation: "app-frigate-control",
    api: ["POST /api/restart", "GET /api/version"],
    panel: { tab: "overview", target: "frigate:cameras" },
    evidence: [FRIGATE_TESTED],
  },
  // Authentik: its API, never a secret. Not /admin/system/, which echoes the request's token.
  {
    id: "authentik.read",
    app: "authentik",
    label:
      "See sign-ins and failed sign-ins, people, the apps it protects, outposts, background tasks and certificates",
    risk: "read",
    api: [
      "GET /api/v3/admin/version/",
      "GET /api/v3/events/events/",
      "GET /api/v3/core/users/",
      "GET /api/v3/core/users/me/",
      "GET /api/v3/core/applications/",
      "GET /api/v3/outposts/instances/",
      "GET /api/v3/outposts/instances/{id}/health/",
      "GET /api/v3/tasks/workers/",
      "GET /api/v3/tasks/tasks/status/",
      "GET /api/v3/tasks/tasks/",
      "GET /api/v3/crypto/certificatekeypairs/",
    ],
    panel: { tab: "overview", target: "authentik:sign-ins" },
    evidence: [AUTHENTIK_TESTED],
  },
  {
    id: "authentik.accounts",
    app: "authentik",
    label: "Turn a person's account off or on (protected)",
    risk: "consequential",
    operation: "app-authentik-control",
    api: ["PATCH /api/v3/core/users/{id}/", "GET /api/v3/core/users/{id}/"],
    panel: { tab: "people", target: "people:list" },
    evidence: [AUTHENTIK_TESTED],
  },
  {
    id: "authentik.tasks",
    app: "authentik",
    label: "Retry a background task that failed",
    risk: "routine",
    operation: "app-authentik-control",
    api: ["POST /api/v3/tasks/tasks/{id}/retry/"],
    panel: { tab: "overview", target: "authentik:health" },
    evidence: [AUTHENTIK_TESTED],
  },
  // Actual Budget, a light panel: read only, and never a budget's contents.
  {
    id: "actual.read",
    app: "actual",
    label:
      "See whether its server is healthy, its version, memory and uptime, and the names of its budget files",
    risk: "read",
    api: [
      "GET /health",
      "GET /info",
      "GET /metrics",
      "GET /account/needs-bootstrap",
      "GET /account/login-methods",
      "POST /account/login",
      "GET /sync/list-user-files",
    ],
    panel: { tab: "overview", target: "actual:budgets" },
    evidence: [ACTUAL_TESTED],
  },
  // Mealie, a light panel: its admin API. Never the database address its overview carries.
  {
    id: "mealie.read",
    app: "mealie",
    label:
      "See its version, setup checks, counts, storage and backups, and whether the first-run administrator is still there",
    risk: "read",
    api: [
      "GET /api/admin/about",
      "GET /api/admin/about/statistics",
      "GET /api/admin/about/check",
      "GET /api/admin/maintenance",
      "GET /api/admin/maintenance/storage",
      "GET /api/admin/backups",
      "GET /api/admin/users",
    ],
    panel: { tab: "overview", target: "mealie:health" },
    evidence: [MEALIE_TESTED],
  },
  {
    id: "mealie.backup",
    app: "mealie",
    label: "Make a backup now",
    risk: "routine",
    operation: "app-mealie-control",
    api: ["POST /api/admin/backups"],
    panel: { tab: "overview", target: "mealie:backups" },
    evidence: [MEALIE_TESTED],
  },
  {
    id: "mealie.maintenance",
    app: "mealie",
    label:
      "Clean temporary files, delete unused images, remove empty recipe folders, unlock locked accounts",
    risk: "consequential",
    operation: "app-mealie-control",
    api: [
      "POST /api/admin/maintenance/clean/temp",
      "POST /api/admin/maintenance/clean/images",
      "POST /api/admin/maintenance/clean/recipe-folders",
      "POST /api/admin/users/unlock",
    ],
    panel: { tab: "overview", target: "mealie:maintenance" },
    evidence: [MEALIE_TESTED],
  },
  // Komga: its REST API with an administrator's API key.
  {
    id: "komga.read",
    app: "komga",
    label:
      "See libraries and their counts, books it could not read, what was added lately, users and failed sign-ins",
    risk: "read",
    api: [
      "GET /actuator/info",
      "GET /api/v1/libraries",
      "GET /api/v1/series",
      "GET /api/v1/books",
      "GET /api/v1/books/latest",
      "GET /api/v2/users",
      "GET /api/v2/users/authentication-activity",
      "GET /api/v1/history",
      "GET /api/v1/readlists",
      "GET /api/v1/collections",
    ],
    panel: { tab: "overview", target: "komga:libraries" },
    evidence: [KOMGA_TESTED],
  },
  {
    id: "komga.scan",
    app: "komga",
    label: "Scan or deep scan a library, analyze its books again or refresh their metadata",
    risk: "routine",
    operation: "app-komga-control",
    api: [
      "POST /api/v1/libraries/{id}/scan",
      "POST /api/v1/libraries/{id}/analyze",
      "POST /api/v1/libraries/{id}/metadata/refresh",
    ],
    panel: { tab: "overview", target: "komga:libraries" },
    evidence: [KOMGA_TESTED],
  },
  {
    id: "komga.trash",
    app: "komga",
    label: "Empty a library's trash (forget books whose files are gone)",
    risk: "destructive",
    operation: "app-komga-control",
    api: ["POST /api/v1/libraries/{id}/empty-trash"],
    panel: { tab: "overview", target: "komga:libraries" },
    evidence: [KOMGA_TESTED],
  },
  {
    id: "komga.unreadable",
    app: "komga",
    label: "Read a book it could not open again, after its file was fixed",
    risk: "routine",
    operation: "app-komga-control",
    api: ["POST /api/v1/books/{id}/analyze"],
    panel: { tab: "books", target: "books:unreadable" },
    evidence: [KOMGA_TESTED],
  },
  // wg-easy 15: its API. Never a client's keys, configuration or QR code.
  {
    id: "wgeasy.read",
    app: "wgeasy",
    label:
      "See every WireGuard client on or off, connected now, its last handshake, where it connects from, traffic and end date, and the address clients connect to",
    risk: "read",
    api: [
      "GET /api/client",
      "GET /api/admin/userconfig",
      "GET /api/admin/interface",
      "GET /api/information",
    ],
    panel: { tab: "overview", target: "tab:clients:open" },
    evidence: [WGEASY_TESTED],
  },
  {
    id: "wgeasy.clients",
    app: "wgeasy",
    label: "Turn a client on or off, rename it or give it an end date",
    risk: "protected",
    operation: "app-wgeasy-control",
    api: [
      "POST /api/client/{clientId}/enable",
      "POST /api/client/{clientId}/disable",
      "GET /api/client/{clientId}",
      "POST /api/client/{clientId}",
    ],
    panel: { tab: "clients", target: "clients:find" },
    evidence: [WGEASY_TESTED],
  },
  {
    id: "wgeasy.add",
    app: "wgeasy",
    label: "Add a client (its QR code is scanned in wg-easy)",
    risk: "protected",
    operation: "app-wgeasy-control",
    api: ["POST /api/client", "DELETE /api/client/{clientId}"],
    panel: { tab: "clients", target: "clients:add" },
    evidence: [WGEASY_TESTED],
  },
  {
    id: "wgeasy.remove",
    app: "wgeasy",
    label: "Remove a client for good",
    risk: "destructive",
    operation: "app-wgeasy-control",
    api: ["DELETE /api/client/{clientId}"],
    panel: { tab: "clients", target: "clients:find" },
    evidence: [WGEASY_TESTED],
  },
  {
    id: "wgeasy.restart",
    app: "wgeasy",
    label: "Restart the WireGuard interface",
    risk: "protected",
    operation: "app-wgeasy-control",
    api: ["POST /api/admin/interface/restart"],
    panel: { tab: "overview", target: "wgeasy:restart" },
    evidence: [WGEASY_TESTED],
  },
  // Tailscale: its cloud API, v2. Never a device's keys.
  {
    id: "tailscale.read",
    app: "tailscale",
    label:
      "See every device online or not, devices waiting for approval, keys running out, exit nodes and subnet routes, updates and DNS",
    risk: "read",
    api: [
      "GET /api/v2/tailnet/{tailnet}/devices",
      "GET /api/v2/tailnet/{tailnet}/dns/preferences",
      "GET /api/v2/tailnet/{tailnet}/dns/nameservers",
      "GET /api/v2/device/{deviceId}/routes",
    ],
    panel: { tab: "overview", target: "tab:devices:open" },
    evidence: [TAILSCALE_SPEC],
  },
  {
    id: "tailscale.approve",
    app: "tailscale",
    label: "Approve a device waiting to join, or take its access away",
    risk: "protected",
    operation: "app-tailscale-control",
    api: ["POST /api/v2/device/{deviceId}/authorized"],
    panel: { tab: "devices", target: "devices:find" },
    evidence: [TAILSCALE_SPEC],
  },
  {
    id: "tailscale.expiry",
    app: "tailscale",
    label: "Turn a device's key expiry off or on",
    risk: "protected",
    operation: "app-tailscale-control",
    api: ["POST /api/v2/device/{deviceId}/key"],
    panel: { tab: "devices", target: "devices:find" },
    evidence: [TAILSCALE_SPEC],
  },
  {
    id: "tailscale.routes",
    app: "tailscale",
    label: "Approve or withdraw an exit node or subnet routes",
    risk: "protected",
    operation: "app-tailscale-control",
    api: ["GET /api/v2/device/{deviceId}/routes", "POST /api/v2/device/{deviceId}/routes"],
    panel: { tab: "devices", target: "devices:find" },
    evidence: [TAILSCALE_SPEC],
  },
  {
    id: "tailscale.rename",
    app: "tailscale",
    label: "Rename a device (its tailnet address)",
    risk: "protected",
    operation: "app-tailscale-control",
    api: ["POST /api/v2/device/{deviceId}/name"],
    panel: { tab: "devices", target: "devices:find" },
    evidence: [TAILSCALE_SPEC],
  },
  {
    id: "tailscale.remove",
    app: "tailscale",
    label: "Remove a device from the tailnet",
    risk: "destructive",
    operation: "app-tailscale-control",
    api: ["DELETE /api/v2/device/{deviceId}"],
    panel: { tab: "devices", target: "devices:find" },
    evidence: [TAILSCALE_SPEC],
  },
  // Vaultwarden: its admin page's own calls; never a vault, a key or a secret setting.
  {
    id: "vaultwarden.read",
    app: "vaultwarden",
    label:
      "See its version, accounts (two-step sign-in, last active, invited, turned off), organizations, who may sign up and its own diagnostics, never anything in a vault",
    risk: "read",
    api: [
      "POST /admin",
      "GET /admin/users",
      "GET /admin/diagnostics",
      "GET /admin/diagnostics/config",
    ],
    panel: { tab: "overview", target: "tab:accounts:open" },
    evidence: [VAULTWARDEN_TESTED],
  },
  {
    id: "vaultwarden.accounts",
    app: "vaultwarden",
    label: "Turn an account off or on, or sign it out of every device",
    risk: "protected",
    operation: "app-vaultwarden-control",
    api: [
      "POST /admin/users/{id}/disable",
      "POST /admin/users/{id}/enable",
      "POST /admin/users/{id}/deauth",
    ],
    panel: { tab: "accounts", target: "accounts:find" },
    evidence: [VAULTWARDEN_TESTED],
  },
  {
    id: "vaultwarden.2fa",
    app: "vaultwarden",
    label: "Turn off an account's two-step sign-in (a lost phone or key)",
    risk: "protected",
    operation: "app-vaultwarden-control",
    api: ["POST /admin/users/{id}/remove-2fa"],
    panel: { tab: "accounts", target: "accounts:find" },
    evidence: [VAULTWARDEN_TESTED],
  },
  {
    id: "vaultwarden.invite",
    app: "vaultwarden",
    label: "Invite someone by email, or send the invitation again",
    risk: "protected",
    operation: "app-vaultwarden-control",
    api: [
      "POST /admin/invite",
      "POST /admin/users/{id}/invite/resend",
      "POST /admin/users/{id}/delete",
    ],
    panel: { tab: "accounts", target: "accounts:invite" },
    evidence: [VAULTWARDEN_TESTED],
  },
  {
    id: "vaultwarden.delete",
    app: "vaultwarden",
    label: "Delete an account and its whole vault",
    risk: "destructive",
    operation: "app-vaultwarden-control",
    api: ["POST /admin/users/{id}/delete"],
    panel: { tab: "accounts", target: "accounts:find" },
    evidence: [VAULTWARDEN_TESTED],
  },
  {
    id: "vaultwarden.backup",
    app: "vaultwarden",
    label: "Back up its database now",
    risk: "protected",
    operation: "app-vaultwarden-control",
    api: ["POST /admin/config/backup_db"],
    panel: { tab: "overview", target: "vaultwarden:backup" },
    evidence: [VAULTWARDEN_TESTED],
  },
  // Paperless-ngx: its REST API, version 9.
  {
    id: "paperless.read",
    app: "paperless",
    label:
      "See the inbox, imports waiting and failed with the reason, Paperless's own health, free space, and tags, correspondents and document types",
    risk: "read",
    api: [
      "GET /api/status/",
      "GET /api/statistics/",
      "GET /api/tasks/",
      "GET /api/tags/",
      "GET /api/correspondents/",
      "GET /api/document_types/",
      "GET /api/documents/",
      "GET /api/remote_version/",
    ],
    panel: { tab: "overview", target: "tab:inbox:open" },
    evidence: [PAPERLESS_TESTED],
  },
  {
    id: "paperless.search",
    app: "paperless",
    label: "Search every document by its text, filter by tag, and see the trash (titles only)",
    risk: "read",
    api: ["GET /api/documents/", "GET /api/trash/"],
    panel: { tab: "documents", target: "documents:find" },
    evidence: [PAPERLESS_TESTED],
  },
  {
    id: "paperless.sort",
    app: "paperless",
    label: "Mark inbox documents done, tag them, and set their correspondent and document type",
    risk: "routine",
    operation: "app-paperless-control",
    api: ["POST /api/documents/bulk_edit/"],
    panel: { tab: "inbox", target: "inbox:done" },
    evidence: [PAPERLESS_TESTED],
  },
  {
    id: "paperless.trash",
    app: "paperless",
    label: "Move documents to the trash or bring them back",
    risk: "consequential",
    operation: "app-paperless-control",
    api: ["POST /api/documents/bulk_edit/", "POST /api/trash/"],
    panel: { tab: "documents", target: "documents:find" },
    evidence: [PAPERLESS_TESTED],
  },
  {
    id: "paperless.tags",
    app: "paperless",
    label: "Make a tag (an inbox tag too); undo removes it while it is unused",
    risk: "consequential",
    operation: "app-paperless-control",
    api: ["POST /api/tags/", "DELETE /api/tags/{id}/"],
    panel: { tab: "overview", target: "tags:add" },
    evidence: [PAPERLESS_TESTED],
  },
  {
    id: "paperless.maintenance",
    app: "paperless",
    label:
      "Run the sanity check, train the classifier, optimize the index, fetch mail, and dismiss failed imports",
    risk: "routine",
    operation: "app-paperless-control",
    api: ["POST /api/tasks/run/", "POST /api/tasks/acknowledge/"],
    panel: { tab: "overview", target: "paperless:maintenance" },
    evidence: [PAPERLESS_TESTED],
  },
  // Nextcloud: its OCS API (serverinfo, users, groups, apps, app config) and setup checks.
  {
    id: "nextcloud.read",
    app: "nextcloud",
    label:
      "See free space, files, accounts with their quota and groups, who used it lately, app updates, background jobs, public links and Nextcloud's own setup checks",
    risk: "read",
    api: [
      "GET /status.php",
      "GET /ocs/v2.php/apps/serverinfo/api/v1/info",
      "GET /ocs/v2.php/cloud/user",
      "GET /ocs/v2.php/cloud/users/details",
      "GET /ocs/v2.php/cloud/groups",
      "GET /ocs/v2.php/apps/provisioning_api/api/v1/config/apps/{app}/{key}",
      "GET /index.php/settings/setupcheck",
    ],
    panel: { tab: "overview", target: "tab:accounts:open" },
    evidence: [NEXTCLOUD_TESTED],
  },
  {
    id: "nextcloud.apps.read",
    app: "nextcloud",
    label: "See every installed app, on or off, with its version and any update",
    risk: "read",
    api: ["GET /ocs/v2.php/cloud/apps", "GET /ocs/v2.php/cloud/apps/{app}"],
    panel: { tab: "apps", target: "apps:find" },
    evidence: [NEXTCLOUD_TESTED],
  },
  {
    id: "nextcloud.accounts",
    app: "nextcloud",
    label: "Turn an account off or on",
    risk: "consequential",
    operation: "app-nextcloud-control",
    api: [
      "PUT /ocs/v2.php/cloud/users/{userId}/disable",
      "PUT /ocs/v2.php/cloud/users/{userId}/enable",
    ],
    panel: { tab: "accounts", target: "accounts:find" },
    evidence: [NEXTCLOUD_TESTED],
  },
  {
    id: "nextcloud.quota",
    app: "nextcloud",
    label: "Set an account's storage quota",
    risk: "routine",
    operation: "app-nextcloud-control",
    api: ["PUT /ocs/v2.php/cloud/users/{userId}"],
    panel: { tab: "accounts", target: "accounts:find" },
    evidence: [NEXTCLOUD_TESTED],
  },
  {
    id: "nextcloud.groups",
    app: "nextcloud",
    label: "Add an account to a group or take it out (admin makes it an administrator)",
    risk: "consequential",
    operation: "app-nextcloud-control",
    api: [
      "POST /ocs/v2.php/cloud/users/{userId}/groups",
      "DELETE /ocs/v2.php/cloud/users/{userId}/groups",
    ],
    panel: { tab: "accounts", target: "accounts:find" },
    evidence: [NEXTCLOUD_TESTED],
  },
  {
    id: "nextcloud.apps",
    app: "nextcloud",
    label: "Turn an app on or off",
    risk: "consequential",
    operation: "app-nextcloud-control",
    api: ["POST /ocs/v2.php/cloud/apps/{app}", "DELETE /ocs/v2.php/cloud/apps/{app}"],
    panel: { tab: "apps", target: "apps:find" },
    evidence: [NEXTCLOUD_TESTED],
  },
  {
    id: "nextcloud.settings",
    app: "nextcloud",
    label:
      "Choose how background jobs run, and whether public links need a password or are allowed",
    risk: "consequential",
    operation: "app-nextcloud-control",
    api: ["POST /ocs/v2.php/apps/provisioning_api/api/v1/config/apps/{app}/{key}"],
    panel: { tab: "overview", target: "nextcloud:settings" },
    evidence: [NEXTCLOUD_TESTED],
  },
  // Portainer: environments, stacks and containers.
  {
    id: "portainer.read",
    app: "portainer",
    label: "See each environment's containers running, stopped and unhealthy, and its stacks",
    risk: "read",
    api: [
      "GET /api/system/status",
      "GET /api/endpoints",
      "GET /api/stacks",
      "GET /api/endpoints/{id}/docker/containers/json",
    ],
    panel: { tab: "overview", target: "tab:stacks:open" },
    evidence: [PORTAINER_TESTED],
  },
  {
    id: "portainer.stacks",
    app: "portainer",
    label: "Start, stop or update a stack (pull its images and deploy again)",
    risk: "consequential",
    operation: "app-portainer-control",
    api: [
      "GET /api/stacks/{id}",
      "GET /api/stacks/{id}/file",
      "POST /api/stacks/{id}/start",
      "POST /api/stacks/{id}/stop",
      "PUT /api/stacks/{id}",
      "PUT /api/stacks/{id}/git/redeploy",
    ],
    panel: { tab: "stacks", target: "stacks:find" },
    evidence: [PORTAINER_TESTED],
  },
  {
    id: "portainer.containers",
    app: "portainer",
    label: "Start, stop or restart a container",
    risk: "consequential",
    operation: "app-portainer-control",
    api: ["POST /api/endpoints/{id}/docker/containers/{containerId}/{action}"],
    panel: { tab: "stacks", target: "stacks:find" },
    evidence: [PORTAINER_TESTED],
  },
  // Traefik: read only (it is set up in its files and labels, not through its API).
  {
    id: "traefik.routers.read",
    app: "traefik",
    label:
      "See every router, the names it answers, its app servers up or down, and refused routers",
    risk: "read",
    api: [
      "GET /api/version",
      "GET /api/overview",
      "GET /api/http/routers",
      "GET /api/http/services",
      "GET /api/entrypoints",
    ],
    panel: { tab: "overview", target: "tab:routers:open" },
    evidence: [TRAEFIK_TESTED],
  },
  {
    id: "traefik.certificates.read",
    app: "traefik",
    label: "See certificates and when they expire",
    risk: "read",
    api: ["GET /api/certificates"],
    panel: { tab: "certificates", target: "tab:certificates" },
    evidence: [TRAEFIK_TESTED],
  },
  // Nginx Proxy Manager: sites, certificates. Every change is a protected plan.
  {
    id: "npm.sites.read",
    app: "npm",
    label: "See every site with where it forwards, its certificate, and whether nginx loaded it",
    risk: "read",
    api: [
      "GET /api/",
      "POST /api/tokens",
      "GET /api/nginx/proxy-hosts",
      "GET /api/nginx/certificates",
      "GET /api/nginx/redirection-hosts",
      "GET /api/nginx/access-lists",
      "GET /api/audit-log",
    ],
    panel: { tab: "overview", target: "tab:sites:open" },
    evidence: [NPM_TESTED],
  },
  {
    id: "npm.sites.edit",
    app: "npm",
    label: "Switch a site on or off, change where it forwards, add or remove a site",
    risk: "protected",
    operation: "app-npm-control",
    api: [
      "POST /api/nginx/proxy-hosts/{hostID}/enable",
      "POST /api/nginx/proxy-hosts/{hostID}/disable",
      "PUT /api/nginx/proxy-hosts/{hostID}",
      "POST /api/nginx/proxy-hosts",
      "DELETE /api/nginx/proxy-hosts/{hostID}",
    ],
    panel: { tab: "sites", target: "site:add" },
    evidence: [NPM_TESTED],
  },
  {
    id: "npm.certificates.renew",
    app: "npm",
    label: "See certificates and when they expire, and renew a Let's Encrypt one",
    risk: "protected",
    operation: "app-npm-control",
    api: ["GET /api/nginx/certificates", "POST /api/nginx/certificates/{certID}/renew"],
    panel: { tab: "certificates", target: "tab:certificates" },
    evidence: [NPM_TESTED],
  },
  // Proxmox VE: nodes, VMs and containers. Checked against its API schema and the stand-in only.
  {
    id: "proxmox.cluster.read",
    app: "proxmox",
    label: "See nodes, VMs and containers with their state and resources, storage and tasks",
    risk: "read",
    api: [
      "GET /api2/json/version",
      "GET /api2/json/cluster/resources",
      "GET /api2/json/cluster/tasks",
      "GET /api2/json/nodes/{node}/apt/update",
    ],
    panel: { tab: "overview", target: "tab:guests:open" },
    evidence: [PROXMOX_SPEC, PROXMOX_STAND],
  },
  {
    id: "proxmox.guest.power",
    app: "proxmox",
    label: "Start, shut down, restart or force-stop a VM or container",
    risk: "consequential",
    operation: "app-proxmox-control",
    api: [
      "POST /api2/json/nodes/{node}/qemu/{vmid}/status/start",
      "POST /api2/json/nodes/{node}/qemu/{vmid}/status/shutdown",
      "POST /api2/json/nodes/{node}/qemu/{vmid}/status/reboot",
      "POST /api2/json/nodes/{node}/qemu/{vmid}/status/stop",
      "POST /api2/json/nodes/{node}/lxc/{vmid}/status/start",
      "POST /api2/json/nodes/{node}/lxc/{vmid}/status/shutdown",
      "POST /api2/json/nodes/{node}/lxc/{vmid}/status/reboot",
      "POST /api2/json/nodes/{node}/lxc/{vmid}/status/stop",
      "GET /api2/json/nodes/{node}/tasks/{upid}/status",
    ],
    panel: { tab: "guests", target: "guests:find" },
    evidence: [PROXMOX_SPEC, PROXMOX_STAND],
  },
  {
    id: "proxmox.backups",
    app: "proxmox",
    label: "See backup jobs and files, and back a guest up now",
    risk: "consequential",
    operation: "app-proxmox-control",
    api: [
      "GET /api2/json/cluster/backup",
      "GET /api2/json/nodes/{node}/storage",
      "GET /api2/json/nodes/{node}/storage/{storage}/content",
      "POST /api2/json/nodes/{node}/vzdump",
    ],
    panel: { tab: "backups", target: "tab:backups" },
    evidence: [PROXMOX_SPEC, PROXMOX_STAND],
  },
  {
    id: "proxmox.snapshot",
    app: "proxmox",
    label: "See a guest's snapshots, and take one",
    risk: "routine",
    operation: "app-proxmox-control",
    api: [
      "GET /api2/json/nodes/{node}/qemu/{vmid}/snapshot",
      "POST /api2/json/nodes/{node}/qemu/{vmid}/snapshot",
      "GET /api2/json/nodes/{node}/lxc/{vmid}/snapshot",
      "POST /api2/json/nodes/{node}/lxc/{vmid}/snapshot",
    ],
    panel: { tab: "guests", target: "guests:find" },
    evidence: [PROXMOX_SPEC, PROXMOX_STAND],
  },
  // AdGuard Home: ad blocking for the whole network. Every change is a protected plan.
  {
    id: "adguard.stats.read",
    app: "adguard",
    label: "See queries and blocked in the last day, most blocked domains, busiest devices",
    risk: "read",
    api: ["GET /control/status", "GET /control/stats"],
    panel: { tab: "overview", target: "tab:queries:open" },
    evidence: [ADGUARD_TESTED],
  },
  {
    id: "adguard.protection.pause",
    app: "adguard",
    label: "Pause protection for a while, and turn it back on",
    risk: "protected",
    operation: "app-adguard-control",
    api: ["GET /control/status", "POST /control/protection"],
    panel: { tab: "overview", target: "adguard:pause" },
    evidence: [ADGUARD_TESTED],
  },
  {
    id: "adguard.safety.switch",
    app: "adguard",
    label: "Switch safe browsing, parental control and safe search on or off",
    risk: "protected",
    operation: "app-adguard-control",
    api: [
      "GET /control/safebrowsing/status",
      "POST /control/safebrowsing/enable",
      "POST /control/safebrowsing/disable",
      "GET /control/parental/status",
      "POST /control/parental/enable",
      "POST /control/parental/disable",
      "GET /control/safesearch/status",
      "PUT /control/safesearch/settings",
    ],
    panel: { tab: "overview", target: "safety:safebrowsing" },
    evidence: [ADGUARD_TESTED],
  },
  {
    id: "adguard.queries.read",
    app: "adguard",
    label: "Read the query log: every lookup, the device, blocked or allowed and by which rule",
    risk: "read",
    api: ["GET /control/querylog"],
    panel: { tab: "queries", target: "queries:search" },
    evidence: [ADGUARD_TESTED],
  },
  {
    id: "adguard.domain.why",
    app: "adguard",
    label: "See why a domain is blocked or allowed",
    risk: "read",
    api: ["GET /control/filtering/check_host"],
    panel: { tab: "queries/domain/ads.example.com", target: "why:allow" },
    evidence: [ADGUARD_TESTED],
  },
  {
    id: "adguard.rules.edit",
    app: "adguard",
    label: "Allow or block a domain with a custom rule, and take a rule off",
    risk: "protected",
    operation: "app-adguard-control",
    api: ["GET /control/filtering/status", "POST /control/filtering/set_rules"],
    panel: { tab: "filters", target: "domain:name" },
    evidence: [ADGUARD_TESTED],
  },
  {
    id: "adguard.filters.edit",
    app: "adguard",
    label: "Add, switch on or off, remove or update filter lists",
    risk: "protected",
    operation: "app-adguard-control",
    api: [
      "POST /control/filtering/add_url",
      "POST /control/filtering/set_url",
      "POST /control/filtering/remove_url",
      "POST /control/filtering/refresh",
    ],
    panel: { tab: "filters", target: "filter:add" },
    evidence: [ADGUARD_TESTED],
  },
  {
    id: "adguard.services.edit",
    app: "adguard",
    label: "Block whole services (TikTok, Roblox) for the network",
    risk: "protected",
    operation: "app-adguard-control",
    api: [
      "GET /control/blocked_services/all",
      "GET /control/blocked_services/get",
      "PUT /control/blocked_services/update",
    ],
    panel: { tab: "services", target: "services:find" },
    evidence: [ADGUARD_TESTED],
  },
  {
    id: "adguard.rewrites.edit",
    app: "adguard",
    label: "Add or remove DNS rewrites (plex.home)",
    risk: "protected",
    operation: "app-adguard-control",
    api: ["GET /control/rewrite/list", "POST /control/rewrite/add", "POST /control/rewrite/delete"],
    panel: { tab: "rewrites", target: "rewrite:add" },
    evidence: [ADGUARD_TESTED],
  },
  // Pi-hole 6: ad blocking for the whole network. Every change is a protected plan.
  {
    id: "pihole.stats.read",
    app: "pihole",
    label: "See queries and blocked in the last day, most blocked domains, busiest devices",
    risk: "read",
    api: [
      "GET /api/stats/summary",
      "GET /api/stats/top_domains",
      "GET /api/stats/top_clients",
      "GET /api/history",
    ],
    panel: { tab: "overview", target: "tab:queries:open" },
    evidence: [PIHOLE_TESTED],
  },
  {
    id: "pihole.blocking.pause",
    app: "pihole",
    label: "Pause ad blocking for a while, and turn it back on",
    risk: "protected",
    operation: "app-pihole-control",
    api: ["GET /api/dns/blocking", "POST /api/dns/blocking"],
    panel: { tab: "overview", target: "pihole:pause" },
    evidence: [PIHOLE_TESTED],
  },
  {
    id: "pihole.gravity.update",
    app: "pihole",
    label: "Update the blocklists (download every list again)",
    risk: "protected",
    operation: "app-pihole-control",
    api: ["POST /api/action/gravity", "GET /api/stats/summary"],
    panel: { tab: "overview", target: "pihole:gravity" },
    evidence: [PIHOLE_TESTED],
  },
  {
    id: "pihole.queries.read",
    app: "pihole",
    label: "Read the query log: every lookup, the device, blocked or allowed, filtered",
    risk: "read",
    api: ["GET /api/queries"],
    panel: { tab: "queries", target: "queries:domain" },
    evidence: [PIHOLE_TESTED],
  },
  {
    id: "pihole.domain.why",
    app: "pihole",
    label: "See why a domain is blocked or allowed: the rules and lists that name it",
    risk: "read",
    api: ["GET /api/search/{domain}"],
    panel: { tab: "queries/domain/ads.example.com", target: "why:allow" },
    evidence: [PIHOLE_TESTED],
  },
  {
    id: "pihole.domain.allow",
    app: "pihole",
    label: "Allow or block a domain, by name or by a pattern, and take it off again",
    risk: "protected",
    operation: "app-pihole-control",
    api: [
      "GET /api/domains/{type}/{kind}/{domain}",
      "POST /api/domains/{type}/{kind}",
      "DELETE /api/domains/{type}/{kind}/{domain}",
    ],
    panel: { tab: "lists", target: "domain:name" },
    evidence: [PIHOLE_TESTED],
  },
  {
    id: "pihole.lists.edit",
    app: "pihole",
    label: "Add, switch on or off, or remove a blocklist or allowlist",
    risk: "protected",
    operation: "app-pihole-control",
    api: ["GET /api/lists", "POST /api/lists", "PUT /api/lists/{list}", "DELETE /api/lists/{list}"],
    panel: { tab: "lists", target: "list:add" },
    evidence: [PIHOLE_TESTED],
  },
  {
    id: "pihole.dns.edit",
    app: "pihole",
    label: "Add or remove local DNS names (plex.home) and aliases",
    risk: "protected",
    operation: "app-pihole-control",
    api: [
      "GET /api/config/{element}",
      "PUT /api/config/{element}/{value}",
      "DELETE /api/config/{element}/{value}",
    ],
    panel: { tab: "dns", target: "dns:add" },
    evidence: [PIHOLE_TESTED],
  },
  // RomM (checklist 46.12): the game library. A login reads; scans need an administrator.
  {
    id: "romm.library.read",
    app: "romm",
    label: "See the library: totals, platforms, recently added, favourites",
    risk: "read",
    api: [
      "GET /api/stats",
      "GET /api/platforms",
      "GET /api/roms",
      "GET /api/collections",
      "GET /api/heartbeat",
    ],
    panel: { tab: "overview", target: "tab:overview" },
    evidence: [ROMM_TESTED],
  },
  {
    id: "romm.games.find",
    app: "romm",
    label: "Find games by name, platform, genre or favourites, in an order",
    risk: "read",
    api: ["GET /api/roms"],
    panel: { tab: "library", target: "library:search" },
    evidence: [ROMM_TESTED],
  },
  {
    id: "romm.game.read",
    app: "romm",
    label: "See a game's page: cover, details, files",
    risk: "read",
    api: ["GET /api/roms/{id}", "GET /assets/romm/resources/{path}"],
    panel: { tab: "library/game/4", target: "game:favorite" },
    evidence: [ROMM_TESTED],
  },
  {
    id: "romm.platforms",
    app: "romm",
    label: "See every platform with its games and space",
    risk: "read",
    api: ["GET /api/platforms"],
    panel: { tab: "platforms", target: "tab:platforms" },
    evidence: [ROMM_TESTED],
  },
  {
    id: "romm.favorite",
    app: "romm",
    label: "Add a game to your favourites, or take it out",
    risk: "consequential",
    operation: "app-romm-control",
    api: [
      "GET /api/collections",
      "POST /api/collections",
      "POST /api/collections/{id}/roms",
      "DELETE /api/collections/{id}/roms",
    ],
    panel: { tab: "library/game/4", target: "game:favorite" },
    evidence: [ROMM_TESTED],
  },
  {
    id: "romm.scan",
    app: "romm",
    label:
      "Scan the library or some platforms (new games, identify again, update details, complete)",
    risk: "consequential",
    operation: "app-romm-control",
    api: ["POST /api/login", "SOCKET /ws/socket.io scan", "POST /api/logout"],
    panel: { tab: "overview", target: "overview:scan" },
    evidence: [ROMM_TESTED],
  },
  // Radarr and Sonarr: the everyday Overview.
  ...arr("queue.read", "See the download queue and what is stuck", {
    risk: "read",
    api: ["GET /api/v3/queue"],
    panel: { tab: "overview/queue", target: "view:queue" },
    tabbed: { tab: "activity", target: "view:queue" },
  }),
  ...arr("queue.remove", "Remove a failed download from the queue", {
    risk: "consequential",
    operation: "app-arr-queue-remove",
    api: ["DELETE /api/v3/queue/{id}"],
    panel: { tab: "overview/queue", target: "queue:remove" },
    tabbed: { tab: "activity", target: "queue:remove" },
    evidence: "spec",
  }),
  ...arr("queue.import", "Import a download that is stuck", {
    risk: "consequential",
    operation: "app-arr-import",
    api: ["POST /api/v3/command"],
    panel: { tab: "overview/queue", target: "queue:import" },
    tabbed: { tab: "activity", target: "queue:import" },
    evidence: "spec",
  }),
  ...arr("queue.search", "Search again for a failed download", {
    risk: "consequential",
    operation: "app-arr-search",
    api: ["POST /api/v3/command"],
    panel: { tab: "overview/queue", target: "queue:search" },
    tabbed: { tab: "activity", target: "queue:search" },
    evidence: "spec",
  }),
  ...arr("missing.read", "See what is missing", {
    risk: "read",
    api: ["GET /api/v3/wanted/missing"],
    panel: { tab: "overview/missing", target: "view:missing" },
    tabbed: { tab: "wanted", target: "wanted:missing" },
  }),
  ...arr("missing.search", "Search for something missing", {
    risk: "consequential",
    operation: "app-arr-search",
    api: ["POST /api/v3/command"],
    panel: { tab: "overview/missing", target: "missing:search" },
    tabbed: { tab: "wanted", target: "wanted:search:6" },
    sonarrTabbed: { tab: "wanted", target: "wanted:search:27" },
    evidence: "spec",
  }),
  ...arr("trail.read", "Follow a download into the library", {
    risk: "read",
    api: ["GET /api/v3/history"],
    panel: { tab: "overview/trail", target: "view:trail" },
    tabbed: { tab: "activity/queue/trail", target: "view:trail" },
  }),
  ...arr("recent.read", "See what was imported recently", {
    risk: "read",
    api: ["GET /api/v3/history"],
    panel: { tab: "overview/recent", target: "view:recent" },
    tabbed: { tab: "activity/queue/recent", target: "view:recent" },
  }),
  ...arr("releases.grab", "Choose a release and download it", {
    risk: "consequential",
    operation: "app-arr-grab",
    api: ["GET /api/v3/release", "POST /api/v3/release"],
    panel: { tab: "overview/search", target: "release:grab" },
    evidence: "spec",
  }),
  {
    id: "radarr.collections.add",
    app: "radarr",
    label: "Add a collection's missing movies",
    risk: "consequential",
    operation: "app-arr-add-collection",
    api: ["GET /api/v3/collection", "PUT /api/v3/collection/{id}"],
    panel: { tab: "overview/collections", target: "collection:add" },
    evidence: [PROD(RADARR), SPEC(RADARR)],
  },
  // Radarr's own tabs (Phase 2, checklist 46.9): Library, Activity, Wanted, Settings, System.
  ...radarr("library.read", "Browse, search and filter the movie library", "read", {
    api: ["GET /api/v3/movie"],
    panel: { tab: "library", target: "library:search" },
  }),
  ...radarr("movie.add", "Add a new movie, found through Radarr's own search", "consequential", {
    operation: "app-arr-create",
    api: ["GET /api/v3/movie/lookup", "GET /api/v3/movie/lookup/tmdb", "POST /api/v3/movie"],
    panel: { tab: "library/add", target: "add:search" },
  }),
  ...radarr(
    "library.bulk",
    "Monitor, stop monitoring or change the profile of several movies",
    "routine",
    {
      operation: "app-arr-edit",
      api: ["PUT /api/v3/movie/{id}"],
      panel: { tab: "library", target: "library:bulk:unmonitor" },
    },
  ),
  ...radarr("movie.read", "See one movie: details, file, history", "read", {
    api: ["GET /api/v3/movie/{id}", "GET /api/v3/history/movie"],
    panel: { tab: "library/movie/1", target: "movie:1" },
  }),
  ...radarr(
    "movie.edit",
    "Change a movie's monitoring, quality profile, availability or tags",
    "routine",
    {
      operation: "app-arr-edit",
      api: ["PUT /api/v3/movie/{id}"],
      panel: { tab: "library/movie/1", target: "movie:save" },
    },
  ),
  ...radarr("movie.search", "Search for one movie now", "consequential", {
    operation: "app-arr-search",
    api: ["POST /api/v3/command"],
    panel: { tab: "library/movie/1", target: "movie:search" },
  }),
  ...radarr("movie.refresh", "Refresh, rescan or rename a movie's files", "consequential", {
    operation: "app-arr-command",
    api: ["POST /api/v3/command"],
    panel: { tab: "library/movie/1", target: "movie:refresh" },
  }),
  ...radarr("movie.remove", "Remove a movie (its files only if asked)", "destructive", {
    operation: "app-arr-delete",
    api: ["DELETE /api/v3/movie/{id}"],
    panel: { tab: "library/movie/1", target: "movie:remove" },
  }),
  ...radarr("history.read", "See everything Radarr grabbed, imported, failed or deleted", "read", {
    api: ["GET /api/v3/history"],
    panel: { tab: "activity/history", target: "history:filter" },
  }),
  ...radarr("blocklist.remove", "Take a release off the blocklist", "consequential", {
    operation: "app-arr-delete",
    api: ["GET /api/v3/blocklist", "DELETE /api/v3/blocklist/{id}"],
    panel: { tab: "activity/blocklist", target: "blocklist:remove:1" },
  }),
  ...radarr("wanted.read", "See missing movies and movies below their cutoff", "read", {
    api: ["GET /api/v3/wanted/missing", "GET /api/v3/wanted/cutoff"],
    panel: { tab: "wanted", target: "wanted:cutoff" },
  }),
  ...radarr(
    "wanted.search-all",
    "Search for every missing movie, or every upgrade",
    "consequential",
    {
      operation: "app-arr-command",
      api: ["POST /api/v3/command"],
      panel: { tab: "wanted", target: "wanted:missing:search-all" },
    },
  ),
  ...radarr(
    "profile.edit",
    "Change a quality profile: qualities, upgrades, format scores",
    "consequential",
    {
      operation: "app-arr-edit",
      api: ["GET /api/v3/qualityprofile/{id}", "PUT /api/v3/qualityprofile/{id}"],
      panel: { tab: "config/profiles/1", target: "profile:1:save" },
    },
  ),
  ...radarr("profile.add", "Add a quality profile as a copy of another", "routine", {
    operation: "app-arr-create",
    api: ["POST /api/v3/qualityprofile"],
    panel: { tab: "config", target: "profile:1:copy" },
  }),
  ...radarr("format.edit", "Change a custom format's conditions", "consequential", {
    operation: "app-arr-edit",
    api: ["GET /api/v3/customformat/{id}", "PUT /api/v3/customformat/{id}"],
    panel: { tab: "config/formats/1", target: "format:1:save" },
  }),
  ...radarr("format.add", "Add a custom format", "routine", {
    operation: "app-arr-create",
    api: ["POST /api/v3/customformat"],
    panel: { tab: "config/formats", target: "format:add" },
  }),
  ...radarr("format.preview", "Check what Radarr itself makes of a release name", "read", {
    api: ["GET /api/v3/parse"],
    panel: { tab: "config/formats", target: "format:preview" },
  }),
  ...radarr("tag.add", "Add a tag", "routine", {
    operation: "app-arr-create",
    api: ["POST /api/v3/tag"],
    panel: { tab: "config/tags", target: "tag:new" },
  }),
  ...radarr("delay.edit", "Change a delay profile", "consequential", {
    operation: "app-arr-edit",
    api: ["PUT /api/v3/delayprofile/{id}"],
    panel: { tab: "config/tags", target: "delay:1:open" },
  }),
  ...radarr("sizes.edit", "Change how big a release may be for each quality", "consequential", {
    operation: "app-arr-edit",
    api: [
      "GET /api/v3/qualitydefinition",
      "GET /api/v3/qualitydefinition/limits",
      "PUT /api/v3/qualitydefinition/{id}",
    ],
    panel: { tab: "config/sizes", target: "sizes:review" },
  }),
  ...radarr(
    "exclusions.edit",
    "Stop import lists adding a movie, or let them again",
    "consequential",
    {
      operation: "app-arr-create",
      api: [
        "GET /api/v3/exclusions/paged",
        "POST /api/v3/exclusions",
        "DELETE /api/v3/exclusions/{id}",
      ],
      panel: { tab: "config/exclusions", target: "exclusions:search" },
    },
  ),
  ...radarr(
    "import.files",
    "Import files Radarr found in a folder into the right movies",
    "consequential",
    {
      operation: "app-arr-command",
      api: ["GET /api/v3/manualimport", "POST /api/v3/command"],
      panel: { tab: "activity/import", target: "import:folder" },
    },
  ),
  ...radarr("media.edit", "Change naming and media management", "consequential", {
    operation: "app-arr-edit",
    api: ["PUT /api/v3/config/naming/{id}", "PUT /api/v3/config/mediamanagement/{id}"],
    panel: { tab: "config/media", target: "naming:save" },
  }),
  ...radarr(
    "rootfolder.add",
    "Add or remove a root folder (nothing on disk is deleted)",
    "consequential",
    {
      operation: "app-arr-create",
      api: ["POST /api/v3/rootfolder", "DELETE /api/v3/rootfolder/{id}"],
      panel: { tab: "config/media", target: "root:add" },
    },
  ),
  ...radarr(
    "connections.edit",
    "Switch a download client, indexer or notification on or off, change its ordinary settings, or remove it (passwords and keys stay in Radarr)",
    "consequential",
    {
      operation: "app-arr-edit",
      api: [
        "GET /api/v3/downloadclient",
        "PUT /api/v3/downloadclient/{id}",
        "DELETE /api/v3/downloadclient/{id}",
      ],
      panel: { tab: "config/connections", target: "connection:downloadclient:1" },
    },
  ),
  ...radarr("system.health", "See Radarr's health, version and disk space", "read", {
    api: ["GET /api/v3/health", "GET /api/v3/system/status", "GET /api/v3/diskspace"],
    panel: { tab: "system", target: "system:status" },
  }),
  ...radarr("task.run", "Run one of Radarr's scheduled tasks now", "consequential", {
    operation: "app-arr-command",
    api: ["GET /api/v3/system/task", "POST /api/v3/command"],
    panel: { tab: "system/tasks", target: "task:run:RssSync" },
  }),
  ...radarr("backup.now", "Make a Radarr backup now", "routine", {
    operation: "app-arr-command",
    api: ["GET /api/v3/system/backup", "POST /api/v3/command"],
    panel: { tab: "system/backups", target: "backup:now" },
  }),
  ...radarr("log.read", "Read Radarr's own log", "read", {
    api: ["GET /api/v3/log"],
    panel: { tab: "system/logs", target: "system:logs" },
  }),
  {
    id: "radarr.files.delete",
    app: "radarr",
    label: "Delete one movie file",
    risk: "destructive",
    operation: "app-radarr-delete-file",
    api: ["DELETE /api/v3/moviefile/{id}"],
    panel: { tab: "library/movie/1", target: "movie:delete-file" },
    evidence: [SPEC(RADARR), STAND],
  },
  {
    id: "sonarr.files.delete",
    app: "sonarr",
    label: "Delete one episode file",
    risk: "destructive",
    operation: "app-sonarr-delete-file",
    api: ["DELETE /api/v3/episodefile/{id}"],
    panel: { tab: "library/series/1", target: "episode:7:delete-file" },
    evidence: [SPEC(SONARR), STAND],
  },
  // Sonarr's own tabs (Phase 3): Library with series, seasons and episodes, Wanted, and the
  // Activity, Settings and System tabs it shares with Radarr.
  ...sonarr("library.read", "Browse, search and filter the series library", "read", {
    api: ["GET /api/v3/series"],
    panel: { tab: "library", target: "library:search" },
  }),
  ...sonarr("series.add", "Add a new series, found through Sonarr's own search", "consequential", {
    operation: "app-arr-create",
    api: ["GET /api/v3/series/lookup", "POST /api/v3/series"],
    panel: { tab: "library/add", target: "add:search" },
  }),
  ...sonarr("series.read", "See one series: seasons, episodes, files, history", "read", {
    api: [
      "GET /api/v3/series/{id}",
      "GET /api/v3/episode",
      "GET /api/v3/episodefile",
      "GET /api/v3/history/series",
    ],
    panel: { tab: "library/series/1", target: "series:1" },
  }),
  ...sonarr(
    "series.edit",
    "Change a series' monitoring, quality profile, type, season folders or tags",
    "routine",
    {
      operation: "app-arr-edit",
      api: ["PUT /api/v3/series/{id}"],
      panel: { tab: "library/series/1", target: "series:save" },
    },
  ),
  ...sonarr("seasons.monitor", "Choose which seasons Sonarr monitors", "routine", {
    operation: "app-arr-edit",
    api: ["PUT /api/v3/series/{id}"],
    panel: { tab: "library/series/1", target: "season:1:monitored" },
  }),
  ...sonarr("episode.monitor", "Monitor or stop monitoring one episode", "routine", {
    operation: "app-arr-edit",
    api: ["GET /api/v3/episode/{id}", "PUT /api/v3/episode/{id}"],
    panel: { tab: "library/series/1", target: "episode:7:monitored" },
  }),
  ...sonarr(
    "series.search",
    "Search for a series' missing episodes, a season or an episode",
    "consequential",
    {
      operation: "app-arr-command",
      api: ["POST /api/v3/command"],
      panel: { tab: "library/series/1", target: "season:2:search" },
    },
  ),
  ...sonarr("series.refresh", "Refresh, rescan or rename a series' files", "consequential", {
    operation: "app-arr-command",
    api: ["POST /api/v3/command"],
    panel: { tab: "library/series/1", target: "series:refresh" },
  }),
  ...sonarr("series.remove", "Remove a series (its files only if asked)", "destructive", {
    operation: "app-arr-delete",
    api: ["DELETE /api/v3/series/{id}"],
    panel: { tab: "library/series/1", target: "series:remove" },
  }),
  ...sonarr("history.read", "See everything Sonarr grabbed, imported, failed or deleted", "read", {
    api: ["GET /api/v3/history"],
    panel: { tab: "activity/history", target: "history:filter" },
  }),
  ...sonarr("blocklist.remove", "Take a release off the blocklist", "consequential", {
    operation: "app-arr-delete",
    api: ["GET /api/v3/blocklist", "DELETE /api/v3/blocklist/{id}"],
    panel: { tab: "activity/blocklist", target: "blocklist:remove:1" },
  }),
  ...sonarr(
    "import.files",
    "Import files Sonarr found in a folder into the right episodes",
    "consequential",
    {
      operation: "app-arr-command",
      api: ["GET /api/v3/manualimport", "POST /api/v3/command"],
      panel: { tab: "activity/import", target: "import:folder" },
    },
  ),
  ...sonarr("wanted.read", "See missing episodes and episodes below their cutoff", "read", {
    api: ["GET /api/v3/wanted/missing", "GET /api/v3/wanted/cutoff"],
    panel: { tab: "wanted", target: "wanted:cutoff" },
  }),
  ...sonarr(
    "wanted.search-all",
    "Search for every missing episode, or every upgrade",
    "consequential",
    {
      operation: "app-arr-command",
      api: ["POST /api/v3/command"],
      panel: { tab: "wanted", target: "wanted:missing:search-all" },
    },
  ),
  ...sonarr(
    "profile.edit",
    "Change a quality profile: qualities, upgrades, format scores",
    "consequential",
    {
      operation: "app-arr-edit",
      api: ["GET /api/v3/qualityprofile/{id}", "PUT /api/v3/qualityprofile/{id}"],
      panel: { tab: "config/profiles/1", target: "profile:1:save" },
    },
  ),
  ...sonarr("format.add", "Add or change a custom format", "routine", {
    operation: "app-arr-create",
    api: ["POST /api/v3/customformat", "PUT /api/v3/customformat/{id}"],
    panel: { tab: "config/formats", target: "format:add" },
  }),
  ...sonarr("format.preview", "Check what Sonarr itself makes of a release name", "read", {
    api: ["GET /api/v3/parse"],
    panel: { tab: "config/formats", target: "format:preview" },
  }),
  ...sonarr("sizes.edit", "Change how big a release may be for each quality", "consequential", {
    operation: "app-arr-edit",
    api: [
      "GET /api/v3/qualitydefinition",
      "GET /api/v3/qualitydefinition/limits",
      "PUT /api/v3/qualitydefinition/{id}",
    ],
    panel: { tab: "config/sizes", target: "sizes:review" },
  }),
  ...sonarr("tag.add", "Add a tag", "routine", {
    operation: "app-arr-create",
    api: ["POST /api/v3/tag"],
    panel: { tab: "config/tags", target: "tag:new" },
  }),
  ...sonarr("delay.edit", "Change a delay profile", "consequential", {
    operation: "app-arr-edit",
    api: ["PUT /api/v3/delayprofile/{id}"],
    panel: { tab: "config/tags", target: "delay:1:open" },
  }),
  ...sonarr("media.edit", "Change naming, media management and root folders", "consequential", {
    operation: "app-arr-edit",
    api: [
      "PUT /api/v3/config/naming/{id}",
      "PUT /api/v3/config/mediamanagement/{id}",
      "POST /api/v3/rootfolder",
    ],
    panel: { tab: "config/media", target: "naming:save" },
  }),
  ...sonarr(
    "exclusions.edit",
    "Stop import lists adding a series, or let them again",
    "consequential",
    {
      operation: "app-arr-create",
      api: [
        "GET /api/v3/importlistexclusion/paged",
        "POST /api/v3/importlistexclusion",
        "DELETE /api/v3/importlistexclusion/{id}",
      ],
      panel: { tab: "config/exclusions", target: "exclusions:search" },
    },
  ),
  ...sonarr(
    "connections.edit",
    "Switch a download client, indexer or notification on or off, change its ordinary settings, or remove it (passwords and keys stay in Sonarr)",
    "consequential",
    {
      operation: "app-arr-edit",
      api: [
        "GET /api/v3/downloadclient",
        "PUT /api/v3/downloadclient/{id}",
        "DELETE /api/v3/downloadclient/{id}",
      ],
      panel: { tab: "config/connections", target: "connection:downloadclient:1" },
    },
  ),
  ...sonarr("system.health", "See Sonarr's health, version and disk space", "read", {
    api: ["GET /api/v3/health", "GET /api/v3/system/status", "GET /api/v3/diskspace"],
    panel: { tab: "system", target: "system:status" },
  }),
  ...sonarr("task.run", "Run one of Sonarr's scheduled tasks now", "consequential", {
    operation: "app-arr-command",
    api: ["GET /api/v3/system/task", "POST /api/v3/command"],
    panel: { tab: "system/tasks", target: "task:run:RssSync" },
  }),
  ...sonarr("backup.now", "Make a Sonarr backup now", "routine", {
    operation: "app-arr-command",
    api: ["GET /api/v3/system/backup", "POST /api/v3/command"],
    panel: { tab: "system/backups", target: "backup:now" },
  }),
  ...sonarr("log.read", "Read Sonarr's own log", "read", {
    api: ["GET /api/v3/log"],
    panel: { tab: "system/logs", target: "system:logs" },
  }),
  ...arr("naming.set", "Change how files are named", {
    risk: "consequential",
    operation: "app-arr-set-naming",
    api: ["GET /api/v3/config/naming", "PUT /api/v3/config/naming/{id}"],
  }),
  ...arr("customformat.score", "Change the score a quality profile needs", {
    risk: "consequential",
    operation: "app-arr-set-cutoff-score",
    api: ["GET /api/v3/qualityprofile", "PUT /api/v3/qualityprofile/{id}"],
  }),

  // Prowlarr.
  {
    id: "prowlarr.indexers.read",
    app: "prowlarr",
    label: "See every indexer, whether it works and why not",
    risk: "read",
    api: ["GET /api/v1/indexer", "GET /api/v1/indexerstatus"],
    panel: { tab: "overview", target: "tab:overview" },
    evidence: [PROD(PROWLARR), SPEC(PROWLARR)],
  },
  {
    id: "prowlarr.indexer.test",
    app: "prowlarr",
    label: "Test an indexer (Prowlarr contacts it with its stored login)",
    risk: "consequential",
    operation: "app-prowlarr-indexer",
    api: ["POST /api/v1/indexer/test"],
    panel: { tab: "overview", target: "indexer:test" },
    evidence: [SPEC(PROWLARR)],
  },
  {
    id: "prowlarr.indexer.switch",
    app: "prowlarr",
    label: "Switch an indexer on or off",
    risk: "routine",
    operation: "app-prowlarr-indexer",
    api: ["PUT /api/v1/indexer/{id}"],
    panel: { tab: "overview", target: "indexer:switch" },
    evidence: [SPEC(PROWLARR)],
  },
  {
    id: "prowlarr.indexers.test-all",
    app: "prowlarr",
    label: "Test every indexer",
    risk: "consequential",
    operation: "app-prowlarr-indexer",
    api: ["POST /api/v1/indexer/testall"],
    panel: { tab: "overview", target: "indexers:test-all" },
    evidence: [SPEC(PROWLARR)],
  },
  {
    id: "prowlarr.indexers.sync",
    app: "prowlarr",
    label: "Send the indexer list to the apps",
    risk: "consequential",
    operation: "app-prowlarr-indexer",
    api: ["POST /api/v1/command"],
    panel: { tab: "overview", target: "indexers:sync" },
    evidence: [SPEC(PROWLARR)],
  },
  // Prowlarr's own tabs (native panels Phase 3).
  ...prowlarr(
    "indexer.edit",
    "Change an indexer's settings, sync profile, priority and tags",
    "consequential",
    {
      operation: "app-arr-edit",
      api: ["GET /api/v1/indexer/{id}", "PUT /api/v1/indexer/{id}"],
      panel: { tab: "indexers/indexer/1", target: "connection:indexer:1:save" },
    },
  ),
  ...prowlarr("indexer.add", "Add an indexer from Prowlarr's list of sites", "consequential", {
    operation: "app-arr-create",
    api: ["GET /api/v1/indexer/schema", "POST /api/v1/indexer"],
    panel: { tab: "indexers/add", target: "add:search" },
  }),
  ...prowlarr("indexer.remove", "Remove an indexer", "consequential", {
    operation: "app-arr-delete",
    api: ["DELETE /api/v1/indexer/{id}"],
    panel: { tab: "indexers/indexer/1", target: "connection:indexer:1:remove" },
  }),
  ...prowlarr("search", "Search every indexer at once", "read", {
    api: ["GET /api/v1/search"],
    panel: { tab: "search", target: "search:query" },
  }),
  ...prowlarr("release.grab", "Send a search result to the download client", "consequential", {
    operation: "app-arr-command",
    api: ["POST /api/v1/search"],
    panel: { tab: "search", target: "search:grab:stand-in-1" },
  }),
  ...prowlarr("history.read", "See every search, RSS check and grab", "read", {
    api: ["GET /api/v1/history"],
    panel: { tab: "grabs", target: "history:event" },
  }),
  ...prowlarr("application.edit", "Change how an app is synced", "consequential", {
    operation: "app-arr-edit",
    api: ["GET /api/v1/applications/{id}", "PUT /api/v1/applications/{id}"],
    panel: { tab: "config", target: "connection:application:1" },
  }),
  ...prowlarr("appprofile.edit", "Change a sync profile", "consequential", {
    operation: "app-arr-edit",
    api: ["PUT /api/v1/appprofile/{id}"],
    panel: { tab: "config", target: "appprofile:1:save" },
  }),
  ...prowlarr("appprofile.add", "Add a sync profile", "routine", {
    operation: "app-arr-create",
    api: ["POST /api/v1/appprofile"],
    panel: { tab: "config", target: "appprofile:new:add" },
  }),
  ...prowlarr(
    "connections.edit",
    "Change download clients, proxies and notifications",
    "consequential",
    {
      operation: "app-arr-edit",
      api: [
        "GET /api/v1/downloadclient",
        "GET /api/v1/indexerproxy",
        "PUT /api/v1/downloadclient/{id}",
      ],
      panel: { tab: "config/connections", target: "connections:indexerproxy" },
    },
  ),
  ...prowlarr("tags.edit", "Add or remove tags", "consequential", {
    operation: "app-arr-create",
    api: ["GET /api/v1/tag/detail", "POST /api/v1/tag", "DELETE /api/v1/tag/{id}"],
    panel: { tab: "config/tags", target: "tag:new:add" },
  }),
  ...prowlarr("system.health", "See Prowlarr's health and version", "read", {
    api: ["GET /api/v1/health", "GET /api/v1/system/status"],
    panel: { tab: "system", target: "system:status" },
  }),
  ...prowlarr("task.run", "Run one of Prowlarr's scheduled tasks now", "consequential", {
    operation: "app-arr-command",
    api: ["GET /api/v1/system/task", "POST /api/v1/command"],
    panel: { tab: "system/tasks", target: "task:run:CheckHealth" },
  }),
  ...prowlarr("backup.now", "Make a Prowlarr backup now", "routine", {
    operation: "app-arr-command",
    api: ["GET /api/v1/system/backup", "POST /api/v1/command"],
    panel: { tab: "system/backups", target: "backup:now" },
  }),
  ...prowlarr("log.read", "Read Prowlarr's own log, keys hidden", "read", {
    api: ["GET /api/v1/log"],
    panel: { tab: "system/logs", target: "system:logs" },
  }),

  // Lidarr's own tabs (native panels Phase 3).
  ...lidarr("library.read", "See every artist and how much of their music is on disk", "read", {
    api: ["GET /api/v1/artist"],
    panel: { tab: "library", target: "library:search" },
  }),
  ...lidarr(
    "artist.edit",
    "Change an artist's monitoring, profiles, new albums and tags",
    "consequential",
    {
      operation: "app-arr-edit",
      api: ["GET /api/v1/artist/{id}", "PUT /api/v1/artist/{id}"],
      panel: { tab: "library/artist/1", target: "artist:settings" },
    },
  ),
  ...lidarr("album.monitor", "Monitor or stop monitoring an album", "routine", {
    operation: "app-arr-edit",
    api: ["PUT /api/v1/album/{id}"],
    panel: { tab: "library/artist/1", target: "album:31:monitor" },
  }),
  ...lidarr("album.search", "Search for an album", "consequential", {
    operation: "app-arr-command",
    api: ["POST /api/v1/command"],
    panel: { tab: "library/artist/1", target: "album:31:search" },
  }),
  ...lidarr("tracks.read", "See an album's tracks and files", "read", {
    api: ["GET /api/v1/track", "GET /api/v1/trackfile"],
    panel: { tab: "library/album/32", target: "album:search" },
  }),
  ...lidarr("artist.add", "Add an artist from Lidarr's music database", "consequential", {
    operation: "app-arr-create",
    api: ["GET /api/v1/artist/lookup", "POST /api/v1/artist"],
    panel: { tab: "library/add", target: "add:search" },
  }),
  ...lidarr(
    "artist.remove",
    "Remove an artist (deleting files is a separate choice)",
    "consequential",
    {
      operation: "app-arr-delete",
      api: ["DELETE /api/v1/artist/{id}"],
      panel: { tab: "library/artist/1", target: "artist:remove" },
    },
  ),
  ...lidarr("wanted.read", "See missing albums and albums below their cutoff", "read", {
    api: ["GET /api/v1/wanted/missing", "GET /api/v1/wanted/cutoff"],
    panel: { tab: "wanted", target: "wanted:missing" },
  }),
  ...lidarr("wanted.search-all", "Search for every missing album", "consequential", {
    operation: "app-arr-command",
    api: ["POST /api/v1/command"],
    panel: { tab: "wanted", target: "wanted:missing:search-all" },
  }),
  ...lidarr(
    "import.files",
    "Import files Lidarr found in a folder into an album's tracks",
    "consequential",
    {
      operation: "app-arr-command",
      api: ["GET /api/v1/manualimport", "POST /api/v1/command"],
      panel: { tab: "activity", target: "import:folder" },
    },
  ),
  ...lidarr("history.read", "See Lidarr's history", "read", {
    api: ["GET /api/v1/history"],
    panel: { tab: "activity/history", target: "history:filter" },
  }),
  ...lidarr("profiles.edit", "Change quality profiles", "consequential", {
    operation: "app-arr-edit",
    api: ["GET /api/v1/qualityprofile", "PUT /api/v1/qualityprofile/{id}"],
    panel: { tab: "config", target: "settings:profiles" },
  }),
  ...lidarr("naming.edit", "Change how tracks and folders are named", "consequential", {
    operation: "app-arr-edit",
    api: ["GET /api/v1/config/naming", "PUT /api/v1/config/naming/{id}"],
    panel: { tab: "config/media", target: "media:rootfolders" },
  }),
  ...lidarr(
    "connections.edit",
    "Change download clients, indexers and notifications",
    "consequential",
    {
      operation: "app-arr-edit",
      api: ["GET /api/v1/downloadclient", "PUT /api/v1/downloadclient/{id}"],
      panel: { tab: "config/connections", target: "connections:downloadclient" },
    },
  ),
  ...lidarr("system.health", "See Lidarr's health, version and disk space", "read", {
    api: ["GET /api/v1/health", "GET /api/v1/system/status", "GET /api/v1/diskspace"],
    panel: { tab: "system", target: "system:status" },
  }),
  ...lidarr("task.run", "Run one of Lidarr's scheduled tasks now", "consequential", {
    operation: "app-arr-command",
    api: ["GET /api/v1/system/task", "POST /api/v1/command"],
    panel: { tab: "system/tasks", target: "task:run:RssSync" },
  }),
  ...lidarr("backup.now", "Make a Lidarr backup now", "routine", {
    operation: "app-arr-command",
    api: ["GET /api/v1/system/backup", "POST /api/v1/command"],
    panel: { tab: "system/backups", target: "backup:now" },
  }),
  ...lidarr("log.read", "Read Lidarr's own log, keys hidden", "read", {
    api: ["GET /api/v1/log"],
    panel: { tab: "system/logs", target: "system:logs" },
  }),

  // Jellyfin (passwords, API keys and server settings stay in Jellyfin).
  ...jellyfin(
    "people.read",
    "See who can sign in, what they can reach and if they may download",
    "read",
    {
      api: ["GET /Users", "GET /Library/VirtualFolders"],
      panel: { tab: "people", target: "people:list" },
    },
  ),
  ...jellyfin(
    "user.access",
    "Choose which libraries a person can reach and if they may download",
    "consequential",
    {
      operation: "app-jellyfin-control",
      api: ["GET /Users/{userId}", "POST /Users/{userId}/Policy"],
      panel: { tab: "people", target: "jf-user:u2:open" },
    },
  ),
  ...jellyfin(
    "user.disable",
    "Disable or enable someone's account (never an administrator's)",
    "consequential",
    {
      operation: "app-jellyfin-control",
      api: ["GET /Users/{userId}", "POST /Users/{userId}/Policy"],
      panel: { tab: "people", target: "jf-user:u2:open" },
    },
  ),
  ...jellyfin("user.remove", "Remove someone's account (never an administrator's)", "destructive", {
    operation: "app-jellyfin-control",
    api: ["GET /Users/{userId}", "DELETE /Users/{userId}"],
    panel: { tab: "people", target: "jf-user:u2:open" },
  }),
  ...jellyfin("devices.read", "See the apps and devices signed in", "read", {
    api: ["GET /Devices"],
    panel: { tab: "devices", target: "devices:list" },
  }),
  ...jellyfin("device.sign-out", "Sign a device out", "consequential", {
    operation: "app-jellyfin-control",
    api: ["GET /Devices", "DELETE /Devices"],
    panel: { tab: "devices", target: "jf-device:dev-phone:sign-out" },
  }),
  ...jellyfin("activity.read", "See Jellyfin's activity: sign-ins, playback and changes", "read", {
    api: ["GET /System/ActivityLog/Entries"],
    panel: { tab: "activity", target: "activity:list" },
  }),
  ...jellyfin("log.read", "Read Jellyfin's own logs, keys hidden", "read", {
    api: ["GET /System/Logs", "GET /System/Logs/Log"],
    panel: { tab: "system", target: "jf-system:log" },
  }),
  ...jellyfin("plugins.read", "See installed plugins, updates and the catalog", "read", {
    api: ["GET /Plugins", "GET /Packages", "GET /Repositories"],
    panel: { tab: "plugins", target: "plugins:find" },
  }),
  ...jellyfin(
    "plugins.manage",
    "Install, update, enable, disable or remove a plugin",
    "consequential",
    {
      operation: "app-jellyfin-control",
      api: [
        "POST /Packages/Installed/{name}",
        "POST /Plugins/{pluginId}/{version}/Enable",
        "POST /Plugins/{pluginId}/{version}/Disable",
        "DELETE /Plugins/{pluginId}/{version}",
      ],
      panel: { tab: "plugins", target: "plugin:Open Subtitles:update" },
    },
  ),
  ...jellyfin("server.restart", "Restart Jellyfin (to finish plugin changes)", "consequential", {
    operation: "app-jellyfin-control",
    api: ["POST /System/Restart"],
  }),
  // Like Plex's (11-04): the library, a title, libraries' folders and settings.
  ...jellyfin("library.read", "Browse each library and find a title", "read", {
    api: ["GET /Library/VirtualFolders", "GET /Items"],
    panel: { tab: "library", target: "library:search" },
  }),
  ...jellyfin(
    "item.watched",
    "Mark a film, episode, season or show watched or unwatched",
    "consequential",
    {
      operation: "app-jellyfin-control",
      api: ["POST /UserPlayedItems/{itemId}", "DELETE /UserPlayedItems/{itemId}"],
      panel: { tab: "library/item/m-anora", target: "item:watched" },
    },
  ),
  ...jellyfin("item.edit", "Edit a title's name, sort title, summary or year", "consequential", {
    operation: "app-jellyfin-control",
    api: ["POST /Items/{itemId}"],
    panel: { tab: "library/item/m-anora", target: "item:edit" },
  }),
  ...jellyfin("item.refresh", "Refresh a title's details and pictures", "routine", {
    operation: "app-jellyfin-control",
    api: ["POST /Items/{itemId}/Refresh"],
    panel: { tab: "library/item/m-anora", target: "item:refresh" },
  }),
  ...jellyfin(
    "libraries.manage",
    "Add or remove a library or one of its folders",
    "consequential",
    {
      operation: "app-jellyfin-control",
      api: [
        "POST /Library/VirtualFolders",
        "DELETE /Library/VirtualFolders",
        "POST /Library/VirtualFolders/Paths",
        "DELETE /Library/VirtualFolders/Paths",
      ],
      panel: { tab: "manage", target: "manage:add-library" },
    },
  ),
  ...jellyfin(
    "settings.change",
    "Change everyday server and video converting settings",
    "consequential",
    {
      operation: "app-jellyfin-control",
      api: ["POST /System/Configuration", "POST /System/Configuration/{key}"],
      panel: { tab: "config", target: "settings:review" },
    },
  ),

  // Plex (sharing, users, remote access and credentials stay in Plex).
  ...plex("library.read", "Browse each library and find a title", "read", {
    api: ["GET /library/sections/all", "GET /library/sections/{sectionId}/all"],
    panel: { tab: "library", target: "library:search" },
  }),
  ...plex("item.read", "Open a title: its details, files, seasons and episodes", "read", {
    api: ["GET /library/metadata/{ids}", "GET /library/metadata/{ids}/children"],
    panel: { tab: "library", target: "library:item:101" },
  }),
  ...plex("item.watched", "Mark a film, episode, season or show watched or unwatched", "routine", {
    operation: "app-plex-control",
    api: ["PUT /:/scrobble", "PUT /:/unscrobble"],
    panel: { tab: "library/item/101", target: "item:watched" },
  }),
  ...plex("item.edit", "Edit a title's name, sort title, summary or year", "consequential", {
    operation: "app-plex-control",
    api: ["PUT /library/metadata/{ids}"],
    panel: { tab: "library/item/101", target: "item:edit" },
  }),
  ...plex("item.refresh", "Refresh a title's details and artwork", "routine", {
    operation: "app-plex-control",
    api: ["PUT /library/metadata/{ids}/refresh"],
    panel: { tab: "library/item/101", target: "item:refresh" },
  }),
  ...plex(
    "library.empty-trash",
    "Empty a library's trash (entries for files already gone)",
    "destructive",
    {
      operation: "app-plex-control",
      api: ["PUT /library/sections/{sectionId}/emptyTrash"],
      panel: { tab: "library", target: "library:empty-trash" },
    },
  ),
  ...plex("history.read", "See what was watched, and by whom", "read", {
    api: ["GET /status/sessions/history/all", "GET /accounts"],
    panel: { tab: "plays", target: "history:list" },
  }),
  ...plex("tasks.read", "See Plex's maintenance tasks and what it is working on", "read", {
    api: ["GET /butler", "GET /activities"],
    panel: { tab: "tasks", target: "tasks:list" },
  }),
  ...plex("task.run", "Run one of Plex's maintenance tasks now", "routine", {
    operation: "app-plex-control",
    api: ["POST /butler/{task}"],
    panel: { tab: "tasks", target: "task:BackupDatabase:run" },
  }),
  ...plex("maintenance.run", "Clean bundles or optimize the database", "routine", {
    operation: "app-plex-control",
    api: ["PUT /library/clean/bundles", "PUT /library/optimize"],
    panel: { tab: "tasks", target: "tasks:clean-bundles" },
  }),
  ...plex(
    "settings.edit",
    "Change Plex's server settings (never networking or credentials)",
    "consequential",
    {
      operation: "app-plex-control",
      api: ["GET /:/prefs", "PUT /:/prefs"],
      panel: { tab: "config", target: "settings:review" },
    },
  ),

  // Tautulli (notifications, newsletters and its settings stay in Tautulli).
  ...tautulli("history.read", "See every play, by person, kind and title", "read", {
    api: ["GET /api/v2?cmd=get_history", "GET /api/v2?cmd=get_user_names"],
    panel: { tab: "plays", target: "history:list" },
  }),
  ...tautulli(
    "history.delete",
    "Delete play records (Plex's watched state is untouched)",
    "destructive",
    {
      operation: "app-tautulli-control",
      api: ["GET /api/v2?cmd=get_history", "GET /api/v2?cmd=delete_history"],
      panel: { tab: "plays", target: "history:pick:5" },
    },
  ),
  ...tautulli("people.read", "See who watches, how much and on what", "read", {
    api: [
      "GET /api/v2?cmd=get_users_table",
      "GET /api/v2?cmd=get_user",
      "GET /api/v2?cmd=get_user_watch_time_stats",
      "GET /api/v2?cmd=get_user_player_stats",
    ],
    panel: { tab: "people", target: "people:list" },
  }),
  ...tautulli(
    "person.edit",
    "Rename a person, record their plays or not, guest access",
    "consequential",
    {
      operation: "app-tautulli-control",
      api: ["GET /api/v2?cmd=get_user", "GET /api/v2?cmd=edit_user"],
      panel: { tab: "people/person/1", target: "person:rename" },
    },
  ),
  ...tautulli("libraries.read", "See plays per library", "read", {
    api: ["GET /api/v2?cmd=get_libraries_table"],
    panel: { tab: "libraries", target: "libraries:list" },
  }),
  ...tautulli("library.edit", "Record a library's plays or not", "consequential", {
    operation: "app-tautulli-control",
    api: ["GET /api/v2?cmd=get_library", "GET /api/v2?cmd=edit_library"],
    panel: { tab: "libraries", target: "library:1:history" },
  }),
  ...tautulli("lists.refresh", "Read people and libraries from Plex again", "routine", {
    operation: "app-tautulli-control",
    api: ["GET /api/v2?cmd=refresh_users_list", "GET /api/v2?cmd=refresh_libraries_list"],
    panel: { tab: "people", target: "people:refresh" },
  }),
  ...tautulli("graphs.read", "See plays per day", "read", {
    api: ["GET /api/v2?cmd=get_plays_by_date"],
    panel: { tab: "graphs", target: "graphs:chart" },
  }),
  ...tautulli("log.read", "Read Tautulli's own log, keys hidden", "read", {
    api: ["GET /api/v2?cmd=get_logs"],
    panel: { tab: "system", target: "system:log" },
  }),
  ...tautulli("backup.now", "Back up Tautulli's database now", "routine", {
    operation: "app-tautulli-control",
    api: ["GET /api/v2?cmd=backup_db"],
    panel: { tab: "system", target: "system:backup" },
  }),

  // Wizarr. Its API has no settings or invite steps: the panel's Settings tab uses its admin
  // pages with the admin sign-in from the vault (checked against its source at 2026.9.1). Server
  // configuration, password resets and API keys stay in Wizarr, linked from the panel.
  {
    id: "wizarr.wizard.read",
    app: "wizarr",
    label: "See the invite steps people see before and after they accept",
    risk: "read",
    api: ["GET /settings/wizard/", "GET /settings/wizard/{step_id}/edit"],
    panel: { tab: "config/wizard", target: "settings:wizard" },
    evidence: [
      { version: WIZARR_ADMIN, how: "official-spec" as const, date: "2026-11-04" },
      { version: WIZARR_ADMIN, how: "stand-in" as const, date: "2026-11-04" },
    ],
  },
  {
    id: "wizarr.wizard.add",
    app: "wizarr",
    label: "Add an invite step",
    risk: "consequential",
    operation: "app-wizarr-setup",
    api: ["GET /settings/wizard/create", "POST /settings/wizard/create"],
    panel: { tab: "config/wizard", target: "settings:wizard" },
    evidence: [
      { version: WIZARR_ADMIN, how: "official-spec" as const, date: "2026-11-04" },
      { version: WIZARR_ADMIN, how: "stand-in" as const, date: "2026-11-04" },
    ],
  },
  {
    id: "wizarr.wizard.edit",
    app: "wizarr",
    label: "Edit an invite step",
    risk: "consequential",
    operation: "app-wizarr-setup",
    api: ["POST /settings/wizard/{step_id}/edit"],
    panel: { tab: "config/wizard", target: "settings:wizard" },
    evidence: [
      { version: WIZARR_ADMIN, how: "official-spec" as const, date: "2026-11-04" },
      { version: WIZARR_ADMIN, how: "stand-in" as const, date: "2026-11-04" },
    ],
  },
  {
    id: "wizarr.wizard.move",
    app: "wizarr",
    label: "Reorder invite steps, or move one between before and after",
    risk: "consequential",
    operation: "app-wizarr-setup",
    api: ["POST /settings/wizard/reorder"],
    panel: { tab: "config/wizard", target: "settings:wizard" },
    evidence: [
      { version: WIZARR_ADMIN, how: "official-spec" as const, date: "2026-11-04" },
      { version: WIZARR_ADMIN, how: "stand-in" as const, date: "2026-11-04" },
    ],
  },
  {
    id: "wizarr.wizard.delete",
    app: "wizarr",
    label: "Delete an invite step",
    risk: "destructive",
    operation: "app-wizarr-setup",
    api: ["POST /settings/wizard/{step_id}/delete"],
    panel: { tab: "config/wizard", target: "settings:wizard" },
    evidence: [
      { version: WIZARR_ADMIN, how: "official-spec" as const, date: "2026-11-04" },
      { version: WIZARR_ADMIN, how: "stand-in" as const, date: "2026-11-04" },
    ],
  },
  {
    id: "wizarr.settings.read",
    app: "wizarr",
    label: "See General settings",
    risk: "read",
    api: ["GET /settings/general"],
    panel: { tab: "config", target: "settings:general" },
    evidence: [
      { version: WIZARR_ADMIN, how: "official-spec" as const, date: "2026-11-04" },
      { version: WIZARR_ADMIN, how: "stand-in" as const, date: "2026-11-04" },
    ],
  },
  {
    id: "wizarr.settings.change",
    app: "wizarr",
    label:
      "Change General settings (display name, who can open the guide, what happens when access ends, join page posters)",
    risk: "consequential",
    operation: "app-wizarr-setup",
    api: ["POST /settings/general"],
    panel: { tab: "config", target: "settings:general" },
    evidence: [
      { version: WIZARR_ADMIN, how: "official-spec" as const, date: "2026-11-04" },
      { version: WIZARR_ADMIN, how: "stand-in" as const, date: "2026-11-04" },
    ],
  },
  {
    id: "wizarr.users.clean-expired",
    app: "wizarr",
    label: "Clean expired users now (deletes or disables them)",
    risk: "destructive",
    operation: "app-wizarr-setup",
    api: ["POST /settings/clean-expired-users"],
    panel: { tab: "config", target: "settings:general" },
    evidence: [
      { version: WIZARR_ADMIN, how: "official-spec" as const, date: "2026-11-04" },
      { version: WIZARR_ADMIN, how: "stand-in" as const, date: "2026-11-04" },
    ],
  },
  {
    id: "wizarr.invitations.read",
    app: "wizarr",
    label: "See invitations and whether they were used",
    risk: "read",
    api: ["GET /api/invitations"],
    panel: { tab: "overview", target: "tab:overview" },
    evidence: [PROD(WIZARR)],
  },
  {
    id: "wizarr.invitation.create",
    app: "wizarr",
    label: "Make an invitation",
    risk: "consequential",
    operation: "app-wizarr-invite",
    api: ["POST /api/invitations"],
    panel: { tab: "overview", target: "invites:create" },
    evidence: [PROD(WIZARR)],
  },
  {
    id: "wizarr.invitation.delete",
    app: "wizarr",
    label: "Delete an invitation nobody used",
    risk: "destructive",
    operation: "app-wizarr-invite-delete",
    api: ["DELETE /api/invitations/{invitation_id}"],
    panel: { tab: "overview", target: "invite:delete" },
    evidence: [
      PROD(WIZARR),
      { version: WIZARR, how: "test-instance" as const, date: "2026-11-01" },
    ],
  },
  {
    id: "wizarr.people.read",
    app: "wizarr",
    label: "See everyone with access and when it ends",
    risk: "read",
    api: ["GET /api/users"],
    panel: { tab: "people", target: "people:search" },
    evidence: [
      PROD(WIZARR),
      { version: WIZARR, how: "test-instance" as const, date: "2026-11-01" },
    ],
  },
  {
    id: "wizarr.servers.read",
    app: "wizarr",
    label: "See media servers, what new people may use, and their libraries",
    risk: "read",
    api: ["GET /api/servers", "GET /api/libraries"],
    panel: { tab: "servers", target: "tab:servers" },
    evidence: [
      PROD(WIZARR),
      { version: WIZARR, how: "test-instance" as const, date: "2026-11-01" },
    ],
  },
  {
    id: "wizarr.user.extend",
    app: "wizarr",
    label: "Extend someone's access",
    risk: "consequential",
    operation: "app-wizarr-user",
    api: ["POST /api/users/{user_id}/extend"],
    panel: { tab: "people", target: "people:search" },
    evidence: [{ version: WIZARR, how: "test-instance" as const, date: "2026-11-01" }],
  },
  {
    id: "wizarr.user.expiry",
    app: "wizarr",
    label: "Set or clear when someone's access ends",
    risk: "consequential",
    operation: "app-wizarr-user",
    api: ["PUT /api/users/{user_id}/update-expiry"],
    panel: { tab: "people", target: "people:search" },
    evidence: [{ version: WIZARR, how: "test-instance" as const, date: "2026-11-01" }],
  },
  {
    id: "wizarr.user.disable",
    app: "wizarr",
    label: "Disable or enable someone's account",
    risk: "consequential",
    operation: "app-wizarr-user",
    api: ["POST /api/users/{user_id}/disable"],
    panel: { tab: "people", target: "people:search" },
    evidence: [{ version: WIZARR, how: "test-instance" as const, date: "2026-11-01" }],
  },
  {
    id: "wizarr.user.enable",
    app: "wizarr",
    label: "Enable someone's account again",
    risk: "consequential",
    operation: "app-wizarr-user",
    api: ["POST /api/users/{user_id}/enable"],
    panel: { tab: "people", target: "people:search" },
    evidence: [{ version: WIZARR, how: "test-instance" as const, date: "2026-11-01" }],
  },
  {
    id: "wizarr.user.remove",
    app: "wizarr",
    label: "Remove someone (their media server account goes too)",
    risk: "destructive",
    operation: "app-wizarr-user",
    api: ["DELETE /api/users/{user_id}"],
    panel: { tab: "people", target: "people:search" },
    evidence: [{ version: WIZARR, how: "test-instance" as const, date: "2026-11-01" }],
  },

  // qBittorrent's Settings tab (its seeding, speed, queue, connection and disk settings). Ports,
  // proxies, the Web UI login, privacy settings and save paths are refused and stay in qBittorrent.
  {
    id: "qbittorrent.settings.read",
    app: "qbittorrent",
    label: "See seeding, speed, queue, connection and disk settings, categories and tags",
    risk: "read",
    api: [
      "GET /api/v2/app/preferences",
      "GET /api/v2/torrents/categories",
      "GET /api/v2/torrents/tags",
      "GET /api/v2/transfer/info",
      "GET /api/v2/transfer/speedLimitsMode",
    ],
    panel: { tab: "config", target: "tab:config" },
    evidence: [QBT_TESTED],
  },
  {
    id: "qbittorrent.settings.edit",
    app: "qbittorrent",
    label: "Change seeding, speed, queue, connection and disk settings (one plan, undoable)",
    risk: "consequential",
    operation: "app-qbt-set-preferences",
    api: ["POST /api/v2/app/setPreferences"],
    panel: { tab: "config", target: "settings:review" },
    evidence: [QBT_TESTED],
  },

  // qBittorrent's Torrents tab (checklist 46.11). Default and category folders never change here.
  {
    id: "qbittorrent.torrents.read",
    app: "qbittorrent",
    label:
      "See every torrent: progress, speeds, time left, ratio, category, tags, tracker; find and filter them",
    risk: "read",
    api: ["GET /api/v2/sync/maindata", "GET /api/v2/torrents/info"],
    panel: { tab: "torrents", target: "torrents:search" },
    evidence: [QBT_TORRENTS_TESTED],
  },
  {
    id: "qbittorrent.torrent.detail",
    app: "qbittorrent",
    label: "See a torrent's files, trackers, peers and transfer totals",
    risk: "read",
    api: [
      "GET /api/v2/torrents/files",
      "GET /api/v2/torrents/trackers",
      "GET /api/v2/torrents/properties",
      "GET /api/v2/sync/torrentPeers",
    ],
    panel: { tab: "torrents/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", target: "torrent:peers" },
    evidence: [QBT_TORRENTS_TESTED],
  },
  {
    id: "qbittorrent.torrent.add",
    app: "qbittorrent",
    label:
      "Add torrents: magnet links, .torrent URLs or files, with a category, a known folder, tags, started or stopped",
    risk: "consequential",
    operation: "app-qbt-add",
    api: ["POST /api/v2/torrents/add"],
    panel: { tab: "torrents", target: "torrents:add" },
    evidence: [QBT_TORRENTS_TESTED],
  },
  {
    id: "qbittorrent.torrent.pause-resume",
    app: "qbittorrent",
    label: "Pause or resume a torrent",
    risk: "routine",
    operation: "app-qbt-pause",
    api: ["POST /api/v2/torrents/stop", "POST /api/v2/torrents/start"],
    panel: {
      tab: "torrents/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      target: "torrent:pause-resume",
    },
    evidence: [QBT_TORRENTS_TESTED],
  },
  {
    id: "qbittorrent.torrent.force-start",
    app: "qbittorrent",
    label: "Force start a torrent (past the queue limits), or stop forcing it",
    risk: "consequential",
    operation: "app-qbt-force-start",
    api: ["POST /api/v2/torrents/setForceStart"],
    panel: {
      tab: "torrents/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      target: "torrent:force-start",
    },
    evidence: [QBT_TORRENTS_TESTED],
  },
  {
    id: "qbittorrent.torrent.recheck",
    app: "qbittorrent",
    label: "Recheck a torrent's files on disk",
    risk: "routine",
    operation: "app-qbt-recheck",
    api: ["POST /api/v2/torrents/recheck"],
    panel: { tab: "torrents/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", target: "torrent:recheck" },
    evidence: [QBT_TORRENTS_TESTED],
  },
  {
    id: "qbittorrent.torrent.category",
    app: "qbittorrent",
    label: "Change a torrent's category (the plan says whether its files move)",
    risk: "consequential",
    operation: "app-qbt-set-category",
    api: ["POST /api/v2/torrents/setCategory"],
    panel: { tab: "torrents/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", target: "torrent:category" },
    evidence: [QBT_TORRENTS_TESTED],
  },
  {
    id: "qbittorrent.torrent.tags",
    app: "qbittorrent",
    label: "Add or remove a torrent's tags",
    risk: "consequential",
    operation: "app-qbt-set-tags",
    api: ["POST /api/v2/torrents/addTags", "POST /api/v2/torrents/removeTags"],
    panel: { tab: "torrents/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", target: "torrent:tags" },
    evidence: [QBT_TORRENTS_TESTED],
  },
  {
    id: "qbittorrent.torrent.files",
    app: "qbittorrent",
    label: "Choose which of a torrent's files download, and their priority",
    risk: "consequential",
    operation: "app-qbt-file-priority",
    api: ["POST /api/v2/torrents/filePrio"],
    panel: {
      tab: "torrents/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      target: "torrent:file-priority",
    },
    evidence: [QBT_TORRENTS_TESTED],
  },
  {
    id: "qbittorrent.torrent.remove",
    app: "qbittorrent",
    label: "Remove a torrent, keeping its files",
    risk: "consequential",
    operation: "app-qbt-remove",
    api: ["POST /api/v2/torrents/delete"],
    panel: { tab: "torrents/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", target: "torrent:remove" },
    evidence: [QBT_TORRENTS_TESTED],
  },
  {
    id: "qbittorrent.torrent.remove-data",
    app: "qbittorrent",
    label: "Remove a torrent and delete its downloaded files (cannot be undone)",
    risk: "destructive",
    operation: "app-qbt-remove-with-data",
    api: ["POST /api/v2/torrents/delete"],
    panel: {
      tab: "torrents/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      target: "torrent:remove-data",
    },
    evidence: [QBT_TORRENTS_TESTED],
  },
  {
    id: "qbittorrent.categories",
    app: "qbittorrent",
    label: "Create a category, or remove one no torrent and no Sonarr, Radarr or Lidarr uses",
    risk: "consequential",
    operation: "app-qbt-category",
    api: ["POST /api/v2/torrents/createCategory", "POST /api/v2/torrents/removeCategories"],
    panel: { tab: "torrents", target: "torrents:categories" },
    evidence: [QBT_TORRENTS_TESTED],
  },
  {
    id: "qbittorrent.manual-sort",
    app: "qbittorrent",
    label:
      "Sort manual downloads (no category) by type into their folders and hand them to Radarr, Sonarr, Lidarr or Chaptarr; SABnzbd's too",
    risk: "consequential",
    operation: "app-qbt-manual-sort",
    api: [
      "GET /api/v2/torrents/files",
      "POST /api/v2/torrents/setCategory",
      "POST /api/v2/torrents/createCategory",
    ],
    panel: { tab: "sort", target: "tab:sort" },
    evidence: [QBT_TORRENTS_TESTED],
  },

  // Seerr (Overseerr, Jellyseerr, Seerr 3). Permissions, request limits and settings stay in Seerr.
  {
    id: "seerr.requests.read",
    app: "seerr",
    label: "See every request, with where it stands in Radarr or Sonarr",
    risk: "read",
    api: ["GET /api/v1/request", "GET /api/v1/request/{requestId}"],
    panel: { tab: "overview", target: "tab:overview" },
    evidence: [SEERR_TESTED],
  },
  {
    id: "seerr.request.approve",
    app: "seerr",
    label: "Approve or decline a request waiting for approval",
    risk: "consequential",
    operation: "app-seerr-approve",
    api: ["POST /api/v1/request/{requestId}/{status}"],
    panel: { tab: "overview", target: "seerr-approve" },
    evidence: [SEERR_TESTED],
  },
  {
    id: "seerr.request.remove",
    app: "seerr",
    label: "Stop tracking a request (the movie and its files stay)",
    risk: "destructive",
    operation: "app-seerr-remove",
    api: ["DELETE /api/v1/request/{requestId}"],
    panel: { tab: "overview", target: "seerr-stop-tracking" },
    evidence: [SEERR_TESTED],
  },
  {
    id: "seerr.media.mark-available",
    app: "seerr",
    label: "Tell Seerr a title is already in the library (Radarr or Sonarr has it, Seerr forgot)",
    risk: "consequential",
    operation: "app-seerr-mark-available",
    api: ["POST /api/v1/media/{mediaId}/{status}"],
    panel: { tab: "discover", target: "discover-mark-available" },
    evidence: [SEERR_TESTED],
  },
  {
    id: "seerr.request.retry",
    app: "seerr",
    label: "Retry a request that failed",
    risk: "consequential",
    operation: "app-seerr-retry",
    api: ["POST /api/v1/request/{requestId}/retry"],
    panel: { tab: "overview", target: "seerr-retry" },
    evidence: [SEERR_TESTED],
  },
  {
    id: "seerr.discover.search",
    app: "seerr",
    label: "Find a movie or show the way Seerr does",
    risk: "read",
    api: ["GET /api/v1/search", "GET /api/v1/movie/{movieId}", "GET /api/v1/tv/{tvId}"],
    panel: { tab: "discover", target: "discover:search" },
    evidence: [SEERR_TESTED],
  },
  {
    id: "seerr.request.create",
    app: "seerr",
    label: "Request a movie, or a show by season",
    risk: "consequential",
    operation: "app-seerr-request",
    api: ["POST /api/v1/request"],
    panel: { tab: "discover", target: "discover:find" },
    evidence: [SEERR_TESTED],
  },
  {
    id: "seerr.issues.read",
    app: "seerr",
    label: "See reported problems and their conversation",
    risk: "read",
    api: ["GET /api/v1/issue", "GET /api/v1/issue/{issueId}"],
    panel: { tab: "issues", target: "issues:open" },
    evidence: [SEERR_TESTED],
  },
  {
    id: "seerr.issue.comment",
    app: "seerr",
    label: "Reply to an issue",
    risk: "consequential",
    operation: "app-seerr-issue",
    api: ["POST /api/v1/issue/{issueId}/comment"],
    panel: { tab: "issues", target: "issue:comment" },
    evidence: [SEERR_TESTED],
  },
  {
    id: "seerr.issue.status",
    app: "seerr",
    label: "Resolve or reopen an issue",
    risk: "consequential",
    operation: "app-seerr-issue",
    api: ["POST /api/v1/issue/{issueId}/{status}"],
    panel: { tab: "issues", target: "issue:resolve" },
    evidence: [SEERR_TESTED],
  },
  {
    id: "seerr.issue.delete",
    app: "seerr",
    label: "Delete an issue",
    risk: "destructive",
    operation: "app-seerr-issue",
    api: ["DELETE /api/v1/issue/{issueId}"],
    panel: { tab: "issues", target: "issue:delete" },
    evidence: [SEERR_TESTED],
  },
  {
    id: "seerr.users.read",
    app: "seerr",
    label: "See who can request, how much, and their limits",
    risk: "read",
    api: ["GET /api/v1/user"],
    panel: { tab: "people", target: "tab:people" },
    evidence: [SEERR_TESTED],
  },

  // SABnzbd. Usenet servers, their logins and other settings stay in SABnzbd.
  {
    id: "sabnzbd.queue.read",
    app: "sabnzbd",
    label: "See what is downloading, the history and why a download failed",
    risk: "read",
    api: [
      "GET /api mode=queue",
      "GET /api mode=history",
      "GET /api mode=warnings",
      "GET /api mode=get_cats",
    ],
    panel: { tab: "overview", target: "tab:overview" },
    evidence: [SAB_TESTED],
  },
  {
    id: "sabnzbd.downloads.find",
    app: "sabnzbd",
    label: "Find a download by name, status or category",
    risk: "read",
    api: ["GET /api mode=queue"],
    panel: { tab: "downloads", target: "downloads:search" },
    evidence: [SAB_DOWNLOADS_TESTED],
  },
  {
    id: "sabnzbd.history.find",
    app: "sabnzbd",
    label: "Search the history, failed only or by category, fifty at a time",
    risk: "read",
    api: ["GET /api mode=history"],
    panel: { tab: "downloads", target: "history:search" },
    evidence: [SAB_DOWNLOADS_TESTED],
  },
  {
    id: "sabnzbd.job.files",
    app: "sabnzbd",
    label: "See a download's files and how much of each is left",
    risk: "read",
    api: ["GET /api mode=get_files"],
    panel: { tab: "downloads/SABnzbd_nzo_a1", target: "job:files" },
    evidence: [SAB_DOWNLOADS_TESTED],
  },
  {
    id: "sabnzbd.add",
    app: "sabnzbd",
    label: "Add NZBs: links or .nzb files, with a category, a priority or paused, and a name",
    risk: "consequential",
    operation: "app-sabnzbd-control",
    api: ["GET /api mode=addurl", "POST /api mode=addfile"],
    panel: { tab: "downloads", target: "downloads:add" },
    evidence: [SAB_DOWNLOADS_TESTED],
  },
  {
    id: "sabnzbd.pause",
    app: "sabnzbd",
    label: "Pause or resume everything, or one download",
    risk: "consequential",
    operation: "app-sabnzbd-control",
    api: [
      "GET /api mode=pause",
      "GET /api mode=resume",
      "GET /api mode=queue name=pause",
      "GET /api mode=queue name=resume",
    ],
    panel: { tab: "downloads/SABnzbd_nzo_a1", target: "job:pause-resume" },
    evidence: [SAB_TESTED],
  },
  {
    id: "sabnzbd.pause-for",
    app: "sabnzbd",
    label: "Pause everything for a while",
    risk: "consequential",
    operation: "app-sabnzbd-control",
    api: ["GET /api mode=config name=set_pause"],
    panel: { tab: "overview", target: "sab:pause-for" },
    evidence: [SAB_TESTED],
  },
  {
    id: "sabnzbd.speed-limit",
    app: "sabnzbd",
    label: "Set or lift the speed limit",
    risk: "consequential",
    operation: "app-sabnzbd-control",
    api: ["GET /api mode=config name=speedlimit"],
    panel: { tab: "overview", target: "sab:speed-limit" },
    evidence: [SAB_TESTED],
  },
  {
    id: "sabnzbd.job.priority",
    app: "sabnzbd",
    label: "Change a download's priority",
    risk: "consequential",
    operation: "app-sabnzbd-control",
    api: ["GET /api mode=queue name=priority"],
    panel: { tab: "downloads/SABnzbd_nzo_a1", target: "job:priority" },
    evidence: [SAB_TESTED],
  },
  {
    id: "sabnzbd.job.move",
    app: "sabnzbd",
    label: "Move a download in the queue",
    risk: "consequential",
    operation: "app-sabnzbd-control",
    api: ["GET /api mode=switch"],
    panel: { tab: "downloads/SABnzbd_nzo_b2", target: "job:top" },
    evidence: [SAB_TESTED],
  },
  {
    id: "sabnzbd.job.category",
    app: "sabnzbd",
    label: "Change a download's category",
    risk: "consequential",
    operation: "app-sabnzbd-control",
    api: ["GET /api mode=change_cat"],
    panel: { tab: "downloads/SABnzbd_nzo_a1", target: "job:category" },
    evidence: [SAB_TESTED],
  },
  {
    id: "sabnzbd.retry",
    app: "sabnzbd",
    label: "Retry a failed download",
    risk: "consequential",
    operation: "app-sabnzbd-control",
    api: ["GET /api mode=retry"],
    panel: { tab: "downloads", target: "history:retry" },
    evidence: [SAB_TESTED],
  },
  {
    id: "sabnzbd.remove",
    app: "sabnzbd",
    label: "Remove a download or a history entry (its files only if asked)",
    risk: "destructive",
    operation: "app-sabnzbd-control",
    api: ["GET /api mode=queue name=delete", "GET /api mode=history name=delete"],
    panel: { tab: "downloads/SABnzbd_nzo_a1", target: "job:remove" },
    evidence: [SAB_TESTED],
  },
  {
    id: "sabnzbd.warnings.clear",
    app: "sabnzbd",
    label: "Clear SABnzbd's warnings",
    risk: "routine",
    operation: "app-sabnzbd-control",
    api: ["GET /api mode=warnings name=clear"],
    panel: { tab: "overview", target: "warnings:clear" },
    evidence: [SAB_DOWNLOADS_TESTED],
  },
];

/** The capabilities of one app. */
export const capabilitiesOf = (app: AppKind) => CAPABILITIES.filter((c) => c.app === app);

/**
 * How an installed version relates to what Hearth verified (D8):
 * - verified: the exact version a capability was checked on.
 * - supported: a major version Hearth supports; same API shape, not this exact build.
 * - unknown: another major, or no version reported. Hearth keeps working as before and says so;
 *   it does not switch off proven-safe functions only because the number differs.
 */
export type VersionFit = "verified" | "supported" | "unknown";

export function versionFit(app: AppKind, version: string | undefined): VersionFit {
  if (!version) return "unknown";
  const checked = CAPABILITIES.filter((c) => c.app === app).flatMap((c) =>
    c.evidence.filter((e) => e.how !== "stand-in").map((e) => e.version),
  );
  if (checked.includes(version)) return "verified";
  const major = Number(version.split(".")[0]);
  return SUPPORTED_MAJORS[app]?.includes(major) ? "supported" : "unknown";
}
