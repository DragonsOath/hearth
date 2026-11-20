# Panel roadmap

Which app panels Hearth builds next, in priority order. One panel per pull request; a panel's box
is ticked in the same pull request that ships it. Each panel follows `NATIVE_PANELS_UX.md` and the
rules in `CLAUDE.md`, and starts with what the table below says it should show first.

Already built or in progress: the arr apps, qBittorrent, SABnzbd, Deluge, Plex, Jellyfin,
Tautulli, Seerr, Syncthing, Home Assistant, Immich, Audiobookshelf, Music Assistant (through Home
Assistant) and Wizarr.

## Checklist

### Tier 1

- [x] Pi-hole
- [x] AdGuard Home
- [x] Proxmox (not yet checked against a real Proxmox: it needs a machine of its own)
- [x] Nginx Proxy Manager
- [x] Traefik (read only: its API cannot change routes)
- [x] Portainer
- [x] Uptime Kuma

### Before Tier 2

- [x] Generic panel for any app
- [x] Panel request board (GitHub Discussions, "Panel requests"), with its issue templates

### Tier 2

- [x] Transmission
- [x] NZBGet
- [x] Emby (Jellyfin's panel, every tab, checked on a real Emby)
- [x] Nextcloud
- [x] Paperless-ngx
- [x] Vaultwarden
- [x] Tailscale (built against its official API client; not yet checked on a real tailnet)
- [x] wg-easy (WireGuard)
- [ ] TrueNAS
- [ ] Unraid

### Tier 3

- [x] Frigate
- [x] Navidrome
- [x] Kavita (built before this roadmap: libraries, scans, files it could not read)
- [x] Komga
- [x] Authentik
- [x] Authelia
- [x] Gitea
- [x] Forgejo
- [x] Mealie
- [x] Actual Budget

## What each panel shows first

| Tier | App                      | Show first                                                                                   |
| ---- | ------------------------ | -------------------------------------------------------------------------------------------- |
| 1    | Pi-hole                  | queries and blocked today, top blocked domains, blocklist update, pause blocking             |
| 1    | AdGuard Home             | same as Pi-hole: queries, blocked, filters, pause protection                                 |
| 1    | Proxmox                  | nodes, VMs and containers with state and resources, start and stop, backups, storage         |
| 1    | Nginx Proxy Manager      | proxy hosts, certificates and expiry; also feeds "Open web UI" addresses, as Caddy does      |
| 1    | Traefik                  | routers, services, certificates, errors; also feeds web addresses                            |
| 1    | Portainer                | stacks and containers per environment, updates available                                     |
| 1    | Uptime Kuma              | monitors, up or down, response times, incidents                                              |
| 2    | Transmission             | torrents, speeds, stalled items, ratio limits (same shape as qBittorrent)                    |
| 2    | NZBGet                   | queue, history, failures, speed (same shape as SABnzbd)                                      |
| 2    | Emby                     | libraries, active streams, users, scheduled tasks (same shape as Jellyfin)                   |
| 2    | Nextcloud                | storage, users, app updates, background job health                                           |
| 2    | Paperless-ngx            | inbox, documents waiting, consume folder errors, tags                                        |
| 2    | Vaultwarden              | health, version, users, admin settings; never vault contents                                 |
| 2    | Tailscale                | devices, online state, exit nodes, key expiry                                                |
| 2    | wg-easy                  | peers, last handshake, traffic                                                               |
| 2    | TrueNAS                  | pools, disk health, snapshots, replication, alerts                                           |
| 2    | Unraid                   | array, parity check, disks, Docker and VMs                                                   |
| 3    | Frigate                  | cameras, recent events, detection stats, storage use                                         |
| 3    | Navidrome                | library scan, now playing, users                                                             |
| 3    | Kavita and Komga         | libraries, scans, reading activity                                                           |
| 3    | Authentik or Authelia    | login health, recent failed logins, apps protected                                           |
| 3    | Gitea or Forgejo         | repos, runners, mirrors, version                                                             |
| 3    | Mealie and Actual Budget | health and version; light panels                                                             |

Vaultwarden and the login apps hold secrets. Their panels follow the vault rule in `CLAUDE.md`:
Ember never sees a secret value, and Hearth never shows or reads one.

Networking apps (Pi-hole, AdGuard Home, Nginx Proxy Manager, Traefik, Tailscale, wg-easy) are
protected systems: every change from their panels is a plan marked protected, so approving it asks
The owner to confirm it is them.

## Fewer issues and pull requests

- **A generic panel for any app** without its own: health, version, web address with **Open web
  UI**, container state, restarts and resource use, recent log lines, **Ask Ember** (through
  `app_api` with the app's vault key, under the usual approvals), and **Request a full panel**. An
  app that later gets its own panel replaces the generic one automatically.
- **A panel request board** in GitHub Discussions ("Panel requests", Ideas format, so requests are
  ranked by upvotes), with a Discord ping to the owner for each new request. Before each new tier, check
  the board: the most upvoted requests can move up this checklist, after asking the owner.

## Testing apps the owner does not use

1. A fake server for tests (like `fake-plex.ts` and `fake-pihole.ts`), built from the app's API
   docs. Unit and e2e tests run against it.
2. One real check in a throwaway container: start the official Docker image, connect Hearth,
   confirm every reading and every change reads back, then remove the container. The check lives
   as a gated `*-real.test.ts` next to the code.
3. Mark the status honestly in `packages/core/src/features.ts`: "tested against a real server" only
   after step 2.
4. Ask a user who runs it to try it before release, when one offers through the request board.
