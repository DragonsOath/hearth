# Development

## Layout

| Path | What it is |
|---|---|
| `apps/server` | Fastify API. Will own the scheduler, monitors, policy engine, and MCP server. Serves the built UI in production. |
| `apps/web` | React + Vite SPA (Tailwind v4, TanStack Query). |
| `packages/core` | Shared domain types and logic, imported as TypeScript source by both apps. |
| `integrations/` | One package per integration (from M3). |
| `sandbox/` | Disposable containers for failure and repair testing (from M4/M5). |
| `tests/e2e` | Playwright tests against the production build. |

## Commands

| Command | Does |
|---|---|
| `pnpm dev` | API (tsx watch, :7400) + Vite (:7401, proxies `/api`) |
| `pnpm build` | Bundles the server (tsup) and the UI (Vite) |
| `pnpm start` | Runs the built server, which also serves the UI |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | Static checks and Vitest unit/integration tests |
| `pnpm test:e2e` | Playwright on desktop (1440px) and mobile (Pixel 7) against the built app, on port 7410 with a throwaway data dir. Runs serially: tests share one database and reset the demo scenario first |
| `pnpm verify` | All of the above in order; run before calling a milestone done |
| `pnpm verify:clean` | Clones the committed HEAD into a temp folder and installs, typechecks, tests, and builds it. Catches files missing from git. Run after committing a milestone |
| `pnpm --filter @dragon-control/server db:generate` | Generate a Drizzle migration after editing `apps/server/src/db/schema.ts` |

First-time E2E setup: `pnpm exec playwright install chromium`.

## Database

SQLite through Node's built-in `node:sqlite`, wired into Drizzle's `sqlite-proxy` driver (no native modules). Migrations live in `apps/server/drizzle/` and run automatically at startup.

### Migrations, backups, and rolling back

Migrations only go forward. On start, the server applies each migration newer than the newest
one recorded in the database (`__drizzle_migrations`), never earlier ones and never twice. Two
things follow:

- **An older version on a newer database** starts normally: it knows fewer migrations, finds
  nothing to apply, and simply never reads what the newer ones added. Whether that is safe
  depends on the migration, so each one that changes data or structure says so here.
- **A newer version on an older database** (for example after restoring a backup) applies the
  missing migrations on its next start.

Every deploy takes a database backup first and keeps the previous build, so rolling back means
putting the previous build back; restoring the database too is only needed when a migration
says so.

| Migration | What it does | Roll back the app alone? |
| --- | --- | --- |
| `0048_classic_looks_existing_installs` | Adds one setting, `ai_look_style = "classic"`, to installations already claimed when it runs (`INSERT OR IGNORE`: safe to run twice). Nothing else in any table changes: names, pictures, voices, conversations, memory, permissions, and preferences are untouched. Verified on a copy of a real installation's database (every other table identical). | **Yes.** Older versions never read the setting. Restoring the database backup is not needed; if one taken before it is restored, the migration runs again on the next start with the same result. |

## API

All JSON. Writes return 204, or 4xx with `{ error, message }` where `message` is meant for people.

| Route | Does |
|---|---|
| `GET /api/health` | Control plane status |
| `GET /api/workspace` | Everything the UI renders, in one read |
| `PATCH /api/settings` | `{ instanceName?, quietHours?, monitorIntervalSec? (15-3600), failureThreshold? (1-10), liveRepairs? }` |
| `PUT /api/autonomy` | `{ default, rules: [{ id, level }] }` |
| `PUT /api/notifications/routes/:id` | `{ channels: string[] }`, configured channels only |
| `GET /api/jobs`, `GET /api/jobs/:id` | Jobs, newest first, with steps, progress, and (while waiting) `approval { fingerprint, expiresAt }`. Keys: read. |
| `POST /api/services/:id/app/check` | Reads inside the app now (read only); returns its `AppReport`. Session only. |
| `POST /api/jobs` | `{ title, reason?, incidentId?, steps: [{ kind, serviceId }] }` (1 to 12 steps). Session only; always waits for your review. |
| `POST /api/jobs/:id/decision` | `{ decision, fingerprint }`, same rules as incident decisions. Keys: approve. |
| `POST /api/jobs/:id/stop` | Stops after the current step (or declines one still waiting). Session only. |
| `POST /api/incidents/:id/decision` | `{ decision: "approve" | "decline", fingerprint }` for incidents awaiting approval. Approving needs the `approval.fingerprint` from the workspace incident (400 without it, 409 if the proposal changed, expired, or was already decided); it runs only the action that fingerprint covers, once. Proposals lapse after `APPROVAL_WINDOW_HOURS` (24; `actions/approval.ts`, swept each monitoring pass). |
| `GET /api/audit?limit=` | Recent changes, newest first |
| `POST /api/demo/scenario` | `{ scenario, replaceYourSystems? }`; demo mode only; 409 over a real environment unless `replaceYourSystems` |
| `POST /api/discovery/scan` | Read-only scan of this machine; returns a `DiscoveryReport` (kept in memory, never saved) |
| `GET /api/discovery/latest` | `{ report }`, the current unadopted scan or `null` |
| `POST /api/discovery/adopt` | `{ reportId, selections: [{ key, name }] }` from the current scan only; first adoption replaces sample data, later ones merge |
| `GET /api/storage/:id/browse?path=` | Read-only listing of a watched folder (sizes, dates) |
| `GET /api/storage/:id/properties?path=` | Properties for one file or folder |
| `POST /api/storage/locations` / `DELETE /api/storage/locations/:id` | Watch / stop watching a folder (real environment, must sit on a discovered volume) |
| `POST /api/storage/disks/refresh` | Re-read drive health |
| `POST /api/monitor/run` | `{ serviceId? }`; run checks now (one service or all) |
| `POST /api/demo/simulate` | `{ serviceId, condition: "down" \| "stuck" \| "slow" \| "normal" }`; 409 unless showing sample data ("stuck": a restart will not fix it) |
| `POST /api/actions` | `{ kind, serviceId }`, always as you (strict: no requester field); returns `{ action, lines? }`; a restart returns while running |

Every write goes through `apps/server/src/store/mutations.ts`, which validates against current state and records an audit entry in the same transaction.

## Demo mode

On by default until discovery exists (`DC_DEMO=off` disables it). On first start the database is seeded with the calm scenario from `apps/server/src/demo/fixtures.ts`. Switching scenarios replaces environment data but keeps the name and quiet hours. "Server unreachable" is simulated in the browser only.

## Discovery (M3)

`apps/server/src/discovery/`. Strictly read-only:

- `docker-client.ts` can only send GET requests. Endpoints tried in order: `DOCKER_HOST`, then Docker Desktop's pipes on Windows or `/var/run/docker.sock` elsewhere.
- `docker.ts` copies only named safe fields out of inspect responses; `Config.Env` (API keys, passwords) is never read into memory structures, logged, or stored. A test asserts this.
- `analyze.ts` is pure: catalogue identification (`catalog.ts`), routing of ports published by a network provider (VPN containers) to the apps inside it, compose `depends_on`, loopback-only detection, one read-only HTTP GET to classify unknown ports (6s timeout; some apps are slow), and a check for well-known apps installed natively.
- `fake.ts` is a synthetic homelab used by unit tests and by E2E (`DC_FAKE_DISCOVERY=1`). Never point tests at real Docker.
- Adoption (`store/adopt.ts`): the first one replaces sample data; later ones merge (kept services keep their ids, incidents, history, public address and notes; unticked ones are removed; agents, channels, and routes are left alone). Settings, autonomy rules, and audit history are always kept; sets `environment=real`. Startup never seeds sample data over an existing environment.

## Monitoring (M4)

`apps/server/src/monitor/`. Strictly read-only: container list + inspect (only `RestartCount` is read), plain HTTP GETs, host metrics, drive health.

- `engine.ts`: `evaluate()` debounces (a failure must repeat `failure_threshold` times, default 2, before an incident opens); one incident per `monitor_key` (`service:<id>`, `volume:<id>`, `disk:<id>`); recovery resolves it as "Recovered on its own". Crash loops are caught from a rising `RestartCount` even when the HTTP check happens to land in an up window. Volumes: incident at 90% full, critical at 97%, closes below 88%. Availability is kept as hourly totals (`availability_hourly`).
- `scheduler.ts`: one pass at a time on a self-rescheduling timer; interval re-read every round (defaults: 15s sample data, 60s real). Drive health every 30 minutes.
- `simulation.ts`: practice failures, sample data only (the API refuses on a real environment).
- `fake.ts`: fake probes with scripted outages for tests.
- Env: `DC_MONITOR=off` disables the scheduler (E2E does this and triggers checks through the API).

## Actions (M5)

`packages/core/src/policy.ts` is the only place permissions are decided (`decideAction`), and the server re-evaluates it at the moment of execution. `apps/server/src/actions/service.ts` (`ActionRunner`) handles requests, automatic responses to new incidents, approvals, and verification. Container access is limited to `actions/tools.ts`. Automatic repairs on real systems need `live_repairs` on, except containers labelled `dragon-control.sandbox=true` (for testing with disposable containers). Logs are redacted (`actions/redact.ts`) and never stored.

Start and stop (`start-container`, `stop-container`, `POWER_ACTIONS` in core) are guardrail actions: never automatic; for anyone but you only as an approved job step (`request` refuses them otherwise); refused through access keys at `POST /api/actions`. `impossible()` refuses starting paused or retired services (even for you) and stopping core networking (`isCoreNetworking`: proxies, VPNs, DNS, Docker access, Hearth). `dependencyProblem()` runs at execution time only, so plans can order steps; it applies to every plan step, and only your direct stop button skips the dependents check (its confirmation lists them). A stop sets `services.stopped_at`/`stopped_by` first; `runChecks` skips held services while their container stays stopped and lifts the hold if it is found running. `carryOutPower` verifies (health check after start, Docker state after stop). Tests: "start and stop (Cave 2)" in `app.test.ts`.

`buildApp` requires an `ActionRunner`; tests build one on `fakeContainerTools` with zero-wait verification and `await runner.idle()` before asserting.

## Command center (Home, projects, workspaces)

Design references and the fit plan: `docs/design/command-center/`. Visual check: `pnpm build && node scripts/visual-check.mjs` (throwaway instance with sample data; screenshots to `test-results/visual`).

- **Shell** (`apps/web/src/components/AppShell.tsx`, `components/shell/`): `Sidebar` (groups, Systems list from the workspace with lifecycle-aware dots, Secure Vault lock state, icon rail stored in localStorage), `TopBar` (find a service or ask, Ctrl+K; overall state; what needs you), `CaveProvider` (`cave-context.tsx`: which conversation is shown, per scope: on its own the main one, with `?project=` open (Home or Ask) that project's ongoing conversation; a different pick is remembered per scope in sessionStorage; expanded or not; a question handed over). Breakpoints: phones (< 768 px) get the mobile top bar, the bottom tab bar (`data-testid="tab-bar"`), and the split view taking turns (`&view=chat`); tablets (768 to 1023 px) get the top bar, the sidebar as an icon rail (forced, `lib/media.ts` `useMedia`), and the split view side by side; desktops can expand the sidebar.
- **Ember chat** (`components/cave/`): `CaveChat` is the only conversation component (Ask page, hub overlay, docked panel). `CavePanel` frames it with the conversations list; `CaveOverlay` is the expanded chat on any page (Escape minimizes). The main conversation is `GET /api/agent/conversations/main` (setting `main_conversation_id`); a project's ongoing conversation is `GET /api/projects/:id/conversation` (its most recently used one, made on first use); a project conversation without an explicit focus is about its project, and plans proposed there belong to it. The full-screen Ask page keeps `?project=`/`?service=` (focus chip, "Back to ..." link to the workspace with the chat side shown).
- **Desktop desk** (1024 px and up; `components/desk/`, plan in `docs/design/command-center/DESKTOP_WORKSPACE_PLAN.md`): `Desk` holds the conversation dock (resize by drag or arrow keys, minimize to a rail, widen; stored in localStorage `dc-desk-dock`) and any number of service/project panels (the unchanged `ServiceWorkspace`/`ProjectWorkspace`, given desk controls and unique ids through `PanelChromeProvider`). The open set is the address: `?panels=[!]kind:id[@tab],...` (`!` pinned) and `&focus=kind:id` (`layout.ts`); legacy `?service=`/`?project=` links still work, and the narrower `SplitView` reads the same list (showing the focused panel). `slotsFor` decides how many fit; `visiblePanels` shows pinned first, then most recently used; the rest wait in the "Also open" strip (nothing closes automatically below `MAX_PANELS`). `usePanelHref` makes service and project references (answers, evidence, progress steps, the Systems list, search, project systems) join the desk instead of replacing it; `Suggestions` offers referenced services as "Open beside this" chips. The conversation on the desk follows the first project panel opened and never switches because another panel opened; the dock offers each open project's conversation. Saved layouts: `GET/POST/DELETE /api/desk/layouts` (table `desk_layouts`, session only, saving under an existing name replaces it), `LayoutsMenu`.
- **Live progress** (`agent/activity.ts`, table `conversation_activity`, `components/cave/Progress.tsx`): each step of answering a message is written when it starts and finished when it ends: gathering facts, asking the AI, every MCP tool the AI calls (wrapped in `registerTools` when the run has `ctx.progress`; plain-English labels in `describeTool`, short results for checks), answering from records, and plans (`job:<id>` rows, always shown with the job's current status; the chat card can approve with the fingerprint or decline). Rows are attached to the owner's message (`CaveMessage.activity`); still-running rows are closed as stopped when the answer is given or on restart. The chat polls every 1.2 s while working; the steps stay open while live and fold into one line afterwards. Nothing is predicted or pre-listed.
- **Stopped on request** shows as "Stopped on request" (neutral) in the Systems list, service workspace and page, Services list, and project systems; it is not counted as down or as needing attention, on Home or in the top bar.
- **Home** (`pages/Home.tsx`, `components/command/`): `CommandHub` (the circle with a real input; focus opens the chat; up to six active projects around it, ranked waiting-for-you first), then attention, what's up, overview, activity. `?project=<id>` or `?service=<id>` (and `&tab=`) switch Home to `SplitView`: chat docked left with the open thing as an explicit, removable focus, `ProjectWorkspace` or `ServiceWorkspace` on the right (shared `WorkspaceFrame`, ARIA tabs). Phones show one side at a time.
- **Projects** (`apps/server/src/projects/service.ts`, routes `/api/projects*`): built on `memory_projects` (+ `phase`, `icon`, `related`), `project_tasks`, `jobs.project_id`, `conversations.project_id`. The shown phase follows facts (`effectivePhase`). Detail gathers tasks, jobs (with steps), notes (memory entries of the project), conversations, logs (events of related services, job events), terminal (captured job step results only), and history (audit for the project and its jobs).
- **Service runtime**: `GET /api/services/:id/runtime` (`ActionRunner.runtime`, `ContainerTools.runtime`): Docker inspect (state, start time, restart count, published ports only) and one stats sample (CPU %, memory as `docker stats` computes them). Sample data, other machines, and non-containers return `available: false` with the reason.
- **Pages**: `/projects`, `/docker`, `/network`, `/backups`, `/logs` (`pages/Projects.tsx`, `pages/Infrastructure.tsx`), all from existing records.
- **Secure Vault**: `GET /api/vault` returns only `{ locked: true, count }` until the session has the vault unlocked or a recent identity check; then names, categories, usernames, endpoints, notes, tags, and verified times (never values). Values come one at a time from `/reveal` and are hidden again after 30 s. `POST /api/vault/secrets/:id/verified` records "it works"; a successful integration read (Prowlarr) sets it too. Replacing a value clears it. No short PIN is added as a key: a passkey's device PIN or biometric is the quick unlock.

## Jobs (Cave 2)

`apps/server/src/jobs/`: `engine.ts` (`Jobs`: plan, decide, stop, execute, recoverInterrupted, close) and `operations.ts` (`JobOperations`; `runnerOperations` carries each step out through `ActionRunner.request({ approved: true })`, so execution, records, verification, and the flap/crash-loop/lifecycle checks stay in one place). A plan is checked step by step with `ActionRunner.preview` (the same checks and policy as a request); any refused step refuses the plan. Plans you make always wait for your review; the AI's or Hearth's run at once only if the policy allows every step. Approval: `jobFingerprint` over id, title, requester, incident, expiry, and the ordered steps; `decide` needs it, refuses an expired or changed plan, and the status moves out of awaiting-approval once (single use). Policy is checked again when each step runs (`approved: true` still refuses under Monitor or Diagnose for the AI). Steps run in order; the first failure stops the job, later steps are skipped, and completed steps with an `undo` are undone newest first (start and stop undo each other; restarts and read-only steps have nothing to undo). Stop: after the current step. Shutdown (`close`, an `onClose` hook) and restarts (`recoverInterrupted`) mark a running job interrupted; it is never resumed by itself. Lapsed plans are swept with lapsed incident proposals (`expireApprovals`). Jobs are part of the environment (cleared with sample data). Tests: `jobs/jobs.test.ts` (stand-in operations, incl. rollback and shutdown) and "jobs (Cave 2)" in `app.test.ts` (real runner on sample data).

## Inside the apps (M9)

`apps/server/src/apps/`: `prowlarr.ts` (`readProwlarr`: GET only, `/api/v1/system/status`, `/health`, `/indexer`, `/indexerstatus`, key in the `X-Api-Key` header; indexers you switched off are ignored; Prowlarr's own "indexers unavailable" note is not repeated next to the indexer list) and `service.ts` (`AppWatcher`). An app is recognised by image or name (`APP_INTEGRATIONS` in core). Its API key is a vault secret of kind API key, automation tier, linked to the service; a protected key or none gives `needs-key` with instructions, a refused key too. Reads are kept in `app_health` (one row per service, part of the environment) and shown in the workspace (`apps`). Each use of the key skips the audit trail (it would be one entry every five minutes); the read time is the record. Error-level issues confirmed on two reads in a row open an incident keyed `app:<service>` whose timeline says a restart will not fix it; it is never passed to the runner, so no restart is proposed; the AI operator can be escalated to as for any escalated incident. Healthy again closes it. Schedule: every five minutes from the monitoring timer, apps never read at once, and on every full `POST /api/monitor/run`; `POST /api/services/:id/app/check` reads one now. Sample data gets a believable reading (failing in the attention scenario), never from the network. AI: `app_health` tool; Ember includes app issues for status and "why" questions. Tests: `apps/prowlarr.test.ts`, "inside the apps (M9)" in `app.test.ts` (`fakeAppFetch`; tests never reach the network).


Phase 2 (2026-10-09): readers for Prowlarr (`apps/prowlarr.ts`, now also history and indexers as connections), Radarr and Sonarr (`apps/arr.ts`, API v3: health, queue with stuck items, history, download clients), SABnzbd (`apps/sabnzbd.ts`: key in the query string as the app requires; never in errors or reports), qBittorrent (`apps/qbittorrent.ts`: vault kind Login with username, signs in, reads, signs out). Shared `apps/http.ts`. Reports carry `queue`, `queueTotal`, `activity`, `connections` (`app_health.details`). `GET /api/services/:id/diagnostics` reads live for the panel (at most every 10 s per app; within that, the last read) and never counts towards opening incidents; the 5-minute background reads do. Queue problems are warnings, never incidents on their own. Web: `components/command/Diagnostics.tsx` (Diagnostics tab after Overview for integrated apps, refreshed every 20 s, Live/Recorded stamps with read time, credential steps when missing). The AI's `app_health` tool includes a short queue/activity/connection summary, cited as a record with its read time. Tests: `apps/readers.test.ts`, "diagnostics read Sonarr live" in `app.test.ts`, desk browser test.

## Installable app (Cave 5)

`apps/web/public/manifest.webmanifest`, icons rendered from the mark by `node scripts/render-icons.mjs` (192, 512, maskable 512, Apple 180), and `apps/web/public/sw.js`, registered in production builds only. The worker caches the app's own files (the page shell, network first; hashed `/assets/*`, cache first) so the app opens without a connection and shows its "cannot reach Hearth" state. It never caches `/api/*`: your data stays on the server and signing out leaves nothing behind. Service workers need a secure context (https, as over Tailscale Serve, or localhost); on a plain-http LAN address the app works the same without it. Bump `CACHE` in `sw.js` if the caching rules change. Browser tests block service workers except the "installable app" test.

## Notifications (M8)

Routes: `PUT /api/notifications/channels/:id` `{ values }` (secret fields go to the vault), `DELETE /api/notifications/channels/:id`, `POST /api/notifications/channels/:id/test`, plus `PUT /api/notifications/routes/:id`. Code in `apps/server/src/notify/` (catalog, providers, notifier). Tests use fake providers (an in-memory outbox) and a fixed local clock for quiet hours and Sundays; `providers.test.ts` runs the real providers against local SMTP and HTTP stand-ins. Never point tests at real addresses.

## Linux and other machines

Hearth runs on Linux and Windows from the same build. Platform differences live in `auth/keyguard.ts` (DPAPI on Windows, an owner-only key file in `DC_KEY_DIR` elsewhere), `discovery/disks.ts` (PowerShell on Windows; systeminformation plus hwmon temperatures on Linux) and `discovery/docker-client.ts` (named pipe or socket). To run the suites on Linux from Windows, send a tar of the working tree to a `node:24-bookworm` container (`git ls-files -co --exclude-standard | tar --force-local -cf ...`). Install as a service: `deploy/linux/install.sh`. Several installations on one machine (`DC_SERVICE_NAME`, `DC_SERVICE_USER`, autostart, limits, `--status`, `--uninstall`): `docs/MULTIPLE_INSTALLS.md`. `install-script.test.ts` proves that managing one never runs anything against another. Another machine: `POST /api/discovery/scan-remote { address, name }` probes the catalogue's `nativePort`s at that address (`findAppsAt`), keys `remote:<host>:<app>`, host connection `network`; adoption only ever replaces the scanned machine's services.

## Homelab memory and backups

`apps/server/src/memory/` (service, routes, Markdown export) and `apps/server/src/backup/`. Search is the FTS5 table `memory_search`, maintained only by triggers in migration `0013_memory_search.sql` (hand-written custom migration; drizzle does not know the table, so query it with `handle.sqlite`). New writable tables that should be searchable need triggers there (a new custom migration), not code paths. Writes that must not run inside a transaction (VACUUM INTO) go through `withQueue`. Tests: "homelab memory" and "backups" in `app.test.ts` (`makeApp({ clock })` drives the backup schedule; `backupRoot` is the temp folder).

## Claude Code companion

`integrations/claude-code/` (see its README). Tests: `src/companion.test.ts` runs the client against a small stand-in server so outages can be switched on and off. To try it by hand: `node integrations/claude-code/plugin/companion/companion.mjs briefing`. Never run real Claude Code from tests; the acceptance runs in the verification log were done by hand.

## AI operator and access keys (M7)

Routes: `POST/GET /api/agent/conversations[/:id]`, `POST /api/agent/providers/:id/connect`, `POST /api/agent/disconnect`, `PATCH /api/agent/settings`, `GET /api/status`, `GET/POST/DELETE /api/keys`, and `/api/mcp` (agent session keys only). Bearer access keys reach only routes in `ROUTE_SCOPES` (`auth/tokens.ts`). Tests use a scripted agent (`fakeAgent` in `app.test.ts`) that talks to the real MCP endpoint over HTTP (`makeApp({ listen: true })`); browser tests set `DC_FAKE_AGENT=1` for `scriptedProvider()`. Never run the real Claude Code from tests. Home Assistant: `docs/HOME_ASSISTANT.md`. AI setup brief: `AI_README.md`.

## Sign-in and vault

All `/api` routes except `GET /api/health` and the sign-in routes (`/api/auth/status|setup|login|recover|passkey/options|passkey/verify`) require the `dc_session` cookie. Routes: `/api/auth/*` (setup, login, recover, logout, logout-all, password, recovery-key, passkeys) and `/api/vault` (`GET`, `POST lock`, `POST/PATCH/DELETE secrets`, `POST secrets/:id/reveal`). A fresh install writes its one-time setup code to `<dataDir>/setup-code.txt` and logs a `/setup?code=` link. `pnpm owner:reset` (on the machine only) forgets the owner, passkeys, sessions, and vault so it can be set up again; everything else is kept.

Tests: `makeApp()` claims the install with a fast KDF (`kdfCost: 1024`) and sends the cookie on every call; `makeApp({ signedIn: false })` for unclaimed tests. E2E: the `claim` project claims the main server and saves `test-results/.auth/owner.json`; the `auth` project runs a second unclaimed server on `localhost` (WebAuthn needs a domain) with a CDP virtual authenticator.

## Gotchas

- **tsup must keep the `node:` prefix** (`removeNodeProtocol: false`). `sqlite` only exists as `node:sqlite`; stripping it makes the built server crash while dev mode works fine.
- TypeScript is pinned to 6.0.x because typescript-eslint doesn't support TS 7 yet.
- pnpm blocks install scripts by default; `esbuild` is allowed in `pnpm-workspace.yaml`.
- Port 5173 is used by another project on the dev machine, so Vite uses 7401.
- The drizzle sqlite-proxy adapter must return `rows: undefined` for a `get` with no match; an empty array is mapped as a row of undefined columns and crashes JSON columns.
- **Never write code containing backslashes through a shell heredoc** (or a `node -e` string inside one). Escapes get eaten: regexes like `/^https?:///` and Windows pipe paths silently broke three times. Use the editor/file tools for such code.
- Migrations run with foreign keys off *outside* the transaction (SQLite's documented table-rebuild procedure); otherwise drizzle-kit's table rebuilds cascade-delete child rows.
- `.gitignore` entries for runtime folders must be anchored (`/data/`), or they also hide source folders with the same name.
