import { timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { existsSync } from "node:fs";
import { EMBER_HEADER, EMBER_SECRET, closestRoutes, methodsAt } from "./agent/hearth-api";
import { HearthSelf } from "./agent/hearth-self";
import { MemoryOperations } from "./monitor/memory-ops";
import { realMemorySources } from "./monitor/memory";
import { fakeMemory } from "./monitor/fake-memory";
import { readFile } from "node:fs/promises";
import { parseCaddyConfig, type CaddySite } from "./admin/caddy-panel";
import { realSetupDeps, VoiceAssist } from "./voice/assist";
import path from "node:path";
import Fastify, { type FastifyRequest, type FastifyServerOptions } from "fastify";
import fastifyStatic from "@fastify/static";
import { RETENTION_CHOICES, ResourceHistory, SAMPLE_MINUTES } from "./monitor/history";
import {
  RESTART_KEEP_PER_SERVICE,
  RESTART_RETENTION_CHOICES,
  RESTART_SWEEP_MINUTES,
  RestartLog,
  describeEvent,
} from "./monitor/restarts";
import { serviceTimeline } from "./store/timeline";
import { readHostCounters } from "./monitor/host-counters";
import { PlexLink } from "./credentials/plex-link";
import { randomUUID } from "node:crypto";
import { and, desc, eq, like } from "drizzle-orm";
import { z, ZodError } from "zod";
import {
  AI_NAME_PATTERN,
  RECOMMEND_KINDS,
  RECOMMEND_MODES,
  RECOMMEND_REACTIONS,
  RECOMMEND_SHOW,
  LOOK_PERSONA_MAX,
  VOICE_NAME,
  VOICE_PERSONA_MAX,
  VOICE_TRAITS,
  VOICE_PROFILE_ID,
  VOICE_EFFECT_IDS,
  type VoiceEffect,
  VOICE_PROFILE_LIMIT,
  VOICE_RECORD_RATE,
  type VoiceConfig,
  APP_NAME,
  APP_VERSION,
  ACTION_KINDS,
  AUTONOMY_LEVELS,
  POWER_ACTIONS,
  DEMO_SCENARIOS,
  worstStatus,
  type ActionKind,
  type DiscoveryReport,
  type HealthReport,
  JURISDICTION_KINDS,
  PROJECT_ICONS,
  PROJECT_COLORS,
  PROJECT_PHASES,
  PROJECT_TASK_STATUSES,
  THEME_PRESETS,
  THREAD_LOOK_IDS,
  PANEL_LOOKS,
  aiDisplayName,
  SERVICE_CATEGORIES,
  type ServiceCategory,
  PROFILE_AVATAR,
  VOICE_GENDERS,
  defaultGenderFor,
  type VoiceGender,
  AI_AVATAR_PATH,
  RESERVATION_RESOURCES,
  REPORTED_WORK_STATUSES,
  isClockTime,
  voiceLevel,
  BUILD_QUESTIONS,
  HOMELAB_STEP_IDS,
  VPN_PROVIDERS,
  type HomelabStepId,
  recommendBuild,
  type BuildAnswers,
  type HostScan,
  type MediaAnnounceSettings,
  mediaAnnounceSettings,
  EMBER_LINES_MAX_PER_DAY,
  type AppKind,
  type InstallFacts,
  jellyfinLike,
} from "@dragon-control/core";
import { BrowserError, EmberBrowser, hostOf, isPrivateAddress } from "./browser/manager";
import { lanAddressFor, MusicAssistantLink, MusicLinkError } from "./apps/music-assistant-link";
import { machineFacts } from "./voice/machine";
import { fakeHostScan, scanHost } from "./plan/scan";
import { SERVER_ROOT, type Config } from "./config";
import type { DbHandle } from "./db/client";
import { readInstallIdentity } from "./db/meta";
import {
  PREMIUM_FEATURES,
  frameVerdict,
  type EmbedVerdict,
  type PremiumFeature,
} from "@dragon-control/core";
import type { Session } from "./auth/service";
import { Entitlements, PremiumRequiredError } from "./premium/entitlements";
import { autoRecover } from "./apps/download-health";
import { AUDIENCES, Issuer, IssuerError } from "./premium/issuer";
import { DEFAULT_LICENCE_SERVICE, LicenceService, LicenceServiceError } from "./premium/service";
import { spawn } from "node:child_process";
import { PACKAGE_KEYS, PremiumPackage, type PackageKeys } from "./premium/package";
import { restartPlan } from "./pcs/network";
import {
  LicenseError,
  PREMIUM_ENFORCED,
  PRODUCTION_KEYS,
  readLicense,
  type TrustedKeys,
} from "./premium/license";
import { seedDemo } from "./demo/seed";
import {
  realProbes,
  runDiscovery,
  runRemoteDiscovery,
  slug,
  type DiscoveryProbes,
} from "./discovery/scan";
import { dismissIncident, runChecks } from "./monitor/engine";
import { realMonitorProbes, type MonitorProbes } from "./monitor/probes";
import { simulate } from "./monitor/simulation";
import type { ActionRunner } from "./actions/service";
import { linkSecret } from "./auth/link-secret";
import { originOf, registerAuth, SESSION_COOKIE } from "./auth/routes";
import { registerPcs } from "./pcs/routes";
import { attachSpeakerRelay } from "./apps/speaker-relay";
import { HostSpeaker } from "./apps/host-speaker";
import { Pcs } from "./pcs/hub";
import { ollamaIsLocalOnly } from "./engine/ollama";
import { HubMember } from "./pcs/member";
import { readInstallInfo, releaseVersion } from "./pcs/install";
import { LabBlueprint } from "./blueprint/service";
import { blueprintSource } from "./blueprint/source";
import { fakeCloud } from "./blueprint/fake-cloud";
import { DEFAULT_SHARE_PORT, VoiceShare } from "./voice/share";
import { Updates, githubReleases, type ReleaseSource } from "./updates/service";
import { HearthKey } from "./pcs/hearth-key";
import { hello } from "./pcs/discover";
import { selfUninstall } from "./pcs/uninstall";
import { SeerrOperations } from "./apps/seerr-ops";
import { NearMissWatch } from "./apps/crucible-near-miss";
import { registerEngine, type Engine } from "./engine/service";
import type { Notifier } from "./notify/notifier";
import { MediaWatcher, mediaWatcherFor } from "./media/watcher";
import { MovieNights, movieNightsFor } from "./media/nights";
import { hearthBotAvailable } from "./notify/hearth-bot";
import type { AccessKeys } from "./auth/tokens";
import { activeLookPersona, personaKey, type Agents } from "./agent/service";
import { ForYou, ForYouError, type SeerrTitle } from "./recommend/for-you";
import { registerMcp } from "./agent/mcp";
import { ADDON_API, Addons } from "./addons";
import { featureHelp } from "./agent/help";
import { registerMemory } from "./memory/routes";
import { Jurisdiction } from "./cave/jurisdiction";
import { AiUsage } from "./cave/usage";
import { buildBriefing } from "./memory/briefing";
import { buildBriefing as buildDashboardBriefing } from "./findings/briefing";
import { Briefs } from "./notify/briefs";
import { Imports } from "./memory/imports";
import type { Memory } from "./memory/service";
import type { Backups } from "./backup/service";
import { recordAudit } from "./store/audit";
import { pinIsSet, PinError, setPin } from "./apps/home-pin";
import { BoardChange, BoardError, changeBoard, OWNER_ONLY, readBoard } from "./apps/home-board";
import { ForbiddenAuthError, type Auth } from "./auth/service";
import type { Vault } from "./auth/vault";
import { adoptDiscovery } from "./store/adopt";
import { loadGettingStarted, updateGettingStarted } from "./store/getting-started";
import { addManualService, markRemovedFindings } from "./store/systems";
import { addLocation, browse, properties, removeLocation } from "./storage/service";
import { StorageCenterService } from "./storage/center-service";
import { CatalogService } from "./catalog/service";
import { FileManager } from "./storage/files";
import { VolumeNames } from "./storage/names";
import { SmartReader } from "./storage/smart";
import { FileOperations } from "./storage/file-ops";
import { RaidService } from "./storage/raid/service";
import { TinyauthUsers } from "./apps/tinyauth-users";
import { FileIndexer, type AddedKind } from "./storage/file-index";
import { saveDisks } from "./store/disks";
import { withTransaction } from "./db/tx";
import * as tables from "./db/schema";
import { deleteSetting, getSetting, setSetting } from "./store/settings";
import { checkedPicture } from "./store/pictures";
import { Todos } from "./todos/service";
import { registerTodoRoutes } from "./todos/routes";
import { createFindingsEngine, type FindingsEngine } from "./findings";
import { donationTokenAnalyzer } from "./findings/analyzers/donations";
import { registerFindingRoutes } from "./findings/routes";
import { Workspaces } from "./workspaces/service";
import { Attachments, registerAttachmentRoutes } from "./cave/attachments";
import { registerCaptureFolderRoutes } from "./cave/capture-folder";
import { WorkspacePlans } from "./workspaces/plans";
import { registerWorkspaceRoutes } from "./workspaces/routes";
import { CustomPanels } from "./panels/service";
import { fakeIntake, httpIntake } from "./panels/intake";
import { PANEL_INTAKE_KEYS } from "./panels/receipt";
import { ForgeAwaiting } from "./workspaces/awaiting";
import {
  Recommend,
  RecommendError,
  sameTitle,
  sameYear,
  type LibraryTitle,
  type SeerrHit,
  type ServerHit,
} from "./recommend/service";
import { listAudit } from "./store/audit";
import { ConflictError, InvalidRequestError, NotFoundError } from "./store/errors";
import { SHAPES, parseSetup } from "./apps/crucible-apply";
import type { CrucibleRow } from "@dragon-control/core";
import {
  decideIncident,
  saveAutonomy,
  setRouteChannels,
  updateGeneralSettings,
  setServiceLifecycle,
  removeService,
  restoreService,
  saveHomelabRules,
} from "./store/mutations";
import { loadWorkspace } from "./store/workspace";
import { Work } from "./work/service";
import { Watches } from "./watches/engine";
import { MovieReleases } from "./watches/movie-release";
import { RADARR_VIEWS, type RadarrView } from "./apps/radarr-panel";
import { SONARR_VIEWS, type SonarrView } from "./apps/sonarr-panel";
import { PROWLARR_VIEWS, type ProwlarrView } from "./apps/prowlarr-panel";
import { JELLYFIN_VIEWS, type JellyfinView } from "./apps/jellyfin-panel";
import { SEERR_VIEWS, type SeerrView } from "./apps/seerr-panel";
import { LIDARR_VIEWS, type LidarrView } from "./apps/lidarr-panel";
import { TAUTULLI_VIEWS, type TautulliView } from "./apps/tautulli-panel";
import { PLEX_VIEWS, type PlexView } from "./apps/plex-panel";
import { AppKeyError, AppUnreachableError, type Fetch } from "./apps/http";
import { MediaLibrary } from "./apps/media-library";
import { CrucibleKeeper } from "./apps/crucible-keeper";
import { HomeRows } from "./apps/home-rows";
import { CredentialError } from "./credentials/broker";
import { Jobs } from "./jobs/engine";
import { Projects } from "./projects/service";
import { AppWatcher, appOf } from "./apps/service";
import { AppOperations } from "./apps/operations";
import { CredentialSources } from "./credentials/sources";
import { keyImportOperations } from "./credentials/import-step";
import { runnerOperations } from "./jobs/operations";
import { createAdmin, registerAdminRoutes, type Admin } from "./admin";
import { GapError } from "./admin/scope";
import { realRun } from "./admin/host";
import { HomelabBuilder, defaultAppsRoot, installInfo } from "./build/service";
import { StagedChanges, browserChangeOperations } from "./browser/staged";
import { signIn as appSignIn, signInAppOf } from "./browser/signin";
import { isProtectedContainer, containerOf } from "./admin/scope";
import { appKindOf, type ReleaseScope, type SearchTitle } from "@dragon-control/core";
import { findCaddyfile, matchSites, readProxySites } from "./discovery/proxy-addresses";
import { Voice, wyomingClient } from "./voice/service";
import { LayoutCopy, LayoutError } from "./layout/copy";
import { findHearths } from "./pcs/discover";

/** Plan step parameters that carry JSON (a new object, a set of settings): Ember's limit. */
/**
 * Parameters that may be long, and how long: a new object or a set of settings (JSON), links to add
 * (magnet links carry their trackers), and uploaded files (a .torrent, as base64, about 4 MB at most).
 */
const LONG_PARAMS = new Map([
  ["body", 200_000],
  // An app's processes to close (free-memory): a browser can have many.
  ["pids", 20_000],
  ["preferences", 200_000],
  ["urls", 20_000],
  // Sorting manual downloads (app-qbt-manual-sort setup), whose setup carries every category.
  ["config", 2_000_000],
  ["files", 6_000_000],
  // Home rows for Jellyfin: each person's home screen (app-jellyfin-control home-screen).
  ["homes", 20_000],
  // Plex's Home rows: a library's rows and their order (11-08: Save to Plex was refused, and
  // nothing showed, once Movies had a dozen rows).
  ["rows", 20_000],
  ["order", 20_000],
  // An app's item or profile edited in its panel (Radarr, Sonarr, Lidarr, Prowlarr), Jellyfin's
  // settings, and Audiobookshelf's import list: JSON that grows with the library.
  ["changes", 200_000],
  ["settings", 200_000],
  ["books", 200_000],
  // The Crucible's rows (app-crucible-apply), sent as JSON.
  ["setup", 50_000],
  // A book to add to Chaptarr (the Curator's request): Chaptarr's own lookup record.
  ["book", 50_000],
]);
const LONG_PARAM_MAX = 6_000_000;

export interface AppDeps {
  handle: DbHandle;
  config: Pick<Config, "webDir" | "mode" | "demo"> & {
    keyDir: string;
    voiceHost?: string;
    dataDir?: string;
    /** Where add-ons (the Premium package) are installed; default <dataDir>/addons. */
    addonsDir?: string;
    /** The custom panel submission service (Panel Builder); unset: none. */
    panelIntakeUrl?: string;
    /** Where Hearth listens, for the addresses other devices can open it at. */
    host?: string;
    port?: number;
  };
  /** The engine (Claude Code and Codex in project folders); the War Room's routes when present. */
  engine?: Engine;
  startedAt?: number;
  logger?: FastifyServerOptions["logger"];
  /** Discovery's view of the outside world; replaced with fakes in tests. */
  probes?: DiscoveryProbes;
  /** Monitoring's read-only observations; replaced with fakes in tests. */
  monitorProbes?: MonitorProbes;
  /**
   * Carries out actions and repairs. Required, so nothing (a test in
   * particular) can reach real containers without choosing to.
   */
  runner: ActionRunner;
  /** The owner's sign-in and sessions; every API route except sign-in needs a session. */
  auth: Auth;
  vault: Vault;
  notifier: Notifier;
  keys: AccessKeys;
  agents: Agents;
  /** The homelab memory (D10) and its backups. */
  memory: Memory;
  backups: Backups;
  /** The Lab Blueprint; built here with this machine as its source when not given. */
  blueprint?: LabBlueprint;
  /** Plans of known operations (Cave 2); built from the runner when not given. */
  jobs?: Jobs;
  /** Projects for the command center (on the memory projects). */
  projects?: Projects;
  /** Reads inside the apps Hearth understands (M9). */
  apps?: AppWatcher;
  /** Resource history (off until switched on); built from the runner when not given. */
  history?: ResourceHistory;
  /** Restart history (on by default, with limits); built from the runner when not given. */
  restarts?: RestartLog;
  /** Link Plex through plex.tv (tests pass one with a stand-in plex.tv). */
  plexLink?: PlexLink;
  /** Browser tests only (DC_FAKE_APPS=1): stand-in apps and the route that steers them. */
  fakeApps?: import("./apps/fake-apps").FakeApps;
  /** Unit tests only: licence signing keys to trust besides the production ones. */
  premiumKeys?: import("./premium/license").TrustedKeys;
  /** Hearth's licence service (tests pass a stand-in; null: none). */
  licenceService?: LicenceService | null;
  /** Unit tests only: keys Premium packages may be signed with, besides the production ones. */
  premiumPackageKeys?: PackageKeys;
  /** Restarting this Hearth by itself (tests pass a stand-in); false when it can't. */
  restartSelf?: () => boolean;
  /** Host administration (feature request 21); built with a data-folder backup root when not given. */
  admin?: Admin;
  /** Voice for Ember (speech services shared with Home Assistant); tests pass a stand-in. */
  voice?: Voice;
  /** Setting voice up from Hearth's pages (find, use, install); tests pass a stand-in. */
  voiceAssist?: VoiceAssist;
  /** Long work reported from your machines (Phase 0 of AGENT_NEEDS_PLAN.md). */
  work?: Work;
  /** Release watch (docs/design/RELEASE_WATCH.md); built from the apps and notifier when not given. */
  watches?: Watches;
  /** Briefs and watches (notify/briefs.ts); built from the notifier when not given. */
  briefs?: Briefs;
  /** Media announcements (media/watcher.ts); built from the apps and notifier when not given. */
  media?: MediaWatcher;
  /** Movie nights (media/nights.ts); built from the media watcher and notifier when not given. */
  nights?: MovieNights;
  /** Findings and the analyzers behind them (checklist section 32). */
  findings?: FindingsEngine;
  /** File operations from the file manager (approved plan steps); given to the jobs engine. */
  fileOps?: FileOperations;
  /** RAID (Storage > RAID / Arrays): reading arrays and approved changes; given to the jobs engine. */
  raidOps?: RaidService;
  /** Tinyauth's users (stand-in tests pass their own). */
  tinyauthUsers?: TinyauthUsers;
  /** Ember changing Hearth itself through approved plans (hearth-api-call). */
  hearthSelf?: HearthSelf;
  /** Freeing memory on this machine (free-memory plan steps, Systems > Memory). */
  memoryOps?: MemoryOperations;
  /** Approved changes from Ember's browser, shared with the jobs that grant them. */
  stagedChanges?: StagedChanges;
  /** Where the homelab plan's build steps go (shared with a Jobs made outside buildApp). */
  homelabSteps?: { current?: HomelabBuilder };
}

const autonomyLevel = z.enum(AUTONOMY_LEVELS as [string, ...string[]]);

/** A look (Settings > Themes): for the desktop, or the phones' own. */
const themeChoice = z
  .object({
    preset: z.enum(THEME_PRESETS),
    primary: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
    secondary: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
    headings: z.enum(["classic", "modern"]).optional(),
    panels: z.enum(PANEL_LOOKS).optional(),
  })
  .strict();

const schemas = {
  // A host name or IP address on your network or tailnet: no scheme, path, or port.
  scanRemote: z
    .object({
      address: z
        .string()
        .trim()
        .min(1, "Enter the other machine's address")
        .max(253)
        .regex(/^(?:[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*|\[?[0-9a-fA-F:]+\]?)$/, {
          message: "Enter just the name or IP address, like 192.168.1.20 or my-pc",
        })
        .transform((a) => a.replace(/^\[|\]$/g, "")),
      name: z.string().trim().min(1, "Give the machine a name").max(60),
    })
    .strict(),
  settings: z
    .object({
      instanceName: z.string().trim().min(1, "Name cannot be empty").max(60).optional(),
      // Empty clears it: companions then say "you".
      ownerName: z.string().trim().max(40).optional(),
      // Your AI administrator's display name; empty goes back to "Ember".
      aiName: z
        .string()
        .trim()
        .max(40)
        .refine((v) => v === "" || AI_NAME_PATTERN.test(v), {
          message: "Use letters, numbers, spaces, apostrophes, dots, or hyphens (up to 40).",
        })
        .optional(),
      webUiVia: z.enum(["proxy", "host"]).optional(),
      // The first-run welcome: finished or skipped (true), or offer it again (false).
      onboardingDone: z.boolean().optional(),
      // The welcome's first choice: help building a first homelab, or an existing one.
      journey: z.enum(["build", "existing"]).optional(),
      // The welcome step reached last, so a closed browser resumes there.
      onboardingStep: z
        .string()
        .regex(/^[a-z][a-z-]{0,31}$/)
        .optional(),
      theme: themeChoice.optional(),
      // The look on phones; null: the same as the desktop.
      phoneTheme: themeChoice.nullable().optional(),
      // The Lair's systems in your order, for every device; null: most used first.
      lairOrder: z.array(z.string().max(200)).max(500).nullable().optional(),
      lairUsage: z
        .record(
          z.string().max(200),
          z.object({ s: z.number().min(0).max(1e6), at: z.number().int().min(0) }).strict(),
        )
        .refine((u) => Object.keys(u).length <= 500, { message: "Too many systems." })
        .nullable()
        .optional(),
      quietHours: z.boolean().optional(),
      monitorIntervalSec: z.number().int().min(15).max(3600).optional(),
      failureThreshold: z.number().int().min(1).max(10).optional(),
      liveRepairs: z.boolean().optional(),
      chatPictures: z.boolean().optional(),
    })
    .strict(),
  // Strict: a request cannot claim to come from anyone but you.
  action: z
    .object({
      kind: z.enum(ACTION_KINDS as [string, ...string[]]),
      serviceId: z.string(),
      /** inspect-logs only: a time window and a text filter (checked by planLogQuery). */
      logs: z
        .object({
          since: z.string().max(40).optional(),
          until: z.string().max(40).optional(),
          filter: z.string().max(200).optional(),
          limit: z.number().int().min(1).max(500).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  runChecks: z.object({ serviceId: z.string().optional() }).strict(),
  simulate: z
    .object({
      serviceId: z.string(),
      // "upstream": break something this service depends on, so it fails as a consequence.
      condition: z.enum(["down", "stuck", "slow", "upstream", "normal"]),
    })
    .strict(),
  autonomy: z
    .object({
      default: autonomyLevel,
      rules: z.array(
        z.object({ id: z.string(), level: z.union([autonomyLevel, z.literal("default")]) }),
      ),
    })
    .strict(),
  route: z.object({ channels: z.array(z.string()).max(20) }).strict(),
  workStart: z
    .object({
      title: z.string().trim().min(1, "Give it a title").max(120),
      machine: z.string().trim().min(1, "Name the machine").max(80),
      stopBy: z.string().datetime({ offset: true }).optional(),
      stallMinutes: z
        .number()
        .int()
        .min(1)
        .max(24 * 60)
        .optional(),
      detail: z.string().max(300).optional(),
      progress: z.number().min(0).max(100).optional(),
    })
    .strict(),
  workReport: z
    .object({
      progress: z.number().min(0).max(100).optional(),
      detail: z.string().max(300).optional(),
      status: z.enum(REPORTED_WORK_STATUSES).optional(),
    })
    .strict(),
  rules: z
    .object({
      doNotTouch: z
        .array(
          z.object({ serviceId: z.string().min(1), reason: z.string().trim().max(200) }).strict(),
        )
        .max(200),
      reservations: z
        .array(
          z
            .object({
              id: z.string().min(1).max(60),
              machine: z.string().trim().min(1, "Name the machine").max(80),
              resource: z.enum(RESERVATION_RESOURCES),
              from: z.string().refine(isClockTime, "Use a time like 19:00"),
              until: z.string().refine(isClockTime, "Use a time like 23:00"),
              days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
              note: z.string().trim().max(120).optional(),
            })
            .strict(),
        )
        .max(50),
      notes: z.string().max(8000).optional(),
    })
    .strict(),
  jurisdiction: z
    .object({
      kind: z.enum(JURISDICTION_KINDS),
      name: z.string().trim().min(1, "Give it a name").max(80),
      value: z.string().trim().max(300).optional(),
      access: z.enum(["in", "out"]),
      note: z.string().trim().max(300).optional(),
    })
    .strict(),
  aiBudget: z
    .object({
      dailyRuns: z.number().int().min(1).max(10_000).nullable().optional(),
      showEstimate: z.boolean().optional(),
      dailyUsd: z.number().min(0.01).max(1000).nullable().optional(),
      dailyTokens: z.number().int().min(1000).max(100_000_000).nullable().optional(),
      perRunUsd: z.number().min(0.01).max(50).optional(),
      warnAt: z.number().min(0.1).max(1).optional(),
      questionModel: z.string().trim().min(1).max(60).optional(),
      incidentModel: z.string().trim().min(1).max(60).optional(),
    })
    .strict(),
  lifecycle: z
    .object({
      lifecycle: z.enum(["active", "paused", "retired"]),
      note: z.string().trim().max(300).optional(),
    })
    .strict(),
  addSystem: z
    .object({
      name: z.string().trim().min(1, "Give it a name").max(60, "Use a shorter name"),
      kind: z.enum(["container", "web", "other"]),
      address: z.string().trim().max(300, "That address is too long"),
      category: z.enum(SERVICE_CATEGORIES as [ServiceCategory, ...ServiceCategory[]]),
      hostId: z.string().max(80).optional(),
    })
    .strict(),
  converse: z
    .object({
      text: z.string().min(1).max(20000),
      conversationId: z.string().max(80).optional(),
      source: z.enum(["voice", "api"]).optional(),
      /** Seconds to wait for the answer before returning "working". */
      wait: z.number().int().min(1).max(170).optional(),
      /** Images captured in the app and attached to this message (the app only). */
      attachments: z.array(z.string().max(80)).max(4).optional(),
      /** When the owner last looked, for "what happened while I was away". */
      lastVisit: z
        .string()
        .max(40)
        .refine((v) => !Number.isNaN(Date.parse(v)))
        .optional(),
      /** A new conversation for this project. */
      projectId: z.string().max(100).optional(),
      /** A new conversation's Thread Look (THREAD_LOOKS): its picture and default name. */
      look: z.enum(THREAD_LOOK_IDS as [string, ...string[]]).optional(),
      /** A new conversation's name, given when it was started (11-18). */
      title: z.string().trim().min(1).max(80).optional(),
      /** Spoken in the app (from the microphone); the answer is read aloud. */
      spoken: z.boolean().optional(),
      /** Sent while the previous answer was under way: more to the same request. */
      followUp: z.boolean().optional(),
      /** What is open on screen: "this" means it. */
      focus: z
        .object({
          kind: z.enum(["service", "project", "todo"]),
          id: z.string().min(1).max(200),
          item: z
            .discriminatedUnion("kind", [
              z
                .object({
                  kind: z.literal("torrent"),
                  id: z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i),
                })
                .strict(),
              z
                .object({ kind: z.literal("plex-session"), id: z.string().regex(/^[\w-]{1,64}$/) })
                .strict(),
            ])
            .optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  agentSettings: z.object({ escalate: z.boolean() }).strict(),
  channel: z.object({ values: z.record(z.string().max(40), z.string().max(2000)) }).strict(),
  project: z
    .object({
      name: z.string().trim().min(1).max(120),
      summary: z.string().max(1000).optional(),
      phase: z.enum(PROJECT_PHASES).optional(),
      icon: z.enum(PROJECT_ICONS).optional(),
      color: z.enum(PROJECT_COLORS).optional(),
      related: z
        .array(
          z.object({ kind: z.enum(["service", "host"]), id: z.string().min(1).max(200) }).strict(),
        )
        .max(20)
        .optional(),
    })
    .strict(),
  projectPatch: z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      summary: z.string().max(1000).optional(),
      status: z.enum(["active", "paused", "done"]).optional(),
      phase: z.enum(PROJECT_PHASES).optional(),
      icon: z.enum(PROJECT_ICONS).optional(),
      color: z.enum(PROJECT_COLORS).nullable().optional(),
      related: z
        .array(
          z.object({ kind: z.enum(["service", "host"]), id: z.string().min(1).max(200) }).strict(),
        )
        .max(20)
        .optional(),
    })
    .strict(),
  job: z
    .object({
      title: z.string().trim().min(1).max(120),
      reason: z.string().max(500).optional(),
      incidentId: z.string().max(100).optional(),
      projectId: z.string().max(100).optional(),
      steps: z
        .array(
          z
            .object({
              kind: z.enum(ACTION_KINDS as [ActionKind, ...ActionKind[]]),
              serviceId: z.string().min(1).max(200),
              /**
               * Operations inside apps: which one (a torrent hash, an indexer). Checked by the
               * operation. A new object (body) or a set of settings (preferences) is JSON and may be
               * as long as Ember's own (an indexer or artist has many fields); anything else is short.
               */
              params: z
                .record(
                  z.string().max(40),
                  z.union([z.string().max(LONG_PARAM_MAX), z.number(), z.boolean()]),
                )
                .refine((p) => Object.keys(p).length <= 8)
                .refine(
                  (p) =>
                    Object.entries(p).every(
                      ([k, v]) => typeof v !== "string" || v.length <= (LONG_PARAMS.get(k) ?? 200),
                    ),
                  {
                    message: `Only ${[...LONG_PARAMS.keys()].join(", ")} may be longer than 200 characters (each has its own limit).`,
                  },
                )
                .optional(),
            })
            .strict(),
        )
        .min(1)
        .max(12),
    })
    .strict(),
  decision: z
    .object({
      decision: z.enum(["approve", "decline"]),
      fingerprint: z.string().max(100).optional(),
    })
    .strict(),
  scenario: z
    .object({
      scenario: z.enum(DEMO_SCENARIOS as [string, ...string[]]),
      /** Required to replace your discovered systems with sample data. */
      replaceYourSystems: z.boolean().optional(),
    })
    .strict(),
  adopt: z
    .object({
      reportId: z.string(),
      selections: z
        .array(z.object({ key: z.string(), name: z.string().max(60) }).strict())
        .max(500),
    })
    .strict(),
  auditQuery: z.object({ limit: z.coerce.number().int().min(1).max(200).default(20) }),
  storagePath: z.object({ path: z.string().max(4096).optional() }),
  addLocation: z
    .object({ path: z.string().min(1).max(1024), label: z.string().max(60).optional() })
    .strict(),
};

export async function buildApp({
  handle,
  config,
  startedAt = Date.now(),
  logger = false,
  probes = realProbes,
  monitorProbes = realMonitorProbes,
  runner,
  auth,
  vault,
  notifier,
  keys,
  agents,
  memory,
  backups,
  blueprint: givenBlueprint,
  projects = new Projects(handle, memory),
  admin = createAdmin(handle, runner, {
    backupRoot: path.join(config.keyDir, "service-backups"),
    rules: { secretRoots: [config.keyDir] },
    memory,
  }),
  fileOps = new FileOperations(
    new FileManager(
      handle,
      [config.keyDir, config.dataDir].filter((x): x is string => Boolean(x)),
      new VolumeNames(handle),
    ),
  ),
  raidOps = RaidService.fromEnv(handle, process.env),
  tinyauthUsers = new TinyauthUsers(
    handle,
    () => runner.containerTools,
    path.join(config.keyDir, "service-backups"),
  ),
  hearthSelf = new HearthSelf(),
  memoryOps = memoryOperations(handle),
  stagedChanges = new StagedChanges(),
  homelabSteps = {} as { current?: HomelabBuilder },
  jobs = new Jobs(
    handle,
    runnerOperations(
      handle,
      runner,
      new AppOperations(handle, vault, runner, undefined, memory),
      admin.config,
      keyImportOperations(handle, vault, runner.containerTools, new AppWatcher(handle, vault)),
      fileOps,
      raidOps,
      tinyauthUsers,
      hearthSelf,
      memoryOps,
      browserChangeOperations(handle, stagedChanges),
      homelabSteps,
    ),
  ),
  apps = new AppWatcher(handle, vault),
  history = new ResourceHistory(handle, {
    containers: runner.containerTools,
    host: readHostCounters,
  }),
  restarts = new RestartLog(handle, runner.containerTools),
  plexLink: givenPlexLink,
  fakeApps,
  premiumKeys,
  licenceService: licenceServiceOpt,
  premiumPackageKeys,
  restartSelf,
  voice = new Voice(handle, { defaultHost: config.voiceHost }),
  voiceAssist = new VoiceAssist(handle, voice, wyomingClient, {
    dataDir: config.dataDir ?? config.keyDir,
    setup: realSetupDeps(SERVER_ROOT),
  }),
  work = new Work(handle),
  briefs = new Briefs(handle, notifier),
  watches: givenWatches,
  media: givenMedia,
  nights: givenNights,
  engine,
  findings = createFindingsEngine(handle, {
    probes: monitorProbes,
    containers: runner.containerTools,
    ...(backups ? { backups } : {}),
    raid: () => raidOps.report(),
  }),
}: AppDeps) {
  const app = Fastify({ logger });
  // Every address, so Ember's wrong guess at one comes back with the real ones (closestRoutes).
  const routes: { method: string; url: string }[] = [];
  app.addHook("onRoute", (r) => {
    for (const m of [r.method].flat()) routes.push({ method: m, url: r.url });
  });
  // Diagnostics only (DC_TX_DEBUG=<file>): requests open a long time, and the event loop
  // falling behind, are written to that file (finding what hangs in long test runs).
  const debugFile = process.env.DC_TX_DEBUG;
  if (debugFile) {
    const open = new Map<string, { url: string; at: number; told?: boolean }>();
    app.addHook("onRequest", async (request) => {
      open.set(request.id, { url: `${request.method} ${request.url}`, at: Date.now() });
    });
    app.addHook("onResponse", async (request) => {
      open.delete(request.id);
    });
    let tick = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const lines: string[] = [];
      if (now - tick > 5000)
        lines.push(`event loop blocked about ${Math.round((now - tick) / 1000)}s`);
      tick = now;
      for (const r of open.values())
        if (!r.told && now - r.at > 20_000 && !/\/stream|\/events/.test(r.url)) {
          r.told = true;
          lines.push(`request open ${Math.round((now - r.at) / 1000)}s: ${r.url}`);
        }
      if (lines.length)
        void import("node:fs").then((fs) =>
          fs.appendFileSync(
            debugFile,
            `${new Date().toISOString()} ${lines.join("; ")}
`,
          ),
        );
    }, 1000);
    timer.unref?.();
  }
  const { db } = handle;

  // The most recent scan, kept in memory only. Adoption works from this,
  // never from findings sent by the browser.
  let latestScan: DiscoveryReport | undefined;
  let scanInFlight: Promise<DiscoveryReport> | undefined;

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "Invalid request",
        message: error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      });
    }
    // A missing or refused login, or an app that did not answer: say so, in the app's words,
    // not "something went wrong". These messages never carry a credential's value.
    if (error instanceof CredentialError)
      return reply.code(409).send({ error: "Credential", message: error.message });
    if (error instanceof AppKeyError || error instanceof AppUnreachableError) {
      request.log.warn({ err: error }, "app call failed");
      return reply.code(502).send({ error: "App", message: error.message });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (error instanceof Error && status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: error.name, message: error.message });
    }
    request.log.error({ err: error }, "request failed");
    return reply.code(500).send({
      error: "Internal error",
      message: "Something went wrong inside Hearth. The details are in the server log.",
    });
  });

  await registerAuth(app, auth, vault, keys, (input) =>
    linkSecret(handle, input, async (id) => {
      // One read-only check now, as Add a system does, so the app's panel has something to show.
      await runChecks(handle, monitorProbes, { serviceIds: [id] });
      runner.onChange?.();
    }),
  );
  // One account, many PCs and devices (docs/design/ONE_ACCOUNT.md).
  const pcsDataDir = config.dataDir ?? config.keyDir;
  const pcIcons = path.join(pcsDataDir, "pc-icons");
  const blueprint =
    givenBlueprint ??
    new LabBlueprint({
      handle,
      auth,
      vault,
      source: () =>
        blueprintSource({
          handle,
          vault,
          version: releaseVersion() ?? APP_VERSION,
          fake: Boolean(fakeApps),
        }),
      version: releaseVersion() ?? APP_VERSION,
      host: () => hostname(),
      ...(fakeApps ? { fetch: fakeCloud().fetch } : {}),
    });
  const member = new HubMember({
    handle,
    auth,
    keyDir: config.keyDir,
    dataDir: pcsDataDir,
    version: releaseVersion() ?? APP_VERSION,
    inject: async (o) => {
      const r = await app.inject({
        method: o.method as "GET",
        url: o.url,
        headers: o.headers,
        ...(o.payload ? { payload: o.payload } : {}),
      });
      return { statusCode: r.statusCode, headers: r.headers, rawPayload: r.rawPayload };
    },
    localAddress: () => {
      const a = app.server.address();
      return a && typeof a === "object" ? { host: config.host ?? "127.0.0.1", port: a.port } : null;
    },
    install: () => readInstallInfo(),
    uninstall: (deleteData) => selfUninstall(readInstallInfo(), deleteData),
  });
  auth.joinedTo = () => member.status();
  const pcs = new Pcs(handle, auth, pcIcons);
  // Passing the account's Ollama setup to joined PCs is Hearth Connected's (Premium package).
  if (engine) {
    // Each PC's Homelab agent knows the account's other PCs, so it never mistakes one for
    // another (10-27: Desktop-PC's Ember thought it was on the home server).
    engine.persona = () => activeLookPersona(db);
    engine.accountPcs = async () => {
      const hub = await member.status();
      if (hub)
        return [
          `- **${hub.name}**: the Hearth this PC joined (it holds the account), ${hub.online ? "connected" : "not connected right now"}. ` +
            "Its apps are in its own Homelab project, not on this machine.",
        ];
      return (await pcs.list()).map(
        (pc) =>
          `- **${pc.name}** (${pc.os || "unknown system"}, Hearth ${pc.version || "unknown"}, ${pc.online ? "online" : "offline"}): ` +
          "joined this account. Its apps are in its own Homelab project, not on this machine.",
      );
    };
  }
  // A Hearth page as a Music Assistant speaker (the PC you remote from, a phone, this browser).
  const stopSpeakers = attachSpeakerRelay(app.server, {
    signedIn: async (req) => {
      const raw = String(req.headers.cookie ?? "")
        .split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith(`${SESSION_COOKIE}=`));
      const value = raw ? decodeURIComponent(raw.slice(SESSION_COOKIE.length + 1)) : undefined;
      return Boolean(await auth.session(value));
    },
    upstream: () => apps.speakerUpstream(),
  });
  app.addHook("onClose", async () => stopSpeakers());
  // This computer as a speaker, by itself (on unless the owner turned it off; never in tests).
  const hostSpeaker = new HostSpeaker({
    dataDir: config.dataDir ?? config.keyDir ?? ".",
    upstream: () => apps.speakerUpstream(),
  });
  if (!fakeApps)
    app.addHook("onReady", async () => {
      const kept = await getSetting(handle.db, "host_speaker").catch(() => undefined);
      if (kept?.on !== false) void hostSpeaker.set(true, kept?.name).catch(() => undefined);
    });
  app.addHook("onClose", async () => hostSpeaker.stop());
  app.get("/api/home/speaker/host", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return hostSpeaker.get();
  });
  app.post("/api/home/speaker/host", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    if (request.session.method === "home")
      throw new ForbiddenAuthError("Turn the Hearth computer's speaker on or off from Hearth.");
    const body = z
      .object({ on: z.boolean(), name: z.string().min(1).max(60).optional() })
      .strict()
      .parse(request.body);
    await setSetting(handle.db, "host_speaker", {
      on: body.on,
      ...(body.name ? { name: body.name } : {}),
    });
    return hostSpeaker.set(body.on, body.name);
  });
  /* ---------- Hearth Premium (docs/design/PREMIUM.md) ---------- */
  const installIdOf = async () => (await readInstallIdentity(db))?.installId ?? "unknown";
  // The keys a licence may be signed with: the ones Hearth's releases trust. Browser tests only
  // (DC_FAKE_APPS=1, never in a real install) also trust the test issuer's own key.
  const trustedKeys = async (): Promise<TrustedKeys> => {
    const own = fakeApps ? await getSetting(db, "premium_issuer") : undefined;
    return {
      ...PRODUCTION_KEYS,
      ...premiumKeys,
      ...(own ? { [own.keyId]: own.publicKey } : {}),
    };
  };
  // Each needs the other only when called: the issuer installs its own licences here, and its
  // revocations count here at once.
  const issuer: Issuer = new Issuer(handle, vault, installIdOf, trustedKeys, (token) =>
    entitlements.install(token),
  );
  // Before launch (PREMIUM_ENFORCED false, or no key trusted yet) every premium feature is open.
  // Tests always enforce, so the locks themselves stay tested.
  const premiumEnforced =
    Boolean(fakeApps) ||
    premiumKeys !== undefined ||
    (PREMIUM_ENFORCED && Object.keys(PRODUCTION_KEYS).length > 0);
  const entitlements = new Entitlements(
    handle,
    installIdOf,
    trustedKeys,
    async () => ((await issuer.active()) ? issuer.revokedLicenses() : []),
    Date.now,
    () => premiumEnforced,
  );
  // One Premium purchase covers every linked Hearth (the owner, 11-20): a PC sends its own
  // licences up, your Hearth keeps them and passes every licence it counts down to all its PCs.
  pcs.licences = () => entitlements.shareable();
  pcs.onLicences = async (pcId, tokens) => {
    if (await entitlements.setLinked(`pc:${pcId}`, tokens)) await pcs.shareLicences();
  };
  member.licences = () => entitlements.own();
  member.onLicences = async (tokens) => {
    await entitlements.setLinked("hub", tokens);
  };
  entitlements.onChange = () => {
    void pcs.shareLicences();
    void member.shareLicences();
  };

  // Hearth Transfer was removed (11-11): its settings go, so nothing of it is left behind. Saves
  // already in a save folder stay where they are; Hearth never deletes the owner's files.
  void handle.db
    .delete(tables.settings)
    .where(like(tables.settings.key, "lab_transfer%"))
    .catch(() => undefined);

  const connectedKit = registerPcs(app, {
    auth,
    listen: { host: config.host ?? "127.0.0.1", port: config.port ?? 7400 },
    pcs,
    member,
    version: releaseVersion() ?? APP_VERSION,
    iconDir: pcIcons,
    install: () => readInstallInfo(),
    uninstall: (deleteData) => selfUninstall(readInstallInfo(), deleteData),
    // Before your Hearth removes itself: the Crucible's clean exit (no request left waiting).
    beforeUninstall: () => crucibleKeeper.exit(),
    // Before a PC that has its own account joins another Hearth: its own backup first.
    ...(backups
      ? {
          backup: async () => {
            const r = await backups.run("manual");
            return { ok: r.ok, detail: r.detail };
          },
        }
      : {}),
    hearthKey: new HearthKey(handle, vault),
    // Browser tests: "Link to my Hearth" finds only these addresses, not the real network.
    ...(process.env.DC_FAKE_FIND
      ? {
          findHearths: async () =>
            (
              await Promise.all(process.env.DC_FAKE_FIND!.split(",").map((u) => hello(u.trim())))
            ).filter((f): f is NonNullable<typeof f> => Boolean(f)),
        }
      : {}),
  });
  // Hearth updates: a check every few hours, said once per version, and Update now.
  // Tests: DC_UPDATE_CHECK=off asks nobody; DC_FAKE_UPDATE=<version> stands in for GitHub, and
  // nothing is launched.
  const fakeUpdate = process.env.DC_FAKE_UPDATE;
  const updateSource: ReleaseSource = fakeUpdate
    ? async () => ({
        version: fakeUpdate,
        notes: "Faster War Room.\nNew icons.",
        url: "https://github.com/example/releases",
      })
    : process.env.DC_UPDATE_CHECK === "off" || process.env.VITEST
      ? async () => null
      : githubReleases;
  const updates = new Updates({
    current: () => releaseVersion() ?? APP_VERSION,
    install: () => readInstallInfo(),
    source: updateSource,
    announce: (release, current) =>
      notifier.announceHearthUpdate({ version: release.version, notes: release.notes, current }),
    announced: () => getSetting(db, "update_announced"),
    auto: async () => (await getSetting(db, "update_check_auto")) !== false,
    // The owner's choice; else the channel the installer was run with; else stable.
    channel: async () =>
      (await getSetting(db, "update_channel")) ?? readInstallInfo()?.channel ?? "stable",
    remember: (v) => setSetting(db, "update_announced", v),
    ...(fakeUpdate ? { launch: () => undefined } : {}),
    busy: () => busyWork(),
  });
  // What a restart would cut off: Ember answering in the Lair, War Room tasks, and (for the
  // Premium package's reload) a job or build step running.
  async function busyWork(withJobs = false): Promise<string[]> {
    const answering = (
      await db
        .select({ id: tables.conversationActivity.id })
        .from(tables.conversationActivity)
        .where(
          and(
            eq(tables.conversationActivity.status, "running"),
            eq(tables.conversationActivity.kind, "ai"),
          ),
        )
    ).length;
    const tasks = engine?.store.runningCount() ?? 0;
    return [
      ...(answering
        ? [
            answering === 1
              ? "Ember answering a question"
              : `Ember answering ${answering} questions`,
          ]
        : []),
      ...(tasks ? [tasks === 1 ? "a running agent task" : `${tasks} running agent tasks`] : []),
      ...(withJobs ? await runningJobs() : []),
    ];
  }
  async function runningJobs(): Promise<string[]> {
    const n = (await jobs.list(100, ["running"]).catch(() => [])).length;
    return n ? [n === 1 ? "a job or build step running" : `${n} jobs running`] : [];
  }
  if (!config.demo || fakeUpdate) updates.start();
  app.addHook("onClose", async () => updates.stop());
  app.get("/api/updates", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return updates.state();
  });
  app.post("/api/updates/check", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    await updates.check();
    return updates.state();
  });
  // Check for updates (Settings, About): off, Hearth never asks GitHub on its own.
  app.post("/api/updates/auto", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const { on } = z
      .object({ on: z.boolean() })
      .strict()
      .parse(request.body ?? {});
    await setSetting(db, "update_check_auto", on);
    await recordAudit(db, {
      actor: "you",
      action: on ? "Turned on Check for updates" : "Turned off Check for updates",
      target: "updates",
    });
    return updates.state();
  });
  // Release channel (Settings, About): stable, or fast (every release as soon as it is out).
  app.post("/api/updates/channel", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const { channel } = z
      .object({ channel: z.enum(["stable", "fast"]) })
      .strict()
      .parse(request.body ?? {});
    await setSetting(db, "update_channel", channel);
    await recordAudit(db, {
      actor: "you",
      action:
        channel === "fast"
          ? "Switched to the fast release channel"
          : "Switched to the stable release channel",
      target: "updates",
    });
    await updates.check();
    return updates.state();
  });
  app.post("/api/updates/install", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const { anyway } = z.object({ anyway: z.boolean().optional() }).parse(request.body ?? {});
    return updates.install({ anyway });
  });

  // The War Room's engine: the real Claude Code and Codex, working on this machine.
  if (engine) registerEngine(app, engine, voice);
  // Old notes are checked against your real systems, never against sample data.
  const imports = new Imports(handle, memory, async () => {
    const ws = await loadWorkspace(db, { demo: config.demo });
    return { real: ws.environment === "real", hosts: ws.hosts, services: ws.services };
  });
  // Ember: answers from records, inside the jurisdiction, within the budget.
  const jurisdiction = new Jurisdiction(handle);
  const aiUsage = new AiUsage(handle);
  // Issues & ideas: the owner's to-do list, checked against what monitoring sees.
  const todos = new Todos(handle, () => loadWorkspace(db, { demo: config.demo }));
  // Interactive workspaces: panels Ember fills with a task's data (feature request 20).
  // Images attached to messages (feature request 19): stored here, limits in ATTACHMENT_LIMITS.
  const attachments = new Attachments(handle);
  void attachments.prune().catch(() => undefined);
  registerAttachmentRoutes(app, attachments);
  registerCaptureFolderRoutes(app, db);

  // Your picture: shown in your circle in conversations and beside your name.
  // A small square image made in the browser; checked to really be an image.
  const AVATAR_MAX = 300 * 1024;
  app.put(
    "/api/owner/avatar",
    { bodyLimit: Math.ceil(AVATAR_MAX * 1.4) + 4096 },
    async (request) => {
      const { data } = z
        .object({ data: z.string().min(1) })
        .strict()
        .parse(request.body);
      const picture = checkedPicture(data, AVATAR_MAX);
      const at = new Date().toISOString();
      await setSetting(db, "owner_avatar", picture);
      await setSetting(db, "owner_avatar_at", at);
      return { at };
    },
  );
  app.delete("/api/owner/avatar", async (_request, reply) => {
    await db.delete(tables.settings).where(eq(tables.settings.key, "owner_avatar"));
    await db.delete(tables.settings).where(eq(tables.settings.key, "owner_avatar_at"));
    return reply.code(204).send();
  });
  app.get("/api/owner/avatar", async (_request, reply) => {
    const a = await getSetting(db, "owner_avatar");
    if (!a) throw new NotFoundError("No picture set.");
    return reply
      .header("content-type", a.mime)
      .header("cache-control", "private, max-age=31536000, immutable")
      .header("x-content-type-options", "nosniff")
      .send(Buffer.from(a.data, "base64"));
  });

  // Your AI's own picture ("Choose from your library"): stored and checked the same way as yours,
  // served from one fixed address that a voice profile may point at.
  app.put("/api/ai/avatar", { bodyLimit: Math.ceil(AVATAR_MAX * 1.4) + 4096 }, async (request) => {
    const { data } = z
      .object({ data: z.string().min(1) })
      .strict()
      .parse(request.body);
    const picture = checkedPicture(data, AVATAR_MAX);
    const at = new Date().toISOString();
    await setSetting(db, "ai_avatar", picture);
    await setSetting(db, "ai_avatar_at", at);
    await recordAudit(db, {
      actor: "you",
      action: "Gave your AI its own picture",
      target: "voice",
    });
    return { at };
  });
  app.delete("/api/ai/avatar", async (_request, reply) => {
    // Profiles that used it go back to their archetype's own picture.
    await voice.dropAvatar(AI_AVATAR_PATH);
    await deleteSetting(db, "ai_avatar");
    await deleteSetting(db, "ai_avatar_at");
    await recordAudit(db, {
      actor: "you",
      action: "Removed your AI's own picture",
      target: "voice",
    });
    return reply.code(204).send();
  });
  app.get("/api/ai/avatar", async (_request, reply) => {
    const a = await getSetting(db, "ai_avatar");
    if (!a) throw new NotFoundError("No picture set.");
    return (
      reply
        .header("content-type", a.mime)
        // One fixed address for whichever picture is current, so it is checked each time.
        .header("cache-control", "private, no-cache")
        .header("x-content-type-options", "nosniff")
        .send(Buffer.from(a.data, "base64"))
    );
  });
  const workspaces = new Workspaces(handle);
  void workspaces.prune().catch(() => undefined);
  // Stage 2: submitted decisions become plans; each item is checked against its snapshot first.
  const workspacePlans = new WorkspacePlans(handle, workspaces, jobs);
  jobs.itemCheck = (job, step) => workspacePlans.check(job, step);
  agents.cave = {
    memory,
    backups: () => backups.status(),
    jurisdiction,
    usage: aiUsage,
    jobs,
    imports,
    todos,
    workspaces,
    workspacePlans,
    attachments,
    admin,
    findings,
  };
  registerAdminRoutes(app, admin, (request) =>
    Boolean(request.session && auth.recentlyVerified(request.session)),
  );
  await agents.recoverInterrupted();
  // A job running when Hearth stopped is marked interrupted, never resumed by itself.
  await jobs.recoverInterrupted();
  app.addHook("onClose", () => jobs.close());
  // A plan proposed in a conversation posts its result there when it ends.
  // A repair that worked, confirmed by a recheck, is remembered in the journal.
  findings.remember = async (f) => {
    // Incident repairs write their own journal entry when they are verified.
    if (f.source === "monitor") return;
    await memory.recordSystem(db, {
      title: `Fixed: ${f.title}`,
      body: `${f.summary} ${f.resolution ?? ""} (finding F-${f.number}).`.trim(),
      happenedAt: f.resolvedAt ?? new Date().toISOString(),
      links: [{ label: `Finding F-${f.number}`, ref: `finding:${f.id}` }],
    });
  };
  jobs.onFinished = (id) => {
    void agents.postJobResult(id).catch(() => undefined);
    // A plan linked to a finding: its result goes in the finding, then Hearth rechecks.
    void findings.jobFinished(id).catch(() => undefined);
  };
  jobs.onChange = () => {
    notifier.kick();
    // Items follow the plans made for them (waiting, running, failed).
    void todos.reconcile().catch(() => undefined);
  };
  registerTodoRoutes(app, todos);
  registerFindingRoutes(app, handle, findings, todos);
  // Browser tests only: the simulated RAID machine starts over (DC_FAKE_RAID, never a real install).
  if (raidOps.simulated)
    app.post("/api/test/fake-raid", async (request) => {
      const q = request.query as { windows?: string };
      await raidOps.resetSample({ windows: q.windows === "1" });
      return { ok: true };
    });
  // Browser tests only: exists when stand-in apps are switched on, never in a real install.
  if (fakeApps) {
    app.get("/api/test/fake-apps", async () => fakeApps.state());
    app.post("/api/test/fake-apps", async (request) => {
      const body = z
        .object({
          reset: z.boolean().optional(),
          resize: z.object({ id: z.number().int(), gb: z.number() }).strict().optional(),
          failDelete: z.number().int().optional(),
          jellyfinArrival: z.union([z.boolean(), z.string().max(80)]).optional(),
          absArrival: z.string().max(80).optional(),
          /** For You starts over: no hidden titles, no kept lists (desktop and phone runs share it). */
          forYouReset: z.boolean().optional(),
          immichAlbums: z.number().int().min(1).max(30).optional(),
          manualTorrents: z.boolean().optional(),
          plexNewReleases: z.boolean().optional(),
          plexKidsTv: z.boolean().optional(),
          plexFamily: z.boolean().optional(),
          zoneminder: z.object({ eventsFail: z.boolean().optional() }).strict().optional(),
          panelIntake: z
            .object({
              /** The stand-in service is down for this panel id only (or back up). */
              downFor: z.string().max(120).optional(),
              upFor: z.string().max(120).optional(),
              /** Act as a Free install for this app only (tests run side by side). */
              freeService: z.string().max(80).optional(),
            })
            .strict()
            .optional(),
          home: z
            .object({
              condition: z.string().max(40).optional(),
              sunUp: z.boolean().optional(),
              down: z.boolean().optional(),
              ring: z.boolean().optional(),
              musicAssistant: z.boolean().optional(),
              livingRoom: z.boolean().optional(),
              googleSignInAgain: z.boolean().optional(),
              googleSignInLost: z.boolean().optional(),
            })
            .strict()
            .optional(),
          media: z
            .object({
              reset: z.boolean().optional(),
              moveDigital: z
                .object({ tmdbId: z.number().int(), days: z.number().int() })
                .strict()
                .optional(),
              arrive: z.number().int().optional(),
              pending: z.number().int().optional(),
              unmonitor: z.number().int().optional(),
              forget: z.number().int().optional(),
              have: z.object({ tmdbId: z.number().int(), on: z.boolean() }).strict().optional(),
            })
            .strict()
            .optional(),
        })
        .strict()
        .parse(request.body);
      const { panelIntake: intakeControl, forYouReset, ...rest } = body;
      if (forYouReset) {
        await db.delete(tables.settings).where(like(tables.settings.key, "for_you%"));
        // Seen it is shared with Curator's Discover, which hides what was seen.
        await db.delete(tables.settings).where(eq(tables.settings.key, "recommend_seen"));
      }
      // A reset first, so a reset sent with new settings keeps the new settings.
      // Not cleared by a reset: other tests running alongside reset the stand-ins too.
      if (intakeControl?.downFor) testIntake?.down(intakeControl.downFor, true);
      if (intakeControl?.upFor) testIntake?.down(intakeControl.upFor, false);
      if (intakeControl?.freeService) testFreeServices.add(intakeControl.freeService);
      fakeApps.control(rest);
      return fakeApps.state();
    });
    // A receipt the stand-in submission service signs for a panel (shared-file tests).
    app.post("/api/test/panel-receipt", async (request) => {
      const { spec } = z.object({ spec: z.record(z.string(), z.unknown()) }).parse(request.body);
      return { receipt: testIntake!.receiptFor(spec as never) };
    });
  }
  // Custom panels (Ember Panel Builder): drafts, Keep and Drop, install, and their live reads.
  // Free-plan submissions go to the submission service when one is set up (DC_PANEL_INTAKE_URL);
  // browser tests use a stand-in that can be told to fail.
  const testIntake = fakeApps ? fakeIntake() : undefined;
  // Tests only: the plan Panel Builder sees, so the free plan's lock can be tried end to end.
  const testFreeServices = new Set<string>();
  const panelIntake =
    testIntake?.intake ?? (config.panelIntakeUrl ? httpIntake(config.panelIntakeUrl) : undefined);
  const customPanels = new CustomPanels(handle, apps, {
    plan: async (serviceId) => {
      if (testFreeServices.has(serviceId)) return "free";
      return (await entitlements.has("panel_builder")) ? "premium" : "free";
    },
    requireBuilder: async (serviceId, what) => {
      if (testFreeServices.has(serviceId)) throw new PremiumRequiredError("panel_builder", what);
      await entitlements.require("panel_builder", what);
    },
    ...(panelIntake ? { intake: panelIntake } : {}),
    // Receipts are checked against the service's keys: the stand-in's in tests, else the keys a
    // release ships (none until the real service is deployed, so nothing unlocks through it).
    intakeKeys: () => testIntake?.keys ?? PANEL_INTAKE_KEYS,
    licence: () => entitlements.tokenFor("panel_builder"),
  });
  // The donation service's GitHub token, warned about 14 days ahead on the owner's issuing Hearth.
  if (panelIntake)
    findings.add(
      donationTokenAnalyzer(async () =>
        (await issuer.active()) ? panelIntake.health() : undefined,
      ),
    );
  // Custom panels' routes and Ember's panel_builder tool are Panel Builder's, in the Premium package.
  // Add-ons (the Premium package, 11-14): loaded before Ember's tool server so their tools join
  // hers. None installed is normal: the core is complete on its own.
  const addons = new Addons();
  const addonsDir =
    config.addonsDir ?? (config.dataDir ? path.join(config.dataDir, "addons") : undefined);
  await addons.load(addonsDir, {
    coreVersion: releaseVersion() ?? APP_VERSION,
    app,
    db: handle,
    has: (feature) => entitlements.has(feature),
    require: (feature, what) => entitlements.require(feature, what),
    log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) },
    signedIn: (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    },
    badRequest: (message) => new InvalidRequestError(message),
    settings: {
      get: async <T>(key: string) =>
        ((await db.select().from(tables.settings).where(eq(tables.settings.key, key)).get())
          ?.value ?? undefined) as T | undefined,
      set: async (key, value) => {
        const at = new Date().toISOString();
        await db
          .insert(tables.settings)
          .values({ key, value: value as never, updatedAt: at })
          .onConflictDoUpdate({
            target: tables.settings.key,
            set: { value: value as never, updatedAt: at },
          });
      },
      del: async (key) => {
        await db.delete(tables.settings).where(eq(tables.settings.key, key));
      },
    },
    services: async () =>
      (await db.select().from(tables.services))
        .filter((x) => x.lifecycle === "active")
        .map((x) => ({
          id: x.id,
          name: x.name,
          image: x.image ?? null,
          ...(appOf(x) ? { app: appOf(x) } : {}),
          demo: Boolean(x.checkTarget?.startsWith("demo:")),
        })),
    apps: {
      plexGet: (id, p, purpose) => apps.plexGet(id, p, purpose),
      tautulliGet: (id, cmd, params, purpose) => apps.tautulliGet(id, cmd, params, purpose),
    },
    ai: { suggest: (system, prompt) => agents.suggest(system, prompt) },
    panels: customPanels,
    show: (hooks) => {
      if (agents.cave) agents.cave.show = hooks;
    },
    connected: {
      ...connectedKit,
      ollama: engine
        ? {
            config: () => engine.ollamaConfig(),
            localOnly: (url: string) => ollamaIsLocalOnly(url),
            onChange: (fn: () => void) => {
              engine.onOllamaChange = fn;
            },
          }
        : undefined,
      onPcHello: (fn: (pcId: string) => void) => {
        connectedKit.pcs.onHello = fn;
      },
    },
    z,
    audit: (e) => recordAudit(db, { actor: "you", ...e }),
  });
  // An add-on's screens, imported by the web app (lib/addons.ts).
  for (const [name, root] of addons.webDirs)
    await app.register(fastifyStatic, { root, prefix: `/addons/${name}/`, decorateReply: false });
  app.get("/api/addons", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return { loaded: addons.loaded, skipped: addons.skipped };
  });
  registerMcp(app, { handle, runner, agents, demo: config.demo, addons });
  // Signed in to an app with no API key: its custom panel reads again straight away.
  apps.sessions.onSignedIn = (serviceId) => customPanels.forget(serviceId);
  // A submission continues the conversation as your message; waits briefly, the answer follows.
  registerWorkspaceRoutes(
    app,
    workspaces,
    (text, conversationId) =>
      agents.converse({ text, conversationId, source: "app", waitMs: 1000 }),
    { memory, db },
  );

  // The companion's check-in says what a briefing would open with.
  notifier.checkIn = async (since) =>
    (
      await buildBriefing(handle, memory, backups, {
        since,
        demo: config.demo,
        imports: () => imports.readiness(),
      })
    ).opening;
  registerMemory(app, {
    handle,
    memory,
    imports,
    backups,
    auth,
    keyDir: config.keyDir,
    demo: config.demo,
  });

  // A compact summary for Home Assistant sensors and dashboards (needs a "read" key or a session).
  app.get("/api/status", async () => {
    const ws = await loadWorkspace(db, { demo: config.demo });
    const open = ws.incidents.filter((i) => i.status !== "resolved");
    return {
      installation: ws.instanceName,
      sampleData: ws.environment === "demo",
      healthy: open.length === 0 && ws.services.every((s) => s.health === "healthy"),
      servicesTotal: ws.services.length,
      servicesDown: ws.services
        .filter((s) => s.health === "offline" && !s.stopped)
        .map((s) => s.name),
      needsYou: open.filter((i) => i.status === "open" || i.status === "awaiting-approval").length,
      // A proposal waiting for you carries what approving it needs (see docs/HOME_ASSISTANT.md).
      openIncidents: open.map((i) => ({
        id: i.id,
        title: i.title,
        status: i.status,
        ...(i.approval ? { proposedAction: i.proposedAction, approval: i.approval } : {}),
      })),
      lastCheckAt: ws.monitoring.lastRunAt ?? null,
    };
  });

  // Conversations with the AI operator: typed in the app, or relayed by Home Assistant (Belle).
  app.post("/api/agent/conversations", async (request) => {
    const body = schemas.converse.parse(request.body);
    // Images are attached in the app only; access keys (Home Assistant, companions) cannot send them.
    if (request.key && body.attachments?.length)
      throw new InvalidRequestError("Images can only be attached in the Hearth app.");
    return agents.converse({
      attachments: body.attachments,
      text: body.text,
      conversationId: body.conversationId,
      projectId: body.projectId,
      ...(body.look && !request.key ? { look: body.look } : {}),
      ...(body.title && !request.key ? { title: body.title } : {}),
      focus: body.focus,
      source: request.key ? (body.source === "voice" ? "voice" : "api") : "app",
      waitMs: (body.wait ?? (request.key ? 25 : 120)) * 1000,
      lastVisit: body.lastVisit,
      spoken: request.key ? undefined : body.spoken,
      ...(body.followUp && !request.key ? { followUp: true } : {}),
    });
  });

  /* ---------- Getting started and Meet Ember (you, signed in) ---------- */
  /* ---------- Help me build: the homelab plan (you, signed in; plans only, installs nothing) ---------- */
  let scanned: { at: number; scan: HostScan } | undefined;
  const hostScan = async (fresh = false) => {
    if (!fresh && scanned && Date.now() - scanned.at < 5 * 60_000) return scanned.scan;
    // Only the owner's own systems count as already running here: sample data is made up, and
    // naming it would tell a beginner they have apps they don't.
    const real = (await getSetting(db, "environment")) === "real";
    const names = real
      ? (
          await db
            .select({ name: tables.services.name })
            .from(tables.services)
            .where(eq(tables.services.lifecycle, "active"))
        ).map((s) => s.name)
      : [];
    // Tests and safe previews scan a made-up machine, like discovery does.
    const scan =
      process.env.DC_FAKE_DISCOVERY === "1" ? fakeHostScan(names) : await scanHost(names);
    scanned = { at: Date.now(), scan };
    return scan;
  };
  const planOwner = (request: { session?: unknown }) => {
    if (!request.session)
      throw new ForbiddenAuthError("Only you can plan your homelab, signed in.");
  };
  const oneOf = <K extends keyof typeof BUILD_QUESTIONS>(k: K) =>
    z.enum(BUILD_QUESTIONS[k].options.map(([v]) => v) as [string, ...string[]]);
  const buildAnswers = z
    .object({
      wants: z.array(oneOf("wants")).max(12),
      devices: z.array(oneOf("devices")).max(12),
      experience: oneOf("experience").optional(),
      budget: oneOf("budget").optional(),
      pace: oneOf("pace").optional(),
      media: oneOf("media").optional(),
      existingServer: oneOf("existingServer").optional(),
      plexPass: oneOf("plexPass").optional(),
      plexServer: oneOf("plexServer").optional(),
      downloadSites: oneOf("downloadSites").optional(),
      importance: oneOf("importance").optional(),
      streams: oneOf("streams").optional(),
      quality: oneOf("quality").optional(),
      away: oneOf("away").optional(),
      existingVpn: oneOf("existingVpn").optional(),
      dedicated: oneOf("dedicated").optional(),
      priorities: z.array(oneOf("wants")).max(12).optional(),
    })
    .strict();
  /* ---------- Build my plan: the saved plan, built one approved step at a time ---------- */
  const homelab = new HomelabBuilder({
    handle,
    vault,
    elevation: admin.elevation,
    run: realRun,
    jobs: () => jobs,
    appsRoot: defaultAppsRoot(),
    install: installInfo(config.dataDir ?? config.keyDir, path.resolve(SERVER_ROOT, "../..")),
    // Hearth watches the apps it built: a scan, adopting them beside what it already watches.
    adopt: async (containers) => {
      const report = await runDiscovery(probes);
      const kept = new Set(
        (await db.select({ t: tables.services.checkTarget }).from(tables.services)).map((r) => r.t),
      );
      const pick = report.findings.filter(
        (f) => kept.has(f.key) || (f.source === "container" && containers.includes(f.sourceName)),
      );
      const named = new Map(
        (await db.select().from(tables.services)).map((r) => [r.checkTarget, r.name] as const),
      );
      await findings.exclusive(() =>
        adoptDiscovery(
          handle,
          report,
          pick.map((f) => ({ key: f.key, name: named.get(f.key) ?? f.name })),
        ),
      );
      const rows = await db.select().from(tables.services);
      return Object.fromEntries(
        containers.flatMap((c) => {
          const row = rows.find((r) => r.checkTarget === `container:${c}`);
          return row ? [[c, row.id] as const] : [];
        }),
      );
    },
    ...(process.env.DC_BUILD_TEST_NO_VPN === "1" ? { noVpnForTests: true } : {}),
  });
  homelabSteps.current = homelab;
  if (agents.cave) agents.cave.homelab = homelab;
  app.get("/api/plan/build", async (request) => {
    planOwner(request);
    return homelab.status();
  });
  app.post("/api/plan/build/propose", async (request) => {
    planOwner(request);
    const body = z
      .object({ step: z.enum(HOMELAB_STEP_IDS as [string, ...string[]]).optional() })
      .strict()
      .parse(request.body ?? {});
    return homelab
      .propose(body.step as HomelabStepId | undefined, {
        requestedBy: "you",
        conversationId: await homelab.conversation(),
      })
      .catch((e: unknown) => {
        throw new ConflictError(e instanceof Error ? e.message : String(e));
      });
  });
  // The owner closed the "everything is built" card (11-22): it does not come back.
  app.post("/api/plan/build/celebrated", async (request) => {
    planOwner(request);
    return homelab.celebrated();
  });
  // The owner checked a failed step's app and it works: a plan to mark it done (11-22).
  app.post("/api/plan/build/confirm", async (request) => {
    planOwner(request);
    const body = z
      .object({ step: z.enum(HOMELAB_STEP_IDS as [string, ...string[]]) })
      .strict()
      .parse(request.body ?? {});
    return homelab
      .confirm(body.step as HomelabStepId, {
        requestedBy: "you",
        conversationId: await homelab.conversation(),
      })
      .catch((e: unknown) => {
        throw new ConflictError(e instanceof Error ? e.message : String(e));
      });
  });
  // The VPN login for qBittorrent's VPN: straight into Secure Vault, never returned.
  app.put("/api/plan/build/vpn", async (request) => {
    planOwner(request);
    const body = z
      .object({
        provider: z.enum(Object.keys(VPN_PROVIDERS) as [string, ...string[]]),
        type: z.enum(["openvpn", "wireguard"]),
        username: z.string().trim().max(200).optional(),
        password: z.string().max(500).optional(),
        privateKey: z.string().trim().max(200).optional(),
        addresses: z.string().trim().max(200).optional(),
      })
      .strict()
      .parse(request.body);
    return homelab.saveVpn(body as Parameters<HomelabBuilder["saveVpn"]>[0]).catch((e: unknown) => {
      throw new InvalidRequestError(e instanceof Error ? e.message : String(e));
    });
  });
  // A fresh Tailscale sign-in link (the last one expired or was used).
  app.post("/api/plan/build/tailscale-link", async (request) => {
    planOwner(request);
    return { url: (await homelab.tailscaleLoginUrl()) ?? null };
  });
  // The hand-off: Ember greets the owner and starts building the plan with them.
  app.post("/api/plan/build/start", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Only you can start this, signed in.");
    const name = aiDisplayName(await getSetting(db, "ai_name"));
    if (!(await agents.operator()))
      throw new ConflictError(
        `Connect an AI service first (AI Agent page), so ${name} can build your plan with you.`,
      );
    const r = await agents.converse({
      text: "Let's build my homelab plan.",
      source: "app",
      waitMs: 1000,
      build: true,
    });
    await homelab.setConversation(r.conversationId);
    return r;
  });

  // The plan and, once allowed, the look at this machine. Nothing is scanned until asked.
  app.get("/api/plan", async (request) => {
    planOwner(request);
    const saved = (await getSetting(db, "homelab_plan")) ?? null;
    return { saved, scan: saved?.scan ?? scanned?.scan ?? null };
  });
  // The accounts the plan's apps will get. Email and username are kept as settings (they are
  // shown back); a password the owner chose goes straight into Secure Vault and is never
  // returned, logged, or shown to the AI. Nothing is created here: accounts are made when the
  // apps are built, with these details.
  app.get("/api/plan/accounts", async (request) => {
    planOwner(request);
    const a = await getSetting(db, "homelab_accounts");
    return a
      ? { email: a.email, username: a.username, passwords: a.passwords, savedAt: a.savedAt }
      : null;
  });
  app.put("/api/plan/accounts", async (request) => {
    planOwner(request);
    const body = z
      .object({
        email: z.string().trim().max(200).email("That doesn't look like an email address."),
        username: z
          .string()
          .trim()
          .regex(
            /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/,
            "Use 3 to 32 letters, numbers, dots, dashes, or underscores.",
          ),
        passwords: z.enum(["generate", "own"]),
        password: z.string().min(12, "Use at least 12 characters.").max(200).optional(),
      })
      .strict()
      .parse(request.body);
    const before = await getSetting(db, "homelab_accounts");
    let secretId: string | undefined;
    if (body.passwords === "own") {
      if (!body.password && !before?.secretId)
        throw new InvalidRequestError("Choose a password, or let Hearth make one for each app.");
      if (body.password) {
        if (before?.secretId) await vault.removeInternal(before.secretId).catch(() => undefined);
        secretId = (
          await vault.add({
            name: "Homelab apps: your password",
            kind: "login",
            tier: "automation",
            value: body.password,
            username: body.username,
            category: "Homelab plan",
            notes: `Used by Hearth to create your accounts (${body.email}) when it builds your homelab plan.`,
          })
        ).id;
      } else secretId = before?.secretId;
    } else if (before?.secretId) await vault.removeInternal(before.secretId).catch(() => undefined);
    await setSetting(db, "homelab_accounts", {
      email: body.email,
      username: body.username,
      passwords: body.passwords,
      ...(secretId ? { secretId } : {}),
      savedAt: new Date().toISOString(),
    });
    return { email: body.email, username: body.username, passwords: body.passwords };
  });

  // Start over: the plan and the look at the machine are forgotten; nothing else changes.
  app.delete("/api/plan", async (request, reply) => {
    planOwner(request);
    await db.delete(tables.settings).where(eq(tables.settings.key, "homelab_plan"));
    scanned = undefined;
    return reply.code(204).send();
  });
  // The owner said yes to "Can I look at this computer?": read only, nothing is changed.
  app.post("/api/plan/scan", async (request) => {
    planOwner(request);
    const scan = await hostScan(true);
    const saved = await getSetting(db, "homelab_plan");
    if (saved) await setSetting(db, "homelab_plan", { ...saved, scan });
    return scan;
  });
  app.put("/api/plan", async (request) => {
    planOwner(request);
    const body = z
      .object({
        answers: buildAnswers,
        chosen: z.record(z.string().max(40), z.string().max(40)).default({}),
        removed: z.array(z.string().max(40)).max(40).default([]),
        // Just the choice: when it was made is recorded here, not taken from the browser.
        decisions: z
          .record(z.string().max(64), z.enum(["include", "later", "accept"]))
          .refine((d) => Object.keys(d).length <= 40)
          .default({}),
        confirmed: z.boolean().default(false),
      })
      .strict()
      .parse(request.body);
    const before = await getSetting(db, "homelab_plan");
    const now = new Date().toISOString();
    const decisions = Object.fromEntries(
      Object.entries(body.decisions).map(([goal, choice]) => {
        const was = before?.decisions?.[goal];
        return [goal, { choice, at: was?.choice === choice ? was.at : now }];
      }),
    );
    const saved = {
      answers: body.answers as BuildAnswers,
      ...((before?.scan ?? scanned?.scan) ? { scan: before?.scan ?? scanned!.scan } : {}),
      chosen: body.chosen,
      removed: body.removed,
      decisions,
      // Once finished, it stays finished; going back to change an answer keeps it.
      confirmed: body.confirmed || Boolean(before?.confirmed),
      savedAt: new Date().toISOString(),
    };
    await setSetting(db, "homelab_plan", saved);
    // An informed override is kept on record: they were shown the risks and chose it anyway.
    const overrides = Object.entries(decisions).filter(
      ([goal, d]) => d.choice === "include" && before?.decisions?.[goal]?.choice !== "include",
    );
    if (overrides.length) {
      const words = saved.scan
        ? recommendBuild(saved.answers, saved.scan, saved.chosen, saved.removed, decisions)
            .requirements
        : [];
      for (const [goal] of overrides)
        await recordAudit(db, {
          actor: "you",
          action: `Chose to include "${
            words.find((r) => r.id === goal)?.wording ??
            // No look at the computer saved (they answered themselves): the wish's own words.
            BUILD_QUESTIONS.wants.options.find(([id]) => `want:${id}` === goal)?.[1] ??
            goal
          }" in your homelab plan anyway, after seeing the risks (plan only, nothing installed)`,
          target: "plan",
        });
    }
    if (body.confirmed && !before?.confirmed)
      await recordAudit(db, { actor: "you", action: "Saved your homelab plan", target: "plan" });
    return saved;
  });

  app.get("/api/getting-started", async () => {
    const [b, credentials] = await Promise.all([backups.status(), apps.broker.status()]);
    return loadGettingStarted(db, { backupCopy: Boolean(b.copyDir || b.offsite), credentials });
  });
  app.patch("/api/getting-started", async (request, reply) => {
    const change = z
      .object({
        dismiss: z.string().max(100).optional(),
        restore: z.string().max(100).optional(),
        hidden: z.boolean().optional(),
      })
      .strict()
      .parse(request.body ?? {});
    await updateGettingStarted(db, change);
    return reply.code(204).send();
  });
  // Meet Ember: the AI introduces itself and checks up on the server, read only. It needs the
  // operator connected (otherwise there is no one to meet yet), and only you can start it.
  app.post("/api/agent/meet", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Only you can start this, signed in.");
    const name = aiDisplayName(await getSetting(db, "ai_name"));
    if (!(await agents.operator()))
      throw new ConflictError(
        `Connect an AI service first (AI Agent page), so ${name} can look at your server.`,
      );
    // Its Getting started step ticks once the answer is given (Agents.converse), not before.
    return agents.converse({
      text: `Meet ${name}: please introduce yourself and check up on my server.`,
      source: "app",
      waitMs: 1000,
      meet: true,
    });
  });

  /* ---------- Voice: speak to Ember and hear it answer (you, signed in; never an access key) ---------- */
  const voiceProfile = z
    .object({
      id: z.string().regex(VOICE_PROFILE_ID, "Use lowercase letters, digits, and hyphens."),
      name: z
        .string()
        .trim()
        .max(40)
        .refine((v) => AI_NAME_PATTERN.test(v), {
          message: "Use letters, numbers, spaces, apostrophes, dots, or hyphens (up to 40).",
        }),
      voice: z.string().trim().regex(VOICE_NAME, "That is not a voice name."),
      persona: z.string().trim().max(VOICE_PERSONA_MAX),
      traits: z
        .object(
          Object.fromEntries(
            VOICE_TRAITS.map((t) => [t.key, z.number().int().min(0).max(3).optional()]),
          ),
        )
        .strict()
        .optional(),
      effect: z.enum(VOICE_EFFECT_IDS as [VoiceEffect, ...VoiceEffect[]]).optional(),
      // Built-in pictures, gallery looks, or your own uploaded one: never an outside address.
      avatar: z.string().regex(PROFILE_AVATAR, "That is not one of Hearth's pictures.").optional(),
      gender: z.enum(VOICE_GENDERS as [VoiceGender, ...VoiceGender[]]).optional(),
    })
    .strict();
  const voiceConfig = z
    .object({
      engine: z.enum(["builtin", "machine"]).optional(),
      host: z
        .string()
        .trim()
        .max(253)
        .refine(
          (v) => v === "" || /^[A-Za-z0-9.-]+$/.test(v),
          "A host name or IP address, no scheme or port.",
        ),
      sttPort: z.number().int().min(1).max(65535),
      ttsPort: z.number().int().min(1).max(65535),
      profiles: z.array(voiceProfile).max(VOICE_PROFILE_LIMIT),
      active: z.string().max(40).optional(),
    })
    .strict();
  const voiceOwner = (request: { session?: unknown }) => {
    if (!request.session) throw new ForbiddenAuthError("Voice is only for you, signed in.");
  };
  // Hearth's Standard voice for Home Assistant (Wyoming), when the owner turns it on.
  const voiceShare = new VoiceShare(handle, {
    // DC_VOICE_SHARE_PORT=0 (browser tests) takes any free port.
    port: process.env.DC_VOICE_SHARE_PORT
      ? Number(process.env.DC_VOICE_SHARE_PORT)
      : DEFAULT_SHARE_PORT,
    version: releaseVersion() ?? APP_VERSION,
    speak: (text) => voice.standardPcm(text),
  });
  void voiceShare.resume();
  app.addHook("onClose", async () => voiceShare.close());
  app.get("/api/voice/share", async (request) => {
    voiceOwner(request);
    return voiceShare.state();
  });
  app.put("/api/voice/share", async (request) => {
    voiceOwner(request);
    const on = z.object({ on: z.boolean() }).parse(request.body).on;
    return voiceShare.set(on);
  });
  app.get("/api/voice", async (request) => {
    voiceOwner(request);
    const [status, facts] = await Promise.all([
      voice.status(),
      machineFacts(config.dataDir ?? config.keyDir),
    ]);
    const name = aiDisplayName(await getSetting(db, "ai_name"));
    return { ...status, machine: voiceLevel(facts, name) };
  });
  app.put("/api/voice", async (request, reply) => {
    voiceOwner(request);
    const config = voiceConfig.parse(request.body) as VoiceConfig;
    // A built-in voice keeps its own gender. Any picture goes with any voice: the owner chooses
    // the voice, then the appearance (the owner, 2026-10-16).
    config.profiles = config.profiles.map((p) =>
      p.gender ? p : { ...p, gender: defaultGenderFor(p.id) },
    );
    const was = await personaKey(db);
    await voice.save(config);
    // A new profile (or picture) can change how Ember talks: live sessions pick it up.
    if ((await personaKey(db)) !== was)
      void agents.remote?.refresh("Ember's voice profile changed.").catch(() => undefined);
    return reply.code(204).send();
  });
  // Raw 16-bit mono PCM from the browser's microphone; two minutes at 16 kHz is under 4 MB.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: 6 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );
  app.post<{ Querystring: { rate?: string } }>("/api/voice/transcribe", async (request) => {
    voiceOwner(request);
    const rate = Number(request.query.rate ?? VOICE_RECORD_RATE);
    if (!Number.isInteger(rate) || rate < 8000 || rate > 48000)
      throw new InvalidRequestError("The recording's sample rate is not supported.");
    if (!Buffer.isBuffer(request.body))
      throw new InvalidRequestError("Send the recording as audio.");
    return { text: await voice.transcribe(request.body, rate) };
  });
  // Standard voice: start getting it ready (it downloads once, by itself; progress in GET /api/voice).
  app.post("/api/voice/builtin/release", async (request) => {
    voiceOwner(request);
    return voice.releaseBuiltin() ?? { state: "missing" };
  });
  app.post("/api/voice/builtin/prepare", async (request) => {
    voiceOwner(request);
    return voice.prepareBuiltin() ?? { state: "missing" };
  });
  // Setting voice up from here: find speech services, use one, or set one up on this computer.
  app.get("/api/voice/setup", async (request) => {
    voiceOwner(request);
    return voiceAssist.state();
  });
  app.post("/api/voice/setup/find", async (request) => {
    voiceOwner(request);
    return { found: await voiceAssist.find() };
  });
  app.post("/api/voice/setup/use", async (request, reply) => {
    voiceOwner(request);
    const { host } = z
      .object({ host: z.string().min(1).max(253) })
      .strict()
      .parse(request.body);
    await voiceAssist.use(host);
    return reply.code(204).send();
  });
  app.post("/api/voice/setup/install", async (request) => {
    voiceOwner(request);
    return voiceAssist.install();
  });
  app.post("/api/voice/speak", async (request, reply) => {
    voiceOwner(request);
    const body = z
      .object({ text: z.string().min(1).max(8000), profile: z.string().max(40).optional() })
      .strict()
      .parse(request.body);
    const audio = await voice.speak(body.text, body.profile);
    return reply.type("audio/wav").header("cache-control", "no-store").send(audio);
  });

  /* ---------- Ember: jurisdiction and AI usage (yours to set; never the AI's) ---------- */
  app.get("/api/jurisdiction", async () => jurisdiction.list());
  app.post("/api/jurisdiction", async (request) =>
    jurisdiction.add(schemas.jurisdiction.parse(request.body)),
  );
  app.delete<{ Params: { id: string } }>("/api/jurisdiction/:id", async (request, reply) => {
    await jurisdiction.remove(request.params.id);
    return reply.code(204).send();
  });
  app.get("/api/ai/usage", async () => aiUsage.report());
  app.patch("/api/ai/budget", async (request) => {
    const patch = schemas.aiBudget.parse(request.body);
    const next = await aiUsage.setBudget(patch);
    await recordAudit(db, {
      actor: "you",
      action: "Changed the AI limit",
      target: "ai-budget",
      detail: patch as Record<string, unknown>,
    });
    return next;
  });
  // "Turn on persona" (Ember Personas design, 11-07): Ember talks as her chosen picture.
  // Only how she talks: the rules, approvals and Full access never depend on it.
  app.get(
    "/api/agent/look-persona",
    async () => (await getSetting(db, "look_persona")) ?? { on: false },
  );
  app.put("/api/agent/look-persona", async (request) => {
    const next = z
      .object({ on: z.boolean(), own: z.string().max(LOOK_PERSONA_MAX).optional() })
      .strict()
      .parse(request.body);
    const own = next.own?.trim();
    const saved = { on: next.on, ...(own ? { own } : {}) };
    const was = await personaKey(db);
    await setSetting(db, "look_persona", saved);
    if ((await personaKey(db)) !== was)
      void agents.remote?.refresh("Ember's persona changed.").catch(() => undefined);
    await recordAudit(db, {
      actor: "you",
      action: next.on ? "Turned on Ember's persona" : "Turned off Ember's persona",
      target: "cave-personality",
      detail: { on: next.on, own: Boolean(own) },
    });
    return saved;
  });
  // How Ember talks. Only its manner: the rules it follows never depend on it.
  app.get("/api/agent/personality", async () => agents.personality());
  app.put("/api/agent/personality", async (request) => {
    const next = z
      .object({
        enthusiasm: z.enum(["calm", "warm", "lively"]),
        humor: z.enum(["none", "light", "playful"]),
        detail: z.enum(["simple", "balanced", "deep"]),
      })
      .strict()
      .parse(request.body);
    await setSetting(db, "cave_personality", next);
    await recordAudit(db, {
      actor: "you",
      action: "Changed how Ember talks",
      target: "cave-personality",
      detail: { ...next },
    });
    return next;
  });
  app.get<{ Querystring: { projectId?: string } }>("/api/agent/conversations", async (request) =>
    agents.conversations({ projectId: request.query.projectId || undefined }),
  );
  // "Where did we talk about this?" (Thread Looks, 11-17): every conversation's words, searched on
  // this Hearth alone. No AI, so no tokens; Ember uses it too (hearth_api).
  app.get<{ Querystring: { q?: string } }>("/api/agent/conversations/search", async (request) => {
    const q = z
      .string()
      .trim()
      .min(2)
      .max(200)
      .parse(request.query.q ?? "");
    return agents.searchConversations(q);
  });
  // The main conversation the hub on Home continues (made on first use).
  // Saved desktop layouts (you only: not open to access keys).
  const layoutBody = z
    .object({
      name: z.string().trim().min(1).max(60),
      panels: z.string().max(2000),
      dock: z
        .object({
          width: z.number().int().min(200).max(4000).optional(),
          mode: z.enum(["docked", "min", "wide"]).optional(),
        })
        .strict()
        .optional(),
    })
    .strict();
  /* ---------- Copying another Hearth's layout (layout/copy.ts) ---------- */
  const layoutCopy = new LayoutCopy(handle);
  const layoutParts = z
    .array(z.enum(["lair", "home", "look", "sidebar"]))
    .min(1)
    .max(4);
  const layoutCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof LayoutError) throw new ConflictError(e.message);
      throw e;
    }
  };
  const layoutOwner = (request: { session?: Session | null }) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    if (request.session.method === "home")
      throw new ForbiddenAuthError("This is a home tablet: its layout is its own.");
  };
  // The layout last arranged in a browser here, kept for another Hearth to read.
  app.put("/api/layout/browser", async (request) => {
    layoutOwner(request);
    const body = z
      .object({ values: z.record(z.string().max(100), z.string().max(20_000)) })
      .strict()
      .parse(request.body);
    await layoutCopy.saveBrowser(body.values);
    return { ok: true };
  });
  // Another Hearth reads this one's layout: only with this Hearth's API key, and only the layout.
  app.post("/api/layout/share", async (request) => {
    const body = z
      .object({ key: z.string().min(10).max(200) })
      .strict()
      .parse(request.body);
    await auth.checkLinkKey(body.key, { userAgent: request.headers["user-agent"] });
    return layoutCopy.share();
  });
  app.post("/api/layout/find", async (request) => {
    layoutOwner(request);
    return { found: await findHearths() };
  });
  const fromBody = z
    .object({
      hubUrl: z.string().trim().min(4).max(300),
      key: z.string().trim().min(10).max(200),
      parts: layoutParts,
    })
    .strict();
  app.post("/api/layout/preview", async (request) => {
    layoutOwner(request);
    const b = fromBody.parse(request.body);
    return layoutCall(() => layoutCopy.preview(b.hubUrl, b.key, b.parts));
  });
  app.post("/api/layout/copy", async (request) => {
    layoutOwner(request);
    const b = fromBody.parse(request.body);
    return layoutCall(() => layoutCopy.copy(b.hubUrl, b.key, b.parts));
  });
  app.post("/api/layout/undo", async (request) => {
    layoutOwner(request);
    return layoutCall(() => layoutCopy.undo());
  });

  app.get("/api/desk/layouts", async () =>
    (
      await handle.db.select().from(tables.deskLayouts).orderBy(desc(tables.deskLayouts.updatedAt))
    ).map((l) => ({ ...l, dock: l.dock ?? undefined })),
  );
  app.post("/api/desk/layouts", async (request) => {
    const body = layoutBody.parse(request.body);
    const at = new Date().toISOString();
    // Saving under an existing name replaces that layout.
    const existing = (await handle.db.select().from(tables.deskLayouts)).find(
      (l) => l.name.toLowerCase() === body.name.toLowerCase(),
    );
    const id = existing?.id ?? randomUUID();
    if (existing) {
      await handle.db
        .update(tables.deskLayouts)
        .set({ name: body.name, panels: body.panels, dock: body.dock ?? null, updatedAt: at })
        .where(eq(tables.deskLayouts.id, id));
    } else {
      await handle.db.insert(tables.deskLayouts).values({
        id,
        name: body.name,
        panels: body.panels,
        dock: body.dock ?? null,
        createdAt: at,
        updatedAt: at,
      });
    }
    return { id, name: body.name, panels: body.panels, dock: body.dock, updatedAt: at };
  });
  app.delete<{ Params: { id: string } }>("/api/desk/layouts/:id", async (request, reply) => {
    const row = await handle.db
      .select({ id: tables.deskLayouts.id })
      .from(tables.deskLayouts)
      .where(eq(tables.deskLayouts.id, request.params.id))
      .get();
    if (!row) throw new NotFoundError("No such layout.");
    await handle.db.delete(tables.deskLayouts).where(eq(tables.deskLayouts.id, row.id));
    return reply.code(204).send();
  });

  // Workspace groups (you only: not open to access keys). A group is saved while you work in it
  // and minimized when you leave the command center; nothing here submits, approves, or runs.
  const groupBody = z
    .object({
      name: z.string().trim().min(1).max(120),
      search: z.string().max(4000),
      conversationId: z.string().max(200).nullable().optional(),
      view: z.record(z.string().max(200), z.unknown()).optional(),
      unsent: z.number().int().min(0).max(100000).optional(),
    })
    .strict();
  const toGroup = (g: typeof tables.deskGroups.$inferSelect) => ({
    id: g.id,
    name: g.name,
    search: g.search,
    ...(g.conversationId ? { conversationId: g.conversationId } : {}),
    view: g.view ?? {},
    unsent: g.unsent,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  });
  // Conversation mode's floating panels, one layout per conversation.
  const talkKey = (key: string) => {
    if (!/^[A-Za-z0-9:_-]{1,100}$/.test(key)) throw new InvalidRequestError("Not a layout key.");
    return key;
  };
  app.get<{ Params: { key: string } }>("/api/talk/layouts/:key", async (request) => {
    const row = await handle.db
      .select()
      .from(tables.talkLayouts)
      .where(eq(tables.talkLayouts.key, talkKey(request.params.key)))
      .get();
    return row ? { layout: row.layout, updatedAt: row.updatedAt } : { layout: null };
  });
  app.put<{ Params: { key: string } }>("/api/talk/layouts/:key", async (request) => {
    const key = talkKey(request.params.key);
    const body = z
      .object({ layout: z.record(z.string(), z.unknown()) })
      .strict()
      .parse(request.body);
    if (JSON.stringify(body.layout).length > 32 * 1024)
      throw new InvalidRequestError("Too much layout to keep (32 KB).");
    const at = new Date().toISOString();
    await handle.db
      .insert(tables.talkLayouts)
      .values({ key, layout: body.layout, updatedAt: at })
      .onConflictDoUpdate({
        target: tables.talkLayouts.key,
        set: { layout: body.layout, updatedAt: at },
      });
    return { updatedAt: at };
  });
  app.get("/api/desk/groups", async () =>
    (
      await handle.db.select().from(tables.deskGroups).orderBy(desc(tables.deskGroups.updatedAt))
    ).map(toGroup),
  );
  app.put<{ Params: { id: string } }>("/api/desk/groups/:id", async (request) => {
    const id = request.params.id;
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new InvalidRequestError("Not a group id.");
    const body = groupBody.parse(request.body);
    if (JSON.stringify(body.view ?? {}).length > 64 * 1024)
      throw new InvalidRequestError("Too much view state for one group (64 KB).");
    const at = new Date().toISOString();
    const existing = await handle.db
      .select({ id: tables.deskGroups.id })
      .from(tables.deskGroups)
      .where(eq(tables.deskGroups.id, id))
      .get();
    const values = {
      name: body.name,
      search: body.search,
      conversationId: body.conversationId ?? null,
      view: body.view ?? {},
      unsent: body.unsent ?? 0,
      updatedAt: at,
    };
    if (existing) {
      await handle.db.update(tables.deskGroups).set(values).where(eq(tables.deskGroups.id, id));
    } else {
      const count = (await handle.db.select({ id: tables.deskGroups.id }).from(tables.deskGroups))
        .length;
      if (count >= 30)
        throw new InvalidRequestError(
          "Thirty workspaces are kept already; close one you no longer need first.",
        );
      await handle.db.insert(tables.deskGroups).values({ id, createdAt: at, ...values });
    }
    return toGroup(
      (await handle.db.select().from(tables.deskGroups).where(eq(tables.deskGroups.id, id)).get())!,
    );
  });
  app.delete<{ Params: { id: string } }>("/api/desk/groups/:id", async (request, reply) => {
    await handle.db.delete(tables.deskGroups).where(eq(tables.deskGroups.id, request.params.id));
    return reply.code(204).send();
  });

  // Home Rows (design "Home Rows: design for DC"): the owner's home-screen rows. Saving and
  // previewing change nothing on Plex; Apply and Undo are planned steps the owner approves.
  const homeRows = new HomeRows(
    handle,
    apps.broker,
    fakeApps?.fetch ?? (fetch as unknown as Fetch),
  );
  const plainly = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (e) {
      if (
        e instanceof Error &&
        e.constructor === Error // a plain reason in the owner's words, not a fault
      )
        throw new InvalidRequestError(e.message);
      throw e;
    }
  };
  app.get<{ Querystring: { serviceId?: string } }>("/api/home-rows", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return homeRows.list(request.query.serviceId ? String(request.query.serviceId) : undefined);
  });
  app.get<{ Querystring: { serviceId?: string } }>("/api/home-rows/options", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return plainly(() => homeRows.options(String(request.query.serviceId ?? "")));
  });
  app.get<{ Querystring: { serviceId?: string; libraryId?: string; q?: string } }>(
    "/api/home-rows/search",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const q = request.query;
      return plainly(() =>
        homeRows.search(String(q.serviceId ?? ""), String(q.libraryId ?? ""), String(q.q ?? "")),
      );
    },
  );
  // Saved home screens: save what Plex shows now under a name; switching is an approved plan.
  app.get<{ Querystring: { serviceId?: string } }>("/api/home-rows/layouts", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return homeRows.layouts(String(request.query.serviceId ?? ""));
  });
  app.post("/api/home-rows/layouts", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const b = (request.body ?? {}) as { serviceId?: string; name?: string; id?: string };
    return plainly(() =>
      homeRows.saveLayout(
        String(b.serviceId ?? ""),
        String(b.name ?? ""),
        b.id ? String(b.id) : undefined,
      ),
    );
  });
  app.patch<{ Params: { id: string } }>("/api/home-rows/layouts/:id", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const b = (request.body ?? {}) as { name?: string };
    await plainly(() => homeRows.renameLayout(request.params.id, String(b.name ?? "")));
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>("/api/home-rows/layouts/:id", async (request, reply) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    await homeRows.removeLayout(request.params.id);
    return reply.code(204).send();
  });
  app.get<{
    Querystring: {
      serviceId?: string;
      libraryId?: string;
      row?: string;
      title?: string;
      with?: string;
      count?: string;
    };
  }>("/api/home-rows/posters", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const q = request.query;
    return plainly(() =>
      homeRows.posters(
        String(q.serviceId ?? ""),
        String(q.libraryId ?? ""),
        String(q.row ?? ""),
        String(q.title ?? "").slice(0, 200),
        String(q.with ?? "")
          .split(",")
          .filter(Boolean)
          .slice(0, 20),
        Number(q.count) || 10,
      ),
    );
  });
  // Plex's Continue Watching, across every library, as its Home shows it (11-22).
  app.get<{ Querystring: { serviceId?: string; count?: string } }>(
    "/api/home-rows/continue",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return plainly(() =>
        homeRows.continueWatching(
          String(request.query.serviceId ?? ""),
          Number(request.query.count) || 24,
        ),
      );
    },
  );
  app.put("/api/home-rows/library-order", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const b = (request.body ?? {}) as { serviceId?: unknown; order?: unknown };
    return plainly(() => homeRows.setLibraryOrder(String(b.serviceId ?? ""), b.order));
  });
  // The whole library, searched forgivingly (the Forge's pick sheets, and Ember through hearth_api).
  app.get<{ Querystring: { serviceId?: string; q?: string; kind?: string; limit?: string } }>(
    "/api/home-rows/find",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const kind = request.query.kind;
      return plainly(() =>
        homeRows.find(
          String(request.query.serviceId ?? ""),
          String(request.query.q ?? ""),
          kind === "movie" || kind === "show" ? kind : "any",
          Number(request.query.limit) || 30,
        ),
      );
    },
  );
  /* ---------- The Forge: request a title a pick sheet doesn't have yet (11-07) ---------- */
  const awaiting = new ForgeAwaiting(
    db,
    workspaces,
    (serviceId, q, kind) => homeRows.find(serviceId, q, kind, 30),
    (text, conversationId) =>
      agents.converse({ text, conversationId, source: "app", waitMs: 1000 }),
    Date.now,
    async (name, plexServiceId) => {
      const row = (await homeRows.list(plexServiceId))
        .filter((r) => r.rules.titles && r.name === name)
        .at(-1);
      return row ? { id: row.id, name: row.name, titles: row.rules.titles! } : undefined;
    },
  );
  // Seerr's search, for titles that aren't in the library: the first Seerr Hearth knows.
  app.get<{ Querystring: { q?: string } }>("/api/forge/request-search", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const q = String(request.query.q ?? "")
      .trim()
      .slice(0, 200);
    const rows = await db.select().from(tables.services);
    const seerr = rows.find(
      (r) => appOf(r) === "seerr" && r.lifecycle !== "removed" && r.lifecycle !== "retired",
    );
    if (!seerr || q.length < 2) return { seerrServiceId: seerr?.id ?? null, results: [] };
    const r = (await apps.seerrPanel(seerr.id, "search", { query: q })) as {
      results?: unknown[];
    };
    return { seerrServiceId: seerr.id, results: (r.results ?? []).slice(0, 10) };
  });
  // Recommend, Discover (checklist 48.1): Ember suggests, Hearth checks each title is real and
  // whether you have it, and offers a request for the rest.
  const recommend = new Recommend({
    ask: (system, prompt) => agents.suggest(system, prompt),
    service: async (want) => {
      const found = (await db.select().from(tables.services)).filter(
        (x) => appOf(x) === want && x.lifecycle !== "removed" && x.lifecycle !== "retired",
      );
      // A real, active app before sample data or a paused one: that's the one that can request.
      const rank = (x: (typeof found)[number]) =>
        (x.checkTarget?.startsWith("demo:") ? 2 : 0) + (x.lifecycle === "active" ? 0 : 1);
      const r = found.sort((a, b) => rank(a) - rank(b))[0];
      return r ? { id: r.id, name: r.name } : undefined;
    },
    seerrSearch: async (id, query) =>
      ((await apps.seerrPanel(id, "search", { query })) as { results?: SeerrHit[] }).results ?? [],
    arr: (id, purpose, fn) => apps.arrRead(id, purpose, fn),
    seen: {
      list: async () => (await getSetting(handle.db, "recommend_seen")) ?? [],
      save: (all) => setSetting(handle.db, "recommend_seen", all),
    },
    // "In my library": the titles of a kind you have (names, years, genres; nothing else).
    library: async (kind) => {
      const rows = await db.select().from(tables.services);
      const real = (app: string) =>
        rows.filter(
          (x) =>
            appOf(x) === app && x.lifecycle === "active" && !x.checkTarget?.startsWith("demo:"),
        );
      const out: LibraryTitle[] = [];
      if (kind === "movie" || kind === "show") {
        for (const sv of real("plex")) {
          const c = await homeRows.catalog(sv.id).catch(() => undefined);
          for (const t of c?.titles ?? [])
            if (
              t.kind === kind &&
              !out.some((x) => sameTitle(x.title, t.title) && x.year === t.year)
            )
              out.push({
                title: t.title,
                ...(t.year ? { year: t.year } : {}),
                genres: t.genres,
                ...(t.thumb
                  ? {
                      image: `/api/services/${encodeURIComponent(sv.id)}/dashboard/art?path=${encodeURIComponent(t.thumb)}`,
                    }
                  : {}),
              });
        }
        // Jellyfin and Emby: their own library lists, a page at a time (at most 2,000 titles).
        for (const sv of [...real("jellyfin"), ...real("emby")]) {
          type Lib = {
            sections?: { id: string; type?: string }[];
            items?: { id: string; title: string; year?: number; poster?: boolean }[];
            total?: number;
          };
          const read = (q: Record<string, string | undefined>) =>
            apps.jellyfinPanel(sv.id, "library", q) as Promise<Lib>;
          try {
            const { sections = [] } = await read({});
            const want = kind === "show" ? "tvshows" : "movies";
            for (const sec of sections.filter((x) => x.type === want))
              for (let page = 1; page <= 34; page++) {
                const r = await read({ section: sec.id, page: String(page), sort: "title" });
                for (const t of r.items ?? [])
                  if (!out.some((x) => sameTitle(x.title, t.title) && x.year === t.year))
                    out.push({ title: t.title, ...(t.year ? { year: t.year } : {}) });
                if (!r.items?.length || page * 60 >= (r.total ?? 0)) break;
              }
          } catch {
            // A server that can't be read is left out.
          }
        }
        return out;
      }
      if (kind === "music") {
        for (const sv of real("lidarr"))
          await apps
            .arrRead(sv.id, "list artists for Curator", async (call) => {
              const r = await call<{ artistName?: string }[]>("GET", "/api/v1/artist");
              for (const a of Array.isArray(r.data) ? r.data : [])
                if (a.artistName) out.push({ title: a.artistName });
            })
            .catch(() => undefined);
        return out;
      }
      for (const sv of real("chaptarr"))
        await apps
          .arrRead(sv.id, "list books for Curator", async (call) => {
            const r = await call<
              {
                title?: string;
                mediaType?: string;
                releaseDate?: string;
                author?: { authorName?: string };
                statistics?: { bookFileCount?: number };
              }[]
            >("GET", "/api/v1/book");
            const want = kind === "audiobook" ? "audiobook" : "ebook";
            for (const b of Array.isArray(r.data) ? r.data : [])
              if (
                b.title &&
                (b.statistics?.bookFileCount ?? 0) > 0 &&
                (!b.mediaType || b.mediaType.toLowerCase() === want)
              )
                out.push({
                  title: b.title.replace(/\s*\([^)]*#\s*[\d.]+\)\s*$/, ""),
                  ...(Number(b.releaseDate?.slice(0, 4))
                    ? { year: Number(b.releaseDate!.slice(0, 4)) }
                    : {}),
                  ...(b.author?.authorName ? { creator: b.author.authorName } : {}),
                });
          })
          .catch(() => undefined);
      return out;
    },
    inLibrary: async (kind, title, year) => {
      const servers = (await db.select().from(tables.services)).filter((x) => {
        const a = appOf(x);
        return (
          (a === "plex" || jellyfinLike(a)) &&
          x.lifecycle === "active" &&
          !x.checkTarget?.startsWith("demo:")
        );
      });
      const same = (t: { title: string; year?: number }) =>
        sameTitle(t.title, title) && sameYear(t.year, year);
      for (const sv of servers) {
        if (appOf(sv) === "plex") {
          // The whole library, cached a few minutes (the same search Home rows uses).
          const r = await homeRows.find(sv.id, title, kind, 15).catch(() => undefined);
          if (r?.titles.some(same)) return true;
        }
      }
      // Jellyfin: its own library search.
      if (servers.some((sv) => jellyfinLike(appOf(sv))))
        return (await recommendServers(kind, title, "jellyfin")).some(same);
      return false;
    },
    onServers: (kind, title) => recommendServers(kind, title),
  });
  /** A movie or show searched by title on each Plex and Jellyfin (for Seen it and the library). */
  async function recommendServers(
    kind: "movie" | "show",
    title: string,
    only?: "plex" | "jellyfin",
  ): Promise<ServerHit[]> {
    type Lib = {
      sections?: { id: string; type?: string }[];
      items?: { id: string; title: string; year?: number; type?: string; watched?: boolean }[];
    };
    const servers = (await db.select().from(tables.services)).filter((x) => {
      const a = appOf(x);
      // Sample data has no real server to mark anything on.
      return (
        (only === "plex"
          ? a === "plex"
          : only === "jellyfin"
            ? jellyfinLike(a)
            : a === "plex" || jellyfinLike(a)) &&
        x.lifecycle === "active" &&
        !x.checkTarget?.startsWith("demo:")
      );
    });
    const hits: ServerHit[] = [];
    for (const sv of servers) {
      // Emby speaks Jellyfin's API: the same reads and the same plan steps.
      const app = appOf(sv) === "plex" ? ("plex" as const) : ("jellyfin" as const);
      const read = (q: Record<string, string | undefined>) =>
        (app === "plex"
          ? apps.plexPanel(sv.id, "library", q)
          : apps.jellyfinPanel(sv.id, "library", q)) as Promise<Lib>;
      const want =
        app === "plex"
          ? kind === "show"
            ? "show"
            : "movie"
          : kind === "show"
            ? "tvshows"
            : "movies";
      try {
        const { sections = [] } = await read({});
        for (const sec of sections.filter((x) => x.type === want)) {
          const { items = [] } = await read({ section: sec.id, q: title });
          for (const it of items)
            hits.push({
              serviceId: sv.id,
              server: sv.name,
              app,
              id: String(it.id),
              title: it.title,
              ...(it.year ? { year: it.year } : {}),
              watched: Boolean(it.watched),
            });
        }
      } catch {
        // A server that can't be read is skipped: it just isn't offered.
      }
    }
    return hits;
  }
  app.post("/api/recommend", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const b = z
      .object({
        kind: z.enum(RECOMMEND_KINDS),
        interest: z.string().trim().min(2).max(300),
        filters: z
          .object({
            fromYear: z.number().int().min(1870).max(2200).optional(),
            toYear: z.number().int().min(1870).max(2200).optional(),
            genres: z.array(z.string().max(40)).max(12).optional(),
            minRating: z.number().min(0).max(10).optional(),
            length: z.enum(["short", "medium", "long"]).optional(),
          })
          .strict()
          .optional(),
        exclude: z.array(z.string().max(200)).max(200).optional(),
        show: z.enum(RECOMMEND_SHOW).optional(),
        mode: z.enum(RECOMMEND_MODES).optional(),
        wide: z.boolean().optional(),
      })
      .strict()
      .parse(request.body);
    try {
      return await recommend.find(b);
    } catch (e) {
      if (e instanceof RecommendError) throw new InvalidRequestError(e.message);
      throw e;
    }
  });
  const seenBody = z
    .object({
      kind: z.enum(RECOMMEND_KINDS),
      title: z.string().trim().min(1).max(200),
      year: z.number().int().min(1800).max(2200).optional(),
      rating: z
        .object({
          stars: z.number().int().min(1).max(5).optional(),
          reaction: z.enum(RECOMMEND_REACTIONS).optional(),
          note: z.string().max(2000).optional(),
        })
        .strict()
        .optional(),
    })
    .strict();
  // "Seen it": remembered at once; marking it watched on Plex or Jellyfin is only offered.
  app.post("/api/recommend/seen", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    try {
      return await recommend.markSeen(seenBody.parse(request.body));
    } catch (e) {
      if (e instanceof RecommendError) throw new InvalidRequestError(e.message);
      throw e;
    }
  });
  app.post("/api/recommend/unseen", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    await recommend.unmarkSeen(seenBody.parse(request.body));
    return { ok: true };
  });
  /* ---------- Curator For You (11-13; free since 11-14): suggestions from the owner's own history ---------- */
  const forYou = new ForYou({
    servers: async () => {
      const rows = (await db.select().from(tables.services)).filter(
        (x) => x.lifecycle === "active",
      );
      // A real app before sample data.
      const first = (app: string) =>
        rows
          .filter((x) => appOf(x) === app)
          .sort(
            (a, b) =>
              Number(Boolean(a.checkTarget?.startsWith("demo:"))) -
              Number(Boolean(b.checkTarget?.startsWith("demo:"))),
          )[0];
      const plex = first("plex");
      // Tautulli only alongside a Plex of the same kind: sample data never reads for a real Plex.
      const demo = (x?: { checkTarget: string | null }) =>
        Boolean(x?.checkTarget?.startsWith("demo:"));
      const tautulli = rows.find((x) => appOf(x) === "tautulli" && demo(x) === demo(plex));
      return {
        ...(plex ? { plex: { id: plex.id, name: plex.name } } : {}),
        ...(tautulli ? { tautulli: { id: tautulli.id } } : {}),
      };
    },
    plexGet: (id, path, purpose) => apps.plexGet(id, path, purpose),
    tautulliGet: (id, cmd, params, purpose) => apps.tautulliGet(id, cmd, params, purpose),
    store: {
      get: async <T>(key: string) =>
        ((await db.select().from(tables.settings).where(eq(tables.settings.key, key)).get())
          ?.value ?? undefined) as T | undefined,
      set: async (key, value) => {
        const at = new Date().toISOString();
        await db
          .insert(tables.settings)
          .values({ key, value: value as never, updatedAt: at })
          .onConflictDoUpdate({
            target: tables.settings.key,
            set: { value: value as never, updatedAt: at },
          });
      },
      del: async (key) => {
        await db.delete(tables.settings).where(eq(tables.settings.key, key));
      },
    },
    ask: (system, prompt) => agents.suggest(system, prompt),
    // Your Seen it ratings steer the picks; Seen it here is Discover's own.
    rated: async () =>
      ((await getSetting(handle.db, "recommend_seen")) ?? []) as {
        kind: string;
        title: string;
        year?: number;
        rating?: { stars?: number; reaction?: string };
      }[],
    markSeen: (e) => recommend.markSeen(e as Parameters<typeof recommend.markSeen>[0]),
    seerr: async () => {
      const rows = (await db.select().from(tables.services)).filter(
        (x) => appOf(x) === "seerr" && x.lifecycle === "active",
      );
      const r = rows.sort(
        (a, b) =>
          Number(Boolean(a.checkTarget?.startsWith("demo:"))) -
          Number(Boolean(b.checkTarget?.startsWith("demo:"))),
      )[0];
      return r ? { id: r.id } : undefined;
    },
    similar: async (id, type, tmdbId) =>
      (
        (await apps.seerrPanel(id, "similar", { type, id: String(tmdbId) })) as {
          results?: SeerrTitle[];
        }
      ).results ?? [],
    seerrSearch: async (id, query) =>
      ((await apps.seerrPanel(id, "search", { query })) as { results?: SeerrTitle[] }).results ??
      [],
    // A vague ask: Discover's light, no-tools ask from your library's titles and genres only.
    vague: async (text, kind) =>
      (await recommend.find({ kind, interest: text, show: "both", mode: "discover" })).items,
  });
  const forYouPlainly = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ForYouError) throw new InvalidRequestError(e.message);
      throw e;
    }
  };
  app.get("/api/recommend/for-you", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return forYouPlainly(() => forYou.people());
  });
  app.post("/api/recommend/for-you/list", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const b = z
      .object({
        person: z.string().min(3).max(80),
        fresh: z.boolean().optional(),
        // More like this: one of your titles (Plex key) or a missing one (its TMDB key).
        seed: z
          .object({
            key: z.string().min(1).max(40).optional(),
            tmdb: z
              .string()
              .regex(/^(movie|tv):\d{1,9}$/)
              .optional(),
            title: z.string().max(200).optional(),
            genres: z.array(z.string().max(40)).max(8).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(request.body);
    return forYouPlainly(() => forYou.forPerson(b.person, b.fresh, b.seed));
  });
  // What should I watch?: plain filters run locally; only a vague ask goes to Ember (lean).
  app.post("/api/recommend/for-you/search", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const b = z
      .object({ person: z.string().min(3).max(80), text: z.string().trim().min(2).max(200) })
      .strict()
      .parse(request.body);
    return forYouPlainly(() => forYou.search(b.person, b.text));
  });
  // Seen it on a For You card: remembered with your rating; marking it watched is a plan.
  app.post("/api/recommend/for-you/seen", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const b = z
      .object({
        person: z.string().min(3).max(80),
        key: z.string().min(1).max(40),
        rating: z
          .object({
            stars: z.number().int().min(1).max(5).optional(),
            reaction: z.enum(RECOMMEND_REACTIONS).optional(),
            note: z.string().max(2000).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(request.body);
    return forYouPlainly(() => forYou.seen(b.person, b.key, b.rating));
  });
  app.post("/api/recommend/for-you/hide", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const b = z
      .object({ person: z.string().min(3).max(80), key: z.string().min(1).max(40) })
      .strict()
      .parse(request.body);
    return { ok: true, ...(await forYou.hide(b.person, b.key)) };
  });
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/awaiting", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return { awaiting: await awaiting.list(request.params.id) };
  });
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/awaiting", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const b = z
      .object({
        tmdbId: z.number().int().positive(),
        mediaType: z.enum(["movie", "tv"]),
        title: z.string().min(1).max(200),
        year: z.number().int().min(1870).max(2200).optional(),
      })
      .strict()
      .parse(request.body);
    return plainly(() => awaiting.add(request.params.id, b));
  });
  // The Crucible's keeper: every few minutes, new movies get their row's profile (approved with
  // the Crucible's plan; switchable in the panel).
  const crucibleLib = new MediaLibrary(apps.broker, fakeApps?.fetch ?? (fetch as unknown as Fetch));
  const crucibleKeeper = new CrucibleKeeper(
    handle,
    (service) => (method, path, purpose, body) =>
      crucibleLib.arr(service, method, path, purpose, body !== undefined ? { body } : {}),
    memory,
    Date.now,
    new SeerrOperations(handle, apps.broker, fakeApps?.fetch ?? (fetch as unknown as Fetch)),
    config.dataDir ?? config.keyDir,
  );
  void crucibleKeeper.syncMarker();
  // Near misses on their own (the Crucible, step 8): a small daily check, oldest missing first.
  const nearMisses = new NearMissWatch(handle, {
    radarrs: async () =>
      (await db.select().from(tables.services).all())
        .filter(
          (s) =>
            s.localUrl && appKindOf({ name: s.name, image: s.image ?? undefined }) === "radarr",
        )
        .map((s) => ({ id: s.id, name: s.name, localUrl: s.localUrl! })),
    arrFor: (service) => (method, path, purpose, body) =>
      crucibleLib.arr(service, method, path, purpose, body !== undefined ? { body } : {}),
    search: async (serviceId, movieId) =>
      (await apps.searchReleases(serviceId, { movieId })).nearMiss,
  });
  if (process.env.NODE_ENV === "production") {
    const nearMissTimer = setInterval(() => {
      void nearMisses
        .due()
        .then(async (due) => {
          if (due && (await nearMisses.settings()).perDay > 0) await nearMisses.check();
        })
        .catch((e: unknown) => console.warn("[crucible] near-miss check failed:", e));
    }, 60 * 60_000);
    nearMissTimer.unref();
    app.addHook("onClose", async () => clearInterval(nearMissTimer));
  }
  app.get("/api/crucible/near-misses", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return nearMisses.report();
  });
  // Hearth's own setting (how many a day, how long missing, the bell): no app changes.
  app.put("/api/crucible/near-misses/settings", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const body = z
      .object({
        perDay: z.number().int().min(0).max(50).optional(),
        minDays: z.number().int().min(0).max(365).optional(),
        notify: z.boolean().optional(),
      })
      .strict()
      .parse(request.body);
    return { settings: await nearMisses.setSettings(body) };
  });
  // Check now: the same daily budget, searched straight away (no download).
  app.post("/api/crucible/near-misses/check", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return nearMisses.check();
  });
  // The clean exit's preview (the uninstall dialog says what will happen first).
  app.get("/api/crucible/exit", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return crucibleKeeper.exitPreview();
  });
  if (process.env.NODE_ENV === "production") {
    const keeperTimer = setInterval(() => {
      crucibleKeeper
        .tick()
        .then((lines) => {
          if (lines.length) console.log(`[crucible] ${lines.join(" | ")}`);
        })
        .catch((e: unknown) => console.warn("[crucible] keeping new movies failed:", e));
    }, 5 * 60_000);
    keeperTimer.unref();
    app.addHook("onClose", async () => clearInterval(keeperTimer));
  }
  // Radarr's "On Movie Added" webhook (made by the Crucible's Save): sort the new movie at once,
  // so its first search uses its row's profile. No sign-in: the private key in the address,
  // which only that Radarr and Hearth know, is checked instead.
  app.post<{ Params: { id: string }; Querystring: { key?: string } }>(
    "/api/crucible/hook/:id",
    async (request, reply) => {
      const keys = (await getSetting(db, "crucible_hooks")) ?? {};
      const want = keys[request.params.id];
      const got = String(request.query.key ?? "");
      if (
        !want ||
        got.length !== want.length ||
        !timingSafeEqual(Buffer.from(got), Buffer.from(want))
      )
        return reply.code(404).send({ error: "Not found." });
      const body = (request.body ?? {}) as {
        eventType?: string;
        movie?: { id?: number };
        series?: { id?: number };
      };
      // Radarr's MovieAdded, or Sonarr's SeriesAdd (shows, step 9).
      const added =
        body.eventType === "MovieAdded"
          ? body.movie?.id
          : body.eventType === "SeriesAdd"
            ? body.series?.id
            : undefined;
      if (typeof added !== "number") return { ok: true };
      try {
        const line = await crucibleKeeper.added(request.params.id, added);
        if (line) console.log(`[crucible] ${line}`);
      } catch (e) {
        console.warn("[crucible] sorting a new movie failed (the 5-minute pass will retry):", e);
      }
      return { ok: true };
    },
  );
  // Browser tests run one pass on demand.
  if (fakeApps)
    app.post("/api/test/crucible-keep", async () => ({ lines: await crucibleKeeper.tick() }));
  // Every five minutes, a requested title that has arrived in Plex joins its sheet.
  if (process.env.NODE_ENV === "production") {
    const forgeTimer = setInterval(() => {
      awaiting
        .tick()
        .then((arrived) => {
          if (arrived.length) console.log(`[forge] arrived in Plex: ${arrived.join(", ")}`);
        })
        .catch((e: unknown) => console.warn("[forge] checking requested titles failed:", e));
    }, 5 * 60_000);
    forgeTimer.unref();
    app.addHook("onClose", async () => clearInterval(forgeTimer));
  }
  app.get<{ Querystring: { serviceId?: string } }>("/api/home-rows/catalog", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return plainly(() => homeRows.catalog(String(request.query.serviceId ?? "")));
  });
  app.post("/api/home-rows/preview", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return plainly(() => homeRows.preview(request.body));
  });
  app.post("/api/home-rows", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return plainly(() => homeRows.save(request.body));
  });
  app.put<{ Params: { id: string } }>("/api/home-rows/:id", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return plainly(() => homeRows.save(request.body, request.params.id));
  });
  app.delete<{ Params: { id: string } }>("/api/home-rows/:id", async (request, reply) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    await plainly(() => homeRows.remove(request.params.id));
    return reply.code(204).send();
  });

  // The credential broker's view: per service, whether its credential exists and works. Never values.
  const credentialSources = new CredentialSources(handle, vault, runner.containerTools);
  // Ember: the same view (metadata, never values) and the Diagnostics panel's live read,
  // which uses the broker with the linked credential.
  // Freeing memory frees Hearth's own voice too (the stand-in machine has its own).
  if (process.env.DC_FAKE_MEMORY !== "1")
    memoryOps.bind({
      voiceLoaded: () => voice.voiceLoaded(),
      releaseVoice: () => void voice.releaseBuiltin(),
    });
  // The approved plan step (hearth-api-call) uses the same in-process door, with its own secret.
  hearthSelf.bind(
    async (secret, req) => {
      const res = await app.inject({
        method: req.method as "GET",
        url: req.path,
        headers: {
          [EMBER_HEADER]: secret,
          ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(req.body !== undefined ? { payload: req.body } : {}),
      });
      let body: unknown = res.body;
      try {
        body = res.body ? JSON.parse(res.body) : null;
      } catch {
        // Not JSON: passed on as text.
      }
      return { status: res.statusCode, body };
    },
    (path) => methodsAt(routes, path),
  );
  if (agents.cave) {
    agents.cave.credentials = () => apps.broker.status((s) => credentialSources.detect(s));
    // Reads the AI asks for are audited (which credential, why, outcome; never the value).
    agents.cave.appLive = (serviceId) => apps.diagnostics(serviceId, "agent");
    agents.cave.history = history;
    agents.cave.homeAssistant = (serviceId, q) => apps.homeAssistant(serviceId, q);
    agents.cave.selectedItem = (serviceId, item) => apps.selectedItem(serviceId, item);
    agents.cave.plex = (serviceId) => apps.dashboard(serviceId, "agent");
    agents.cave.seerr = (serviceId) => apps.dashboard(serviceId, "agent");
    agents.cave.library = (serviceId, q) => apps.library(serviceId, q, "agent");
    agents.cave.arr = (serviceId, q) => apps.arrView(serviceId, q, "agent");
    // Ember using Hearth itself: an in-process request as the owner, marked as Ember, within
    // the rules the sign-in hook enforces (agent/hearth-api.ts). Changes are audited as Ember's.
    agents.cave.hearthApi = async (req) => {
      const res = await app.inject({
        method: req.method,
        url: req.path,
        headers: {
          [EMBER_HEADER]: EMBER_SECRET,
          ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(req.body !== undefined ? { payload: req.body } : {}),
      });
      let body: unknown = res.body;
      try {
        body = res.body ? JSON.parse(res.body) : null;
      } catch {
        // Not JSON: passed on as text.
      }
      if (req.method !== "GET")
        await recordAudit(db, {
          actor: "agent",
          action: `Ember used Hearth: ${req.method} ${req.path.split("?")[0]}`,
          target: req.path.split("?")[0]!,
          detail: { status: res.statusCode },
        });
      if (res.statusCode === 404 && (body as { error?: unknown } | null)?.error === "Not Found") {
        const takes = methodsAt(routes, req.path).filter((m) => m !== req.method);
        const near = closestRoutes(routes, req.method, req.path);
        body = takes.length
          ? {
              message: `Hearth has no ${req.method} at ${req.path.split("?")[0]}. That address takes ${takes.join(", ")}.`,
              methods: takes,
              next: `Use ${takes.join(" or ")} at the same address. Never read Hearth's source code to find an address.`,
            }
          : {
              message: `Hearth has no address ${req.method} ${req.path.split("?")[0]}.`,
              closest: near,
              next: near.length
                ? "Use one of these. Never read Hearth's source code to find an address."
                : "hearth_help names each feature's addresses. Never read Hearth's source code to find one.",
            };
      }
      return { status: res.statusCode, ok: res.statusCode < 400, body };
    };
    agents.cave.panels = customPanels;
    agents.cave.sessions = apps.sessions;
    // Saved Plex sign-ins (Tasterr) are kept alive while Hearth runs.
    apps.sessions.startKeepAlive();
    app.addHook("onClose", async () => apps.sessions.stopKeepAlive());
    agents.cave.appApi = (serviceId, req, opts) =>
      apps.appApi(serviceId, req, { ...opts, by: "agent" });
    agents.cave.qbtSettings = (serviceId) => apps.qbtSettings(serviceId, "agent");
    agents.cave.torrents = async (serviceId, hash) => {
      const board = await apps.dashboard(serviceId, "agent");
      if (!hash || board.error) return board;
      const qb = board.data?.app === "qbittorrent" ? board.data : undefined;
      const torrent = qb?.torrents.find((x) => x.hash === hash.toLowerCase());
      if (!torrent)
        return { note: `qBittorrent has no torrent with hash ${hash} (read just now).` };
      // With its files, so Ember can plan which ones download (app-qbt-file-priority).
      return {
        torrent,
        detail: await apps.torrentDetail(serviceId, torrent.hash, "agent", { files: true }),
      };
    };
  }

  // Resource history: settings with what it costs, and the hourly points (signed in).
  const historyInput = z
    .object({
      enabled: z.boolean().optional(),
      retentionDays: z.number().int().optional(),
    })
    .strict();
  app.get("/api/history/resources", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const settings = await history.settings();
    return {
      ...settings,
      sampleMinutes: SAMPLE_MINUTES,
      retentionChoices: RETENTION_CHOICES,
      estimate: await history.estimate(),
      estimates: Object.fromEntries(
        await Promise.all(RETENTION_CHOICES.map(async (d) => [d, await history.estimate(d)])),
      ),
      stored: await history.stored(),
    };
  });
  app.put("/api/history/resources", async (request) => {
    // Signed in only: an access key (Home Assistant, a companion) cannot change it.
    if (!request.session) throw new ForbiddenAuthError("Sign in to change resource history.");
    const body = historyInput.parse(request.body);
    let next;
    try {
      next = await history.update(body);
    } catch (error) {
      throw new ConflictError(error instanceof Error ? error.message : String(error));
    }
    await recordAudit(db, {
      actor: "you",
      action: next.enabled
        ? `Turned resource history on (kept ${next.retentionDays} days)`
        : "Turned resource history off",
      target: "resource-history",
      detail: next as unknown as Record<string, unknown>,
    });
    return next;
  });
  const restartsInput = z
    .object({ enabled: z.boolean().optional(), retentionDays: z.number().int().optional() })
    .strict();
  app.get("/api/history/restarts", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return {
      ...(await restarts.settings()),
      sweepMinutes: RESTART_SWEEP_MINUTES,
      retentionChoices: RESTART_RETENTION_CHOICES,
      keepPerService: RESTART_KEEP_PER_SERVICE,
      stored: await restarts.stored(),
    };
  });
  app.put("/api/history/restarts", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to change restart history.");
    const body = restartsInput.parse(request.body);
    let next;
    try {
      next = await restarts.update(body);
    } catch (error) {
      throw new ConflictError(error instanceof Error ? error.message : String(error));
    }
    await recordAudit(db, {
      actor: "you",
      action: next.enabled
        ? `Restart history on (kept ${next.retentionDays} days)`
        : "Turned restart history off",
      target: "restart-history",
      detail: next as unknown as Record<string, unknown>,
    });
    return next;
  });
  app.get<{ Params: { id: string } }>("/api/services/:id/restarts", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return {
      events: (await restarts.list(request.params.id, 100)).map((e) => ({
        ...e,
        text: describeEvent(e),
      })),
    };
  });
  app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    "/api/services/:id/timeline",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const days = Math.min(180, Math.max(1, Number(request.query.days) || 30));
      return { days, events: await serviceTimeline(handle, request.params.id, days, restarts) };
    },
  );
  app.get<{ Params: { id: string }; Querystring: { hours?: string } }>(
    "/api/services/:id/history",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const hours = Math.min(24 * 30, Math.max(1, Number(request.query.hours) || 72));
      return {
        hours,
        points:
          request.params.id === "host"
            ? await history.series({ host: true }, hours)
            : await history.series({ serviceId: request.params.id }, hours),
      };
    },
  );
  // Live application dashboards (read only, through the broker; signed in).
  app.get<{ Params: { id: string } }>("/api/services/:id/dashboard", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return apps.dashboard(request.params.id);
  });
  // Interactive search (Sonarr, Radarr, Lidarr, Chaptarr): find a title, then what the indexers
  // offer for it. Reads only; downloading the chosen release is a plan step.
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    "/api/services/:id/search/titles",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return apps.searchTitles(request.params.id, String(request.query.q ?? "").slice(0, 120));
    },
  );
  app.get<{ Params: { id: string }; Querystring: { seriesId?: string } }>(
    "/api/services/:id/search/episodes",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return apps.searchEpisodes(request.params.id, Number(request.query.seriesId));
    },
  );
  app.get<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>(
    "/api/services/:id/search/releases",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const q = request.query;
      const n = (k: string) => (q[k] !== undefined ? Number(q[k]) : undefined);
      const scope = Object.fromEntries(
        ["movieId", "episodeId", "seriesId", "seasonNumber", "albumId", "bookId"]
          .map((k) => [k, n(k)] as const)
          .filter(([, v]) => v !== undefined && Number.isFinite(v)),
      );
      try {
        return await apps.searchReleases(request.params.id, scope as never);
      } catch (e) {
        if (e instanceof Error && e.message === "Say what to search for.")
          throw new InvalidRequestError(e.message);
        throw e;
      }
    },
  );
  // The Crucible's saved rows for every Radarr (small): Add movie picks the row's profile.
  app.get("/api/crucible", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return { setups: (await getSetting(db, "crucible")) ?? {} };
  });
  // Ember's suggested rules (11-18): the owner's own words, translated into a rule the panel
  // shows with every definition in plain sight, to add or dismiss. Nothing else changes.
  app.get<{ Querystring: { serviceId?: string } }>("/api/crucible/suggestions", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const all = (await getSetting(db, "crucible_suggestions")) ?? {};
    const want = request.query.serviceId;
    return {
      suggestions: Object.entries(all)
        .filter(([, x]) => !want || x.serviceId === want)
        .map(([id, x]) => ({ id, ...x })),
    };
  });
  app.post<{
    Body: { serviceId?: string; kind?: string; row?: unknown; note?: string };
  }>("/api/crucible/suggestions", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const b = request.body ?? {};
    const serviceId = String(b.serviceId ?? "");
    const kind = b.kind === "show" ? "show" : "movie";
    const svc = await db
      .select()
      .from(tables.services)
      .where(eq(tables.services.id, serviceId))
      .get();
    if (!svc) throw new InvalidRequestError("Say which Radarr or Sonarr (its service id).");
    const shape = kind === "show" ? SHAPES.sonarr : SHAPES.radarr;
    let row: CrucibleRow;
    try {
      const raw = { ...(b.row as CrucibleRow) };
      row = {
        id: String(raw.id || `rule-${randomUUID().slice(0, 8)}`).slice(0, 60),
        name: String(raw.name ?? "").slice(0, 80),
        group: raw.group ?? {},
        ladder: raw.ladder,
        upgrade: raw.upgrade !== false,
        waitHours: Number(raw.waitHours ?? 0) || 0,
      };
      const setup = {
        preset: "custom",
        movies: [],
        shows: [],
        [shape.app === "sonarr" ? "shows" : "movies"]: [row],
      };
      parseSetup(JSON.stringify(setup), shape);
    } catch (e) {
      throw new InvalidRequestError(
        e instanceof Error ? e.message : "That rule isn't one the Crucible can use.",
      );
    }
    const all = (await getSetting(db, "crucible_suggestions")) ?? {};
    const id = randomUUID();
    all[id] = {
      serviceId,
      kind,
      row,
      ...(b.note ? { note: String(b.note).slice(0, 300) } : {}),
      at: new Date().toISOString(),
    };
    // A handful at most: the oldest go first.
    const keep = Object.entries(all)
      .sort((a, z) => z[1].at.localeCompare(a[1].at))
      .slice(0, 12);
    await setSetting(db, "crucible_suggestions", Object.fromEntries(keep));
    return { id, row };
  });
  app.delete<{ Params: { id: string } }>("/api/crucible/suggestions/:id", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const all = (await getSetting(db, "crucible_suggestions")) ?? {};
    delete all[request.params.id];
    await setSetting(db, "crucible_suggestions", all);
    return { ok: true };
  });
  // The Crucible (11-17): one Radarr's library summary and the rows saved for it.
  app.get<{ Params: { id: string } }>("/api/services/:id/crucible", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const library = await apps.crucibleLibrary(request.params.id);
    const saved = (await getSetting(db, "crucible"))?.[request.params.id];
    return { library, ...(saved ? { setup: saved } : {}) };
  });
  // Smart Quality's near-miss check (11-17), for Ember and the panel: "why isn't Radarr grabbing
  // Snow White?" Finds the title, searches the indexers (downloads nothing), and says whether
  // nothing exists or the owner's own rules turned every release down, with the closest one ready
  // to propose as a one-time download (app-arr-grab, approved like any change).
  app.get<{ Params: { id: string }; Querystring: { q?: string; season?: string } }>(
    "/api/services/:id/why-not-grabbed",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const q = String(request.query.q ?? "")
        .trim()
        .slice(0, 120);
      if (!q) throw new InvalidRequestError("Say which title.");
      const { titles } = (await apps.searchTitles(request.params.id, q)) as {
        titles: SearchTitle[];
      };
      const t = titles.find((x) => x.kind === "movie" || x.kind === "series");
      if (!t)
        return {
          answer: `There's no title matching "${q}" in its library. It has to be added (or requested) first.`,
        };
      const name = `${t.title}${t.year ? ` (${t.year})` : ""}`;
      if (t.kind === "movie" && t.hasFile)
        return { title: name, answer: `${name} already has a file, so there's nothing to grab.` };
      const season =
        t.kind === "series"
          ? Number(request.query.season) || Math.max(...(t.seasons ?? [1]).filter((n) => n > 0), 1)
          : undefined;
      const scope =
        t.kind === "movie" ? { movieId: t.id } : { seriesId: t.id, seasonNumber: season! };
      const r = await apps.searchReleases(request.params.id, scope as ReleaseScope);
      const nm = r.nearMiss;
      const grab =
        nm?.kind === "blocked" && nm.closest
          ? {
              operation: "app-arr-grab",
              params: {
                guid: nm.closest.guid,
                indexerId: nm.closest.indexerId,
                release: nm.closest.title,
                title: name,
                ...(nm.closest.quality ? { quality: nm.closest.quality } : {}),
                ...(nm.closest.sizeGB !== undefined ? { sizeGB: nm.closest.sizeGB } : {}),
                ...(nm.closest.indexer ? { indexer: nm.closest.indexer } : {}),
              },
            }
          : undefined;
      return {
        title: name,
        ...(season !== undefined ? { season } : {}),
        scope,
        nearMiss: nm,
        answer: `${name}${season !== undefined ? `, season ${season}` : ""}: ${nm?.sentence ?? "searched."}`,
        ...(grab ? { grab } : {}),
      };
    },
  );
  // The Gluetun panel: the VPN's state, server, exit address, and what goes through it.
  app.get<{ Params: { id: string } }>("/api/services/:id/vpn", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    try {
      return { data: await admin.config.vpnPanel(request.params.id) };
    } catch (error) {
      return { error: panelError(error) };
    }
  });
  // The Recyclarr panel: its last run, and on request what a sync now would change.
  app.get<{ Params: { id: string }; Querystring: { preview?: string } }>(
    "/api/services/:id/recyclarr",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      try {
        return {
          data: await admin.config.recyclarrPanel(request.params.id, request.query.preview === "1"),
        };
      } catch (error) {
        return { error: panelError(error) };
      }
    },
  );
  // The Caddy panel (protected, read only): sites, where each goes, sign-in, certificates.
  app.get<{ Params: { id: string } }>("/api/services/:id/caddy", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    try {
      return { data: await admin.config.caddyPanel(request.params.id) };
    } catch (error) {
      return { error: panelError(error) };
    }
  });
  // The Caddy panel's form: the exact Caddyfile edits for a site, proposed as a protected plan.
  app.post<{
    Params: { id: string };
    Body: { op?: string; site?: string; upstream?: string; signIn?: string };
  }>("/api/services/:id/caddy/site", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const b = request.body ?? {};
    const op = b.op === "change" || b.op === "remove" ? b.op : "add";
    try {
      return {
        data: await admin.config.caddySiteEdits(request.params.id, {
          op,
          site: String(b.site ?? ""),
          ...(b.upstream ? { upstream: String(b.upstream) } : {}),
          ...(b.signIn === "sign-in service" || b.signIn === "none" ? { signIn: b.signIn } : {}),
        }),
      };
    } catch (error) {
      return { error: panelError(error) };
    }
  });
  // The Tinyauth panel: who it let in, sent to sign in, or refused, from its own log.
  app.get<{ Params: { id: string } }>("/api/services/:id/tinyauth", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return runner.tinyauth(request.params.id);
  });
  // Tinyauth's users: the usernames (never a password or its scramble), and where they live.
  app.get<{ Params: { id: string } }>("/api/services/:id/tinyauth/users", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return tinyauthUsers.list(request.params.id);
  });
  // A password typed for a Tinyauth change: only right after you confirm it's you; scrambled at
  // once and kept in memory for its plan, which refers to it by a reference, never the password.
  app.post<{ Params: { id: string }; Body: { username?: unknown; password?: unknown } }>(
    "/api/services/:id/tinyauth/users/password",
    async (request) => {
      const session = request.session;
      if (!session) throw new ForbiddenAuthError("Sign in to do this.");
      if (!auth.recentlyVerified(session))
        throw new ForbiddenAuthError("Confirm it's you, then type the password.");
      const b = request.body ?? {};
      if (typeof b.username !== "string" || typeof b.password !== "string")
        throw new InvalidRequestError("Give the username and the password.");
      return tinyauthUsers.prepare(request.params.id, b.username.trim(), b.password);
    },
  );
  // The FlareSolverr panel: what its own log says it solved (it has no statistics API).
  app.get<{ Params: { id: string } }>("/api/services/:id/flaresolverr", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return runner.flaresolverr(request.params.id);
  });
  // Plex artwork through Hearth: the token never reaches the browser.
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/services/:id/dashboard/book-cover",
    async (request, reply) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const q = request.query as { path?: string; remote?: string };
      const art = await apps.chaptarrCover(request.params.id, {
        ...(q.path ? { path: String(q.path) } : {}),
        ...(q.remote ? { remote: String(q.remote) } : {}),
      });
      return reply.type(art.type).header("cache-control", "private, max-age=86400").send(art.bytes);
    },
  );
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/services/:id/dashboard/art",
    async (request, reply) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const art = await apps.plexArt(request.params.id, String(request.query.path ?? ""));
      return reply.type(art.type).header("cache-control", "private, max-age=3600").send(art.bytes);
    },
  );
  // The home dashboard (11-04, homeassistant-home.ts): what a wall tablet shows, its pictures
  // and its taps. A paired home tablet reaches these and nothing else (auth/routes.ts).
  const homeService = (q: { service?: string }) =>
    typeof q.service === "string" && q.service ? q.service.slice(0, 80) : undefined;
  // A speaker's name in Hearth (11-13): renamed from the picker, or Reset name.
  app.put("/api/home/speakers/name", async (request) => {
    const { entity, name } = z
      .object({
        entity: z.string().regex(/^media_player\.[a-z0-9_]+$/),
        name: z.string().max(60).optional(),
      })
      .strict()
      .parse(request.body);
    return apps.renameSpeaker(entity, name);
  });
  app.get<{ Querystring: { service?: string; watch?: string; catalog?: string } }>(
    "/api/home",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const watch = String(request.query.watch ?? "")
        .split(",")
        .filter((e) => /^[a-z_]+\.[a-z0-9_]+$/.test(e))
        .slice(0, 40);
      return {
        ...(await apps.homeView(homeService(request.query), {
          watch,
          catalog: request.query.catalog === "1",
        })),
        pinSet: await pinIsSet(handle),
        tablet: request.session.method === "home",
      };
    },
  );
  // The household board (home-board.ts): notes, countdowns, chores, reminders, and (the owner's
  // choice) the news feeds and the photo frame's album. Shared by every screen in the house.
  app.get("/api/home/board", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return readBoard(handle);
  });
  app.post("/api/home/board", async (request) => {
    const session = request.session;
    if (!session) throw new ForbiddenAuthError("Sign in to do this.");
    const change = BoardChange.parse(request.body);
    if (OWNER_ONLY.has(change.op) && session.method === "home")
      throw new ForbiddenAuthError("Choose the news and photos from Hearth, not a home tablet.");
    try {
      const board = await changeBoard(handle, change);
      if (OWNER_ONLY.has(change.op))
        await recordAudit(handle.db, {
          actor: "you",
          action:
            change.op === "feeds.set"
              ? `Home dashboard: news feeds set (${board.feeds.length})`
              : `Home dashboard: photo frame shows ${board.photos?.albumName ?? "recent photos"}`,
          target: "home",
        });
      return board;
    } catch (e) {
      if (e instanceof BoardError) throw new ConflictError(e.message);
      throw e;
    }
  });
  // The Media page's music library (through Home Assistant's Music Assistant actions).
  app.get<{ Querystring: { q?: string; service?: string } }>(
    "/api/home/music/search",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const q = String(request.query.q ?? "").trim();
      if (!q) return { tracks: [], albums: [], artists: [], playlists: [] };
      return apps.homeMusicSearch(request.query.service?.slice(0, 80), q.slice(0, 200));
    },
  );
  app.get<{ Querystring: { shelf?: string; service?: string } }>(
    "/api/home/music/library",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const shelf = z
        .enum(["playlist", "album", "artist", "track", "recent"])
        .parse(request.query.shelf ?? "playlist");
      return apps.homeMusicLibrary(request.query.service?.slice(0, 80), shelf);
    },
  );
  // The calendar page: events for a range, and adding, changing and deleting them.
  app.get<{ Querystring: { start?: string; end?: string; service?: string } }>(
    "/api/home/calendar",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const q = z
        .object({
          start: z.string().datetime({ offset: true }),
          end: z.string().datetime({ offset: true }),
          service: z.string().max(80).optional(),
        })
        .parse(request.query);
      if (
        Date.parse(q.end) - Date.parse(q.start) > 120 * 86_400_000 ||
        Date.parse(q.end) < Date.parse(q.start)
      )
        throw new InvalidRequestError("Ask for at most four months at a time.");
      return apps.homeCalendar(q.service, q.start, q.end);
    },
  );
  app.post("/api/home/calendar", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const when = z.string().min(10).max(40);
    const event = {
      service: z.string().max(80).optional(),
      entity: z.string().min(10).max(120),
      title: z.string().max(300),
      start: when,
      end: when,
      allDay: z.boolean(),
      description: z.string().max(4000).optional(),
      location: z.string().max(300).optional(),
    };
    const body = z
      .discriminatedUnion("action", [
        z.object({ action: z.literal("add"), ...event }).strict(),
        z
          .object({
            action: z.literal("change"),
            uid: z.string().min(1).max(500),
            recurrenceId: z.string().max(200).optional(),
            ...event,
          })
          .strict(),
        z
          .object({
            action: z.literal("delete"),
            service: z.string().max(80).optional(),
            entity: z.string().min(10).max(120),
            uid: z.string().min(1).max(500),
            recurrenceId: z.string().max(200).optional(),
            title: z.string().max(300).optional(),
          })
          .strict(),
      ])
      .parse(request.body);
    const { service, ...c } = body;
    return apps.homeCalendarChange(
      service,
      c,
      request.session.method === "home" ? "home tablet" : "you",
    );
  });
  // The Scenes widget's editor: open a scene, save (change or add) one, delete one.
  app.get<{ Querystring: { entity?: string; service?: string } }>(
    "/api/home/scene",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const q = z
        .object({
          entity: z
            .string()
            .regex(/^(scene|script)\.[\w-]{1,120}$/)
            .optional(),
          service: z.string().max(80).optional(),
        })
        .parse(request.query);
      return apps.homeScene(q.service, q.entity);
    },
  );
  app.post("/api/home/scene", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const scene = z.string().regex(/^(scene|script)\.[\w-]{1,120}$/);
    const rgb = z.tuple([
      z.number().int().min(0).max(255),
      z.number().int().min(0).max(255),
      z.number().int().min(0).max(255),
    ]);
    const item = z.union([
      z.object({ ref: z.string().max(200), keep: z.literal(true) }).strict(),
      z
        .object({
          ref: z.string().max(200).optional(),
          entity: z.string().regex(/^\w+\.[\w-]{1,120}$/),
          on: z.boolean(),
          brightness: z.number().min(1).max(100).optional(),
          color: rgb.optional(),
        })
        .strict(),
    ]);
    const body = z
      .discriminatedUnion("action", [
        z
          .object({
            action: z.literal("save"),
            service: z.string().max(80).optional(),
            entity: scene.optional(),
            name: z.string().min(1).max(80),
            items: z.array(item).min(1).max(100),
          })
          .strict(),
        z
          .object({
            action: z.literal("delete"),
            service: z.string().max(80).optional(),
            entity: scene,
          })
          .strict(),
      ])
      .parse(request.body);
    const { service, ...c } = body;
    return apps.homeSceneChange(
      service,
      c as Parameters<typeof apps.homeSceneChange>[1],
      request.session.method === "home" ? "home tablet" : "you",
    );
  });
  // The weather's places and source (the owner sets them, in the weather window).
  app.get("/api/home/weather/places", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return apps.homeWeatherPlaces();
  });
  app.post("/api/home/weather/places", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    if (request.session.method === "home")
      throw new ForbiddenAuthError("Choose the weather's places from Hearth, not a home tablet.");
    const body = z
      .object({
        source: z.enum(["auto", "homeassistant"]),
        places: z
          .array(
            z
              .object({
                label: z.string().min(1).max(100),
                lat: z.number().min(-90).max(90),
                lon: z.number().min(-180).max(180),
              })
              .strict(),
          )
          .max(6),
      })
      .strict()
      .parse(request.body);
    return apps.setHomeWeatherPlaces(body);
  });
  app.get<{ Querystring: { q?: string } }>("/api/home/weather/find", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const q = z
      .string()
      .min(2)
      .max(100)
      .parse(request.query.q ?? "");
    return apps.findWeatherPlaces(q);
  });
  // Add a music service: Music Assistant's own setup for it, a step at a time (the owner only).
  app.get("/api/home/music/services", async (request) => {
    ownerOnly(request.session);
    return apps.musicServiceList();
  });
  app.post("/api/home/music/services", async (request) => {
    ownerOnly(request.session);
    const flowId = z.string().regex(/^[\w-]{4,100}$/);
    const body = z
      .discriminatedUnion("action", [
        z
          .object({ action: z.literal("start"), domain: z.string().regex(/^[a-z0-9_]{2,60}$/) })
          .strict(),
        z
          .object({
            action: z.literal("submit"),
            flowId,
            values: z.record(
              z.string().max(120),
              z.union([z.string().max(4000), z.number(), z.boolean()]),
            ),
          })
          .strict(),
        z.object({ action: z.literal("get"), flowId }).strict(),
        z.object({ action: z.literal("abort"), flowId }).strict(),
      ])
      .parse(request.body);
    return apps.musicServiceStep(body);
  });
  app.get("/api/home/speaker", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return apps.speakerReady();
  });
  app.get("/api/home/music/home", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return apps.homeMusicHome();
  });
  // Up Next and likes on the music card (11-11), from the speaker's Music Assistant queue.
  app.get<{ Querystring: { queue?: string; name?: string } }>(
    "/api/home/music/queue",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const q = z
        .object({ queue: z.string().max(120).optional(), name: z.string().min(1).max(120) })
        .parse(request.query);
      return apps.homeMusicQueue({ name: q.name, ...(q.queue ? { queue: q.queue } : {}) });
    },
  );
  app.post("/api/home/music/queue", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const body = z
      .discriminatedUnion("action", [
        z.object({
          action: z.literal("play"),
          queueId: z.string().min(1).max(120),
          itemId: z.string().min(1).max(120),
        }),
        z.object({ action: z.enum(["like", "unlike"]), uri: z.string().min(3).max(500) }),
      ])
      .parse(request.body);
    return apps.homeMusicQueueAction(
      body,
      request.session.method === "home" ? "home tablet" : "you",
    );
  });
  app.get<{ Querystring: { uri?: string } }>("/api/home/music/open", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return apps.homeMusicOpen(String(request.query.uri ?? "").slice(0, 500));
  });
  // The now-playing card's video: the song's official music video on YouTube, if it has one.
  app.get<{ Querystring: { title?: string; artist?: string } }>(
    "/api/home/music/video",
    async (request, reply) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const q = z
        .object({ title: z.string().min(1).max(200), artist: z.string().min(1).max(200) })
        .parse(request.query);
      reply.header("cache-control", "private, max-age=3600");
      return apps.homeMusicVideo(q.title, q.artist);
    },
  );
  // Watch on TV: the music video on a Google Cast TV (the music pauses on its other speaker).
  app.post("/api/home/music/video-tv", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const body = z
      .object({
        service: z.string().max(80).optional(),
        tv: z.string().min(3).max(120),
        videoId: z.string().regex(/^[\w-]{11}$/),
        pause: z.string().min(3).max(120).optional(),
      })
      .strict()
      .parse(request.body);
    const { service, ...p } = body;
    return apps.homeVideoOnTv(
      service,
      p,
      request.session.method === "home" ? "home tablet" : "you",
    );
  });
  app.get<{ Querystring: { id?: string } }>("/api/home/music/art", async (request, reply) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const pic = await apps.homeMusicArt(String(request.query.id ?? ""));
    return reply
      .header("cache-control", "private, max-age=86400")
      .header("x-content-type-options", "nosniff")
      .type(pic.type)
      .send(pic.body);
  });
  app.post("/api/home/music/play", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const body = z
      .object({
        service: z.string().max(80).optional(),
        entity: z.string().min(3).max(120),
        uri: z.string().min(3).max(500),
        kind: z.enum(["track", "album", "artist", "playlist", "radio"]),
        how: z.enum(["play", "mix", "next", "add"]),
        name: z.string().max(200).optional(),
        /** Play all: the rest of a row's songs, after `uri`, as one queue. */
        more: z.array(z.string().min(3).max(500)).max(49).optional(),
      })
      .strict()
      .parse(request.body);
    const { service, ...p } = body;
    return apps.homeMusicPlay(
      service,
      p,
      request.session.method === "home" ? "home tablet" : "you",
    );
  });
  app.get("/api/home/news", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const board = await readBoard(handle);
    return board.feeds.length ? apps.homeNews(board.feeds) : { items: [], problems: [] };
  });
  app.get("/api/home/photos", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const board = await readBoard(handle);
    return apps.homePhotos(board.photos?.album);
  });
  app.get<{ Querystring: { id?: string } }>("/api/home/photo", async (request, reply) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const pic = await apps.homePhoto(String(request.query.id ?? "").slice(0, 64));
    if (!pic) throw new NotFoundError("That photo is not on the photo frame.");
    return reply
      .type(pic.type)
      .header("cache-control", "private, max-age=3600")
      .header("x-content-type-options", "nosniff")
      .send(pic.bytes);
  });
  app.get<{ Querystring: { service?: string; entity?: string } }>(
    "/api/home/picture",
    async (request, reply) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const pic = await apps.homePicture(
        homeService(request.query),
        String(request.query.entity ?? ""),
      );
      if (!pic) throw new NotFoundError("Home Assistant has no picture for that.");
      return reply
        .type(pic.type)
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff")
        .send(pic.body);
    },
  );
  app.post("/api/home/action", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const body = z
      .object({
        service: z.string().max(80).optional(),
        entity: z.string().min(3).max(120),
        action: z.string().min(2).max(40),
        value: z.union([z.string().max(255), z.number(), z.boolean()]).optional(),
        item: z.string().max(200).optional(),
        code: z.string().max(32).optional(),
        pin: z.string().max(16).optional(),
      })
      .strict()
      .parse(request.body);
    const { service, ...a } = body;
    return apps.homeAction(service, a, request.session.method === "home" ? "home tablet" : "you");
  });
  // Music Assistant from Hearth (11-05): its own sign-in page in a window, then Hearth finishes
  // its setup, adds it to Home Assistant, and adds YouTube Music from an ordinary Chrome window the
  // owner signs in to. The owner only (never a home tablet); sessions stay in the backend.
  const musicLink = new MusicAssistantLink(
    path.join(config.dataDir ?? config.keyDir, "music-link-profiles"),
  );
  const ownerOnly = (session: typeof undefined | { method?: string } | null | undefined) => {
    if (!session) throw new ForbiddenAuthError("Sign in to do this.");
    if (session.method === "home")
      throw new ForbiddenAuthError("Set up music from Hearth itself, not a home tablet.");
  };
  const linkError = <T>(p: Promise<T> | T): Promise<T> =>
    Promise.resolve(p).catch((e: unknown) => {
      if (e instanceof MusicLinkError) throw new ConflictError(e.message);
      throw e;
    });
  // Change YouTube account: straight to the YouTube step with the Music Assistant key Hearth keeps.
  app.post("/api/home/music-assistant/youtube", async (request) => {
    ownerOnly(request.session);
    const ma = await apps.musicAssistantKeyForSetup();
    if (!ma)
      throw new ConflictError(
        "Link Music Assistant from Hearth first (the music card, Connect, Music Assistant).",
      );
    const r = musicLink.startWithKey(ma.address, ma.key);
    return { state: r.state, address: r.address };
  });
  app.post("/api/home/music-assistant/start", async (request) => {
    ownerOnly(request.session);
    const body = z
      .object({ address: z.string().min(3).max(300) })
      .strict()
      .parse(request.body);
    const r = await linkError(
      musicLink.start(body.address, (maHost) => {
        // Music Assistant only sends its sign-in back to an address on the home network, so the
        // window returns to this Hearth's own home-network address, whatever address it was opened on.
        const host = request.headers.host ?? "";
        const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
        const base = isPrivateAddress(hostname)
          ? `${request.protocol}://${host}`
          : `http://${lanAddressFor(maHost) ?? hostname}:${request.socket.localPort}`;
        return `${base}/api/home/music-assistant/back`;
      }),
    );
    return { state: r.state, address: r.address, loginUrl: r.loginUrl, version: r.version };
  });
  // Music Assistant's sign-in lands here in its window: keep the session, close the window.
  app.get<{ Querystring: { state?: string; code?: string } }>(
    "/api/home/music-assistant/back",
    async (request, reply) => {
      // No session needed: the session cookie is strict, and this arrives from Music Assistant's
      // page. The state is a one-time 144-bit secret an owner's session made, kept for this setup.
      let ok = true;
      try {
        musicLink.back(String(request.query.state ?? ""), String(request.query.code ?? ""));
      } catch {
        ok = false;
      }
      reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
      return reply
        .type("text/html")
        .send(
          `<!doctype html><meta charset="utf-8"><title>Hearth</title><body style="font:16px system-ui;background:#111;color:#eee;display:grid;place-items:center;height:90vh"><p>${ok ? "Signed in. Back to Hearth..." : "This sign-in has ended. Go back to Hearth and start again."}</p><script>try{window.opener&&window.opener.postMessage({hearth:"music-assistant-signed-in"},location.origin)}catch(e){};${ok ? "setTimeout(function(){window.close()},600)" : ""}</script>`,
        );
    },
  );
  app.get<{ Params: { state: string } }>("/api/home/music-assistant/:state", async (request) => {
    ownerOnly(request.session);
    return linkError(musicLink.status(request.params.state));
  });
  app.post<{ Params: { state: string } }>("/api/home/music-assistant/:state", async (request) => {
    ownerOnly(request.session);
    const body = z
      .union([
        z
          .object({ action: z.literal("home-assistant"), service: z.string().max(80).optional() })
          .strict(),
        z.object({ action: z.literal("youtube-open") }).strict(),
        z.object({ action: z.literal("youtube-read") }).strict(),
        z
          .object({
            action: z.literal("youtube-done"),
            channel: z
              .object({
                id: z
                  .string()
                  .regex(/^\d{10,30}$/)
                  .optional(),
                name: z.string().min(1).max(200),
              })
              .strict(),
          })
          .strict(),
        z.object({ action: z.literal("end") }).strict(),
      ])
      .parse(request.body);
    const state = request.params.state;
    if (body.action === "home-assistant") {
      await linkError(musicLink.finishSetup(state));
      const ma = musicLink.forHomeAssistant(state);
      const step = await apps.homeConnectMusicAssistant(body.service, ma);
      // Hearth's own key, for the home rows and opening playlists (never fatal).
      if (step.type === "done")
        await apps.keepMusicAssistantKey(ma.address, ma.token).catch(() => undefined);
      // YouTube Music already there: the setup ends here instead of asking for it again.
      return { ...step, youtube: await musicLink.youtubeAdded(state).catch(() => false) };
    }
    if (body.action === "youtube-open") return linkError(musicLink.openYoutube(state));
    if (body.action === "youtube-read") return linkError(musicLink.youtubeRead(state));
    if (body.action === "youtube-done") {
      const r = await linkError(musicLink.youtubeDone(state, body.channel));
      if (!r.added) return r;
      // Hearth keeps the sign-in in Secure Vault (for YouTube Music's own home rows); the page never gets it.
      const kept = await apps.keepYoutubeSignIn(r.cookie, r.channel).catch(() => ({ kept: false }));
      await recordAudit(db, {
        actor: "you",
        action: `Music Assistant: YouTube Music set to the channel "${body.channel.name.slice(0, 80)}" (signed in in a Chrome window; the sign-in kept in Secure Vault)`,
        target: "music-assistant",
      });
      return { added: true, kept: kept.kept };
    }
    musicLink.end(state);
    return { ended: true };
  });
  // Connecting a service and the unlock PIN: the owner only (never a home tablet, never Ember).
  app.post("/api/home/connect", async (request) => {
    const session = request.session;
    if (!session) throw new ForbiddenAuthError("Sign in to do this.");
    const body = z
      .union([
        z
          .object({ service: z.string().max(80).optional(), start: z.string().min(2).max(40) })
          .strict(),
        z
          .object({
            service: z.string().max(80).optional(),
            handler: z.string().min(2).max(40),
            flowId: z.string().min(8).max(64),
            data: z.record(z.string().max(80), z.unknown()),
          })
          .strict(),
        // The address a sign-in ended on when its page couldn't be reached.
        z
          .object({
            service: z.string().max(80).optional(),
            handler: z.string().min(2).max(40),
            flowId: z.string().min(8).max(64),
            callback: z.string().min(10).max(4000),
          })
          .strict(),
        z
          .object({
            service: z.string().max(80).optional(),
            app: z.string().min(2).max(40),
            clientId: z.string().min(1).max(300),
            clientSecret: z.string().min(1).max(300),
            /** Also keep them in Secure Vault, under this name. */
            saveAs: z.string().min(1).max(80).optional(),
          })
          .strict(),
        // Or an "App sign-in" already in Secure Vault: its client ID and secret, filled in here.
        z
          .object({
            service: z.string().max(80).optional(),
            app: z.string().min(2).max(40),
            vaultSecret: z.string().min(8).max(64),
          })
          .strict(),
      ])
      .parse(request.body);
    const { service, ...step } = body;
    if ("vaultSecret" in step) {
      const entry = (await vault.list()).find((s) => s.id === step.vaultSecret);
      if (!entry || entry.kind !== "oauth-app" || !entry.username)
        throw new ConflictError("That isn't an app sign-in with a client ID in Secure Vault.");
      const clientSecret = await vault.use(
        entry.id,
        `give ${step.app}'s client ID and secret to Home Assistant`,
        { actor: "dragon-control", unlockedSession: session },
      );
      return apps.homeConnect(service, {
        app: step.app,
        clientId: entry.username,
        clientSecret,
      });
    }
    if ("clientSecret" in step && step.saveAs) {
      const { saveAs, ...give } = step;
      const r = await apps.homeConnect(service, give);
      await vault.add({
        name: saveAs,
        kind: "oauth-app",
        tier: "automation",
        value: give.clientSecret,
        username: give.clientId,
      });
      return r;
    }
    return apps.homeConnect(service, step);
  });
  app.put("/api/home/pin", async (request, reply) => {
    const session = request.session;
    if (!session) throw new ForbiddenAuthError("Sign in to do this.");
    if (!auth.recentlyVerified(session))
      throw new ForbiddenAuthError("Confirm it's you first, then set the unlock PIN.");
    const { pin } = z
      .object({ pin: z.string().max(16).nullable() })
      .strict()
      .parse(request.body);
    try {
      await setPin(handle, pin ?? undefined);
    } catch (e) {
      if (e instanceof PinError) throw new ConflictError(e.message);
      throw e;
    }
    await recordAudit(handle.db, {
      actor: "you",
      action: pin
        ? "Set the home dashboard's unlock PIN"
        : "Cleared the home dashboard's unlock PIN",
      target: "security",
    });
    return reply.code(204).send();
  });
  // Posters for Jellyfin's panel, through Hearth (its key never reaches the browser).
  app.get<{ Params: { id: string }; Querystring: { item?: string } }>(
    "/api/services/:id/dashboard/jellyfin-poster",
    async (request, reply) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const pic = await apps.jellyfinPoster(request.params.id, String(request.query.item ?? ""));
      if (!pic) throw new NotFoundError("Jellyfin has no poster for this.");
      return reply
        .type(pic.type)
        .header("cache-control", "private, max-age=3600")
        .header("x-content-type-options", "nosniff")
        .send(pic.bytes);
    },
  );
  // Book covers for Audiobookshelf's panel, through Hearth (its key never reaches the browser).
  // The Immich panel's Photos tab: the timeline a page at a time, newest taken first.
  app.get<{ Params: { id: string }; Querystring: { page?: string; album?: string } }>(
    "/api/services/:id/dashboard/immich/photos",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const page = Math.max(1, Math.min(10_000, Math.trunc(Number(request.query.page) || 1)));
      return apps.immichPhotos(request.params.id, page, request.query.album || undefined);
    },
  );
  // Organizing Immich photos: albums (and what the storage template does on disk), a photo's
  // edits, and every photo id for Select all. Changes are app-immich-control plans.
  app.get<{ Params: { id: string } }>(
    "/api/services/:id/dashboard/immich/albums",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return apps.immichAlbums(request.params.id);
    },
  );
  app.get<{ Params: { id: string }; Querystring: { asset?: string } }>(
    "/api/services/:id/dashboard/immich/edits",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return apps.immichEdits(request.params.id, String(request.query.asset ?? ""));
    },
  );
  app.get<{ Params: { id: string }; Querystring: { album?: string } }>(
    "/api/services/:id/dashboard/immich/photo-ids",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return apps.immichPhotoIds(request.params.id, request.query.album || undefined);
    },
  );
  // Files and folders: Immich's storage template, a preview on a few photos, and its job.
  app.get<{ Params: { id: string } }>(
    "/api/services/:id/dashboard/immich/files",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return apps.immichFiles(request.params.id);
    },
  );
  // How the Immich panel shows photos: kept in Hearth, so Immich itself is not changed.
  app.get<{ Params: { id: string } }>(
    "/api/services/:id/dashboard/immich/prefs",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return apps.immichPhotoPrefs(request.params.id);
    },
  );
  const immichPrefs = z
    .object({
      recent: z.enum(["show", "blur", "off"]).optional(),
      photo: z
        .object({
          id: z.string().regex(/^[0-9a-f-]{36}$/i),
          show: z.enum(["blur", "hide", "normal"]),
        })
        .optional(),
    })
    .strict();
  app.put<{ Params: { id: string } }>(
    "/api/services/:id/dashboard/immich/prefs",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return apps.setImmichPhotoPrefs(request.params.id, immichPrefs.parse(request.body));
    },
  );
  // Photos for Immich's panel, through Immich (its key never reaches the browser): a small
  // thumbnail, or size=preview for the full view (Immich's resized copy, not the original).
  app.get<{
    Params: { id: string };
    Querystring: { asset?: string; size?: string; edited?: string };
  }>("/api/services/:id/dashboard/immich-thumb", async (request, reply) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const pic = await apps.immichThumbnail(
      request.params.id,
      String(request.query.asset ?? ""),
      request.query.size === "preview" ? "preview" : "thumbnail",
      request.query.edited !== "0",
    );
    if (!pic) throw new NotFoundError("No picture.");
    return reply
      .type(pic.type)
      .header("cache-control", "private, max-age=86400")
      .header("x-content-type-options", "nosniff")
      .send(pic.bytes);
  });
  app.get<{ Params: { id: string }; Querystring: { item?: string } }>(
    "/api/services/:id/dashboard/abs-cover",
    async (request, reply) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const pic = await apps.audiobookshelfCover(
        request.params.id,
        String(request.query.item ?? ""),
      );
      return reply.type(pic.type).header("cache-control", "private, max-age=86400").send(pic.bytes);
    },
  );
  // Posters for Tautulli's panel, through Tautulli (its key never reaches the browser).
  app.get<{ Params: { id: string }; Querystring: { img?: string } }>(
    "/api/services/:id/dashboard/tautulli-image",
    async (request, reply) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const pic = await apps.tautulliImage(request.params.id, String(request.query.img ?? ""));
      return reply.type(pic.type).header("cache-control", "private, max-age=3600").send(pic.bytes);
    },
  );
  // Whether an app's own page may be shown inside Hearth (basic panels, 11-14): the app's own
  // headers decide, read here. Only the service's own addresses are read, and nothing is changed.
  const embedChecked = new Map<string, { at: number; v: EmbedVerdict }>();
  app.get<{ Params: { id: string }; Querystring: { url?: string; from?: string } }>(
    "/api/services/:id/embed",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const row = await db
        .select()
        .from(tables.services)
        .where(eq(tables.services.id, request.params.id))
        .get();
      if (!row) throw new NotFoundError("That system isn't in Hearth.");
      const url = String(request.query.url ?? "");
      const from = String(request.query.from ?? "");
      const own = [row.localUrl, row.publicUrl]
        .filter((u): u is string => Boolean(u))
        .map((u) => (/^https?:\/\//.test(u) ? u : `https://${u}`));
      if (!own.includes(url)) throw new InvalidRequestError("That isn't this app's address.");
      if (!/^https?:\/\/[^/]+/.test(from))
        throw new InvalidRequestError("Say where Hearth is open.");
      const key = `${row.id}|${url}|${from}`;
      const kept = embedChecked.get(key);
      if (kept && Date.now() - kept.at < 3_600_000) return kept.v;
      const get = fakeApps?.fetch ?? (fetch as unknown as Fetch);
      const res = await get(url, {
        method: "GET",
        headers: { Accept: "text/html" },
        signal: AbortSignal.timeout(6_000),
      }).catch(() => undefined);
      const v: EmbedVerdict = res
        ? frameVerdict(
            {
              xFrameOptions: res.headers?.get?.("x-frame-options"),
              csp: res.headers?.get?.("content-security-policy"),
            },
            from,
            url,
          )
        : { ok: false, reason: "Hearth couldn't reach the app just now." };
      embedChecked.set(key, { at: Date.now(), v });
      return v;
    },
  );
  // Movie posters for the Seerr dashboard: TMDB's public image server, fetched by Hearth so the
  // page loads nothing from outside. Only a plain poster file name is accepted.
  app.get<{ Params: { id: string }; Querystring: { path?: string; size?: string } }>(
    "/api/services/:id/dashboard/poster",
    async (request, reply) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const file = String(request.query.path ?? "");
      if (!/^\/[\w-]+\.(jpg|jpeg|png|webp)$/i.test(file)) throw new NotFoundError("Not a poster.");
      const get = fakeApps?.fetch ?? (fetch as unknown as Fetch);
      // A backdrop for a hero or a title's banner is wider; a cast photo smaller (11-19).
      const size = { backdrop: "w1280", face: "w185" }[String(request.query.size ?? "")] ?? "w342";
      const res = await get(`https://image.tmdb.org/t/p/${size}${file}`, {
        method: "GET",
        headers: { Accept: "image/*" },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
      const type = res?.headers?.get?.("content-type") ?? "";
      if (!res?.ok || !/^image\//.test(type)) throw new NotFoundError("No poster.");
      const bytes = Buffer.from(await (res as unknown as Response).arrayBuffer());
      return reply.type(type).header("cache-control", "private, max-age=86400").send(bytes);
    },
  );
  // One Home Assistant routine in plain words, with its recent runs (the panel's details).
  app.get<{ Params: { id: string }; Querystring: { entityId?: string } }>(
    "/api/services/:id/dashboard/ha-routine",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return apps.homeAssistant(
        request.params.id,
        {
          section: "routine",
          entityId: String(request.query.entityId ?? "").slice(0, 120),
        },
        "you",
      );
    },
  );
  // The native Radarr, Sonarr and Prowlarr panels' tabs (radarr-panel.ts, sonarr-panel.ts,
  // prowlarr-panel.ts): reads only, shaped, secrets kept out.
  for (const kind of ["radarr", "sonarr", "prowlarr", "lidarr"] as const)
    app.get<{
      Params: { id: string; view: string };
      Querystring: Record<string, string | undefined>;
    }>(`/api/services/:id/${kind}/:view`, async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const view = request.params.view;
      const views: readonly string[] =
        kind === "radarr"
          ? RADARR_VIEWS
          : kind === "sonarr"
            ? SONARR_VIEWS
            : kind === "lidarr"
              ? LIDARR_VIEWS
              : PROWLARR_VIEWS;
      if (!views.includes(view)) throw new NotFoundError("Not a panel view.");
      const q = request.query ?? {};
      const pick = (k: string) => (typeof q[k] === "string" ? q[k]!.slice(0, 300) : undefined);
      const query = {
        id: pick("id"),
        page: pick("page"),
        event: pick("event"),
        level: pick("level"),
        title: pick("title"),
        folder: pick("folder"),
        // Prowlarr: definitions, search and history filters.
        term: pick("term"),
        privacy: pick("privacy"),
        protocol: pick("protocol"),
        name: pick("name"),
        query: pick("query"),
        type: pick("type"),
        indexerIds: pick("indexerIds"),
        categories: pick("categories"),
        indexer: pick("indexer"),
      };
      return kind === "radarr"
        ? apps.radarrPanel(request.params.id, view as RadarrView, query)
        : kind === "sonarr"
          ? apps.sonarrPanel(request.params.id, view as SonarrView, query)
          : kind === "lidarr"
            ? apps.lidarrPanel(request.params.id, view as LidarrView, query)
            : apps.prowlarrPanel(request.params.id, view as ProwlarrView, query);
    });
  // The native Plex panel's Library, History, Tasks and Settings tabs: reads only.
  app.get<{
    Params: { id: string; view: string };
    Querystring: Record<string, string | undefined>;
  }>("/api/services/:id/plex/:view", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const view = request.params.view;
    if (!(PLEX_VIEWS as readonly string[]).includes(view))
      throw new NotFoundError("Not a panel view.");
    const q = request.query ?? {};
    const pick = (k: string) => (typeof q[k] === "string" ? q[k]!.slice(0, 200) : undefined);
    return apps.plexPanel(request.params.id, view as PlexView, {
      section: pick("section"),
      page: pick("page"),
      q: pick("q"),
      sort: pick("sort"),
      filter: pick("filter"),
      id: pick("id"),
    });
  });
  // The native Jellyfin panel's tabs (Library, Manage, People, Devices, Activity, Plugins,
  // Settings, System): reads only.
  app.get<{
    Params: { id: string; view: string };
    Querystring: Record<string, string | undefined>;
  }>("/api/services/:id/jellyfin/:view", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const view = request.params.view;
    if (!(JELLYFIN_VIEWS as readonly string[]).includes(view))
      throw new NotFoundError("Not a panel view.");
    const q = request.query ?? {};
    const pick = (k: string) => (typeof q[k] === "string" ? q[k]!.slice(0, 200) : undefined);
    return apps.jellyfinPanel(request.params.id, view as JellyfinView, {
      page: pick("page"),
      name: pick("name"),
      section: pick("section"),
      q: pick("q"),
      sort: pick("sort"),
      filter: pick("filter"),
      id: pick("id"),
    });
  });
  // The native Seerr panel's Discover, Issues and People tabs (seerr-panel.ts): reads only.
  app.get<{
    Params: { id: string; view: string };
    Querystring: Record<string, string | undefined>;
  }>("/api/services/:id/seerr/:view", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const view = request.params.view;
    if (!(SEERR_VIEWS as readonly string[]).includes(view))
      throw new NotFoundError("Not a panel view.");
    const q = request.query ?? {};
    const pick = (k: string) => (typeof q[k] === "string" ? q[k]!.slice(0, 200) : undefined);
    return apps.seerrPanel(request.params.id, view as SeerrView, {
      query: pick("query"),
      page: pick("page"),
      type: pick("type"),
      id: pick("id"),
      status: pick("status"),
      row: pick("row"),
    });
  });
  // The native Tautulli panel's History, People, Libraries, Graphs and System tabs: reads only.
  app.get<{
    Params: { id: string; view: string };
    Querystring: Record<string, string | undefined>;
  }>("/api/services/:id/tautulli/:view", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const view = request.params.view;
    if (!(TAUTULLI_VIEWS as readonly string[]).includes(view))
      throw new NotFoundError("Not a panel view.");
    const q = request.query ?? {};
    const pick = (k: string) => (typeof q[k] === "string" ? q[k]!.slice(0, 200) : undefined);
    return apps.tautulliPanel(request.params.id, view as TautulliView, {
      page: pick("page"),
      userId: pick("userId"),
      type: pick("type"),
      q: pick("q"),
      id: pick("id"),
      days: pick("days"),
    });
  });
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    "/api/services/:id/dashboard/movies",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return apps.findMovies(request.params.id, String(request.query.q ?? "").slice(0, 100));
    },
  );
  app.get<{ Params: { id: string; hash: string }; Querystring: { with?: string } }>(
    "/api/services/:id/dashboard/torrents/:hash",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      // Files and peers only while the panel shows them (?with=files or ?with=peers).
      const want = String(request.query.with ?? "").split(",");
      return apps.torrentDetail(request.params.id, request.params.hash, undefined, {
        files: want.includes("files"),
        peers: want.includes("peers"),
      });
    },
  );
  // SABnzbd's Downloads tab: one job's files, and the history searched or filtered.
  // RomM's Library: games a page at a time, one game's page, and its cover (passed through).
  // Wizarr's Wizard and Settings tabs: read with its admin sign-in, never returned or shown.
  app.get<{ Params: { id: string } }>(
    "/api/services/:id/dashboard/wizarr/wizard",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return apps.wizarrAdmin(request.params.id, "wizard");
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/services/:id/dashboard/wizarr/settings",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return apps.wizarrAdmin(request.params.id, "settings");
    },
  );
  app.get<{
    Params: { id: string };
    Querystring: {
      search?: string;
      platform?: string;
      genre?: string;
      favorites?: string;
      order?: string;
      offset?: string;
    };
  }>("/api/services/:id/dashboard/romm/games", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const q = request.query;
    const order = ["name", "added", "size", "released"].includes(q.order ?? "")
      ? (q.order as "name" | "added" | "size" | "released")
      : "name";
    return apps.rommGames(request.params.id, {
      ...(q.search ? { search: String(q.search).slice(0, 200) } : {}),
      ...(Number(q.platform) > 0 ? { platformId: Number(q.platform) } : {}),
      ...(q.genre ? { genre: String(q.genre).slice(0, 100) } : {}),
      ...(q.favorites === "1" ? { favorites: true } : {}),
      order,
      ...(q.offset ? { offset: Number(q.offset) || 0 } : {}),
    });
  });
  app.get<{ Params: { id: string; rom: string } }>(
    "/api/services/:id/dashboard/romm/games/:rom",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const rom = Number(request.params.rom);
      if (!Number.isInteger(rom) || rom < 1) throw new NotFoundError("Not a RomM game id.");
      return apps.rommGame(request.params.id, rom);
    },
  );
  app.get<{ Params: { id: string; rom: string }; Querystring: { size?: string } }>(
    "/api/services/:id/dashboard/romm/games/:rom/cover",
    async (request, reply) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const rom = Number(request.params.rom);
      if (!Number.isInteger(rom) || rom < 1) throw new NotFoundError("Not a RomM game id.");
      const cover = await apps.rommCover(
        request.params.id,
        rom,
        request.query.size === "large" ? "large" : "small",
      );
      if (!cover) throw new NotFoundError("RomM has no cover for this game.");
      return reply
        .header("Content-Type", cover.type)
        .header("Cache-Control", "private, max-age=600")
        .header("X-Content-Type-Options", "nosniff")
        .send(cover.bytes);
    },
  );
  app.get<{
    Params: { id: string };
    Querystring: { query?: string; tag?: string; page?: string; trash?: string };
  }>("/api/services/:id/dashboard/paperless/documents", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const q = request.query;
    return apps.paperlessDocuments(request.params.id, {
      ...(q.query ? { query: String(q.query).slice(0, 200) } : {}),
      ...(Number(q.tag) > 0 ? { tagId: Number(q.tag) } : {}),
      ...(Number(q.page) > 0 ? { page: Number(q.page) } : {}),
      ...(q.trash === "1" ? { trash: true } : {}),
    });
  });
  app.get<{ Params: { id: string } }>(
    "/api/services/:id/dashboard/nextcloud/apps",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return apps.nextcloudApps(request.params.id);
    },
  );
  app.get<{ Params: { id: string; nzo: string } }>(
    "/api/services/:id/dashboard/sab/jobs/:nzo/files",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      if (!/^[\w.-]{1,100}$/.test(request.params.nzo))
        throw new NotFoundError("Not a download id.");
      return apps.sabJobFiles(request.params.id, request.params.nzo);
    },
  );
  app.get<{
    Params: { id: string };
    Querystring: { search?: string; failed?: string; category?: string; start?: string };
  }>("/api/services/:id/dashboard/sab/history", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const q = request.query;
    return apps.sabHistory(request.params.id, {
      ...(q.search ? { search: String(q.search).slice(0, 200) } : {}),
      ...(q.failed === "1" ? { failedOnly: true } : {}),
      ...(q.category ? { category: String(q.category).slice(0, 100) } : {}),
      ...(q.start ? { start: Number(q.start) || 0 } : {}),
    });
  });
  // Pi-hole's query log and "why is this domain blocked?" (reads; changes are protected plans).
  app.get<{
    Params: { id: string };
    Querystring: { show?: string; domain?: string; client?: string; start?: string };
  }>("/api/services/:id/dashboard/pihole/queries", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const q = request.query;
    return apps.piholeQueries(request.params.id, {
      show: q.show === "blocked" || q.show === "allowed" ? q.show : "all",
      domain: String(q.domain ?? "").slice(0, 253),
      client: String(q.client ?? "").slice(0, 45),
      start: Math.max(0, Math.min(100_000, Math.trunc(Number(q.start) || 0))),
    });
  });
  app.get<{ Params: { id: string }; Querystring: { domain?: string } }>(
    "/api/services/:id/dashboard/pihole/check",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const domain = String(request.query.domain ?? "")
        .trim()
        .toLowerCase()
        .replace(/\.$/, "");
      if (!/^[a-z0-9_.-]{1,253}$/.test(domain))
        throw new InvalidRequestError("Give one domain name, like ads.example.com.");
      return apps.piholeCheck(request.params.id, domain);
    },
  );
  // Download Health: stuck and failing downloads, explained; POST checks now. It changes nothing.
  app.get("/api/download-health", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return apps.health.overview();
  });
  app.post("/api/download-health/check", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    await apps.health.check();
    return apps.health.overview();
  });
  // Automatic Recovery on or off (11-13, the owner's choice; off unless turned on).
  app.put("/api/download-health/settings", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const b = z.object({ auto: z.boolean() }).strict().parse(request.body);
    return { settings: await apps.health.setSettings(b) };
  });
  // Automatic Recovery: with the owner's standing approval (the switch), a download that needs
  // attention and can be recovered gets the same plan Fix it makes, approved by that switch, and
  // the history and the bell say what was done. Once per download; the step itself refuses a
  // third replacement for the same movie or episode.
  const autoTried = new Set<string>();
  apps.health.onChecked = async (o) => {
    await autoRecover(o, {
      tried: autoTried,
      create: (job) => jobs.create(job),
      approve: (id, fingerprint) => jobs.decide(id, "approve", fingerprint),
      log: (rec) => apps.health.log(rec),
    });
  };
  // Audiobook intake: its setup (or a ready one) and every release judged; POST checks now.
  app.get<{ Params: { id: string } }>(
    "/api/services/:id/dashboard/audiobookshelf/intake",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return apps.audiobookIntake(request.params.id);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/services/:id/dashboard/audiobookshelf/intake/check",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return apps.audiobookIntake(request.params.id, true);
    },
  );
  // Manual downloads (no category): the sorter's setup, history and Unsorted; POST checks now.
  app.get<{ Params: { id: string } }>(
    "/api/services/:id/dashboard/qbittorrent/sort",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return apps.manualSort(request.params.id);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/services/:id/dashboard/qbittorrent/sort/check",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return apps.manualSort(request.params.id, true);
    },
  );
  // AdGuard Home's query log and "why is this domain blocked?" (reads; changes are protected plans).
  app.get<{
    Params: { id: string };
    Querystring: { show?: string; search?: string; older?: string };
  }>("/api/services/:id/dashboard/adguard/queries", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const q = request.query;
    return apps.adguardQueries(request.params.id, {
      show: q.show === "blocked" || q.show === "allowed" ? q.show : "all",
      search: String(q.search ?? "").slice(0, 253),
      older: String(q.older ?? "").slice(0, 40),
    });
  });
  app.get<{ Params: { id: string }; Querystring: { domain?: string } }>(
    "/api/services/:id/dashboard/adguard/check",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const domain = String(request.query.domain ?? "")
        .trim()
        .toLowerCase()
        .replace(/\.$/, "");
      if (!/^[a-z0-9_.-]{1,253}$/.test(domain))
        throw new InvalidRequestError("Give one domain name, like ads.example.com.");
      return apps.adguardCheck(request.params.id, domain);
    },
  );
  // A Proxmox VM's or container's snapshots (read; taking one is a plan).
  app.get<{ Params: { id: string }; Querystring: { guest?: string } }>(
    "/api/services/:id/dashboard/proxmox/snapshots",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return apps.proxmoxSnapshots(
        request.params.id,
        String(request.query.guest ?? "").slice(0, 20),
      );
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/services/:id/dashboard/qbittorrent/settings",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return apps.qbtSettings(request.params.id);
    },
  );
  // Transmission's Settings tab and the Torrents tab's labels (read only; changes are plans).
  app.get<{ Params: { id: string } }>(
    "/api/services/:id/dashboard/transmission/settings",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return apps.transmissionSettings(request.params.id);
    },
  );
  // Deluge's Settings tab and the Torrents tab's labels (read only; changes are plans).
  app.get<{ Params: { id: string } }>(
    "/api/services/:id/dashboard/deluge/settings",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return apps.delugeSettings(request.params.id);
    },
  );
  app.get("/api/credentials", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return apps.broker.status((s) => credentialSources.detect(s));
  });
  // Link Plex: plex.tv's own sign-in by code, started by you right after confirming it's you;
  // the token goes straight into the vault (read-only scope) and is never sent back.
  const plexLink =
    givenPlexLink ??
    new PlexLink(handle, apps.broker, async (id) => {
      const s = await db.select().from(tables.services).where(eq(tables.services.id, id)).get();
      return s && /plex/i.test(`${s.image ?? ""} ${s.name}`)
        ? { name: s.name, localUrl: s.localUrl }
        : undefined;
    });
  app.post<{ Params: { serviceId: string } }>(
    "/api/credentials/:serviceId/plex-link",
    async (request) => {
      const session = request.session;
      if (!session) throw new ForbiddenAuthError("Sign in to do this.");
      if (!auth.recentlyVerified(session)) {
        throw new ForbiddenAuthError("Confirm it's you first, then link Plex.");
      }
      return plexLink.start(request.params.serviceId);
    },
  );
  app.get<{ Params: { serviceId: string; pinId: string } }>(
    "/api/credentials/:serviceId/plex-link/:pinId",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      return plexLink.check(request.params.serviceId, Number(request.params.pinId));
    },
  );

  // Import a key from an app's own settings file: only when you ask, right after confirming it's you.
  app.post<{ Params: { serviceId: string } }>(
    "/api/credentials/:serviceId/import",
    async (request) => {
      const session = request.session;
      if (!session) throw new ForbiddenAuthError("Sign in to do this.");
      if (!auth.recentlyVerified(session)) {
        throw new ForbiddenAuthError("Confirm it's you first, then import.");
      }
      const { source, scope } = z
        .object({
          source: z.string().min(1).max(60),
          scope: z.enum(["read", "approved-changes"]).optional(),
        })
        .strict()
        .parse(request.body);
      const imported = await credentialSources.import(request.params.serviceId, source, scope);
      await apps.check([request.params.serviceId]);
      return { name: imported.name, credentials: await apps.broker.status() };
    },
  );

  // Find my keys: every app on this machine still missing its key, whose own settings
  // file holds one, is imported in one go, straight into the vault. Same rules as one import: only
  // when you ask, right after confirming it's you; values are never returned, shown, or logged.
  app.post("/api/credentials/find-keys", async (request) => {
    const session = request.session;
    if (!session) throw new ForbiddenAuthError("Sign in to do this.");
    if (!auth.recentlyVerified(session)) {
      throw new ForbiddenAuthError("Confirm it's you first, then find your keys.");
    }
    // What the found keys may be used for: your choice on the question, the vault's default otherwise.
    const { scope } = z
      .object({ scope: z.enum(["read", "approved-changes"]).optional() })
      .strict()
      .parse(request.body ?? {});
    const status = await apps.broker.status((s) => credentialSources.detect(s));
    const results: { serviceId: string; serviceName: string; imported: boolean; note: string }[] =
      [];
    for (const c of status) {
      if (c.state !== "missing") continue;
      const source = c.importSources?.[0];
      if (!source) {
        results.push({
          serviceId: c.serviceId,
          serviceName: c.serviceName,
          imported: false,
          note: "No key in a settings file Hearth can read: add it by hand in Secure Vault.",
        });
        continue;
      }
      try {
        const done = await credentialSources.import(c.serviceId, source.id, scope);
        results.push({
          serviceId: c.serviceId,
          serviceName: c.serviceName,
          imported: true,
          note: `Imported as "${done.name}".`,
        });
      } catch (error) {
        results.push({
          serviceId: c.serviceId,
          serviceName: c.serviceName,
          imported: false,
          note: error instanceof Error ? error.message : "Could not import.",
        });
      }
    }
    const imported = results.filter((r) => r.imported).map((r) => r.serviceId);
    if (imported.length) await apps.check(imported).catch(() => undefined);
    return { results, credentials: await apps.broker.status((s) => credentialSources.detect(s)) };
  });

  // A project's ongoing conversation (made on first use), beside the main one.
  app.get<{ Params: { id: string } }>("/api/projects/:id/conversation", async (request) =>
    agents.conversation(await agents.projectConversation(request.params.id)),
  );
  app.get("/api/agent/conversations/main", async () =>
    agents.conversation(await agents.mainConversation()),
  );
  app.put("/api/agent/conversations/main", async (request) => {
    const { conversationId } = z
      .object({ conversationId: z.string().min(1).max(80) })
      .strict()
      .parse(request.body);
    await agents.setMainConversation(conversationId);
    return agents.conversation(conversationId);
  });
  app.get<{ Params: { id: string } }>("/api/agent/conversations/:id", async (request) =>
    agents.conversation(request.params.id),
  );
  app.patch<{ Params: { id: string } }>("/api/agent/conversations/:id", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const body = z
      .object({
        title: z.string().max(200).optional(),
        // Its Thread Look; null takes the picture off.
        look: z
          .enum(THREAD_LOOK_IDS as [string, ...string[]])
          .nullable()
          .optional(),
      })
      .strict()
      .refine((b) => b.title !== undefined || b.look !== undefined, {
        message: "Give a name or a picture.",
      })
      .parse(request.body);
    let out: { id: string; title?: string; look?: string | null } = { id: request.params.id };
    if (body.title !== undefined)
      out = { ...out, ...(await agents.renameConversation(request.params.id, body.title)) };
    if (body.look !== undefined)
      out = { ...out, ...(await agents.setConversationLook(request.params.id, body.look)) };
    return out;
  });
  app.delete<{ Params: { id: string } }>("/api/agent/conversations/:id", async (request, reply) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    await agents.deleteConversation(request.params.id);
    return reply.code(204).send();
  });
  // Stop (11-07): ends the answer Ember is working on in this conversation.
  app.post<{ Params: { id: string } }>("/api/agent/conversations/:id/stop", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const { followUp } = z
      .object({ followUp: z.boolean().optional() })
      .strict()
      .parse(request.body ?? {});
    return { stopped: agents.stop(request.params.id, followUp ? { followUp } : {}) };
  });
  app.post<{ Params: { id: string } }>(
    "/api/agent/providers/:id/connect",
    async (request, reply) => {
      await agents.connect(request.params.id);
      return reply.code(204).send();
    },
  );
  // Setup ("Connect your AI"): which account must be signed in, a free installed check, and a
  // real connection test. Owner only; no credential passes through any of them.
  app.get("/api/agent/setup", async () => agents.setupInfo());
  app.post<{ Params: { id: string } }>("/api/agent/providers/:id/check", async (request) =>
    agents.checkProvider(request.params.id),
  );
  app.post<{ Params: { id: string } }>("/api/agent/providers/:id/test", async (request) =>
    agents.testConnection(request.params.id),
  );
  // Signing Claude Code in from this page, for the account Hearth runs as (owner session only:
  // no access key reaches these). Only the sign-in link and the one-time code pass through.
  const signIn = () => {
    const s = agents.claudeSignIn;
    if (!s) throw new InvalidRequestError("Signing in from Hearth is not available here.");
    return s;
  };
  app.get("/api/agent/claude/status", async () => signIn().status());
  app.post("/api/agent/claude/sign-in", async (request) => {
    const body = (request.body ?? {}) as { console?: unknown };
    const started = await signIn().start({ console: body.console === true });
    await recordAudit(db, {
      actor: "you",
      action: "Started signing Claude Code in from Hearth",
      target: "agent",
    });
    return started;
  });
  app.post<{ Params: { id: string } }>("/api/agent/claude/sign-in/:id/code", async (request) => {
    const body = (request.body ?? {}) as { code?: unknown };
    const result = await signIn().complete(request.params.id, body.code);
    await recordAudit(db, {
      actor: "you",
      action: result.ok
        ? `Signed Claude Code in from Hearth${result.status.email ? ` (${result.status.email})` : ""}`
        : "Signing Claude Code in did not finish",
      target: "agent",
    });
    return result;
  });
  app.delete<{ Params: { id: string } }>(
    "/api/agent/claude/sign-in/:id",
    async (request, reply) => {
      signIn().cancel(request.params.id);
      return reply.code(204).send();
    },
  );
  app.post("/api/agent/claude/sign-out", async () => {
    const status = await signIn().signOut();
    await recordAudit(db, { actor: "you", action: "Signed Claude Code out", target: "agent" });
    return status;
  });
  app.post("/api/agent/disconnect", async (_request, reply) => {
    await agents.disconnect();
    return reply.code(204).send();
  });
  app.patch("/api/agent/settings", async (request, reply) => {
    const { escalate } = schemas.agentSettings.parse(request.body);
    await withTransaction(handle, async () => {
      await setSetting(db, "agent_escalate", escalate);
      await recordAudit(db, {
        actor: "you",
        action: escalate
          ? "Hand unresolved incidents to the operator"
          : "Stop handing incidents to the operator",
        target: "agent",
      });
    });
    return reply.code(204).send();
  });

  // The web build being served, read once (an update restarts the server).
  const webBuild = await readFile(path.join(config.webDir, "index.html"), "utf8")
    .then((html) => /\/assets\/(index-[\w-]+\.js)/.exec(html)?.[1])
    .catch(() => undefined);
  // Hearth's own app on this PC (11-22, the owner: nothing told a beginner an app landed on their
  // PC): a browser tab on the PC Hearth runs on, where the installer made the app, offers to open
  // it. Only for a visit from this PC itself, never one passed on by a proxy (that is someone else).
  app.get("/api/app-window", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    const here =
      /^(127\.|::1$|::ffff:127\.)/.test(request.ip) &&
      !request.headers["x-forwarded-for"] &&
      !request.headers.forwarded;
    const home = config.dataDir ? path.dirname(config.dataDir) : "";
    return {
      app:
        here &&
        Boolean(home) &&
        // The installer's own folder: it says how Hearth was installed, beside the app's opener.
        existsSync(path.join(home, "install.json")) &&
        (existsSync(path.join(home, "open-hearth")) ||
          existsSync(path.join(home, "open-hearth.ps1"))),
    };
  });
  app.get("/api/health", async (): Promise<HealthReport> => {
    let database: HealthReport["database"];
    try {
      const identity = await readInstallIdentity(db);
      database = {
        status: identity ? "ok" : "degraded",
        installId: identity?.installId ?? null,
        firstStartedAt: identity?.firstStartedAt ?? null,
      };
    } catch (error) {
      app.log.error({ err: error }, "database health check failed");
      database = {
        status: "down",
        installId: null,
        firstStartedAt: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      status: worstStatus([database.status]),
      app: APP_NAME,
      version: releaseVersion() ?? APP_VERSION,
      mode: config.mode,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      ...(webBuild ? { webBuild } : {}),
      database,
    };
  });

  app.get("/api/workspace", async () => loadWorkspace(db, { demo: config.demo }));

  app.patch("/api/settings", async (request, reply) => {
    await updateGeneralSettings(handle, schemas.settings.parse(request.body ?? {}));
    return reply.code(204).send();
  });

  // Long work: a script with a "work" key starts tracking itself, then reports progress. Any
  // report is a heartbeat; Hearth decides "stalled" itself (work/service.ts).
  app.get("/api/work", async () => work.list());

  app.post("/api/work", async (request, reply) => {
    const body = schemas.workStart.parse(request.body);
    const started = await work.start({ ...body, reportedBy: request.key?.name ?? "you" });
    return reply.code(201).send(started);
  });

  app.post<{ Params: { id: string } }>("/api/work/:id", async (request) =>
    work.report(request.params.id, schemas.workReport.parse(request.body)),
  );

  app.put("/api/settings/rules", async (request, reply) => {
    const body = schemas.rules.parse(request.body);
    await saveHomelabRules(handle, body);
    return reply.code(204).send();
  });

  app.put("/api/autonomy", async (request, reply) => {
    const body = schemas.autonomy.parse(request.body);
    await saveAutonomy(handle, body as Parameters<typeof saveAutonomy>[1]);
    return reply.code(204).send();
  });

  // Paused or retired services are off on purpose: not watched, never restarted by Hearth.
  app.put<{ Params: { id: string } }>("/api/services/:id/lifecycle", async (request) => {
    const { lifecycle, note } = schemas.lifecycle.parse(request.body);
    const { name, changed } = await setServiceLifecycle(handle, request.params.id, lifecycle, note);
    if (changed && (await getSetting(db, "environment")) === "real") {
      // Remembered as your decision, so companions know why it is off.
      await memory.create(
        {
          kind: "journal",
          title:
            lifecycle === "active"
              ? `Watching ${name} again`
              : `${name} ${lifecycle === "retired" ? "retired" : "paused"}`,
          body: note?.trim() || undefined,
          basis: "stated",
          links: [{ label: name, ref: `service:${request.params.id}` }],
        },
        { source: "you" },
      );
    }
    runner.onChange?.();
    return { ok: true };
  });

  // Add a system discovery missed. It is watched like any other from now on.
  app.post("/api/services", async (request, reply) => {
    const added = await addManualService(handle, schemas.addSystem.parse(request.body));
    // One read-only check now, so its page says something real straight away.
    await runChecks(handle, monitorProbes, { serviceIds: [added.id] }).catch(() => undefined);
    runner.onChange?.();
    return reply.code(201).send(added);
  });

  // Take a system out of Hearth. Nothing on the machine changes: the
  // container or app keeps running exactly as it was; Hearth just stops
  // watching it and hides it. Settings > Removed systems brings it back.
  app.post<{ Params: { id: string } }>("/api/services/:id/remove", async (request) => {
    const { name, changed } = await removeService(handle, request.params.id);
    runner.onChange?.();
    return { ok: true, name, changed };
  });

  app.post<{ Params: { id: string } }>("/api/services/:id/restore", async (request) => {
    const { name, changed } = await restoreService(handle, request.params.id);
    runner.onChange?.();
    return { ok: true, name, changed };
  });

  // A service's web address through the reverse proxy (10-12): "Open" uses it instead of the
  // local IP and port, so you sign in once on one address. Only Hearth's record changes.
  // Your reverse proxy's addresses: read from Caddy (and Nginx Proxy Manager, Traefik) and matched to each system by
  // where it forwards. Only systems with no web address yet are filled in; yours are kept.
  const detectWebAddresses = async () => {
    const file = await findCaddyfile(realRun, (c) => runner.containerTools.mounts(c));
    // The Caddyfile when Hearth may read it; otherwise Caddy's running configuration from its
    // admin API (read only), which has the same sites and where each one forwards.
    let sites = file ? await readProxySites(file).catch(() => undefined) : undefined;
    let source: string | null = sites ? file! : null;
    if (!sites?.length) {
      const live: CaddySite[] = await admin.config
        .caddyApi()
        .then(parseCaddyConfig)
        .catch(() => []);
      sites = live.flatMap((c) => {
        const host = c.hosts.find((h) => !h.includes("*"));
        const upstream = c.upstreams[0];
        return host && upstream ? [{ site: host, upstream }] : [];
      });
      if (sites.length) source = "Caddy's admin API (127.0.0.1:2019)";
    }
    // Nginx Proxy Manager's and Traefik's sites too (through their own APIs).
    for (const [found, label] of [
      [await apps.npmProxySites().catch(() => []), "Nginx Proxy Manager"],
      [await apps.traefikProxySites().catch(() => []), "Traefik"],
    ] as const) {
      if (!found.length) continue;
      sites = [...(sites ?? []), ...found];
      source = source ? `${source} and ${label}` : label;
    }
    if (!sites?.length) return { file: source, found: 0, added: [] as string[] };
    // Systems you removed are not Hearth's any more, so nothing is filled in for them.
    const rows = (await db.select().from(tables.services)).filter((s) => s.lifecycle !== "removed");
    const hostRows = await db.select().from(tables.hosts);
    const ips = hostRows.map((h) => h.address.toLowerCase());
    const matched = matchSites(sites, rows, ips);
    const added: string[] = [];
    for (const s of rows) {
      const site = matched.get(s.id);
      if (!site || s.publicUrl) continue;
      await db.update(tables.services).set({ publicUrl: site }).where(eq(tables.services.id, s.id));
      added.push(`${s.name}: ${site}`);
    }
    if (added.length)
      await recordAudit(db, {
        actor: "dragon-control",
        action: `Found ${added.length} web address${added.length === 1 ? "" : "es"} in your reverse proxy`,
        target: "services",
        detail: { file: source, added },
      });
    return { file: source, found: matched.size, added };
  };
  app.post("/api/services/web-addresses/detect", async () => detectWebAddresses());
  // Once shortly after starting (and from Settings any time).
  if (process.env.NODE_ENV === "production")
    setTimeout(() => {
      detectWebAddresses()
        .then((r) =>
          console.log(
            `[proxy] ${r.file ?? "no Caddyfile"}: ${r.found} matched, ${r.added.length} added`,
          ),
        )
        .catch((e: unknown) =>
          console.warn("[proxy] reading the reverse proxy's addresses failed:", e),
        );
    }, 15_000).unref();

  app.put<{ Params: { id: string } }>("/api/services/:id/web-address", async (request) => {
    const { publicUrl } = z
      .object({
        publicUrl: z
          .string()
          .trim()
          .max(200)
          .regex(/^[a-z0-9.-]+\.[a-z]{2,}(\/[\w./-]*)?$/i, "A web address like radarr.example.com")
          .nullable(),
      })
      .strict()
      .parse(request.body);
    const svc = await db
      .select()
      .from(tables.services)
      .where(eq(tables.services.id, request.params.id))
      .get();
    if (!svc) throw new NotFoundError("No such service.");
    await db
      .update(tables.services)
      .set({ publicUrl: publicUrl || null })
      .where(eq(tables.services.id, svc.id));
    await recordAudit(db, {
      actor: "you",
      action: publicUrl
        ? `Set ${svc.name}'s web address to ${publicUrl}`
        : `Removed ${svc.name}'s web address`,
      target: `service:${svc.id}`,
      detail: { before: svc.publicUrl ?? null, after: publicUrl || null },
    });
    runner.onChange?.();
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>("/api/notifications/routes/:id", async (request, reply) => {
    const { channels } = schemas.route.parse(request.body);
    await setRouteChannels(handle, request.params.id, channels);
    return reply.code(204).send();
  });

  // Dismiss an incident: closed, and not raised again while the problem reads the same.
  app.post<{ Params: { id: string } }>("/api/incidents/:id/dismiss", async (request, reply) => {
    const row = await dismissIncident(db, request.params.id, new Date().toISOString());
    if (!row) throw new NotFoundError("No such incident.");
    await recordAudit(db, {
      actor: "you",
      action: `Dismissed an incident: ${row.title}`,
      target: row.serviceId ?? "incidents",
    });
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/incidents/:id/decision", async (request, reply) => {
    const { decision, fingerprint } = schemas.decision.parse(request.body);
    const { actionId } = await decideIncident(handle, request.params.id, decision, fingerprint);
    if (decision === "approve") await runner.runApproved(request.params.id, actionId);
    else await runner.decline(request.params.id);
    return reply.code(204).send();
  });

  // A container's live state (uptime, ports, CPU, memory), read only.
  app.get<{ Params: { id: string } }>("/api/services/:id/runtime", async (request) =>
    runner.runtime(request.params.id),
  );

  // Read inside an app now (read only), e.g. after adding its API key.
  // Diagnostics panel: a live read of the app (read only), or the last one when just read.
  app.get<{ Params: { id: string } }>("/api/services/:id/diagnostics", async (request) => {
    const service = await db
      .select({ id: tables.services.id })
      .from(tables.services)
      .where(eq(tables.services.id, request.params.id))
      .get();
    if (!service) throw new NotFoundError("No such service.");
    return apps.diagnostics(service.id);
  });

  // Saved sign-ins (11-11): an app with no API key, signed in by Hearth, session in the vault.
  const signInRecipe = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("login"),
      path: z.string().max(300),
      format: z.enum(["json", "form"]),
      userField: z.string().max(40),
      passField: z.string().max(40),
      tokenField: z.string().max(40).optional(),
    }),
    z.object({
      type: z.literal("plex-pin"),
      start: z.string().max(300),
      poll: z.string().max(300),
      handleField: z.string().max(40),
      urlField: z.string().max(40),
      check: z.string().max(300).optional(),
    }),
  ]);
  // Seeding rules (11-11, stage 1: they preview only; nothing pauses, removes or deletes).
  app.get<{ Params: { id: string } }>("/api/services/:id/seeding-rules", async (request) => {
    const [rules, choices, log] = await Promise.all([
      apps.seedingRules(request.params.id),
      apps.seedingChoices(request.params.id),
      apps.seedingLog(request.params.id),
    ]);
    const run = await apps.seedingRun(request.params.id);
    return {
      rules,
      choices,
      log,
      stopped: Boolean(run.stopped),
      ...(run.lastCheck ? { lastCheck: run.lastCheck } : {}),
      unseen: run.unseen.length,
    };
  });
  app.post<{ Params: { id: string; rule: string } }>(
    "/api/services/:id/seeding-rules/:rule/mode",
    async (request) => {
      const body = z
        .object({ mode: z.enum(["preview", "live"]), confirm: z.string().max(40).optional() })
        .parse(request.body);
      return {
        rules: await apps.setSeedingMode(
          request.params.id,
          request.params.rule,
          body.mode,
          body.confirm,
        ),
      };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/services/:id/seeding-rules/stopped",
    async (request) => {
      const body = z.object({ stopped: z.boolean() }).parse(request.body);
      await apps.setSeedingStopped(request.params.id, body.stopped);
      return { stopped: body.stopped };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/services/:id/seeding-rules/check",
    async (request) => ({
      acted: await apps.seedingTick(request.params.id),
    }),
  );
  app.post<{ Params: { id: string } }>("/api/services/:id/seeding-rules/seen", async (request) => {
    await apps.seedingSeen(request.params.id);
    return { ok: true };
  });
  app.put<{ Params: { id: string } }>("/api/services/:id/seeding-rules", async (request) => {
    const body = z
      .object({
        rules: z
          .array(
            z.object({
              id: z.string().max(40).optional(),
              name: z.string().max(80).optional(),
              indexers: z.array(z.string().max(120)).max(50),
              trackers: z.array(z.string().max(200)).max(50),
              days: z.number(),
              minRatio: z.number().optional(),
              action: z.enum(["notify", "pause", "remove", "delete"]),
              enabled: z.boolean(),
            }),
          )
          .max(50),
      })
      .parse(request.body);
    return { rules: await apps.saveSeedingRules(request.params.id, body.rules) };
  });

  app.get<{ Params: { id: string } }>("/api/services/:id/sign-in", async (request) =>
    apps.sessions.status(request.params.id),
  );
  app.put<{ Params: { id: string } }>("/api/services/:id/sign-in", async (request) => {
    await apps.sessions.setRecipe(request.params.id, signInRecipe.parse(request.body), "you");
    return apps.sessions.status(request.params.id);
  });
  // Which way (Tasterr offers Plex and its own login): the panel's button says.
  app.post<{ Params: { id: string } }>("/api/services/:id/sign-in", async (request) => {
    const { how } = z
      .object({ how: z.enum(["login", "plex-pin"]).optional() })
      .parse(request.body ?? {});
    return apps.sessions.start(request.params.id, how);
  });

  app.post<{ Params: { id: string } }>("/api/services/:id/app/check", async (request) => {
    const service = await db
      .select({ id: tables.services.id })
      .from(tables.services)
      .where(eq(tables.services.id, request.params.id))
      .get();
    if (!service) throw new NotFoundError("No such service.");
    const opened = await apps.check([service.id]);
    if (opened.length) runner.onChange?.();
    const report = (await apps.reports()).find((r) => r.serviceId === service.id);
    if (!report) throw new ConflictError("Hearth does not understand this app yet.");
    return report;
  });

  /* ---------- Media announcements: what arrived in Plex or Jellyfin, to chosen destinations ---------- */
  const media =
    givenMedia ??
    mediaWatcherFor(handle, apps, notifier, (system, prompt) => agents.suggest(system, prompt));
  const announceKinds = z.enum([
    "movie",
    "series",
    "season",
    "episode",
    "album",
    "audiobook",
    "book",
    "comic",
    "game",
    "podcast",
  ]);
  const lineTone = z.enum(["playful", "gentle", "off"]);
  const announceSchema = z.object({
    looks: z.record(
      announceKinds,
      z.object({
        template: z.enum(["cinematic", "streaming", "compact", "banner"]),
        heading: z.string().max(120),
      }),
    ),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    botName: z.string().min(1).max(80),
    branding: z.string().max(120),
    show: z.object({
      art: z.boolean(),
      synopsis: z.boolean(),
      genre: z.boolean(),
      rating: z.boolean(),
      runtime: z.boolean(),
      trailer: z.boolean(),
      availability: z.boolean(),
    }),
    // Kinds saved before music, books and games existed are filled in (off) on reading.
    types: z.record(announceKinds, z.boolean()),
    libraries: z.array(z.string().max(200)).max(200),
    exclude: z.array(z.string().max(80)).max(100),
    mode: z.enum(["immediate", "digest"]),
    digestHour: z.number().int().min(0).max(23),
    quietHours: z.boolean(),
    dedupe: z.enum(["across", "per-library"]),
    tone: lineTone.optional(),
    emberWrites: z.boolean().optional(),
    emberWritesPerDay: z.number().int().min(0).max(EMBER_LINES_MAX_PER_DAY).optional(),
    destinations: z
      .record(
        z.string().max(80),
        z.object({
          types: z.record(announceKinds, z.boolean()).optional(),
          tone: lineTone.optional(),
        }),
      )
      .optional(),
  });
  const announceOwner = (request: FastifyRequest) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
  };
  app.get("/api/media-announce", async (request) => {
    announceOwner(request);
    const [settings, servers, history, destinations] = await Promise.all([
      media.settings(),
      apps.mediaServers(),
      media.history(),
      notifier.mediaChannels(),
    ]);
    return {
      settings,
      servers,
      history,
      destinations: destinations.map((c) => ({ id: c.id, name: c.name, audience: c.audience })),
      baseline: await media.arrivals.baselined(),
    };
  });
  app.put("/api/media-announce", async (request) => {
    announceOwner(request);
    // Saving fills in anything not sent (settings from before a kind or option existed).
    await media.saveSettings(announceSchema.parse(request.body) as MediaAnnounceSettings);
    await recordAudit(db, {
      actor: "you",
      action: "Changed media announcements",
      target: "notifications",
    });
    return media.settings();
  });
  app.get<{ Querystring: { kind?: string } }>("/api/media-announce/samples", async (request) => {
    announceOwner(request);
    const kind = announceKinds.catch("movie").parse(request.query.kind);
    return media.arrivals.samples(kind);
  });
  // The preview: the very message a destination would get, with the pictures as Hearth links.
  // The picture Discord shows beside announcements: the webhook's own, read and changed with it.
  app.get("/api/media-announce/sender-picture", async (_request, reply) => {
    // No picture of its own (or Discord did not send it): Discord shows the default, so does
    // the preview, without a failed request in the page.
    const url = await notifier.mediaSenderPicture();
    if (!url) return reply.redirect("/icon-192.png");
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    if (!res?.ok) return reply.redirect("/icon-192.png");
    return reply
      .header("content-type", res.headers.get("content-type") ?? "image/png")
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .send(Buffer.from(await res.arrayBuffer()));
  });
  app.put(
    "/api/media-announce/sender-picture",
    { bodyLimit: Math.ceil(AVATAR_MAX * 1.4) + 4096 },
    async (request) => {
      const { data } = z
        .object({ data: z.string().min(1) })
        .strict()
        .parse(request.body);
      const picture = checkedPicture(data, AVATAR_MAX);
      return notifier.setMediaSenderPicture(picture.mime, picture.data);
    },
  );
  app.post("/api/media-announce/preview", async (request) => {
    announceOwner(request);
    const { key, settings, channelId } = z
      .object({
        key: z.string().max(400),
        settings: announceSchema.optional(),
        // Ember's line in this destination's tone (else the tone for every destination).
        channelId: z.string().max(80).optional(),
      })
      .parse(request.body);
    const s = mediaAnnounceSettings(
      (settings as Partial<MediaAnnounceSettings> | undefined) ?? (await media.settings()),
    );
    const m = await media.compose(key, s, false, channelId);
    return {
      payload: m.payload,
      images: Object.fromEntries(
        m.files.map((f) => [f.name, `data:${f.type};base64,${f.bytes.toString("base64")}`]),
      ),
    };
  });
  app.post("/api/media-announce/test", async (request) => {
    announceOwner(request);
    const { key, channelId, settings } = z
      .object({
        key: z.string().max(400),
        channelId: z.string().max(80),
        settings: announceSchema.optional(),
      })
      .parse(request.body);
    return media.test(channelId, key, settings as MediaAnnounceSettings | undefined);
  });
  app.post("/api/media-announce/retry", async (request) => {
    announceOwner(request);
    const { key, channelId } = z
      .object({ key: z.string().max(400), channelId: z.string().max(80) })
      .parse(request.body);
    await media.retry(key, channelId);
    return media.history();
  });
  app.post("/api/media-announce/check", async (request) => {
    announceOwner(request);
    await media.tick();
    return media.history();
  });

  /* ---------- Movie nights: a library title at a time, invitations to friends' destinations ---------- */
  const nights = givenNights ?? movieNightsFor(handle, media, notifier);

  // What this installation has, for the AI's hearth_help tool: which features are set up here.
  const hearthFacts = async (): Promise<InstallFacts> => {
    const rows = await db.select().from(tables.services);
    const kinds = rows
      .filter((r) => r.lifecycle !== "removed" && r.lifecycle !== "retired")
      .map((r) => appOf(r))
      .filter((k): k is AppKind => Boolean(k));
    const [media, nightDest, joined] = await Promise.all([
      notifier.mediaChannels(),
      notifier.movieNightChannels(),
      pcs.list(),
    ]);
    const all = await db.select().from(tables.notificationChannels);
    return {
      apps: [...new Set(kinds)],
      facts: {
        "notify-destination": all.some((r) => r.status === "configured" && r.enabled !== false),
        "media-destination": media.length > 0,
        "movie-night-destination": nightDest.length > 0,
        "rsvp-bot": nightDest.some((c) => c.buttons),
        "hearth-bot-relay": hearthBotAvailable(),
        "another-pc": joined.length > 0,
      },
    };
  };
  if (agents.cave) agents.cave.hearthFacts = hearthFacts;

  // Only the owner's own signed-in screen: never an agent key or a linked PC.
  const ownerScreen = (request: { session?: unknown }) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to see this.");
  };
  // Show & Tell (its routes, the go-between with the screen) is in the Premium package, which
  // hands Ember's turn its hooks (host.show).
  // Free Ember (11-14): which Premium extras' tools and instructions Ember gets. Both need the
  // licence and the Premium package that brings them (a licence alone adds no tools).
  const provided = (f: PremiumFeature) => addons.loaded.some((a) => a.features.includes(f));
  if (agents.cave)
    agents.cave.premium = async () => ({
      show: provided("ember_show_and_tell") && (await entitlements.has("ember_show_and_tell")),
      panelBuilder: provided("panel_builder") && (await entitlements.has("panel_builder")),
    });
  /* ---------- Hearth Premium: status, licences, codes, and the owner's grants ---------- */
  // The Lab Blueprint (blueprint/service.ts). Reading it and its notes: any signed-in session,
  // Ember included. Everything else checks "confirm it's you" in the service, which Ember never has.
  const blueprintOwner = (request: { session?: Session | null }) => {
    const s = request.session;
    if (!s) throw new ForbiddenAuthError("Sign in to do this.");
    if (s.method === "home")
      throw new ForbiddenAuthError(
        "This is a home tablet: the Lab Blueprint is managed from Hearth.",
      );
    return s;
  };
  app.get("/api/blueprint", async (request) => {
    blueprintOwner(request);
    return blueprint.status();
  });
  app.get("/api/blueprint/preview", async (request) => {
    blueprintOwner(request);
    return { markdown: await blueprint.preview() };
  });
  app.get("/api/blueprint/imported", async (request) => {
    blueprintOwner(request);
    return { imported: await blueprint.imported() };
  });
  app.put("/api/blueprint/notes", async (request) => {
    blueprintOwner(request);
    const { notes } = z
      .object({ notes: z.string().max(20_000) })
      .strict()
      .parse(request.body);
    await blueprint.setNotes(notes);
    return blueprint.status();
  });
  app.post("/api/blueprint/setup/start", async (request) => {
    const s = blueprintOwner(request);
    const body = z
      .union([
        z.object({ destination: z.string().min(1).max(1024) }).strict(),
        z
          .object({
            cloud: z.discriminatedUnion("kind", [
              z
                .object({
                  kind: z.literal("s3"),
                  endpoint: z.string().min(1).max(500),
                  bucket: z.string().min(1).max(63),
                  prefix: z.string().max(200).optional(),
                  region: z.string().max(40).optional(),
                })
                .strict(),
              z.object({ kind: z.literal("webdav"), url: z.string().min(1).max(1000) }).strict(),
            ]),
            username: z.string().min(1).max(300),
            secret: z.string().min(1).max(2000),
          })
          .strict(),
      ])
      .parse(request.body);
    return blueprint.startSetup("destination" in body ? { folder: body.destination } : body, s);
  });
  app.post("/api/blueprint/setup/confirm", async (request) => {
    const s = blueprintOwner(request);
    const { recoveryKey } = z
      .object({ recoveryKey: z.string().min(1).max(200) })
      .strict()
      .parse(request.body);
    return blueprint.confirmSetup(recoveryKey, s);
  });
  app.post("/api/blueprint/update", async (request) => {
    const s = blueprintOwner(request);
    return { result: await blueprint.updateNow(s), status: await blueprint.status() };
  });
  app.post("/api/blueprint/test-key", async (request) => {
    const s = blueprintOwner(request);
    const { recoveryKey } = z
      .object({ recoveryKey: z.string().min(1).max(200) })
      .strict()
      .parse(request.body);
    return blueprint.testKey(recoveryKey, s);
  });
  app.post("/api/blueprint/import/open", { bodyLimit: 12 * 1024 * 1024 }, async (request) => {
    const s = blueprintOwner(request);
    const { file, recoveryKey } = z
      .object({
        file: z
          .string()
          .min(1)
          .max(11 * 1024 * 1024),
        recoveryKey: z.string().min(1).max(200),
      })
      .strict()
      .parse(request.body);
    return blueprint.openImport(new Uint8Array(Buffer.from(file, "base64")), recoveryKey, s);
  });
  app.post("/api/blueprint/import/apply", async (request) => {
    const s = blueprintOwner(request);
    const { id, names, movePremium } = z
      .object({
        id: z.string().uuid(),
        names: z.array(z.string().min(1).max(200)).max(500),
        movePremium: z.boolean().optional(),
      })
      .strict()
      .parse(request.body);
    return blueprint.applyImport(id, names, s, { movePremium });
  });
  app.delete("/api/blueprint", async (request, reply) => {
    const s = blueprintOwner(request);
    await blueprint.turnOff(s);
    return reply.code(204).send();
  });

  const premiumOwner = (request: { session?: Session | null }) => {
    const s = request.session;
    if (!s) throw new ForbiddenAuthError("Sign in to do this.");
    if (s.method === "home")
      throw new ForbiddenAuthError("This is a home tablet: Premium is managed from Hearth.");
    return s;
  };
  // Hearth's licence service: redeeming codes from any Hearth, and licences taken back. Browser
  // and unit tests never reach the real one.
  const licenceUrl = process.env.DC_LICENCE_SERVICE ?? DEFAULT_LICENCE_SERVICE;
  const licenceService =
    licenceServiceOpt !== undefined
      ? (licenceServiceOpt ?? undefined)
      : fakeApps || process.env.VITEST || licenceUrl === "off"
        ? undefined
        : new LicenceService(licenceUrl);
  issuer.connect(licenceService);
  // Which licences were taken back (only the ones installed here count). Never on a schedule (the
  // Pledge, 11-20): Premium goes online only when someone enters a code, so this runs then.
  const checkRevoked = async () => {
    if (!licenceService) return;
    try {
      await entitlements.syncRevoked(await licenceService.revoked());
    } catch {
      // Offline: licences keep working until their end date.
    }
  };
  // The Premium package (11-22): fetched, checked and installed when a licence here has none that
  // fits; Hearth reloads itself once nothing runs. Only when Premium goes online anyway (a redeem;
  // at startup when licensed and missing it, or once after an update), never on a schedule.
  const addonsHome = config.addonsDir ?? path.join(config.dataDir ?? config.keyDir, "addons");
  const premiumPackage = new PremiumPackage({
    dir: addonsHome,
    api: ADDON_API,
    coreVersion: releaseVersion() ?? APP_VERSION,
    keys: { ...PACKAGE_KEYS, ...premiumPackageKeys },
    licence: () => entitlements.licenceInForce(),
    ...(licenceService
      ? { fetch: (licence, api, have) => licenceService.package(licence, api, have) }
      : {}),
    loaded: () => addons.loaded.find((a) => a.name === "hearth-premium")?.version,
    skipped: () => addons.skipped.find((a) => a.folder === "hearth-premium")?.why,
    memory: {
      get: () => getSetting(db, "premium_package"),
      set: (m) => setSetting(db, "premium_package", m),
    },
    busy: () => busyWork(true),
    restart:
      restartSelf ??
      (() => {
        const plan = restartPlan(readInstallInfo());
        if (!plan) return false;
        spawn(plan.command, plan.args, {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        }).unref();
        return true;
      }),
    log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) },
  });
  app.addHook("onClose", async () => premiumPackage.stop());
  // Premium moves with the Lab Blueprint (11-23): each version carries this Hearth's own licence
  // keys, and importing one on a new Hearth can move Premium there. Moving is the licence
  // service's job (the old Hearth's licence is taken back); it goes online only then.
  if (blueprint instanceof LabBlueprint)
    blueprint.premium = {
      licences: () => entitlements.own(),
      describe: async (token) => {
        try {
          const p = readLicense(token, await trustedKeys());
          return { features: p.features, ...(p.end ? { end: p.end } : {}) };
        } catch {
          return null;
        }
      },
      move: async (tokens, from) => {
        const install = await installIdOf();
        const features = new Set<string>();
        let moved = false;
        for (const token of tokens) {
          let licence = token;
          if (readLicense(token, await trustedKeys()).install !== install) {
            if (!licenceService)
              throw new Error(
                "Moving Premium needs Hearth's licence service, which this Hearth can't reach. Check its internet connection and import again.",
              );
            const r = await licenceService.move(token, install);
            licence = r.licence;
            moved ||= r.moved;
          }
          const p = await entitlements.install(licence);
          p.features.forEach((f) => features.add(f));
        }
        if (!moved) return { state: "already" as const };
        await checkRevoked();
        void premiumPackage.redeemed().catch(() => undefined);
        await recordAudit(db, {
          actor: "you",
          action: `Moved Premium here from ${from} with its Lab Blueprint (${[...features].join(", ")})`,
          target: "premium",
        });
        return { state: "moved" as const, features: [...features] };
      },
    };
  if (licenceService && !process.env.VITEST) {
    const t = setTimeout(() => void premiumPackage.startup().catch(() => undefined), 5_000);
    t.unref();
  }
  const premiumStatus = async () => {
    const st = await entitlements.status(
      await issuer.active(),
      Boolean(licenceService) || (await issuer.active()),
    );
    const licensed = st.licenses.some((l) => l.state === "active");
    const pkg = await premiumPackage.status();
    return {
      ...st,
      ...(licensed || pkg.state !== "idle" ? { package: pkg } : {}),
      ...(licensed && pkg.state === "ready" && (await premiumPackage.welcomePending())
        ? { welcome: true }
        : {}),
    };
  };
  // "Learn about Premium" (the owner, 11-22): after the welcome, a new conversation where Ember
  // shows each Premium extra on screen with Show & Tell. Show & Tell is switched to Show me when it
  // is off (that is what was asked for); a choice already made (Show me, Teach me) is kept.
  app.post("/api/premium/tour", async (request) => {
    premiumOwner(request);
    const name = aiDisplayName(await getSetting(db, "ai_name"));
    if (!(await agents.operator()))
      throw new ConflictError(
        `Connect an AI service first (AI Agent page), so ${name} can show you around Premium.`,
      );
    await premiumPackage.welcomed();
    const show = await getSetting(db, "show_and_tell");
    const showOn = await entitlements.has("ember_show_and_tell");
    // A tour is spoken (the owner, 11-22: "I'm not getting any vocals"): captions are read aloud
    // too, on a device with a voice, unless the owner already turned that off themselves.
    if (showOn && (!show?.mode || show.mode === "off" || show.speak === undefined)) {
      await setSetting(db, "show_and_tell", {
        ...show,
        mode: !show?.mode || show.mode === "off" ? "show" : show.mode,
        speak: show?.speak ?? true,
        ...(show?.mode && show.mode !== "off" ? {} : { speak: true }),
      });
      await recordAudit(db, {
        actor: "you",
        action: "Turned on Show & Tell with captions read aloud, for the Premium tour",
        target: "show-and-tell",
      });
    }
    return agents.converse({
      text: showOn
        ? "Show me around Hearth Premium: walk me through each Premium extra on my screen with Show & Tell, one at a time, and what I can do with it."
        : "Tell me about Hearth Premium: what each Premium extra does and what I can do with it.",
      source: "app",
      waitMs: 1000,
    });
  });
  app.post("/api/premium/welcomed", async (request) => {
    premiumOwner(request);
    await premiumPackage.welcomed();
    return premiumStatus();
  });
  app.get("/api/premium", async (request) => {
    premiumOwner(request);
    return premiumStatus();
  });
  // A licence key someone sent you (a direct grant): checked here, offline.
  app.post("/api/premium/license", async (request) => {
    const session = premiumOwner(request);
    const { key } = z
      .object({ key: z.string().min(20).max(4000) })
      .strict()
      .parse(request.body);
    try {
      const p = await entitlements.install(key);
      void premiumPackage.redeemed().catch(() => undefined);
      await recordAudit(db, {
        actor: "you",
        action: `Added a Premium licence (${p.features.join(", ")}${p.end ? ` until ${p.end.slice(0, 10)}` : ", for good"})`,
        target: "premium",
      });
    } catch (e) {
      if (e instanceof LicenseError) throw new ConflictError(e.message);
      throw e;
    }
    void session;
    return premiumStatus();
  });
  // A promo code: redeemed with the issuer (this Hearth, when it is the issuer). Nothing counts
  // until the issuer says so: no "success" before the licence is here.
  app.post("/api/premium/redeem", async (request) => {
    const session = premiumOwner(request);
    const { code } = z
      .object({ code: z.string().min(8).max(64) })
      .strict()
      .parse(request.body);
    if (licenceService) {
      let gifted: boolean | undefined;
      try {
        const r = await licenceService.redeem(code, await installIdOf());
        const licence = r.licence;
        gifted = r.gifted;
        const p = await entitlements.install(licence);
        // The one time Premium goes online here: also ask which licences were taken back, and
        // fetch the Premium package that brings the features (it reloads Hearth when idle).
        await checkRevoked();
        void premiumPackage.redeemed().catch(() => undefined);
        await recordAudit(db, {
          actor: "you",
          action: `Redeemed a Premium code (${p.features.join(", ")}${p.end ? ` until ${p.end.slice(0, 10)}` : ", for good"})`,
          target: "premium",
        });
      } catch (e) {
        if (e instanceof LicenceServiceError || e instanceof LicenseError)
          throw new ConflictError(e.message);
        throw e;
      }
      // A code the owner gave away says so (the page asks reviewers to mention it).
      return { ...(await premiumStatus()), gifted: Boolean(gifted) };
    }
    if (!(await issuer.active()))
      throw new ConflictError(
        "Redeeming a code needs Hearth's licence service, which isn't switched on yet. Ask whoever gave you the code for a licence key for this installation instead (it's in Settings, Premium).",
      );
    await issuer.redeem(session, code, await installIdOf());
    void premiumPackage.redeemed().catch(() => undefined);
    // Every code the owner's issuer makes is given, not bought, so the page asks reviewers to
    // say so (Flint, 11-13). Codes claimed after sponsoring come from the licence service.
    return { ...(await premiumStatus()), gifted: true };
  });
  const issuerOwner = async (request: { session?: Session | null }, what: string) => {
    const s = premiumOwner(request);
    auth.requireRecent(s);
    if (!(await issuer.active()))
      throw new ForbiddenAuthError(`Only the Hearth holding the licence signing key can ${what}.`);
    return s;
  };
  app.get("/api/premium/issuer", async (request) => {
    premiumOwner(request);
    const set = await issuer.setting();
    return {
      active: await issuer.active(),
      ...(set ? { publicKey: set.publicKey, keyId: set.keyId } : {}),
      keyMissing: await issuer.keyMissing(),
      ...((await issuer.active()) ? await issuer.overview() : { grants: [], codes: [] }),
    };
  });
  app.post("/api/premium/issuer/setup", async (request) => {
    const s = premiumOwner(request);
    auth.requireRecent(s);
    try {
      return await issuer.setUp();
    } catch (e) {
      if (e instanceof IssuerError) throw e;
      throw e;
    }
  });
  // The owner's saved copy of the signing key, back into this Hearth's vault (never logged).
  app.post("/api/premium/issuer/restore", async (request) => {
    const s = premiumOwner(request);
    auth.requireRecent(s);
    const body = z
      .object({ key: z.string().min(40).max(4000) })
      .strict()
      .parse(request.body);
    return issuer.restore(body.key);
  });
  const scope = z
    .array(z.enum(["premium_all", ...PREMIUM_FEATURES]))
    .min(1)
    .max(3);
  const when = z.string().datetime().optional();
  app.post("/api/premium/issuer/grants", async (request) => {
    const s = await issuerOwner(request, "grant Premium");
    const body = z
      .object({
        recipient: z.string().trim().min(1).max(80),
        audience: z.enum(AUDIENCES),
        note: z.string().max(500).optional(),
        label: z.string().trim().max(60).optional(),
        scope,
        start: when,
        end: when,
        installId: z.string().uuid().optional(),
      })
      .strict()
      .parse(request.body);
    return issuer.grant(s, body);
  });
  app.post<{ Params: { id: string } }>("/api/premium/issuer/grants/:id/revoke", async (request) => {
    const s = await issuerOwner(request, "revoke a grant");
    await issuer.revoke(request.params.id, s);
    return issuer.overview();
  });
  app.post<{ Params: { id: string } }>(
    "/api/premium/issuer/grants/:id/reinstate",
    async (request) => {
      const s = await issuerOwner(request, "reinstate a grant");
      await issuer.reinstate(request.params.id, s);
      return issuer.overview();
    },
  );
  app.post("/api/premium/issuer/codes", async (request) => {
    const s = await issuerOwner(request, "make codes");
    const body = z
      .object({
        scope,
        audience: z.enum(AUDIENCES),
        campaign: z.string().trim().max(60).optional(),
        note: z.string().max(500).optional(),
        durationDays: z.number().int().min(1).max(3650).optional(),
        expiresAt: when,
        maxUses: z.number().int().min(1).max(10_000),
      })
      .strict()
      .parse(request.body);
    return issuer.createCode(body, s);
  });
  app.post<{ Params: { id: string } }>("/api/premium/issuer/codes/:id/active", async (request) => {
    const s = await issuerOwner(request, "change a code");
    const { active } = z.object({ active: z.boolean() }).strict().parse(request.body);
    await issuer.setCodeActive(request.params.id, active, s);
    return issuer.overview();
  });
  // Every licence made from a code, taken back (wherever it was redeemed); the code goes off.
  app.post<{ Params: { id: string } }>(
    "/api/premium/issuer/codes/:id/revoke-all",
    async (request) => {
      const s = await issuerOwner(request, "take back a code's licences");
      await issuer.revokeCode(request.params.id, s);
      return issuer.overview();
    },
  );

  /* ---------- Ember's Browser (checklist 45.12): a real browser Ember uses, watched live ---------- */
  // The owner's apps the browser may reach: every system in Hearth with a web address.
  const serviceAt = async (origin: string) => {
    const rows = await db.select().from(tables.services);
    for (const s of rows) {
      for (const u of [s.localUrl, s.publicUrl]) {
        if (!u) continue;
        let o: string | undefined;
        try {
          o = new URL(u).origin;
        } catch {
          continue;
        }
        if (o === origin)
          return {
            serviceId: s.id,
            name: s.name,
            origin,
            protected: isProtectedContainer(containerOf(s) ?? s.name, s.image ?? ""),
            app: appKindOf({ name: s.name, image: s.image ?? undefined }),
          };
      }
    }
    return undefined;
  };
  // Held changes send with the same session the page had, or sign in again the same way.
  stagedChanges.configure({
    signIn: async (serviceId, origin) => {
      const app = signInAppOf((await serviceAt(origin))?.app);
      if (!app) return undefined;
      return apps.broker.browserSignIn(serviceId, origin, (login) => appSignIn(app, origin, login));
    },
    secrets: (serviceId) => apps.broker.secretValues(serviceId),
  });
  const emberBrowser = new EmberBrowser({
    // Tests only (a local test page); production never opens this machine's own addresses.
    allowLocal: process.env.DC_TEST_BROWSER_LOCAL === "1",
    testHeadless:
      process.env.DC_TEST_BROWSER_LOCAL === "1" && process.env.DC_TEST_BROWSER_HEADLESS === "1",
    downloads: path.join(config.dataDir ?? config.keyDir, "browser-downloads"),
    scope: serviceAt,
    // Signed in by Hearth, server side, with the app's web login when you allowed it for the
    // browser in Secure Vault; only the session reaches the browser.
    signIn: async (s) => {
      const app = signInAppOf((await serviceAt(s.origin))?.app);
      if (!app)
        throw new Error(
          `Hearth cannot sign in to ${s.name}'s web page yet (no sign-in for this app); it opens at its own sign-in screen.`,
        );
      return apps.broker.browserSignIn(s.serviceId, s.origin, (login) =>
        appSignIn(app, s.origin, login),
      );
    },
    // A change sent to an app from the browser: the same rule as app_api. With Full access it is
    // sent; otherwise it is held (not sent) for you to approve on its own.
    mayChange: async (s) =>
      agents.fullAccessOn()
        ? undefined
        : `Changing ${s.name} from the browser needs your approval: it is held for you instead of sent.`,
    stage: (input) => stagedChanges.stage(input),
    secrets: (s) => apps.broker.secretValues(s.serviceId),
    // Sites you always allow in a visible window when they refuse the background browser.
    visibleSites: {
      load: async () => {
        const v = await getSetting(db, "browser_visible_sites");
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
      },
      save: (hosts) => setSetting(db, "browser_visible_sites", hosts.slice(0, 200)),
    },
  });
  if (agents.cave) agents.cave.browser = emberBrowser;
  void emberBrowser.loadSites().catch(() => undefined);
  app.addHook("onClose", async () => emberBrowser.close());
  app.get("/api/browser/state", async (request) => {
    ownerScreen(request);
    return emberBrowser.state();
  });
  // The live picture of a tab (MJPEG), for the panel's image: the page's own screencast.
  app.get<{ Querystring: { tab?: string } }>("/api/browser/stream", async (request, reply) => {
    ownerScreen(request);
    reply.hijack();
    emberBrowser.watch(request.query.tab?.slice(0, 64), reply.raw);
  });
  // The panel's size: the page takes its shape so it fills the panel (11-04).
  app.post("/api/browser/viewport", async (request) => {
    ownerScreen(request);
    const body = z
      .object({ width: z.number().min(1).max(10_000), height: z.number().min(1).max(10_000) })
      .parse(request.body);
    return { viewport: await emberBrowser.resize(body.width, body.height) };
  });
  // What you do in the panel: open an address, back, forward, reload, close (the same rules).
  app.post("/api/browser/owner", async (request) => {
    ownerScreen(request);
    const body = z
      .object({
        action: z.enum([
          "open",
          "back",
          "forward",
          "reload",
          "close",
          "take-over",
          "give-back",
          "visible-yes",
          "visible-always",
          "visible-no",
          "forget-site",
        ]),
        url: z.string().max(2000).optional(),
        host: z.string().max(253).optional(),
        tab: z.string().max(64).optional(),
        newTab: z.boolean().optional(),
      })
      .parse(request.body);
    try {
      if (body.action === "take-over") {
        emberBrowser.handOver("You took over", "owner");
        await recordAudit(db, {
          actor: "you",
          action: "Took over Ember's browser",
          target: "browser",
        });
      } else if (body.action === "give-back") {
        const { handed, page } = emberBrowser.giveBack();
        await recordAudit(db, {
          actor: "you",
          action: "Gave Ember's browser back",
          target: "browser",
        });
        // Ember asked for this: she carries on by herself, from the page as it is now.
        if (handed?.by === "ember" && handed.conversationId)
          agents.browserGivenBack(handed.conversationId, handed.reason, page);
      } else if (
        body.action === "visible-yes" ||
        body.action === "visible-always" ||
        body.action === "visible-no"
      ) {
        const answer =
          body.action === "visible-no" ? "no" : body.action === "visible-always" ? "always" : "yes";
        const { asked, page } = await emberBrowser.answerVisible(answer);
        if (asked) {
          await recordAudit(db, {
            actor: "you",
            action:
              answer === "no"
                ? `Said no to a visible browser window for ${asked.host}`
                : `Allowed a visible browser window for ${asked.host}${answer === "always" ? " (always)" : ""}`,
            target: "browser",
          });
          // Ember carries on by herself either way, in the conversation that asked.
          if (asked.conversationId)
            agents.browserVisibleAnswered(asked.conversationId, asked.host, answer !== "no", page);
        }
      } else if (body.action === "forget-site") {
        await emberBrowser.forgetSite(body.host ?? "");
        await recordAudit(db, {
          actor: "you",
          action: `Stopped always allowing ${body.host ?? ""} in a visible browser window`,
          target: "browser",
        });
      } else if (body.action === "close") {
        await emberBrowser.close();
        await recordAudit(db, {
          actor: "you",
          action: "Closed Ember's browser",
          target: "browser",
        });
      } else if (body.action === "open") {
        const page = await emberBrowser.open(body.url ?? "", "owner", body.newTab);
        await recordAudit(db, {
          actor: "you",
          action: `Opened ${hostOf(page.url)} in Ember's browser`,
          target: "browser",
        });
      } else await emberBrowser.history(body.action, "owner", body.tab);
    } catch (error) {
      if (error instanceof BrowserError) throw new InvalidRequestError(error.message);
      throw error;
    }
    return emberBrowser.state();
  });
  // What you do on the page while you have it (45.18): a click on the picture, typing, a key,
  // scrolling. Nothing typed is recorded anywhere.
  app.post("/api/browser/owner/input", async (request) => {
    ownerScreen(request);
    const body = z
      .object({
        kind: z.enum(["click", "type", "key", "scroll"]),
        fx: z.number().min(0).max(1).optional(),
        fy: z.number().min(0).max(1).optional(),
        text: z.string().min(1).max(500).optional(),
        key: z.string().max(16).optional(),
        dy: z.number().min(-4000).max(4000).optional(),
        tab: z.string().max(64).optional(),
      })
      .strict()
      .parse(request.body);
    const input =
      body.kind === "click"
        ? { kind: "click" as const, fx: body.fx ?? 0, fy: body.fy ?? 0 }
        : body.kind === "type"
          ? { kind: "type" as const, text: body.text ?? "" }
          : body.kind === "key"
            ? { kind: "key" as const, key: body.key ?? "" }
            : { kind: "scroll" as const, dy: body.dy ?? 0 };
    try {
      await emberBrowser.ownerInput(input, body.tab);
    } catch (error) {
      if (error instanceof BrowserError) throw new InvalidRequestError(error.message);
      throw error;
    }
    return emberBrowser.state();
  });
  // A page's "How this works" (checklist 42.2): the same feature answers the AI gets, for the
  // owner signed in to the app. Describes only; it opens or changes nothing.
  app.get<{ Querystring: { features?: string } }>("/api/help", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to see this.");
    const ids = (request.query.features ?? "").split(",").filter(Boolean).slice(0, 12);
    return { features: featureHelp(ids, await hearthFacts()) };
  });
  const nightSchema = z.object({
    key: z.string().min(1).max(400),
    startsAt: z.string().min(1).max(40),
    timeZone: z.string().min(1).max(64),
    spots: z.number().int().min(1).max(500).nullable(),
    note: z.string().max(500),
    watch: z.string().max(1000).optional(),
    code: z.string().max(60).optional(),
    look: z.enum(["cinematic", "streaming", "compact", "banner"]).optional(),
    reminders: z.array(z.enum(["day", "hour", "start"])).max(3),
    channels: z.array(z.string().max(80)).max(20),
  });
  app.get("/api/movie-nights", async (request) => {
    announceOwner(request);
    const [list, destinations] = await Promise.all([nights.list(), notifier.movieNightChannels()]);
    return {
      nights: list,
      destinations: destinations.map((c) => ({ id: c.id, name: c.name, buttons: c.buttons })),
    };
  });
  app.get("/api/movie-nights/channels", async (request) => {
    announceOwner(request);
    return { channels: await nights.channelLinks() };
  });
  app.put("/api/movie-nights/channels", async (request) => {
    announceOwner(request);
    const { channels } = z
      .object({
        channels: z
          .array(z.object({ name: z.string().max(100), link: z.string().max(300) }))
          .max(30),
      })
      .parse(request.body);
    return { channels: await nights.saveChannelLinks(channels) };
  });
  app.get("/api/movie-nights/places", async (request) => {
    announceOwner(request);
    return { places: await nights.places() };
  });
  app.put("/api/movie-nights/places", async (request) => {
    announceOwner(request);
    const { places } = z
      .object({
        places: z.array(z.object({ name: z.string().max(60), text: z.string().max(1000) })).max(30),
      })
      .parse(request.body);
    return { places: await nights.savePlaces(places) };
  });
  app.get<{ Querystring: { q?: string } }>("/api/movie-nights/titles", async (request) => {
    announceOwner(request);
    return media.arrivals.search("movie", String(request.query.q ?? "").slice(0, 100));
  });
  app.post("/api/movie-nights/preview", async (request) => {
    announceOwner(request);
    const input = nightSchema.omit({ channels: true }).parse(request.body);
    const m = await nights.preview(input);
    return {
      payload: m.payload,
      // Mentions in the preview show the saved names, as Discord will.
      channels: Object.fromEntries(m.channels.map((c) => [c.id, c.name])),
      images: Object.fromEntries(
        m.files.map((f) => [f.name, `data:${f.type};base64,${f.bytes.toString("base64")}`]),
      ),
    };
  });
  app.post("/api/movie-nights", async (request) => {
    announceOwner(request);
    const night = await nights.create(nightSchema.parse(request.body));
    await recordAudit(db, {
      actor: "you",
      action: `Planned a movie night: ${night.title}`,
      target: "notifications",
    });
    return night;
  });
  app.patch<{ Params: { id: string } }>("/api/movie-nights/:id", async (request) => {
    announceOwner(request);
    const patch = nightSchema
      .pick({
        startsAt: true,
        spots: true,
        note: true,
        watch: true,
        code: true,
        look: true,
        reminders: true,
      })
      .partial()
      .parse(request.body);
    return nights.update(request.params.id, patch);
  });
  app.post<{ Params: { id: string } }>("/api/movie-nights/:id/cancel", async (request) => {
    announceOwner(request);
    const night = await nights.cancel(request.params.id);
    await recordAudit(db, {
      actor: "you",
      action: `Cancelled a movie night: ${night.title}`,
      target: "notifications",
    });
    return night;
  });
  app.post<{ Params: { id: string } }>("/api/movie-nights/:id/guests", async (request) => {
    announceOwner(request);
    const change = z
      .object({ add: z.string().max(60).optional(), remove: z.string().max(60).optional() })
      .parse(request.body);
    return nights.guests(request.params.id, change);
  });
  app.post<{ Params: { id: string } }>("/api/movie-nights/:id/retry", async (request) => {
    announceOwner(request);
    return nights.retry(request.params.id);
  });
  app.post("/api/movie-nights/check", async (request) => {
    announceOwner(request);
    await nights.tick();
    return { nights: await nights.list() };
  });

  /* ---------- Briefs and watches: summaries on a schedule, a word when something trips ---------- */
  // They only read and tell (Talome Gap Plan, item 3); a change to a system is still a plan.
  briefs.briefing = () => buildDashboardBriefing(handle, findings);
  const weekDay = z.number().int().min(0).max(6);
  const briefWhat = z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("summary"),
        days: z.array(weekDay).min(1).max(7),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Give the time as HH:MM, like 07:00."),
      })
      .strict(),
    z
      .object({
        kind: z.literal("disk"),
        percent: z.number().int().min(1).max(99),
        volumeId: z.string().max(200).optional(),
      })
      .strict(),
    z.object({ kind: z.literal("service-down"), serviceId: z.string().min(1).max(200) }).strict(),
    z.object({ kind: z.literal("host-offline"), hostId: z.string().max(200).optional() }).strict(),
  ]);
  const briefBody = z
    .object({
      name: z.string().trim().max(120).optional(),
      what: briefWhat,
      channels: z.array(z.string().max(120)).max(20).optional(),
      enabled: z.boolean().optional(),
    })
    .strict();
  type BriefId = { Params: { id: string } };
  app.get("/api/briefs", async () => ({
    briefs: await briefs.list(),
    channels: await briefs.channels(),
  }));
  app.post("/api/briefs", async (request, reply) => {
    const body = briefBody.parse(request.body ?? {});
    const by = request.session?.id === "ember" ? "ember" : "owner";
    const made = await briefs.create(body as Parameters<typeof briefs.create>[0], by);
    await recordAudit(db, {
      actor: by === "ember" ? "agent" : "you",
      action: "Added a brief",
      target: `brief:${made.id}`,
      detail: { name: made.name, says: made.says },
    });
    return reply.code(201).send(made);
  });
  app.patch<BriefId>("/api/briefs/:id", async (request) => {
    const patch = briefBody.partial().parse(request.body ?? {});
    const changed = await briefs.update(
      request.params.id,
      patch as Parameters<typeof briefs.update>[1],
    );
    // Changed in place (11-13); a plain on/off is the switch's own, not worth a line.
    if (Object.keys(patch).some((k) => k !== "enabled"))
      await recordAudit(db, {
        actor: request.session?.id === "ember" ? "agent" : "you",
        action: `Changed the brief "${changed.name}"`,
        target: `brief:${changed.id}`,
        detail: { says: changed.says },
      });
    return changed;
  });
  app.delete<BriefId>("/api/briefs/:id", async (request, reply) => {
    await briefs.remove(request.params.id);
    return reply.code(204).send();
  });
  app.post<BriefId>("/api/briefs/:id/send", async (request) => briefs.sendNow(request.params.id));
  // Browser tests and Send now: run the minute check right away.
  app.post("/api/briefs/check", async () => {
    await briefs.tick();
    return { briefs: await briefs.list() };
  });

  /* ---------- Release watch: requested movies followed until they arrive (you only) ---------- */
  const watches =
    givenWatches ??
    new Watches(
      handle,
      new MovieReleases(handle, apps.broker, fakeApps?.fetch ?? (fetch as unknown as Fetch)),
      notifier,
    );
  // Ember reads them too (release_watches, read only).
  if (agents.cave) agents.cave.watches = () => watches.list();
  const watchView = z.enum(["upcoming", "attention", "completed", "dismissed"]);
  type WatchId = { Params: { id: string } };
  app.get<{ Querystring: { view?: string } }>("/api/watches", async (request) => ({
    watches: await watches.list(
      request.query.view ? watchView.parse(request.query.view) : undefined,
    ),
    settings: await watches.settings(),
    ...(await watches.sources()),
  }));
  app.patch("/api/watches/settings", async (request) =>
    watches.updateSettings(
      z
        .object({
          enabled: z.boolean().optional(),
          region: z.string().max(2).optional(),
          overdueAfterDays: z.number().int().min(0).max(60).optional(),
          notify: z
            .object({
              dates: z.boolean().optional(),
              "out-today": z.boolean().optional(),
              problems: z.boolean().optional(),
              arrived: z.boolean().optional(),
            })
            .strict()
            .optional(),
        })
        .strict()
        .parse(request.body ?? {}) as Parameters<typeof watches.updateSettings>[0],
    ),
  );
  // Look for new requests and check whatever is due, now rather than on the next timer.
  app.post("/api/watches/check", async () => {
    const found = await watches.discover();
    await watches.tick();
    return found;
  });
  app.get<WatchId>("/api/watches/:id", async (request) => watches.get(request.params.id));
  app.post<WatchId>("/api/watches/:id/check", async (request) =>
    watches.checkNow(request.params.id),
  );
  app.post<WatchId>("/api/watches/:id/snooze", async (request, reply) => {
    const { days } = z
      .object({ days: z.number().int() })
      .strict()
      .parse(request.body ?? {});
    await watches.snooze(request.params.id, days);
    return reply.code(204).send();
  });
  app.post<WatchId>("/api/watches/:id/unsnooze", async (request, reply) => {
    await watches.unsnooze(request.params.id);
    return reply.code(204).send();
  });
  app.post<WatchId>("/api/watches/:id/dismiss", async (request, reply) => {
    await watches.dismiss(request.params.id);
    return reply.code(204).send();
  });
  app.post<WatchId>("/api/watches/:id/restore", async (request, reply) => {
    await watches.restore(request.params.id);
    return reply.code(204).send();
  });

  /* ---------- Projects (command center): long-running work, on the memory projects ---------- */
  app.get<{ Querystring: { all?: string } }>("/api/projects", async (request) =>
    projects.list({ includeDone: request.query.all === "1" }),
  );
  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request) =>
    projects.get(request.params.id),
  );
  app.post("/api/projects", async (request) =>
    projects.create(schemas.project.parse(request.body)),
  );
  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (request) =>
    projects.update(request.params.id, schemas.projectPatch.parse(request.body)),
  );
  app.post<{ Params: { id: string } }>("/api/projects/:id/tasks", async (request) =>
    projects.addTask(
      request.params.id,
      z
        .object({ title: z.string().trim().min(1).max(200) })
        .strict()
        .parse(request.body).title,
    ),
  );
  app.patch<{ Params: { id: string; taskId: string } }>(
    "/api/projects/:id/tasks/:taskId",
    async (request) =>
      projects.updateTask(
        request.params.id,
        request.params.taskId,
        z
          .object({
            title: z.string().trim().min(1).max(200).optional(),
            status: z.enum(PROJECT_TASK_STATUSES).optional(),
          })
          .strict()
          .parse(request.body),
      ),
  );
  app.delete<{ Params: { id: string; taskId: string } }>(
    "/api/projects/:id/tasks/:taskId",
    async (request, reply) => {
      await projects.removeTask(request.params.id, request.params.taskId);
      return reply.code(204).send();
    },
  );

  /* ---------- Jobs (Cave 2): plans you approve once, carried out step by step ---------- */
  app.get<{ Querystring: { limit?: string } }>("/api/jobs", async (request) =>
    jobs.list(Math.min(Math.max(Number(request.query.limit) || 30, 1), 100)),
  );
  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request) =>
    jobs.get(request.params.id),
  );
  // Large enough for an uploaded .torrent (base64) in a plan to add it.
  app.post("/api/jobs", { bodyLimit: 7 * 1024 * 1024 }, async (request) => {
    const body = schemas.job.parse(request.body);
    return jobs.create({ ...body, requestedBy: "you" });
  });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/decision", async (request) => {
    const { decision, fingerprint } = schemas.decision.parse(request.body);
    // A protected change (VPN, Caddy, networking): approving it needs a fresh "it's you".
    if (decision === "approve") {
      const job = await jobs.get(request.params.id);
      if (job.steps.some((s) => s.params?.protected === "yes")) {
        const session = request.session;
        if (!session || !auth.recentlyVerified(session))
          throw new ForbiddenAuthError(
            job.steps.every((s) => s.kind === "credential-import")
              ? "This plan stores keys in Secure Vault. Confirm it's you, then approve it."
              : "This plan changes a protected system. Confirm it's you, then approve it.",
          );
      }
    }
    return jobs.decide(request.params.id, decision, fingerprint);
  });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/stop", async (request) =>
    jobs.stop(request.params.id),
  );

  // Actions you ask for. Everything else (automatic repairs) goes through the same runner.
  app.post("/api/actions", async (request) => {
    const { kind, serviceId, logs } = schemas.action.parse(request.body);
    // An access key's "act" scope covers checks and restarts; start and stop need you, signed in.
    if (request.key && POWER_ACTIONS.includes(kind as ActionKind)) {
      throw new ForbiddenAuthError("Starting and stopping containers needs you, signed in.");
    }
    return runner.request({
      kind: kind as ActionKind,
      serviceId,
      requestedBy: "you",
      ...(kind === "inspect-logs" && logs && Object.keys(logs).length ? { logs } : {}),
    });
  });

  // Notification channels: settings here, secrets straight into the vault.
  // Browser push, turned on per device (notify/push.ts).
  app.get<{ Querystring: { endpoint?: string } }>("/api/notifications/push", async (request) => ({
    publicKey: await notifier.pushKey(),
    ...(await notifier.pushDevices(request.query.endpoint)),
  }));
  app.post("/api/notifications/push", async (request, reply) => {
    if (request.session?.method === "home")
      throw new ForbiddenAuthError("Turn push on from Hearth itself.");
    const body = z
      .object({
        subscription: z.object({
          endpoint: z.string().url().max(1000),
          keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
        }),
        name: z.string().trim().min(1).max(60),
      })
      .parse(request.body);
    await notifier.pushSubscribe(body.subscription, body.name, originOf(request).origin);
    return reply.code(204).send();
  });
  app.delete<{ Querystring: { endpoint?: string } }>(
    "/api/notifications/push",
    async (request, reply) => {
      await notifier.pushUnsubscribe(String(request.query.endpoint ?? ""));
      return reply.code(204).send();
    },
  );
  app.put<{ Params: { id: string } }>("/api/notifications/channels/:id", async (request, reply) => {
    const { values } = schemas.channel.parse(request.body);
    await notifier.configure(request.params.id, values, originOf(request).origin);
    return reply.code(204).send();
  });

  // Change (11-13): everything about a destination in one save, a test before saving, Switch
  // back to the way it sent before, and Undo.
  const draftSchema = z.object({
    name: z.string().min(1).max(60),
    kind: z.enum([
      "email",
      "discord",
      "discord-bot",
      "hearth-bot",
      "ntfy",
      "push",
      "telegram",
      "webhook",
    ]),
    values: z.record(z.string(), z.string().max(2000)),
    audience: z.enum(["private", "public"]),
    quiet: z.enum(["hold", "any"]),
    routes: z.array(z.string().max(60)).max(50),
  });
  app.put<{ Params: { id: string } }>(
    "/api/notifications/channels/:id/change",
    async (request, reply) => {
      await notifier.change(
        request.params.id,
        draftSchema.parse(request.body),
        originOf(request).origin,
      );
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { id: string } }>("/api/notifications/channels/:id/try", async (request) =>
    notifier.tryDraft(request.params.id, draftSchema.parse(request.body)),
  );
  app.post<{ Params: { id: string } }>(
    "/api/notifications/channels/:id/switch-back",
    async (request, reply) => {
      await notifier.switchBack(request.params.id);
      return reply.code(204).send();
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/notifications/channels/:id/previous",
    async (request, reply) => {
      await notifier.forgetPrevious(request.params.id);
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/notifications/channels/:id/undo",
    async (request, reply) => {
      await notifier.undoChange(request.params.id);
      return reply.code(204).send();
    },
  );
  app.get("/api/notifications/change-state", async () => notifier.changeState());

  app.delete<{ Params: { id: string } }>(
    "/api/notifications/channels/:id",
    async (request, reply) => {
      await notifier.remove(request.params.id);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>("/api/notifications/channels/:id/test", async (request) =>
    notifier.sendTest(request.params.id),
  );
  // The official Hearth bot: whether it is offered here, its Add to my server link, its channels.
  app.get("/api/notifications/hearth-bot", async () => ({ available: hearthBotAvailable() }));
  app.post("/api/notifications/hearth-bot", async (request) => {
    const { action } = z
      .object({ action: z.enum(["invite", "channels"]) })
      .parse(request.body ?? {});
    return notifier.hearthBotSetup(action);
  });
  // Your Discord bot's setup: its name, its add-to-server link, and the channels it can post in.
  app.post<{ Params: { id: string } }>("/api/notifications/channels/:id/bot", async (request) => {
    const { token } = z.object({ token: z.string().max(200).optional() }).parse(request.body ?? {});
    return notifier.botLookup(request.params.id, token);
  });
  // Another destination of a kind (a second Discord channel, for friends and family, say).
  app.post("/api/notifications/destinations", async (request) => {
    const input = z
      .object({
        kind: z.string().max(20),
        name: z.string().min(1).max(60),
        audience: z.enum(["private", "public"]).default("private"),
      })
      .parse(request.body);
    return { id: await notifier.addDestination(input) };
  });
  app.put<{ Params: { id: string } }>(
    "/api/notifications/channels/:id/enabled",
    async (request, reply) => {
      const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
      await notifier.setEnabled(request.params.id, enabled);
      return reply.code(204).send();
    },
  );

  app.get("/api/audit", async (request) => {
    const { limit } = schemas.auditQuery.parse(request.query);
    return listAudit(db, limit);
  });

  app.post("/api/discovery/scan-remote", async (request) => {
    const input = schemas.scanRemote.parse(request.body);
    const hosts = await db.select().from(tables.hosts);
    const clash = hosts.find(
      (h) => h.connection === "this-machine" && slug(h.name) === slug(input.name),
    );
    if (clash) throw new ConflictError(`${clash.name} is the machine Hearth runs on.`);
    latestScan = await markRemovedFindings(handle, await runRemoteDiscovery(probes, input));
    return latestScan;
  });

  // This machine's own numbers (CPU, memory, drives, uptime), read live. Nothing has to be
  // adopted for these: a PC with no apps still shows its numbers on Home (10-30). Read at
  // most every few seconds, however many windows ask.
  let machine: { at: number; read: Promise<DiscoveryReport["host"]> } | undefined;
  app.get("/api/machine", async () => {
    if (!machine || Date.now() - machine.at > 5_000) {
      const read = probes.host();
      machine = { at: Date.now(), read };
      read.catch(() => {
        if (machine?.read === read) machine = undefined;
      });
    }
    return machine.read;
  });

  // Where this machine's memory goes, what can be stopped, and the quick win (Systems > Memory;
  // the owner, 2026-11-02). Another PC's comes through /api/on/<pc>/machine/memory. Read at most
  // every few seconds: listing every process takes the system a moment.
  let memoryRead: { at: number; read: ReturnType<MemoryOperations["breakdown"]> } | undefined;
  app.get<{ Querystring: { fresh?: string } }>("/api/machine/memory", async (request) => {
    if (!memoryRead || Date.now() - memoryRead.at > (request.query.fresh ? 500 : 1_500)) {
      const read = memoryOps.breakdown();
      memoryRead = { at: Date.now(), read };
      read.catch(() => {
        if (memoryRead?.read === read) memoryRead = undefined;
      });
    }
    return memoryRead.read;
  });

  app.post("/api/discovery/scan", async () => {
    // Clicking twice shares one scan instead of starting a second.
    scanInFlight ??= runDiscovery(probes).finally(() => {
      scanInFlight = undefined;
    });
    // Systems you removed are shown as removed, never ticked or added back.
    latestScan = await markRemovedFindings(handle, await scanInFlight);
    return latestScan;
  });

  // Storage & Files (the panel): drives, layout, arrays, capacity, journeys, findings. Read only.
  // Hearth's own data and keys never show in the file manager.
  const volumeNames = new VolumeNames(handle);
  const fileManager = new FileManager(
    handle,
    [config.keyDir, config.dataDir].filter((x): x is string => Boolean(x)),
    volumeNames,
  );
  // Your names for drives ("Film" for /mnt/f): display only, the mounts are never changed.
  app.put<{ Body: { mount?: string; name?: string | null } }>(
    "/api/storage-center/names",
    async (request) => {
      if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
      const mount = String(request.body?.mount ?? "");
      // Any drive Hearth knows, the system drive included (it is not in the file manager).
      const known = (
        await handle.db.select({ mount: tables.volumes.mount }).from(tables.volumes)
      ).some((v) => v.mount === mount);
      if (!known) throw new InvalidRequestError("That is not one of this machine's drives.");
      return volumeNames.set(mount, request.body?.name ?? null);
    },
  );
  const storageCenter = new StorageCenterService(
    handle,
    apps,
    findings.findings,
    runner.containerTools,
    fileManager,
    volumeNames,
    new SmartReader(admin.elevation),
    () => raidOps.report(),
  );
  const signedIn = (request: { session?: unknown }) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
  };
  // File operations refuse folders the download and library apps manage: tell them which.
  fileOps.usePlaces(() => storageCenter.places());
  fileOps.useElevation(admin.elevation);
  raidOps.useElevation(admin.elevation);
  raidOps.useJobs((job) => jobs.create(job));
  // Ember sees the same drives and folders (read only), to propose file changes you approve.
  if (agents.cave) agents.cave.files = fileManager;
  if (agents.cave) agents.cave.raid = raidOps;
  // Recently Added: every file on the drives, first seen when; indexed every ten minutes.
  const fileIndexer = new FileIndexer(
    handle,
    fileManager,
    () => storageCenter.noisePaths(),
    () => storageCenter.places(),
  );
  const stopIndexing = fileIndexer.start();
  app.addHook("onClose", async () => stopIndexing());
  app.get<{
    Querystring: {
      days?: string;
      kind?: string;
      q?: string;
      gone?: string;
      role?: string;
      arrivals?: string;
    };
  }>("/api/storage-center/added", async (request) => {
    signedIn(request);
    const days = Math.min(365, Math.max(1, Number(request.query.days ?? 7) || 7));
    const kind = (request.query.kind ?? "all") as AddedKind | "all";
    return fileIndexer.added({
      days,
      kind,
      q: String(request.query.q ?? "").slice(0, 120),
      includeGone: request.query.gone === "1",
      // Observed arrivals by default; "all" adds the files already there when watching began.
      arrivals: request.query.arrivals === "all" ? "all" : "observed",
      places: await storageCenter.places(),
      role:
        request.query.role === "library" || request.query.role === "downloads"
          ? request.query.role
          : "all",
    });
  });
  app.post("/api/storage-center/added/refresh", async (request) => {
    signedIn(request);
    return (await fileIndexer.run()) ?? null;
  });
  // The file manager: this machine's drives and watched folders. Read only; secrets left out.
  type FileQuery = { Querystring: { root?: string; path?: string; q?: string; inline?: string } };
  app.get("/api/files/roots", async (request) => {
    signedIn(request);
    return fileManager.roots();
  });
  app.get<FileQuery>("/api/files/list", async (request) => {
    signedIn(request);
    return fileManager.list(String(request.query.root ?? ""), request.query.path);
  });
  app.get<FileQuery>("/api/files/properties", async (request) => {
    signedIn(request);
    return fileManager.properties(String(request.query.root ?? ""), request.query.path);
  });
  app.get<FileQuery>("/api/files/search", async (request) => {
    signedIn(request);
    return fileManager.search(
      String(request.query.root ?? ""),
      request.query.path,
      String(request.query.q ?? "").slice(0, 120),
    );
  });
  app.get<FileQuery>("/api/files/preview", async (request) => {
    signedIn(request);
    return fileManager.preview(String(request.query.root ?? ""), String(request.query.path ?? ""));
  });
  // A file to the owner's browser: images inline (sandboxed), anything else as a download.
  app.get<FileQuery>("/api/files/open", async (request, reply) => {
    signedIn(request);
    const f = await fileManager.open(
      String(request.query.root ?? ""),
      String(request.query.path ?? ""),
    );
    const inline = request.query.inline === "1" && f.image;
    if (!inline)
      await recordAudit(db, {
        actor: "you",
        action: `Downloaded ${f.name} from the file manager`,
        target: `file:${request.query.root}/${request.query.path}`,
      });
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    const type = inline
      ? ({
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          png: "image/png",
          gif: "image/gif",
          webp: "image/webp",
          bmp: "image/bmp",
        }[ext] ?? "application/octet-stream")
      : "application/octet-stream";
    return reply
      .header("Content-Type", type)
      .header("Content-Length", String(f.size))
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "sandbox; default-src 'none'")
      .header(
        "Content-Disposition",
        `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      )
      .send(f.stream);
  });
  // RAID / Arrays: the arrays, drives that could join them, and what can be done (read only;
  // changes are storage-raid plan steps).
  app.get<{ Querystring: { refresh?: string } }>("/api/storage-center/raid", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return raidOps.report(request.query.refresh === "1");
  });
  // SnapRAID: what changed since the last sync (read only: added, deleted, changed, moved files).
  app.get("/api/storage-center/raid/snapraid-diff", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return raidOps.snapraidDiff();
  });
  // Collection PDF: folders to list, a scan in the background, and the PDFs it made.
  const catalog = new CatalogService(handle, fileManager, config.dataDir ?? config.keyDir, () =>
    apps.showYears(),
  );
  app.get("/api/catalog", async (request) => {
    signedIn(request);
    return catalog.state();
  });
  app.put<{ Body: unknown }>("/api/catalog/settings", async (request) => {
    signedIn(request);
    return catalog.saveSettings(request.body);
  });
  app.post("/api/catalog/make", async (request) => {
    signedIn(request);
    return catalog.start();
  });
  // The PDF itself: shown in the browser's PDF viewer, or downloaded with ?download=1.
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    "/api/catalog/files/:id",
    async (request, reply) => {
      signedIn(request);
      const f = await catalog.file(request.params.id);
      const body = await readFile(f.path);
      return reply
        .header("Content-Type", "application/pdf")
        .header("Content-Length", String(body.length))
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "private, no-store")
        .header(
          "Content-Disposition",
          `${request.query.download === "1" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        )
        .send(body);
    },
  );
  app.delete<{ Params: { id: string } }>("/api/catalog/files/:id", async (request) => {
    signedIn(request);
    await catalog.remove(request.params.id);
    return { ok: true };
  });
  app.get("/api/storage-center", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return storageCenter.read();
  });
  // Drive health (SMART) through the elevated executor's read-only operation; cached half an hour.
  app.get<{ Querystring: { refresh?: string } }>("/api/storage-center/smart", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return storageCenter.smart(request.query.refresh === "1");
  });
  // Recent files in the watched folders: on request only, bounded, cached (it touches the disks).
  app.get<{ Querystring: { hours?: string } }>("/api/storage-center/recent", async (request) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return storageCenter.recent(Number(request.query.hours ?? 24) || 24);
  });

  // Storage browsing: read only, and only inside folders you chose to watch.
  app.get<{ Params: { id: string } }>("/api/storage/:id/browse", async (request) =>
    browse(handle, request.params.id, schemas.storagePath.parse(request.query).path),
  );
  app.get<{ Params: { id: string } }>("/api/storage/:id/properties", async (request) =>
    properties(handle, request.params.id, schemas.storagePath.parse(request.query).path),
  );
  app.post("/api/storage/locations", async (request, reply) => {
    const location = await addLocation(handle, schemas.addLocation.parse(request.body));
    return reply.code(201).send(location);
  });
  app.post("/api/storage/disks/refresh", async () => {
    if ((await getSetting(db, "environment")) !== "real") {
      throw new ConflictError(
        "Drive health is read from your own systems. Discover this machine first.",
      );
    }
    const host = (await db.select().from(tables.hosts)).find(
      (h) => h.connection === "this-machine",
    );
    if (!host) throw new ConflictError("Discover this machine first.");
    const disks = await probes.disks(host.id);
    await withTransaction(handle, () => saveDisks(db, host.id, disks));
    return disks;
  });

  app.delete<{ Params: { id: string } }>("/api/storage/locations/:id", async (request, reply) => {
    await removeLocation(handle, request.params.id);
    return reply.code(204).send();
  });

  // Monitoring: run checks now (read only), and simulate failures on sample data.
  app.post("/api/monitor/run", async (request) => {
    const { serviceId } = schemas.runChecks.parse(request.body ?? {});
    if (
      serviceId &&
      !(await db.select().from(tables.services).where(eq(tables.services.id, serviceId)).get())
    ) {
      throw new NotFoundError("No such service.");
    }
    const summary = await runChecks(handle, monitorProbes, {
      serviceIds: serviceId ? [serviceId] : undefined,
    });
    runner.respond(summary.openedIncidents);
    // A check of everything also reads inside the apps (read only; never answered with a restart).
    if (!serviceId && (await apps.check()).length) runner.onChange?.();
    notifier.kick();
    return summary;
  });

  app.post("/api/demo/simulate", async (request, reply) => {
    const { serviceId, condition } = schemas.simulate.parse(request.body);
    if ((await getSetting(db, "environment")) !== "demo") {
      throw new ConflictError(
        "Failures can only be simulated on sample data, never on your own systems.",
      );
    }
    if (!(await db.select().from(tables.services).where(eq(tables.services.id, serviceId)).get())) {
      throw new NotFoundError("No such service.");
    }
    if (condition === "upstream") {
      const depIds = (
        await db
          .select()
          .from(tables.serviceDependencies)
          .where(eq(tables.serviceDependencies.serviceId, serviceId))
      ).map((d) => d.dependsOnId);
      const cause = (await db.select().from(tables.services)).find(
        (s) => depIds.includes(s.id) && s.checkTarget?.startsWith("demo:"),
      );
      if (!cause) {
        throw new ConflictError("This service does not depend on anything Hearth watches.");
      }
      simulate(cause.id, "down");
      simulate(serviceId, "cascade", cause.id);
    } else {
      simulate(serviceId, condition);
    }
    return reply.code(204).send();
  });

  // "No scan yet" is a normal answer, not an error.
  app.get("/api/discovery/latest", async () => ({ report: latestScan ?? null }));

  app.post("/api/discovery/adopt", async (request) => {
    const { reportId, selections } = schemas.adopt.parse(request.body);
    if (!latestScan || latestScan.id !== reportId) {
      throw new ConflictError("That scan is no longer current. Scan again, then adopt.");
    }
    const scan = latestScan;
    const result = await findings.exclusive(() => adoptDiscovery(handle, scan, selections));
    const host = latestScan.host;
    await memory.recordSystem(db, {
      title: result.services
        ? `Added ${result.services} services on ${host.name} to Hearth`
        : `Hearth watches ${host.name} itself (no services added)`,
      body: `From a scan of ${host.name} (${host.os}, ${host.address}): ${selections
        .map((s) => s.name)
        .join(", ")}.`,
      machine: host.name,
      happenedAt: latestScan.scannedAt,
      links: [{ label: host.name, ref: `host:${host.id}` }],
    });
    latestScan = undefined; // adopted; the next visit starts fresh
    return result;
  });

  app.post("/api/demo/scenario", async (request, reply) => {
    if (!config.demo) throw new NotFoundError("Demo mode is off for this installation.");
    const { scenario, replaceYourSystems } = schemas.scenario.parse(request.body);
    if ((await getSetting(db, "environment")) === "real" && !replaceYourSystems) {
      throw new ConflictError(
        "Hearth is showing your own systems. Switching to sample data replaces them until you scan again.",
      );
    }
    await findings.exclusive(() => seedDemo(handle, scenario as (typeof DEMO_SCENARIOS)[number]));
    latestScan = undefined;
    // The new sample homelab's findings at once, not on the next monitoring pass, so the
    // dashboard shows the scenario as it is from the first look.
    await apps.check().catch(() => undefined);
    await findings.tick({ only: findings.analyzers.map((a) => a.id) }).catch(() => undefined);
    return reply.code(204).send();
  });

  const indexHtml = path.join(config.webDir, "index.html");
  const hasWeb = existsSync(indexHtml);
  if (hasWeb) {
    // preCompressed: the build writes .br/.gz copies of large files (vite.config.ts).
    await app.register(fastifyStatic, {
      root: config.webDir,
      wildcard: false,
      preCompressed: true,
    });
  } else {
    app.log.warn({ webDir: config.webDir }, "web UI not built; serving API only");
  }

  // Unknown API routes are JSON 404s; anything else is a client-side route in the SPA.
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/") || !hasWeb || request.method !== "GET") {
      return reply.code(404).send({ error: "Not Found", path: request.url });
    }
    return reply.type("text/html").sendFile("index.html");
  });

  return app;
}

/** A panel's failure for the web: the reason, and what the owner can do about it right there. */
function panelError(error: unknown) {
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof GapError && error.blocker ? { blocker: error.blocker } : {}),
  };
}

/** Freeing memory on this machine: the real one, or the stand-in machine in tests. */
export function memoryOperations(handle: DbHandle): MemoryOperations {
  const services = async () =>
    (await handle.db.select().from(tables.services).all()).map((s) => ({
      id: s.id,
      name: s.name,
      image: s.image,
      checkTarget: s.checkTarget,
      lifecycle: s.lifecycle,
      stoppedAt: s.stoppedAt,
    }));
  if (process.env.DC_FAKE_MEMORY === "1") {
    const fake = fakeMemory();
    const ops = new MemoryOperations(() => fake.sources(), services, fake.close);
    ops.bind(fake.hooks);
    return ops;
  }
  return new MemoryOperations((hooks) => realMemorySources(() => hooks.voiceLoaded()), services);
}
