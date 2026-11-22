import { eq, sql } from "drizzle-orm";
import type { Autonomy, DemoScenario } from "@dragon-control/core";
import type { Database } from "../db/client";
import { settings } from "../db/schema";

export interface SettingValues {
  /** Speaker names the owner gave in Hearth (11-13), by Home Assistant entity. */
  speaker_names?: Record<string, string>;
  /** "Turn on persona": Ember talks as her chosen picture (Ember Personas design, 11-07). */
  look_persona: import("@dragon-control/core").LookPersonaSetting;
  /** Titles requested from a Forge pick sheet, waiting to arrive in Plex (workspaces/awaiting.ts). */
  forge_awaiting: import("../workspaces/awaiting").Awaiting[];
  /** This computer as a Music Assistant speaker (on unless turned off), and its name. */
  host_speaker: { on: boolean; name?: string };
  /** Where screen captures are saved on Hearth's computer (cave/capture-folder.ts). */
  capture_folder: { path: string };
  /** Recommend: titles you said you've seen, never suggested again (recommend/service.ts). */
  recommend_seen: (import("@dragon-control/core").RecommendSeen & { at: string })[];
  /**
   * The home dashboard's weather: "auto" (the National Weather Service in the US, else
   * Open-Meteo) or Home Assistant's own; the places, the first the main one (none: the home).
   */
  home_weather: {
    source: "auto" | "homeassistant";
    places: { label: string; lat: number; lon: number }[];
  };
  /** Ember Show & Tell: whether Ember opens and points at what it examines (checklist 45). */
  show_and_tell: Partial<import("@dragon-control/core").ShowSettings>;
  instance_name: string;
  /** Sorting manual downloads, per qBittorrent service (its setup plan turns it on). */
  manual_sort: Record<string, import("@dragon-control/core").ManualSortConfig>;
  /** What the sorter did, newest first (the last 200). */
  manual_sort_log: import("@dragon-control/core").ManualSortEvent[];
  /** Download Health: strikes between checks and the last overview (it changes nothing). */
  /** Download Health's Fix it: each movie or episode's replacements (arr-operations.ts). */
  download_recoveries: Record<string, string[]>;
  download_health: {
    strikes: Record<string, import("@dragon-control/core").Strike>;
    overview: import("@dragon-control/core").DownloadHealthOverview;
    sample?: boolean;
  };
  /**
   * Incidents the owner dismissed, by monitor key: not opened again while the problem reads the
   * same (same title). Cleared when it recovers, so a later, new problem is raised as usual.
   */
  incident_mutes: Record<string, { title: string; at: string }>;
  /** When downloads started or stopped needing attention, newest first. */
  download_health_log: import("./../apps/download-health").HealthRecord[];
  /** Audiobook intake, per Audiobookshelf service (its setup plan turns it on). */
  audiobook_intake: Record<string, import("@dragon-control/core").IntakeConfig>;
  /** The releases intake has judged, per Audiobookshelf service, newest first. */
  audiobook_intake_jobs: Record<string, import("@dragon-control/core").IntakeJob[]>;
  /** This PC had its own account before it joined another Hearth: it keeps it if removed. */
  pc_kept_own_account: boolean;
  /** The layout last arranged in a browser here, for another Hearth to copy (layout/copy.ts). */
  layout_browser: { values: Record<string, string>; at: string };
  /** The layout before the last copy, for Undo. */
  layout_before_copy: {
    at: string;
    parts: string[];
    theme: unknown;
    lookStyle: unknown;
    deskLayouts: unknown[];
    browser: Record<string, unknown>;
  };
  /** Sites always allowed to open in a visible browser window when they refuse the background one. */
  browser_visible_sites: string[];
  /** How each Immich panel shows photos (blurred, hidden, Recent photos off), by service id. */
  immich_photo_prefs: Record<string, import("@dragon-control/core").ImmichPhotoPrefs>;
  /** Seeding rules per qBittorrent (11-11), and what they have noted. */
  seeding_rules: Record<string, import("@dragon-control/core").SeedingRule[]>;
  seeding_rule_log: Record<string, import("@dragon-control/core").SeedingLogEntry[]>;
  seeding_rule_run: Record<string, import("@dragon-control/core").SeedingRunState>;
  /** Lab Blueprint: where versions go and the public key they are encrypted to (never the recovery key). */
  blueprint_config: import("@dragon-control/core").BlueprintConfig;
  /** Lab Blueprint: versions written, the last check, the last failure and a keyed fingerprint. */
  blueprint_state: {
    versions: import("@dragon-control/core").BlueprintVersion[];
    lastCheck?: string;
    lastError?: { at: string; text: string };
    fingerprint?: string;
  };
  /** Lab Blueprint: the owner's and Ember's notes, carried into every version. */
  blueprint_notes: string;
  /** Lab Blueprint: one imported on this Hearth, for Ember to rebuild from (no secret in it). */
  blueprint_imported: {
    at: string;
    from: string;
    hearthVersion?: string;
    entries: number;
    markdown: string;
  };
  /** Jellyfin tasks turned off from Hearth: their schedule, by "serviceId:taskId", to put back. */
  jellyfin_task_triggers: Record<string, unknown[]>;
  /** Recently Added: per indexed root, its first complete pass and the folders walked. */
  file_index_roots: Record<string, { complete?: string; starts: string[] }>;
  /** How companions refer to the owner ("Sam"); unset means plain "you". */
  owner_name: string;
  /** The owner's picture: a small square image, base64, with its type. */
  owner_avatar: { mime: string; data: string };
  /** When it was set (the address carries it, so a new picture shows at once). */
  owner_avatar_at: string;
  /** Your AI's own picture (Choose from your library), same form as yours; served at AI_AVATAR_PATH. */
  ai_avatar: { mime: string; data: string };
  ai_avatar_at: string;
  /** The AI administrator's display name ("Warden"); unset means Ember (DEFAULT_AI_NAME). */
  ai_name: string;
  /** Open web UIs through the reverse proxy ("proxy", default) or the host's address. */
  web_ui_via: "proxy" | "host";
  /** The look you chose (Settings > Themes). */
  ui_theme: import("@dragon-control/core").ThemeChoice;
  /** The look on phones; unset means the same as ui_theme. */
  ui_theme_phone: import("@dragon-control/core").ThemeChoice;
  /** The Lair's systems in your order (Arrange), for every device. */
  lair_order: string[];
  /** How often each system was opened in the Lair, from every device (most used first). */
  lair_usage: Record<string, { s: number; at: number }>;
  /** "classic" on installs claimed before the Hearth rebrand (migration 0048); else Ember's flame. */
  ai_look_style: import("@dragon-control/core").LookStyle;
  quiet_hours: boolean;
  autonomy_default: Autonomy;
  /** Which environment the tables describe: sample data or your discovered systems. */
  environment: "demo" | "real";
  demo_scenario: DemoScenario;
  discovered_at: string;
  monitor_interval_sec: number;
  failure_threshold: number;
  monitor_last_run: string;
  /** Automatic repairs may run on your real systems. Off until you switch it on. */
  live_repairs: boolean;
  /** Pictures beside messages in conversations (yours and the AI's); on unless turned off. */
  chat_pictures: boolean;
  /** Only incidents opened after this are notified (so history is never sent as news). */
  notify_since: string;
  /** Where links in notifications point, learned from the browser that set up a channel. */
  app_url: string;
  /** Start of the week the last weekly summary covered. */
  weekly_sent_for: string;
  /** Briefs and watches the owner asked for (notify/briefs.ts). */
  briefs: import("@dragon-control/core").Brief[];
  /** The Hearth API key's fingerprint (pcs/hearth-key.ts), and its Secure Vault entry. */
  link_key_hash: string;
  /** The home dashboard's unlock PIN, hashed (home-pin.ts): opening doors needs it. */
  home_unlock_pin: string;
  /** The home dashboard's household board: notes, countdowns, chores, feeds (home-board.ts). */
  home_board: import("../apps/home-board").HomeBoard;
  /** Hearth Premium on this installation: its licence keys and what the issuer said (premium/). */
  premium: import("../premium/entitlements").PremiumState;
  /** The owner's licence signing key, on the issuing Hearth only (its vault entry, public half). */
  premium_issuer: import("../premium/issuer").IssuerSetting;
  /** The Crucible's saved rows, per Radarr or Sonarr service id (crucible-apply.ts). */
  crucible: Record<string, import("@dragon-control/core").CrucibleSetup>;
  /** The highest movie id the Crucible's keeper has handled, per Radarr (crucible-keeper.ts). */
  crucible_seen: Record<string, number>;
  /** The day each app's titles last followed the rules as they aged (YYYY-MM-DD). */
  crucible_aged: Record<string, string>;
  /** The private key in each Radarr's "On Movie Added" webhook address (never shown). */
  crucible_hooks: Record<string, string>;
  /**
   * Rules Ember suggested for the Crucible (11-18), waiting in the panel for the owner to add or
   * dismiss. Suggestions only: nothing reaches Radarr or Sonarr until the owner saves.
   */
  crucible_suggestions: Record<
    string,
    {
      serviceId: string;
      kind: "movie" | "show";
      row: import("@dragon-control/core").CrucibleRow;
      note?: string;
      at: string;
    }
  >;
  /**
   * The request checkpoint: each Seerr whose automatic search the Crucible took over, with the
   * default profile it had before (the clean exit puts it back).
   */
  /** Near misses (the Crucible, step 8): the daily check's results and when each title was looked at. */
  crucible_near_misses: {
    checkedAt?: string;
    items: import("@dragon-control/core").NearMissItem[];
    lastChecked: Record<string, string>;
  };
  crucible_near_miss_settings: import("@dragon-control/core").NearMissSettings;
  crucible_seerr: Record<
    string,
    {
      app?: "radarr" | "sonarr";
      serverId: number;
      profileBefore?: number;
      profileBeforeName?: string;
    }
  >;
  /** Where codes are redeemed and revocations checked (unset until the service exists). */
  premium_service_url: string;
  hearth_key_secret: string;
  /** The newest Hearth version already announced, so each is announced once. */
  update_announced: string;
  /** Check for updates (Settings, About); off: Hearth never asks GitHub on its own. */
  update_check_auto: boolean;
  /** Release channel (Settings, About): stable (releases marked stable) or fast (every release). */
  update_channel: "stable" | "fast";
  /** Ember: AI budget and models, and the day the budget warning last went out. */
  ai_budget: Partial<import("@dragon-control/core").AiBudget>;
  ai_warned_on: string;
  /** The companion's check-in: the local day it last went out, when, and what it said (JSON list). */
  checkin_sent_on: string;
  checkin_sent_at: string;
  checkin_last: string;
  /** The conversation the Ember hub on Home continues. */
  main_conversation_id: string;
  /** Which AI agent is connected as the operator, if any. */
  operator_agent: string;
  /** Hand incidents a known fix could not resolve to the operator. On unless switched off. */
  agent_escalate: boolean;
  /** The newest off-machine backup the other machine confirmed and Hearth checked. */
  offsite_last_verified: {
    file: string;
    receivedAt: string;
    destination: string;
    checkedAt: string;
  };
  offsite_last_error: { at: string; detail: string };
  /** When the off-machine queue first held a backup (the clock for "never fetched"). */
  offsite_since: string;
  /** How Ember talks (enthusiasm, humor, detail). The safety rules never depend on it. */
  cave_personality: import("@dragon-control/core").CavePersonality;
  /** Resource history: off until switched on, and how many days it keeps (monitor/history.ts). */
  resource_history: { enabled: boolean; retentionDays: number };
  restart_history: { enabled: boolean; retentionDays: number };
  /** The UTC day history (resource and uptime) was last pruned. */
  history_pruned_on: string;
  /** This installation's identifier towards plex.tv when linking Plex (not a secret). */
  plex_client_id: string;
  /** Release watch (docs/design/RELEASE_WATCH.md): on or off, which country, which news to send. */
  release_watch: import("@dragon-control/core").ReleaseWatchSettings;
  /**
   * Seerr services whose existing requests were already picked up once. The first pass is quiet,
   * so switching watching on does not send a note for every old request.
   */
  release_watch_imported: string[];
  /** Homelab rules (Settings): services only the owner changes, and times a machine is theirs. */
  do_not_touch: import("@dragon-control/core").DoNotTouch[];
  reservations: import("@dragon-control/core").Reservation[];
  /**
   * The owner's own rules for Ember in their words (Settings > Ember > Homelab rules). First filled from
   * what they added to the old Homelab project's brief; "" when there are none.
   */
  lair_rules: string;
  /**
   * When the owner finished or skipped the first-run welcome ("Meet your AI"). Unset means it
   * has not been offered yet; installs claimed before it existed are marked by migration 0046.
   */
  onboarding_done_at: string;
  /** The welcome's first choice: help building a first homelab, or an existing one. */
  journey: "build" | "existing";
  /** The welcome step reached last ("ai", "voice"...), so a closed browser resumes there. */
  onboarding_step: string;
  /** Getting started: items the owner dismissed, and whether they hid the whole list. */
  getting_started: import("@dragon-control/core").GettingStartedChoices;
  /** When the owner first met the AI (Meet Ember). */
  meet_cove_at: string;
  /** "Help me build": the owner's answers, the scan it was planned against, and what they removed. */
  /**
   * The account details the owner chose for the apps the plan will build: their email and
   * username (not secrets), and how passwords are made. A password they chose is kept only in
   * Secure Vault (secretId); generated ones are made per app at build time, straight into the vault.
   */
  homelab_accounts: {
    email: string;
    username: string;
    passwords: "generate" | "own";
    secretId?: string;
    savedAt: string;
  };
  /** "Build my plan": each step's plan, the vault ids of what it made, and the VPN login's ids. */
  homelab_build: {
    steps: Partial<
      Record<
        import("@dragon-control/core").HomelabStepId,
        { jobId?: string; done?: string; detail?: string }
      >
    >;
    secrets: Partial<Record<string, { login?: string; key?: string }>>;
    vpn?: {
      provider: import("@dragon-control/core").VpnProvider;
      type: "openvpn" | "wireguard";
      ids: Record<string, string>;
    };
    tailscaleUrl?: string;
    conversationId?: string;
  };
  homelab_plan: {
    answers: import("@dragon-control/core").BuildAnswers;
    /** The look at the machine, once the owner allowed it. */
    scan?: import("@dragon-control/core").HostScan;
    /** Their picks where the plan offered a choice ("media-app": "plex"). */
    chosen: Record<string, string>;
    removed: string[];
    /** Their decisions on goals that don't fit ("include anyway", "later", "accept"), dated. */
    decisions?: import("@dragon-control/core").GoalDecisions;
    /** They finished the plan (saved it or pressed "Next: your apps and accounts"), not just started it. */
    confirmed: boolean;
    savedAt: string;
  };
  /**
   * RAID (Storage > RAID / Arrays), by array UUID: consistency checks the owner approved to run
   * on a schedule (each run is recorded as its own plan), and where a paused check stopped.
   */
  raid_state: {
    schedules: Record<
      string,
      {
        every: "daily" | "weekly" | "monthly";
        name: string;
        approvedBy: string;
        approvedAt: string;
        jobId: string;
        lastRun?: string;
        /** What runs: a check (mdadm's check, a ZFS or Btrfs scrub) or SnapRAID's sync. */
        action?: "check" | "sync";
        tech?: string;
      }
    >;
    paused: Record<string, number>;
  };
  /** Collection PDF: its title and the folders it lists. */
  collection_catalog: import("@dragon-control/core").CatalogSettings;
  /** Collection PDFs made so far (the files are in the data folder's catalogs folder). */
  collection_catalog_files: import("@dragon-control/core").CatalogFile[];
  /** Voice: where the speech services are, the voice profiles, and which one Ember uses. */
  /** Media announcements: when each media server's baseline was read (service id to time). */
  media_baseline: Record<string, string>;
  /** The id of the last line Ember put on an announcement, per destination (never twice in a row). */
  media_last_line: Record<string, string>;
  /** How many lines Ember wrote herself today, for "Let Ember write it"'s daily allowance. */
  media_ember_lines: { day: string; n: number };
  /** Media announcements: when each server's movies were last joined to the other's by file name. */
  media_files_linked: Record<string, string>;
  /** Movie nights: the host's saved "Where to watch" texts, picked with one click. */
  movie_night_places: import("@dragon-control/core").WatchPlace[];
  /** The official Hearth bot: this Hearth's registration with its relay (kept in the vault). */
  hearth_bot: { secretId: string };
  /** Discord channels the host saved, so "#name" in movie night text links to the channel. */
  discord_channel_links: import("@dragon-control/core").ChannelLink[];
  /** Discord destinations already given the Hearth icon when they had no picture (channel ids). */
  media_picture_checked: string[];
  /** Media announcements: rules and the designer's look (Notifications, Media announcements). */
  media_announce: Partial<import("@dragon-control/core").MediaAnnounceSettings>;
  /** Hearth's Standard voice offered to Home Assistant over Wyoming (Settings, Voice). */
  voice_share: { on: boolean };
  voice_config: import("@dragon-control/core").VoiceConfig & {
    /** Built-in profiles the owner removed, so they are not added back. */
    removedBuiltIns?: string[];
  };
}

export const SETTING_DEFAULTS: Pick<
  SettingValues,
  "instance_name" | "quiet_hours" | "autonomy_default"
> = {
  instance_name: "Home",
  quiet_hours: true,
  autonomy_default: "ask",
};

export async function getSetting<K extends keyof SettingValues>(
  db: Database,
  key: K,
): Promise<SettingValues[K] | undefined> {
  const row = await db.select().from(settings).where(eq(settings.key, key)).get();
  return row ? (row.value as SettingValues[K]) : undefined;
}

/** Plain upsert; callers that need atomicity wrap it in withTransaction. */
export async function setSetting<K extends keyof SettingValues>(
  db: Database,
  key: K,
  value: SettingValues[K],
): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` },
    });
}

export async function deleteSetting(db: Database, key: keyof SettingValues): Promise<void> {
  await db.delete(settings).where(eq(settings.key, key));
}
