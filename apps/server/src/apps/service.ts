import { CHAPTARR_COVER, remoteCover } from "./chaptarr-cover";
import { DownloadHealth } from "./download-health";
import { AudiobookIntake } from "./audiobook-intake";
import { ManualSorter } from "./manual-sort";
import { TorrentOperations } from "./torrent-operations";
import { addManualService } from "../store/systems";
import {
  musicServices,
  serviceAbort,
  serviceStart,
  serviceStep,
  serviceSubmit,
} from "./music-services";
import { youtubeHome } from "./youtube-music";
import { findPlaces, weatherAt } from "./weather";
import type { SpeakerUpstream } from "./speaker-relay";
import { musicVideo } from "./music-video";
import {
  musicHomeRows,
  musicOpen,
  musicQueue,
  type MaCall,
  type MusicRow,
} from "./music-assistant-api";
import { fakeMedia } from "../watches/fake-media";
import {
  addAppCredentials,
  calendarCreate,
  calendarDelete,
  calendarRange,
  calendarUpdate,
  videoOnTv,
  homeCoords,
  type HomeView,
  sceneDelete,
  sceneRead,
  sceneSave,
  type SceneSave,
  type EventInput,
  connectMusicAssistant,
  connectNext,
  deliverSignInCallback,
  connectStart,
  homeAct,
  HomeActionError,
  homePicture,
  musicLibrary,
  musicPlay,
  musicSearch,
  type MusicHow,
  type MusicKind,
  type MusicShelf,
  NEEDS_PIN,
  readHome,
  type FlowStep,
  type HomeAction,
} from "./homeassistant-home";
import { checkPin } from "./home-pin";
import { recordAudit } from "../store/audit";
import { readSeerrView, SeerrReadError, type SeerrView } from "./seerr-panel";
import { eq } from "drizzle-orm";
import {
  APP_INTEGRATIONS,
  DASHBOARD_APPS,
  isCoreNetworking,
  nearMiss,
  HEARTH_PREFIX,
  BLOCK_SCORE,
  arrTitle,
  type CrucibleLibrary,
  type AppDashboard,
  type CaveItem,
  type TorrentDetail,
  type AppDetails,
  type AppDiagnostics,
  type AppIssue,
  type AppKind,
  appKindOf,
  jellyfinLike,
  type AppReport,
  RELEASE_WATCH_DEFAULTS,
  type ReleaseScope,
  type ReleaseSearchResult,
  type SearchApp,
  type WizarrAdminRead,
  type WizarrSettings,
  type WizarrWizard,
  IMMICH_PHOTO_PREFS_DEFAULT,
  type ImmichPhotoPrefs,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withTransaction } from "../db/tx";
import type { Vault } from "../auth/vault";
import { openIncidentFor, raise, settle } from "../monitor/engine";
import { getSetting, setSetting } from "../store/settings";
import { ConflictError, InvalidRequestError, NotFoundError } from "../store/errors";
import { readProwlarr } from "./prowlarr";
import { readArr } from "./arr";
import { readQbittorrent } from "./qbittorrent";
import { readSabnzbd } from "./sabnzbd";
import { DelugeLive, readDeluge } from "./deluge";
import { readTransmission, TransmissionLive } from "./transmission";
import { readArrV1, readBazarr, readSeerr, readSyncthing, readTautulli } from "./more-apps";
import { QbittorrentLive } from "./qbittorrent-live";
import { PLEX_ART, PlexLive, plexReport } from "./plex-live";
import { PlexReadError, readPlexView, type PlexView } from "./plex-panel";
import { PLEX_TV, PlexAccessError, readPlexAccess } from "./plex-access";
import { fakePlex } from "./fake-plex";
import { fakeRadarr, type FakeRadarr } from "./fake-radarr";
import { fakeSonarr, type FakeSonarr } from "./fake-sonarr";
import { fakeProwlarr, type FakeProwlarr } from "./fake-prowlarr";
import { fakeLidarr, type FakeLidarr } from "./fake-lidarr";
import { readRadarrView, type RadarrView } from "./radarr-panel";
import { readSonarrView, type SonarrView } from "./sonarr-panel";
import { readProwlarrView, type ProwlarrView } from "./prowlarr-panel";
import { readLidarrView, type LidarrView } from "./lidarr-panel";
import { ServarrReadError, type ServarrGet } from "./servarr-panel";
import { MediaLibrary } from "./media-library";
import { ArrLive } from "./arr-live";
import { findMovies } from "./radarr-library";
import { SeerrLive } from "./seerr-live";
import { SeerrLibrary } from "./seerr-library";
import { readWizarr, wizarrDashboard } from "./wizarr";
import { PLEX_IMAGE, tautulliCmd, tautulliDashboard } from "./tautulli";
import {
  readTautulliView,
  TautulliReadError,
  type TautulliRead,
  type TautulliView,
} from "./tautulli-panel";
import { fakeTautulli } from "./fake-tautulli";
import { sabHistory, sabJobFiles, sabnzbdDashboard } from "./sabnzbd-live";
import { nzbgetDashboard, nzbgetHistory, nzbgetJobFiles, readNzbget } from "./nzbget";
import { prowlarrDashboard } from "./prowlarr-live";
import { bazarrDashboard } from "./bazarr-live";
import { homeAssistantDashboard } from "./homeassistant-live";
import { syncthingDashboard } from "./syncthing-live";
import { libraryDashboard } from "./arr-v1-live";
import {
  findReleases,
  sampleEpisodes,
  sampleReleases,
  sampleTitles,
  scopeQuery,
  searchTitles,
  seriesEpisodes,
  type Call as SearchCall,
} from "./release-search";
import {
  JELLYFIN_ITEM,
  jellyfinCall,
  jellyfinDashboard,
  jellyfinPoster,
  readJellyfin,
} from "./jellyfin";
import { JellyfinReadError, readJellyfinView, type JellyfinView } from "./jellyfin-panel";
import { fakeJellyfin } from "./fake-jellyfin";
import { jellyfinRecent, plexRecent, RECENT_WINDOW } from "../media/sources";
import type { MediaApp, ReadPart, ServerRead } from "../media/arrivals";
import {
  audiobookshelfRecent,
  jellyfinAlbums,
  kavitaRecent,
  navidromeAlbums,
  plexAlbums,
  rommRecent,
} from "../media/library-sources";
import { IMMICH_ASSET, immichDashboard, immichPhotos, immichThumbnail, readImmich } from "./immich";
import { immichAlbums, readEdits, stateOf, storageLayout } from "./immich-organize";
import { readNews } from "./home-news";
import { filesStatus } from "./immich-files";
import { fakeImmich } from "./fake-immich";
import {
  ABS_ITEM,
  audiobookshelfCover,
  audiobookshelfDashboard,
  readAudiobookshelf,
} from "./audiobookshelf";
import { kavitaDashboard, readKavita } from "./kavita";
import { PortainerClient, portainerDashboard, readPortainer } from "./portainer";
import { kumaDashboard, readUptimeKuma } from "./uptimekuma";
import { nextcloudApps, nextcloudDashboard, readNextcloud } from "./nextcloud";
import { paperlessDashboard, paperlessDocuments, readPaperless } from "./paperless";
import { readVaultwarden, vaultwardenDashboard } from "./vaultwarden";
import { readTailscale, TAILSCALE_API, tailscaleDashboard } from "./tailscale";
import { readWgEasy, wgEasyDashboard } from "./wgeasy";
import { navidromeCover, navidromeDashboard, readNavidrome } from "./navidrome";
import { komgaDashboard, readKomga } from "./komga";
import { mealieDashboard, readMealie } from "./mealie";
import { actualDashboard, readActual } from "./actual";
import { authentikDashboard, readAuthentik } from "./authentik";
import { frigateDashboard, readFrigate } from "./frigate";
import { autheliaDashboard, readAuthelia } from "./authelia";
import { giteaDashboard, readGitea } from "./gitea";
import { readTraefik, traefikDashboard, traefikSites } from "./traefik";
import { NpmClient, npmDashboard, npmSites, readNpm } from "./npm";
import { localTlsFetch } from "./local-tls";
import { ProxmoxClient, proxmoxDashboard, readProxmox } from "./proxmox";
import {
  AdguardClient,
  adguardCheck,
  adguardDashboard,
  adguardQueries,
  readAdguard,
  type QueryFilter as AdguardQueryFilter,
} from "./adguard";
import {
  PiholeSession,
  piholeCheck,
  piholeDashboard,
  piholeQueries,
  readPihole,
  type QueryFilter,
} from "./pihole";
import {
  readRomm,
  rommCover,
  rommDashboard,
  rommGame,
  rommGames,
  type RommCredential,
  type RommOrder,
} from "./romm";
import type { RommGameDetail } from "@dragon-control/core";
import { ersatzDashboard, readErsatz } from "./ersatztv";
import { MovieReleases } from "../watches/movie-release";
import {
  sampleArr,
  sampleRadarrLibrary,
  samplePlex,
  sampleSeerr,
  sampleWizarr,
  sampleWizarrSettings,
  sampleWizarrWizard,
  sampleTautulli,
  sampleSabnzbd,
  sampleProwlarr,
  sampleAdguard,
  sampleBazarr,
  sampleHomeAssistant,
  sampleSyncthing,
  sampleLibrary,
  sampleJellyfin,
  sampleImmich,
  sampleAudiobookshelf,
  sampleKavita,
  samplePortainer,
  sampleUptimeKuma,
  sampleNextcloud,
  sampleNextcloudApps,
  samplePaperless,
  sampleVaultwarden,
  sampleTailscale,
  sampleWgEasy,
  sampleNavidrome,
  sampleKomga,
  sampleMealie,
  sampleActual,
  sampleAuthentik,
  sampleFrigate,
  sampleAuthelia,
  sampleGitea,
  sampleTraefik,
  sampleNpm,
  sampleProxmox,
  samplePihole,
  sampleRomm,
  sampleErsatz,
  sampleQbittorrent,
  sampleTorrentDetail,
} from "./samples";
import {
  readHomeAssistant,
  readHomeAssistantSection,
  type HaQuery,
  type SocketFactory,
  type SocketLike,
} from "./homeassistant";
import { AppKeyError, AppUnreachableError, joinUrl, type Fetch } from "./http";
import { readWizarrSettings, readWizarrWizard, WizarrPasskeyError } from "./wizarr-admin";
import { WizarrAdminSessions } from "./wizarr-setup";
import {
  appApi,
  authProblem,
  bodyProblem,
  followCommand,
  pathProblem,
  type ApiAnswer,
  type ApiRequest,
} from "./app-api";
import { CredentialBroker, CredentialError } from "../credentials/broker";
import { AppSessions } from "../credentials/app-session";
import { sourceIndex, trackerSource, type GrabRecord } from "./grab-sources";
import {
  SEEDING_ACTION_LABEL,
  checkRule,
  ruleName,
  ruleStateOf,
  type SeedingLogEntry,
  type SeedingRule,
  type SeedingRunState,
  type Torrent,
} from "@dragon-control/core";

/** Radarr and Sonarr results carry the near-miss check (Smart Quality): why nothing was taken. */
function withNearMiss(app: SearchApp, r: ReleaseSearchResult): ReleaseSearchResult {
  if (app !== "radarr" && app !== "sonarr") return r;
  return { ...r, nearMiss: nearMiss(r, app === "radarr" ? "Radarr" : "Sonarr") };
}

type ServiceRow = typeof t.services.$inferSelect;
type HealthRow = typeof t.appHealth.$inferSelect;

/** How often apps are read; their APIs are slower and less urgent than the container check. */
export const APP_INTERVAL_MS = 5 * 60_000;
/** Reads in a row with an error before it becomes an incident. */
const CONFIRM_AFTER = 2;
/** A Diagnostics panel reads live at most this often per app (it refreshes while open). */
export const LIVE_MIN_MS = 10_000;
/** A live dashboard reads the app at most this often per service. */
export const DASHBOARD_MIN_MS = 1_500;

function dashboardError(error: unknown): NonNullable<AppDashboard["error"]> {
  const message = error instanceof Error ? error.message : String(error);
  const kind = (error as { kind?: string } | null)?.kind;
  return {
    kind:
      error instanceof CredentialError
        ? "needs-key"
        : kind === "rejected"
          ? "rejected"
          : kind === "blocked"
            ? "blocked"
            : "unreachable",
    message,
  };
}

export function appOf(service: Pick<ServiceRow, "image" | "name">): AppKind | undefined {
  return appKindOf(service);
}

export function toAppReport(row: HealthRow): AppReport {
  return {
    serviceId: row.serviceId,
    app: row.app as AppKind,
    version: row.version ?? undefined,
    status: row.status,
    issues: row.issues as AppIssue[],
    facts: row.facts as AppReport["facts"],
    checkedAt: row.checkedAt,
    detail: row.detail ?? undefined,
    ...((row.details as AppDetails | null) ?? {}),
  };
}

/** Sample data: a believable read per app, with trouble in the attention scenario. */
function demoReport(
  app: AppKind,
  scenario: string | undefined,
): Omit<AppReport, "serviceId" | "checkedAt"> {
  const failing = scenario === "attention";
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const SAMPLE: Partial<Record<AppKind, { label: string; value: string }[]>> = {
    lidarr: [
      { label: "Missing (monitored)", value: "42" },
      { label: "Queue", value: "1" },
    ],
    chaptarr: [
      { label: "Missing (monitored)", value: "17" },
      { label: "Queue", value: "0" },
    ],
    bazarr: [
      { label: "Episodes missing subtitles", value: failing ? "38" : "4" },
      { label: "Movies missing subtitles", value: "2" },
    ],
    tautulli: [
      { label: "Streams now", value: "2 (1 transcoding)" },
      { label: "Bandwidth", value: "18.4 Mbps" },
    ],
    seerr: [
      { label: "Waiting for approval", value: failing ? "6" : "1" },
      { label: "Being downloaded", value: "2" },
    ],
    syncthing: [
      { label: "Folders", value: "4" },
      { label: "Devices online", value: "2 of 3" },
    ],
    // Their own samples, so they never borrow Prowlarr's (its indexer trouble is its own).
    qbittorrent: [
      { label: "Downloading", value: "3" },
      { label: "Seeding", value: "41" },
    ],
    sabnzbd: [
      { label: "In the queue", value: "2" },
      { label: "Speed", value: "38 MB/s" },
    ],
    jellyfin: [
      { label: "Watching now", value: "1" },
      { label: "Libraries", value: "2" },
    ],
    immich: [
      { label: "Photos, videos", value: "48210, 1904" },
      { label: "Storage", value: "52%" },
    ],
    audiobookshelf: [
      { label: "Listening now", value: "1" },
      { label: "Libraries", value: "Audiobooks (312), Podcasts (18)" },
    ],
    romm: [
      { label: "Games", value: "8" },
      { label: "Platforms", value: "4" },
    ],
    pihole: [
      { label: "Ad blocking", value: "on" },
      { label: "Queries, 24 hours", value: "41230, 6112 blocked (15%)" },
    ],
    adguard: [
      { label: "Protection", value: "on" },
      { label: "Queries, 24 hours", value: "38220, 5410 blocked (14%)" },
    ],
    proxmox: [
      { label: "Nodes", value: "1 of 1 online" },
      { label: "Running", value: "2 of 3 VMs and containers" },
    ],
    npm: [
      { label: "Proxy hosts", value: "6 on" },
      { label: "Certificates", value: "2" },
    ],
    traefik: [
      { label: "Routers", value: "9" },
      { label: "Certificates", value: "2" },
    ],
    uptimekuma: [
      { label: "Monitors up", value: "11 of 12" },
      { label: "Down", value: "1" },
    ],
    nextcloud: [
      { label: "Accounts", value: "4" },
      { label: "Free space", value: "412 GB" },
    ],
    paperless: [
      { label: "Documents", value: "1,284" },
      { label: "In the inbox", value: "3" },
    ],
    vaultwarden: [
      { label: "Accounts", value: "4" },
      { label: "Without two-step sign-in", value: "1" },
    ],
    gitea: [
      { label: "Repositories", value: "4" },
      { label: "Runners online", value: "1 of 2" },
    ],
    actual: [{ label: "Budgets", value: "2" }],
    authelia: [
      { label: "Sign-ins", value: "142" },
      { label: "Failed", value: "4" },
    ],
    frigate: [
      { label: "Cameras", value: "2 of 2 online" },
      { label: "Alerts today", value: "3" },
    ],
    authentik: [
      { label: "Sign-ins today", value: "14" },
      { label: "Failed today", value: "1" },
    ],
    mealie: [
      { label: "Recipes", value: "214" },
      { label: "Newest backup", value: "today" },
    ],
    komga: [
      { label: "Series", value: "59" },
      { label: "Books", value: "642" },
    ],
    navidrome: [
      { label: "Songs", value: "1,284" },
      { label: "Listening now", value: "1" },
    ],
    wgeasy: [
      { label: "Connected now", value: "2 of 4" },
      { label: "Turned off", value: "1" },
    ],
    tailscale: [
      { label: "Devices online", value: "5 of 6" },
      { label: "Exit nodes to approve", value: "1" },
    ],
    portainer: [
      { label: "Environments", value: "1 of 1 reachable" },
      { label: "Containers running", value: "14 of 16" },
    ],
    kavita: [
      { label: "Series", value: "420" },
      { label: "Libraries", value: "2" },
    ],
    ersatztv: [
      { label: "Channels", value: "6" },
      { label: "Streaming now", value: "1" },
    ],
  };
  if (SAMPLE[app])
    return {
      app,
      version: "sample data",
      status: "ok",
      issues: [],
      facts: SAMPLE[app]!,
      activity: [],
      connections: [],
    };
  if (app === "plex") return plexReport(samplePlex());
  if (app === "homeassistant") {
    return {
      app,
      version: "2026.10.1 (sample data)",
      status: failing ? "attention" : "ok",
      issues: failing
        ? [
            {
              level: "warning",
              key: "integration:zha",
              text: "Zigbee Home Automation (zha) keeps retrying setup (sample data).",
            },
          ]
        : [],
      facts: [
        { label: "Entities", value: "214" },
        { label: "Unavailable", value: failing ? "9" : "1" },
        { label: "Automations", value: "18 (16 on)" },
        { label: "Integrations", value: `27 (${failing ? 1 : 0} failing)` },
        { label: "Repairs", value: "0" },
      ],
      connections: [
        {
          name: "Zigbee Home Automation (zha)",
          ok: !failing,
          ...(failing ? { detail: "keeps retrying setup" } : {}),
        },
        { name: "Met.no (met)", ok: true },
      ],
      activity: [{ at: ago(7), text: "Automation ran: Porch light at sunset" }],
    };
  }
  if (app === "radarr" || app === "sonarr") {
    const radarr = app === "radarr";
    return {
      app,
      version: `${radarr ? "5.14.0" : "4.0.11"} (sample data)`,
      status: failing ? "attention" : "ok",
      issues: failing
        ? [{ level: "warning", key: "queue:stuck", text: "1 item in the queue needs attention." }]
        : [],
      facts: [
        { label: "In the queue", value: "3" },
        { label: "Needing attention", value: failing ? "1" : "0" },
        { label: "Download clients", value: "2" },
      ],
      queue: [
        {
          title: radarr ? "Example Movie (2024)" : "Example Show S02E05",
          status: "Downloading",
          progressPct: 62,
          sizeMb: 4200,
          timeLeft: "00:14:10",
          via: "qBittorrent",
        },
        {
          title: radarr ? "Another Film (2019)" : "Example Show S02E06",
          status: failing ? "Import blocked" : "Import pending",
          progressPct: 100,
          sizeMb: 2100,
          via: "SABnzbd",
          ...(failing ? { problem: "No files found are eligible for import (sample data)." } : {}),
        },
        {
          title: radarr ? "Third Picture (2021)" : "Other Series S01E01",
          status: "Queued",
          progressPct: 0,
          sizeMb: 3100,
          via: "qBittorrent",
        },
      ],
      queueTotal: 3,
      activity: [
        {
          at: ago(12),
          text: `Imported: ${radarr ? "A Recent Movie" : "A Recent Show"}`,
          tone: "good",
        },
        { at: ago(40), text: `Grabbed: ${radarr ? "Example Movie" : "Example Show"}` },
        ...(failing
          ? [{ at: ago(95), text: "Download failed: Old Release", tone: "error" as const }]
          : []),
      ],
      connections: [
        { name: "qBittorrent (torrent)", ok: true },
        { name: "SABnzbd (usenet)", ok: true },
      ],
    };
  }
  return {
    app: "prowlarr",
    version: "1.24.3 (sample data)",
    status: failing ? "failing" : "ok",
    issues: failing
      ? [
          {
            level: "error",
            key: "indexer:4",
            text: "Indexer Alpha is failing; Prowlarr paused it (sample data).",
          },
          {
            level: "error",
            key: "indexer:7",
            text: "Indexer Beta is failing; Prowlarr paused it (sample data).",
          },
        ]
      : [],
    facts: [
      { label: "Indexers", value: "12 enabled of 14" },
      { label: "Failing", value: failing ? "2" : "0" },
    ],
    activity: [
      { at: ago(5), text: 'Indexer Gamma: Search for "example"' },
      { at: ago(18), text: "Indexer Delta: Grabbed: Example Release" },
    ],
    connections: [
      { name: "Indexer Alpha (torrent)", ok: !failing, ...(failing ? { detail: "Failing" } : {}) },
      { name: "Indexer Beta (usenet)", ok: !failing, ...(failing ? { detail: "Failing" } : {}) },
      { name: "Indexer Gamma (torrent)", ok: true },
    ],
  };
}

/**
 * Reads the applications Hearth understands (M9: Prowlarr), read
 * only, with an API key you put in the vault linked to the service. Errors
 * confirmed on two reads become an incident that says a restart will not fix
 * it; they close by themselves when the app is healthy again.
 */
/** The stand-in Radarr behind the sample-data Radarr panel (read only). */
let demoRadarr: FakeRadarr | undefined;
/** The stand-in Sonarr behind the sample-data Sonarr panel (read only). */
let demoSonarr: FakeSonarr | undefined;
let demoProwlarr: FakeProwlarr | undefined;
/** The stand-in Jellyfin behind sample data's Jellyfin panel tabs. */
let demoJellyfin: ReturnType<typeof fakeJellyfin> | undefined;
let demoImmich: ReturnType<typeof fakeImmich> | undefined;
/** The stand-in Seerr behind sample data's Seerr panel tabs (watches/fake-media.ts). */
let demoSeerr: ReturnType<typeof fakeMedia> | undefined;
let demoLidarr: FakeLidarr | undefined;
/** The stand-in Tautulli behind sample data's Tautulli panel tabs. */
let demoTautulli: ReturnType<typeof fakeTautulli> | undefined;
/** The stand-in Plex behind sample data's Plex panel tabs. */
let demoPlex: ReturnType<typeof fakePlex> | undefined;

export class AppWatcher {
  private last = 0;
  /** Every credential use goes through the broker (destination and scope checks, track record). */
  readonly broker: CredentialBroker;

  constructor(
    private readonly handle: DbHandle,
    vault: Vault,
    private readonly fetchImpl?: Fetch,
    /** Home Assistant's live connection (tests pass a stand-in). */
    private readonly socket?: SocketFactory,
  ) {
    this.broker = new CredentialBroker(handle, vault);
    this.vault = vault;
    this.sessions = new AppSessions(
      handle,
      vault,
      this.broker,
      () => this.fetchImpl ?? (fetch as unknown as Fetch),
    );
  }

  /** Saved sign-ins for apps with no API key (auth "session"), kept in the Secure Vault. */
  readonly sessions: AppSessions;

  private readonly vault: Vault;
  private wizarrSessions?: WizarrAdminSessions;
  private live?: QbittorrentLive;
  private deluge?: DelugeLive;
  private transmission?: TransmissionLive;
  private plex?: PlexLive;
  private arr?: ArrLive;
  private seerr?: SeerrLive;
  private seerrLibrary?: SeerrLibrary;

  /**
   * A poster for Tautulli's panel, through Tautulli's own image proxy (its key stays server side).
   * Only Plex artwork paths are accepted.
   */
  /** A book cover from Audiobookshelf, fetched with its key server side. */
  /** A Jellyfin poster for its panel (sample data answers from the stand-in). */
  async jellyfinPoster(
    serviceId: string,
    itemId: string,
  ): Promise<{ bytes: Buffer; type: string } | undefined> {
    if (!JELLYFIN_ITEM.test(itemId)) return undefined;
    const target = (await this.targets([serviceId]))[0];
    if (!target || !jellyfinLike(target.app))
      throw new NotFoundError("Not a watched Jellyfin or Emby.");
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:")) {
      const sample = (demoJellyfin ??= fakeJellyfin());
      return jellyfinPoster(sample.fetch, "http://demo.invalid:8096", "e2e-demo", itemId);
    }
    if (!service.localUrl) return undefined;
    const base = service.localUrl;
    return this.broker.use(
      { serviceId, purpose: "show a Jellyfin poster", access: "read", destination: base },
      ({ value }) =>
        jellyfinPoster(this.fetchImpl ?? (fetch as unknown as Fetch), base, value, itemId),
    );
  }

  /** Reads from one watched Immich with its key (the stand-in for a demo service). */
  private async immichRead<T>(
    serviceId: string,
    purpose: string,
    read: (fetchImpl: Fetch, base: string, key: string) => Promise<T>,
  ): Promise<T> {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "immich") throw new NotFoundError("Not a watched Immich.");
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:")) {
      const sample = (demoImmich ??= fakeImmich());
      return read(sample.fetch, "http://demo.invalid:2283", "e2e-demo");
    }
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const base = service.localUrl;
    return this.broker.use({ serviceId, purpose, access: "read", destination: base }, ({ value }) =>
      read(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
    );
  }

  /** A photo's picture for the Immich panel, through Immich (its key stays here). */
  immichThumbnail(
    serviceId: string,
    assetId: string,
    size: "thumbnail" | "preview" = "thumbnail",
    edited = true,
  ) {
    return this.immichRead(serviceId, "show a photo", (f, base, key) =>
      immichThumbnail(f, base, key, assetId, size, edited),
    );
  }

  /** Albums to add photos to, and what Immich's storage template does with files on disk. */
  immichAlbums(serviceId: string) {
    return this.immichRead(serviceId, "list albums", async (f, base, key) => ({
      albums: await immichAlbums(f, base, key),
      storage: await storageLayout(f, base, key),
    }));
  }

  /** A photo's flips and turn in Immich (absent "supported": Immich older than 2.5). */
  immichEdits(serviceId: string, assetId: string) {
    if (!IMMICH_ASSET.test(assetId)) throw new NotFoundError("Not a photo.");
    return this.immichRead(serviceId, "read a photo's edits", async (f, base, key) => {
      const edits = await readEdits(f, base, key, assetId);
      return edits
        ? {
            supported: true,
            ...stateOf(edits),
            cropped: edits.some((e) => e.action === "crop"),
            edited: edits.length > 0,
          }
        : {
            supported: false,
            rotate: 0,
            mirrorH: false,
            mirrorV: false,
            cropped: false,
            edited: false,
          };
    });
  }

  /** Every photo's id on the timeline (for Select all), newest first, up to a limit. */
  immichPhotoIds(serviceId: string, albumId?: string, limit = 20_000) {
    return this.immichRead(serviceId, "list photo ids", async (f, base, key) => {
      const ids: string[] = [];
      for (let page = 1; ids.length < limit; page++) {
        const p = await immichPhotos(f, base, key, page, 1000, albumId);
        ids.push(...p.items.map((x) => x.id));
        if (!p.next) return { ids, complete: true };
      }
      return { ids: ids.slice(0, limit), complete: false };
    });
  }

  /** The Files and folders tab: Immich's storage template, a preview, and its job's progress. */
  immichFiles(serviceId: string) {
    return this.immichRead(serviceId, "read Immich's files and folders", (f, base, key) =>
      filesStatus({ fetchImpl: f, base, key, service: { name: "Immich" } }),
    );
  }

  /** A page of the Photos tab, newest taken first. */
  async immichPhotos(serviceId: string, page: number, albumId?: string) {
    const target = (await this.targets([serviceId]))[0];
    const out = await this.immichRead(serviceId, "list photos", (f, base, key) =>
      immichPhotos(f, base, key, page, 60, albumId),
    );
    return target?.service.checkTarget?.startsWith("demo:") ? { ...out, sample: true } : out;
  }

  /** How this Immich panel shows photos (kept in Hearth; Immich is not changed). */
  async immichPhotoPrefs(serviceId: string): Promise<ImmichPhotoPrefs> {
    const all = (await getSetting(this.handle.db, "immich_photo_prefs")) ?? {};
    return { ...IMMICH_PHOTO_PREFS_DEFAULT, ...all[serviceId] };
  }

  async setImmichPhotoPrefs(
    serviceId: string,
    change: {
      recent?: ImmichPhotoPrefs["recent"];
      photo?: { id: string; show: "blur" | "hide" | "normal" };
    },
  ): Promise<ImmichPhotoPrefs> {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "immich") throw new NotFoundError("Not a watched Immich.");
    const all = (await getSetting(this.handle.db, "immich_photo_prefs")) ?? {};
    const now = { ...IMMICH_PHOTO_PREFS_DEFAULT, ...all[serviceId] };
    const photos = { ...now.photos };
    if (change.photo) {
      if (change.photo.show === "normal") delete photos[change.photo.id];
      else photos[change.photo.id] = change.photo.show;
    }
    if (Object.keys(photos).length > 5000)
      throw new ConflictError("That is a lot of hidden photos: show some again first.");
    const next: ImmichPhotoPrefs = { recent: change.recent ?? now.recent, photos };
    await setSetting(this.handle.db, "immich_photo_prefs", { ...all, [serviceId]: next });
    return next;
  }

  async audiobookshelfCover(
    serviceId: string,
    itemId: string,
  ): Promise<{ bytes: Buffer; type: string }> {
    if (!ABS_ITEM.test(itemId)) throw new NotFoundError("Not a book.");
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "audiobookshelf" || !target.service.localUrl)
      throw new NotFoundError("No Audiobookshelf here.");
    const base = target.service.localUrl;
    const pic = await this.broker.use(
      { serviceId, purpose: "show a book cover", access: "read", destination: base },
      ({ value }) =>
        audiobookshelfCover(this.fetchImpl ?? (fetch as unknown as Fetch), base, value, itemId),
    );
    if (!pic) throw new NotFoundError("No cover.");
    return pic;
  }

  async tautulliImage(serviceId: string, img: string): Promise<{ bytes: Buffer; type: string }> {
    if (!PLEX_IMAGE.test(img)) throw new NotFoundError("Not a Plex picture.");
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "tautulli" || !target.service.localUrl)
      throw new NotFoundError("No Tautulli here.");
    const base = target.service.localUrl;
    return this.broker.use(
      { serviceId, purpose: "show a poster from Tautulli", access: "read", destination: base },
      async ({ value }) => {
        const url = joinUrl(
          base,
          `/api/v2?${new URLSearchParams({ apikey: value, cmd: "pms_image_proxy", img, width: "300", height: "450", fallback: "poster" }).toString()}`,
        );
        const res = (await (this.fetchImpl ?? (fetch as unknown as Fetch))(url, {
          headers: { Accept: "image/*" },
          signal: AbortSignal.timeout(10_000),
        })) as unknown as Response;
        const type = res.headers.get("content-type") ?? "";
        if (!res.ok || !type.startsWith("image/")) throw new NotFoundError("No poster.");
        return { bytes: Buffer.from(await res.arrayBuffer()), type };
      },
    );
  }

  /**
   * A Plex picture for the dashboard, fetched with the token server side (the browser never
   * sees it). Only Plex's own artwork paths are accepted.
   */
  /**
   * A book cover from Chaptarr (the Curator's cards, 11-17): only Chaptarr's own cover paths,
   * fetched by Hearth with its vault key, so the browser never reaches out to anyone else.
   */
  async chaptarrCover(
    serviceId: string,
    q: { path?: string; remote?: string },
  ): Promise<{ bytes: Buffer; type: string }> {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "chaptarr" || !target.service.localUrl)
      throw new NotFoundError("Not a watched Chaptarr.");
    const get = this.fetchImpl ?? (fetch as unknown as Fetch);
    const image = async (res: Response) => {
      const type = res.headers?.get?.("content-type") ?? "";
      if (!res.ok || typeof res.arrayBuffer !== "function" || !/^image\//.test(type))
        throw new NotFoundError(`No cover there (${res.status}).`);
      return { bytes: Buffer.from(await res.arrayBuffer()), type };
    };
    // A looked-up book: its cover from the cover site Chaptarr named (only those sites, no key).
    const remote = remoteCover(q.remote);
    if (remote)
      return image(
        (await get(remote, {
          headers: { Accept: "image/*" },
          signal: AbortSignal.timeout(8000),
        })) as unknown as Response,
      );
    const coverPath = String(q.path ?? "");
    if (!CHAPTARR_COVER.test(coverPath)) throw new NotFoundError("Not a Chaptarr cover.");
    const base = target.service.localUrl;
    return this.broker.use(
      { serviceId, purpose: "show book covers", access: "read", destination: base },
      async ({ value }) =>
        image(
          (await get(`${base.replace(/\/+$/, "")}/api/v1${coverPath}`, {
            headers: { "X-Api-Key": value },
            signal: AbortSignal.timeout(8000),
          })) as unknown as Response,
        ),
    );
  }

  async plexArt(serviceId: string, artPath: string): Promise<{ bytes: Buffer; type: string }> {
    if (!PLEX_ART.test(artPath)) throw new NotFoundError("Not a Plex picture.");
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "plex" || !target.service.localUrl) {
      throw new NotFoundError("Not a watched Plex.");
    }
    const base = target.service.localUrl;
    return this.broker.use(
      { serviceId, purpose: "show Plex artwork", access: "read", destination: base },
      async ({ value }) => {
        // Through the same connection as every other Plex read (a stand-in Plex in tests), so a
        // poster never waits on an address that does not answer.
        const res = (await (this.fetchImpl ?? (fetch as unknown as Fetch))(
          `${base.replace(/\/+$/, "")}/photo/:/transcode?width=240&height=360&minSize=1&upscale=1&url=${encodeURIComponent(artPath)}`,
          { headers: { "X-Plex-Token": value }, signal: AbortSignal.timeout(8000) },
        )) as unknown as Response;
        if (!res.ok || typeof res.arrayBuffer !== "function")
          throw new NotFoundError(`Plex answered ${res.status} for that picture.`);
        return {
          bytes: Buffer.from(await res.arrayBuffer()),
          type: res.headers.get("content-type") ?? "image/jpeg",
        };
      },
    );
  }
  /* ---------- Media announcements (media/watcher.ts) ---------- */

  /**
   * The apps Hearth watches for "New in your library": Plex and Jellyfin (Emby too) for movies,
   * shows and music; Navidrome for music; Audiobookshelf for audiobooks, ebooks and podcasts;
   * Kavita for books and comics; RomM for games. Downloaders and photo apps are never watched.
   */
  async mediaServers(): Promise<
    { serviceId: string; server: MediaApp; name: string; parts: ReadPart[] }[]
  > {
    const out: { serviceId: string; server: MediaApp; name: string; parts: ReadPart[] }[] = [];
    for (const x of await this.targets()) {
      if (!x.service.localUrl) continue;
      const server = mediaAppOf(x.app);
      if (!server) continue;
      out.push({
        serviceId: x.service.id,
        server,
        name: x.service.name,
        parts: server === "plex" || server === "jellyfin" ? ["video", "library"] : ["library"],
      });
    }
    return out;
  }

  /**
   * What one app just added (the newest items, or `limit` for the one-time baseline): movies and
   * episodes ("video"), or music, books, comics, games and podcast episodes ("library").
   */
  async mediaRead(
    serviceId: string,
    limit?: number,
    part: ReadPart = "video",
  ): Promise<ServerRead> {
    const target = (await this.targets([serviceId]))[0];
    const server = target ? mediaAppOf(target.app) : undefined;
    if (!target || !server || !target.service.localUrl)
      throw new NotFoundError("Not an app Hearth watches for new arrivals.");
    if (part === "video" && server !== "plex" && server !== "jellyfin")
      throw new NotFoundError("Not a watched Plex or Jellyfin.");
    const key = await this.keyFor(target.service, target.app);
    if (!key.id)
      throw new AppKeyError(key.problem ?? `${target.service.name} has no key in the vault.`);
    const base = target.service.localUrl;
    const f = this.fetchImpl ?? (fetch as unknown as Fetch);
    // Only the newest are ever needed for the library: its baseline is the newest thousand.
    const n = part === "library" ? Math.min(limit ?? RECENT_WINDOW, 1000) : limit;
    const items = await this.broker.use(
      {
        serviceId,
        purpose: "see what was added, for media announcements",
        access: "read",
        destination: base,
      },
      ({ value, username }) => {
        if (part === "video")
          return server === "plex"
            ? plexRecent(f, base, value, limit)
            : jellyfinRecent(f, base, value, limit);
        switch (server) {
          case "plex":
            return plexAlbums(f, base, value, n);
          case "jellyfin":
            return jellyfinAlbums(f, base, value, n);
          case "navidrome":
            return navidromeAlbums(f, base, { username: username ?? "", password: value }, n);
          case "audiobookshelf":
            return audiobookshelfRecent(f, base, value, n);
          case "kavita":
            return kavitaRecent(f, base, value);
          case "romm":
            return rommRecent(f, base, { value, ...(username ? { username } : {}) });
        }
      },
    );
    return { serviceId, server, serverName: target.service.name, part, items };
  }

  /** A poster or backdrop from a media server, for attaching to an announcement (never linked). */
  async mediaArt(
    serviceId: string,
    path: string,
    shape: "poster" | "backdrop" | "thumb",
  ): Promise<{ bytes: Buffer; type: string }> {
    const target = (await this.targets([serviceId]))[0];
    if (!target || !target.service.localUrl) throw new NotFoundError("Not a watched server.");
    const base = target.service.localUrl.replace(/\/+$/, "");
    const [w, h] = shape === "backdrop" ? [1280, 720] : shape === "thumb" ? [240, 360] : [600, 900];
    return this.broker.use(
      {
        serviceId,
        purpose: "attach artwork to a media announcement",
        access: "read",
        destination: base,
      },
      async ({ value, username }) => {
        let url: string;
        let headers: Record<string, string>;
        if (target.app === "plex") {
          if (!PLEX_ART.test(path)) throw new NotFoundError("Not a Plex picture.");
          url = `${base}/photo/:/transcode?width=${w}&height=${h}&minSize=1&upscale=1&url=${encodeURIComponent(path)}`;
          headers = { "X-Plex-Token": value };
        } else if (jellyfinLike(target.app)) {
          if (!/^\/Items\/[\w-]+\/Images\/(Primary|Backdrop)$/.test(path))
            throw new NotFoundError("Not a Jellyfin picture.");
          url = `${base}${path}?maxWidth=${w}&quality=85`;
          headers = { Authorization: `MediaBrowser Token="${value}"` };
        } else {
          // The library apps' covers, each read the way its own panel reads them.
          const f = this.fetchImpl ?? (fetch as unknown as Fetch);
          const pic = await this.libraryCover(target.app, f, base, value, username, path);
          if (!pic) throw new NotFoundError("No cover for that one.");
          return pic;
        }
        const f = this.fetchImpl ?? (fetch as unknown as Fetch);
        const res = await f(url, { headers, signal: AbortSignal.timeout(10_000) });
        if (!res.ok || !res.arrayBuffer)
          throw new NotFoundError(`The server answered ${res.status} for that picture.`);
        return {
          bytes: Buffer.from(await res.arrayBuffer()),
          type: res.headers?.get("content-type") ?? "image/jpeg",
        };
      },
    );
  }

  /** A cover from a library app, by the path its reader gave (library-sources.ts); only those. */
  private async libraryCover(
    app: AppKind,
    f: Fetch,
    base: string,
    value: string,
    username: string | undefined,
    path: string,
  ): Promise<{ bytes: Buffer; type: string } | undefined> {
    if (app === "audiobookshelf") {
      const id = /^\/api\/items\/([A-Za-z0-9_-]{6,64})\/cover$/.exec(path)?.[1];
      return id ? audiobookshelfCover(f, base, value, id) : undefined;
    }
    if (app === "romm") {
      const id = /^\/api\/roms\/(\d{1,12})\/cover$/.exec(path)?.[1];
      return id
        ? rommCover(f, base, { value, ...(username ? { username } : {}) }, Number(id), "large")
        : undefined;
    }
    if (app === "navidrome")
      return navidromeCover(f, base, { username: username ?? "", password: value }, path);
    if (app === "kavita") {
      // Not verified on a real Kavita yet: its image routes take the API key in the address.
      const id = /^\/api\/Image\/series-cover\?seriesId=(\d{1,12})$/.exec(path)?.[1];
      if (!id) return undefined;
      const res = (await f(
        `${base}/api/Image/series-cover?seriesId=${id}&apiKey=${encodeURIComponent(value)}`,
        { headers: {}, signal: AbortSignal.timeout(10_000) },
      ).catch(() => undefined)) as unknown as Response | undefined;
      const type = res?.headers?.get?.("content-type") ?? "";
      if (!res?.ok || !type.startsWith("image/")) return undefined;
      return { bytes: Buffer.from(await res.arrayBuffer()), type };
    }
    return undefined;
  }

  /**
   * A movie's trailer as Radarr knows it (from TMDB, for that exact movie), or undefined. Never a
   * search by title: no trailer is better than the wrong one.
   */
  async radarrTrailer(tmdbId: string): Promise<string | undefined> {
    if (!/^\d+$/.test(tmdbId)) return undefined;
    for (const target of (await this.targets()).filter(
      (x) => x.app === "radarr" && x.service.localUrl,
    )) {
      const key = await this.keyFor(target.service, "radarr");
      if (!key.id) continue;
      const base = target.service.localUrl!.replace(/\/+$/, "");
      const id = await this.broker
        .use(
          {
            serviceId: target.service.id,
            purpose: "find a trailer for a media announcement",
            access: "read",
            destination: base,
          },
          async ({ value }) => {
            const f = this.fetchImpl ?? (fetch as unknown as Fetch);
            const res = await f(`${base}/api/v3/movie?tmdbId=${tmdbId}`, {
              headers: { "X-Api-Key": value, Accept: "application/json" },
              signal: AbortSignal.timeout(8000),
            });
            if (!res.ok) return undefined;
            const list = (await res.json()) as { tmdbId?: number; youTubeTrailerId?: string }[];
            const m = list.find((x) => String(x.tmdbId) === tmdbId);
            return m?.youTubeTrailerId && /^[\w-]{6,20}$/.test(m.youTubeTrailerId)
              ? m.youTubeTrailerId
              : undefined;
          },
        )
        .catch(() => undefined);
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }
    return undefined;
  }

  private dashboards = new Map<string, { at: number; value: Promise<AppDashboard> }>();

  /**
   * The live dashboard of an app (feature request 3 to 9), through the broker.
   * Reads at most every DASHBOARD_MIN_MS per service, however many panels are
   * open; read only. `by` audits a read the AI asked for.
   */
  async dashboard(serviceId: string, by?: "agent"): Promise<AppDashboard> {
    const cached = this.dashboards.get(serviceId);
    if (cached && Date.now() - cached.at < DASHBOARD_MIN_MS && !by) return cached.value;
    const value = this.readDashboard(serviceId, by).then((v) => this.withSources(serviceId, v));
    this.dashboards.set(serviceId, { at: Date.now(), value });
    // A failed read is never reused: a key added a moment later must be tried at once.
    void value.then((v) => {
      if (v.error && this.dashboards.get(serviceId)?.value === value)
        this.dashboards.delete(serviceId);
    });
    return value;
  }

  /**
   * qBittorrent's torrents and SABnzbd's jobs with the indexer that grabbed each (11-11), from
   * the grabbing apps' history; a read that fails leaves the dashboard as it was.
   */
  private async withSources(serviceId: string, v: AppDashboard): Promise<AppDashboard> {
    const d = v.data;
    if (!d || (d.app !== "qbittorrent" && d.app !== "sabnzbd")) return v;
    const idx = await this.grabSources().catch(() => undefined);
    if (d.app === "qbittorrent") {
      const [rules, run] = await Promise.all([
        this.seedingRules(serviceId),
        this.seedingRun(serviceId),
      ]);
      const torrents = d.torrents.map((x) => {
        const s = x.source ?? idx?.find(x.hash, x.name) ?? trackerSource(x.tracker);
        const t = s ? { ...x, source: s } : x;
        const rule = ruleStateOf(t, rules, Date.now(), run.stopped);
        return rule ? { ...t, rule } : t;
      });
      await this.noteSeedingRules(serviceId, torrents).catch(() => undefined);
      return { ...v, data: { ...d, torrents } };
    }
    if (!idx) return v;
    return {
      ...v,
      data: {
        ...d,
        queue: d.queue.map((x) => {
          const s = idx.find(x.id, x.name);
          return s ? { ...x, source: s } : x;
        }),
        history: d.history.map((x) => {
          const s = idx.find(x.id, x.name);
          return s ? { ...x, source: s } : x;
        }),
      },
    };
  }

  /** The owner's seeding rules for one qBittorrent (stage 1: they preview only). */
  async seedingRules(serviceId: string): Promise<SeedingRule[]> {
    return ((await getSetting(this.handle.db, "seeding_rules")) ?? {})[serviceId] ?? [];
  }

  async saveSeedingRules(serviceId: string, rules: Partial<SeedingRule>[]): Promise<SeedingRule[]> {
    if (rules.length > 50)
      throw new InvalidRequestError("Fifty rules is the most one qBittorrent can have.");
    let clean: SeedingRule[];
    const before = new Map((await this.seedingRules(serviceId)).map((r) => [r.id, r]));
    const same = (a: SeedingRule, b: SeedingRule) =>
      a.action === b.action &&
      JSON.stringify([...a.indexers].sort()) === JSON.stringify([...b.indexers].sort()) &&
      JSON.stringify([...a.trackers].sort()) === JSON.stringify([...b.trackers].sort()) &&
      a.days >= b.days &&
      (a.minRatio ?? 0) >= (b.minRatio ?? 0);
    try {
      // A live rule stays live through edits that only make it wait longer or switch it off;
      // anything that changes what it covers or does puts it back in preview.
      clean = rules.map(checkRule).map((r) => {
        const was = before.get(r.id);
        return was?.mode === "live" && same(r, was) ? { ...r, mode: "live" as const } : r;
      });
    } catch (e) {
      throw new InvalidRequestError(e instanceof Error ? e.message : String(e));
    }
    const all = (await getSetting(this.handle.db, "seeding_rules")) ?? {};
    await setSetting(this.handle.db, "seeding_rules", { ...all, [serviceId]: clean });
    this.dashboards.delete(serviceId);
    return clean;
  }

  /**
   * What a rule can pick from: every indexer in Prowlarr (the owner's idea, 11-11), the indexers
   * seen on this qBittorrent's torrents, and the tracker hosts its torrents use.
   */
  async seedingChoices(serviceId: string): Promise<{ indexers: string[]; trackers: string[] }> {
    const dash = await this.dashboard(serviceId).catch(() => undefined);
    const torrents = dash?.data?.app === "qbittorrent" ? dash.data.torrents : [];
    const names = new Set<string>();
    for (const t of torrents) if (t.source?.indexer) names.add(t.source.indexer);
    const prowlarrs = (await this.targets()).filter(
      (x) => x.app === "prowlarr" && !x.service.checkTarget?.startsWith("demo:"),
    );
    for (const { service } of prowlarrs) {
      const a = await this.appApi(
        service.id,
        { method: "GET", path: "/api/v1/indexer" },
        { access: "read", purpose: "list indexers for seeding rules" },
      ).catch(() => undefined);
      for (const i of a?.ok && Array.isArray(a.body) ? (a.body as { name?: string }[]) : [])
        if (i.name) names.add(i.name.replace(/s*(Prowlarr)s*$/i, ""));
    }
    const trackers = new Set(torrents.map((t) => t.tracker).filter(Boolean) as string[]);
    const sort = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
    return { indexers: sort(names), trackers: sort(trackers) };
  }

  async seedingLog(serviceId: string) {
    return ((await getSetting(this.handle.db, "seeding_rule_log")) ?? {})[serviceId] ?? [];
  }

  /**
   * Notes each torrent once when its rule's time is up (in preview: what the rule would do),
   * so the activity list shows it after a restart too. Keeps the newest 200.
   */
  private async noteSeedingRules(serviceId: string, torrents: Torrent[]) {
    // Live rules write their own entries when they act (seedingTick).
    const due = torrents.filter((t) => t.rule?.met && t.rule.mode === "preview");
    if (!due.length) return;
    const all = (await getSetting(this.handle.db, "seeding_rule_log")) ?? {};
    const log = all[serviceId] ?? [];
    const seen = new Set(
      log.filter((e) => e.mode === "preview").map((e) => `${e.hash}|${e.rule}|${e.action}`),
    );
    const fresh: SeedingLogEntry[] = due
      .filter((t) => !seen.has(`${t.hash}|${t.rule!.rules[0]}|${t.rule!.action}`))
      .map((t) => ({
        at: new Date().toISOString(),
        hash: t.hash,
        name: t.name,
        rule: t.rule!.rules[0]!,
        action: t.rule!.action,
        mode: t.rule!.mode,
        seedingSec: t.rule!.seedingSec ?? 0,
        ratio: t.ratio,
      }));
    if (!fresh.length) return;
    await setSetting(this.handle.db, "seeding_rule_log", {
      ...all,
      [serviceId]: [...fresh, ...log].slice(0, 200),
    });
  }

  async seedingRun(serviceId: string): Promise<SeedingRunState> {
    const s = ((await getSetting(this.handle.db, "seeding_rule_run")) ?? {})[serviceId];
    return { done: {}, tries: {}, unseen: [], ...s };
  }

  private async putSeedingRun(serviceId: string, s: SeedingRunState) {
    const all = (await getSetting(this.handle.db, "seeding_rule_run")) ?? {};
    await setSetting(this.handle.db, "seeding_rule_run", { ...all, [serviceId]: s });
  }

  /** What live rules did that the owner hasn't seen yet, per qBittorrent (for the bell). */
  async seedingUnseen(): Promise<{ serviceId: string; name: string; unseen: SeedingLogEntry[] }[]> {
    const all = (await getSetting(this.handle.db, "seeding_rule_run")) ?? {};
    const ids = Object.keys(all).filter((id) => all[id]?.unseen.length);
    if (!ids.length) return [];
    const out: { serviceId: string; name: string; unseen: SeedingLogEntry[] }[] = [];
    for (const { service } of await this.targets(ids))
      out.push({ serviceId: service.id, name: service.name, unseen: all[service.id]!.unseen });
    return out;
  }

  /** The owner opened the rules: what they did is seen, and leaves the bell. */
  async seedingSeen(serviceId: string) {
    const s = await this.seedingRun(serviceId);
    if (s.unseen.length) await this.putSeedingRun(serviceId, { ...s, unseen: [] });
  }

  /** The one switch that stops (or restarts) every rule on this qBittorrent. */
  async setSeedingStopped(serviceId: string, stopped: boolean) {
    const s = await this.seedingRun(serviceId);
    await this.putSeedingRun(serviceId, { ...s, stopped });
    await recordAudit(this.handle.db, {
      actor: "you",
      action: stopped ? "Stopped every seeding rule" : "Started the seeding rules again",
      target: `service:${serviceId}`,
    });
    this.dashboards.delete(serviceId);
  }

  /**
   * Preview or live, for one rule: live is the owner's OK for it to act on its own. Delete
   * needs its own confirmation words; sample data can never go live.
   */
  async setSeedingMode(
    serviceId: string,
    ruleId: string,
    mode: "preview" | "live",
    confirm?: string,
  ): Promise<SeedingRule[]> {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "qbittorrent")
      throw new NotFoundError("Not a watched qBittorrent.");
    if (mode === "live" && target.service.checkTarget?.startsWith("demo:"))
      throw new ConflictError("Sample data: there is no real qBittorrent for this rule to act on.");
    const rules = await this.seedingRules(serviceId);
    const rule = rules.find((r) => r.id === ruleId);
    if (!rule) throw new NotFoundError("No such rule.");
    if (mode === "live" && rule.action === "delete" && confirm !== "delete files")
      throw new InvalidRequestError(
        'Deleting files needs its own OK: confirm with the words "delete files".',
      );
    const next = rules.map((r) => (r.id === ruleId ? { ...r, mode } : r));
    const all = (await getSetting(this.handle.db, "seeding_rules")) ?? {};
    await setSetting(this.handle.db, "seeding_rules", { ...all, [serviceId]: next });
    await recordAudit(this.handle.db, {
      actor: "you",
      action: `Seeding rule "${ruleName(rule)}" ${mode === "live" ? "switched to live" : "put back in preview"}`,
      target: `service:${serviceId}`,
      detail: {
        action: rule.action,
        days: rule.days,
        indexers: rule.indexers,
        trackers: rule.trackers,
      },
    });
    this.dashboards.delete(serviceId);
    return next;
  }

  private safetyCache?: {
    at: number;
    value: Promise<{ imported: Set<string>; roots: string[] }>;
  };

  /**
   * What Delete checks first: the downloads a media app has imported (by download id), and the
   * media apps' library folders. Read at most once a minute.
   */
  private arrSafety() {
    if (this.safetyCache && Date.now() - this.safetyCache.at < 60_000)
      return this.safetyCache.value;
    const value = (async () => {
      const imported = new Set<string>();
      const roots: string[] = [];
      const list = (await this.targets()).filter(
        (x) =>
          ["sonarr", "radarr", "lidarr", "chaptarr", "readarr"].includes(x.app) &&
          !x.service.checkTarget?.startsWith("demo:"),
      );
      const purpose = "check a download was imported before a seeding rule deletes it";
      await Promise.all(
        list.map(async ({ app, service }) => {
          const v = app === "sonarr" || app === "radarr" ? "v3" : "v1";
          const read = async (path: string) =>
            (await this.appApi(service.id, { method: "GET", path }, { access: "read", purpose })
              .then((a) => (a.ok ? a.body : undefined))
              .catch(() => undefined)) as unknown;
          const h = (await read(
            `/api/${v}/history?page=1&pageSize=500&sortKey=date&sortDirection=descending`,
          )) as { records?: { downloadId?: string; eventType?: string | number }[] } | undefined;
          for (const r of Array.isArray(h?.records) ? h.records : [])
            if (r.downloadId && /import/i.test(String(r.eventType)))
              imported.add(r.downloadId.toLowerCase());
          // Every library folder must be known before anything is deleted: one app that can't
          // be read stops Delete (it waits), rather than risking that app's library.
          const rf = (await read(`/api/${v}/rootfolder`)) as { path?: string }[] | undefined;
          if (!Array.isArray(rf))
            throw new Error(`${service.name}'s library folders couldn't be read.`);
          for (const f of rf) if (f.path) roots.push(f.path);
        }),
      );
      return { imported, roots };
    })();
    this.safetyCache = { at: Date.now(), value };
    void value.catch(() => (this.safetyCache = undefined));
    return value;
  }

  /**
   * The rules' check (every five minutes from index.ts, or Check now): each live rule's torrents
   * whose time is up get its action, once, through the same re-checked torrent operations the
   * owner's plans use. Anything unclear waits. Every action is logged, audited and shown in the
   * bell. Nothing happens while the rules are stopped.
   */
  async seedingTick(only?: string): Promise<SeedingLogEntry[]> {
    const acted: SeedingLogEntry[] = [];
    for (const { app, service } of await this.targets(only ? [only] : undefined)) {
      if (app !== "qbittorrent" || service.checkTarget?.startsWith("demo:") || !service.localUrl)
        continue;
      const rules = await this.seedingRules(service.id);
      if (!rules.some((r) => r.enabled && r.mode === "live")) continue;
      const run = await this.seedingRun(service.id);
      if (run.stopped) continue;
      this.dashboards.delete(service.id);
      const dash = await this.dashboard(service.id).catch(() => undefined);
      // Can't read qBittorrent: wait for the next check.
      if (!dash || dash.error || dash.data?.app !== "qbittorrent") continue;
      const at = new Date().toISOString();
      const fresh: SeedingLogEntry[] = [];
      const ref = { id: service.id, name: service.name, localUrl: service.localUrl };
      for (const tor of dash.data.torrents) {
        const r = tor.rule;
        if (!r?.met || r.mode !== "live") continue;
        const key = `${tor.hash}|${r.ruleId}|${r.action}`;
        if (run.done[key] || (run.tries[key] ?? 0) >= 3) continue;
        // Busy torrents wait; they are looked at again next time.
        if (["error", "checking", "moving"].includes(tor.status)) continue;
        const entry: SeedingLogEntry = {
          at,
          hash: tor.hash,
          name: tor.name,
          rule: r.rules[0]!,
          action: r.action,
          mode: "live",
          seedingSec: r.seedingSec ?? 0,
          ratio: tor.ratio,
        };
        // A reason it waits (or never acts) is noted once, not every five minutes.
        const skip = (why: string, forGood: boolean) => {
          const note = `${key}|skip`;
          if (forGood) run.done[key] = at;
          if (run.done[note]) return;
          run.done[note] = at;
          fresh.push({ ...entry, ok: false, result: why });
        };
        if (r.action === "delete") {
          const safety = await this.arrSafety().catch(() => undefined);
          if (!safety) {
            skip("Waiting: Hearth couldn't check the media apps, so nothing was deleted.", false);
            continue;
          }
          const path = (tor.contentPath ?? "").replace(/\/+$/, "");
          const inLibrary = safety.roots.some((root) => {
            const r0 = root.replace(/\/+$/, "");
            return Boolean(path) && (path === r0 || path.startsWith(`${r0}/`));
          });
          if (inLibrary) {
            skip("Not deleted: its files are inside a media library folder.", true);
            continue;
          }
          if (!safety.imported.has(tor.hash.toLowerCase())) {
            skip(
              "Waiting: no media app has imported it yet, so its files may be the only copy. Nothing was deleted.",
              false,
            );
            continue;
          }
        }
        let ok = true;
        let result = "Its rule's time is up.";
        if (r.action !== "notify") {
          const kind = (
            {
              pause: "app-qbt-pause",
              remove: "app-qbt-remove",
              delete: "app-qbt-remove-with-data",
            } as const
          )[r.action];
          try {
            const planned = await this.torrentOps.plan(
              kind,
              ref,
              { hash: tor.hash },
              {
                label: "",
                serviceName: service.name,
                changes: true,
                policy: "allow",
                policyReason: `Seeding rule "${entry.rule}", switched to live by the owner`,
              },
            );
            const out = await this.torrentOps.run(
              {
                kind,
                serviceId: service.id,
                requestedBy: "dragon-control",
                ...(planned.params ? { params: planned.params } : {}),
                ...(planned.change ? { change: planned.change } : {}),
              },
              { ...ref, hostId: service.hostId ?? "" },
            );
            ok = out.ok;
            result = out.result;
          } catch (error) {
            const why = error instanceof Error ? error.message : String(error);
            ok = /already paused/i.test(why);
            result = ok ? "It was already paused." : why;
          }
        }
        if (ok) run.done[key] = at;
        else run.tries[key] = (run.tries[key] ?? 0) + 1;
        fresh.push({ ...entry, ok, result });
        await recordAudit(this.handle.db, {
          actor: "dragon-control",
          action: `Seeding rule "${entry.rule}": ${SEEDING_ACTION_LABEL[r.action].toLowerCase()}, "${tor.name}"`,
          target: `service:${service.id}`,
          detail: {
            ok,
            result: result.slice(0, 500),
            seedingSec: entry.seedingSec,
            ratio: tor.ratio,
          },
        });
      }
      run.lastCheck = at;
      run.unseen = [...fresh, ...run.unseen].slice(0, 50);
      await this.putSeedingRun(service.id, run);
      if (fresh.length) {
        const all = (await getSetting(this.handle.db, "seeding_rule_log")) ?? {};
        await setSetting(this.handle.db, "seeding_rule_log", {
          ...all,
          [service.id]: [...fresh, ...(all[service.id] ?? [])].slice(0, 200),
        });
        this.dashboards.delete(service.id);
      }
      acted.push(...fresh);
    }
    return acted;
  }

  private sourceCache?: { at: number; value: Promise<ReturnType<typeof sourceIndex>> };

  /** Every grab the *arr apps and Prowlarr remember (newest 250 each), read at most every 2 minutes. */
  private grabSources() {
    if (this.sourceCache && Date.now() - this.sourceCache.at < 120_000)
      return this.sourceCache.value;
    const value = (async () => {
      const records: GrabRecord[] = [];
      const list = (await this.targets()).filter(
        (x) =>
          ["sonarr", "radarr", "lidarr", "chaptarr", "readarr", "prowlarr"].includes(x.app) &&
          !x.service.checkTarget?.startsWith("demo:"),
      );
      const purpose = "read grab history to show where downloads came from";
      const q = "page=1&pageSize=250&sortKey=date&sortDirection=descending&eventType=1";
      // One app that answers oddly (or not at all) never hides the others.
      await Promise.allSettled(
        list.map(async ({ app, service }) => {
          const v = app === "sonarr" || app === "radarr" ? "v3" : "v1";
          const read = async (path: string) =>
            (await this.appApi(service.id, { method: "GET", path }, { access: "read", purpose })
              .then((a) => (a.ok ? a.body : undefined))
              .catch(() => undefined)) as unknown;
          const raw = (await read(`/api/${v}/history?${q}`)) as { records?: unknown } | undefined;
          const h = (raw && Array.isArray(raw.records) ? raw : undefined) as
            | {
                records?: {
                  downloadId?: string;
                  sourceTitle?: string;
                  indexerId?: number;
                  data?: Record<string, string | undefined>;
                }[];
              }
            | undefined;
          if (app === "prowlarr") {
            const got = await read("/api/v1/indexer");
            const ix = (Array.isArray(got) ? got : []) as { id?: number; name?: string }[];
            const names = new Map(ix.map((i) => [i.id, i.name ?? ""]));
            for (const r of h?.records ?? []) {
              const indexer = names.get(r.indexerId) ?? "";
              const title = r.data?.grabTitle ?? r.data?.title;
              if (indexer && title)
                records.push({ title, indexer, via: r.data?.source || "Prowlarr" });
            }
            return;
          }
          for (const r of h?.records ?? [])
            if (typeof r.data?.indexer === "string" && r.data.indexer)
              records.push({
                ...(r.downloadId ? { downloadId: r.downloadId } : {}),
                ...(r.sourceTitle ? { title: r.sourceTitle } : {}),
                indexer: r.data.indexer,
                via: service.name,
              });
        }),
      );
      // The *arr's own record (with the download's id) before Prowlarr's (title only).
      return sourceIndex([
        ...records.filter((r) => r.downloadId),
        ...records.filter((r) => !r.downloadId),
      ]);
    })();
    this.sourceCache = { at: Date.now(), value };
    void value.catch(() => (this.sourceCache = undefined));
    return value;
  }

  private async readDashboard(serviceId: string, by?: "agent"): Promise<AppDashboard> {
    const at = new Date().toISOString();
    const target = (await this.targets([serviceId]))[0];
    if (!target || !(DASHBOARD_APPS as readonly string[]).includes(target.app)) {
      return {
        serviceId,
        at,
        error: {
          kind: "unsupported",
          message: "Hearth has no live dashboard for this service yet.",
        },
      };
    }
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:")) {
      return {
        serviceId,
        at,
        sample: true,
        data:
          target.app === "plex"
            ? samplePlex()
            : target.app === "sonarr" || target.app === "radarr"
              ? sampleArr(target.app)
              : target.app === "seerr"
                ? sampleSeerr()
                : target.app === "wizarr"
                  ? sampleWizarr()
                  : target.app === "tautulli"
                    ? sampleTautulli()
                    : target.app === "sabnzbd"
                      ? sampleSabnzbd()
                      : target.app === "nzbget"
                        ? (({ speedLimitPct: _pct, ...rest }) => {
                            void _pct;
                            return { ...rest, app: "nzbget" as const };
                          })(sampleSabnzbd())
                        : target.app === "prowlarr"
                          ? sampleProwlarr()
                          : target.app === "bazarr"
                            ? sampleBazarr()
                            : target.app === "homeassistant"
                              ? sampleHomeAssistant()
                              : target.app === "syncthing"
                                ? sampleSyncthing()
                                : target.app === "lidarr" || target.app === "chaptarr"
                                  ? sampleLibrary(target.app)
                                  : jellyfinLike(target.app)
                                    ? sampleJellyfin()
                                    : target.app === "immich"
                                      ? sampleImmich()
                                      : target.app === "audiobookshelf"
                                        ? sampleAudiobookshelf()
                                        : target.app === "kavita"
                                          ? sampleKavita()
                                          : target.app === "portainer"
                                            ? samplePortainer()
                                            : target.app === "uptimekuma"
                                              ? sampleUptimeKuma()
                                              : target.app === "nextcloud"
                                                ? sampleNextcloud()
                                                : target.app === "paperless"
                                                  ? samplePaperless()
                                                  : target.app === "vaultwarden"
                                                    ? sampleVaultwarden()
                                                    : target.app === "tailscale"
                                                      ? sampleTailscale()
                                                      : target.app === "wgeasy"
                                                        ? sampleWgEasy()
                                                        : target.app === "navidrome"
                                                          ? sampleNavidrome()
                                                          : target.app === "komga"
                                                            ? sampleKomga()
                                                            : target.app === "mealie"
                                                              ? sampleMealie()
                                                              : target.app === "actual"
                                                                ? sampleActual()
                                                                : target.app === "authentik"
                                                                  ? sampleAuthentik()
                                                                  : target.app === "frigate"
                                                                    ? sampleFrigate()
                                                                    : target.app === "authelia"
                                                                      ? sampleAuthelia()
                                                                      : target.app === "gitea"
                                                                        ? sampleGitea()
                                                                        : target.app === "traefik"
                                                                          ? sampleTraefik()
                                                                          : target.app === "npm"
                                                                            ? sampleNpm()
                                                                            : target.app ===
                                                                                "proxmox"
                                                                              ? sampleProxmox()
                                                                              : target.app ===
                                                                                  "pihole"
                                                                                ? samplePihole()
                                                                                : target.app ===
                                                                                    "adguard"
                                                                                  ? sampleAdguard()
                                                                                  : target.app ===
                                                                                      "romm"
                                                                                    ? sampleRomm()
                                                                                    : target.app ===
                                                                                        "ersatztv"
                                                                                      ? sampleErsatz()
                                                                                      : target.app ===
                                                                                          "transmission"
                                                                                        ? {
                                                                                            ...sampleQbittorrent(),
                                                                                            app: "transmission" as const,
                                                                                            labelsEnabled: true,
                                                                                            alternativeLimits: false,
                                                                                          }
                                                                                        : {
                                                                                            ...sampleQbittorrent(),
                                                                                            vpn: await this.vpnOf(
                                                                                              service.id,
                                                                                            ),
                                                                                          },
      };
    }
    if (target.app === "authelia") {
      if (!service.localUrl)
        return {
          serviceId,
          at,
          error: {
            kind: "unreachable",
            message: `Hearth does not know ${service.name}'s address.`,
          },
        };
      try {
        const data = await autheliaDashboard(
          this.fetchImpl ?? (fetch as unknown as Fetch),
          service.localUrl,
        );
        return { serviceId, at: new Date().toISOString(), data };
      } catch (error) {
        return { serviceId, at, error: dashboardError(error) };
      }
    }
    if (target.app === "traefik") {
      if (!service.localUrl)
        return {
          serviceId,
          at,
          error: {
            kind: "unreachable",
            message: `Hearth does not know ${service.name}'s address.`,
          },
        };
      try {
        const data = await traefikDashboard(
          this.fetchImpl ?? (fetch as unknown as Fetch),
          service.localUrl,
        );
        return { serviceId, at: new Date().toISOString(), data };
      } catch (error) {
        return { serviceId, at, error: dashboardError(error) };
      }
    }
    if (target.app === "ersatztv") {
      if (!service.localUrl)
        return {
          serviceId,
          at,
          error: {
            kind: "unreachable",
            message: `Hearth does not know ${service.name}'s address.`,
          },
        };
      try {
        const data = await ersatzDashboard(
          this.fetchImpl ?? (fetch as unknown as Fetch),
          service.localUrl,
        );
        return { serviceId, at: new Date().toISOString(), data };
      } catch (error) {
        return { serviceId, at, error: dashboardError(error) };
      }
    }
    const key = await this.keyFor(service, target.app);
    if (!key.id)
      return {
        serviceId,
        at,
        error: { kind: "needs-key", message: key.problem ?? "No credential." },
      };
    // Tailscale keeps its devices in its own service: Hearth reads its cloud API, not the address.
    if (!service.localUrl && target.app !== "tailscale") {
      return {
        serviceId,
        at,
        error: {
          kind: "unreachable",
          message: `Hearth does not know ${service.name}'s address.`,
        },
      };
    }
    const base = target.app === "tailscale" ? TAILSCALE_API : service.localUrl!;
    this.live ??= new QbittorrentLive(this.fetchImpl ?? (fetch as unknown as Fetch));
    this.plex ??= new PlexLive(this.fetchImpl ?? (fetch as unknown as Fetch));
    try {
      const use = {
        serviceId: service.id,
        purpose: `read ${service.name}'s live dashboard`,
        access: "read" as const,
        destination: base,
        ...(by ? { onBehalfOf: by } : {}),
      };
      if (target.app === "plex") {
        const data = await this.broker.use(use, ({ value }) =>
          this.plex!.dashboard(service.id, base, value),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "transmission") {
        this.transmission ??= new TransmissionLive(this.fetchImpl ?? (fetch as unknown as Fetch));
        const data = await this.broker.use(use, ({ value, username }) =>
          this.transmission!.dashboard(service.id, base, {
            username: username ?? "",
            password: value,
          }),
        );
        const vpn = await this.vpnOf(service.id);
        return {
          serviceId,
          at: new Date().toISOString(),
          data: { ...data, ...(vpn ? { vpn } : {}) },
        };
      }
      if (target.app === "deluge") {
        this.deluge ??= new DelugeLive(this.fetchImpl ?? (fetch as unknown as Fetch));
        const data = await this.broker.use(use, ({ value }) =>
          this.deluge!.dashboard(service.id, base, value),
        );
        const vpn = await this.vpnOf(service.id);
        return {
          serviceId,
          at: new Date().toISOString(),
          data: { ...data, ...(vpn ? { vpn } : {}) },
        };
      }
      if (target.app === "romm") {
        const data = await this.broker.use(use, ({ value, username }) =>
          rommDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), base, {
            value,
            ...(username ? { username } : {}),
          }),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "pihole") {
        const fetchImpl = this.fetchImpl ?? (fetch as unknown as Fetch);
        const data = await this.broker.use(use, async ({ value }) =>
          piholeDashboard(await PiholeSession.open(base, value, fetchImpl)),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "adguard") {
        const fetchImpl = this.fetchImpl ?? (fetch as unknown as Fetch);
        const data = await this.broker.use(use, ({ value, username }) =>
          adguardDashboard(
            new AdguardClient(base, { username: username ?? "", password: value }, fetchImpl),
          ),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "proxmox") {
        // Proxmox's self-signed certificate: a pinned connection (or the stand-in, in tests).
        const fetchImpl = this.fetchImpl ?? localTlsFetch;
        const data = await this.broker.use(use, ({ value }) =>
          proxmoxDashboard(new ProxmoxClient(base, value, fetchImpl)),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "npm") {
        const fetchImpl = this.fetchImpl ?? (fetch as unknown as Fetch);
        const data = await this.broker.use(use, ({ value, username }) =>
          npmDashboard(
            new NpmClient(base, { username: username ?? "", password: value }, fetchImpl),
          ),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "uptimekuma") {
        const fetchImpl = this.fetchImpl ?? (fetch as unknown as Fetch);
        const data = await this.broker.use(use, ({ value, username }) =>
          kumaDashboard(fetchImpl, base, { username: username ?? "", password: value }),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "gitea") {
        const data = await this.broker.use(use, ({ value }) =>
          giteaDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "frigate") {
        // Frigate's signed-in port uses its own self-signed certificate: a pinned connection.
        const fetchImpl = this.fetchImpl ?? localTlsFetch;
        const data = await this.broker.use(use, ({ value, username }) =>
          frigateDashboard(fetchImpl, base, { username: username ?? "", password: value }),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "authentik") {
        const data = await this.broker.use(use, ({ value }) =>
          authentikDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "actual") {
        const data = await this.broker.use(use, ({ value }) =>
          actualDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "mealie") {
        const data = await this.broker.use(use, ({ value }) =>
          mealieDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "komga") {
        const data = await this.broker.use(use, ({ value }) =>
          komgaDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "navidrome") {
        const data = await this.broker.use(use, ({ value, username }) =>
          navidromeDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), base, {
            username: username ?? "",
            password: value,
          }),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "wgeasy") {
        const data = await this.broker.use(use, ({ value, username }) =>
          wgEasyDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), base, {
            username: username ?? "",
            password: value,
          }),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "tailscale") {
        const data = await this.broker.use(use, ({ value }) =>
          tailscaleDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), value),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "vaultwarden") {
        const data = await this.broker.use(use, ({ value }) =>
          vaultwardenDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "paperless") {
        const data = await this.broker.use(use, ({ value }) =>
          paperlessDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "nextcloud") {
        const fetchImpl = this.fetchImpl ?? (fetch as unknown as Fetch);
        const data = await this.broker.use(use, ({ value, username }) =>
          nextcloudDashboard(fetchImpl, base, { username: username ?? "", password: value }),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "portainer") {
        const fetchImpl = this.fetchImpl ?? (fetch as unknown as Fetch);
        const data = await this.broker.use(use, ({ value }) =>
          portainerDashboard(new PortainerClient(base, value, fetchImpl)),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "kavita") {
        const data = await this.broker.use(use, ({ value }) =>
          kavitaDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "audiobookshelf") {
        const data = await this.broker.use(use, ({ value }) =>
          audiobookshelfDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "immich") {
        const data = await this.broker.use(use, ({ value }) =>
          immichDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (jellyfinLike(target.app)) {
        const data = await this.broker.use(use, ({ value }) =>
          jellyfinDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "lidarr" || target.app === "chaptarr") {
        const app = target.app;
        const data = await this.broker.use(use, ({ value }) =>
          libraryDashboard(app, this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "syncthing") {
        const data = await this.broker.use(use, ({ value }) =>
          syncthingDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "homeassistant") {
        const data = await this.broker.use(use, ({ value }) =>
          homeAssistantDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "bazarr") {
        const data = await this.broker.use(use, ({ value }) =>
          bazarrDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "prowlarr") {
        const data = await this.broker.use(use, ({ value }) =>
          prowlarrDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "sabnzbd") {
        const data = await this.broker.use(use, ({ value }) =>
          sabnzbdDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "nzbget") {
        const data = await this.broker.use(use, ({ value, username }) =>
          nzbgetDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), base, {
            username: username ?? "",
            password: value,
          }),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "tautulli") {
        const data = await this.broker.use(use, ({ value }) =>
          tautulliDashboard(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "wizarr") {
        const data = await this.broker.use(use, ({ value }) =>
          wizarrDashboard(
            this.fetchImpl ?? (fetch as unknown as Fetch),
            base,
            value,
            Date.now(),
            target.service.publicUrl,
          ),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "seerr") {
        // Seerr and every Radarr, each read with its own key through the broker.
        this.seerr ??= new SeerrLive(
          new MovieReleases(
            this.handle,
            this.broker,
            this.fetchImpl ?? (fetch as unknown as Fetch),
          ),
        );
        const saved = await getSetting(this.handle.db, "release_watch");
        const settings = { ...RELEASE_WATCH_DEFAULTS, ...saved };
        const now = new Date();
        const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
        const data = await this.seerr.dashboard(service, {
          region: settings.region,
          overdueAfterDays: settings.overdueAfterDays,
          now,
          today: local.toISOString().slice(0, 10),
        });
        return { serviceId, at: new Date().toISOString(), data };
      }
      if (target.app === "sonarr" || target.app === "radarr") {
        const app = target.app;
        this.arr ??= new ArrLive(this.fetchImpl ?? (fetch as unknown as Fetch));
        const data = await this.broker.use(use, ({ value }) =>
          this.arr!.dashboard(service.id, app, base, value),
        );
        return { serviceId, at: new Date().toISOString(), data };
      }
      const data = await this.broker.use(use, ({ value, username }) =>
        this.live!.dashboard(service.id, base, { username: username ?? "", password: value }),
      );
      return {
        serviceId,
        at: new Date().toISOString(),
        data: { ...data, vpn: await this.vpnOf(service.id) },
      };
    } catch (error) {
      return { serviceId, at, error: dashboardError(error) };
    }
  }

  /**
   * One movie in Radarr in depth (files, untracked copies in its folder, history with
   * upgrade reasons, quality profile, recycle bin), or one title's versions in Plex. Read
   * through the broker, audited as the AI's read when it asks.
   */
  async library(
    serviceId: string,
    q: {
      movieId?: number;
      seriesId?: number;
      title?: string;
      season?: number;
      episode?: number;
    },
    by?: "agent" | "you",
  ): Promise<Record<string, unknown>> {
    const target = (await this.targets([serviceId]))[0];
    if (!target || !["radarr", "sonarr", "plex"].includes(target.app))
      throw new NotFoundError("Not a watched Radarr, Sonarr, or Plex.");
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:"))
      return { note: `Sample data: there is no real ${service.name} to read.` };
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const lib = new MediaLibrary(this.broker, this.fetchImpl ?? (fetch as unknown as Fetch));
    const svc = { id: service.id, name: service.name, localUrl: service.localUrl };
    if (target.app === "plex") {
      if (!q.title) throw new ConflictError("Say which title to find in Plex.");
      return lib.plexItems(svc, q.title, by);
    }
    if (target.app === "sonarr") return lib.seriesReport(svc, q, by);
    return lib.movieReport(svc, q, by);
  }

  /** Sonarr's or Radarr's queue (with stuck-import detail), missing items, or one item's releases. */
  async arrView(
    serviceId: string,
    q: {
      view: "queue" | "missing" | "releases" | "profiles" | "naming";
      episodeId?: number;
      movieId?: number;
    },
    by?: "agent" | "you",
  ): Promise<Record<string, unknown>> {
    const target = (await this.targets([serviceId]))[0];
    if (!target || (target.app !== "sonarr" && target.app !== "radarr"))
      throw new NotFoundError("Not a watched Sonarr or Radarr.");
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:"))
      return { note: `Sample data: there is no real ${service.name} to read.` };
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const lib = new MediaLibrary(this.broker, this.fetchImpl ?? (fetch as unknown as Fetch));
    const svc = { id: service.id, name: service.name, localUrl: service.localUrl };
    if (q.view === "queue") return lib.arrQueue(svc, target.app, by);
    if (q.view === "missing") return lib.arrMissing(svc, target.app, by);
    if (q.view === "profiles") return lib.arrProfiles(svc, target.app, by);
    if (q.view === "naming") return lib.arrNaming(svc, target.app, by);
    if (target.app === "sonarr" ? q.episodeId === undefined : q.movieId === undefined)
      throw new ConflictError(
        `Say which ${target.app === "sonarr" ? "episodeId" : "movieId"} to look up.`,
      );
    return lib.arrReleases(svc, target.app, q, by);
  }

  /**
   * Any request to a connected app's own API with its Secure Vault credential (app-api.ts).
   * A read needs any working credential; a change needs one allowed for approved changes, and
   * the caller decides whether the change was approved (a plan step, or Full access).
   */
  async appApi(
    serviceId: string,
    req: ApiRequest,
    opts: { access: "read" | "change"; purpose: string; by?: "agent" | "you" },
  ): Promise<ApiAnswer & { app: string; service: string }> {
    const target = (await this.targets([serviceId]))[0];
    if (!target) return this.genericApi(serviceId, req, opts);
    const { service, app } = target;
    const problem = pathProblem(req.path) ?? bodyProblem(app, req.body);
    if (problem) throw new ConflictError(problem);
    if (req.method !== "GET" && opts.access !== "change")
      throw new ConflictError("A change needs change access.");
    if (service.checkTarget?.startsWith("demo:"))
      throw new ConflictError(`Sample data: there is no real ${service.name} to ask.`);
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const base = service.localUrl;
    const fetchImpl = this.fetchImpl ?? (fetch as unknown as Fetch);
    const name = APP_INTEGRATIONS[app].name;
    const once = (r: ApiRequest, access: "read" | "change") =>
      APP_INTEGRATIONS[app].credential === "none"
        ? appApi(fetchImpl, app, name, base, undefined, r)
        : this.broker.use(
            {
              serviceId: service.id,
              purpose: opts.purpose,
              access,
              destination: joinUrl(base, r.path),
              ...(opts.by ? { onBehalfOf: opts.by } : {}),
            },
            (cred) => appApi(fetchImpl, app, name, base, cred, r),
          );
    const first = await once(req, opts.access);
    const answer = await followCommand(req, first, (path) => once({ method: "GET", path }, "read"));
    return { ...answer, app, service: service.name };
  }

  /**
   * The same for a web app Hearth watches but has no reader for (the generic panel's Ask Ember):
   * its own API at its own address, with its vault credential when one is linked (sent the way
   * req.auth says), or none. Protected infrastructure is never reached this way.
   */
  private async genericApi(
    serviceId: string,
    req: ApiRequest,
    opts: { access: "read" | "change"; purpose: string; by?: "agent" | "you" },
  ): Promise<ApiAnswer & { app: string; service: string }> {
    const service = (
      await this.handle.db.select().from(t.services).where(eq(t.services.id, serviceId))
    )[0];
    if (!service || service.lifecycle !== "active")
      throw new NotFoundError("Not a system Hearth watches.");
    if (!/^https?:\/\//.test(service.localUrl ?? ""))
      throw new ConflictError(`Hearth does not know a web address for ${service.name}.`);
    if (isCoreNetworking(service.name, service.image))
      throw new ConflictError(
        `${service.name} is protected infrastructure: Hearth does not reach its API this way.`,
      );
    if (service.checkTarget?.startsWith("demo:"))
      throw new ConflictError(`Sample data: there is no real ${service.name} to ask.`);
    const problem =
      pathProblem(req.path) ?? bodyProblem("generic", req.body) ?? authProblem(req.auth);
    if (problem) throw new ConflictError(problem);
    if (req.method !== "GET" && opts.access !== "change")
      throw new ConflictError("A change needs change access.");
    const base = service.localUrl!;
    const fetchImpl = this.fetchImpl ?? (fetch as unknown as Fetch);
    if (req.auth === "session")
      return {
        ...(await this.sessions.withSession(service.id, opts.purpose, (cred, headers) =>
          appApi(fetchImpl, "generic", service.name, base, cred, req, headers),
        )),
        app: "generic",
        service: service.name,
      };
    const answer =
      req.auth !== "none" && (await this.broker.has(service.id))
        ? await this.broker.use(
            {
              serviceId: service.id,
              purpose: opts.purpose,
              access: opts.access,
              destination: joinUrl(base, req.path),
              ...(opts.by ? { onBehalfOf: opts.by } : {}),
            },
            (cred) => appApi(fetchImpl, "generic", service.name, base, cred, req),
          )
        : await appApi(fetchImpl, "generic", service.name, base, undefined, req);
    return { ...answer, app: "generic", service: service.name };
  }

  /**
   * A picture from an app Hearth has no reader for (a custom panel's image block): one GET on its
   * own address with its vault credential, sent as `auth` says. Only image answers come back, at
   * most 5 MB; the same refusals as genericApi (protected systems, sample data, bad paths).
   */
  async genericImage(
    serviceId: string,
    path: string,
    opts: { auth?: string; purpose: string },
  ): Promise<{ type: string; bytes: Buffer }> {
    const service = (
      await this.handle.db.select().from(t.services).where(eq(t.services.id, serviceId))
    )[0];
    if (!service || service.lifecycle !== "active")
      throw new NotFoundError("Not a system Hearth watches.");
    if (!/^https?:\/\//.test(service.localUrl ?? ""))
      throw new ConflictError(`Hearth does not know a web address for ${service.name}.`);
    if (isCoreNetworking(service.name, service.image))
      throw new ConflictError(`${service.name} is protected infrastructure.`);
    if (service.checkTarget?.startsWith("demo:"))
      throw new ConflictError(`Sample data: there is no real ${service.name} to ask.`);
    const problem = pathProblem(path) ?? authProblem(opts.auth);
    if (problem) throw new ConflictError(problem);
    const base = service.localUrl!;
    const fetchImpl = this.fetchImpl ?? (fetch as unknown as Fetch);
    const get = async (
      cred?: { value: string; username?: string },
      session?: Record<string, string>,
    ) => {
      let p = path;
      const headers: Record<string, string> = { Accept: "image/*", ...session };
      const auth = opts.auth ?? (cred?.username ? "basic" : "header:X-Api-Key");
      if (cred && auth !== "none" && !session) {
        if (auth.startsWith("header:")) headers[auth.slice(7)] = cred.value;
        else if (auth === "bearer") headers.Authorization = `Bearer ${cred.value}`;
        else if (auth === "basic")
          headers.Authorization = `Basic ${Buffer.from(`${cred.username ?? ""}:${cred.value}`).toString("base64")}`;
        else if (auth.startsWith("query:"))
          p = `${p}${p.includes("?") ? "&" : "?"}${auth.slice(6)}=${encodeURIComponent(cred.value)}`;
      }
      const res = await fetchImpl(joinUrl(base, p), {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
      const type = res?.headers?.get?.("content-type") ?? "";
      if (!res?.ok || !/^image\//.test(type)) throw new NotFoundError("No picture.");
      const bytes = Buffer.from(await (res as unknown as Response).arrayBuffer());
      if (bytes.length > 5_000_000) throw new ConflictError("The picture is too large.");
      return { type, bytes };
    };
    if (opts.auth === "session")
      return this.sessions.withSession(service.id, opts.purpose, (cred, headers) =>
        get(cred, headers),
      );
    return opts.auth !== "none" && (await this.broker.has(service.id))
      ? this.broker.use(
          {
            serviceId: service.id,
            purpose: opts.purpose,
            access: "read",
            destination: joinUrl(base, path),
          },
          (cred) => get(cred),
        )
      : get();
  }

  /**
   * Show years Sonarr knows, by title and by folder name (lowercase), for the Collection PDF.
   * Every Sonarr Hearth watches is asked; one that cannot be read is skipped.
   */
  async showYears(): Promise<Map<string, number>> {
    const years = new Map<string, number>();
    const lib = new MediaLibrary(this.broker, this.fetchImpl ?? (fetch as unknown as Fetch));
    for (const { service } of (await this.targets()).filter((x) => x.app === "sonarr")) {
      if (service.checkTarget?.startsWith("demo:") || !service.localUrl) continue;
      const r = await lib
        .arr<{ title?: string; year?: number; path?: string }[]>(
          { id: service.id, name: service.name, localUrl: service.localUrl },
          "GET",
          "/api/v3/series",
          "read show years for the Collection PDF",
        )
        .catch(() => undefined);
      for (const s of Array.isArray(r?.data) ? r.data : []) {
        if (!s.year) continue;
        if (s.title) years.set(s.title.toLowerCase(), s.year);
        const folder = s.path?.split(/[\\/]/).filter(Boolean).pop();
        if (folder) years.set(folder.toLowerCase(), s.year);
      }
    }
    return years;
  }

  /** Movies in Radarr by title, for its panel's Find (from the library it last read). */
  /**
   * One view of the native Radarr or Sonarr panel (radarr-panel.ts, sonarr-panel.ts), read
   * through the credential broker. Sample data reads a stand-in app, so the tabs show something
   * real-looking without a key.
   */
  radarrPanel(
    serviceId: string,
    view: RadarrView,
    q: Record<string, string | undefined>,
    by?: "agent",
  ) {
    return this.servarrPanel("radarr", serviceId, (get) => readRadarrView(get, view, q), view, by);
  }

  sonarrPanel(
    serviceId: string,
    view: SonarrView,
    q: Record<string, string | undefined>,
    by?: "agent",
  ) {
    return this.servarrPanel("sonarr", serviceId, (get) => readSonarrView(get, view, q), view, by);
  }

  prowlarrPanel(
    serviceId: string,
    view: ProwlarrView,
    q: Record<string, string | undefined>,
    by?: "agent",
  ) {
    return this.servarrPanel(
      "prowlarr",
      serviceId,
      (get) => readProwlarrView(get, view, q),
      view,
      by,
    );
  }

  /**
   * One view of the native Seerr panel's Discover, Issues and People tabs (seerr-panel.ts), read
   * through the credential broker; sample data reads the stand-in Seerr.
   */
  async seerrPanel(
    serviceId: string,
    view: SeerrView,
    q: Record<string, string | undefined>,
    by?: "agent",
  ) {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "seerr") throw new NotFoundError("Not a watched Seerr.");
    const { service } = target;
    const read = (get: ServarrGet) =>
      readSeerrView(get, view, q).catch((e: unknown) => {
        if (e instanceof SeerrReadError) throw new ConflictError(e.message);
        throw e;
      });
    if (service.checkTarget?.startsWith("demo:")) {
      const sample = (demoSeerr ??= fakeMedia());
      return {
        sample: true,
        ...(await read(async (path) => {
          const r = await sample.fetch(`http://demo.invalid:5055${path}`, {
            method: "GET",
            headers: {},
            signal: AbortSignal.timeout(5_000),
          });
          return { ok: r.ok, status: r.status, data: await r.json() };
        })),
      };
    }
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const lib = new MediaLibrary(this.broker, this.fetchImpl ?? (fetch as unknown as Fetch));
    const svc = {
      id: service.id,
      name: service.name,
      localUrl: service.localUrl,
      hostId: service.hostId,
    };
    const data = await read((path) =>
      lib.arr(svc, "GET", path, `read ${service.name}'s ${view} for its panel`, by ? { by } : {}),
    );
    // What Radarr and Sonarr already have, for titles Seerr calls not requested (seerr-library.ts).
    if (!["title", "discover", "search", "similar"].includes(view)) return data;
    this.seerrLibrary ??= new SeerrLibrary(
      new MovieReleases(this.handle, this.broker, this.fetchImpl ?? (fetch as unknown as Fetch)),
    );
    return this.seerrLibrary.annotate(view, data);
  }

  lidarrPanel(
    serviceId: string,
    view: LidarrView,
    q: Record<string, string | undefined>,
    by?: "agent",
  ) {
    return this.servarrPanel("lidarr", serviceId, (get) => readLidarrView(get, view, q), view, by);
  }

  /**
   * One view of the native Plex panel's Library, History, Tasks and Settings tabs (plex-panel.ts),
   * read with the token through the broker; sample data reads the stand-in.
   */
  async plexPanel(serviceId: string, view: PlexView, q: Record<string, string | undefined>) {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "plex") throw new NotFoundError("Not a watched Plex.");
    const { service } = target;
    const read = (get: ServarrGet) =>
      readPlexView(get, view, q).catch((e: unknown) => {
        if (e instanceof PlexReadError) throw new ConflictError(e.message);
        throw e;
      });
    const via =
      (f: Fetch, base: string, token: string): ServarrGet =>
      async (path) => {
        const r = await f(joinUrl(base, path), {
          method: "GET",
          headers: { Accept: "application/json", "X-Plex-Token": token },
          signal: AbortSignal.timeout(15_000),
        });
        if (r.status === 401) throw new ConflictError("Plex refused the token. Link Plex again.");
        return { ok: r.ok, status: r.status, data: r.ok ? await r.json().catch(() => ({})) : {} };
      };
    // Who has access: from plex.tv, the account the server's token came from.
    const access = async (f: Fetch, base: string, token: string) =>
      readPlexAccess(
        f,
        base,
        token,
        (await getSetting(this.handle.db, "plex_client_id")) ?? "hearth",
      ).catch((e: unknown) => {
        if (e instanceof PlexAccessError) throw new ConflictError(e.message);
        throw e;
      });
    if (service.checkTarget?.startsWith("demo:")) {
      const sample = (demoPlex ??= fakePlex());
      if (view === "access")
        return {
          sample: true,
          ...(await access(sample.fetch, "http://demo.invalid:32400", "e2e-demo")),
        };
      return {
        sample: true,
        ...(await read(via(sample.fetch, "http://demo.invalid:32400", "e2e-demo"))),
      };
    }
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const base = service.localUrl;
    if (view === "access")
      return this.broker.use(
        {
          serviceId: service.id,
          purpose: "read who Plex is shared with, from plex.tv",
          access: "read",
          destination: PLEX_TV,
          account: "plex.tv",
        },
        ({ value }) => access(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
      );
    return this.broker.use(
      {
        serviceId: service.id,
        purpose: `read Plex's ${view} for its panel`,
        access: "read",
        destination: base,
      },
      ({ value }) => read(via(this.fetchImpl ?? (fetch as unknown as Fetch), base, value)),
    );
  }

  /**
   * One view of the native Jellyfin panel's People, Devices, Activity and System tabs
   * (jellyfin-panel.ts), read with its key through the broker; sample data reads the stand-in.
   */
  async jellyfinPanel(
    serviceId: string,
    view: JellyfinView,
    q: Record<string, string | undefined>,
  ) {
    const target = (await this.targets([serviceId]))[0];
    if (!target || !jellyfinLike(target.app))
      throw new NotFoundError("Not a watched Jellyfin or Emby.");
    const { service } = target;
    const read = (get: ServarrGet) =>
      readJellyfinView(get, view, q).catch((e: unknown) => {
        if (e instanceof JellyfinReadError) throw new ConflictError(e.message);
        throw e;
      });
    const via =
      (f: Fetch, base: string, key: string): ServarrGet =>
      async (path) => {
        // Log files come back as plain text.
        if (path.startsWith("/System/Logs/Log")) {
          const r = await f(`${base}${path}`, {
            method: "GET",
            headers: { Authorization: `MediaBrowser Token="${key}"` },
            signal: AbortSignal.timeout(15_000),
          });
          return { ok: r.ok, status: r.status, data: r.text ? await r.text() : "" };
        }
        return jellyfinCall(f, base, key, "GET", path);
      };
    if (service.checkTarget?.startsWith("demo:")) {
      const sample = (demoJellyfin ??= fakeJellyfin());
      return {
        sample: true,
        ...(await read(via(sample.fetch, "http://demo.invalid:8096", "e2e-demo"))),
      };
    }
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const base = service.localUrl;
    return this.broker.use(
      {
        serviceId: service.id,
        purpose: `read Jellyfin's ${view} for its panel`,
        access: "read",
        destination: base,
      },
      ({ value }) => read(via(this.fetchImpl ?? (fetch as unknown as Fetch), base, value)),
    );
  }

  /**
   * One view of the native Tautulli panel's History, People, Libraries, Graphs and System tabs
   * (tautulli-panel.ts), read with its key through the broker; sample data reads the stand-in.
   */
  async tautulliPanel(
    serviceId: string,
    view: TautulliView,
    q: Record<string, string | undefined>,
  ) {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "tautulli") throw new NotFoundError("Not a watched Tautulli.");
    const { service } = target;
    const run = (f: Fetch, base: string, key: string) => {
      const read: TautulliRead = (cmd, p) => tautulliCmd(f, base, key, cmd, p);
      return readTautulliView(read, view, q).catch((e: unknown) => {
        if (e instanceof TautulliReadError) throw new ConflictError(e.message);
        throw e;
      });
    };
    if (service.checkTarget?.startsWith("demo:")) {
      const sample = (demoTautulli ??= fakeTautulli());
      return { sample: true, ...(await run(sample.fetch, "http://demo.invalid:8181", "e2e-demo")) };
    }
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const base = service.localUrl;
    return this.broker.use(
      {
        serviceId: service.id,
        purpose: `read Tautulli's ${view} for its panel`,
        access: "read",
        destination: base,
      },
      ({ value }) => run(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
    );
  }

  private async servarrPanel(
    app: "radarr" | "sonarr" | "prowlarr" | "lidarr",
    serviceId: string,
    reader: (get: ServarrGet) => Promise<Record<string, unknown>>,
    view: string,
    by?: "agent",
  ) {
    const name = { radarr: "Radarr", sonarr: "Sonarr", prowlarr: "Prowlarr", lidarr: "Lidarr" }[
      app
    ];
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== app) throw new NotFoundError(`Not a watched ${name}.`);
    const { service } = target;
    const read = (get: ServarrGet) =>
      reader(get).catch((e: unknown) => {
        if (e instanceof ServarrReadError) throw new ConflictError(e.message);
        throw e;
      });
    if (service.checkTarget?.startsWith("demo:")) {
      const sample =
        app === "radarr"
          ? (demoRadarr ??= fakeRadarr())
          : app === "sonarr"
            ? (demoSonarr ??= fakeSonarr())
            : app === "lidarr"
              ? (demoLidarr ??= fakeLidarr())
              : (demoProwlarr ??= fakeProwlarr());
      return {
        sample: true,
        ...(await read(async (path) => {
          const r = await sample.fetch(`http://demo.invalid:7879${path}`, {
            method: "GET",
            // The stand-in Prowlarr wants a test key; nothing real is read here.
            headers: { "X-Api-Key": "e2e-demo" },
            signal: AbortSignal.timeout(5_000),
          });
          return { ok: r.ok, status: r.status, data: await r.json() };
        })),
      };
    }
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const lib = new MediaLibrary(this.broker, this.fetchImpl ?? (fetch as unknown as Fetch));
    const svc = {
      id: service.id,
      name: service.name,
      localUrl: service.localUrl,
      hostId: service.hostId,
    };
    return read((path) =>
      lib.arr(svc, "GET", path, `read ${name}'s ${view} for its panel`, by ? { by } : {}),
    );
  }

  async findMovies(serviceId: string, q: string) {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "radarr") throw new NotFoundError("Not a watched Radarr.");
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:"))
      return { sample: true, movies: findMovies(sampleRadarrLibrary().index, q) };
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const base = service.localUrl;
    this.arr ??= new ArrLive(this.fetchImpl ?? (fetch as unknown as Fetch));
    return this.broker.use(
      {
        serviceId: service.id,
        purpose: `find a movie in ${service.name}`,
        access: "read",
        destination: base,
      },
      ({ value }) => this.arr!.findMovies(service.id, base, value, q),
    );
  }

  /**
   * Reads from Lidarr or Chaptarr for Recommend (its lookups and library), through the broker:
   * the key never leaves it. Sample apps have nothing to read, so they are refused plainly.
   */
  /**
   * Curator For You (11-13): one read-only Plex GET (JSON), the token through the broker. Sample
   * data reads the stand-in.
   */
  async plexGet<T>(serviceId: string, path: string, purpose: string): Promise<T> {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "plex") throw new NotFoundError("Not a watched Plex.");
    const { service } = target;
    const get = async (f: Fetch, base: string, token: string) => {
      const r = await f(joinUrl(base, path), {
        method: "GET",
        headers: { Accept: "application/json", "X-Plex-Token": token },
        signal: AbortSignal.timeout(30_000),
      });
      if (r.status === 401) throw new ConflictError("Plex refused the token. Link Plex again.");
      if (!r.ok) throw new ConflictError(`Plex answered ${r.status} for ${path.split("?")[0]}.`);
      return (await r.json().catch(() => ({}))) as T;
    };
    if (service.checkTarget?.startsWith("demo:")) {
      const sample = (demoPlex ??= fakePlex());
      return get(sample.fetch, "http://demo.invalid:32400", "e2e-demo");
    }
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const base = service.localUrl;
    return this.broker.use(
      { serviceId: service.id, purpose, access: "read", destination: base },
      ({ value }) => get(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
    );
  }

  /** Curator For You (11-13): one read-only Tautulli command, the key through the broker. */
  async tautulliGet<T>(
    serviceId: string,
    cmd: string,
    params: Record<string, string | number>,
    purpose: string,
  ): Promise<T> {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "tautulli") throw new NotFoundError("Not a watched Tautulli.");
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:")) {
      const sample = (demoTautulli ??= fakeTautulli());
      return tautulliCmd<T>(sample.fetch, "http://demo.invalid:8181", "e2e-demo", cmd, params);
    }
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const base = service.localUrl;
    return this.broker.use(
      { serviceId: service.id, purpose, access: "read", destination: base },
      ({ value }) =>
        tautulliCmd<T>(this.fetchImpl ?? (fetch as unknown as Fetch), base, value, cmd, params),
    );
  }

  async arrRead<T>(
    serviceId: string,
    purpose: string,
    fn: (call: SearchCall, web: string) => Promise<T>,
  ): Promise<T> {
    return this.searchCall(
      serviceId,
      purpose,
      (_app, call, web) => fn(call, web),
      () => {
        throw new ConflictError("This is a sample app: there is nothing real to check against.");
      },
    );
  }

  /**
   * Interactive search (Sonarr, Radarr, Lidarr, Chaptarr): reads through the broker, nothing is
   * downloaded here. Sending a release to the download client is a plan step the owner confirms.
   */
  private async searchCall<T>(
    serviceId: string,
    purpose: string,
    live: (app: SearchApp, call: SearchCall, web: string) => Promise<T>,
    sample: (app: SearchApp) => T,
  ): Promise<T> {
    const target = (await this.targets([serviceId]))[0];
    const app = target?.app as SearchApp | undefined;
    if (!target || !app || !["sonarr", "radarr", "lidarr", "chaptarr"].includes(app))
      throw new NotFoundError("Interactive search works in Sonarr, Radarr, Lidarr and Chaptarr.");
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:")) return sample(app);
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const base = service.localUrl;
    const fetchImpl = this.fetchImpl ?? (fetch as unknown as Fetch);
    return this.broker.use(
      {
        serviceId: service.id,
        purpose: `${purpose} in ${service.name}`,
        access: "read",
        destination: base,
      },
      ({ value }) =>
        live(
          app,
          async (method, path, body) => {
            const res = await fetchImpl(joinUrl(base, path), {
              method,
              headers: {
                "X-Api-Key": value,
                Accept: "application/json",
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
              },
              ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
              // Searching every indexer can take a while.
              signal: AbortSignal.timeout(120_000),
            });
            const data = await res.json().catch(() => undefined);
            return { ok: res.ok, status: res.status, data: data as never };
          },
          service.publicUrl ?? base,
        ),
    );
  }

  async searchTitles(serviceId: string, q: string) {
    return this.searchCall(
      serviceId,
      "find a title",
      async (app, call, web) => ({
        // Chaptarr's add page, at the address the owner opens it from.
        titles: (await searchTitles(app, call, q)).map((t) =>
          t.notInLibrary?.addUrl
            ? {
                ...t,
                notInLibrary: { ...t.notInLibrary, addUrl: joinUrl(web, t.notInLibrary.addUrl) },
              }
            : t,
        ),
      }),
      (app) => ({ titles: sampleTitles(app, q), sample: true }),
    );
  }

  async searchEpisodes(serviceId: string, seriesId: number) {
    return this.searchCall(
      serviceId,
      "list a series' episodes",
      async (_app, call) => ({ episodes: await seriesEpisodes(call, seriesId) }),
      () => ({ episodes: sampleEpisodes(seriesId), sample: true }),
    );
  }

  /**
   * The Crucible's view of one Radarr (11-17): each movie's year, genres, popularity, tags, file
   * size and profile (for the live counts), and the profiles Hearth made, with what each blocks
   * (to spot a change made in Radarr itself). Read only.
   */
  async crucibleLibrary(serviceId: string): Promise<CrucibleLibrary> {
    return this.searchCall(
      serviceId,
      "read the library for the Crucible",
      async (app, call) => {
        if (app !== "radarr" && app !== "sonarr")
          throw new ConflictError("The Crucible works with Radarr (movies) and Sonarr (shows).");
        const App = app === "radarr" ? "Radarr" : "Sonarr";
        const get = async <T>(path: string) => {
          const r = await call<T>("GET", path);
          if (!r.ok) throw new ConflictError(`${App} did not answer ${path} (${r.status}).`);
          return r.data;
        };
        const [movies, tags, profiles] = await Promise.all([
          get<Record<string, unknown>[]>(app === "radarr" ? "/api/v3/movie" : "/api/v3/series"),
          get<{ id: number; label: string }[]>("/api/v3/tag"),
          get<Record<string, unknown>[]>("/api/v3/qualityprofile"),
        ]);
        const tag = new Map(tags.map((t) => [t.id, t.label]));
        const profile = new Map(profiles.map((p) => [Number(p.id), String(p.name)]));
        return {
          titles: movies.map((m) => ({
            id: Number(m.id),
            title: String(m.title ?? ""),
            ...arrTitle(m, tag),
            profile: profile.get(Number(m.qualityProfileId)) ?? "",
          })),
          hearthProfiles: profiles
            .filter((p) => String(p.name).startsWith(HEARTH_PREFIX))
            .map((p) => ({
              name: String(p.name),
              upgradeAllowed: Boolean(p.upgradeAllowed),
              blocks: ((p.formatItems as { name?: string; score?: number }[]) ?? [])
                .filter((f) => f.score === BLOCK_SCORE)
                .map((f) => String(f.name)),
            })),
          profiles: profiles.map((p) => String(p.name)),
        };
      },
      () => ({ titles: [], hearthProfiles: [], profiles: [], sample: true }),
    );
  }

  async searchReleases(serviceId: string, scope: ReleaseScope): Promise<ReleaseSearchResult> {
    return this.searchCall(
      serviceId,
      "search the indexers for one item (no download)",
      async (app, call) => withNearMiss(app, await findReleases(app, call, scope)),
      (app) => {
        scopeQuery(app, scope);
        return withNearMiss(app, sampleReleases(app));
      },
    );
  }

  /** One torrent in depth (trackers, peers, properties), read now through the broker. */
  async torrentDetail(
    serviceId: string,
    hash: string,
    by?: "agent",
    more: { files?: boolean; peers?: boolean } = {},
  ): Promise<TorrentDetail> {
    const target = (await this.targets([serviceId]))[0];
    if (
      !target ||
      (target.app !== "qbittorrent" && target.app !== "deluge" && target.app !== "transmission")
    )
      throw new NotFoundError("Not a watched torrent client.");
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:")) return sampleTorrentDetail(hash, more);
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const base = service.localUrl;
    if (target.app === "transmission") {
      this.transmission ??= new TransmissionLive(this.fetchImpl ?? (fetch as unknown as Fetch));
      return this.broker.use(
        {
          serviceId: service.id,
          purpose: `read one torrent in ${service.name}`,
          access: "read",
          destination: base,
          ...(by ? { onBehalfOf: by } : {}),
        },
        ({ value, username }) =>
          this.transmission!.detail(
            service.id,
            base,
            { username: username ?? "", password: value },
            hash,
            more,
          ),
      );
    }
    if (target.app === "deluge") {
      this.deluge ??= new DelugeLive(this.fetchImpl ?? (fetch as unknown as Fetch));
      return this.broker.use(
        {
          serviceId: service.id,
          purpose: `read one torrent in ${service.name}`,
          access: "read",
          destination: base,
          ...(by ? { onBehalfOf: by } : {}),
        },
        ({ value }) => this.deluge!.detail(service.id, base, value, hash, more),
      );
    }
    this.live ??= new QbittorrentLive(this.fetchImpl ?? (fetch as unknown as Fetch));
    return this.broker.use(
      {
        serviceId: service.id,
        purpose: `read one torrent in ${service.name}`,
        access: "read",
        destination: base,
        ...(by ? { onBehalfOf: by } : {}),
      },
      ({ value, username }) =>
        this.live!.detail(
          service.id,
          base,
          { username: username ?? "", password: value },
          hash,
          more,
        ),
    );
  }

  /** One RomM, read with its vault login or token (or sample data). */
  private async rommRead<T>(
    serviceId: string,
    purpose: string,
    by: "agent" | undefined,
    sample: () => T,
    read: (fetchImpl: Fetch, base: string, cred: RommCredential) => Promise<T>,
  ): Promise<T> {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "romm") throw new NotFoundError("Not a watched RomM.");
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:")) return sample();
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const base = service.localUrl;
    return this.broker.use(
      {
        serviceId: service.id,
        purpose: `${purpose} in ${service.name}`,
        access: "read",
        destination: base,
        ...(by ? { onBehalfOf: by } : {}),
      },
      ({ value, username }) =>
        read(this.fetchImpl ?? (fetch as unknown as Fetch), base, {
          value,
          ...(username ? { username } : {}),
        }),
    );
  }

  /**
   * Wizarr's invite steps or General settings, read with its admin sign-in (its API key cannot
   * open them). Never throws for a missing or refused sign-in: the panel shows how to add it.
   */
  async wizarrAdmin<T extends "wizard" | "settings">(
    serviceId: string,
    what: T,
    by?: "agent",
  ): Promise<WizarrAdminRead<T extends "wizard" ? WizarrWizard : WizarrSettings>> {
    type Out = T extends "wizard" ? WizarrWizard : WizarrSettings;
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "wizarr") throw new NotFoundError("Not a watched Wizarr.");
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:"))
      return {
        ok: true,
        sample: true,
        data: (what === "wizard" ? sampleWizarrWizard() : sampleWizarrSettings()) as Out,
      };
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    this.wizarrSessions ??= new WizarrAdminSessions(
      this.broker,
      this.fetchImpl ?? (fetch as unknown as Fetch),
    );
    try {
      const data = await this.wizarrSessions.use<WizarrWizard | WizarrSettings>(
        { id: service.id, localUrl: service.localUrl },
        what === "wizard"
          ? `read the invite steps in ${service.name}`
          : `read ${service.name}'s settings`,
        "read",
        (admin): Promise<WizarrWizard | WizarrSettings> =>
          what === "wizard" ? readWizarrWizard(admin) : readWizarrSettings(admin),
        by,
      );
      return { ok: true, data: data as Out };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof CredentialError && error.reason === "missing")
        return { ok: false, needs: "login", message };
      if (error instanceof WizarrPasskeyError) return { ok: false, needs: "passkey", message };
      if (error instanceof AppKeyError) return { ok: false, needs: "rejected", message };
      if (error instanceof CredentialError || error instanceof AppUnreachableError)
        return { ok: false, needs: "other", message };
      throw error;
    }
  }

  /** RomM's games, a page at a time, searched or filtered. */
  rommGames(
    serviceId: string,
    want: {
      search?: string;
      platformId?: number;
      genre?: string;
      favorites?: boolean;
      order?: RommOrder;
      offset?: number;
    },
    by?: "agent",
  ) {
    return this.rommRead(
      serviceId,
      "read the game library",
      by,
      () => {
        const d = sampleRomm();
        const needle = want.search?.trim().toLowerCase() ?? "";
        const all = [...d.recent, ...d.favorites].filter(
          (g, i, list) => list.findIndex((x) => x.id === g.id) === i,
        );
        const items = all
          .filter((g) => !needle || g.name.toLowerCase().includes(needle))
          .filter(
            (g) =>
              !want.platformId ||
              d.platforms.find((p) => p.id === want.platformId)?.slug === g.platformSlug,
          )
          .filter((g) => !want.favorites || g.favorite);
        return { total: items.length, items, genres: [] };
      },
      (f, base, cred) => rommGames(f, base, cred, want),
    );
  }

  /** One game's page in RomM. */
  rommGame(serviceId: string, romId: number, by?: "agent") {
    return this.rommRead<RommGameDetail>(
      serviceId,
      "read a game",
      by,
      () => {
        const g = sampleRomm().recent.find((x) => x.id === romId);
        if (!g) throw new NotFoundError("RomM has no such game.");
        return {
          ...g,
          summary: "A sample game: this is not your library.",
          genres: [],
          developers: [],
          publishers: [],
          franchises: [],
          languages: [],
          files: [{ name: `${g.name}.bin`, sizeBytes: 1_048_576 }],
          screenshots: 0,
          hasManual: false,
          path: `/rom/${g.id}`,
        };
      },
      (f, base, cred) => rommGame(f, base, cred, romId),
    );
  }

  /** A game's cover from RomM, passed through (never any other file). */
  rommCover(serviceId: string, romId: number, size: "small" | "large") {
    return this.rommRead(
      serviceId,
      "read a game's cover",
      undefined,
      () => undefined,
      (f, base, cred) => rommCover(f, base, cred, romId, size),
    );
  }

  /** One SABnzbd, its address and how to read it with its vault key (or sample data). */
  private async sabRead<T>(
    serviceId: string,
    purpose: string,
    by: "agent" | undefined,
    sample: () => T,
    read: (fetchImpl: Fetch, base: string, key: string) => Promise<T>,
    nzbget?: (
      fetchImpl: Fetch,
      base: string,
      login: { username: string; password: string },
    ) => Promise<T>,
  ): Promise<T> {
    const target = (await this.targets([serviceId]))[0];
    if (!target || (target.app !== "sabnzbd" && !(nzbget && target.app === "nzbget")))
      throw new NotFoundError("Not a watched SABnzbd or NZBGet.");
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:")) return sample();
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const base = service.localUrl;
    return this.broker.use(
      {
        serviceId: service.id,
        purpose: `${purpose} in ${service.name}`,
        access: "read",
        destination: base,
        ...(by ? { onBehalfOf: by } : {}),
      },
      ({ value, username }) =>
        target.app === "nzbget"
          ? nzbget!(this.fetchImpl ?? (fetch as unknown as Fetch), base, {
              username: username ?? "",
              password: value,
            })
          : read(this.fetchImpl ?? (fetch as unknown as Fetch), base, value),
    );
  }

  /** Paperless-ngx documents for its Documents tab: a search, the newest, or the trash. */
  async paperlessDocuments(
    serviceId: string,
    want: { query?: string; tagId?: number; page?: number; trash?: boolean },
    by?: "agent",
  ) {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "paperless")
      throw new NotFoundError("Not a watched Paperless-ngx.");
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:")) {
      const s = samplePaperless();
      return { total: want.trash ? 0 : s.inbox.length, items: want.trash ? [] : s.inbox };
    }
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const base = service.localUrl;
    return this.broker.use(
      {
        serviceId: service.id,
        purpose: `read the documents in ${service.name}`,
        access: "read",
        destination: base,
        ...(by ? { onBehalfOf: by } : {}),
      },
      ({ value }) =>
        paperlessDocuments(this.fetchImpl ?? (fetch as unknown as Fetch), base, value, want),
    );
  }

  /** Nextcloud's installed apps with their names and updates, for its Apps tab. */
  async nextcloudApps(serviceId: string, by?: "agent") {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "nextcloud") throw new NotFoundError("Not a watched Nextcloud.");
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:")) return sampleNextcloudApps();
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const base = service.localUrl;
    return this.broker.use(
      {
        serviceId: service.id,
        purpose: `read the apps in ${service.name}`,
        access: "read",
        destination: base,
        ...(by ? { onBehalfOf: by } : {}),
      },
      ({ value, username }) =>
        nextcloudApps(this.fetchImpl ?? (fetch as unknown as Fetch), base, {
          username: username ?? "",
          password: value,
        }),
    );
  }

  /** A SABnzbd job's files. */
  sabJobFiles(serviceId: string, nzoId: string, by?: "agent") {
    return this.sabRead(
      serviceId,
      "read a download's files",
      by,
      () => {
        const job = sampleSabnzbd().queue.find((j) => j.id === nzoId);
        if (!job) return [];
        const part = Math.round(((job.sizeMb ?? 1000) / 4) * 10) / 10;
        const done = Math.round((job.progressPct / 100) * 4);
        return Array.from({ length: 4 }, (_, i) => ({
          name: `${job.name}.part0${i + 1}.rar`,
          sizeMb: part,
          leftMb: i < done ? 0 : part,
          status: i < done ? "finished" : i === done ? "active" : "queued",
        }));
      },
      (f, base, key) => sabJobFiles(f, base, key, nzoId),
      (f, base, login) => nzbgetJobFiles(f, base, login, nzoId),
    );
  }

  /** SABnzbd's history, searched or filtered, a page at a time. */
  sabHistory(
    serviceId: string,
    want: { search?: string; failedOnly?: boolean; category?: string; start?: number },
    by?: "agent",
  ) {
    return this.sabRead(
      serviceId,
      "read the download history",
      by,
      () => {
        const needle = want.search?.trim().toLowerCase() ?? "";
        const items = sampleSabnzbd()
          .history.filter((h) => !needle || h.name.toLowerCase().includes(needle))
          .filter((h) => !want.failedOnly || h.failed)
          .filter((h) => !want.category || h.category === want.category);
        return { total: items.length, items };
      },
      (f, base, key) => sabHistory(f, base, key, want),
      (f, base, login) => nzbgetHistory(f, base, login, want),
    );
  }

  private torrentOpsCache?: TorrentOperations;
  private get torrentOps(): TorrentOperations {
    return (this.torrentOpsCache ??= new TorrentOperations(
      this.handle,
      this.broker,
      this.fetchImpl ?? (fetch as unknown as Fetch),
    ));
  }
  /** Sorting manual downloads: its view here, and the minute's pass (index.ts). */
  get sorter(): ManualSorter {
    return this.torrentOps.sorter;
  }

  /** A container's mounts (set by index.ts), so intake finds the real folders of an app's paths. */
  intakeMounts?: (container: string) => Promise<{ source: string; destination: string }[]>;
  private intakeCache?: AudiobookIntake;
  /** Audiobook intake: its view here, and the pass every two minutes (index.ts). */
  get intake(): AudiobookIntake {
    return (this.intakeCache ??= new AudiobookIntake(
      this.handle,
      this.broker,
      this.fetchImpl ?? (fetch as unknown as Fetch),
      {
        ...(this.intakeMounts ? { mounts: this.intakeMounts } : {}),
        qbSession: (s) => this.torrentOps.sessionFor(s),
      },
    ));
  }

  private healthCache?: DownloadHealth;
  /** Download Health: stuck and failing downloads across clients and apps (it changes nothing). */
  get health(): DownloadHealth {
    return (this.healthCache ??= new DownloadHealth(this.handle, (id) => this.dashboard(id)));
  }

  /** Audiobookshelf's Intake tab: the setup (or a ready one) and every release judged. */
  async audiobookIntake(serviceId: string, check = false) {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "audiobookshelf")
      throw new NotFoundError("Not a watched Audiobookshelf.");
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:"))
      throw new ConflictError("Sample data: there is no real Audiobookshelf to import into.");
    if (!service.localUrl) throw new ConflictError("Audiobookshelf has no address in Hearth.");
    if (check) await this.intake.tick(service.id);
    return this.intake.view({ id: service.id, name: service.name, localUrl: service.localUrl });
  }

  /** qBittorrent's Manual downloads tab: the setup (or a ready one), history and Unsorted. */
  async manualSort(serviceId: string, check = false) {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "qbittorrent")
      throw new NotFoundError("Not a watched qBittorrent.");
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:"))
      throw new ConflictError("Sample data: there is no real qBittorrent to sort.");
    if (!service.localUrl) throw new ConflictError("qBittorrent has no address in Hearth.");
    if (check) await this.sorter.tick();
    return this.sorter.view({ id: service.id, name: service.name, localUrl: service.localUrl });
  }

  /** qBittorrent's settings, categories, tags, and transfer state, read now through the broker. */
  /** AdGuard Home's query log (100 at a time) or why it blocks one domain: reads only. */
  private async adguardRead<T>(
    serviceId: string,
    what: string,
    read: (c: AdguardClient) => Promise<T>,
  ): Promise<T> {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "adguard") throw new NotFoundError("Not a watched AdGuard Home.");
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:"))
      throw new ConflictError("Sample data: there is no real AdGuard Home to read.");
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const base = service.localUrl;
    const fetchImpl = this.fetchImpl ?? (fetch as unknown as Fetch);
    return this.broker.use(
      {
        serviceId: service.id,
        purpose: `read ${service.name}'s ${what}`,
        access: "read",
        destination: base,
      },
      ({ value, username }) =>
        read(new AdguardClient(base, { username: username ?? "", password: value }, fetchImpl)),
    );
  }

  adguardQueries(serviceId: string, f: AdguardQueryFilter) {
    return this.adguardRead(serviceId, "query log", (c) => adguardQueries(c, f));
  }

  adguardCheck(serviceId: string, domain: string) {
    return this.adguardRead(serviceId, "rules for one domain", (c) => adguardCheck(c, domain));
  }

  /** Pi-hole's query log (100 at a time) or why it blocks one domain: reads, never changes. */
  async pihole<T>(
    serviceId: string,
    what: string,
    read: (s: PiholeSession) => Promise<T>,
    by?: "agent",
  ): Promise<T> {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "pihole") throw new NotFoundError("Not a watched Pi-hole.");
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:"))
      throw new ConflictError("Sample data: there is no real Pi-hole to read.");
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const base = service.localUrl;
    const fetchImpl = this.fetchImpl ?? (fetch as unknown as Fetch);
    return this.broker.use(
      {
        serviceId: service.id,
        purpose: `read ${service.name}'s ${what}`,
        access: "read",
        destination: base,
        ...(by ? { onBehalfOf: by } : {}),
      },
      async ({ value }) => read(await PiholeSession.open(base, value, fetchImpl)),
    );
  }

  piholeQueries(serviceId: string, f: QueryFilter) {
    return this.pihole(serviceId, "query log", (s) => piholeQueries(s, f));
  }

  piholeCheck(serviceId: string, domain: string) {
    return this.pihole(serviceId, "rules for one domain", (s) => piholeCheck(s, domain));
  }

  /** One Proxmox guest's snapshots (read when its row is opened). */
  async proxmoxSnapshots(serviceId: string, guest: string) {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "proxmox") throw new NotFoundError("Not a watched Proxmox.");
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:")) return [];
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const m = guest.match(/^(qemu|lxc)\/(\d{2,9})$/);
    if (!m) throw new ConflictError("Say which VM or container, as qemu/100 or lxc/200.");
    const base = service.localUrl;
    const fetchImpl = this.fetchImpl ?? localTlsFetch;
    return this.broker.use(
      {
        serviceId: service.id,
        purpose: `read ${service.name}'s snapshots`,
        access: "read",
        destination: base,
      },
      async ({ value }) => {
        const c = new ProxmoxClient(base, value, fetchImpl);
        const all = await c.call<{ id: string; node: string }[]>(
          "GET",
          "/cluster/resources?type=vm",
        );
        const g = all.find((x) => x.id === guest);
        if (!g) throw new NotFoundError(`${service.name} has no ${guest}.`);
        const snaps = await c.call<
          { name: string; snaptime?: number; description?: string; parent?: string }[]
        >("GET", `/nodes/${encodeURIComponent(g.node)}/${m[1]}/${m[2]}/snapshot`);
        return snaps
          .filter((s) => s.name !== "current")
          .map((s) => ({
            name: s.name,
            ...(s.snaptime ? { at: new Date(s.snaptime * 1000).toISOString() } : {}),
            ...(s.description ? { description: s.description.trim().slice(0, 200) } : {}),
          }));
      },
    );
  }

  /** Every Traefik's routers and where they forward (for "Open web UI" addresses). */
  async traefikProxySites(): Promise<{ site: string; upstream: string }[]> {
    const rows = (await this.handle.db.select().from(t.services)).filter(
      (s) =>
        s.lifecycle !== "removed" &&
        appOf(s) === "traefik" &&
        s.localUrl &&
        !s.checkTarget?.startsWith("demo:"),
    );
    const fetchImpl = this.fetchImpl ?? (fetch as unknown as Fetch);
    const lists = await Promise.all(
      rows.map((s) => traefikSites(fetchImpl, s.localUrl!).catch(() => [])),
    );
    return lists.flat();
  }

  /** Every Nginx Proxy Manager's sites and where they forward (for "Open web UI" addresses). */
  async npmProxySites(): Promise<{ site: string; upstream: string }[]> {
    const rows = (await this.handle.db.select().from(t.services)).filter(
      (s) =>
        s.lifecycle !== "removed" &&
        appOf(s) === "npm" &&
        s.localUrl &&
        !s.checkTarget?.startsWith("demo:"),
    );
    const fetchImpl = this.fetchImpl ?? (fetch as unknown as Fetch);
    const lists = await Promise.all(
      rows.map((s) =>
        this.broker
          .use(
            {
              serviceId: s.id,
              purpose: `read ${s.name}'s sites for web addresses`,
              access: "read",
              destination: s.localUrl!,
            },
            ({ value, username }) =>
              npmSites(
                new NpmClient(
                  s.localUrl!,
                  { username: username ?? "", password: value },
                  fetchImpl,
                ),
              ),
          )
          .catch(() => []),
      ),
    );
    return lists.flat();
  }

  async qbtSettings(serviceId: string, by?: "agent") {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "qbittorrent")
      throw new NotFoundError("Not a watched qBittorrent.");
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:"))
      throw new ConflictError("Sample data: there is no real qBittorrent to read.");
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const base = service.localUrl;
    this.live ??= new QbittorrentLive(this.fetchImpl ?? (fetch as unknown as Fetch));
    return this.broker.use(
      {
        serviceId: service.id,
        purpose: `read ${service.name}'s settings`,
        access: "read",
        destination: base,
        ...(by ? { onBehalfOf: by } : {}),
      },
      ({ value, username }) =>
        this.live!.settings(service.id, base, { username: username ?? "", password: value }),
    );
  }

  /** Deluge's Settings tab: its speed, queue and seeding settings, labels, default folder. */
  async transmissionSettings(serviceId: string, by?: "agent") {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "transmission")
      throw new NotFoundError("Not a watched Transmission.");
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:"))
      throw new ConflictError("Sample data: there is no real Transmission to read.");
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const base = service.localUrl;
    this.transmission ??= new TransmissionLive(this.fetchImpl ?? (fetch as unknown as Fetch));
    return this.broker.use(
      {
        serviceId: service.id,
        purpose: `read ${service.name}'s settings`,
        access: "read",
        destination: base,
        ...(by ? { onBehalfOf: by } : {}),
      },
      ({ value, username }) =>
        this.transmission!.settings(service.id, base, {
          username: username ?? "",
          password: value,
        }),
    );
  }

  async delugeSettings(serviceId: string, by?: "agent") {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "deluge") throw new NotFoundError("Not a watched Deluge.");
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:"))
      throw new ConflictError("Sample data: there is no real Deluge to read.");
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const base = service.localUrl;
    this.deluge ??= new DelugeLive(this.fetchImpl ?? (fetch as unknown as Fetch));
    return this.broker.use(
      {
        serviceId: service.id,
        purpose: `read ${service.name}'s settings`,
        access: "read",
        destination: base,
        ...(by ? { onBehalfOf: by } : {}),
      },
      ({ value }) => this.deluge!.settings(service.id, base, value),
    );
  }

  /**
   * What the owner selected inside a service, read fresh for Ember (audited as the AI's
   * read). Only the item's identity came from the browser; if it no longer exists, it says so.
   */
  async selectedItem(
    serviceId: string,
    item: CaveItem,
  ): Promise<{ text: string; label: string } | undefined> {
    if (item.kind === "plex-session") return this.selectedStream(serviceId, item.id);
    if (item.kind !== "torrent") return undefined;
    const board = await this.dashboard(serviceId, "agent");
    const qb = board.data?.app === "qbittorrent" ? board.data : undefined;
    if (board.error) {
      return {
        label: "Selected torrent (could not be read)",
        text: `The owner selected a torrent (hash ${item.id}) in this qBittorrent, but it could not be read just now: ${board.error.message}`,
      };
    }
    const tor = qb?.torrents.find((x) => x.hash === item.id.toLowerCase());
    if (!tor) {
      return {
        label: "Selected torrent (gone)",
        text: `The owner selected a torrent (hash ${item.id}) that qBittorrent no longer has (read just now): it was removed or finished and cleared.`,
      };
    }
    const detail = await this.torrentDetail(serviceId, tor.hash, "agent").catch(() => undefined);
    const sp = (b: number) =>
      b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB/s` : `${Math.round(b / 1024)} KB/s`;
    const gb = (b: number) => `${(b / 1024 ** 3).toFixed(2)} GB`;
    const parts = [
      `status ${tor.status} (qBittorrent state ${tor.state})`,
      `${tor.progressPct}% of ${gb(tor.sizeBytes)} (${gb(tor.leftBytes)} left)`,
      `down ${sp(tor.downSpeed)}, up ${sp(tor.upSpeed)}`,
      `seeds ${tor.seedsConnected} connected of ${tor.seedsInSwarm} in the swarm, leechers ${tor.leechersConnected} of ${tor.leechersInSwarm}`,
      ...(tor.availability !== undefined ? [`availability ${tor.availability} copies`] : []),
      ...(tor.lastSeenComplete ? [`last complete copy seen ${tor.lastSeenComplete}`] : []),
      ...(tor.etaSec ? [`about ${Math.round(tor.etaSec / 60)} min left`] : []),
      ...(tor.queuePosition ? [`queue position ${tor.queuePosition}`] : []),
      ...(tor.category ? [`category ${tor.category}`] : []),
      ...(tor.addedAt ? [`added ${tor.addedAt}`] : []),
      ...(detail
        ? [
            `trackers: ${detail.trackers.map((tr) => `${tr.host} ${tr.status}${tr.message ? ` ("${tr.message}")` : ""}${tr.seeds !== undefined ? `, ${tr.seeds} seeds` : ""}`).join("; ") || "none"}`,
            `pieces ${detail.piecesHave ?? "?"} of ${detail.piecesTotal ?? "?"}`,
          ]
        : []),
    ];
    const vpn = qb?.vpn;
    return {
      label: `Selected torrent: ${tor.name} (read just now)`,
      text: `The owner selected the torrent "${tor.name}" (hash ${tor.hash}) in qBittorrent and is asking about it: "this", "that", or "it" means this torrent. Read from qBittorrent just now: ${parts.join("; ")}.${tor.problem ? ` Hearth's reading: ${tor.problem}` : ""} qBittorrent's connection: ${qb?.connection}.${vpn ? ` The VPN it depends on (${vpn.name}) is ${vpn.health} by Hearth's monitoring.` : ""} You can re-read it with the qbittorrent tool (serviceId and this hash); you cannot change it yourself, but you can propose a plan (resume, pause, reannounce, or recheck this one torrent, by this hash) that the owner approves.`,
    };
  }

  /** A Plex stream the owner selected, read fresh. */
  private async selectedStream(
    serviceId: string,
    sessionId: string,
  ): Promise<{ text: string; label: string }> {
    const board = await this.dashboard(serviceId, "agent");
    const plex = board.data?.app === "plex" ? board.data : undefined;
    if (!plex) {
      return {
        label: "Selected stream (could not be read)",
        text: `The owner selected a Plex stream (session ${sessionId}), but Plex could not be read just now: ${board.error?.message ?? "no answer"}.`,
      };
    }
    const s = plex.sessions.find((x) => x.sessionId === sessionId);
    if (!s) {
      return {
        label: "Selected stream (ended)",
        text: `The owner selected a Plex stream (session ${sessionId}) that has ended (read just now): nobody is playing it any more.`,
      };
    }
    const what = s.show
      ? `${s.show} S${s.season}E${s.episode} "${s.title}"`
      : `"${s.title}"${s.year ? ` (${s.year})` : ""}`;
    const parts = [
      `${s.user} on ${s.player}${s.device ? ` (${s.device}, ${s.platform ?? "?"})` : ""}, ${s.local === false ? "remote" : s.local ? "on the home network" : "location unknown"}`,
      `state ${s.state}, ${s.progressPct}% watched`,
      `${s.decision}${s.videoDecision ? ` (video ${s.videoDecision}, audio ${s.audioDecision ?? "?"})` : ""}`,
      ...(s.resolution ? [`source ${s.resolution}`] : []),
      ...(s.bitrateKbps ? [`source bitrate ${(s.bitrateKbps / 1000).toFixed(1)} Mbps`] : []),
      ...(s.bandwidthKbps ? [`stream bandwidth ${(s.bandwidthKbps / 1000).toFixed(1)} Mbps`] : []),
      ...(s.transcodeSpeed !== undefined
        ? [
            `transcoder speed ${s.transcodeSpeed}x (${s.hardwareTranscode ? "hardware" : "software"})`,
          ]
        : []),
      `${plex.sessions.length} streams in total, ${plex.sessions.filter((x) => x.decision === "transcode").length} transcoding`,
    ];
    return {
      label: `Selected stream: ${s.user} watching ${s.title} (read just now)`,
      text: `The owner selected the Plex stream of ${what} and is asking about it: "this", "that", or "it" means this stream. Read from Plex just now: ${parts.join("; ")}.${s.problem ? ` Hearth's reading: ${s.problem}` : ""} The plex tool re-reads all streams. Stopping a stream is not an operation yet; say so if asked.`,
    };
  }

  /** The VPN a service depends on, as Hearth's monitoring sees it (no configuration). */
  private async vpnOf(serviceId: string) {
    const deps = await this.handle.db
      .select({
        id: t.services.id,
        name: t.services.name,
        health: t.services.health,
        image: t.services.image,
        category: t.services.category,
      })
      .from(t.serviceDependencies)
      .innerJoin(t.services, eq(t.services.id, t.serviceDependencies.dependsOnId))
      .where(eq(t.serviceDependencies.serviceId, serviceId));
    const vpn = deps.find((d) =>
      /gluetun|vpn|wireguard|openvpn/i.test(`${d.image ?? ""} ${d.name} ${d.category}`),
    );
    if (!vpn) return undefined;
    const check = await this.handle.db
      .select()
      .from(t.checkState)
      .where(eq(t.checkState.serviceId, vpn.id))
      .get();
    return {
      serviceId: vpn.id,
      name: vpn.name,
      health: vpn.health,
      ...(check?.detail ? { detail: check.detail } : {}),
    };
  }

  /**
   * One deeper read of Home Assistant for Ember (entities, devices, the
   * error log...), through the broker like every other use of its token. Read
   * only: homeassistant.ts can only make the reads it lists.
   */
  async homeAssistant(
    serviceId: string,
    q: HaQuery,
    /** Who asked: Ember, or the owner from the panel (the audit says which). */
    by: "agent" | "you" = "agent",
  ): Promise<unknown> {
    const target = (await this.targets([serviceId]))[0];
    if (!target || target.app !== "homeassistant") {
      return { note: "That is not a watched Home Assistant service." };
    }
    const { service } = target;
    if (service.checkTarget?.startsWith("demo:")) {
      return { note: "Sample data has no Home Assistant to read." };
    }
    if (!service.localUrl) return { note: `Hearth does not know ${service.name}'s address.` };
    const key = await this.keyFor(service, "homeassistant");
    if (!key.id) return { note: key.problem };
    const base = service.localUrl;
    const fetchImpl = this.fetchImpl ?? (fetch as unknown as Fetch);
    return this.broker.use(
      {
        serviceId: service.id,
        purpose: `read Home Assistant's ${q.section.replace("_", " ")}`,
        access: "read",
        destination: base,
        onBehalfOf: by,
      },
      ({ value }) => readHomeAssistantSection(base, value, fetchImpl, q, this.socket),
    );
  }

  /**
   * The home dashboard's Home Assistant (homeassistant-home.ts): the one asked for, or the first
   * watched one. Its token is used through the broker for each read and each tap.
   */
  private async homeTarget(serviceId?: string) {
    const all = (await this.targets()).filter((x) => x.app === "homeassistant");
    // Without one named (a paired home tablet): the first Home Assistant Hearth has a token for.
    let target = serviceId ? all.find((x) => x.service.id === serviceId) : undefined;
    if (!serviceId)
      for (const x of all)
        if (await this.broker.has(x.service.id).catch(() => false)) {
          target = x;
          break;
        }
    target ??= serviceId ? undefined : all[0];
    if (!target) throw new NotFoundError("Hearth is not watching a Home Assistant yet.");
    const { service } = target;
    if (!service.localUrl)
      throw new ConflictError(`Hearth does not know ${service.name}'s address.`);
    const fetchImpl = this.fetchImpl ?? (fetch as unknown as Fetch);
    const socket: SocketFactory =
      this.socket ??
      ((url) =>
        new (globalThis as unknown as { WebSocket: new (u: string) => SocketLike }).WebSocket(url));
    const use = <T>(
      purpose: string,
      access: "read" | "change",
      by: "agent" | "you",
      fn: (token: string) => Promise<T>,
    ) =>
      this.broker.use(
        {
          serviceId: service.id,
          purpose,
          access,
          destination: service.localUrl!,
          ...(by === "you" && access === "change" ? { onBehalfOf: "you" as const } : {}),
        },
        ({ value }) => fn(value),
      );
    return { service, base: service.localUrl, fetchImpl, socket, use };
  }

  /** Everything the home dashboard shows (and the devices a Devices widget asked for). */
  async homeView(serviceId?: string, opts: { watch?: string[]; catalog?: boolean } = {}) {
    const h = await this.homeTarget(serviceId);
    const view = await h.use("read Home Assistant for the home dashboard", "read", "you", (token) =>
      readHome(h.fetchImpl, h.base, token, h.socket, opts),
    );
    // The owner's own speaker names (11-13): the same name in every picker, Ember included.
    const names = (await getSetting(this.handle.db, "speaker_names")) ?? {};
    const music = view.music.map((m) =>
      names[m.entity] ? { ...m, name: names[m.entity]!, renamed: true as const } : m,
    );
    return {
      serviceId: h.service.id,
      serviceName: h.service.name,
      ...view,
      music,
      ...(await this.homeWeather(h, view)),
    };
  }

  /** Renames a speaker in Hearth, or (no name) goes back to its own name. */
  async renameSpeaker(entity: string, name: string | undefined) {
    const names = { ...((await getSetting(this.handle.db, "speaker_names")) ?? {}) };
    const before = names[entity];
    const clean = name?.replace(/\s+/g, " ").trim().slice(0, 60);
    if (clean) names[entity] = clean;
    else delete names[entity];
    await setSetting(this.handle.db, "speaker_names", names);
    await recordAudit(this.handle.db, {
      actor: "you",
      action: clean
        ? `Renamed the speaker ${before ?? entity} to ${clean}`
        : `Reset the name of the speaker ${before ?? entity}`,
      target: `speaker:${entity}`,
    });
    return { entity, ...(clean ? { name: clean } : {}) };
  }

  private homeCoordsCache = new Map<string, { at: number; value?: { lat: number; lon: number } }>();

  /**
   * The weather from the National Weather Service (US) or Open-Meteo, at the places chosen
   * or else the home; Home Assistant's own weather stays when that is chosen or they fail.
   */
  private async homeWeather(
    h: Awaited<ReturnType<AppWatcher["homeTarget"]>>,
    view: HomeView,
  ): Promise<Pick<HomeView, "weather" | "cities">> {
    const ha = view.weather
      ? { weather: { ...view.weather, sourceName: "Home Assistant", placeName: view.place.name } }
      : {};
    const pick = (await getSetting(this.handle.db, "home_weather")) ?? {
      source: "auto" as const,
      places: [],
    };
    if (pick.source === "homeassistant") return ha;
    const fetchImpl = this.fetchImpl ?? (fetch as unknown as Fetch);
    const unit = /F/.test(view.place.tempUnit) ? "°F" : "°C";
    let main: { lat: number; lon: number; label?: string } | undefined = pick.places[0];
    if (!main) {
      const kept = this.homeCoordsCache.get(h.service.id);
      if (kept && Date.now() - kept.at < 60 * 60_000) main = kept.value;
      else {
        main = await h
          .use("read the home's location for the weather", "read", "you", (token) =>
            homeCoords(h.fetchImpl, h.base, token),
          )
          .catch(() => undefined);
        this.homeCoordsCache.set(h.service.id, { at: Date.now(), value: main });
      }
    }
    const [report, ...more] = await Promise.all([
      main ? weatherAt(fetchImpl, main, unit).catch(() => undefined) : undefined,
      ...pick.places.slice(1, 6).map((p) => weatherAt(fetchImpl, p, unit).catch(() => undefined)),
    ]);
    const cities = more.flatMap((r, i) =>
      r
        ? [
            {
              label: pick.places[i + 1]!.label,
              condition: r.condition,
              ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
              ...(r.forecast[0]?.high !== undefined ? { high: r.forecast[0].high } : {}),
              ...(r.forecast[0]?.low !== undefined ? { low: r.forecast[0].low } : {}),
              unit: r.unit,
            },
          ]
        : [],
    );
    if (!report) return { ...ha, ...(cities.length ? { cities } : {}) };
    const { source: _s, sourceName, place, ...w } = report;
    return {
      weather: {
        entity: view.weather?.entity ?? "",
        name: sourceName,
        ...w,
        sourceName,
        placeName: place,
      },
      ...(cities.length ? { cities } : {}),
    };
  }

  /** The weather's places and source (Settings in the weather window). */
  async homeWeatherPlaces() {
    return (
      (await getSetting(this.handle.db, "home_weather")) ?? {
        source: "auto" as const,
        places: [],
      }
    );
  }

  async setHomeWeatherPlaces(v: {
    source: "auto" | "homeassistant";
    places: { label: string; lat: number; lon: number }[];
  }) {
    await setSetting(this.handle.db, "home_weather", v);
    await recordAudit(this.handle.db, {
      actor: "you",
      action: `Home dashboard: weather set to ${v.source === "homeassistant" ? "Home Assistant's" : v.places.map((p) => p.label).join(", ") || "the home"}`,
      target: "settings",
    });
    return v;
  }

  /** Places for the weather by town or ZIP code. */
  async findWeatherPlaces(q: string) {
    return { places: await findPlaces(this.fetchImpl ?? (fetch as unknown as Fetch), q) };
  }

  /** The calendar page: every calendar's events between two dates. */
  async homeCalendar(serviceId: string | undefined, start: string, end: string) {
    const h = await this.homeTarget(serviceId);
    return this.musicErrors(() =>
      h.use("read the calendars for the home dashboard", "read", "you", (token) =>
        calendarRange(h.fetchImpl, h.base, token, start, end),
      ),
    );
  }

  /** Adds, changes or deletes an event (written to the calendar's own service). */
  async homeCalendarChange(
    serviceId: string | undefined,
    c:
      | ({ action: "add" } & EventInput)
      | ({ action: "change"; uid: string; recurrenceId?: string } & EventInput)
      | { action: "delete"; entity: string; uid: string; recurrenceId?: string; title?: string },
    who: "you" | "home tablet",
  ) {
    const h = await this.homeTarget(serviceId);
    const r = await this.musicErrors(() =>
      h.use(
        `${c.action} a calendar event from the home dashboard`,
        "change",
        "you",
        async (token) => {
          if (c.action === "add") return calendarCreate(h.fetchImpl, h.base, token, c);
          if (c.action === "delete") return calendarDelete(h.socket, h.base, token, c);
          const { calendars } = await calendarRange(
            h.fetchImpl,
            h.base,
            token,
            new Date().toISOString(),
            new Date().toISOString(),
          );
          const canUpdate = Boolean(calendars.find((x) => x.entity === c.entity)?.can.update);
          return calendarUpdate(h.fetchImpl, h.socket, h.base, token, { ...c, canUpdate });
        },
      ),
    );
    await recordAudit(this.handle.db, {
      actor: "you",
      action: `Home dashboard${who === "home tablet" ? " (home tablet)" : ""}: ${c.action === "add" ? "added" : c.action === "change" ? "changed" : "deleted"} the event "${(c.title ?? "").slice(0, 80)}" on ${c.entity}`,
      target: `service:${h.service.id}`,
    });
    return r;
  }

  /** A scene to view or change, or (with none named) what a new one can use. */
  async homeScene(serviceId: string | undefined, entity?: string) {
    const h = await this.homeTarget(serviceId);
    return this.musicErrors(() =>
      h.use("read a scene for the home dashboard", "read", "you", (token) =>
        sceneRead(h.fetchImpl, h.socket, h.base, token, entity),
      ),
    );
  }

  /** Saves (changes or adds) or deletes a scene in Home Assistant. */
  async homeSceneChange(
    serviceId: string | undefined,
    c: ({ action: "save" } & SceneSave) | { action: "delete"; entity: string },
    who: "you" | "home tablet",
  ) {
    const h = await this.homeTarget(serviceId);
    const r = await this.musicErrors(() =>
      h.use(`${c.action} a scene from the home dashboard`, "change", "you", (token) =>
        c.action === "delete"
          ? sceneDelete(h.fetchImpl, h.socket, h.base, token, c.entity)
          : sceneSave(h.fetchImpl, h.socket, h.base, token, c),
      ),
    );
    const what =
      c.action === "delete"
        ? `deleted the scene ${c.entity}`
        : `${c.entity ? "changed" : "added"} the scene "${c.name.slice(0, 80)}"`;
    await recordAudit(this.handle.db, {
      actor: "you",
      action: `Home dashboard${who === "home tablet" ? " (home tablet)" : ""}: ${what}`,
      target: `service:${h.service.id}`,
    });
    return r;
  }

  /** The Media page's music library: search (YouTube Music and the rest, through Music Assistant). */
  async homeMusicSearch(serviceId: string | undefined, query: string) {
    const h = await this.homeTarget(serviceId);
    return this.musicErrors(() =>
      h.use("search music for the home dashboard", "read", "you", (token) =>
        musicSearch(h.fetchImpl, h.base, token, query),
      ),
    );
  }

  /** One shelf of the music library: playlists, albums, artists, songs or recently played. */
  async homeMusicLibrary(serviceId: string | undefined, shelf: MusicShelf) {
    const h = await this.homeTarget(serviceId);
    return this.musicErrors(() =>
      h.use("read the music library for the home dashboard", "read", "you", (token) =>
        musicLibrary(h.fetchImpl, h.base, token, shelf),
      ),
    ).then((items) => ({ items }));
  }

  /** Plays a song, album, artist or playlist on a Music Assistant speaker (or starts a mix). */
  async homeMusicPlay(
    serviceId: string | undefined,
    p: {
      entity: string;
      uri: string;
      kind: MusicKind;
      how: MusicHow;
      name?: string;
      more?: string[];
    },
    who: "you" | "home tablet",
  ) {
    const h = await this.homeTarget(serviceId);
    const r = await this.musicErrors(() =>
      h.use(`play music on ${p.entity} from the home dashboard`, "change", "you", (token) =>
        musicPlay(h.fetchImpl, h.base, token, p),
      ),
    );
    await recordAudit(this.handle.db, {
      actor: "you",
      action: `Home dashboard${who === "home tablet" ? " (home tablet)" : ""}: ${r.done.toLowerCase()} ${p.name ? `"${p.name.slice(0, 80)}" ` : ""}on ${p.entity}`,
      target: `service:${h.service.id}`,
    });
    return r;
  }

  /** Watch on TV: the song's music video on a Google Cast TV, through Home Assistant. */
  async homeVideoOnTv(
    serviceId: string | undefined,
    p: { tv: string; videoId: string; pause?: string },
    who: "you" | "home tablet",
  ) {
    const h = await this.homeTarget(serviceId);
    const r = await this.musicErrors(() =>
      h.use(`play a music video on ${p.tv} from the home dashboard`, "change", "you", (token) =>
        videoOnTv(h.fetchImpl, h.base, token, h.socket, p),
      ),
    );
    await recordAudit(this.handle.db, {
      actor: "you",
      action: `Home dashboard${who === "home tablet" ? " (home tablet)" : ""}: played a music video on ${p.tv}`,
      target: `service:${h.service.id}`,
    });
    return r;
  }

  /** The Music Assistant Hearth holds a key for (made when the owner linked it from Hearth). */
  private async musicAssistant() {
    const rows = await this.handle.db.select().from(t.services);
    for (const svc of rows.filter(
      // A Music Assistant removed from Hearth is not linked any more (11-12).
      (x) =>
        x.localUrl &&
        x.lifecycle !== "removed" &&
        /music[\s-]?assistant/i.test(`${x.name} ${x.image ?? ""}`),
    ))
      if (await this.broker.has(svc.id).catch(() => false)) {
        const address = new URL(svc.localUrl!).origin;
        const fetchImpl = (this.fetchImpl ?? fetch) as unknown as typeof fetch;
        const send = <T>(
          command: string,
          args: Record<string, unknown>,
          access: "read" | "change",
          why?: string,
        ) =>
          this.broker.use(
            {
              serviceId: svc.id,
              purpose:
                access === "read"
                  ? `read Music Assistant (${command}) for the home dashboard`
                  : `${why ?? "add a music service in Music Assistant"} (${command}); the owner asked`,
              access,
              destination: `${address}/api`,
              ...(access === "change" ? { onBehalfOf: "you" as const } : {}),
            },
            async ({ value }) => {
              const res = await fetchImpl(`${address}/api`, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${value}` },
                body: JSON.stringify({ message_id: command, command, args }),
                signal: AbortSignal.timeout(60_000),
              });
              const text = await res.text();
              if (!res.ok)
                throw new ConflictError(
                  `Music Assistant answered ${res.status}: ${text.replaceAll(value, "[hidden]").slice(0, 160)}`,
                );
              return JSON.parse(text) as T;
            },
          );
        const call = <T>(command: string, args: Record<string, unknown> = {}) =>
          send<T>(command, args, "read");
        /** For the owner's own changes (adding a music service). */
        const change = <T>(command: string, args: Record<string, unknown> = {}) =>
          send<T>(command, args, "change");
        /** A change the owner made on the music card (like a song, play from Up Next). */
        const act = <T>(why: string, command: string, args: Record<string, unknown> = {}) =>
          send<T>(command, args, "change", why);
        return { service: svc, address, call, change, act, fetchImpl };
      }
    return undefined;
  }

  /** Add a music service: what Music Assistant offers, each marked when already added. */
  async musicServiceList() {
    const ma = await this.musicAssistant();
    if (!ma) return { linked: false, services: [] };
    return { linked: true, services: await musicServices(ma.call) };
  }

  /** A step of adding a music service: start, answer a form, see where it is, or stop. */
  async musicServiceStep(
    c:
      | { action: "start"; domain: string }
      | { action: "submit"; flowId: string; values: Record<string, string | number | boolean> }
      | { action: "get"; flowId: string }
      | { action: "abort"; flowId: string },
  ) {
    const ma = await this.musicAssistant();
    if (!ma)
      throw new ConflictError(
        "Link Music Assistant from Hearth first (the music card, Connect, Music Assistant).",
      );
    const step =
      c.action === "start"
        ? await serviceStart(ma.change, c.domain)
        : c.action === "submit"
          ? await serviceSubmit(ma.change, c.flowId, c.values)
          : c.action === "get"
            ? await serviceStep(ma.call, c.flowId)
            : (await serviceAbort(ma.change, c.flowId),
              { stepId: "abort", type: "abort" as const, fields: [], errors: {} });
    if (step.type === "finish") {
      this.youtubeRowsCache = undefined;
      await recordAudit(this.handle.db, {
        actor: "you",
        action: `Music Assistant: added a music service${c.action === "start" ? ` (${c.domain})` : ""} from Hearth`,
        target: "music-assistant",
      });
    }
    return step;
  }

  /** Whether this Hearth can make a page a Music Assistant speaker (it holds the key). */
  async speakerReady() {
    return { linked: Boolean(await this.musicAssistant()) };
  }

  /** Music Assistant's Sendspin connection for a browser speaker (apps/speaker-relay.ts). */
  async speakerUpstream(): Promise<SpeakerUpstream | null> {
    const ma = await this.musicAssistant();
    if (!ma) return null;
    const ws = `${ma.address.replace(/^http/, "ws")}/sendspin`;
    return {
      url: ws,
      signIn: (send) =>
        this.broker.use(
          {
            serviceId: ma.service.id,
            purpose: "connect a speaker (a Hearth page) to Music Assistant",
            access: "read",
            // The key's own address (the socket is the same host, ws:// instead of http://).
            destination: `${ma.address}/sendspin`,
          },
          async ({ value }) => send(value),
        ),
    };
  }

  /**
   * After the owner linked Music Assistant from Hearth: Hearth keeps a key of its own (a
   * long-lived Music Assistant token named Hearth) so the Media page can show the home rows and
   * open playlists. Adds Music Assistant to Hearth when it is not there yet.
   */
  async keepMusicAssistantKey(address: string, sessionToken: string) {
    const fetchImpl = fetch;
    const origin = new URL(address).origin;
    const res = await fetchImpl(`${origin}/api`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({
        message_id: "hearth-key",
        command: "auth/token/create",
        args: { name: "Hearth" },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { kept: false };
    const key = (await res.json().catch(() => undefined)) as unknown;
    if (typeof key !== "string" || key.length < 10) return { kept: false };
    const rows = await this.handle.db.select().from(t.services);
    let svc = rows.find(
      (x) =>
        (x.localUrl && new URL(x.localUrl).origin === origin) ||
        /music[\s-]?assistant/i.test(`${x.name} ${x.image ?? ""}`),
    );
    if (!svc) {
      const made = await addManualService(this.handle, {
        name: "Music Assistant",
        kind: "web",
        address: origin,
        category: "Media",
      });
      svc = (await this.handle.db.select().from(t.services)).find((x) => x.id === made.id);
    }
    if (!svc) return { kept: false };
    await this.broker.storeGenerated({
      serviceId: svc.id,
      kind: "api-key",
      value: key,
      workflow: "Music Assistant linked by the owner from the home dashboard",
      scope: "approved-changes",
    });
    return { kept: true, serviceId: svc.id };
  }

  /**
   * The Media page's rows: YouTube Music's own home page (Quick picks and every other row, in
   * its order) when Hearth has the YouTube sign-in, else Music Assistant's few; then the
   * library's.
   */
  async homeMusicHome() {
    const ma = await this.musicAssistant();
    if (!ma) return { rows: [], linked: false };
    // 11-06 ("where's the rows"): when YouTube Music can't be read, say why instead of
    // quietly showing Music Assistant's few rows.
    let youtubeError: string | undefined;
    const own = await this.youtubeHomeRows(ma.call).catch((e: unknown) => {
      youtubeError = e instanceof Error ? e.message : String(e);
      console.warn(`[youtube-music] home rows: ${youtubeError}`);
      return undefined;
    });
    return {
      rows: await musicHomeRows(ma.call, 16, own),
      linked: true,
      youtube: Boolean(await this.youtubeService()),
      ...(youtubeError ? { youtubeError: youtubeError.slice(0, 300) } : {}),
    };
  }

  private youtubeRowsCache?: { at: number; key: string; rows: MusicRow[] };
  /** The last Speed dial and Quick picks YouTube sent, for when it leaves them out. */
  private youtubeKept?: { key: string; rows: Record<string, MusicRow> };

  /** YouTube Music's home rows with the sign-in Hearth keeps (5 minutes kept). */
  private async youtubeHomeRows(call: MaCall): Promise<MusicRow[] | undefined> {
    const svc = await this.youtubeService();
    if (!svc) return undefined;
    const providers = await call<{ instance_id?: string; enabled?: boolean }[]>(
      "config/providers",
      { provider_domain: "ytmusic" },
    ).catch(() => []);
    const provider = (Array.isArray(providers) ? providers : []).find(
      (p) => p.instance_id && p.enabled !== false,
    )?.instance_id;
    if (!provider || !/^[\w-]{3,80}$/.test(provider))
      throw new Error("Music Assistant has no YouTube Music provider turned on.");
    const kept = this.youtubeRowsCache;
    if (kept && kept.key === `${svc.id}:${provider}` && Date.now() - kept.at < 5 * 60_000)
      return kept.rows;
    const rows = await this.broker.use(
      {
        serviceId: svc.id,
        purpose: "read YouTube Music's home rows for the Media page",
        access: "read",
        destination: "https://music.youtube.com",
      },
      ({ value, username }) =>
        youtubeHome(
          this.fetchImpl ?? (fetch as unknown as Fetch),
          {
            cookie: value,
            ...(username && /^\d{10,30}$/.test(username) ? { channel: username } : {}),
          },
          provider,
        ),
    );
    if (!rows.length)
      throw new Error("YouTube Music answered, but its home page had no rows Hearth could read.");
    const out: MusicRow[] = rows.map((r, i) => ({
      id: `youtube:${i}:${r.title}`,
      title: r.title,
      items: r.items,
      service: "YouTube Music",
    }));
    // YouTube's website shuffles its home rows on every load (11-06: "it changes every
    // time"); Speed dial and Quick picks are kept from the last time they came, so they stay.
    const key = `${svc.id}:${provider}`;
    const keep = this.youtubeKept?.key === key ? this.youtubeKept.rows : {};
    for (const name of ["Speed dial", "Quick picks"]) {
      const row = out.find((r) => r.title === name);
      if (row) keep[name] = row;
      else if (keep[name]) out.splice(name === "Speed dial" ? 0 : 1, 0, keep[name]!);
    }
    this.youtubeKept = { key, rows: keep };
    this.youtubeRowsCache = { at: Date.now(), key, rows: out };
    return out;
  }

  /** The YouTube Music sign-in Hearth keeps (a service of its own, so it never mixes with Music Assistant's key). */
  private async youtubeService() {
    const rows = await this.handle.db.select().from(t.services);
    for (const s of rows)
      if (
        s.localUrl &&
        new URL(s.localUrl).origin === "https://music.youtube.com" &&
        (await this.broker.has(s.id).catch(() => false))
      )
        return s;
    return undefined;
  }

  /**
   * Keeps the YouTube Music sign-in from Hearth's music setup in Secure Vault (in place of an
   * older one), with the channel it plays as, for the Media page's YouTube Music rows.
   */
  async keepYoutubeSignIn(cookie: string, channel?: string) {
    const rows = await this.handle.db.select().from(t.services);
    let svc = rows.find(
      (s) => s.localUrl && new URL(s.localUrl).origin === "https://music.youtube.com",
    );
    if (!svc) {
      const made = await addManualService(this.handle, {
        name: "YouTube Music",
        kind: "web",
        address: "https://music.youtube.com",
        category: "Media",
      });
      svc = (await this.handle.db.select().from(t.services)).find((x) => x.id === made.id);
    }
    if (!svc) return { kept: false };
    const old = await this.handle.db
      .select({ id: t.vaultSecrets.id })
      .from(t.vaultSecrets)
      .where(eq(t.vaultSecrets.serviceId, svc.id));
    for (const o of old) await this.vault.removeInternal(o.id);
    await this.broker.storeGenerated({
      serviceId: svc.id,
      kind: "token",
      value: cookie,
      ...(channel ? { username: channel } : {}),
      workflow: "YouTube Music signed in by the owner in Hearth's music setup",
    });
    this.youtubeRowsCache = undefined;
    return { kept: true };
  }

  /** For Change YouTube account: Music Assistant's address and the key Hearth keeps for it. */
  async musicAssistantKeyForSetup(): Promise<{ address: string; key: string } | undefined> {
    const ma = await this.musicAssistant();
    if (!ma) return undefined;
    return this.broker.use(
      {
        serviceId: ma.service.id,
        purpose: "change the YouTube Music account in Music Assistant (the owner asked)",
        access: "change",
        destination: `${ma.address}/api`,
        onBehalfOf: "you",
      },
      async ({ value }) => ({ address: ma.address, key: value }),
    );
  }

  /** Inside a playlist, an album or an artist. */
  /** Up Next for a speaker, from its Music Assistant queue (or none: not a Music Assistant one). */
  async homeMusicQueue(speaker: { queue?: string; name: string }) {
    const ma = await this.musicAssistant();
    if (!ma) return { linked: false as const };
    const queue = await this.musicErrors(() => musicQueue(ma.call, speaker));
    return { linked: true as const, ...(queue ? { queue } : {}) };
  }

  /**
   * The music card's changes in Music Assistant (11-11): play a song from Up Next, like the song
   * (saved in the library and favorites: YouTube Music's like when it comes from there), or take
   * the like back. Music Assistant has no dislike, so "Not for me" is the like taken back and the
   * next song (the card skips through Home Assistant).
   */
  async homeMusicQueueAction(
    a:
      | { action: "play"; queueId: string; itemId: string }
      | { action: "like" | "unlike"; uri: string },
    who: "you" | "home tablet",
  ) {
    const ma = await this.musicAssistant();
    if (!ma) throw new ConflictError("Music Assistant isn't linked to Hearth.");
    await this.musicErrors(async () => {
      if (a.action === "play") {
        await ma.act("play a song from Up Next", "player_queues/play_index", {
          queue_id: a.queueId,
          index: a.itemId,
        });
        return;
      }
      if (a.action === "like") {
        await ma.act("like a song", "music/library/add_item", { item: a.uri });
        await ma.act("like a song", "music/favorites/add_item", { item: a.uri });
        return;
      }
      // Its library entry (it is in the library when it is liked), then the like taken back.
      const lib = await ma.act<{ item_id?: string | number; media_type?: string } | null>(
        "take a like back",
        "music/library/add_item",
        { item: a.uri },
      );
      if (lib?.item_id === undefined || !lib.media_type) return;
      await ma.act("take a like back", "music/favorites/remove_item", {
        media_type: lib.media_type,
        library_item_id: lib.item_id,
      });
      await ma.act("take a like back", "music/library/remove_item", {
        media_type: lib.media_type,
        library_item_id: lib.item_id,
      });
    });
    await recordAudit(this.handle.db, {
      actor: "you",
      action: `Home dashboard${who === "home tablet" ? " (home tablet)" : ""}: ${
        a.action === "play"
          ? "played a song from Up Next"
          : a.action === "like"
            ? "liked a song"
            : "took a like back"
      }`,
      target: "music-assistant",
    });
    return { ok: true };
  }

  async homeMusicOpen(uri: string) {
    const ma = await this.musicAssistant();
    if (!ma)
      throw new ConflictError(
        "Hearth can't open playlists until Music Assistant is linked from Hearth: on the music card, Connect, then Music Assistant.",
      );
    return musicOpen(ma.call, uri);
  }

  /** A poster, through Music Assistant's own image proxy (its opaque ids only). */
  /** The song's official music video on YouTube, for the now-playing card (or none). */
  async homeMusicVideo(title: string, artist: string) {
    const fetchImpl = this.fetchImpl ?? (fetch as unknown as Fetch);
    return { video: await musicVideo(fetchImpl, title, artist) };
  }

  async homeMusicArt(id: string) {
    if (!/^[A-Za-z0-9_-]{4,200}$/.test(id)) throw new NotFoundError("No such picture.");
    const ma = await this.musicAssistant();
    if (!ma) throw new NotFoundError("No such picture.");
    const res = await ma.fetchImpl(`${ma.address}/imageproxy/${id}?size=300`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new NotFoundError("No such picture.");
    const type = res.headers.get("content-type") ?? "image/jpeg";
    if (!/^image\//.test(type)) throw new NotFoundError("No such picture.");
    return { type, body: Buffer.from(await res.arrayBuffer()) };
  }

  private async musicErrors<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof HomeActionError) throw new ConflictError(e.message);
      throw e;
    }
  }

  /** The photo frame's photos last listed: only these are served to the dashboard. */
  private framePhotos = new Set<string>();

  /** The Immich the photo frame uses: the first one Hearth has a key for (or sample data). */
  private async frameImmich() {
    for (const x of (await this.targets()).filter((x) => x.app === "immich"))
      if (
        x.service.checkTarget?.startsWith("demo:") ||
        (await this.broker.has(x.service.id).catch(() => false))
      )
        return x.service;
    return undefined;
  }

  /**
   * The photo frame (11-05): up to 40 photos from the chosen Immich album, or the newest on
   * the timeline, shuffled. Archived, hidden and locked photos never show (immichPhotos).
   */
  async homePhotos(album?: string) {
    const service = await this.frameImmich();
    if (!service) return { connected: false as const, photos: [] as string[], albums: [] };
    const [page, albums] = await Promise.all([
      this.immichRead(service.id, "show photos on the home dashboard", (f, base, key) =>
        immichPhotos(f, base, key, 1, 80, album),
      ),
      this.immichRead(service.id, "list albums for the home dashboard", (f, base, key) =>
        immichAlbums(f, base, key),
      ).catch(() => []),
    ]);
    const ids = page.items.map((p) => p.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    }
    const photos = ids.slice(0, 40);
    this.framePhotos = new Set([...this.framePhotos, ...photos].slice(-400));
    return {
      connected: true as const,
      serviceName: service.name,
      photos,
      albums: albums.map((a) => ({ id: a.id, name: a.albumName, count: a.assetCount ?? 0 })),
    };
  }

  /** One photo frame picture (Immich's preview size), only one the frame was given. */
  async homePhoto(id: string) {
    if (!this.framePhotos.has(id)) return undefined;
    const service = await this.frameImmich();
    if (!service) return undefined;
    return this.immichThumbnail(service.id, id, "preview");
  }

  /** The news widget's headlines, from the feeds the owner chose. */
  homeNews(feeds: { url: string; name?: string }[]) {
    return readNews(this.fetchImpl ?? (fetch as unknown as Fetch), feeds);
  }

  /** A speaker's artwork or a camera's picture for the dashboard. */
  async homePicture(serviceId: string | undefined, entity: string) {
    const h = await this.homeTarget(serviceId);
    return h.use("show a picture on the home dashboard", "read", "you", (token) =>
      homePicture(h.fetchImpl, h.base, token, entity),
    );
  }

  /**
   * A tap on the home dashboard: done straight away (the person at the screen decided), within
   * HOME_ACTIONS only, audited. Opening a door or disarming needs the PIN (checked first).
   */
  async homeAction(
    serviceId: string | undefined,
    a: HomeAction & { pin?: string },
    who: "you" | "home tablet",
  ) {
    const h = await this.homeTarget(serviceId);
    if (NEEDS_PIN.has(`${a.entity.split(".")[0]}.${a.action}`)) {
      try {
        await checkPin(this.handle, a.pin);
      } catch (e) {
        await recordAudit(this.handle.db, {
          actor: "you",
          action: `Home dashboard${who === "home tablet" ? " (home tablet)" : ""}: refused ${a.action} of ${a.entity} (${e instanceof Error ? e.message : "PIN"})`,
          target: `service:${h.service.id}`,
        });
        throw new ConflictError(e instanceof Error ? e.message : "That PIN is not right.");
      }
    }
    try {
      const done = await h.use(
        `${a.action.replace(/_/g, " ")} ${a.entity} from the home dashboard`,
        "change",
        "you",
        (token) => homeAct(h.fetchImpl, h.base, token, a),
      );
      await recordAudit(this.handle.db, {
        actor: "you",
        action: `Home dashboard${who === "home tablet" ? " (home tablet)" : ""}: ${done.done}`,
        target: `service:${h.service.id}`,
        detail: { entity: a.entity, action: a.action },
      });
      return done;
    } catch (e) {
      if (e instanceof HomeActionError) throw new ConflictError(e.message);
      throw e;
    }
  }

  /** Connecting a service through Home Assistant's own setup (the owner only). */
  async homeConnect(
    serviceId: string | undefined,
    step:
      | { start: string }
      | { handler: string; flowId: string; data: Record<string, unknown> }
      | { handler: string; flowId: string; callback: string }
      | { app: string; clientId: string; clientSecret: string },
  ) {
    const h = await this.homeTarget(serviceId);
    try {
      return await h.use(
        "connect a service in Home Assistant for the home dashboard",
        "change",
        "you",
        async (token) => {
          if ("start" in step)
            return connectStart(h.fetchImpl, h.socket, h.base, token, step.start);
          if ("app" in step) {
            await addAppCredentials(
              h.socket,
              h.base,
              token,
              step.app,
              step.clientId,
              step.clientSecret,
            );
            await recordAudit(this.handle.db, {
              actor: "you",
              action: `Home dashboard: gave Home Assistant the ${step.app} app's client id and secret (not kept by Hearth)`,
              target: `service:${h.service.id}`,
            });
            return { ok: true };
          }
          // The address a sign-in ended on (a dead page): its code goes to Home Assistant first.
          if ("callback" in step) await deliverSignInCallback(h.fetchImpl, h.base, step.callback);
          const next = await connectNext(
            h.fetchImpl,
            h.socket,
            h.base,
            token,
            step.handler,
            step.flowId,
            "callback" in step ? {} : step.data,
          );
          if (next.type === "done")
            await recordAudit(this.handle.db, {
              actor: "you",
              action: `Home dashboard: connected ${next.title ?? step.handler} in Home Assistant`,
              target: `service:${h.service.id}`,
            });
          return next;
        },
      );
    } catch (e) {
      if (e instanceof HomeActionError) throw new ConflictError(e.message);
      throw e;
    }
  }

  /**
   * Adds Home Assistant's Music Assistant integration with a Music Assistant session the owner
   * signed in for (MusicAssistantLink): Home Assistant's own setup, its address question answered,
   * and its sign-in step given that session, which Home Assistant swaps for its own token.
   */
  async homeConnectMusicAssistant(
    serviceId: string | undefined,
    ma: { address: string; token: string },
  ): Promise<FlowStep> {
    const h = await this.homeTarget(serviceId);
    try {
      return await h.use(
        "add Music Assistant to Home Assistant for the home dashboard",
        "change",
        "you",
        async (token) => {
          const step = await connectMusicAssistant(h.fetchImpl, h.socket, h.base, token, ma);
          if (step.type === "done")
            await recordAudit(this.handle.db, {
              actor: "you",
              action: "Home dashboard: connected Music Assistant in Home Assistant",
              target: `service:${h.service.id}`,
            });
          return step;
        },
      );
    } catch (e) {
      if (e instanceof HomeActionError) throw new ConflictError(e.message);
      throw e;
    }
  }

  /** The apps worth reading: watched services whose image Hearth understands. */
  private async targets(serviceIds?: string[]) {
    const rows = await this.handle.db
      .select()
      .from(t.services)
      .where(eq(t.services.lifecycle, "active"));
    return rows
      .filter((s) => !serviceIds || serviceIds.includes(s.id))
      .map((s) => ({ service: s, app: appOf(s) }))
      .filter((x): x is { service: ServiceRow; app: AppKind } => Boolean(x.app));
  }

  /**
   * On the monitoring timer: reads every app at most once per APP_INTERVAL_MS,
   * and any app not read yet (newly adopted, or sample data just reset) at once.
   */
  async tick(now = Date.now()): Promise<string[]> {
    if (now - this.last >= APP_INTERVAL_MS) {
      this.last = now;
      return this.check();
    }
    const read = new Set(
      (await this.handle.db.select({ id: t.appHealth.serviceId }).from(t.appHealth)).map(
        (r) => r.id,
      ),
    );
    const unread = (await this.targets()).filter((x) => !read.has(x.service.id));
    return unread.length ? this.check(unread.map((x) => x.service.id)) : [];
  }

  /** Reads now; returns the ids of incidents it opened. */
  async check(serviceIds?: string[]): Promise<string[]> {
    const opened: string[] = [];
    for (const { service, app } of await this.targets(serviceIds)) {
      const id = await this.checkOne(service, app);
      if (id) opened.push(id);
    }
    return opened;
  }

  /** The vault entry this app is read with: an API key, or (qBittorrent) a login. */
  private async keyFor(
    service: ServiceRow,
    app: AppKind,
  ): Promise<{ id?: string; username?: string; problem?: string }> {
    const login = APP_INTEGRATIONS[app].credential === "login";
    const secrets = (
      await this.handle.db
        .select()
        .from(t.vaultSecrets)
        .where(eq(t.vaultSecrets.serviceId, service.id))
    ).filter((s) =>
      login
        ? (s.kind === "login" || s.kind === "password") && Boolean(s.username)
        : // An app's key is often called a token (Plex's X-Plex-Token): either kind is its key.
          s.kind === "api-key" || s.kind === "token",
    );
    const usable = secrets.find((s) => s.tier === "automation");
    if (usable) return { id: usable.id, username: usable.username ?? undefined };
    const what = login ? "Web UI login" : "API key";
    return {
      problem: secrets.length
        ? `${service.name}'s ${what} is a protected secret, which needs you to unlock it each time. Make it an automation secret in the vault so Hearth can read ${service.name} on its own.`
        : login
          ? `Add ${service.name}'s Web UI login to the vault (kind: Login, with the username, the password as the value, linked to ${service.name}) so Hearth can read it. It changes nothing in ${service.name} unless you approve that change.`
          : `Add ${service.name}'s API key to the vault (kind: API key, linked to ${service.name}) so Hearth can read it. It changes nothing in ${service.name} unless you approve that change.`,
    };
  }

  /** One read of the app, without storing anything. */
  private async read(
    service: ServiceRow,
    app: AppKind,
    by?: "agent" | "you",
  ): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
    const demo = service.checkTarget?.startsWith("demo:") ?? false;
    if (demo) return demoReport(app, await getSetting(this.handle.db, "demo_scenario"));
    if (app === "authelia") {
      if (!service.localUrl)
        return {
          app,
          status: "unreachable",
          issues: [],
          facts: [],
          detail: `Hearth does not know ${service.name}'s address.`,
        };
      return readAuthelia(service.localUrl, this.fetchImpl ?? (fetch as unknown as Fetch)).catch(
        (error: unknown) => ({
          app,
          status: "unreachable" as const,
          issues: [],
          facts: [],
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    if (app === "traefik") {
      if (!service.localUrl)
        return {
          app,
          status: "unreachable",
          issues: [],
          facts: [],
          detail: `Hearth does not know ${service.name}'s address.`,
        };
      return readTraefik(service.localUrl, this.fetchImpl ?? (fetch as unknown as Fetch)).catch(
        (error: unknown) => ({
          app,
          status: "unreachable" as const,
          issues: [],
          facts: [],
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    if (app === "ersatztv") {
      if (!service.localUrl)
        return {
          app,
          status: "unreachable",
          issues: [],
          facts: [],
          detail: `Hearth does not know ${service.name}'s address.`,
        };
      return readErsatz(service.localUrl, this.fetchImpl ?? (fetch as unknown as Fetch)).catch(
        (error: unknown) => ({
          app,
          status: "unreachable" as const,
          issues: [],
          facts: [],
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    const key = await this.keyFor(service, app);
    if (!key.id) return { app, status: "needs-key", issues: [], facts: [], detail: key.problem };
    if (!service.localUrl && app !== "tailscale") {
      return {
        app,
        status: "unreachable",
        issues: [],
        facts: [],
        detail: `Hearth does not know ${service.name}'s address.`,
      };
    }
    const fetchImpl = this.fetchImpl ?? (fetch as unknown as Fetch);
    const base = app === "tailscale" ? TAILSCALE_API : service.localUrl!;
    try {
      // Through the broker: only to this service's address, scrubbed errors, track record kept.
      // Each use shows in this table's checkedAt rather than one audit entry every five minutes.
      return await this.broker.use(
        {
          serviceId: service.id,
          purpose: `read ${service.name}'s health`,
          access: "read",
          destination: base,
          ...(by ? { onBehalfOf: by } : {}),
        },
        ({ value, username }) =>
          app === "prowlarr"
            ? readProwlarr(base, value, fetchImpl)
            : app === "radarr" || app === "sonarr"
              ? readArr(app, base, value, fetchImpl)
              : app === "sabnzbd"
                ? readSabnzbd(base, value, fetchImpl)
                : app === "nzbget"
                  ? readNzbget(base, { username: username ?? "", password: value }, fetchImpl)
                  : app === "deluge"
                    ? readDeluge(base, value, fetchImpl)
                    : app === "transmission"
                      ? readTransmission(
                          base,
                          { username: username ?? "", password: value },
                          fetchImpl,
                        )
                      : app === "homeassistant"
                        ? readHomeAssistant(base, value, fetchImpl, this.socket)
                        : app === "lidarr" || app === "chaptarr"
                          ? readArrV1(app, base, value, fetchImpl)
                          : app === "bazarr"
                            ? readBazarr(base, value, fetchImpl)
                            : app === "tautulli"
                              ? readTautulli(base, value, fetchImpl)
                              : app === "seerr"
                                ? readSeerr(base, value, fetchImpl, service.name)
                                : app === "syncthing"
                                  ? readSyncthing(base, value, fetchImpl)
                                  : app === "wizarr"
                                    ? readWizarr(base, value, fetchImpl)
                                    : jellyfinLike(app)
                                      ? readJellyfin(base, value, fetchImpl).then((r) => ({
                                          ...r,
                                          app,
                                        }))
                                      : app === "immich"
                                        ? readImmich(base, value, fetchImpl)
                                        : app === "audiobookshelf"
                                          ? readAudiobookshelf(base, value, fetchImpl)
                                          : app === "kavita"
                                            ? readKavita(base, value, fetchImpl)
                                            : app === "portainer"
                                              ? readPortainer(base, value, fetchImpl)
                                              : app === "uptimekuma"
                                                ? readUptimeKuma(
                                                    base,
                                                    { username: username ?? "", password: value },
                                                    fetchImpl,
                                                  )
                                                : app === "paperless"
                                                  ? readPaperless(base, value, fetchImpl)
                                                  : app === "vaultwarden"
                                                    ? readVaultwarden(base, value, fetchImpl)
                                                    : app === "tailscale"
                                                      ? readTailscale(value, fetchImpl)
                                                      : app === "komga"
                                                        ? readKomga(base, value, fetchImpl)
                                                        : app === "mealie"
                                                          ? readMealie(base, value, fetchImpl)
                                                          : app === "actual"
                                                            ? readActual(base, value, fetchImpl)
                                                            : app === "frigate"
                                                              ? readFrigate(
                                                                  base,
                                                                  {
                                                                    username: username ?? "",
                                                                    password: value,
                                                                  },
                                                                  this.fetchImpl ?? localTlsFetch,
                                                                )
                                                              : app === "authentik"
                                                                ? readAuthentik(
                                                                    base,
                                                                    value,
                                                                    fetchImpl,
                                                                  )
                                                                : app === "gitea"
                                                                  ? readGitea(
                                                                      base,
                                                                      value,
                                                                      fetchImpl,
                                                                    )
                                                                  : app === "navidrome"
                                                                    ? readNavidrome(
                                                                        base,
                                                                        {
                                                                          username: username ?? "",
                                                                          password: value,
                                                                        },
                                                                        fetchImpl,
                                                                      )
                                                                    : app === "wgeasy"
                                                                      ? readWgEasy(
                                                                          base,
                                                                          {
                                                                            username:
                                                                              username ?? "",
                                                                            password: value,
                                                                          },
                                                                          fetchImpl,
                                                                        )
                                                                      : app === "nextcloud"
                                                                        ? readNextcloud(
                                                                            base,
                                                                            {
                                                                              username:
                                                                                username ?? "",
                                                                              password: value,
                                                                            },
                                                                            fetchImpl,
                                                                          )
                                                                        : app === "npm"
                                                                          ? readNpm(
                                                                              base,
                                                                              {
                                                                                username:
                                                                                  username ?? "",
                                                                                password: value,
                                                                              },
                                                                              fetchImpl,
                                                                            )
                                                                          : app === "proxmox"
                                                                            ? readProxmox(
                                                                                base,
                                                                                value,
                                                                                this.fetchImpl ??
                                                                                  localTlsFetch,
                                                                              )
                                                                            : app === "pihole"
                                                                              ? readPihole(
                                                                                  base,
                                                                                  value,
                                                                                  fetchImpl,
                                                                                )
                                                                              : app === "adguard"
                                                                                ? readAdguard(
                                                                                    base,
                                                                                    {
                                                                                      username:
                                                                                        username ??
                                                                                        "",
                                                                                      password:
                                                                                        value,
                                                                                    },
                                                                                    fetchImpl,
                                                                                  )
                                                                                : app === "romm"
                                                                                  ? readRomm(
                                                                                      base,
                                                                                      {
                                                                                        value,
                                                                                        ...(username
                                                                                          ? {
                                                                                              username,
                                                                                            }
                                                                                          : {}),
                                                                                      },
                                                                                      fetchImpl,
                                                                                    )
                                                                                  : app === "plex"
                                                                                    ? (this.plex ??=
                                                                                        new PlexLive(
                                                                                          fetchImpl,
                                                                                        ))
                                                                                        .dashboard(
                                                                                          service.id,
                                                                                          base,
                                                                                          value,
                                                                                        )
                                                                                        .then(
                                                                                          plexReport,
                                                                                        )
                                                                                    : readQbittorrent(
                                                                                        base,
                                                                                        {
                                                                                          username:
                                                                                            username ??
                                                                                            "",
                                                                                          password:
                                                                                            value,
                                                                                        },
                                                                                        fetchImpl,
                                                                                      ),
      );
    } catch (error) {
      return {
        app,
        status:
          error instanceof AppKeyError || error instanceof CredentialError
            ? "needs-key"
            : "unreachable",
        issues: [],
        facts: [],
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private liveReads = new Map<string, Promise<AppReport | undefined>>();

  /**
   * For the Diagnostics panel: a fresh read of the app (at most every
   * LIVE_MIN_MS; within that, the last one). Stored for display, but never
   * counted towards opening an incident: an open panel does not raise alarms faster.
   */
  async diagnostics(serviceId: string, by?: "agent" | "you"): Promise<AppDiagnostics> {
    const target = (await this.targets([serviceId]))[0];
    const recorded = await this.handle.db
      .select()
      .from(t.appHealth)
      .where(eq(t.appHealth.serviceId, serviceId))
      .get();
    if (!target) {
      return {
        live: false,
        ...(recorded ? { report: toAppReport(recorded) } : {}),
        note: "Hearth has no integration for this service, or it is paused or retired.",
      };
    }
    if (recorded && Date.now() - Date.parse(recorded.checkedAt) < LIVE_MIN_MS) {
      return { live: false, report: toAppReport(recorded), note: "Read a moment ago." };
    }
    let pending = this.liveReads.get(serviceId);
    if (!pending) {
      pending = this.checkOne(target.service, target.app, { live: true, by }).then(async () => {
        const row = await this.handle.db
          .select()
          .from(t.appHealth)
          .where(eq(t.appHealth.serviceId, serviceId))
          .get();
        return row ? toAppReport(row) : undefined;
      });
      this.liveReads.set(serviceId, pending);
      void pending.finally(() => this.liveReads.delete(serviceId)).catch(() => undefined);
    }
    const report = await pending;
    const demo = target.service.checkTarget?.startsWith("demo:") ?? false;
    return {
      live: Boolean(report) && !demo,
      ...(report ? { report } : {}),
      ...(demo ? { note: "Sample data: nothing is read from a real app." } : {}),
    };
  }

  private async checkOne(
    service: ServiceRow,
    app: AppKind,
    opts: { live?: boolean; by?: "agent" | "you" } = {},
  ): Promise<string | undefined> {
    const { db } = this.handle;
    const at = new Date().toISOString();
    const demo = service.checkTarget?.startsWith("demo:") ?? false;
    const report = await this.read(service, app, opts.by);

    const prior = await db
      .select()
      .from(t.appHealth)
      .where(eq(t.appHealth.serviceId, service.id))
      .get();
    const errors = report.issues.filter((i) => i.level === "error");
    // Unreachable says nothing about the app's own health (the container check covers being down).
    const failingChecks =
      opts.live || report.status === "unreachable" || report.status === "needs-key"
        ? (prior?.failingChecks ?? 0)
        : errors.length
          ? (prior?.failingChecks ?? 0) + 1
          : 0;
    const row = {
      serviceId: service.id,
      app,
      status: report.status,
      version: report.version ?? prior?.version ?? null,
      issues: report.issues,
      facts: report.facts,
      detail: report.detail ?? null,
      checkedAt: at,
      failingChecks,
      details: {
        ...(report.queue ? { queue: report.queue } : {}),
        ...(report.queueTotal !== undefined ? { queueTotal: report.queueTotal } : {}),
        ...(report.activity ? { activity: report.activity } : {}),
        ...(report.connections ? { connections: report.connections } : {}),
      },
    };

    let opened: string | undefined;
    await withTransaction(this.handle, async () => {
      await db
        .insert(t.appHealth)
        .values(row)
        .onConflictDoUpdate({ target: t.appHealth.serviceId, set: row });
      // Live panel reads only refresh what is shown; incidents follow the regular reads.
      if (demo || opts.live) return;
      const key = `app:${service.id}`;
      if (errors.length && failingChecks >= CONFIRM_AFTER) {
        const title =
          errors.length === 1
            ? `${service.name}: ${errors[0]!.text.replace(/\.$/, "")}`
            : `${service.name}: ${errors.length} problems inside the app`;
        const already = await openIncidentFor(db, key);
        const id = await raise(db, {
          key,
          at,
          since: at,
          title: title.length > 120 ? `${title.slice(0, 117)}...` : title,
          summary: errors.map((e) => e.text).join(" "),
          severity: "warning",
          serviceId: service.id,
          detectedText: `${service.name} reported: ${errors.map((e) => e.text).join(" ")}`,
          confirmText: `Confirmed on ${failingChecks} reads in a row.`,
          escalateText: `This is inside ${service.name} itself, so restarting its container will not fix it. Waiting for you (the AI operator can look into it if connected).`,
        });
        if (!already) opened = id;
      } else if (!errors.length && report.status === "ok") {
        await settle(
          db,
          key,
          at,
          `${service.name} reports no problems.`,
          `${service.name} recovered: no problems reported.`,
          `${service.name} is healthy again`,
        );
      }
    });
    return opened;
  }

  async reports(): Promise<AppReport[]> {
    return (await this.handle.db.select().from(t.appHealth)).map(toAppReport);
  }
}

/**
 * Kavita's reader (media/library-sources.ts) has not been checked against a real Kavita yet. Until
 * one real book and one real comic read correctly from a real install, Kavita is not watched, so
 * nothing from it can reach a destination.
 */
export const KAVITA_ANNOUNCE_CHECKED = false;

/** Which watcher an app is read by for "New in your library" (Emby is read as Jellyfin is). */
function mediaAppOf(app: AppKind): MediaApp | undefined {
  if (app === "plex") return "plex";
  if (jellyfinLike(app)) return "jellyfin";
  if (app === "kavita") return KAVITA_ANNOUNCE_CHECKED ? "kavita" : undefined;
  if (app === "navidrome" || app === "audiobookshelf" || app === "romm") return app;
  return undefined;
}
