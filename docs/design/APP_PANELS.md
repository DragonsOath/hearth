# Application-aware panels: audit, standard, and roadmap

The owner's brief (2026-10-12, `dragon_control_application_aware_panels.md`): every managed service should show what the application is doing, not only that its container runs. This file is the read-only audit, the reusable standard, the coverage of all 50 services, and the batches.

Audit date: 2026-10-12, from Hearth's live inventory on the home server (50 services) and the Caddy routes on Home Vault (read only, no change).

## The reusable standard

The data contract already existed: every app reader returns one `AppReport` (packages/core/src/apps.ts). The standard below maps the brief's seven parts onto it.

| Brief | In the report | Shown in |
| --- | --- | --- |
| At a glance (3 to 6 facts) | `facts` | Overview, first thing (AppGlance), or the app's own dashboard |
| Activity | `queue` (current work, with progress) and `activity` (recent results) | Overview "Working on" and "Lately" |
| Health | `issues` (the app's own warnings), `status` | Overview "Needs attention"; separate from the container's health |
| History and trends | `activity`; per-app dashboards (Plex, qBittorrent, Sonarr, Radarr) | Overview; Health tab for container trends |
| Actions | plan operations (approve first) | Dashboards and Warden; a panel never grants permission |
| Diagnostics | container, logs, resources | Diagnostics, Health, Logs tabs (unchanged) |
| Original UI | `publicUrl` (reverse proxy), else `localUrl` | "Open web UI" on Overview, "Open" in lists |

States are always told apart: loading, needs its key (with Find my keys or where to find it), cannot be reached (the reason and when it was last tried), no activity ("Nothing right now"), and the report's age ("Live" or "Recorded, read N minutes ago"). The server limits how often an app is read; the panel refreshes every 20 seconds while open, and qBittorrent's live view every 2 seconds with only changes fetched.

A service with no reader shows an honest note instead (IntegrationGap, `apps/web/src/lib/coverage.ts`): what it is, and why its panel is the container view for now. Nothing is invented.

## Coverage of all 50 services

Panel: **Dashboard** = its own live dashboard; **Glance** = the standard panel from its reader; **Container** = health, logs, resources, with the note shown.

| Service | Kind | Panel | Reads (key) | Next step or blocker |
| --- | --- | --- | --- | --- |
| qBittorrent | Downloads | Dashboard + settings card | Web UI login (in vault) | Done; full control by plan (10-12) |
| SABnzbd | Downloads | Glance | API key (in vault) | A dedicated dashboard later |
| qui | Downloads | Container | none | Another front end on qBittorrent: nothing more to read |
| Sonarr | Automation | Dashboard | API key (in vault) | Done |
| Radarr | Automation | Dashboard | API key (in vault) | Done |
| Prowlarr | Automation | Glance | API key (in vault) | Indexer detail view (checklist 8.3, 8.4) |
| Lidarr | Automation | Glance (new) | API key: Find my keys | Import the key |
| Bazarr | Automation | Glance (new) | API key: Find my keys | Import the key |
| FlareSolverr | Automation | Container | none needed | No status beyond up; Prowlarr shows its effect |
| Recyclarr | Automation | Container | none | Scheduled, no live status; plans run it |
| Kometa | Automation | Container | none | Paused by you |
| Chaptarr | System | Glance (new) | API key: Find my keys | Import the key |
| Plex (plex) | Media | Dashboard | Plex token (in vault) | Done |
| Plex (plex-test) | Media | Dashboard | needs a token | Link Plex for it, or retire it |
| Tautulli | Media | Glance (new) | API key: Find my keys | Import the key; a richer stats view later |
| Overseerr | Media | Dashboard (requests) | API key: Find my keys, or Ember's credential-import plan | Done 10-19: every movie request with poster, digital date, approval, Radarr instance, root folder, quality profile, download, overdue marks; Approve/Decline actions next |
| Seerr | System | Dashboard (requests) | API key: Find my keys | Same dashboard as Overseerr |
| Jellyseerr | Media | Dashboard (requests) | API key: Find my keys | Retired; reads nothing while retired |
| Jellyfin | Media | Container + note | needs an API key you create | Reader planned (batch 2) |
| Kavita | Media | Dashboard (series, libraries, unreadable files, jobs; scan, back up) | API key pasted once in its panel | Built 10-20 |
| Audiobookshelf | Media | Dashboard (listening, libraries, backups; scan, back up) | API key pasted once in its panel | Built 10-20 |
| ErsatzTV | Media | Container + note | API being checked | Batch 3 |
| RomM | Media | Container + note | needs a login | Batch 3 |
| Wizarr | Media | Dashboard (invitations) | API key pasted once in its panel | Built 10-20: invitations with links, create, delete; people and when access ends |
| Immich | Files & Photos | Container + note | needs an API key you create (stored scrambled, cannot be imported) | Reader planned (batch 2) |
| Immich machine learning | Files & Photos | Container | infrastructure | Immich shows its jobs |
| Syncthing | Files & Photos | Glance (new) | API key: Find my keys | Import the key |
| Home Assistant | Home | Glance | needs a long-lived token you create | Reader exists; add the token |
| Ha Ui | System | Container | infrastructure | Home Assistant's panel shows the home |
| Gluetun VPN (gluetun) | Network | Container | protected | Watched, never changed |
| Gluetun VPN (gluetun-qbit) | Network | Container | protected | Watched, never changed |
| RustDesk relay (hbbr) | Network | Container | infrastructure | Up and reachable is what matters |
| RustDesk relay (hbbs) | Network | Container | infrastructure | Same |
| PostgreSQL (immich_postgres) | System | Container | infrastructure | Database: health, memory, logs |
| PostgreSQL (opnform-db) | System | Container | infrastructure | Same |
| Redis (immich_redis) | System | Container | infrastructure | Cache |
| Redis (opnform-redis) | System | Container | infrastructure | Cache |
| MariaDB (romm-db) | System | Container | infrastructure | Database |
| Opnform Api, Api Scheduler, Api Worker, Client, Ingress | System | Container | infrastructure | Parts of the forms app |
| Collection Pdf Server | System | Container | infrastructure | Serves files |
| Nanohive Abs Theme | System | Container | no API | Audiobookshelf's themed front end |
| Arr Dashboard | System | Container | no API | Its own page from the same apps |
| Audiobook Organizer | System | Container | your own tool | Tell Warden what it should show |
| Romarr, Shortlist, Tasterr | System | Container | unknown API | Checked in batch 3 |

Not managed as services today: Caddy (on Home Vault, Windows) and Traefik. A read of Caddy's routes and certificate state is planned; Caddy is never changed without separate approval.

## Open original UI: why it opened IP:port

Hearth never recorded the reverse-proxy addresses (`publicUrl` was empty for every service), so "Open" fell back to the local IP and port, a different origin from the one the owner signs in on, hence repeated logins. The Caddy routes on Home Vault were read (site name and upstream only; no other line printed) and each https address was checked to answer (all did: 200, or a login page or redirect). Those verified addresses are now recorded per service by matching each route's upstream to the service's local address, through Hearth's own record only. A new route, `PUT /api/services/:id/web-address`, sets or clears one (audited). Different origins still have separate sign-ins; Hearth does not promise shared logins.

## The bar since 10-19

The owner (10-19): every service gets a dashboard built for that app, with what someone opens the app to see,
and its everyday tasks (Wizarr invites, Overseerr approvals) through approved plans. A Glance card or a
"documented blocker" no longer counts as done. Tracked in the private checklist, sections 33 and 34.

## Panel plan, service by service (10-20)

The owner (10-20): "go over each container, think about what information and activities or tasks someone
would do from that panel and make sure they can do it." Every row: what someone opens it to see,
what they open it to do (changes are plans they confirm in the panel, as Wizarr's invitations), what
Hearth needs, and the order. Status: **Done** (built and verified on the home server), **Built** (not yet on
The home server), **Next**, or **Later**. Container health, logs, and restart stay in the admin sections of
every panel; this is about the app itself.

| Service | See | Do | Needs | Status |
| --- | --- | --- | --- | --- |
| Overseerr, Seerr | Every movie request: poster, digital date, approval, Radarr folder, quality, download, overdue | Ask why, search; approve or decline a request; requests for shows | key (imported) | Done (see/ask/search). Approve/decline and TV: Next |
| Wizarr | People with access and when it ends; invitations with links and status | Create an invitation and copy or share its link; delete an unused one; extend, disable, or enable someone | API key pasted once (Wizarr stores keys scrambled) | Built 10-20 (invitations). Extend/disable: Next |
| Radarr, Sonarr | Queue with progress, stuck imports, missing, next 7 days, recent | Import a stuck download, search, monitor, upgrades, naming, cutoff | key (imported) | Done |
| qBittorrent | Torrents, speeds, ratios, VPN, settings | Pause, resume, recheck, remove, limits, categories, add | login (in vault) | Done |
| Plex | Who is watching, libraries, recently added, scans | Scan a library, delete duplicates, (later) manage shares | token (linked) | Done; shares Later |
| Tautulli | Now playing with progress and quality, top users and titles this week, history | Ask why something converts (transcode reasons in plain words), stop a stream with a message | key (imported) | Built 10-20 |
| Prowlarr | Each indexer: working or failing, why, grabs and queries, last test | Test one or all (with Prowlarr's reason), turn on or off, send indexers to the apps, ask why one fails | key (imported) | Built 10-20 |
| SABnzbd | Queue with speed and time left, history with failures and why, disk space | Pause or resume all or one job, retry a failed job, remove one (files kept unless ticked), ask why it failed | key (imported) | Built 10-20 |
| Bazarr | Movies and episodes missing subtitles, recent downloads, providers working | Search one movie or episode, search everything missing, reset throttled providers | key (imported) | Built 10-20 |
| Lidarr, Chaptarr | Artists or books, missing, queue (stuck first, with the reason), coming out, recent, health | Search one or all missing, replace a stuck download | key (imported) | Built 10-20 |
| Jellyfin | Who is watching, libraries, recently added, users | Scan a library or all; stop a stream with a message; run a scheduled task; ask why it converts | API key the owner creates in Jellyfin, pasted once in the panel | Built 10-20 (users: Next) |
| Immich | Photos and videos count, storage, upload activity, jobs (thumbnails, faces) and failures, users | Pause or resume a queue, process what is missing, clear failed jobs, back up the database | API key an administrator creates in Immich, pasted once in the panel | Built 10-20 |
| Audiobookshelf, Nanohive theme | Listening now, libraries (items, hours, space), just added, backups | Scan a library, make a backup | API key pasted once in the panel | Built 10-20 (theme shown inside it) |
| Kavita | Series, files, libraries and last scans, unreadable files, jobs | Scan one or all, back up the database | API key pasted once in the panel | Built 10-20 |
| Home Assistant, Ha Ui | Rooms and devices, what is unavailable, automations that failed, battery levels | Turn a device on or off, run a scene or automation (plans for anything risky) | long-lived token (in vault) | Built 10-20: automations on, off, run; scripts and scenes; lights, switches, fans, helpers; reload a failing integration. Locks, alarms, covers never offered. Batteries and rooms: Next |
| Syncthing | Folders in sync or not, failed files and why, machines online and last seen | Rescan a folder, pause or resume a folder or machine | key (in vault) | Built 10-20 |
| Gluetun (both) | VPN up, server and place, the address the internet sees, what routes through it | Switch server (protected plan, confirm it is you) | host administration | Built 10-20 (forwarded port: Next) |
| Caddy | Every reverse proxy and the local address and service behind it; live checks (app answers, works through Caddy); sign-in; certificate expiry; errors | Add a site, change where it goes, turn the shared sign-in on or off, or remove it, from a form in the panel: exact Caddyfile edits as a protected plan (Caddy validates, you confirm it is you, backed up, put back on failure). Passwords through Ember | host administration | Built 10-20 |
| Tinyauth | From its own log over the last day: visitors let in, sent to sign in, or refused; sign-ins that worked or failed; who asked most; asks per hour and unusually busy hours; its own errors | Ask Ember about it; change users through Ember (config, hashed) | none (container log) | Built 10-20 |
| Recyclarr | Last sync: what it changed in Radarr and Sonarr, errors; preview of the next sync | Run a sync (plan) | host administration | Built 10-20 |
| ErsatzTV | Channels with now and next (its own guide), who is streaming | Rebuild a channel's schedule, stop a channel's stream | none (its API takes no key) | Built 10-20 |
| RomM, Romarr | Platforms and game counts, recent additions, scans | Scan a platform | RomM login | Later |
| Immich ML, PostgreSQL (2), MariaDB, Redis (2) | Grouped under their app: database size, connections, memory, slowest queries or hit rate | Nothing beyond restart (data is the app's) | database credentials from the app's own config (permission needed) | Later |
| Opnform (5 parts) | One panel for the app: forms, submissions this week, the parts' health together | Read only | Opnform API token | Later |
| FlareSolverr | Requests solved, failures and why, per site, from its own log (no statistics API) | Nothing beyond restart | none (container log) | Built 10-20 |
| qui | Its qBittorrent instances (shown in qBittorrent's panel) | Nothing extra | none | Later |
| Arr Dashboard, Abb Proxy, Collection Pdf Server | What it serves and whether its address answers | Open it | none | Later |
| Audiobook Organizer, Tasterr | Your own tools: Ember reads what they expose and proposes a panel | As found | unknown | Later |
| FlareSolverr, RustDesk relays (2) | Up and reachable; RustDesk: relayed sessions if its logs show them | Nothing beyond restart | none | Later |

**Order:** Wizarr (done), Overseerr approve/decline (done), Tautulli (done), SABnzbd (done), Prowlarr detail (done), Bazarr (done),
Home Assistant (done), Gluetun (done), Syncthing (done), Recyclarr (done), Lidarr/Chaptarr (done), then the key-you-create apps
(Jellyfin, Immich, Audiobookshelf, Kavita) with one shared "paste the key here" step, then the rest.

## Batches

1. **Done 10-12.** The panel standard (AppGlance, IntegrationGap), readers for Lidarr, Chaptarr, Bazarr, Tautulli, Seerr (Overseerr, Jellyseerr), Syncthing; Find my keys; verified web addresses; qBittorrent settings view and full control by plan.
2. **Next.** Jellyfin, Immich, Kavita, Audiobookshelf readers (each needs a key the owner creates in the app; none can be imported). Prowlarr indexer detail. A richer Tautulli statistics view.
3. **Then.** ErsatzTV, RomM, Wizarr, Romarr, Shortlist, Tasterr: confirm each API, then readers or a documented "no API". Caddy route and certificate read (read only).

Not complete until every service above has a useful panel or a documented blocker. As of 10-12: every service has one or the other; batch 2 and 3 readers remain.

## Verification

- Unit tests: each new reader against a stand-in app (apps/server/src/apps/more-apps.test.ts), including that Tautulli's key never appears in an error.
- The key parsers were checked against the real settings files on the home server, printing only whether a key was found and its length.
- Request load: one read per app per check interval on the server; panels reuse it (no per-viewer polling of the apps).
- Owner verification: AWAITING THE OWNER (open several panels on the real install, compare with each app's own UI).
