# Findings: one intelligence layer for the dashboard and Ember

Hearth used to keep what needs attention in several places: incidents from monitoring, problems
apps report about themselves (only errors became incidents; warnings were never shown), the
companion's "what's up" points, and Ember's suggestions. Findings put all of it in one place, so
the dashboard can rank it and Ember can work from the same list.

## What a finding is

A **condition**, not an event: something Hearth (or Ember) saw that is still true. It has:

- **kind**: `problem` (confirmed), `suspected` (likely, not certain: a projection, a first
  sighting), `observation` (worth knowing), `recommendation` (an improvement or a gap).
- **severity**: critical, high, medium, low, info. Priority combines severity and kind; a plan
  waiting for the owner's approval comes first among equals.
- **evidence** (with times), **why it matters**, **next steps**, **affected resources**, and links
  to an incident, a plan, a to-do item, or a conversation.
- **status**: open, acknowledged (seen), investigating (Ember is on it), planned (a plan is
  linked), resolved, dismissed. Every change is a history event; resolved findings are kept.

## Analyzers

Small, read-only, reusable (`apps/server/src/findings/analyzers`). Each reports drafts (what it
sees) and what it was able to look at. The store (`store.ts`) reconciles a run:

- A new key opens a finding (or waits as a hidden candidate until it has been seen
  `confirmAfter` times, for noisy signals like memory or a restarting container).
- A known key is updated in place; a change of severity or a suspected-to-confirmed step is
  recorded in its history, plain re-sightings are not (no repeated alerts).
- A key the analyzer looked at and no longer sees is **resolved by the recheck**. A key it could
  not look at (Docker unreadable, an app without its key) is left exactly as it was: a gap is
  never treated as healthy, and the gap itself shows in "What Hearth can see".
- A condition that comes back within a day reopens the same finding with a count.

| Analyzer | Looks at | Finds |
| --- | --- | --- |
| `monitor.incidents` | open incidents | each one, with a reason; resolves with the incident's resolution |
| `app.health` | the app reads Hearth already makes | every issue an app reports, classified (an error once is suspected, repeated is confirmed); the same report from several apps is one finding; apps Hearth cannot read are one honest "cannot see" finding; version changes go to the activity feed |
| `host.machines` | host readings | sustained memory pressure; restarts go to the feed |
| `docker.containers` | every container (real installs only) | unwatched containers that crashed, restart, or fail health checks; long-stopped leftovers (grouped); out-of-memory kills and Docker's own restarts of watched services; new, removed, and recreated containers go to the feed |
| `storage.volumes` | volumes, plus a daily history it keeps | 80 to 90% full (monitoring takes over at 90%); a fill-up forecast once there are a few days of real history; a known volume no longer mounted |
| `backup.hearth` | Hearth's own backups | failed, stale, off-machine copy not arriving |
| `security.credential-files` | file modes only, never contents | app settings files with API keys (and backup copies) readable by every account |

## Ember

Ember reads the same list (`list_findings`, `get_finding`), records what its investigations
establish (`record_finding`, only from evidence it read), marks progress (`update_finding`), and
links plans (`propose_job findingNumber`). The backend decides who may do what: only the owner
dismisses or snoozes; only a recheck resolves an analyzer's finding; Ember resolves its own only
by saying how it verified, or when a linked plan's checks pass. Plans are offered for problems,
never for observations or recommendations. When a linked plan ends, Hearth records the result in
the finding and rechecks at once.

## The dashboard

`GET /api/findings/briefing` answers: what needs you (and why), what changed since your last
visit, what is worth knowing, what is working (only real evidence: imports, quiet fixes, backups,
healthy services), what Ember is doing, this week's trends, and what Hearth can see. Home shows
incidents live (so a new one appears at once), enriched with the finding's reason.

## Context: certainty, nature, history, and what the owner accepted

So Hearth neither overstates nor repeats itself:

- **Nature**, separate from certainty and severity: failure, degraded, risk (a setting or trend
  that can cause trouble: a configuration risk is not an outage), maintenance, visibility (Hearth
  cannot see it), state (unusual, possibly intentional: a container stopped cleanly, a paused
  queue).
- **Pattern**, from history: new, ongoing, recurring, or returned after a repair. A finding a
  repair resolved (a plan whose checks passed, or Hearth's own fix of an incident) is marked
  repaired; if it comes back within a week, it is "returned after repair", ranks higher, and its
  first next step says to find the cause before repeating the fix. Incidents are keyed by what they
  are about (the service, the volume), so a service that keeps going down is one finding.
- **Specifics**: a finding names what is affected when the source says (the stuck downloads with
  the app's reason for each, the failing indexers, the download client), and only the same
  message from several apps is grouped, keeping every app's evidence.
- **Acceptance**: the owner can accept a condition as it is, with a note. The acceptance is stored
  apart from the finding with the condition's signature (set by its analyzer: which containers are
  stopped, which files are exposed, which band of fullness). It holds while the condition looks
  the same and is no more serious, including after it goes away and comes back. When it changes,
  it is raised again with what changed. Only the owner accepts.
- **Remember**: a finding fixed by a repair and confirmed by a recheck goes into the journal.

## Compose changes and the mount guard

Every Compose edit or restore Hearth plans is read by `docker compose config` (Compose must accept
it), described per service in Compose's own resolved terms, and judged by the mount guard
(`apps/server/src/admin/compose.ts`) on what it newly lets a container reach: secrets and the whole
machine are refused; the Docker socket, privileges, host namespaces, devices, unconfined security
profiles, and folders outside `DC_HOMELAB_ROOTS` make it a protected change. Read-only clock mounts
are fine. Every Compose change is applied by recreating its project, checked, and put back if it
does not come up. Writing Compose files needs a grant on the host (see the access proposal).
