# HEARTH — EMBER COMMAND CENTER
## Complete UI, Workspace, Systems Explorer, and Secure Vault Specification

I am providing **two reference images** illustrating the next major evolution of Ember. Study both carefully. They define the intended visual direction, layout, navigation, and interaction model inside the **existing Hearth application**.

This is **not** a separate application, a static mockup, or a rewrite. Build a polished, interactive command center where I can talk with the primary AI assistant, manage projects, inspect services across my computers, securely manage credentials, and coordinate authorized operations.

Hearth is intended to become a configurable, public project: free for home use, source available. Build generic capabilities; my homelab is a development and testing environment, **not** hardcoded product configuration.

---

## 1. Read the two reference images together

**Image 1 — Systems sidebar, Plex workspace, Ember:** Permanent left navigation; central project dashboard; expanded main conversation; right-side Plex service workspace; expanded Systems list; protected credentials vault. Clicking a service opens its details alongside the ongoing main conversation. This applies to every supported service, not only Plex.

**Image 2 — Project dashboard and split-screen workspace:** Default circular Ember hub surrounded by project cards; clicking the hub's text field expands the conversation over the dashboard; selecting a project opens a split screen with main Ember conversation on the left and project workspace on the right.

The images show **complementary states of one application**, not separate designs. They are visual references, not evidence that depicted data or features already exist.

## 2. Visual direction

- Black and charcoal backgrounds; gold brand and interaction accents; strong dragon identity.
- Subtle ornamental dragon/geometric patterns, tasteful depth and lighting, thin illuminated borders, clean readable type.
- **Do not use a busy fantasy cave background.** Keep content visually dominant.
- Use meaningful status colors: red for errors, green for healthy, amber for warnings and approvals.
- Smooth but restrained transitions; accessible contrast, keyboard navigation, and reduced-motion support.

## 3. Persistent application sidebar

Suggested sections: **Home, Projects, Agents, Systems, Secure Vault, Docker, Backups, Network, Monitoring, Logs, Settings**. Integrate existing pages; do not duplicate functionality. Expandable groups, a collapsible icon rail on desktop, and appropriate mobile drawer/navigation.

**Systems** expands to show actual discovered services with status indicators, search/filter, and a click-to-open right-side workspace. **Secure Vault** has a visibly locked state and an appropriate unlock flow.

## 4. Central circular Ember hub

Default Home displays a **central circle** with dragon emblem, Ember title, brief invitation, **functional text input inside the circle**, send control, and optionally a recent-message preview. Visually connect surrounding project cards to the hub.

Clicking/focusing the circle's input **expands it into a larger rectangular main chat window**, overlaying part of the dashboard. Project cards can remain partially visible behind it. Do not navigate to a completely different page just to chat.

Expanded chat reuses the **real persistent conversation**: user/AI messages, cited evidence, task/job progress, approvals, errors, attachments where supported, and input controls. Minimizing returns to the circle without losing messages, draft, or scroll position where practical. Do not create disconnected histories for collapsed and expanded states.

## 5. Surrounding project cards

Example projects: **Fix Tasterr, Secure Server, Docker Network Maintenance, Improve ErsatzTV, Audit Public Servers, Encrypted Backups**. These are examples, not hardcoded templates.

Each card should show title, short purpose, status, relevant systems/agent, progress where known, icon, open control, and warnings/approvals where applicable. Support states such as Planned, Queued, Investigating, In Progress, Awaiting Approval, Blocked, Completed, Failed, Paused. Use **real persisted data**; keep completed work accessible through history/archive.

## 6. Projects are broader than jobs

Cave 2 already provides ordered jobs with exact-plan approval, progress, verification, and audit history. **Reuse it.** But a long-running project can include multiple jobs, investigations, conversations, documents, findings, logs, approvals, and historical decisions. A project like Improve ErsatzTV may last weeks. Do not model each project as exactly one job. Preserve job identities and audit history; avoid destructive migrations.

## 7. Project split-screen workspace

Clicking a project opens its workspace **on the right** while the **main Ember conversation stays on the left**, as in the lower part of Image 2.

Use meaningful supported tabs such as **Overview, Tasks, Logs, Terminal, Files, Notes, History**. Overview explains purpose, current state, completed/remaining work, blockers, related systems, findings, and next actions. Tasks display real steps/progress; Logs real events; Terminal authorized output only; Files permitted project artifacts; Notes and History persistent context.

Main and project-specific conversations must remain distinct while sharing authorized memory/context. Closing restores dashboard; reopening restores project context.

## 8. Systems explorer

Populate from Hearth discovery records, not a hardcoded list. My services include Plex, Jellyfin, Radarr, Sonarr, Prowlarr, Bazarr, qBittorrent, SABnzbd, ErsatzTV, Tautulli, Kometa, Seerr, Wizarr, Shortlist, Immich, Audiobookshelf, Kavita, RomM, Home Assistant, and others.

Show actual status and distinguish **running, healthy, degraded, intentionally stopped, paused, retired, unavailable, unknown**. Kometa is deliberately paused; retired services must not be shown as unexpected failures. Preserve lifecycle classifications and jurisdiction.

## 9. Service workspace on the right

Clicking a Systems entry slides a reusable service-detail workspace into the right side, keeping Ember accessible on the left. Tabs as supported: **Overview, Health, Logs, Terminal, Files, Settings, Notes, History**.

Display grounded values: name, host, lifecycle, container/process, version if known, uptime, ports, CPU/memory, checks, incidents, dependencies, related jobs. Timestamp observations and clearly distinguish **live** from **recorded**. Integrations can enrich the workspace; unavailable metrics must be labeled unavailable, not fabricated.

Example: select Plex, ask “Check Plex and tell me if anything is wrong,” and view the assistant's findings beside real Plex health/logs.

## 10. Authorized service actions and terminal

Possible controls: health check, open Web UI, read logs, restart, start, stop. **Reuse existing Hearth execution and permission systems**, never a second independent Docker control path.

Preserve jurisdiction, autonomy settings, exact-plan/single-use/expiring approvals, runtime rechecks, audit, verification, and interruption handling. Displaying a button does not authorize execution. Start/stop implementation approval is **not** blanket permission to operate production containers. Do not auto-start Kometa or auto-stop production services.

A Terminal tab must not silently introduce unrestricted shell access. Show captured authorized output if that's all the backend supports; interactive arbitrary commands require separate security review and approval.

## 11. Secure Credentials Vault — more than API keys

This is a **general secure credentials vault**, not merely an API-key list. Store/manage appropriate records for:

- API keys and access tokens
- Proxy and reverse-proxy authentication usernames/passwords
- LAN service logins
- Router administration usernames/passwords
- Local dashboard and service account logins
- Database credentials
- Integration secrets
- SSH identities/keys or secure references
- Recovery credentials where appropriate
- Other homelab connection credentials

First inspect and **reuse Hearth's existing vault, encryption, secret handling, authentication, and authorization**. Do not replace a functioning secure system with a weaker custom store.

Organize configurable entries/categories (Router, Plex, Proxies, Prowlarr, Infrastructure, AI Providers, Databases, etc.). Entry fields may include name, type, associated service/system, username, masked secret, endpoint, notes, tags, updated/verified timestamps.

## 12. PIN/unlock experience and security

Click Secure Vault → locked view → enter PIN **or a stronger existing configured unlock method** → authorized vault interface. A short PIN is **not** sufficient encryption or authentication by itself.

Requirements:

- Server-side authorization, appropriate credential hashing, rate limits, and brute-force protection.
- Strong protection of secrets at rest; reuse existing encryption architecture.
- Auto-lock after appropriate idle/session expiration.
- Secrets masked by default; reveal/copy gated by authorization and fresh authentication when warranted.
- Fetch only requested authorized secret; **never preload all decrypted credentials into the browser**.
- Never leak secrets through URLs, logs, transcripts, analytics, errors, AI prompts, or persistent browser storage.
- Audit access and changes **without recording secret values**.
- Secure recovery/backup with decryption keys separate from backup archives.

If the requested PIN experience conflicts with existing stronger security, preserve the stronger controls and explain the tradeoff.

## 13. AI use of vault-backed integrations

Ember should be able to request **authorized connector operations** that use stored credentials without exposing raw secrets to the language model.

Examples: “Check my router configuration” uses an approved router integration; “Which Prowlarr indexers are failing?” uses the stored Prowlarr API key. The assistant receives permitted results, **not the password or API key**.

Associate credentials with services and narrow operation scopes. **Having a credential does not grant authority to change a system.** Router edits, infrastructure modifications, and sensitive operations still require the existing approvals and jurisdiction checks. Never dump vault contents into model context. Unsupported integrations must be honestly marked unavailable.

## 14. Context-aware Ember

The assistant should know the visibly selected project/service. With Plex open, “Check this service” should mean Plex; switching to Radarr updates the selection. Allow general questions without forcing every message into that selection. Make context explicit to prevent acting on the wrong target.

Reuse persistent conversations, memory, provenance, and AI-provider systems; **do not build a second memory store**. Distinguish live facts, recorded observations, assumptions, and proposed actions.

## 15. Conversation navigation

Provide a secondary conversations panel where useful (as in Image 2) to return to the main conversation, reopen older chats, find project conversations, see active work, and search where supported. Keep it collapsible and mobile-friendly. Histories must remain persistent and correctly scoped.

## 16. Relationship between projects and services

Projects organize **work**; services represent **running or managed applications**. Example: Fix Tasterr Home Feed relates to Tasterr, Caddy, and the home server. Project workspace shows investigation/jobs; service workspace shows current service health. Support cross-links in both directions without duplicating underlying data.

## 17. Required layout states

**A. Dashboard:** sidebar + circular hub + surrounding cards.

**B. Expanded main conversation:** chat overlays part of dashboard; collapse restores circle.

**C. Project split screen:** main chat left, project workspace right; close restores dashboard.

**D. Service split screen:** main chat available, selected service details right; close restores previous view.

**E. Vault:** protected, unlockable credential workspace with masked secrets and scoped actions.

Use smooth transitions and preserve conversation/workspace state. Avoid spawning separate browser windows. Restore reasonable navigation state after refresh.

## 18. Desktop, tablet, mobile, and PWA

Desktop should closely resemble references. Tablet adapts split panels. Mobile uses focused navigation between chat, projects, selected workspace, Systems, service workspace, and Vault; **do not squeeze three desktop columns onto a phone**. Preserve state across views. Support existing installable PWA. **Never cache decrypted credentials offline.**

## 19. Real data only

Reference-image metrics, versions, log lines, statuses, and percentages are illustrative. Do not copy them into production. Show real Hearth/integration data, with timestamps and honest unavailable/stale states. Mock data belongs only in clearly marked isolated previews/tests. Never simulate successful work or repairs.

## 20. Preserve current architecture and production safety

Inspect current repo, PROJECT_STATE, GAME_PLAN, architecture decisions, DRAGONS_CAVE docs, roadmap, and deployed UI before changing anything. Reuse:

- Provenance-backed persistent memory and conversation history
- Service discovery, monitoring, lifecycle, and jurisdiction
- Existing credential vault
- AI adapters and Ember
- Exact-plan approval fingerprints, expiry, single use, runtime checks, audit
- Cave 2 job model
- Read-only Prowlarr integration
- PWA and backups

Do not auto-approve pending memory drafts, change jurisdiction, restart paused services, revive retired services, or modify production Docker infrastructure merely for UI development. No duplicate subsystems.

## 21. Implementation approach

Take ownership of routine engineering and **build incrementally**, rather than stopping after writing a plan.

1. Inspect architecture and explain major fit/conflicts briefly.
2. Implement black/gold shell, sidebar, dashboard, circle-to-chat expansion.
3. Connect real projects/jobs and build project workspaces.
4. Add Systems dropdown and reusable service workspaces.
5. Extend existing secure vault safely with credential organization, unlock, and associations.
6. Connect selected-context behavior and authorized vault-backed integrations where supported.
7. Polish persistence, responsiveness, accessibility, performance, and integration tests.

Adjust ordering for dependencies; deliver functional slices before decorative polish. Avoid unnecessary frameworks. Pause only for consequential security, destructive, production, or architecture decisions. Continue unrelated safe work while awaiting answers.

## 22. Verification checklist

Verify: sidebar/groups; discovered services and lifecycle labels; correct right-side service workspace; real data; circle's functional input; expansion/collapse preserving history; real project cards; project split screen; separation of main/project conversations; job progress and approvals; close/reopen/refresh state; vault server-side authorization, masking, scoped secret access, no leakage; existing permission checks on service actions; no unauthorized Docker changes; desktop/tablet/mobile; existing Windows/Linux tests. Use browser testing and compare visually with **both reference images**.

## 23. Documentation and file organization

Follow **each host/project's own established** installation, backup, directory, and documentation conventions. The home server and Home Vault differ: consult local authoritative docs and ledgers before choosing paths. Update project state, architecture, developer docs, and roadmap. Preserve resumability for future Claude Code/Codex sessions. Do not publish personal domains, IPs, usernames, or secrets in public-release code or examples. **Do not publish externally without explicit approval.**

## 24. Definition of success

I open Hearth and see a polished black-and-gold command center with a sidebar, circular Ember hub, and real surrounding projects. I type into the circle; it expands into my persistent AI conversation. I minimize it and return to the circle. I open **Audit Public Servers** and get a right-side project workspace while talking to Ember on the left. I close it, select **Plex** under Systems, and see live/recorded Plex health and logs beside the assistant's findings. I open **Secure Vault**, unlock appropriately, and see organized protected credentials for router, proxies, services, APIs, and other systems. Hearth can use credentials only through appropriately authorized, scoped integrations—without exposing secrets to the model.

I can move between all these views without losing conversations, histories, or work in progress.

**Treat the two supplied images as the primary visual references and this document as the functional specification.** Briefly identify true architectural/security blockers, then proceed with safe implementation, testing, and deployment according to established project protocols. Do not stall for routine frontend/refactoring approvals.
