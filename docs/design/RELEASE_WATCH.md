# Release watch: movies you requested, followed until they arrive (issue #11)

Status (2026-10-15): first version built on branch `claude/release-watch`, not merged. Queued
after PR #9 and PR #10 by the owner; built while the owner was away, for review on return.

The owner asked that a movie requested in Seerr be followed on its own: Hearth learns
its digital release date, notices when the date moves, checks Radarr when the day comes, and
says plainly what happened or what is in the way. No reminders to set up.

## What the integrations really provide (checked against their source, 2026-10-15)

| Need | Where it comes from | Checked in |
| --- | --- | --- |
| Movie requests, who and when | Seerr `GET /api/v1/request?mediaType=movie&filter=all&sort=added&take=&skip=` (request status 1 pending, 2 approved, 3 declined, 4 failed, 5 completed; media status 1 unknown to 5 available, 6 blocklisted, 7 deleted) | seerr-team/seerr `server/routes/request.ts`, `server/constants/media.ts` |
| Digital release date | Seerr `GET /api/v1/movie/{tmdbId}`: `releases.results[]` is TMDB's release dates per country; type 4 is Digital, 5 Physical, 3 Theatrical (Seerr's own UI labels them so) | `server/models/Movie.ts`, `src/components/MovieDetails/index.tsx` |
| Which country | Seerr `GET /api/v1/settings/public`: `discoverRegion` (Overseerr: `region`); Seerr's own UI falls back to US | `server/lib/settings/index.ts` |
| Radarr's view | Radarr `GET /api/v3/movie?tmdbId=`: `digitalRelease`, `physicalRelease`, `inCinemas`, `monitored`, `hasFile`, `isAvailable`, `minimumAvailability`, `status` | Radarr `src/Radarr.Api.V3/openapi.json` |
| Download state | Radarr `GET /api/v3/queue?movieIds=` (`trackedDownloadStatus` ok, warning, error; `trackedDownloadState` downloading, importBlocked, importPending, importing, failed...; `errorMessage`, `statusMessages`) | same |
| What happened before | Radarr `GET /api/v3/history/movie?movieId=` (`grabbed`, `downloadFailed`, `downloadFolderImported`...) | same |
| Releases on offer and why each was turned down | Radarr `GET /api/v3/release?movieId=` (already used by Ember's `radarr` tool) | `apps/server/src/apps/media-library.ts` |
| In the library | Radarr `hasFile`; Seerr media status 5 (Seerr syncs it from the media server) | as above |

Hearth already reads Seerr (`readSeerr`) and Radarr (`media-library.ts`, `arr-live.ts`)
through the credential broker with the keys in Secure Vault. Nothing new is needed: no new
credential, no paid service, no change to Seerr or Radarr.

**Not available, so not invented:** no source gives an "estimated" digital date. When TMDB and
Radarr have none, the watch says "Not announced yet" and keeps checking daily, quietly. A
theatrical date is shown for context only and never treated as digital availability.

## How it works

- **A reusable engine** (`apps/server/src/watches/engine.ts`, tables `watches` and
  `watch_events`): each watch has a kind, a stable key (one watch per Seerr request, so no
  duplicates), a state, the facts it last saw, the next check time, snooze and dismissal, and a
  history. A one-minute timer checks only what is due, so the work survives restarts and does not
  repeat. Future kinds (certificates, backup checks, reminders) add a source, not a new engine.
- **The movie source** (`apps/server/src/watches/movie-release.ts`): finds movie requests in every
  watched Seerr (every 30 minutes, all pages, so existing requests are picked up the first time),
  and reads Seerr and Radarr for each due watch. Reads only.
- **The rules** (`packages/core/src/watches.ts`, pure and unit tested): from the facts, the state
  ("Not announced yet", "Coming", "Out today", "Looking for it", "Downloading", "Needs a look",
  "In your library", "Request gone"), what is wrong and whether that is confirmed or only
  suspected, when to check next, and which events are new.
- **Notifications:** a new route, "Movie releases", on the Notifications page (it starts on the
  channels "Needs your attention" already uses, like Long work). Each event is sent once: date
  announced or moved, out today, a problem (once per distinct problem), and arrived. Kinds can be
  switched off on the Releases page, and a snoozed watch sends nothing until the snooze ends.
- **The page** (`/releases`): Upcoming, Needs a look, Arrived, and Dismissed, with request date,
  release date with its source and status, what Radarr is doing, next check, the latest event,
  history, links to the movie in Seerr and Radarr, and "Ask Ember about it". Snooze, dismiss, and
  bring back.
- **Ember** reads the watches (`release_watches`, read only) and investigates with the tools it
  already has (`radarr` with the queue, history, and releases with their rejection reasons).

## Rules for "needs a look"

Checked in this order once the digital (or physical) date has passed:

1. Radarr is not watched by Hearth, or its key is missing: confirmed, says so.
2. The request is still waiting for approval in Seerr: confirmed.
3. The movie is not in Radarr: confirmed.
4. Radarr is not monitoring it: confirmed.
5. Its download is failing or its import is blocked (queue status warning or error): confirmed,
   with Radarr's own message.
6. Its last download failed and nothing is queued: confirmed.
7. Nothing grabbed 48 hours after the date: **suspected**. "Radarr has not found a release it
   accepts yet. Releases may not meet your quality profile, or none are out yet." The release
   list is not read on a timer: it searches every indexer, so it runs only when Ember or the owner
   asks.

## What it never does

Search, grab, download, change a quality profile, monitor or unmonitor, or change Seerr. Those
stay plan steps the owner approves. The AI is not involved in routine checks.

## Decisions for the owner (made provisionally, easy to change)

1. **On by default.** Watching starts as soon as a Seerr with a working key is watched. A switch
   on the Releases page turns it off. Alternative: off until switched on.
2. **Movies only.** TV shows (season and episode air dates) are a different shape; not built.
3. **Home release = digital, or physical when there is no digital date.** Radarr treats either
   as released. Alternative: digital only.
4. **Which country's dates:** Seerr's own region setting, else US, changeable on the page.
5. **Requests already in the library are not watched.** Declined or deleted requests close their
   watch quietly.
6. **"Needs a look" waits 48 hours** after the date before suspecting the quality profile.
7. **No artwork yet.** Posters come from TMDB's image server; showing them means each browser
   loads pictures from image.tmdb.org (or through Seerr's image cache, when the owner turns that
   on in Seerr). Left out until the owner chooses.
8. **The authoritative checklist** (`PROJECT_STATE.md` and the game plan the design docs refer
   to) is not in this repository, so this feature is recorded in issue #11 and here. Suggested
   checklist line: "Release watch (issue #11): built, PR open, waiting for review."
