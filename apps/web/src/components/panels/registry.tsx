import { lazy, useEffect, type ComponentType, type LazyExoticComponent } from "react";
import type { AppKind } from "@dragon-control/core";
import type { ArrView } from "../dashboards/ArrDashboard";

/**
 * Which tabs each app's panel has (native panels Phase 1, D2). Overview is always first and is
 * the app's everyday dashboard; deeper, app-appropriate tabs follow (Radarr: Library, Activity, Wanted,
 * Settings, System). Hearth's own tabs about the service (Health, Logs, Notes...) are added by the service
 * panel under its Hearth group, so an app never has to repeat them.
 *
 * Views load only when their tab is opened (lazy), so opening a panel never downloads or runs the
 * code of tabs nobody looked at.
 */
export interface AppViewProps {
  serviceId: string;
  name: string;
  /** Where inside the tab, from the address ("movie/42"), when the tab supports it. */
  sub?: string | null;
  onSub?: (sub: string | null) => void;
  /** Opens another tab of the same panel, at a place inside it ("library", "movie/42"). */
  onGo?: (tab: string, sub?: string | null) => void;
}

export interface AppTab {
  id: string;
  label: string;
  view: LazyExoticComponent<ComponentType<AppViewProps>>;
}

export interface AppPanel {
  overview: LazyExoticComponent<ComponentType<AppViewProps>>;
  tabs: AppTab[];
  /** The tab the panel opens on when none is named (Overview when absent). */
  start?: string;
}

/** A named export as a lazily loaded view. */
const view = <M,>(load: () => Promise<M>, pick: (m: M) => ComponentType<AppViewProps>) =>
  lazy(async () => ({ default: pick(await load()) }));

/**
 * A Sonarr tab: Sonarr's own views, or the Radarr panel's shared ones (Activity, Settings,
 * System) under a Sonarr context so they read Sonarr and say its name (Phase 3).
 */
const inServarr =
  (app: "sonarr" | "prowlarr" | "lidarr") =>
  <M,>(load: () => Promise<M>, pick: (m: M) => ComponentType<AppViewProps>) =>
    lazy(async () => {
      const [mod, data] = await Promise.all([load(), import("../dashboards/radarr/data")]);
      const Inner = pick(mod);
      return {
        default: function ServarrTab(props: AppViewProps) {
          return (
            <data.ServarrContext.Provider value={app}>
              <Inner {...props} />
            </data.ServarrContext.Provider>
          );
        },
      };
    });
const sonarr = inServarr("sonarr");
/** A Prowlarr tab: its own views, or the shared Connections and System under its context. */
const prowlarr = inServarr("prowlarr");
/** A Lidarr tab: its own views, or the shared Activity, Settings and System under its context. */
const lidarr = inServarr("lidarr");

/**
 * Radarr's and Sonarr's Overview: the everyday summary. The queue, trail and recent imports live in
 * Activity and missing items in Wanted; old addresses that pointed inside Overview open those
 * tabs. Health warnings link to the setting that fixes them.
 */
const RADARR_OVERVIEW_VIEWS = ["coming", "upgrades", "collections", "find", "search"] as const;
const SONARR_OVERVIEW_VIEWS = ["upcoming", "search"] as const;
/** Where an old Overview address now lives: [tab, place inside it]. */
function movedFrom(sub: string | null | undefined): readonly [string, string | null] | undefined {
  if (sub === "queue") return ["activity", null];
  if (sub === "trail" || sub === "recent") return ["activity", `queue/${sub}`];
  if (sub === "missing") return ["wanted", null];
  return undefined;
}
const servarrOverview = (name: string, views: readonly ArrView[]) =>
  view(
    () => import("../dashboards/ArrDashboard"),
    (m) =>
      function ServarrOverview({ serviceId, sub, onSub, onGo }: AppViewProps) {
        const moved = movedFrom(sub);
        useEffect(() => {
          const to = movedFrom(sub);
          if (to && onGo) onGo(to[0], to[1]);
        }, [sub, onGo]);
        if (moved && onGo) return null;
        return (
          <m.ArrDashboard
            serviceId={serviceId}
            name={name}
            section={sub}
            onSection={onSub}
            views={views}
            onFix={onGo ? (tab, place) => onGo(tab, place) : undefined}
            tabs={
              onGo
                ? {
                    activity: (part) => onGo("activity", part ?? null),
                    wanted: () => onGo("wanted", null),
                  }
                : undefined
            }
          />
        );
      },
  );
const radarrOverview = servarrOverview("Radarr", RADARR_OVERVIEW_VIEWS);

export const APP_PANELS: Partial<Record<AppKind, AppPanel>> = {
  radarr: {
    overview: radarrOverview,
    tabs: [
      {
        id: "library",
        label: "Library",
        view: view(
          () => import("../dashboards/radarr/RadarrLibrary"),
          (m) => m.RadarrLibrary,
        ),
      },
      {
        id: "activity",
        label: "Activity",
        view: view(
          () => import("../dashboards/radarr/RadarrActivity"),
          (m) => m.RadarrActivity,
        ),
      },
      {
        id: "wanted",
        label: "Wanted",
        view: view(
          () => import("../dashboards/radarr/RadarrWanted"),
          (m) => m.RadarrWanted,
        ),
      },
      {
        id: "config",
        label: "Settings",
        view: view(
          () => import("../dashboards/radarr/RadarrSettings"),
          (m) => m.RadarrSettings,
        ),
      },
      {
        id: "system",
        label: "System",
        view: view(
          () => import("../dashboards/radarr/RadarrSystem"),
          (m) => m.RadarrSystem,
        ),
      },
    ],
  },
  sonarr: {
    overview: servarrOverview("Sonarr", SONARR_OVERVIEW_VIEWS),
    tabs: [
      {
        id: "library",
        label: "Library",
        view: sonarr(
          () => import("../dashboards/sonarr/SonarrLibrary"),
          (m) => m.SonarrLibrary,
        ),
      },
      {
        id: "activity",
        label: "Activity",
        view: sonarr(
          () => import("../dashboards/radarr/RadarrActivity"),
          (m) => m.RadarrActivity,
        ),
      },
      {
        id: "wanted",
        label: "Wanted",
        view: sonarr(
          () => import("../dashboards/sonarr/SonarrWanted"),
          (m) => m.SonarrWanted,
        ),
      },
      {
        id: "config",
        label: "Settings",
        view: sonarr(
          () => import("../dashboards/radarr/RadarrSettings"),
          (m) => m.RadarrSettings,
        ),
      },
      {
        id: "system",
        label: "System",
        view: sonarr(
          () => import("../dashboards/radarr/RadarrSystem"),
          (m) => m.RadarrSystem,
        ),
      },
    ],
  },
  qbittorrent: {
    overview: view(
      () => import("../dashboards/QbittorrentDashboard"),
      (m) =>
        function QbittorrentOverview({ serviceId, onGo }: AppViewProps) {
          return <m.QbittorrentDashboard serviceId={serviceId} onGo={onGo} />;
        },
    ),
    tabs: [
      {
        id: "torrents",
        label: "Torrents",
        view: view(
          () => import("../dashboards/qbittorrent/QbTorrents"),
          (m) => m.QbTorrents,
        ),
      },
      {
        // Torrents added by hand (no category): sorted by type and handed to the apps.
        id: "sort",
        label: "Manual downloads",
        view: view(
          () => import("../dashboards/qbittorrent/QbSort"),
          (m) => m.QbSort,
        ),
      },
      {
        id: "config",
        label: "Settings",
        view: view(
          () => import("../dashboards/QbittorrentSettings"),
          (m) => m.QbittorrentSettings,
        ),
      },
    ],
  },
  deluge: {
    overview: view(
      () => import("../dashboards/QbittorrentDashboard"),
      (m) =>
        function DelugeOverview({ serviceId, onGo }: AppViewProps) {
          return <m.DelugeDashboard serviceId={serviceId} onGo={onGo} />;
        },
    ),
    tabs: [
      {
        id: "torrents",
        label: "Torrents",
        view: view(
          () => import("../dashboards/qbittorrent/QbTorrents"),
          (m) => m.DelugeTorrents,
        ),
      },
      {
        id: "config",
        label: "Settings",
        view: view(
          () => import("../dashboards/DelugeSettings"),
          (m) => m.DelugeSettings,
        ),
      },
    ],
  },
  transmission: {
    overview: view(
      () => import("../dashboards/QbittorrentDashboard"),
      (m) =>
        function TransmissionOverview({ serviceId, onGo }: AppViewProps) {
          return <m.TransmissionDashboard serviceId={serviceId} onGo={onGo} />;
        },
    ),
    tabs: [
      {
        id: "torrents",
        label: "Torrents",
        view: view(
          () => import("../dashboards/qbittorrent/QbTorrents"),
          (m) => m.TransmissionTorrents,
        ),
      },
      {
        id: "config",
        label: "Settings",
        view: view(
          () => import("../dashboards/TransmissionSettings"),
          (m) => m.TransmissionSettings,
        ),
      },
    ],
  },
  plex: {
    // Opens on Home, the home screen and its rows (11-21); Overview is one tab away.
    start: "home",
    overview: view(
      () => import("../dashboards/PlexDashboard"),
      (m) =>
        function PlexOverview({ serviceId }: AppViewProps) {
          return <m.PlexDashboard serviceId={serviceId} />;
        },
    ),
    tabs: [
      {
        // Opens here (11-21): the home screen and its rows, with Refresh.
        id: "home",
        label: "Home",
        view: view(
          () => import("../homeRows/HomeRowsPanel"),
          (m) =>
            function MediaHome({ serviceId }: AppViewProps) {
              return <m.ServerHome serviceId={serviceId} />;
            },
        ),
      },
      {
        id: "library",
        label: "Library",
        view: view(
          () => import("../dashboards/plex/PlexTabs"),
          (m) => m.PlexLibrary,
        ),
      },
      {
        // Not "history": that is Hearth's History tool.
        id: "plays",
        label: "History",
        view: view(
          () => import("../dashboards/plex/PlexTabs"),
          (m) => m.PlexHistory,
        ),
      },
      {
        id: "tasks",
        label: "Tasks",
        view: view(
          () => import("../dashboards/plex/PlexTabs"),
          (m) => m.PlexTasks,
        ),
      },
      {
        id: "manage",
        label: "Manage",
        view: view(
          () => import("../dashboards/plex/PlexTabs"),
          (m) => m.PlexManage,
        ),
      },
      {
        id: "config",
        label: "Settings",
        view: view(
          () => import("../dashboards/plex/PlexTabs"),
          (m) => m.PlexSettings,
        ),
      },
    ],
  },
  seerr: {
    overview: view(
      () => import("../dashboards/SeerrDashboard"),
      (m) => m.SeerrDashboard,
    ),
    tabs: [
      {
        id: "discover",
        label: "Discover",
        view: view(
          () => import("../dashboards/seerr/SeerrDiscover"),
          (m) => m.SeerrDiscover,
        ),
      },
      {
        id: "issues",
        label: "Issues",
        view: view(
          () => import("../dashboards/seerr/SeerrIssues"),
          (m) => m.SeerrIssues,
        ),
      },
      {
        id: "people",
        label: "People",
        view: view(
          () => import("../dashboards/seerr/SeerrPeople"),
          (m) => m.SeerrPeople,
        ),
      },
    ],
  },
  wizarr: {
    overview: view(
      () => import("../dashboards/WizarrDashboard"),
      (m) => m.WizarrDashboard,
    ),
    tabs: [
      {
        id: "people",
        label: "People",
        view: view(
          () => import("../dashboards/wizarr/WizarrPeople"),
          (m) => m.WizarrPeople,
        ),
      },
      {
        id: "servers",
        label: "Servers",
        view: view(
          () => import("../dashboards/wizarr/WizarrServers"),
          (m) => m.WizarrServers,
        ),
      },
      {
        id: "config",
        label: "Settings",
        view: view(
          () => import("../dashboards/wizarr/WizarrSetup"),
          (m) => m.WizarrSettings,
        ),
      },
    ],
  },
  tautulli: {
    overview: view(
      () => import("../dashboards/TautulliDashboard"),
      (m) => m.TautulliDashboard,
    ),
    tabs: [
      {
        id: "plays",
        label: "History",
        view: view(
          () => import("../dashboards/tautulli/TautulliTabs"),
          (m) => m.TautulliHistory,
        ),
      },
      {
        id: "people",
        label: "People",
        view: view(
          () => import("../dashboards/tautulli/TautulliTabs"),
          (m) => m.TautulliPeople,
        ),
      },
      {
        id: "libraries",
        label: "Libraries",
        view: view(
          () => import("../dashboards/tautulli/TautulliTabs"),
          (m) => m.TautulliLibraries,
        ),
      },
      {
        id: "graphs",
        label: "Graphs",
        view: view(
          () => import("../dashboards/tautulli/TautulliTabs"),
          (m) => m.TautulliGraphs,
        ),
      },
      {
        id: "system",
        label: "System",
        view: view(
          () => import("../dashboards/tautulli/TautulliTabs"),
          (m) => m.TautulliSystem,
        ),
      },
    ],
  },
  sabnzbd: {
    overview: view(
      () => import("../dashboards/SabnzbdDashboard"),
      (m) =>
        function SabnzbdOverview({ serviceId, name, onGo }: AppViewProps) {
          return <m.SabnzbdDashboard serviceId={serviceId} name={name} onGo={onGo} />;
        },
    ),
    tabs: [
      {
        id: "downloads",
        label: "Downloads",
        view: view(
          () => import("../dashboards/sabnzbd/SabDownloads"),
          (m) => m.SabDownloads,
        ),
      },
    ],
  },
  nzbget: {
    overview: view(
      () => import("../dashboards/SabnzbdDashboard"),
      (m) =>
        function NzbgetOverview({ serviceId, name, onGo }: AppViewProps) {
          return <m.NzbgetDashboard serviceId={serviceId} name={name} onGo={onGo} />;
        },
    ),
    tabs: [
      {
        id: "downloads",
        label: "Downloads",
        view: view(
          () => import("../dashboards/sabnzbd/SabDownloads"),
          (m) => m.NzbgetDownloads,
        ),
      },
    ],
  },
  prowlarr: {
    overview: view(
      () => import("../dashboards/ProwlarrDashboard"),
      (m) => m.ProwlarrDashboard,
    ),
    tabs: [
      {
        id: "indexers",
        label: "Indexers",
        view: prowlarr(
          () => import("../dashboards/prowlarr/ProwlarrIndexers"),
          (m) => m.ProwlarrIndexers,
        ),
      },
      {
        id: "search",
        label: "Search",
        view: prowlarr(
          () => import("../dashboards/prowlarr/ProwlarrSearch"),
          (m) => m.ProwlarrSearch,
        ),
      },
      {
        // Not "history": that is Hearth's History tool.
        id: "grabs",
        label: "History",
        view: prowlarr(
          () => import("../dashboards/prowlarr/ProwlarrMore"),
          (m) => m.ProwlarrHistory,
        ),
      },
      {
        id: "config",
        label: "Settings",
        view: prowlarr(
          () => import("../dashboards/prowlarr/ProwlarrMore"),
          (m) => m.ProwlarrSettings,
        ),
      },
      {
        id: "system",
        label: "System",
        view: prowlarr(
          () => import("../dashboards/radarr/RadarrSystem"),
          (m) => m.RadarrSystem,
        ),
      },
    ],
  },
  bazarr: {
    overview: view(
      () => import("../dashboards/BazarrDashboard"),
      (m) => m.BazarrDashboard,
    ),
    tabs: [],
  },
  ersatztv: {
    overview: view(
      () => import("../dashboards/ErsatzDashboard"),
      (m) => m.ErsatzDashboard,
    ),
    tabs: [],
  },
  romm: {
    overview: view(
      () => import("../dashboards/romm/RommOverview"),
      (m) => m.RommOverview,
    ),
    tabs: [
      {
        id: "library",
        label: "Library",
        view: view(
          () => import("../dashboards/romm/RommLibrary"),
          (m) => m.RommLibrary,
        ),
      },
      {
        id: "platforms",
        label: "Platforms",
        view: view(
          () => import("../dashboards/romm/RommPlatforms"),
          (m) => m.RommPlatforms,
        ),
      },
    ],
  },
  pihole: {
    overview: view(
      () => import("../dashboards/PiholeDashboard"),
      (m) => m.PiholeDashboard,
    ),
    tabs: [
      {
        id: "queries",
        label: "Query log",
        view: view(
          () => import("../dashboards/PiholeQueries"),
          (m) => m.PiholeQueries,
        ),
      },
      {
        id: "lists",
        label: "Lists and domains",
        view: view(
          () => import("../dashboards/PiholeDashboard"),
          (m) => m.PiholeLists,
        ),
      },
      {
        id: "dns",
        label: "Local DNS",
        view: view(
          () => import("../dashboards/PiholeQueries"),
          (m) => m.PiholeDns,
        ),
      },
    ],
  },
  adguard: {
    overview: view(
      () => import("../dashboards/AdguardDashboard"),
      (m) => m.AdguardDashboard,
    ),
    tabs: [
      {
        id: "queries",
        label: "Query log",
        view: view(
          () => import("../dashboards/AdguardQueries"),
          (m) => m.AdguardQueries,
        ),
      },
      {
        id: "filters",
        label: "Filters",
        view: view(
          () => import("../dashboards/AdguardDashboard"),
          (m) => m.AdguardFilters,
        ),
      },
      {
        id: "services",
        label: "Blocked services",
        view: view(
          () => import("../dashboards/AdguardDashboard"),
          (m) => m.AdguardServices,
        ),
      },
      {
        id: "rewrites",
        label: "DNS rewrites",
        view: view(
          () => import("../dashboards/AdguardDashboard"),
          (m) => m.AdguardRewrites,
        ),
      },
    ],
  },
  proxmox: {
    overview: view(
      () => import("../dashboards/ProxmoxDashboard"),
      (m) => m.ProxmoxDashboard,
    ),
    tabs: [
      {
        id: "guests",
        label: "VMs and containers",
        view: view(
          () => import("../dashboards/ProxmoxDashboard"),
          (m) => m.ProxmoxGuests,
        ),
      },
      {
        id: "backups",
        label: "Backups",
        view: view(
          () => import("../dashboards/ProxmoxDashboard"),
          (m) => m.ProxmoxBackups,
        ),
      },
    ],
  },
  npm: {
    overview: view(
      () => import("../dashboards/NpmDashboard"),
      (m) => m.NpmDashboard,
    ),
    tabs: [
      {
        id: "sites",
        label: "Sites",
        view: view(
          () => import("../dashboards/NpmDashboard"),
          (m) => m.NpmSites,
        ),
      },
      {
        id: "certificates",
        label: "Certificates",
        view: view(
          () => import("../dashboards/NpmDashboard"),
          (m) => m.NpmCertificates,
        ),
      },
    ],
  },
  traefik: {
    overview: view(
      () => import("../dashboards/TraefikDashboard"),
      (m) => m.TraefikDashboard,
    ),
    tabs: [
      {
        id: "routers",
        label: "Routers",
        view: view(
          () => import("../dashboards/TraefikDashboard"),
          (m) => m.TraefikRouters,
        ),
      },
      {
        id: "certificates",
        label: "Certificates",
        view: view(
          () => import("../dashboards/TraefikDashboard"),
          (m) => m.TraefikCertificates,
        ),
      },
    ],
  },
  portainer: {
    overview: view(
      () => import("../dashboards/PortainerDashboard"),
      (m) => m.PortainerDashboard,
    ),
    tabs: [
      {
        id: "stacks",
        label: "Stacks and containers",
        view: view(
          () => import("../dashboards/PortainerDashboard"),
          (m) => m.PortainerStacks,
        ),
      },
    ],
  },
  uptimekuma: {
    overview: view(
      () => import("../dashboards/UptimeKumaDashboard"),
      (m) => m.UptimeKumaDashboard,
    ),
    tabs: [
      {
        id: "monitors",
        label: "Monitors",
        view: view(
          () => import("../dashboards/UptimeKumaDashboard"),
          (m) => m.UptimeKumaMonitors,
        ),
      },
    ],
  },
  authelia: {
    overview: view(
      () => import("../dashboards/AutheliaDashboard"),
      (m) => m.AutheliaDashboard,
    ),
    tabs: [],
  },
  frigate: {
    overview: view(
      () => import("../dashboards/FrigateDashboard"),
      (m) => m.FrigateDashboard,
    ),
    tabs: [],
  },
  authentik: {
    overview: view(
      () => import("../dashboards/AuthentikDashboard"),
      (m) => m.AuthentikDashboard,
    ),
    tabs: [
      {
        id: "people",
        label: "People",
        view: view(
          () => import("../dashboards/AuthentikDashboard"),
          (m) => m.AuthentikPeople,
        ),
      },
    ],
  },
  actual: {
    overview: view(
      () => import("../dashboards/ActualDashboard"),
      (m) => m.ActualDashboard,
    ),
    tabs: [],
  },
  mealie: {
    overview: view(
      () => import("../dashboards/MealieDashboard"),
      (m) => m.MealieDashboard,
    ),
    tabs: [],
  },
  gitea: {
    overview: view(
      () => import("../dashboards/GiteaDashboard"),
      (m) => m.GiteaDashboard,
    ),
    tabs: [
      {
        id: "actions",
        label: "Actions",
        view: view(
          () => import("../dashboards/GiteaDashboard"),
          (m) => m.GiteaActions,
        ),
      },
    ],
  },
  komga: {
    overview: view(
      () => import("../dashboards/KomgaDashboard"),
      (m) => m.KomgaDashboard,
    ),
    tabs: [
      {
        id: "books",
        label: "Books",
        view: view(
          () => import("../dashboards/KomgaDashboard"),
          (m) => m.KomgaBooks,
        ),
      },
      {
        id: "people",
        label: "People",
        view: view(
          () => import("../dashboards/KomgaDashboard"),
          (m) => m.KomgaPeople,
        ),
      },
    ],
  },
  navidrome: {
    overview: view(
      () => import("../dashboards/NavidromeDashboard"),
      (m) => m.NavidromeDashboard,
    ),
    tabs: [
      {
        id: "people",
        label: "People",
        view: view(
          () => import("../dashboards/NavidromeDashboard"),
          (m) => m.NavidromePeople,
        ),
      },
    ],
  },
  wgeasy: {
    overview: view(
      () => import("../dashboards/WgEasyDashboard"),
      (m) => m.WgEasyDashboard,
    ),
    tabs: [
      {
        id: "clients",
        label: "Clients",
        view: view(
          () => import("../dashboards/WgEasyDashboard"),
          (m) => m.WgEasyClients,
        ),
      },
    ],
  },
  tailscale: {
    overview: view(
      () => import("../dashboards/TailscaleDashboard"),
      (m) => m.TailscaleDashboard,
    ),
    tabs: [
      {
        id: "devices",
        label: "Devices",
        view: view(
          () => import("../dashboards/TailscaleDashboard"),
          (m) => m.TailscaleDevices,
        ),
      },
    ],
  },
  vaultwarden: {
    overview: view(
      () => import("../dashboards/VaultwardenDashboard"),
      (m) => m.VaultwardenDashboard,
    ),
    tabs: [
      {
        id: "accounts",
        label: "Accounts",
        view: view(
          () => import("../dashboards/VaultwardenDashboard"),
          (m) => m.VaultwardenAccounts,
        ),
      },
    ],
  },
  paperless: {
    overview: view(
      () => import("../dashboards/PaperlessDashboard"),
      (m) => m.PaperlessDashboard,
    ),
    tabs: [
      {
        id: "inbox",
        label: "Inbox",
        view: view(
          () => import("../dashboards/PaperlessDashboard"),
          (m) => m.PaperlessInbox,
        ),
      },
      {
        id: "documents",
        label: "Documents",
        view: view(
          () => import("../dashboards/PaperlessDashboard"),
          (m) => m.PaperlessDocuments,
        ),
      },
    ],
  },
  nextcloud: {
    overview: view(
      () => import("../dashboards/NextcloudDashboard"),
      (m) => m.NextcloudDashboard,
    ),
    tabs: [
      {
        id: "accounts",
        label: "Accounts",
        view: view(
          () => import("../dashboards/NextcloudDashboard"),
          (m) => m.NextcloudAccounts,
        ),
      },
      {
        id: "apps",
        label: "Apps",
        view: view(
          () => import("../dashboards/NextcloudDashboard"),
          (m) => m.NextcloudApps,
        ),
      },
    ],
  },
  kavita: {
    overview: view(
      () => import("../dashboards/KavitaDashboard"),
      (m) => m.KavitaDashboard,
    ),
    tabs: [],
  },
  audiobookshelf: {
    overview: view(
      () => import("../dashboards/AudiobookshelfDashboard"),
      (m) => m.AudiobookshelfDashboard,
    ),
    tabs: [
      {
        // Finished audiobook downloads, identified and copied in as Author/Title.
        id: "intake",
        label: "Intake",
        view: view(
          () => import("../dashboards/audiobookshelf/AbsIntake"),
          (m) => m.AbsIntake,
        ),
      },
    ],
  },
  immich: {
    overview: view(
      () => import("../dashboards/ImmichDashboard"),
      (m) => m.ImmichDashboard,
    ),
    tabs: [
      {
        id: "photos",
        label: "Photos",
        view: view(
          () => import("../dashboards/immich/photos"),
          (m) => m.ImmichPhotos,
        ),
      },
      {
        // Not "files": that id is Hearth's own Files tool in every panel's Hearth menu.
        id: "folders",
        label: "Files and folders",
        view: view(
          () => import("../dashboards/immich/files"),
          (m) => m.ImmichFiles,
        ),
      },
    ],
  },
  jellyfin: {
    // Opens on Home, the home screen and its rows (11-21); Overview is one tab away.
    start: "home",
    overview: view(
      () => import("../dashboards/JellyfinDashboard"),
      (m) => m.JellyfinDashboard,
    ),
    // Laid out like Plex's (11-04): Library, then Manage, Plugins and Settings beside the rest.
    tabs: [
      {
        // Opens here (11-21): the home screen and its rows, with Refresh.
        id: "home",
        label: "Home",
        view: view(
          () => import("../homeRows/HomeRowsPanel"),
          (m) =>
            function MediaHome({ serviceId }: AppViewProps) {
              return <m.ServerHome serviceId={serviceId} />;
            },
        ),
      },
      {
        id: "library",
        label: "Library",
        view: view(
          () => import("../dashboards/jellyfin/JellyfinManage"),
          (m) => m.JellyfinLibrary,
        ),
      },
      {
        id: "tasks",
        label: "Tasks",
        view: view(
          () => import("../dashboards/JellyfinDashboard"),
          (m) => m.JellyfinTasks,
        ),
      },
      {
        id: "people",
        label: "People",
        view: view(
          () => import("../dashboards/jellyfin/JellyfinTabs"),
          (m) => m.JellyfinPeople,
        ),
      },
      {
        id: "devices",
        label: "Devices",
        view: view(
          () => import("../dashboards/jellyfin/JellyfinTabs"),
          (m) => m.JellyfinDevices,
        ),
      },
      {
        id: "activity",
        label: "Activity",
        view: view(
          () => import("../dashboards/jellyfin/JellyfinTabs"),
          (m) => m.JellyfinActivity,
        ),
      },
      {
        id: "manage",
        label: "Manage",
        view: view(
          () => import("../dashboards/jellyfin/JellyfinManage"),
          (m) => m.JellyfinManage,
        ),
      },
      {
        id: "plugins",
        label: "Plugins",
        view: view(
          () => import("../dashboards/jellyfin/JellyfinManage"),
          (m) => m.JellyfinPlugins,
        ),
      },
      {
        // Not "settings": that is Hearth's Settings.
        id: "config",
        label: "Settings",
        view: view(
          () => import("../dashboards/jellyfin/JellyfinManage"),
          (m) => m.JellyfinSettings,
        ),
      },
      {
        id: "system",
        label: "Logs",
        view: view(
          () => import("../dashboards/jellyfin/JellyfinTabs"),
          (m) => m.JellyfinSystem,
        ),
      },
    ],
  },
  // Emby speaks Jellyfin's API (Jellyfin began as Emby's free version): the same views.
  emby: {
    // Opens on Home, the home screen and its rows (11-21); Overview is one tab away.
    start: "home",
    overview: view(
      () => import("../dashboards/JellyfinDashboard"),
      (m) => m.JellyfinDashboard,
    ),
    // Laid out like Plex's (11-04): Library, then Manage, Plugins and Settings beside the rest.
    tabs: [
      {
        // Opens here (11-21): the home screen and its rows, with Refresh.
        id: "home",
        label: "Home",
        view: view(
          () => import("../homeRows/HomeRowsPanel"),
          (m) =>
            function MediaHome({ serviceId }: AppViewProps) {
              return <m.ServerHome serviceId={serviceId} />;
            },
        ),
      },
      {
        id: "library",
        label: "Library",
        view: view(
          () => import("../dashboards/jellyfin/JellyfinManage"),
          (m) => m.JellyfinLibrary,
        ),
      },
      {
        id: "tasks",
        label: "Tasks",
        view: view(
          () => import("../dashboards/JellyfinDashboard"),
          (m) => m.JellyfinTasks,
        ),
      },
      {
        id: "people",
        label: "People",
        view: view(
          () => import("../dashboards/jellyfin/JellyfinTabs"),
          (m) => m.JellyfinPeople,
        ),
      },
      {
        id: "devices",
        label: "Devices",
        view: view(
          () => import("../dashboards/jellyfin/JellyfinTabs"),
          (m) => m.JellyfinDevices,
        ),
      },
      {
        id: "activity",
        label: "Activity",
        view: view(
          () => import("../dashboards/jellyfin/JellyfinTabs"),
          (m) => m.JellyfinActivity,
        ),
      },
      {
        id: "manage",
        label: "Manage",
        view: view(
          () => import("../dashboards/jellyfin/JellyfinManage"),
          (m) => m.JellyfinManage,
        ),
      },
      {
        id: "plugins",
        label: "Plugins",
        view: view(
          () => import("../dashboards/jellyfin/JellyfinManage"),
          (m) => m.JellyfinPlugins,
        ),
      },
      {
        // Not "settings": that is Hearth's Settings.
        id: "config",
        label: "Settings",
        view: view(
          () => import("../dashboards/jellyfin/JellyfinManage"),
          (m) => m.JellyfinSettings,
        ),
      },
      {
        id: "system",
        label: "Logs",
        view: view(
          () => import("../dashboards/jellyfin/JellyfinTabs"),
          (m) => m.JellyfinSystem,
        ),
      },
    ],
  },
  lidarr: {
    overview: view(
      () => import("../dashboards/LibraryDashboard"),
      (m) => m.LibraryDashboard,
    ),
    tabs: [
      {
        id: "library",
        label: "Library",
        view: lidarr(
          () => import("../dashboards/lidarr/LidarrLibrary"),
          (m) => m.LidarrLibrary,
        ),
      },
      {
        id: "activity",
        label: "Activity",
        view: lidarr(
          () => import("../dashboards/radarr/RadarrActivity"),
          (m) => m.RadarrActivity,
        ),
      },
      {
        id: "wanted",
        label: "Wanted",
        view: lidarr(
          () => import("../dashboards/lidarr/LidarrWanted"),
          (m) => m.LidarrWanted,
        ),
      },
      {
        id: "config",
        label: "Settings",
        view: lidarr(
          () => import("../dashboards/radarr/RadarrSettings"),
          (m) => m.RadarrSettings,
        ),
      },
      {
        id: "system",
        label: "System",
        view: lidarr(
          () => import("../dashboards/radarr/RadarrSystem"),
          (m) => m.RadarrSystem,
        ),
      },
    ],
  },
  chaptarr: {
    overview: view(
      () => import("../dashboards/LibraryDashboard"),
      (m) => m.LibraryDashboard,
    ),
    tabs: [],
  },
  syncthing: {
    overview: view(
      () => import("../dashboards/SyncthingDashboard"),
      (m) => m.SyncthingDashboard,
    ),
    tabs: [],
  },
  homeassistant: {
    // Opens on Home, the dashboard (11-07); Overview is one tab away.
    start: "home",
    overview: view(
      () => import("../dashboards/HomeAssistantDashboard"),
      (m) => m.HomeAssistantDashboard,
    ),
    tabs: [
      {
        // The home dashboard (11-04): what a wall tablet shows, with Full screen.
        id: "home",
        label: "Home",
        view: view(
          () => import("../home/HomeTab"),
          (m) => m.HomeTab,
        ),
      },
    ],
  },
};
