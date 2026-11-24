import type { IsoTime } from "./domain";

/**
 * Live application dashboards (feature request sections 3 to 9): what an app is
 * actually doing, read through the credential broker by a per-app adapter on
 * the server. Every value comes from the app itself; anything the app does not
 * report is left out, never estimated.
 */

/** One state per torrent, for grouping and colour. */
export type TorrentStatus =
  | "downloading"
  | "metadata"
  | "stalled"
  | "queued"
  | "paused"
  | "checking"
  | "moving"
  | "seeding"
  | "completed"
  | "error";

export const TORRENT_STATUS_LABEL: Record<TorrentStatus, string> = {
  downloading: "Downloading",
  metadata: "Getting metadata",
  stalled: "Stalled",
  queued: "Queued",
  paused: "Paused",
  checking: "Checking",
  moving: "Moving",
  seeding: "Seeding",
  completed: "Completed",
  error: "Error",
};

/** Where a download came from: the indexer that grabbed it, and the app that did (11-11). */
export interface GrabSource {
  /** "PublicTracker", "TrackerOne", "UsenetOne". */
  indexer: string;
  /** "Radarr", "Sonarr", "Prowlarr", or "tracker" when only the tracker's address names it. */
  via: string;
}

export interface Torrent {
  /** qBittorrent's info hash: the torrent's identity. */
  hash: string;
  name: string;
  status: TorrentStatus;
  /** qBittorrent's own state word, for the record ("stalledDL", "forcedUP"...). */
  state: string;
  /** 0 to 100, one decimal. */
  progressPct: number;
  sizeBytes: number;
  downloadedBytes: number;
  leftBytes: number;
  /** Bytes per second. */
  downSpeed: number;
  upSpeed: number;
  /** Seconds; absent when qBittorrent reports none (finished, or "infinity"). */
  etaSec?: number;
  /** Seeds and leechers Hearth's client is connected to now. */
  seedsConnected: number;
  leechersConnected: number;
  /** Seeds and leechers in the whole swarm, as the trackers report them. */
  seedsInSwarm: number;
  leechersInSwarm: number;
  ratio: number;
  /** Position in qBittorrent's queue; absent when not queued (it reports 0 or -1). */
  queuePosition?: number;
  /** The tracker currently used, as its host name only (announce URLs can carry a personal key). */
  tracker?: string;
  /** The indexer that grabbed it (from the app that grabbed it). */
  source?: GrabSource;
  /** qBittorrent's seeding time: seconds spent seeding while complete (stopped time doesn't count). */
  seedingSec?: number;
  /** The owner's seeding rule that covers it, and where it stands (seeding-rules.ts). */
  rule?: import("./seeding-rules").TorrentRuleState;
  category?: string;
  addedAt?: IsoTime;
  completedAt?: IsoTime;
  /** Last time anyone had the complete file: tells "no seeders" apart from "slow". */
  lastSeenComplete?: IsoTime;
  /** Where its files are, as qBittorrent reports it (a path inside its container). */
  contentPath?: string;
  /** Distributed copies available to this client (below 1 means it cannot complete right now). */
  availability?: number;
  /** Why it needs attention, in plain words, when it does. */
  problem?: string;
  /** Its tags, as qBittorrent lists them. */
  tags?: string[];
  /** The folder it saves into (inside qBittorrent's container). */
  savePath?: string;
  /** Automatic torrent management: qBittorrent moves its files when its category changes. */
  autoTmm?: boolean;
  /** Force started: runs whatever the queue limits say. */
  forceStart?: boolean;
}

/** One file inside a torrent, with qBittorrent's download priority for it. */
export interface TorrentFile {
  /** qBittorrent's index for the file (what a priority change names). */
  index: number;
  name: string;
  sizeBytes: number;
  progressPct: number;
  /** 0 do not download, 1 normal, 6 high, 7 maximum. */
  priority: 0 | 1 | 6 | 7;
}

/** One connected peer, as qBittorrent shows it. */
export interface TorrentPeer {
  address: string;
  client?: string;
  country?: string;
  progressPct: number;
  downSpeed: number;
  upSpeed: number;
  /** qBittorrent's connection flags ("D U E P" and so on), with its own explanation. */
  flags?: string;
}

export interface TorrentTracker {
  /** Host name only, or a qBittorrent pseudo-tracker ("DHT", "PeX", "LSD"). */
  host: string;
  status: "working" | "updating" | "not contacted" | "not working" | "disabled";
  seeds?: number;
  leechers?: number;
  /** The tracker's own message, secrets hidden. */
  message?: string;
}

export interface TorrentDetail {
  hash: string;
  trackers: TorrentTracker[];
  savePath?: string;
  /** Seconds it has been active and seeding. */
  activeSec?: number;
  seedingSec?: number;
  piecesHave?: number;
  piecesTotal?: number;
  peers: { connected: number; seeds: number; leechers: number };
  /** Its files, when read (the panel's Files view). */
  files?: TorrentFile[];
  /** Connected peers, when read (the panel's Peers view). */
  peerList?: TorrentPeer[];
  /** Transfer totals for this torrent. */
  transfer?: {
    downloadedBytes: number;
    uploadedBytes: number;
    ratio: number;
    downLimit: number;
    upLimit: number;
    addedAt?: string;
    completedAt?: string;
    createdBy?: string;
  };
}

export interface QbittorrentDashboard {
  app: "qbittorrent";
  version?: string;
  /** qBittorrent's own view of its network: connected, firewalled (no incoming), disconnected. */
  connection: "connected" | "firewalled" | "disconnected" | "unknown";
  downSpeed: number;
  upSpeed: number;
  dhtNodes?: number;
  /** Free space where it downloads, as qBittorrent reports it. */
  freeSpaceBytes?: number;
  torrents: Torrent[];
  /**
   * The VPN it depends on, from Hearth's own monitoring of that service
   * (never its configuration or credentials).
   */
  vpn?: {
    serviceId: string;
    name: string;
    health: "healthy" | "attention" | "offline";
    detail?: string;
  };
}

/**
 * Deluge's live dashboard: the same torrents as qBittorrent's (one Torrents tab serves both), with
 * Deluge's labels (its Label plugin) in place of categories, and no tags.
 */
export interface DelugeDashboard extends Omit<QbittorrentDashboard, "app"> {
  app: "deluge";
  /** Deluge's Label plugin is on (labels are its categories); off, labels cannot be set. */
  labelsEnabled: boolean;
}

/**
 * Transmission's live dashboard: the same torrents as qBittorrent's (one Torrents tab serves all
 * three), with Transmission's labels: the first one stands for the category, all show as tags.
 */
export interface TransmissionDashboard extends Omit<QbittorrentDashboard, "app"> {
  app: "transmission";
  /** Always true: Transmission's labels need no plugin. */
  labelsEnabled: boolean;
  /** Its alternative speed limits (the turtle) are on. */
  alternativeLimits: boolean;
}

export interface PlexLibrary {
  key: string;
  title: string;
  type: "movie" | "show" | "artist" | "photo" | "other";
  /** Movies, shows, artists, or photos, by type. */
  count: number;
  seasons?: number;
  episodes?: number;
}

export interface PlexItem {
  /** Plex's rating key: the item's identity. */
  id: string;
  title: string;
  type: "movie" | "episode" | "season" | "show" | "track" | "other";
  year?: number;
  show?: string;
  season?: number;
  episode?: number;
  addedAt?: IsoTime;
  /** A Plex picture path, fetched through Hearth (never with the token in the browser). */
  thumb?: string;
  /** The files behind it, as Plex sees them (recently added movies and episodes). */
  files?: string[];
}

export interface PlexSession extends PlexItem {
  /** Plex's session id. */
  sessionId: string;
  user: string;
  player: string;
  device?: string;
  platform?: string;
  state: "playing" | "paused" | "buffering" | "other";
  local?: boolean;
  progressPct: number;
  durationMs?: number;
  offsetMs?: number;
  /** How Plex delivers it: the file as is, the file repackaged, or converted. */
  decision: "direct play" | "direct stream" | "transcode";
  videoDecision?: string;
  audioDecision?: string;
  resolution?: string;
  bitrateKbps?: number;
  bandwidthKbps?: number;
  /** Transcoder speed (1 = real time); below 1 the player will run dry. */
  transcodeSpeed?: number;
  hardwareTranscode?: boolean;
  /** Why it is a problem, when Hearth can tell (buffering, transcoder too slow). */
  problem?: string;
}

export interface PlexActivity {
  title: string;
  subtitle?: string;
  progressPct?: number;
}

export interface PlexDashboard {
  app: "plex";
  version?: string;
  serverName?: string;
  totals: { movies: number; shows: number; seasons: number; episodes: number };
  libraries: PlexLibrary[];
  recentlyAdded: PlexItem[];
  sessions: PlexSession[];
  activities: PlexActivity[];
  /** Titles with more than one copy (read every few hours), when known. */
  duplicates?: PlexDuplicate[];
}

export interface PlexDuplicate {
  ratingKey: string;
  title: string;
  kind: "movie" | "episode";
  versions: number;
}

/** One item in Sonarr's or Radarr's download queue. */
export interface ArrQueueItem {
  /** The app's queue id (changes if it is re-added). */
  queueId: number;
  /** The download client's id for it (a torrent hash, a SABnzbd id). */
  downloadId?: string;
  /** "Ghosts (US) S02E01" or "Colony (2026)". */
  title: string;
  /** The release name as downloaded. */
  release?: string;
  seriesId?: number;
  episodeId?: number;
  movieId?: number;
  status: string;
  /** downloading, importPending, importBlocked, importing, failedPending, failed, ... */
  state?: string;
  progressPct?: number;
  sizeBytes?: number;
  timeLeft?: string;
  client?: string;
  indexer?: string;
  protocol?: string;
  /** Why it is stuck or failed, in the app's own words. */
  problem?: string;
  /** Where the download client put it, as the app reports it (a path inside the app's container). */
  outputPath?: string;
  /** Stuck after downloading: the files are there but were not imported. */
  stuckImport: boolean;
  /**
   * The download failed in the download client (a usenet repair that failed, an aborted job).
   * Nothing usable was downloaded; it only leaves the queue when it is removed.
   */
  failed?: boolean;
  /** The episode or movie it was for already has a file, so nothing needs searching for. */
  onDisk?: boolean;
}

/** A missing (wanted) episode or movie. */
export interface ArrMissing {
  title: string;
  seriesId?: number;
  episodeId?: number;
  movieId?: number;
  airedAt?: IsoTime;
  monitored: boolean;
}

export interface ArrUpcoming {
  title: string;
  at?: IsoTime;
  hasFile: boolean;
}

/**
 * One event from Radarr's or Sonarr's own history, for file journeys: a grab, an import (with
 * the path it took the file from and the path it put it at, as the app sees them), a failure.
 */
export interface ArrHistoryEvent {
  at?: IsoTime;
  event: "grabbed" | "imported" | "failed" | "ignored" | "deleted" | "renamed" | "other";
  title: string;
  release?: string;
  /** The download client's id (a torrent hash, a SABnzbd id): what ties the events together. */
  downloadId?: string;
  client?: string;
  indexer?: string;
  /** Imported: where the download was (as the app sees it). */
  droppedPath?: string;
  /** Imported: where the app put it, renamed (as the app sees it). */
  importedPath?: string;
  /** Failed or ignored: the app's own words. */
  message?: string;
  quality?: string;
  /** Renamed: the file's path before and after (as the app sees it). */
  renamedFrom?: string;
  renamedTo?: string;
}

/**
 * One download's trail in Radarr, Sonarr, Chaptarr, or Lidarr (10-26): grabbed, downloading
 * (in which folder), imported (from the download folder into the library, renamed), renamed later,
 * or failed. Paths are as the app reports them (inside its container: /downloads, /movies).
 */
export interface DownloadTrail {
  key: string;
  title: string;
  release?: string;
  /** Where it got to. */
  status: "grabbed" | "downloading" | "importing" | "stuck" | "imported" | "renamed" | "failed";
  updatedAt?: IsoTime;
  steps: DownloadTrailStep[];
}

export interface DownloadTrailStep {
  kind: "grabbed" | "downloading" | "importing" | "stuck" | "imported" | "renamed" | "failed";
  at?: IsoTime;
  /** Plain words: "Grabbed from Torznab, sent to SABnzbd". */
  text: string;
  /** A file or folder it came from, and where it went. */
  from?: string;
  to?: string;
  progressPct?: number;
}

/** How sharp a movie file is, from its quality's resolution. */
export type MovieTier = "4K" | "1080p" | "720p" | "SD" | "Unknown";

/** One movie in Radarr, compact (library views and Find). */
export interface MovieItem {
  movieId: number;
  title: string;
  year?: number;
  monitored: boolean;
  hasFile: boolean;
  tier?: MovieTier;
  /** Radarr's quality name, e.g. "HDTV-720p". */
  quality?: string;
  sizeBytes?: number;
  codec?: string;
  /** HDR10, DV, ... when the file has it. */
  hdr?: string;
  /** IMDb rating, 0 to 10. */
  rating?: number;
  /** Below the quality its profile asks for (Radarr's cutoff not met). */
  belowCutoff?: boolean;
  /** Where the movie lives, as Radarr sees it (Find only). */
  path?: string;
}

/** Radarr's whole library in a few numbers, plus what is coming, upgradable, and incomplete. */
export interface RadarrLibrary {
  /** When Radarr's library was last read (it is read at most every few minutes). */
  at: IsoTime;
  onDisk: number;
  sizeBytes: number;
  tiers: { tier: MovieTier; count: number; sizeBytes: number }[];
  /** Files with HDR or Dolby Vision. */
  hdr: number;
  codecs: { name: string; count: number }[];
  biggest: MovieItem[];
  folders: { path: string; freeBytes?: number; totalBytes?: number }[];
  /** Monitored movies not on disk yet, by their next release date (digital first). */
  coming: {
    movieId: number;
    title: string;
    year?: number;
    on: IsoTime;
    kind: "digital" | "physical" | "cinema";
  }[];
  upgrades: {
    /** Every movie below its profile's cutoff. */
    total: number;
    byTier: { tier: MovieTier; count: number }[];
    /** The best-rated ones of each tier (a sample, not all of them). */
    items: MovieItem[];
  };
  /** How many collections are partly there (the list holds the closest to complete). */
  collectionsTotal?: number;
  /** Collections you have part of, with the released movies you do not have. */
  collections: {
    id: number;
    title: string;
    have: number;
    total: number;
    missing: { tmdbId: number; title: string; year?: number; released: boolean }[];
  }[];
}

export interface ArrDashboard {
  app: "sonarr" | "radarr";
  version?: string;
  totals: {
    /** Series (Sonarr) or movies (Radarr). */
    titles: number;
    monitored: number;
    /** Wanted and missing (episodes or movies). */
    missing: number;
    queue: number;
    stuckImports: number;
    /** Failed downloads still sitting in the queue. */
    failed?: number;
  };
  queue: ArrQueueItem[];
  missing: ArrMissing[];
  upcoming: ArrUpcoming[];
  recent: { title: string; at?: IsoTime; event: string; quality?: string }[];
  /** The last hundred history events with their paths (file journeys). */
  history?: ArrHistoryEvent[];
  /** Each recent download's trail, newest first. */
  trails?: DownloadTrail[];
  /** The app's own health messages; `source` is its check name (where Hearth links to the fix). */
  health: { level: "warning" | "error"; text: string; source?: string }[];
  /** Radarr only: the whole library at a glance, coming, upgrades, collections. */
  library?: RadarrLibrary;
}

/**
 * Where a requested movie stands, from Seerr's request and Radarr's own state. Each is something
 * Hearth read, never guessed: a request with no Radarr entry says so.
 */
export type RequestStage =
  | "awaiting-approval"
  | "declined"
  | "request-failed"
  | "not-in-radarr"
  | "radarr-unknown"
  | "not-monitored"
  | "waiting-release"
  | "searching"
  | "grabbed"
  | "downloading"
  | "awaiting-import"
  | "download-problem"
  | "imported";

export const REQUEST_STAGE_LABEL: Record<RequestStage, string> = {
  "awaiting-approval": "Waiting for approval",
  declined: "Declined",
  "request-failed": "Request failed",
  "not-in-radarr": "Not in Radarr",
  "radarr-unknown": "Radarr not readable",
  "not-monitored": "In Radarr, not monitored",
  "waiting-release": "Monitored, waiting for release",
  searching: "Monitored, not grabbed",
  grabbed: "Grabbed",
  downloading: "Downloading",
  "awaiting-import": "Downloaded, awaiting import",
  "download-problem": "Download needs attention",
  imported: "In your library",
};

/** One movie request on the Seerr dashboard. */
export interface RequestedMovie {
  requestId: number;
  tmdbId: number;
  title: string;
  year?: number;
  /** TMDB poster path ("/abc.jpg"), loaded through Hearth. */
  poster?: string;
  requestedAt: IsoTime;
  requestedBy: string;
  /** Requested by the Seerr user Hearth's key belongs to (the owner). */
  mine: boolean;
  /** Seerr's approval of the request. */
  approval: "pending" | "approved" | "declined" | "failed" | "completed";
  /** Release dates (YYYY-MM-DD) for Seerr's region; digital is never a theatrical date. */
  digital?: { date: string; source: "tmdb" | "radarr" };
  theatrical?: string;
  /** Days since the digital release date while it is not grabbed (counted from the threshold). */
  overdueDays?: number;
  stage: RequestStage;
  /** What Radarr is doing, in a sentence. */
  doing: string;
  radarr?: {
    serviceId: string;
    /** Radarr's own id for the movie (for a search plan). */
    movieId: number;
    instance: string;
    monitored: boolean;
    rootFolder?: string;
    path?: string;
    quality?: string;
    progressPct?: number;
    problem?: string;
    hasFile?: boolean;
  };
}

/** A show someone requested in Seerr, and whether Sonarr is still looking for it. */
export interface RequestedShow {
  requestId: number;
  tmdbId: number;
  title: string;
  year?: number;
  poster?: string;
  /** A wide picture of the show (TMDB path), for What's Missing. */
  backdrop?: string;
  genres?: string[];
  network?: string;
  /** TMDB's word for where the show is ("Returning Series", "Ended"). */
  showStatus?: string;
  requestedAt: IsoTime;
  requestedBy: string;
  mine: boolean;
  approval: RequestedMovie["approval"];
  /** The seasons asked for; empty when Seerr does not say (all of it). */
  seasons: number[];
  sonarr?: {
    serviceId: string;
    seriesId: number;
    instance: string;
    monitored: boolean;
    /** Episodes on disk, of the episodes Sonarr knows (aired). */
    episodesOnDisk: number;
    episodes: number;
    /** When the next episode airs, when Sonarr knows. */
    nextAiring?: IsoTime;
    /** The show has ended: no more episodes are coming. */
    ended?: boolean;
    /** Its seasons (specials left out), each with episodes on disk of those aired and monitored. */
    seasons?: { number: number; files: number; episodes: number; monitored: boolean }[];
    /** Aired, monitored episodes not on disk yet (specials left out). */
    missing?: number;
  };
}

export interface SeerrDashboard {
  app: "seerr";
  version?: string;
  /** The country whose release dates count. */
  region: string;
  /** The Seerr user Hearth's key belongs to. */
  me?: string;
  /** A request is overdue this many days after its digital date with nothing grabbed (0 = on the day). */
  overdueAfterDays: number;
  totals: { movies: number; mine: number; overdue: number; awaitingApproval: number };
  movies: RequestedMovie[];
  /** Show requests (newest first), with Sonarr's state. */
  shows?: RequestedShow[];
  /** Radarrs that could not be read, and why (their movies say "Radarr not readable"). */
  notes: string[];
  /** Each Radarr's root folders, for changing where a movie goes. */
  radarrs: { serviceId: string; name: string; rootFolders: string[] }[];
}

/** A Wizarr invitation: a link someone uses to get access to a media server. */
export interface WizarrInvite {
  id: number;
  code: string;
  url: string;
  /** pending (can be used), used, or expired. */
  status: string;
  created?: IsoTime;
  expires?: IsoTime;
  usedAt?: IsoTime;
  usedBy?: string;
  /** How long the access it gives lasts: "unlimited" or days. */
  duration: string;
  servers: string[];
  libraries: number[];
}

export interface WizarrUser {
  id: number;
  username: string;
  email?: string;
  server?: string;
  serverType?: string;
  expires?: IsoTime;
  created?: IsoTime;
}

export interface WizarrDashboard {
  app: "wizarr";
  /**
   * Where invitation links come from: Wizarr's own address ("wizarr"), the service's public
   * address in Hearth ("public"), or only its local one ("local": friends outside cannot open them).
   */
  links?: "wizarr" | "public" | "local";
  totals: {
    users: number;
    invites: number;
    pending: number;
    expired: number;
    expiringSoon: number;
  };
  invites: WizarrInvite[];
  users: WizarrUser[];
  servers: {
    id: number;
    name: string;
    type: string;
    verified: boolean;
    /** The address people use to reach it, as set in Wizarr. */
    externalUrl?: string;
    allowDownloads?: boolean;
    allowLiveTv?: boolean;
    allowMobileUploads?: boolean;
  }[];
  /**
   * serverId 0: not linked to a server (left by older Wizarr versions). Wizarr ignores such a
   * library in an invitation's limit, so the panel never offers it.
   */
  libraries: { id: number; name: string; serverId: number; enabled: boolean }[];
}

/** When a Wizarr invite step shows: before the person accepts the invitation, or after. */
export type WizarrStepCategory = "pre_invite" | "post_invite";

/** One page of the guide Wizarr shows people who accept an invitation. */
export interface WizarrStep {
  id: number;
  /** The media server type it is for: plex, jellyfin, emby, audiobookshelf, romm, komga, kavita. */
  server: string;
  category: WizarrStepCategory;
  /** Its place in its list, 0 first. */
  position: number;
  title: string;
  /** The page itself, in Markdown. */
  markdown: string;
  /** The person must click a button or link on it before Next works. */
  requireInteraction: boolean;
}

/** Wizarr's invite steps (Settings, Wizard), read with Wizarr's admin sign-in. */
export interface WizarrWizard {
  /** One entry per media server type Wizarr has, in Wizarr's order. */
  servers: { server: string; steps: WizarrStep[] }[];
}

/** Wizarr's General settings, read with its admin sign-in. */
export interface WizarrSettings {
  displayName: string;
  /** Only people with an invitation can open the guide. */
  protectWizard: boolean;
  /** What happens to someone when their access ends. */
  expiryAction: "delete" | "disable";
  /** Where the join page's posters come from (Wizarr 2026.10 and later; absent before). */
  posters?: { value: string; choices: { value: string; label: string }[] };
}

/**
 * What the Settings tab's General and Wizard sections read: absent "needs" means the read worked. Wizarr keeps these
 * behind its admin sign-in, which its API key cannot open.
 */
export type WizarrAdminRead<T> =
  | { ok: true; data: T; sample?: boolean }
  | {
      ok: false;
      /** login: no admin sign-in in the vault yet; rejected: Wizarr refused it; passkey: the admin
       * signs in with a passkey, which Hearth cannot do; other: Wizarr could not be read. */
      needs: "login" | "rejected" | "passkey" | "other";
      message: string;
    };

/** One stream playing now, as Tautulli reports it. */
export interface TautulliStream {
  sessionId: string;
  user: string;
  /** "Show - Episode" or "Movie". */
  title: string;
  year?: number;
  mediaType: string;
  /** Plex artwork path, loaded through Hearth. */
  thumb?: string;
  progressPct: number;
  /** playing, paused, buffering. */
  state: string;
  player: string;
  /** "1080p", "4k". */
  quality?: string;
  /** "direct play", "copy" (direct stream), or "transcode". */
  decision: string;
  /** Why it is being converted, in plain words, when it is. */
  why?: string;
  bandwidthKbps?: number;
  location: "lan" | "wan";
}

export interface TautulliDashboard {
  app: "tautulli";
  version?: string;
  totals: { streams: number; transcoding: number; bandwidthKbps: number; remoteKbps: number };
  streams: TautulliStream[];
  /** This week. */
  top: {
    users: { name: string; plays: number }[];
    movies: { title: string; plays: number }[];
    shows: { title: string; plays: number }[];
  };
  history: { user: string; title: string; at?: IsoTime; watchedPct?: number; player?: string }[];
}

export interface SabnzbdDashboard {
  app: "sabnzbd";
  version?: string;
  paused: boolean;
  /** Minutes left of a timed pause, when SABnzbd was paused for a while. */
  pausedMinutes?: number;
  /** The speed limit as a share of the line speed set in SABnzbd (100 or absent = none). */
  speedLimitPct?: number;
  /** The same limit in SABnzbd's words ("2.5 M"), when one is set. */
  speedLimit?: string;
  /** SABnzbd's categories (without "*", the default). */
  categories?: string[];
  /** Downloading, Paused, Queued, Idle. */
  status: string;
  speedKbps: number;
  sizeLeft?: string;
  timeLeft?: string;
  diskFreeGb?: number;
  diskTotalGb?: number;
  queue: {
    id: string;
    name: string;
    status: string;
    progressPct: number;
    sizeMb?: number;
    timeLeft?: string;
    category?: string;
    /** Force, High, Normal, Low. */
    priority?: string;
    /** The indexer that grabbed it (from the app that grabbed it). */
    source?: GrabSource;
  }[];
  history: {
    id: string;
    name: string;
    failed: boolean;
    status: string;
    /** Why it failed, in SABnzbd's words. */
    why?: string;
    at?: IsoTime;
    sizeMb?: number;
    category?: string;
    /** The indexer that grabbed it (from the app that grabbed it). */
    source?: GrabSource;
  }[];
  warnings: string[];
}

/**
 * NZBGet's live dashboard, in SABnzbd's shapes (one Overview and Downloads tab serve both). Its
 * speed limit is a rate, not a share of the line speed.
 */
export interface NzbgetDashboard extends Omit<SabnzbdDashboard, "app" | "speedLimitPct"> {
  app: "nzbget";
  /** Its download speed limit in KB/s (absent: no limit). */
  speedLimitKbps?: number;
}

/** One file of a SABnzbd job, as SABnzbd lists it. */
export interface SabJobFile {
  name: string;
  sizeMb?: number;
  leftMb?: number;
  /** finished, active, queued. */
  status?: string;
}

/** A page of SABnzbd's history, searched or filtered. */
export interface SabHistoryPage {
  /** How many match, in all. */
  total: number;
  items: SabnzbdDashboard["history"];
}

export interface ProwlarrDashboard {
  app: "prowlarr";
  version?: string;
  totals: { indexers: number; enabled: number; failing: number; queries: number; grabs: number };
  /** Failing first, switched-off last. Counts are for the last 7 days. */
  indexers: {
    id: number;
    name: string;
    enabled: boolean;
    failing: boolean;
    protocol?: string;
    privacy?: string;
    /** Prowlarr paused it after failures, until this time. */
    pausedUntil?: IsoTime;
    lastFailure?: IsoTime;
    queries: number;
    grabs: number;
    failedQueries: number;
    failedGrabs: number;
    avgMs?: number;
    proxies?: string[];
  }[];
  /** The apps Prowlarr hands its indexers to (Radarr, Sonarr...). */
  apps: { name: string; kind?: string; sync: "full" | "add only" | "off" }[];
  health: { level: "warning" | "error"; text: string }[];
}

export interface BazarrDashboard {
  app: "bazarr";
  version?: string;
  totals: { movies: number; episodes: number; providers: number; throttled: number };
  /** Up to 25 of each, with the languages still missing in plain words. */
  movies: { radarrId: number; title: string; missing: string[] }[];
  episodes: { seriesId: number; episodeId: number; title: string; missing: string[] }[];
  providers: { name: string; ok: boolean; why?: string; retry?: string }[];
  history: { title: string; text: string; at?: IsoTime }[];
}

export interface HomeAssistantDashboard {
  app: "homeassistant";
  version?: string;
  running: boolean;
  totals: {
    entities: number;
    unavailable: number;
    automations: number;
    automationsOn: number;
    /** Missing when the token's user cannot list integrations (not an administrator). */
    integrationsFailing?: number;
  };
  automations: {
    entityId: string;
    name: string;
    on: boolean;
    lastRan?: IsoTime;
    /** Home Assistant cannot use it (a broken or removed automation). */
    unavailable?: boolean;
  }[];
  /** Scripts: in plain words, routines (the ones made in Home Assistant's own app are these). */
  scripts: {
    entityId: string;
    name: string;
    running: boolean;
    lastRan?: IsoTime;
    unavailable?: boolean;
  }[];
  scenes: { entityId: string; name: string; lastRan?: IsoTime; unavailable?: boolean }[];
  /** Lights, switches, fans, and on/off helpers. Locks, alarms, and covers are never listed. */
  switches: { entityId: string; name: string; kind: string; on: boolean }[];
  unavailable: { entityId: string; name: string; since?: IsoTime }[];
  integrations: { entryId: string; name: string; domain: string; problem: string }[];
  note?: string;
}

export interface SyncthingDashboard {
  app: "syncthing";
  version?: string;
  /** Folders with errors first, then the ones still syncing. */
  folders: {
    id: string;
    name: string;
    path?: string;
    /** send and receive, send only, receive only, receive encrypted. */
    kind: string;
    paused: boolean;
    /** idle, scanning, syncing, error, paused... */
    state: string;
    syncedPct: number;
    needFiles: number;
    needMb: number;
    sizeGb: number;
    errors: number;
    failed: { path: string; why: string }[];
    sharedWith: string[];
  }[];
  /** The other machines (this one is left out). */
  devices: {
    id: string;
    name: string;
    paused: boolean;
    connected: boolean;
    address?: string;
    lastSeen?: IsoTime;
  }[];
}

/** Lidarr (artists and albums) and Chaptarr (authors and books), which share one panel. */
export interface LibraryDashboard {
  app: "lidarr" | "chaptarr";
  version?: string;
  /** The app's own words: artist/album or author/book. */
  words: { who: string; what: string; whats: string };
  totals: {
    people: number;
    /** Artists or authors the app watches for new releases. */
    monitored?: number;
    missing: number;
    queue: number;
    stuck: number;
  };
  /** Stuck downloads first. */
  queue: {
    id: number;
    title: string;
    /** The release name as downloaded. */
    release?: string;
    status: string;
    stuck: boolean;
    progressPct?: number;
    sizeBytes?: number;
    timeLeft?: string;
    problem?: string;
    /** The download client. */
    via?: string;
    indexer?: string;
    /** The download client's id for it, and where it put it (as the app sees it). */
    downloadId?: string;
    outputPath?: string;
  }[];
  /** Each recent download's trail, newest first. */
  trails?: DownloadTrail[];
  /** The newest 25 monitored and missing. */
  missing: { id: number; title: string; released?: IsoTime }[];
  upcoming: { id: number; title: string; on?: IsoTime }[];
  /** History, newest first. `text` is the event and release together; the rest split it out. */
  recent: {
    text: string;
    at?: IsoTime;
    failed: boolean;
    /** The event in plain words ("imported", "grabbed", "download failed"). */
    event?: string;
    title?: string;
    quality?: string;
  }[];
  health: { level: "warning" | "error"; text: string }[];
  /**
   * Chaptarr's whole collection (read once a minute: the book list is large). Chaptarr keeps one
   * record per format, so a book wanted as an audiobook and as an ebook counts once in each.
   */
  collection?: {
    /** Every book Chaptarr knows by the authors in it, wanted or not, counted per format. */
    known: number;
    formats: {
      format: BookFormat;
      wanted: number;
      have: number;
      sizeBytes: number;
      /** On disk but not wanted (it will not be upgraded or replaced). */
      unwanted: number;
    }[];
  };
  /** The wanted books, newest first: each format separately. */
  wanted?: BookItem[];
  /** Books by these authors coming out in the next year, soonest first, wanted or not. */
  coming?: BookItem[];
  authors?: {
    id: number;
    name: string;
    monitored: boolean;
    /** Wanted books per format, and how many of them are on disk. */
    wanted: Partial<Record<BookFormat, number>>;
    have: number;
    sizeBytes: number;
    next?: { title: string; on: IsoTime };
  }[];
  /** Where the books go, with the space left there. */
  folders?: { name: string; path: string; freeBytes?: number; totalBytes?: number }[];
}

export type BookFormat = "audiobook" | "ebook";

export interface BookItem {
  /** Chaptarr's id for this format's record (what Want and Search act on). */
  id: number;
  title: string;
  author?: string;
  format: BookFormat;
  wanted: boolean;
  have: boolean;
  released?: IsoTime;
  series?: string;
  sizeBytes?: number;
  narrator?: string;
  minutes?: number;
  pages?: number;
}

export interface JellyfinDashboard {
  app: "jellyfin";
  version?: string;
  server?: string;
  needsRestart: boolean;
  updateAvailable: boolean;
  streams: {
    sessionId: string;
    user: string;
    title: string;
    device: string;
    progressPct: number;
    paused: boolean;
    converting: boolean;
    /** Why it converts, in plain words. */
    why?: string;
    away: boolean;
  }[];
  libraries: {
    id: string;
    name: string;
    kind: string;
    folders: number;
    scanning: boolean;
    /** What is in it, like Plex shows ("812 movies", or "140 shows", "6,123 episodes"). */
    size?: { n: number; label: string }[];
  }[];
  counts: { movies: number; shows: number; episodes: number; albums: number; books: number };
  users: { name: string; admin: boolean; disabled: boolean; lastActive?: IsoTime }[];
  /** Failed first. */
  tasks: {
    id: string;
    name: string;
    running: boolean;
    failed: boolean;
    lastRan?: IsoTime;
    error?: string;
    /** It runs on its own (it has schedule triggers); false once turned off. */
    scheduled?: boolean;
  }[];
  /** Newest first. `poster` is the Jellyfin item whose picture to show (a show's for an episode). */
  recent: { id?: string; title: string; kind: string; at?: IsoTime; poster?: string }[];
}

export interface ImmichDashboard {
  app: "immich";
  version?: string;
  photos: number;
  videos: number;
  usageGb: number;
  disk: { used: string; size: string; free: string; pct: number };
  /** Most space first. */
  people: { name: string; photos: number; videos: number; usageGb: number; quotaGb?: number }[];
  /** Failed first, then busiest. */
  queues: {
    name: string;
    label: string;
    paused: boolean;
    active: number;
    waiting: number;
    failed: number;
    /** Whether "process what is missing" applies to this queue. */
    runnable: boolean;
  }[];
  /**
   * The newest photos on the timeline (newest taken first; archived, hidden and locked ones are
   * left out). Absent when Immich would not say, such as a key without permission to see assets.
   */
  recent?: ImmichPhoto[];
}

/** One photo in Immich, as Hearth's panel shows it. */
export interface ImmichPhoto {
  id: string;
  name: string;
  takenAt?: IsoTime;
  favorite?: boolean;
  /** Changes when the photo is edited in Immich, so its picture is fetched afresh. */
  version?: string;
}

/** A page of the Photos tab: newest taken first; `next` is the page after it, when there is one. */
export interface ImmichPhotoPage {
  items: ImmichPhoto[];
  next?: number;
  sample?: boolean;
}

/**
 * How Hearth shows Immich photos (kept in Hearth; Immich is not changed): the Overview's Recent
 * photos shown, blurred or off, and photos the owner blurred or hid one by one.
 */
export interface ImmichPhotoPrefs {
  recent: "show" | "blur" | "off";
  /** blur: blurred until clicked, everywhere in Hearth; hide: left off the Overview too. */
  photos: Record<string, "blur" | "hide">;
}
export const IMMICH_PHOTO_PREFS_DEFAULT: ImmichPhotoPrefs = { recent: "show", photos: {} };

export interface AudiobookshelfDashboard {
  app: "audiobookshelf";
  version?: string;
  listening: {
    user: string;
    title: string;
    device: string;
    progressPct: number;
    /** The book's library item id, for its cover. */
    itemId?: string;
  }[];
  online: string[];
  libraries: {
    id: string;
    name: string;
    /** books or podcasts */
    kind: string;
    items: number;
    authors: number;
    hours: number;
    sizeGb: number;
    recent: AudiobookshelfBook[];
  }[];
  backups: { count: number; newest?: IsoTime };
  /** Shelves for the account Hearth's key belongs to (absent when Audiobookshelf has none). */
  shelves?: AudiobookshelfShelf[];
  /** The account the shelves are for. */
  shelfUser?: string;
  /** The book that account listened to last (or is listening to now), and exactly where. */
  nowListening?: AudiobookshelfNow;
  /** That account's playlists and the collections, in order: books are added, moved, removed. */
  lists?: AudiobookshelfList[];
}

/** A playlist (the key's account's own) or a collection (shared in its library). */
export interface AudiobookshelfList {
  id: string;
  kind: "playlist" | "collection";
  name: string;
  libraryId: string;
  /** Named like a to-be-read list (TBR, To be read, Want to listen, Up next). */
  tbr: boolean;
  /** In the list's own order. */
  books: AudiobookshelfBook[];
}

export interface AudiobookshelfNow {
  book: AudiobookshelfBook;
  /** Live: a listening session is open right now. Otherwise the last saved position. */
  live: boolean;
  positionSec: number;
  durationSec: number;
  progressPct: number;
  lastListened?: IsoTime;
  chapter?: {
    title: string;
    /** 1-based. */
    number: number;
    count: number;
    startSec: number;
    endSec: number;
    pct: number;
  };
}

export interface AudiobookshelfShelf {
  /** continue: in progress; tbr: your to-be-read collection or playlist; series: next in a
   * series you are listening to; discover: Audiobookshelf's suggestions. */
  kind: "continue" | "tbr" | "series" | "discover";
  label: string;
  /** A to-be-read shelf that is one of your lists: its books can be moved and removed. */
  list?: { id: string; kind: "playlist" | "collection" };
  books: (AudiobookshelfBook & { progressPct?: number; lastListened?: IsoTime })[];
}

/** A book as Audiobookshelf describes it; the cover is fetched through Hearth by its id. */
export interface AudiobookshelfBook {
  /** Kept for older readers: "Title · Author". */
  title: string;
  at?: IsoTime;
  /** Audiobookshelf's library item id (for the cover). */
  id?: string;
  name?: string;
  author?: string;
  narrator?: string;
  series?: string;
  year?: string;
  hours?: number;
  genres?: string[];
  /** The publisher's description, plain text, shortened. */
  description?: string;
  cover?: boolean;
}

/** A domain allowed or blocked by name, or a pattern (regex) that matches many. */
export interface PiholeRule {
  domain: string;
  match: "exact" | "regex";
  comment?: string;
  enabled: boolean;
}

/** One line of Pi-hole's query log, in plain words. */
export interface PiholeQuery {
  id: number;
  at: string;
  domain: string;
  /** A (address), AAAA, HTTPS and so on. */
  type: string;
  client: { ip: string; name?: string };
  verdict: "blocked" | "allowed" | "other";
  /** Why, in plain words: "blocked by a blocklist", "answered from cache". */
  why: string;
  /** How long the answer took, in milliseconds. */
  ms?: number;
}

/** A page of the query log, newest first. */
export interface PiholeQueries {
  queries: PiholeQuery[];
  /** Queries that match the filter, in Pi-hole's memory (about the last day). */
  matching: number;
  /** Devices and domains to filter by. */
  clients: { ip: string; name?: string }[];
}

/** Why Pi-hole blocks or allows one domain. */
export interface PiholeCheck {
  domain: string;
  /** Rules that name or match it (allowed or blocked, exact or pattern). */
  rules: (PiholeRule & { list: "allow" | "deny" })[];
  /** Lists that contain it, masked. */
  lists: { id: number; address: string; type: "block" | "allow"; enabled: boolean }[];
  verdict: string;
}

/** One of Pi-hole's adlists (an address it downloads domains from). */
export interface PiholeList {
  /** Pi-hole's own id, used to name the list in a change (its address can hold a key). */
  id: number;
  /** The address, with any query string or login masked. */
  address: string;
  type: "block" | "allow";
  enabled: boolean;
  comment?: string;
  /** Domains it gave at the last update. */
  domains: number;
  /** How the last update of this list went, in plain words. */
  status:
    | "updated"
    | "unchanged"
    | "unreachable, using the copy it had"
    | "unreachable"
    | "not yet updated";
  updatedAt?: string;
}

/**
 * Pi-hole's live dashboard (v6 API): the last 24 hours of queries and how many were blocked, the
 * most blocked domains and busiest devices, blocking on or paused, the blocklists and when they
 * were last updated, the domains you allowed or blocked yourself, and Pi-hole's own warnings.
 */
export interface PiholeDashboard {
  app: "pihole";
  version?: string;
  /** A newer Pi-hole is out (from Pi-hole's own version check), in plain words. */
  update?: string;
  blocking: "enabled" | "disabled" | "failed" | "unknown";
  /** Paused with a timer: seconds until blocking comes back on. */
  resumesInSec?: number;
  queries: {
    total: number;
    blocked: number;
    percentBlocked: number;
    uniqueDomains: number;
    forwarded: number;
    cached: number;
  };
  clients: { active: number; total: number };
  gravity: { domains: number; updatedAt?: string };
  topBlocked: { domain: string; count: number }[];
  topClients: { name: string; ip: string; count: number }[];
  /** Queries per hour over the last 24 hours, oldest first. */
  history: { at: string; total: number; blocked: number }[];
  lists: PiholeList[];
  /** Domains allowed or blocked by name (exact) or by a pattern (regex), with their comments. */
  allowed: PiholeRule[];
  denied: PiholeRule[];
  /** Local DNS: names Pi-hole answers itself (plex.home is 192.168.1.10), and aliases. */
  localDns: {
    records: { name: string; ip: string }[];
    aliases: { name: string; target: string }[];
  };
  /** Pi-hole's own warnings (its diagnosis page), newest first. */
  messages: { id: number; type: string; text: string; at: string }[];
}

/** One of AdGuard Home's filter lists (a blocklist, or an allowlist). */
export interface AdguardFilter {
  id: number;
  name: string;
  /** The address, with any query string or login masked (it can hold a key). */
  url: string;
  enabled: boolean;
  allowlist: boolean;
  rules: number;
  updatedAt?: string;
}

/** A custom filtering rule, with what it does in plain words when Hearth can tell. */
export interface AdguardRule {
  text: string;
  /** block "||ads.example.com^", allow "@@||ads.example.com^", comment "! note", other rules. */
  kind: "block" | "allow" | "comment" | "other";
  /** The domain a simple block or allow rule names. */
  domain?: string;
}

/**
 * AdGuard Home's live dashboard: the last 24 hours of queries and how many were blocked (by
 * filters, safe browsing, parental control), the most blocked and most asked domains, the busiest
 * devices, protection on or paused, filter lists, custom rules, DNS rewrites, blocked services, and
 * the safe browsing, parental control and safe search switches.
 */
export interface AdguardDashboard {
  app: "adguard";
  version?: string;
  protection: { enabled: boolean; resumesInSec?: number };
  /** Filtering as a whole (filter lists and rules); off, only safe browsing and the like apply. */
  filteringEnabled: boolean;
  queries: {
    total: number;
    blocked: number;
    percentBlocked: number;
    safeBrowsing: number;
    parental: number;
    safeSearch: number;
    /** Average time to answer, in milliseconds. */
    avgMs: number;
  };
  topBlocked: { domain: string; count: number }[];
  topQueried: { domain: string; count: number }[];
  topClients: { client: string; name?: string; count: number }[];
  /** Queries per hour over the last 24 hours, oldest first. */
  history: { at: string; total: number; blocked: number }[];
  filters: AdguardFilter[];
  /** How often the filter lists are downloaded again, in hours (0: never by itself). */
  updateEveryHours: number;
  userRules: AdguardRule[];
  rewrites: { domain: string; answer: string; enabled: boolean }[];
  blockedServices: { ids: string[]; all: { id: string; name: string; group?: string }[] };
  safety: { safeBrowsing: boolean; parental: boolean; safeSearch: boolean };
}

/** One line of AdGuard Home's query log, in plain words. */
export interface AdguardQuery {
  at: string;
  domain: string;
  type: string;
  client: string;
  clientName?: string;
  verdict: "blocked" | "allowed" | "other";
  why: string;
  /** The rule that decided it, and the list it came from (masked), when one did. */
  rule?: string;
  list?: string;
  ms?: number;
}

export interface AdguardQueries {
  queries: AdguardQuery[];
  /** Pass back as `older` for the next 100. */
  older?: string;
}

/** Why AdGuard Home blocks or allows one domain. */
export interface AdguardCheck {
  domain: string;
  verdict: "blocked" | "allowed" | "other";
  why: string;
  rules: { text: string; list: string }[];
  service?: string;
}

/** A virtual machine or container on Proxmox. */
export interface ProxmoxGuest {
  /** "qemu/100" or "lxc/200", Proxmox's own id. */
  id: string;
  kind: "vm" | "container";
  vmid: number;
  name: string;
  node: string;
  status: "running" | "stopped" | "paused" | "unknown";
  /** Share of its CPUs in use, 0 to 100. */
  cpuPct: number;
  cpus: number;
  memUsed: number;
  memTotal: number;
  diskTotal: number;
  uptimeSec: number;
  template: boolean;
  tags: string[];
  /** Its newest backup, from the backup storages Hearth can read. */
  lastBackup?: string;
  /** Locked by a running task (backup, snapshot, migrate). */
  lock?: string;
}

export interface ProxmoxBackupFile {
  /** Proxmox's volume id ("local:backup/vzdump-qemu-100-….vma.zst"). */
  volid: string;
  vmid: number;
  node: string;
  storage: string;
  at: string;
  sizeBytes: number;
  notes?: string;
  protected: boolean;
}

export interface ProxmoxTask {
  upid: string;
  node: string;
  /** What it was, in plain words ("Backup", "Start"), and its guest when it had one. */
  what: string;
  vmid?: number;
  user: string;
  started: string;
  ended?: string;
  /** undefined while running; true when Proxmox says OK. */
  ok?: boolean;
  /** Proxmox's own status text when it did not end OK. */
  error?: string;
}

/**
 * Proxmox VE's live dashboard (its API through an API token): the nodes with CPU, memory and disk,
 * every VM and container with its state and resources, storage use, backup jobs and backup files,
 * and recent tasks with any that failed.
 */
export interface ProxmoxDashboard {
  app: "proxmox";
  version?: string;
  nodes: {
    name: string;
    online: boolean;
    cpuPct: number;
    cpus: number;
    memUsed: number;
    memTotal: number;
    diskUsed: number;
    diskTotal: number;
    uptimeSec: number;
    /** Packages with an update waiting, when the token may read it. */
    updates?: number;
  }[];
  guests: ProxmoxGuest[];
  storage: {
    id: string;
    node: string;
    type: string;
    shared: boolean;
    active: boolean;
    usedBytes: number;
    totalBytes: number;
    content: string[];
  }[];
  backupJobs: {
    id: string;
    schedule: string;
    enabled: boolean;
    storage: string;
    /** "every guest", or the guest ids it backs up. */
    guests: "all" | number[];
    mode: string;
  }[];
  backups: ProxmoxBackupFile[];
  tasks: ProxmoxTask[];
}

/** A site Nginx Proxy Manager serves, and where it sends visitors. */
export interface NpmHost {
  id: number;
  /** The names it answers ("radarr.example.com"); the first is the main one. */
  domains: string[];
  /** Where it forwards: "http://192.168.1.10:7878". */
  forward: string;
  forwardScheme: "http" | "https";
  forwardHost: string;
  forwardPort: number;
  enabled: boolean;
  /** nginx loaded its configuration; false with the error nginx gave when it did not. */
  online: boolean;
  error?: string;
  certificate?: { id: number; name: string; expires?: string };
  sslForced: boolean;
  /** Asks for a password or allows only some addresses (an access list), by its name. */
  accessList?: string;
  websockets: boolean;
  blockExploits: boolean;
}

export interface NpmCertificate {
  id: number;
  name: string;
  domains: string[];
  /** "letsencrypt" (renewable here) or "other" (uploaded). */
  provider: string;
  expires?: string;
  /** Proxy hosts that use it, by their main name. */
  usedBy: string[];
}

/**
 * Nginx Proxy Manager's live dashboard: every proxy host with where it forwards, its certificate
 * and expiry, whether nginx loaded it; certificates; redirections, streams and 404 hosts; and the
 * latest changes from its own audit log.
 */
export interface NpmDashboard {
  app: "npm";
  version?: string;
  hosts: NpmHost[];
  certificates: NpmCertificate[];
  redirections: { id: number; domains: string[]; to: string; enabled: boolean }[];
  streams: { id: number; incomingPort: number; forward: string; enabled: boolean }[];
  deadHosts: { id: number; domains: string[]; enabled: boolean }[];
  accessLists: { id: number; name: string }[];
  /** Recent changes (who did what, to which site), newest first. */
  activity: { at: string; who: string; action: string; what: string }[];
}

/** A Traefik router: which requests it takes, and where it sends them. */
export interface TraefikRouter {
  /** "radarr@docker": its name and the provider that made it. */
  name: string;
  provider: string;
  /** The rule as written ("Host(`radarr.example.com`)"), and the names it answers. */
  rule: string;
  hosts: string[];
  entryPoints: string[];
  tls: boolean;
  /** Middlewares by name only (their settings can hold passwords). */
  middlewares: string[];
  service: string;
  /** enabled, or disabled with Traefik's own errors. */
  status: "enabled" | "disabled" | "warning";
  errors: string[];
  /** The app servers behind it and whether Traefik's health check sees each one up. */
  servers: { url: string; up?: boolean }[];
}

/**
 * Traefik's live dashboard (its own API, read only): every router with the names it answers and
 * where it sends them, routers Traefik refused and why, app servers it sees down, certificates and
 * their expiry. Traefik is set up in its files and container labels, not through its API.
 */
export interface TraefikDashboard {
  app: "traefik";
  version?: string;
  providers: string[];
  entryPoints: { name: string; address: string }[];
  routers: TraefikRouter[];
  certificates: { names: string[]; issuer: string; expires: string; status: string }[];
  counts: { routers: number; errors: number; warnings: number; servicesDown: number };
}

/** A container as Portainer shows it, in one of its environments. */
export interface PortainerContainer {
  /** Docker's id (short). */
  id: string;
  name: string;
  image: string;
  state: "running" | "exited" | "paused" | "restarting" | "created" | "dead" | "unknown";
  /** Docker's own words ("Up 3 days (healthy)"). */
  status: string;
  health?: "healthy" | "unhealthy" | "starting";
  /** The stack (Compose project) it belongs to. */
  stack?: string;
  environmentId: number;
  /** A newer image is waiting, when Portainer can tell (its Business edition). */
  update?: "outdated" | "updated";
}

/** A Compose stack Portainer deployed. */
export interface PortainerStack {
  id: number;
  name: string;
  environmentId: number;
  running: boolean;
  /** Deployed from a Git repository (it updates from there) or from a file in Portainer. */
  fromGit: boolean;
  updatedAt?: string;
  updatedBy?: string;
  containers: number;
  containersRunning: number;
}

/**
 * Portainer's live dashboard: each environment (a Docker host) with its containers running,
 * stopped and unhealthy, the stacks it deployed, and every container with its state and stack.
 * Read live through Portainer's Docker proxy, not its snapshots (those lag by minutes).
 */
export interface PortainerDashboard {
  app: "portainer";
  version?: string;
  environments: {
    id: number;
    name: string;
    kind: "docker" | "agent" | "edge" | "kubernetes" | "other";
    online: boolean;
    running: number;
    stopped: number;
    unhealthy: number;
    stacks: number;
    images?: number;
    cpus?: number;
    memoryBytes?: number;
  }[];
  stacks: PortainerStack[];
  containers: PortainerContainer[];
  /** Whether this Portainer reports image updates (its Business edition does). */
  updatesKnown: boolean;
}

export type KumaStatus = "up" | "down" | "pending" | "maintenance" | "paused";

/** One monitor in Uptime Kuma, as its dashboard shows it. */
export interface KumaMonitor {
  id: number;
  name: string;
  /** Uptime Kuma's monitor type ("http", "keyword", "port", "ping", "docker", "group", "push"...). */
  type: string;
  /** What it checks: an address without passwords or query strings, a host and port, a container. */
  target?: string;
  /** The group it sits in ("Media / Downloads"), when it is in one. */
  group?: string;
  parentId?: number;
  status: KumaStatus;
  /** The latest check's message ("200 - OK", "connect ECONNREFUSED"). */
  message?: string;
  /** When it last changed state (its latest important check). */
  since?: string;
  pingMs?: number;
  /** Average response time over 24 hours. */
  avgPingMs?: number;
  /** Uptime as a fraction (0 to 1) over 24 hours and 30 days. */
  uptime24h?: number;
  uptime30d?: number;
  /** Days its https certificate has left, when it checks one. */
  certDaysLeft?: number;
  certValid?: boolean;
  intervalSeconds: number;
  /** How many notifications it sends alerts to. */
  alerts: number;
  tags: string[];
  /** Its latest checks, oldest first (at most 40). */
  beats: { status: KumaStatus; at: string; pingMs?: number }[];
}

/** A state change Uptime Kuma recorded (an important heartbeat). */
export interface KumaEvent {
  monitorId: number;
  monitor: string;
  status: KumaStatus;
  at: string;
  message?: string;
}

/**
 * Uptime Kuma's live dashboard, read through its socket (it has no REST API): every monitor with
 * its state, response time, uptime and certificate, recent state changes, maintenance windows and
 * status pages. Monitor settings can hold passwords and tokens: Hearth reads only what it shows.
 */
export interface KumaDashboard {
  app: "uptimekuma";
  version?: string;
  /** A newer release, when Uptime Kuma checks for one. */
  latestVersion?: string;
  monitors: KumaMonitor[];
  events: KumaEvent[];
  maintenance: { id: number; title: string; status: string; active: boolean }[];
  statusPages: { slug: string; title: string; published: boolean }[];
  /** The names of its notifications (where alerts go); never their settings. */
  notifications: string[];
}

/**
 * Komga's dashboard: libraries with their series and books, books it could not read, recently added
 * books, who used it lately (and failed sign-ins), and its own history of changes. Never the API key.
 */
/**
 * Gitea's dashboard: repositories and their mirrors, Actions runners and recent workflow runs, people
 * and the version. Never a token, a runner's registration token, a secret or a file.
 */
export interface GiteaDashboard {
  app: "gitea";
  version?: string;
  /** "Gitea" or "Forgejo": Forgejo answers the same API and says so in its version. */
  flavor: "Gitea" | "Forgejo";
  repos: number;
  privateRepos: number;
  archivedRepos: number;
  /** Total size of the listed repositories, in kilobytes as Gitea reports it. */
  sizeKb: number;
  recent: { id: number; fullName: string; private: boolean; mirror: boolean; updated: IsoTime }[];
  mirrors: {
    id: number;
    owner: string;
    name: string;
    fullName: string;
    interval: string;
    lastSync?: IsoTime;
    /** Not synced for more than twice its interval (or a day when the interval is unknown). */
    late: boolean;
  }[];
  /** Undefined when this version has no runner list in its API. */
  runners?: {
    id: number;
    name: string;
    online: boolean;
    busy: boolean;
    disabled: boolean;
    labels: string[];
  }[];
  runs?: {
    id: number;
    owner: string;
    repo: string;
    title: string;
    workflow: string;
    branch: string;
    status: string;
    conclusion?: string;
    attempt: number;
    started?: IsoTime;
  }[];
  /** Gitea can run a run's failed jobs again; Forgejo cannot. */
  canRerun: boolean;
  failedRunsToday: number;
  users: number;
  admins: number;
  orgs: number;
  /** Gitea's scheduled tasks, for "Run now". */
  tasks: { name: string; schedule: string; next?: IsoTime; prev?: IsoTime }[];
}

/**
 * Mealie's dashboard, a light panel: health and version, what it holds, its storage and backups,
 * and whether its first-run administrator account is still there. Never the database address
 * (it can hold a password), a token, or a recipe's contents.
 */
/**
 * Actual Budget's server, a light panel: health, version, memory and uptime, how it signs people in,
 * and which budget files it holds. Never a budget's contents, its encryption key, or the password.
 */
/**
 * Authentik's dashboard: sign-in health (successful and failed sign-ins in the last day, and who
 * failed from where), the applications it protects, its outposts, its background tasks, and
 * certificates near expiry. Never a password, token, key, a provider's secret, an event's context
 * or a task's log.
 */
/**
 * Frigate's dashboard: each camera (frames coming in, detection on or off, connection), the
 * detectors and how fast they are, recent events and today's alerts, and storage. Never a camera's
 * stream address (it usually holds the camera's password), and never an image.
 */
/**
 * Authelia's dashboard, a light read-only panel: whether sign-in is healthy, and from its metrics
 * (when they are on) sign-ins, failed and banned sign-ins since it started, how long a sign-in
 * takes, server errors, uptime and memory. Authelia has no admin API: users and rules live in its
 * files. Never a password, secret or session.
 */
export interface AutheliaDashboard {
  app: "authelia";
  healthy: boolean;
  /** False when Authelia's metrics are off or not reachable on their port. */
  metrics: boolean;
  metricsAddress?: string;
  since?: IsoTime;
  memoryMb?: number;
  signIns?: number;
  failed?: number;
  banned?: number;
  signInMs?: number;
  serverErrors?: number;
}

export interface FrigateDashboard {
  app: "frigate";
  version?: string;
  latest?: string;
  /** Seconds since Frigate started. */
  uptime?: number;
  cameras: {
    name: string;
    fps: number;
    expectedFps?: number;
    detecting: boolean;
    online: boolean;
    connection?: string;
    reconnects: number;
    /** Recordings this camera uses, in megabytes. */
    storageMb?: number;
  }[];
  detectors: { name: string; inferenceMs: number }[];
  events: {
    id: string;
    camera: string;
    label: string;
    at: IsoTime;
    snapshot: boolean;
    kept: boolean;
  }[];
  alertsToday: number;
  detectionsToday: number;
  unreviewed: number;
  storage?: { usedGb: number; totalGb: number; freeGb: number };
}

export interface AuthentikDashboard {
  app: "authentik";
  version?: string;
  latest?: string;
  outdated: boolean;
  signIns: number;
  failedSignIns: { username: string; at: IsoTime; ip?: string }[];
  failedCount: number;
  users: {
    id: number;
    username: string;
    name: string;
    active: boolean;
    admin: boolean;
    lastLogin?: IsoTime;
  }[];
  activeUsers: number;
  applications: { slug: string; name: string; protects?: string; provider?: string }[];
  outposts: {
    id: string;
    name: string;
    type: string;
    healthy: boolean;
    lastSeen?: IsoTime;
    outdated: boolean;
  }[];
  workers: number;
  tasks: { failed: number; warning: number; running: number; queued: number };
  failedTasks: { id: string; name: string; description: string; at: IsoTime }[];
  certificates: { name: string; expires: IsoTime; days: number }[];
}

export interface ActualDashboard {
  app: "actual";
  version?: string;
  healthy: boolean;
  /** Seconds since the server started. */
  uptime?: number;
  memoryMb?: number;
  loginMethods: string[];
  multiuser: boolean;
  budgets: { id: string; name: string; encrypted: boolean; people: number }[];
  /** Budgets moved to the server's trash. */
  deleted: number;
}

export interface MealieDashboard {
  app: "mealie";
  version?: string;
  /** The newest release, when Mealie could find out. */
  latest?: string;
  database: string;
  recipes: number;
  users: number;
  households: number;
  groups: number;
  uncategorized: number;
  untagged: number;
  /** Mealie's own setup checks. */
  checks: { emailReady: boolean; baseUrlSet: boolean; ldap?: boolean; oidc?: boolean };
  storage: {
    data: string;
    temp: string;
    backups: string;
    cleanableImages: number;
    cleanableDirs: number;
  };
  backups: { name: string; at: IsoTime; size: string }[];
  /** The account Mealie makes on first start (changeme@example.com) still exists. */
  defaultAdmin: boolean;
}

export interface KomgaDashboard {
  app: "komga";
  version?: string;
  libraries: {
    id: string;
    name: string;
    root: string;
    series: number;
    books: number;
    /** How often Komga scans it on its own ("every 6 hours", "off"). */
    scanEvery: string;
  }[];
  series: number;
  books: number;
  /** Books Komga could not read, with its reason. */
  unreadable: { id: string; name: string; series: string; why: string }[];
  unreadableCount: number;
  latest: { id: string; name: string; series: string; added: IsoTime }[];
  users: { id: string; email: string; admin: boolean; lastSeen?: IsoTime }[];
  /** Sign-ins that failed recently (wrong password or key). */
  failedSignIns: { email: string; at: IsoTime; ip?: string }[];
  history: { type: string; at: IsoTime; text: string }[];
  readLists: number;
  collections: number;
}

/**
 * Navidrome's dashboard: the library and its last scan, who is listening now, users and their
 * players, and files it can no longer find. Never a password or token.
 */
export interface NavidromeDashboard {
  app: "navidrome";
  version?: string;
  scan: { scanning: boolean; lastScan?: IsoTime; type?: string; files: number; folders: number };
  libraries: {
    id: number;
    name: string;
    path: string;
    songs: number;
    albums: number;
    artists: number;
    missing: number;
    lastScan?: IsoTime;
  }[];
  nowPlaying: {
    user: string;
    title: string;
    artist: string;
    album: string;
    player: string;
    minutesAgo: number;
  }[];
  users: {
    id: string;
    userName: string;
    name: string;
    email?: string;
    admin: boolean;
    lastSeen?: IsoTime;
  }[];
  players: { id: string; name: string; user: string; client: string; lastSeen?: IsoTime }[];
  missing: { id: string; title: string; artist: string; path: string }[];
  missingCount: number;
  playlists: number;
  shares: number;
}

/** A wg-easy client (a WireGuard peer). Never its keys, configuration or one-time link. */
export interface WgPeer {
  id: number;
  name: string;
  enabled: boolean;
  address: string;
  /** Last handshake: a peer is connected when it shook hands in the last 3 minutes. */
  lastHandshake?: IsoTime;
  connected: boolean;
  /** Where it last connected from (its public address and port). */
  from?: string;
  receivedBytes: number;
  sentBytes: number;
  expiresAt?: IsoTime;
  created?: IsoTime;
}

/** wg-easy's WireGuard server: its peers, traffic and handshakes, and how clients reach it. */
export interface WgEasyDashboard {
  app: "wgeasy";
  version?: string;
  latest?: string;
  /** The address and port clients connect to. */
  host?: string;
  port?: number;
  subnet?: string;
  dns: string[];
  /** What clients send through the tunnel by default ("0.0.0.0/0" is everything). */
  allowedIps: string[];
  peers: WgPeer[];
}

/** A device on the tailnet. Never its machine or node keys. */
export interface TailscaleDevice {
  /** Tailscale's node id (the preferred id for changes). */
  id: string;
  /** Its short name ("nas"), and its full MagicDNS name. */
  name: string;
  fqdn: string;
  hostname: string;
  os: string;
  user: string;
  tags: string[];
  /** Tailscale addresses, IPv4 first. */
  addresses: string[];
  online: boolean;
  lastSeen?: IsoTime;
  /** False: waiting for an admin to approve it. */
  authorized: boolean;
  /** When its key expires; left out when expiry is off. */
  keyExpires?: IsoTime;
  keyExpiryDisabled: boolean;
  clientVersion?: string;
  updateAvailable: boolean;
  /** Offers to be an exit node, and whether that is approved. */
  exitNode: { offered: boolean; approved: boolean };
  /** Subnet routes it offers (not the exit node ones), and which are approved. */
  routes: { offered: string[]; approved: string[] };
  /** Shared in from another tailnet. */
  external: boolean;
  ephemeral: boolean;
  ssh: boolean;
}

/**
 * Tailscale's view of the tailnet, from its cloud API: every device online or not, waiting for
 * approval, keys running out, exit nodes and subnet routes, and DNS. Never a key.
 */
export interface TailscaleDashboard {
  app: "tailscale";
  /** The tailnet's MagicDNS domain ("tail1234.ts.net"), when the device names show it. */
  domain?: string;
  devices: TailscaleDevice[];
  dns: { magicDns?: boolean; nameservers: string[] };
}

/** A Vaultwarden account: who, never anything from their vault. */
export interface VaultwardenUser {
  id: string;
  email: string;
  name: string;
  /** "invited": asked to join, no account made yet. */
  status: "active" | "invited" | "disabled";
  twoFactor: boolean;
  lastActive?: IsoTime;
  created?: IsoTime;
  /** The organizations they belong to, by name. */
  orgs: string[];
}

/**
 * Vaultwarden's admin view: version, health, accounts and the settings that matter for who can
 * get in. Never a vault item, a key, the admin token or any setting that holds a secret.
 */
export interface VaultwardenDashboard {
  app: "vaultwarden";
  version?: string;
  webVault?: string;
  /** A newer release, when Vaultwarden could check. */
  latest?: string;
  database?: string;
  /** The address Vaultwarden says it is reached at (its DOMAIN setting). */
  address?: string;
  https: boolean;
  users: VaultwardenUser[];
  orgs: { name: string; members: number }[];
  settings: {
    signupsAllowed: boolean;
    /** Email domains that may sign up (empty: any). */
    signupDomains: string;
    signupsVerify: boolean;
    invitationsAllowed: boolean;
    emergencyAccess: boolean;
    sends: boolean;
    passwordHints: boolean;
    showPasswordHint: boolean;
    emailConfigured: boolean;
    webVault: boolean;
  };
  /** Its own diagnostics that need a look, in plain words. */
  checks: { key: string; text: string }[];
}

/** A Paperless-ngx document as the panel lists it: never its text. */
export interface PaperlessDoc {
  id: number;
  title: string;
  correspondent?: string;
  correspondentId?: number;
  type?: string;
  typeId?: number;
  tags: number[];
  created?: string;
  added?: IsoTime;
  fileName?: string;
  /** When it went to the trash (trash list only). */
  deletedAt?: IsoTime;
}

/** A Paperless-ngx import or maintenance task. */
export interface PaperlessTask {
  id: number;
  name: string;
  /** The file being imported, for an import. */
  file?: string;
  status: "waiting" | "running" | "done" | "failed";
  at?: IsoTime;
  /** Paperless's own words: why it failed, or what it made. */
  result?: string;
  documentId?: number;
}

/** A tag, correspondent or document type. */
export interface PaperlessLabel {
  id: number;
  name: string;
  count: number;
  color?: string;
  inbox?: boolean;
}

/**
 * Paperless-ngx's dashboard: the inbox, imports waiting or failed, its own health (database,
 * Redis, workers, search index, classifier, sanity check), storage and the tags, correspondents
 * and document types. Never a document's text, the token, or the Redis and database addresses.
 */
export interface PaperlessDashboard {
  app: "paperless";
  version?: string;
  updateTo?: string;
  documents: number;
  inboxCount: number;
  inbox: PaperlessDoc[];
  /** Tag ids that mark a document as new. */
  inboxTags: number[];
  waiting: PaperlessTask[];
  failed: PaperlessTask[];
  freeGb?: number;
  totalGb?: number;
  /** Each part of Paperless, "ok", "warning" or "error", with its message when not ok. */
  health: { part: string; status: "ok" | "warning" | "error"; message?: string; at?: IsoTime }[];
  tags: PaperlessLabel[];
  correspondents: PaperlessLabel[];
  types: PaperlessLabel[];
  fileTypes: { type: string; count: number }[];
  trashCount: number;
}

/** A Nextcloud account, as its user list reports it. Never a password or app password. */
export interface NextcloudUser {
  id: string;
  name: string;
  email?: string;
  enabled: boolean;
  admin: boolean;
  groups: string[];
  /** Bytes allowed; left out when the account has no limit. */
  quotaBytes?: number;
  /** The quota as Nextcloud stores it ("5 GB", "none", "default"). */
  quota: string;
  usedBytes: number;
  lastLogin?: IsoTime;
  /** Where the account comes from ("Database", "LDAP"). */
  backend: string;
}

/** One of Nextcloud's own setup checks that is not passing. */
export interface NextcloudCheck {
  id: string;
  name: string;
  level: "info" | "warning" | "error";
  text: string;
  link?: string;
  /** The check judges the request Hearth makes (over plain http), not how people reach it. */
  hearthsOwn?: boolean;
}

/**
 * Nextcloud's dashboard from its serverinfo and user APIs and its own setup checks: storage, users,
 * app updates and background jobs. The account's password never leaves the server.
 */
export interface NextcloudDashboard {
  app: "nextcloud";
  version?: string;
  /** A newer Nextcloud, when it has checked for one. */
  updateTo?: string;
  maintenance: boolean;
  /** The account Hearth signs in as (it is never disabled or taken out of admin). */
  signedInAs: string;
  freeGb?: number;
  files: number;
  /** Accounts, and how many of them are turned off. */
  accounts: number;
  disabledAccounts: number;
  active: {
    last5min: number;
    lastHour: number;
    lastDay: number;
    lastWeek: number;
    lastMonth: number;
  };
  shares: { total: number; links: number; linksNoPassword: number; federated: number };
  system: {
    php?: string;
    database?: string;
    databaseMb?: number;
    webserver?: string;
    memoryGb?: number;
    memoryFreeGb?: number;
    load?: number;
    cpus?: number;
    memcache?: string;
  };
  jobs: {
    mode: "ajax" | "webcron" | "cron";
    lastRun?: IsoTime;
    /** "late": more than an hour since the last run; "never": no run yet. */
    health: "ok" | "late" | "never";
  };
  apps: { installed: number; updates: { id: string; version: string }[] };
  checks: NextcloudCheck[];
  users: NextcloudUser[];
  groups: string[];
  /** Sharing settings Hearth can change: a password on every public link, public links at all. */
  settings: { linksNeedPassword: boolean; linksAllowed: boolean };
}

/** An installed Nextcloud app for the Apps tab. */
export interface NextcloudApp {
  id: string;
  name: string;
  version?: string;
  enabled: boolean;
  /** A newer version Nextcloud's app store offers. */
  update?: string;
  summary?: string;
}

export interface KavitaDashboard {
  app: "kavita";
  version?: string;
  series: number;
  volumes: number;
  chapters: number;
  files: number;
  sizeGb: number;
  readingHours: number;
  libraries: { id: number; name: string; kind: string; folders: number; lastScanned?: IsoTime }[];
  jobs: { name: string; lastRan?: IsoTime }[];
  /** Files Kavita could not read (not dismissed), the first few with Kavita's reason. */
  unreadable: { count: number; files: { file: string; where: string; why: string }[] };
}

/** One game in RomM, as a card shows it. */
export interface RommGame {
  id: number;
  name: string;
  platform: string;
  platformSlug: string;
  year?: number;
  /** Whether RomM has cover art for it (served through Hearth). */
  cover: boolean;
  sizeBytes?: number;
  regions?: string[];
  favorite?: boolean;
  addedAt?: IsoTime;
  /** RomM could not match it to any metadata source. */
  unidentified?: boolean;
}

/** One game's page. */
export interface RommGameDetail extends RommGame {
  summary?: string;
  genres: string[];
  developers: string[];
  publishers: string[];
  franchises: string[];
  languages: string[];
  playerCount?: string;
  rating?: number;
  files: { name: string; sizeBytes: number }[];
  screenshots: number;
  hasManual: boolean;
  /** Its page in RomM, a path on RomM's own address. */
  path: string;
}

export interface RommPlatform {
  id: number;
  name: string;
  slug: string;
  games: number;
  sizeBytes: number;
  /** Missing from the files (RomM keeps it until cleaned up). */
  missing?: boolean;
  unidentified?: boolean;
}

export interface RommDashboard {
  app: "romm";
  version?: string;
  totals: {
    platforms: number;
    games: number;
    saves: number;
    states: number;
    screenshots: number;
    sizeBytes: number;
  };
  platforms: RommPlatform[];
  recent: RommGame[];
  favorites: RommGame[];
  /** Games RomM could not identify (no metadata), from the most recent. */
  unidentified: number;
  /** Whether the login in the vault may run scans (a RomM administrator). */
  canScan: boolean;
}

/** A page of RomM's games, searched or filtered. */
export interface RommGamesPage {
  total: number;
  items: RommGame[];
  /** Genres RomM knows, for the filter. */
  genres: string[];
}

export interface ErsatzDashboard {
  app: "ersatztv";
  version?: string;
  channels: {
    number: string;
    name: string;
    streaming: boolean;
    profile?: string;
    now?: { title: string; until?: IsoTime };
    next?: { title: string; at?: IsoTime };
  }[];
  streams: number;
  /** Whether its guide could be read (now and next come from it). */
  guideRead: boolean;
}

export type AppDashboardData =
  | ErsatzDashboard
  | RommDashboard
  | KavitaDashboard
  | KumaDashboard
  | NextcloudDashboard
  | PaperlessDashboard
  | VaultwardenDashboard
  | TailscaleDashboard
  | WgEasyDashboard
  | NavidromeDashboard
  | KomgaDashboard
  | GiteaDashboard
  | MealieDashboard
  | ActualDashboard
  | AuthentikDashboard
  | FrigateDashboard
  | AutheliaDashboard
  | PortainerDashboard
  | TraefikDashboard
  | NpmDashboard
  | ProxmoxDashboard
  | AdguardDashboard
  | PiholeDashboard
  | AudiobookshelfDashboard
  | ImmichDashboard
  | JellyfinDashboard
  | LibraryDashboard
  | SyncthingDashboard
  | HomeAssistantDashboard
  | BazarrDashboard
  | ProwlarrDashboard
  | SabnzbdDashboard
  | NzbgetDashboard
  | TautulliDashboard
  | QbittorrentDashboard
  | DelugeDashboard
  | TransmissionDashboard
  | PlexDashboard
  | ArrDashboard
  | SeerrDashboard
  | WizarrDashboard;

export interface AppDashboard {
  serviceId: string;
  /** When the app answered. */
  at: IsoTime;
  /** Sample data, not your systems. */
  sample?: boolean;
  /** Present when it could not be read: why, in plain words; data is then absent. */
  error?: {
    kind: "needs-key" | "unreachable" | "rejected" | "blocked" | "unsupported";
    message: string;
  };
  data?: AppDashboardData;
}

/** Apps that have a live dashboard. */
export const DASHBOARD_APPS = [
  "qbittorrent",
  "deluge",
  "transmission",
  "plex",
  "sonarr",
  "radarr",
  "seerr",
  "wizarr",
  "tautulli",
  "sabnzbd",
  "nzbget",
  "prowlarr",
  "bazarr",
  "homeassistant",
  "syncthing",
  "lidarr",
  "chaptarr",
  "jellyfin",
  "emby",
  "immich",
  "audiobookshelf",
  "adguard",
  "kavita",
  "portainer",
  "uptimekuma",
  "nextcloud",
  "paperless",
  "vaultwarden",
  "tailscale",
  "wgeasy",
  "navidrome",
  "komga",
  "gitea",
  "mealie",
  "actual",
  "authentik",
  "frigate",
  "authelia",
  "traefik",
  "npm",
  "proxmox",
  "pihole",
  "romm",
  "ersatztv",
] as const;
export type DashboardApp = (typeof DASHBOARD_APPS)[number];
