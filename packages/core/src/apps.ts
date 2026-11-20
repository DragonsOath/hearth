import type { IsoTime } from "./domain";

/**
 * Application integrations: Hearth understanding an app, not just its
 * container. Read only, always: version, the app's own health messages,
 * download queues, recent activity, and connections (indexers, download
 * clients). Credentials come from the Secure Vault, linked to the service;
 * they are used server side only and never reach the AI or the logs.
 */

export type AppKind =
  | "prowlarr"
  | "radarr"
  | "sonarr"
  | "qbittorrent"
  | "deluge"
  | "transmission"
  | "nzbget"
  | "sabnzbd"
  | "homeassistant"
  | "plex"
  | "lidarr"
  | "chaptarr"
  | "bazarr"
  | "tautulli"
  | "seerr"
  | "syncthing"
  | "wizarr"
  | "jellyfin"
  | "emby"
  | "immich"
  | "audiobookshelf"
  | "kavita"
  | "portainer"
  | "uptimekuma"
  | "nextcloud"
  | "paperless"
  | "vaultwarden"
  | "tailscale"
  | "wgeasy"
  | "navidrome"
  | "komga"
  | "gitea"
  | "mealie"
  | "actual"
  | "authentik"
  | "frigate"
  | "authelia"
  | "traefik"
  | "npm"
  | "proxmox"
  | "adguard"
  | "pihole"
  | "romm"
  | "ersatztv";

export type AppHealthStatus = "ok" | "attention" | "failing" | "unreachable" | "needs-key";

export interface AppIssue {
  level: "warning" | "error";
  /** Stable per issue ("indexer:4"), so the same problem is recognised across checks. */
  key: string;
  text: string;
  since?: IsoTime;
  /** The app's own help page for it, when it gives one. */
  link?: string;
}

/** One item in a download queue, as the app reports it. */
export interface AppQueueItem {
  title: string;
  /** The app's own state in plain words ("Downloading", "Stalled", "Import pending"). */
  status: string;
  progressPct?: number;
  sizeMb?: number;
  /** Time left, as the app estimates it ("00:12:31", "12 min"). */
  timeLeft?: string;
  /** Why it needs attention, when it does. */
  problem?: string;
  /** Which download client or indexer it is with. */
  via?: string;
  /** The app's id for this queue item (what a plan step on it needs). */
  queueId?: number;
  /** The release's own name. */
  release?: string;
  /** Lidarr/Chaptarr: the album or book this download was grabbed for. */
  itemId?: number;
  /** Where the app sees the downloaded file or folder. */
  path?: string;
}

/** Something that happened in the app recently (grabbed, imported, failed). */
export interface AppActivity {
  at?: IsoTime;
  text: string;
  tone?: "good" | "warning" | "error";
}

/** Something the app connects to (an indexer, a download client, the internet). */
export interface AppConnection {
  name: string;
  ok: boolean;
  detail?: string;
}

/** The detail behind a report: shown in the Diagnostics panel. */
export interface AppDetails {
  queue?: AppQueueItem[];
  /** How many items the queue holds in total (the list may be shortened). */
  queueTotal?: number;
  activity?: AppActivity[];
  connections?: AppConnection[];
}

export interface AppReport extends AppDetails {
  serviceId: string;
  app: AppKind;
  version?: string;
  status: AppHealthStatus;
  issues: AppIssue[];
  facts: { label: string; value: string }[];
  checkedAt: IsoTime;
  /** Why it could not be read, for unreachable and needs-key. */
  detail?: string;
}

/** A diagnostics read: live when it was just taken from the app, otherwise the last recorded read. */
export interface AppDiagnostics {
  report?: AppReport;
  live: boolean;
  /** Why a live read was not taken (too soon after the last one, sample data, not an app). */
  note?: string;
}

export interface AppIntegration {
  name: string;
  image: RegExp;
  reads: string;
  /** What to add to the Secure Vault, linked to the service ("none": the app takes no key on your network). */
  credential: "api-key" | "login" | "none";
  /** Where you find it in the app. */
  where: string;
  /**
   * The page inside the app where the key is made or shown, from the app's address
   * ("/settings/general"). Hearth opens it beside the vault form. Left out when the app has no
   * such page (the key lives in a dialog, or elsewhere).
   */
  keyPage?: string;
  /** What the vault calls the key when it is not an API key ("Web UI password"). */
  keyLabel?: string;
  /** A login app that also takes an API token (read only, used when no login is saved). */
  tokenToo?: boolean;
  /** Words in a question that make this app relevant even when it is not named. */
  topics: RegExp;
}

export const APP_INTEGRATIONS: Record<AppKind, AppIntegration> = {
  prowlarr: {
    name: "Prowlarr",
    image: /prowlarr/i,
    reads:
      "version, Prowlarr's own health messages, indexers and which are failing, recent searches and grabs",
    credential: "api-key",
    where: "Prowlarr: Settings > General > Security > API Key",
    keyPage: "/settings/general",
    topics: /\b(indexers?|trackers?|torznab|newznab|cloudflare|flaresolverr|captcha)\b/i,
  },
  radarr: {
    name: "Radarr",
    image: /radarr/i,
    reads:
      "version, Radarr's own health messages, the download queue, recent grabs and imports, download clients",
    credential: "api-key",
    where: "Radarr: Settings > General > Security > API Key",
    keyPage: "/settings/general",
    topics: /\b(movies?|films?)\b/i,
  },
  sonarr: {
    name: "Sonarr",
    image: /sonarr/i,
    reads:
      "version, Sonarr's own health messages, the download queue, recent grabs and imports, download clients",
    credential: "api-key",
    where: "Sonarr: Settings > General > Security > API Key",
    keyPage: "/settings/general",
    topics: /\b(shows?|series|episodes?|seasons?)\b/i,
  },
  qbittorrent: {
    name: "qBittorrent",
    image: /qbittorrent/i,
    reads:
      "version, connection status, transfer speeds, and the torrents that are downloading, stalled, or in error",
    credential: "login",
    where: "qBittorrent: the Web UI username and password (Tools > Options > Web UI)",
    topics: /\b(torrents?|seeding|seeds?|peers?|magnets?)\b/i,
  },
  deluge: {
    name: "Deluge",
    image: /deluge/i,
    reads:
      "version, transfer speeds, free space, and the torrents that are downloading, stalled, or in error",
    // Deluge's Web UI has a password and no username: stored as one secret.
    credential: "api-key",
    keyLabel: "Web UI password",
    where:
      'Deluge: the Web UI password (Preferences > Interface > Password; "deluge" until it is changed)',
    topics: /\b(deluge|torrents?|seeding|seeds?|peers?|magnets?)\b/i,
  },
  transmission: {
    name: "Transmission",
    image: /transmission/i,
    reads:
      "version, transfer speeds, free space, and the torrents that are downloading, stalled, or in error",
    credential: "login",
    where:
      "Transmission: the Web UI username and password (rpc-username and rpc-password in its settings.json, or USER and PASS for the linuxserver image). If it asks for none, save any username and password",
    topics: /\b(transmission|torrents?|seeding|seeds?|peers?|magnets?)\b/i,
  },
  nzbget: {
    name: "NZBGet",
    image: /nzbget/i,
    reads:
      "version, status and speed, the queue, recent history and failures, NZBGet's own health warnings",
    credential: "login",
    where:
      "NZBGet: the control username and password (Settings > Security > ControlUsername and ControlPassword; nzbget and tegbzn6789 until changed)",
    topics: /\b(nzbget|usenet|nzbs?|newsgroups?|downloads?)\b/i,
  },
  sabnzbd: {
    name: "SABnzbd",
    image: /sabnzbd/i,
    reads:
      "version, queue status and speed, the queue, recent history and failures, SABnzbd's own warnings",
    credential: "api-key",
    where: "SABnzbd: Config > General > Security > API Key",
    keyPage: "/config/general/",
    topics: /\b(usenet|nzbs?|newsgroups?)\b/i,
  },
  homeassistant: {
    name: "Home Assistant",
    image: /home[- ]?assistant/i,
    reads:
      "version, whether it is running normally, integrations that failed to set up, repairs it is asking for, entities (and which are unavailable), automations and when they last ran; on request devices, its error log, and an entity's logbook",
    credential: "api-key",
    where:
      "Home Assistant: your profile (bottom left) > Security > Long-lived access tokens > Create token, named Hearth. Integrations, devices, repairs, and the log need an administrator's token.",
    keyPage: "/profile/security",
    topics:
      /\b(home assistant|automations?|entit(y|ies)|zigbee|z-?wave|lights?|switch(es)?|sensors?|thermostat|belle|smart home)\b/i,
  },
  plex: {
    name: "Plex",
    image: /plexinc\/pms|linuxserver\/plex|(^|\/)plex(-media-server)?(:|$)/i,
    reads:
      "version, libraries with movie, show, season, and episode counts, recently added, who is watching what on which device, direct play or transcoding, quality, buffering, and library scans",
    credential: "api-key",
    where:
      "A Plex token: Link Plex in Secure Vault (you approve it on plex.tv), or paste an existing X-Plex-Token. It gives the access of the Plex account that approves it.",
    topics: /\b(plex|watching|streams?|streaming|transcod\w*|buffering|playback)\b/i,
  },
  lidarr: {
    name: "Lidarr",
    image: /lidarr/i,
    reads:
      "version, Lidarr's own health messages, missing albums, the download queue, recent grabs and imports, download clients",
    credential: "api-key",
    where:
      "Lidarr: Settings > General > Security > API Key (Find my keys in Secure Vault imports it)",
    keyPage: "/settings/general",
    topics: /\b(music|albums?|artists?|songs?|tracks?)\b/i,
  },
  chaptarr: {
    name: "Chaptarr",
    image: /chaptarr/i,
    reads:
      "version, Chaptarr's own health messages, missing books, the download queue, recent grabs and imports, download clients",
    credential: "api-key",
    where:
      "Chaptarr: Settings > General > Security > API Key (Find my keys in Secure Vault imports it)",
    keyPage: "/settings/general",
    topics: /\b(books?|ebooks?|authors?|audiobooks?)\b/i,
  },
  bazarr: {
    name: "Bazarr",
    image: /bazarr/i,
    reads:
      "version, its health, episodes and movies missing subtitles, paused subtitle providers, running tasks, recent subtitle downloads",
    credential: "api-key",
    where:
      "Bazarr: Settings > General > Security > API Key (Find my keys in Secure Vault imports it)",
    keyPage: "/settings/general",
    topics: /\b(subtitles?|subs|srt)\b/i,
  },
  tautulli: {
    name: "Tautulli",
    image: /tautulli/i,
    reads:
      "version, who is watching what right now (direct play or transcoding, bandwidth), recent plays, the most watched and most active users this week, and its connection to Plex",
    credential: "api-key",
    where: "Tautulli: Settings > Web Interface > API Key (Find my keys in Secure Vault imports it)",
    keyPage: "/settings",
    topics: /\b(tautulli|watch history|most watched|plays?)\b/i,
  },
  seerr: {
    name: "Seerr",
    image: /overseerr|jellyseerr|(^|[/ ])seerr/i,
    reads:
      "version, requests waiting for approval (title and who asked), being downloaded, available, recent requests, open issues",
    credential: "api-key",
    where:
      "Overseerr, Jellyseerr, or Seerr: Settings > General > API Key (Find my keys in Secure Vault imports it)",
    keyPage: "/settings/main",
    topics: /\b(requests?|requested|overseerr|jellyseerr|seerr)\b/i,
  },
  syncthing: {
    name: "Syncthing",
    image: /syncthing/i,
    reads:
      "version, folders and whether they are in sync or have errors, devices online, what is left to sync, its own errors",
    credential: "api-key",
    where:
      "Syncthing: Actions > Settings > General > API Key (Find my keys in Secure Vault imports it)",
    topics: /\b(syncthing|sync(ing|ed)?)\b/i,
  },
  wizarr: {
    name: "Wizarr",
    image: /wizarr/i,
    reads:
      "users and when their access ends, invitations (waiting, used, expired) with their links, media servers and libraries",
    credential: "api-key",
    where:
      "Wizarr: Settings > API Keys > Create. Wizarr keeps its keys scrambled, so paste the new key once in Hearth's Wizarr panel",
    keyPage: "/settings",
    topics: /\b(wizarr|invites?|invitations?)\b/i,
  },
  jellyfin: {
    name: "Jellyfin",
    image: /jellyfin/i,
    reads:
      "who is watching and whether it plays directly or converts (and why), libraries and counts, users, scheduled tasks that failed, what was just added",
    credential: "api-key",
    where:
      "Jellyfin: Dashboard > API Keys > +. Jellyfin keeps its keys in its database, so paste the new key once in Hearth's Jellyfin panel",
    keyPage: "/web/#/dashboard/keys",
    topics: /\b(jellyfin|transcod\w*|buffer\w*)\b/i,
  },
  emby: {
    name: "Emby",
    // Emby Server; never Jellyfin (which began as Emby's free version and has its own entry).
    image: /\bemby/i,
    reads:
      "who is watching and whether it plays directly or converts (and why), libraries and counts, users, scheduled tasks that failed, what was just added",
    credential: "api-key",
    where:
      "Emby: Settings (the gear) > Advanced > API Keys > New API Key. Emby keeps its keys in its database, so paste the new key once in Hearth's Emby panel",
    keyPage: "/web/index.html#!/apikeys",
    topics: /\b(emby|transcod\w*|buffer\w*)\b/i,
  },
  immich: {
    name: "Immich",
    image: /immich-server|immich_server|^immich(?![\s_-]*(machine|ml|postgres|redis|db|database))/i,
    reads:
      "photos and videos, storage, how much each person uses and their quota, job queues (thumbnails, faces, smart search...) with failures",
    credential: "api-key",
    where:
      "Immich, signed in as an administrator: Account Settings > API Keys > New API Key (all permissions). Immich keeps its keys in its database, so paste the new key once in Hearth's Immich panel",
    keyPage: "/user-settings?isOpen=api-keys",
    topics: /\b(immich|photos?|faces?|thumbnails?)\b/i,
  },
  audiobookshelf: {
    name: "Audiobookshelf",
    image: /audiobookshelf/i,
    reads:
      "who is listening and how far along, libraries (books or podcasts, how many, hours, space, just added), backups",
    credential: "api-key",
    where:
      "Audiobookshelf, as an administrator: Settings > API Keys > Add API Key. It keeps its keys in its database, so paste the new key once in Hearth's Audiobookshelf panel",
    keyPage: "/audiobookshelf/config/api-keys",
    topics: /\b(audiobookshelf|audiobooks?|podcasts?)\b/i,
  },
  pihole: {
    name: "Pi-hole",
    // Its image, or a service named Pi-hole.
    image: /pi-?hole/i,
    reads:
      "queries and how many were blocked in the last 24 hours, the most blocked domains and busiest devices, whether blocking is on or paused, the blocklists and when they were last updated, and Pi-hole's own warnings",
    // Pi-hole 6 signs in with a password and no username: its app password, stored as one secret.
    credential: "api-key",
    keyLabel: "App password",
    where:
      "Pi-hole 6, as its administrator: Settings > Web interface / API (switch on Expert), Configure app password. It is shown once. The web interface password also works when two-factor sign-in is off",
    keyPage: "/admin/settings/api",
    topics: /\b(pi-?hole|ad ?block(ing|er)?|ads?|blocklists?|gravity|dns queries)\b/i,
  },
  adguard: {
    name: "AdGuard Home",
    // Its image, or a service named AdGuard Home; never AdGuard VPN or other AdGuard products.
    image: /adguardhome|adguard[ -_]?home/i,
    reads:
      "queries and how many were blocked in the last 24 hours, the most blocked domains and busiest devices, whether protection is on or paused, filter lists and when they were updated, custom rules, DNS rewrites and blocked services",
    credential: "login",
    where:
      "AdGuard Home: the username and password you sign in to its web interface with (set when it was installed)",
    topics:
      /\b(adguard|ad ?block(ing|er)?|ads?|filter lists?|blocklists?|dns rewrites?|blocked services|safe ?search|parental control)\b/i,
  },
  proxmox: {
    name: "Proxmox VE",
    // A service named Proxmox (it is a host system, rarely a container image); never Proxmox Backup
    // Server, Mail Gateway, or a metrics exporter.
    image: /proxmox(?!.*(backup|mail|exporter))/i,
    reads:
      "the nodes with CPU, memory and disk, every VM and container with its state and resources, storage use, backup jobs, backups and recent tasks (with any that failed)",
    // Proxmox's API token is one string: user@realm!tokenid=secret.
    credential: "api-key",
    keyLabel: "API token",
    where:
      "Proxmox VE: Datacenter > Permissions > API Tokens > Add. Copy it as user@realm!tokenid=secret (for example root@pam!hearth=xxxxxxxx-…). With Privilege Separation on, give the token PVEAuditor on / to read; to start, stop, back up and take snapshots also PVEVMAdmin on /vms and PVEDatastoreUser on the backup storage. Showing waiting updates needs Sys.Modify on the node (optional)",
    topics: /\b(proxmox|pve|vms?|virtual machines?|lxc|hypervisor|snapshots?)\b/i,
  },
  npm: {
    name: "Nginx Proxy Manager",
    image: /nginx[- _]?proxy[- _]?manager|jc21\/nginx|^npm$/i,
    reads:
      "every proxy host with where it sends visitors, its certificate and when that expires, hosts nginx could not load, redirections, streams and 404 hosts, and recent changes",
    credential: "login",
    where:
      "Nginx Proxy Manager: the email and password you sign in to its admin page with (port 81). A user of its own, with only Proxy Hosts and Certificates allowed, works too",
    topics:
      /\b(nginx proxy manager|npm|proxy hosts?|reverse proxy|certificates?|ssl|let'?s encrypt|https)\b/i,
  },
  traefik: {
    name: "Traefik",
    image: /traefik(?!.*(forward-?auth|certs?-dumper))/i,
    reads:
      "every router with the names it answers and where it sends them, routers Traefik refused and why, app servers it sees down, and certificates with their expiry",
    // Its API (api.insecure, port 8080 on your network) takes no key.
    credential: "none",
    where:
      "Nothing to add when Traefik's API is on (api.insecure=true, port 8080 on your network); give Hearth that address",
    topics: /\b(traefik|reverse proxy|routers?|certificates?|ssl|https|let'?s encrypt)\b/i,
  },
  portainer: {
    name: "Portainer",
    image: /portainer\/portainer|^portainer\b(?!.*agent)/i,
    reads:
      "each environment's containers running, stopped and unhealthy, the stacks it deployed, and every container with its state",
    credential: "api-key",
    keyLabel: "Access token",
    where:
      "Portainer: your user menu (top right) > My account > Access tokens > Add access token (an administrator's, to manage every environment). Portainer shows it once",
    keyPage: "/#!/account",
    topics: /\b(portainer|stacks?|containers?|docker|compose)\b/i,
  },
  uptimekuma: {
    name: "Uptime Kuma",
    image: /uptime[- _]?kuma/i,
    reads:
      "every monitor up, down, paused or in maintenance, response times, uptime over 24 hours and 30 days, certificates running out, recent state changes, maintenance windows and status pages",
    credential: "login",
    where:
      "Uptime Kuma: the username and password you sign in to it with (Hearth cannot sign in while two-factor sign-in is on for that user)",
    topics:
      /\b(uptime kuma|kuma|monitors?|uptime|downtime|status pages?|outages?|response times?)\b/i,
  },
  nextcloud: {
    name: "Nextcloud",
    // Nextcloud itself (its image, linuxserver's, AIO's, or a service named for it), never its
    // database, cron, Redis or AIO's other containers.
    image:
      /^(?!.*(all-in-one|aio-(?!nextcloud)[a-z]))(?!.*nextcloud[-_ .]?(db|database|redis|cron|mariadb|postgres|mysql|notify|push|imaginary|talk|whiteboard|clamav|onlyoffice|collabora|office|backup|elastic|fulltext|exporter)).*nextcloud/i,
    reads:
      "free space, files and accounts, who used it lately, every account with its quota and groups, app updates, background jobs and when they last ran, public links without a password, and Nextcloud's own setup warnings",
    credential: "login",
    where:
      "Nextcloud: an administrator's username and the password you sign in with (Nextcloud asks for the account's own password before any change, so an app password can only read). A separate administrator account for Hearth, without two-factor sign-in, is best",
    topics:
      /\b(nextcloud|cloud storage|file sync|quotas?|shares?|public links?|cron|background jobs?)\b/i,
  },
  paperless: {
    name: "Paperless-ngx",
    // Paperless-ngx itself, never its Redis, database, Tika or Gotenberg.
    image:
      /^(?!.*(redis|broker|postgres|mariadb|db\b|tika|gotenberg|ai\b|gpt))(?=.*paperless).*paperless(?!-?(ai|gpt))/i,
    reads:
      "the inbox (new documents still to sort), imports waiting and failed with Paperless's reason, its own health (database, Redis, workers, search index, classifier, sanity check), free space, and tags, correspondents and document types",
    credential: "api-key",
    keyLabel: "API token",
    where:
      "Paperless-ngx: your name (top right) > My Profile > API Auth Token (an administrator's, to see every document)",
    keyPage: "/profile",
    topics:
      /\b(paperless|documents?|scans?|scanned|ocr|inbox|consume|correspondents?|receipts?|invoices?|bills?)\b/i,
  },
  vaultwarden: {
    name: "Vaultwarden",
    // Vaultwarden itself (or an old bitwardenrs image), never a backup or other helper container.
    image: /^(?!.*(backup|sync|ldap|exporter))(?=.*(vaultwarden|bitwardenrs|bitwarden_rs))/i,
    reads:
      "its version, accounts (active, invited, turned off, two-step sign-in on or off, last active), organizations, who may sign up, whether email is set up, and its own diagnostics; never anything stored in a vault",
    credential: "api-key",
    keyLabel: "Admin token",
    where:
      "Vaultwarden: the admin token you sign in to its admin page (/admin) with, the plain one, not its Argon2 hash (ADMIN_TOKEN in its settings; without one its admin page is off)",
    keyPage: "/admin",
    topics:
      /\b(vaultwarden|bitwarden|password manager|passwords?|vault|two-?factor|2fa|sign-?ups?)\b/i,
  },
  tailscale: {
    name: "Tailscale",
    // Tailscale itself (its image or a service named for it); never Headscale or a UI for it.
    image: /^(?!.*(headscale|headplane|tsdproxy|tailscale-?ui|derper|exporter))(?=.*tailscale)/i,
    reads:
      "every device on your tailnet online or not and when it was last seen, devices waiting for approval, keys running out, exit nodes and subnet routes waiting for approval, client updates, and DNS; read from Tailscale's own API, never a key",
    credential: "api-key",
    keyLabel: "API access token",
    where:
      "Tailscale's admin console: Settings > Keys > Generate access token (tskey-api-...; it lasts up to 90 days). In Hearth's vault, give it the address https://api.tailscale.com: Tailscale keeps your devices in its own service, so that is where Hearth sends it",
    topics:
      /\b(tailscale|tailnet|exit nodes?|subnet routes?|magicdns|vpn|devices? (offline|online))\b/i,
  },
  wgeasy: {
    name: "wg-easy",
    image: /wg-?easy/i,
    reads:
      "every WireGuard client, on or off, whether it is connected now, its last handshake, where it connects from, data sent and received, when it expires, and the address clients connect to; never a client's keys or configuration",
    credential: "login",
    where:
      "wg-easy: the username and password you sign in to its web page with (version 15 or later; Hearth cannot sign in while two-factor sign-in is on for that account)",
    topics: /\b(wg-?easy|wireguard|vpn|peers?|handshakes?|tunnel)\b/i,
  },
  navidrome: {
    name: "Navidrome",
    image: /navidrome/i,
    reads:
      "the music library (songs, albums, artists) and its last scan, who is listening now and to what, users and when each was last on, their players and apps, and files it can no longer find",
    credential: "login",
    where:
      "Navidrome: an administrator's username and password (the ones you sign in to its web page with)",
    topics: /\b(navidrome|music|songs?|albums?|artists?|subsonic|listening|playlists?)\b/i,
  },
  komga: {
    name: "Komga",
    image: /komga/i,
    reads:
      "libraries with their series and books, books it could not read and why, recently added books, who used it lately and failed sign-ins, and its own history of changes",
    credential: "api-key",
    where:
      "Komga, as an administrator: your account (top right) > API Keys > Generate API key (Komga 1.13 or later). It shows the key once",
    keyPage: "/account/api-keys",
    topics: /\b(komga|comics?|manga|graphic novels?|cbz|cbr)\b/i,
  },
  gitea: {
    name: "Gitea or Forgejo",
    // Gitea and Forgejo (one API), by image or name; not their runners (gitea/act_runner,
    // forgejo/runner), which only connect to them.
    image: /(?:^|[/\s])(gitea|forgejo)(?:[:@\s]|$)/i,
    reads:
      "repositories and their mirrors, Actions runners and recent workflow runs, how many people and organizations, its scheduled tasks and the version",
    credential: "api-key",
    where:
      "Gitea or Forgejo, as an administrator: your avatar (top right) > Settings > Applications > Generate new token, with read and write access to admin and repository. It shows the token once",
    keyPage: "/user/settings/applications",
    topics:
      /\b(gitea|forgejo|git server|repos?|repositor(y|ies)|mirrors?|runners?|workflows?|actions)\b/i,
  },
  mealie: {
    name: "Mealie",
    image: /mealie/i,
    reads:
      "its version and setup checks, how many recipes, people and households, its storage and backups, and whether its first-run administrator account is still there",
    credential: "api-key",
    where:
      "Mealie, as an administrator: your profile (top left) > API Tokens > Generate. It shows the token once",
    keyPage: "/user/profile/api-tokens",
    topics: /\b(mealie|recipes?|meal plans?|shopping lists?|cookbooks?)\b/i,
  },
  actual: {
    name: "Actual Budget",
    image: /actual[-_ ]?(server|budget)|actualbudget/i,
    reads:
      "whether its server is healthy, its version, memory and uptime, how people sign in, and the names of the budget files it holds (never what is in them)",
    credential: "api-key",
    where:
      "Actual Budget: the server password you set when you first opened it (Settings > Server > Change password changes it). Save it as the key",
    keyPage: "/",
    topics: /\b(actual( budget)?|budgets?|budgeting|sync server)\b/i,
  },
  authentik: {
    name: "Authentik",
    // The server image, not its outposts (goauthentik/proxy, /ldap, /radius, /rac).
    image: /goauthentik\/server|(?:^|[/\s])authentik(?:[:@\s]|$)/i,
    reads:
      "sign-ins and failed sign-ins in the last day, the applications it protects, its outposts and background tasks, certificates near expiry and its version (never a password, token or secret)",
    credential: "api-key",
    where:
      "Authentik, as an administrator: Admin interface > Directory > Tokens and App passwords > Create, intent API. Copy its key once",
    keyPage: "/if/admin/#/core/tokens",
    topics: /\b(authentik|sso|single sign-on|sign-?ins?|log-?ins?|identity|outposts?)\b/i,
  },
  frigate: {
    name: "Frigate",
    image: /frigate/i,
    reads:
      "each camera's frames and whether it detects, the detectors' speed, recent events and today's alerts, and how full its storage is (never a camera's stream address or an image)",
    credential: "login",
    where:
      "Frigate: a username and password you sign in to its web page with (port 8971); an administrator, to change cameras. Frigate prints the first admin password in its log on first start",
    keyPage: "/settings?page=users",
    topics: /\b(frigate|cameras?|cctv|nvr|motion|detections?|events?|recordings?|doorbell)\b/i,
  },
  authelia: {
    name: "Authelia",
    image: /authelia/i,
    reads:
      "whether sign-in is healthy, and from its metrics: sign-ins, failed and banned sign-ins since it started, how long a sign-in takes, server errors, uptime and memory",
    // Its health check and metrics (port 9959 on your network) take no key.
    credential: "none",
    where:
      "Nothing to add. For sign-in counts, turn on Authelia's metrics in its configuration (telemetry: metrics: enabled: true, port 9959) and let Hearth reach that port",
    topics: /\b(authelia|sso|single sign-on|sign-?ins?|log-?ins?|2fa|two-factor)\b/i,
  },
  kavita: {
    name: "Kavita",
    image: /kavita/i,
    reads:
      "series, volumes, files and size, hours read, libraries and when each was last scanned, scheduled jobs, files it could not read and why",
    credential: "api-key",
    where:
      "Kavita, as an administrator: your user settings, API Key (or Auth Keys). Kavita keeps its keys in its database, so paste the key once in Hearth's Kavita panel",
    keyPage: "/preferences",
    topics: /\b(kavita|manga|comics?|e-?books?)\b/i,
  },
  romm: {
    name: "RomM",
    // Its image, or a service named RomM; never its database ("romm-db").
    image: /rommapp\/romm|^romm\b(?!-)/i,
    reads:
      "your game library: platforms and how many games each, recently added, favourites, each game's details and cover, and whether a scan is running",
    credential: "login",
    tokenToo: true,
    where:
      "RomM: a user's username and password (an administrator's, to run scans from Hearth; any user's to browse). A RomM API token (Profile > API tokens) also works, read only",
    topics: /\b(romm|roms?|retro ?games?|emulat\w*|game library|video games?)\b/i,
  },
  ersatztv: {
    name: "ErsatzTV",
    image: /ersatztv/i,
    reads: "channels with what is on now and next (from its own guide), and who is streaming",
    credential: "none",
    where: "Nothing to add: ErsatzTV's API takes no key on your network",
    topics: /\b(ersatz\w*|channels?|live tv|iptv)\b/i,
  },
};

/** Which app a service is, from its image or name (shared by the server and the interface). */
/**
 * Emby speaks Jellyfin's API (Jellyfin began as Emby's free version): Hearth reads and changes
 * both with the same code, and the panel says which one it is.
 */
export const jellyfinLike = (app?: AppKind | null): app is "jellyfin" | "emby" =>
  app === "jellyfin" || app === "emby";

export function appKindOf(service: { image?: string | null; name: string }): AppKind | undefined {
  // A name you gave it, with a note in brackets ("Plex (test)", "Radarr (4K)"), is the app named.
  const bare = service.name.replace(/\s*\([^)]*\)\s*$/, "").trim();
  for (const [kind, def] of Object.entries(APP_INTEGRATIONS) as [AppKind, AppIntegration][]) {
    if (def.image.test(service.image ?? "") || def.image.test(service.name)) return kind;
    if (bare && (def.image.test(bare) || bare.toLowerCase() === def.name.toLowerCase()))
      return kind;
  }
  return undefined;
}
