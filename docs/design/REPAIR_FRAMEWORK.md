# From diagnosing to repairing: the controlled repair framework

The owner's direction (2026-10-09): Ember should become an AI systems administrator that
understands the infrastructure, remembers previous repairs, develops safe solutions, and carries
out approved repairs itself, without weakening the security model. This document is the design;
it applies to any Hearth installation, not one server.

## The ladder

| Rung | What Ember can do | Approval | Status |
| ---- | ------------------------- | -------- | ------ |
| 1. Investigate | Read live state, logs, app APIs (health, queues, indexers, proxies), records, approved memory, unreviewed notes (labelled as leads), dependencies | None (read only) | Built |
| 2. Container actions | Restart, start, stop existing containers | Autonomy rules; start/stop always approved, plans only | Built |
| 3. App configuration | Change settings through an app's own API: first Prowlarr indexers (test; on/off) | Exact-plan approval of the before/after values, always (guardrail) | **First capability built** |
| 4. Broader app configuration | Radarr/Sonarr indexers, download clients, quality profiles; Prowlarr proxies and indexer tags and base URLs; qBittorrent/SABnzbd categories and limits | Same as 3 | Next |
| 5. Protected infrastructure | VPN routing (Gluetun), firewall, reverse proxy (Caddy), Docker networking and container settings | Separate, explicit authorization per area, plus exact-plan approval and a pre-change backup | Not built; no operations exist |

Never, at any rung: a shell for the AI, arbitrary Docker or compose changes, reading credentials
out of app config files, or credentials in the AI's context.

## Separation of investigation and change

- Every operation declares `changes`. Investigation operations (`changes: false`) only read or ask
  an app to test something; they never alter settings.
- Configuration operations are guardrail actions: whatever the autonomy level, the AI's plans
  wait for the owner. They run only as plan steps (`APP_ACTIONS`); the runner refuses them as
  direct actions.
- `riskOf(kind)` names the tier (investigation, configuration); infrastructure has no operations.
- Services classified as core networking (`isCoreNetworking`) refuse configuration operations
  ("protected infrastructure; needs a separate, explicit authorization").

## The operation pattern (`apps/server/src/apps/operations.ts`)

1. **Plan.** Resolve parameters (an indexer named "PublicTracker" becomes id 5), read the current value
   from the app, and produce a `StepChange` (summary, settings with before and after). Refuse with
   a reason when it cannot be done (no credential, unsupported app, sample data, nothing to
   change, protected service).
2. **Approve.** The job fingerprint covers every step's kind, service, parameters, and change.
   Editing any of them invalidates the approval. Approval expires and is single use.
3. **Run.** Check the policy again (an approved plan still obeys Monitor or Diagnose). Read the
   app again; if it no longer matches "before", stop without changing anything ("plan it
   again"). Apply through the app's API, sending back the resource it returned (its own fields,
   including its own secrets, untouched and never stored). Read back to verify.
4. **Record.** Audit with setting, before, after, verified. A verified change becomes a journal
   entry (a fact Hearth saw), like a verified repair.
5. **Undo.** If a later step fails, put back the "before" value through the same path, newest
   first.

Adding an operation: a new `ActionKind` in `APP_ACTIONS` (with `describe`, `changes`, guardrail),
verify and rollback text in `jobs/operations.ts`, plan/run/undo branches in `AppOperations`
reading and writing through the app's API, the propose_job schema, and tests with a stateful
stand-in app (plan values, approval binding, drift refusal, verification, rollback, no secrets).

### Reusable for Radarr and Sonarr

They share the *arr API shape with Prowlarr: `GET/PUT /api/v3/{indexer|downloadclient|qualityprofile}/{id}`
with the full resource. The same plan/run/undo applies; the difference is which fields are
exposed as settings (for example `enable`, `priority`, a download client's `enable`). Each new
setting is added deliberately, with its own before/after rendering, never a free-form field edit.

## Memory and context (why the PublicTracker history was missed, and the fix)

Found on the home server (2026-10-09): the earlier PublicTracker incident (Cloudflare 1006 on the VPN exit IP,
fixed on 2026-09-19 by switching the Gluetun server) was documented only in notes that are
still pending in Memory > Review. Ember correctly does not treat unreviewed notes as
memory, so it said it had no record. Its memory search also only covered approved entries, and
the question named "PublicTracker", which is not a service, so Prowlarr's tunnel neighbours were not in
its context.

Changes:

- **Unreviewed notes as labelled leads.** The context pack and the `unreviewed_notes` tool search
  pending drafts and present matches as "UNREVIEWED ... a lead to verify, not a fact" (evidence
  kind `unreviewed`, shown under its own heading). Reading never approves anything.
- **Questions find their apps.** Each app integration declares topics (Prowlarr: indexers,
  trackers, Cloudflare, FlareSolverr...), so "the PublicTracker indexer is down" brings Prowlarr in.
- **Dependencies and neighbours.** For the systems involved, the context says what they depend
  on, what shares it (containers in one VPN tunnel), and what depends on them.
- **App-level relations.** Prowlarr's reader now reports which indexers go through which proxy
  (FlareSolverr, by shared tag) and each indexer's address.

## Durable operational knowledge

`draft_report` (offered by Ember when an investigation or repair concludes) writes a
pending draft in Memory > Review with: problem; root cause marked "verified" or "inference by the
AI"; relevant configuration; **what Hearth recorded (verified)**, written from records
(checks run in the conversation, plan steps with before/after and results, outcomes); outcome;
lessons. It becomes memory only if the owner accepts it. Verified changes are also journaled
automatically, as facts.
