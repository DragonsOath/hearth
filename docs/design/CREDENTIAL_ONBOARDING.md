# Credential onboarding: inventory, security review, and plan (2026-10-09)

The owner's direction: no hours of hunting for keys. Recognize services, reuse what exists, ask only
for what is genuinely needed, never scrape secrets from environment variables, config files, or
databases, and never generate, rotate, import, or enroll a credential without the owner's approval.

## Inventory (the home server, 50 services: 48 watched, 1 paused, 1 retired)

| Group | Services | Credential |
| --- | --- | --- |
| Hearth reads inside, credential stored | Prowlarr, Radarr, Sonarr, SABnzbd (working); qBittorrent (stored; failed only because of the cookie bug fixed 2026-10-09) | Done |
| Reader built 2026-10-09, credential not yet added | Home Assistant (long-lived token the owner creates; see the review below) | Needed for Home Assistant reads |
| Monitored well without credentials (container state, health checks, logs) | The other 43, including FlareSolverr, Recyclarr, Gluetun x2, RustDesk, databases, Opnform, Syncthing, ErsatzTV, Wizarr, Shortlist, Tasterr, Arr Dashboard, ha-ui, Audiobook Organizer, Romarr, Immich ML | Not needed |
| Would gain real diagnostics, but only once Hearth has a reader for them | Lidarr, Chaptarr (same API family as the *arr reader), Bazarr, Seerr/Overseerr, Tautulli, Plex, Jellyfin, Audiobookshelf, Immich, Kavita, RomM, qui | Not useful until the reader exists |
| Never: credentials would give database or network control, not diagnostics | PostgreSQL, Redis, MariaDB, Gluetun (protected) | Do not add |

Home Vault and ai-box are seen over the network only; their services need host agents
(Cave 3), not credentials.

**For today's capabilities one more credential is useful: Home Assistant's token** (its reader was built 2026-10-09). Adding a key for a service
without a reader does nothing. Each new reader should come with its credential step.

## What can be automatic

- Recognizing which services need which credential, linking it, picking it, trying it, and
  reporting its state: already automatic (app catalogue + broker).
- Telling a wrong credential from everything else: automatic since 2026-10-09 (failure kinds).

## Enrollment options per new reader (each needs the owner's approval before it is built)

1. **Link-code sign-in (no password typed):** Plex supports a PIN flow. Hearth shows a
   code, the owner approves it on plex.tv, and Plex issues a token for "Hearth" that the owner can
   revoke there. Safest: no secret is typed anywhere.
2. **Guided copy and paste (no new mechanism):** for apps that show their key in their UI (*arr
   family, Bazarr, Seerr, Tautulli, SABnzbd), one onboarding page lists only the services that
   need one. Each has a direct link to the exact settings page and a paste field that saves and
   tests at once. About 30 seconds per service.
3. **Import from the app's own settings file (exists; kept by the owner's decision 2026-10-09):**
   - Started only by the owner, per service, right after they confirm it is them with a passkey or
     password; an access key or the AI cannot start it.
   - Fixed apps and filenames (Prowlarr, Radarr, Sonarr: `config.xml`; SABnzbd: `sabnzbd.ini`),
     read only from that container's own `/config` folder.
   - Since 2026-10-09 it refuses a file that is a link to somewhere else.
   - The value goes straight into the vault through the broker's store. The response, the
     audit entry, and the AI's `vault_status` carry the entry's name and source only, never the
     value.

## Guided least-privilege onboarding: Jellyfin, Immich, Home Assistant (security review 2026-10-09)

The owner approved this subject to a review of each app's own authentication. The review was done
against the versions running on the home server, using each app's published API description, read without
signing in. The three apps differ, so each gets its own path.

| | Jellyfin 12.2.0 | Immich 3.2.4 | Home Assistant (stable) |
| --- | --- | --- | --- |
| Credential | API key (`/Auth/Keys`; creating one needs an administrator) | API key (`/api-keys`) with **per-key permissions** (168 to choose from) | Long-lived access token, belonging to a user |
| Can it be limited? | **No permission choice on the key**: an API key acts with administrator rights. The only way to limit it is a separate non-administrator user, but the useful reads (logs, scheduled tasks, activity log) are marked "requires elevation", so that user could not see them. | **Yes.** A key can hold only read permissions, for example `server.about`, `server.statistics`, `server.storage`, `job.read`, `library.read` (statistics and jobs also need the key's user to be an administrator). | **No scopes.** A token has its user's full rights. A non-administrator user can still control every device, and cannot see integrations, repairs, or the log. |
| What Hearth would read | Server info, active sessions and transcodes, scheduled tasks and their last result, activity log, server log (redacted) | Server version, storage, statistics, background job queues | (Reader built 2026-10-09) running state, integrations, repairs, entities, automations, devices, error log, logbook |
| Recommended way to get it | the owner creates the key in Jellyfin (Dashboard > API Keys > +, name "Hearth") and pastes it into Secure Vault. Hearth never creates it. | the owner creates the key in Immich (Account Settings > API Keys > New, name "Hearth") **with only the read permissions listed** and pastes it into Secure Vault. Hearth's onboarding page shows that exact list to tick. | the owner creates the token in Home Assistant (profile > Security > Long-lived access tokens, name "Hearth") and pastes it into Secure Vault. Ideally as a dedicated "Hearth" Home Assistant user, so it can be revoked or audited on its own. That user must be an administrator to see integrations, repairs, and the log. |
| What actually limits Hearth | Its reader code: a fixed list of GET requests. The key itself could do anything an administrator can. | The key's own permissions, **plus** the reader code. | Its reader code: a fixed list of GET paths and WebSocket list commands (`apps/homeassistant.ts`). The token itself could control devices. |

**Conclusion: no token-minting mechanism is needed.** For all three apps, the owner creating the
credential in the app's own UI gives the same or less access than Hearth minting it from
an administrator sign-in. It also means the owner's administrator password never passes through
Hearth. So the "one-time admin sign-in" mechanism proposed earlier is withdrawn: nothing to
build, nothing new to approve. What remains is the onboarding page. For each app it shows:

1. what the credential will allow, in plain words, including the honest part: "this key can do
   anything an administrator can; Hearth's code only reads" (Jellyfin, Home Assistant),
   or the exact read-only permissions to tick (Immich);
2. a direct link to the page in that app where the owner creates it;
3. a paste field that stores it through the broker and tests it with one read.

Hearth creates no credential, changes no permission, and stores nothing until the owner pastes
it in.

## Recommended order

The onboarding page (option 2 and the guided least-privilege flow above) ships together with the
next readers: Home Assistant now (reader built), then Jellyfin and Immich, Lidarr and Chaptarr
(same API family as the *arr reader), Bazarr and Seerr, with option 1 for Plex.
