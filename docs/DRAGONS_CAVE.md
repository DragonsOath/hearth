# Ember: evaluation and roadmap

> Renamed from Dragon's Cave on 2026-10-11 (checklist 22.13). The file name, routes (`/ask`), code paths (`cave/`), database tables, setting keys, and API fields keep the old internal names on purpose, so stored data, links, and integrations keep working. Your AI administrator's display name is set in Settings > Ember > Identity.

Status: **approved by the owner 2026-10-08; Cave 1 built (commit ae3c5f9).** Source: the owner's
"Ember: Product Vision & Development Direction" brief, checked against the code as of
commit d9a9685. the owner's decisions are recorded in section 3; Cave 1 results in section 6; the
Just-in-Time Administrator Approval design in section 8.

## The short version

Hearth already has the hardest part of the vision right: **the AI never holds the
power.** The in-app operator runs with every built-in tool switched off and can only call
Hearth's own tools; it asks for actions, and the server decides, using autonomy rules
the model cannot change, approvals tied to one specific action, and a check of the result
afterwards. Memory, history, and "verified versus remembered" are also in place.

What is missing is **reach and range**:

- **Reach:** Hearth acts only on the home server's Docker. Home Vault is seen from the network
  (a few web ports), ai-box not at all; networking, DNS, and reverse proxies are not modelled.
- **Range:** it can check, test, read logs, and restart a container. It cannot install, update,
  move, or configure anything, and it has no notion of a multi-step job with a plan.
- **Conversation:** the "Ask about your homelab" bar on Home is still a placeholder. The AI
  Agent page can talk to the operator, but the operator cannot read the memory.
- **Jurisdiction** exists only as "the in-app AI has no tools outside Hearth". There is
  no registry of what belongs to the homelab, so nothing yet decides "the Gig Tracker repository
  is out of scope even though it lives on an enrolled machine".

The smallest useful next step is to make the conversation real and accountable, inside the
safe boundary that already exists (milestone **Cave 1** below), and then to grow reach and range
through one carefully designed execution layer, never through a general shell.

## 1. What already supports the vision

| Vision area | Already in place | Where |
| --- | --- | --- |
| AI cannot act directly | Operator = Claude Code headless with `--tools ""`, `--strict-mcp-config`, only `mcp__dragon-control` allowed, no personal settings loaded; per-run keys | `agent/providers.ts`, `agent/mcp.ts` |
| Enforcement outside the model | One policy function decides every action (autonomy level, guardrails, live-repairs switch); the agent never decides its own permissions | `packages/core/src/policy.ts`, `actions/service.ts` |
| Approval tied to one action | An approval runs the stored action record (kind + target) and re-checks policy at run time; it is not a session-wide grant | `ActionRunner.runApproved` |
| Verify, never assume | Repairs are verified by Hearth's own check, independently of what the AI claims | M5/M7 runbooks |
| Tiered autonomy | Monitor / Diagnose / Ask / Auto Fix, global plus per-area rules, hard guardrails, live repairs off by default on real systems | Autonomy page |
| Audit trail | `audit_log`, `actions`, incident timelines, notification log | DB schema |
| Persistent infrastructure knowledge | Hosts, services, volumes, disks, dependencies (start of a graph), discovery and reconciliation by re-scan | `discovery/`, `store/` |
| Verified vs documented vs assumed | Memory `basis` (observed / documented / stated / unknown), `verification` records, `superseded` history, LIVE vs CACHED labels | `memory/`, companion |
| Reconcile old records with live state | Import triage compares notes with what Hearth sees and keeps conflicts as history | `memory/triage.ts` |
| History and accountability | Journal written automatically for fixes and adoptions; transcripts word for word; full-text search; revisions for every edit | `memory/` |
| Secrets | Vault (passkey/password, automation and protected tiers, broker model: the AI never reads values), redaction of logs and transcripts | `auth/vault.ts`, `redact.ts` |
| Dashboard questions 1-3 | Home: healthy headline, "Requires your attention", "What's up / Since you were last here", activity; personalised greeting | `pages/Home.tsx` |
| Mobile | Every screen tested at phone width; bottom navigation; axe accessibility checks | Playwright suite |
| Notifications, reach-out | Email, Discord, ntfy, webhook; severity routing; quiet hours; optional daily check-in | `notify/` |
| Resilience | Daily verified backups, encrypted off-machine copies on Home Vault, backup alerts | `backup/` |
| Many AIs, one memory | Companion API and key; Claude Code add-on on three machines; design for Codex, Gemini, local models (P1) | `docs/COMPANION.md` |

**Preserve all of this.** In particular: the visual direction, the policy-in-the-server design,
the approval-per-action model, memory provenance, and the companion key model.

## 2. Gaps, by vision section

1. **Boundaries.** No jurisdiction registry (enrolled machines, approved repositories, storage
   roots, domains, compose projects). Terminal sessions with the companion keep their full normal
   abilities: they get the memory, not a boundary. The operator's boundary is "Hearth's
   tools", which is safe but too narrow to be useful for "install" or "move".
2. **Awareness.** Home Vault (Windows) and ai-box have no agent, so no processes, memory,
   drives, services, or logs from them. Caddy routes, DNS, Tailscale, the router, VPN tunnels,
   and storage mounts are not modelled. Dependencies exist but are thin.
3. **Orchestration.** No task model (a job with a plan, steps, state, logs, and a result that
   survives the browser closing). No way to dispatch work to Codex or Claude Code with a scoped
   identity. No execution environments other than the home server's Docker socket.
4. **Autonomy.** Four action kinds. Tier 2 operations (install, migrate, update, configure) do
   not exist yet; neither do rollback plans.
5. **Conversation.** Home's command bar sends nothing. The operator cannot read the memory, the
   audit trail, or past tasks, so it cannot answer "what did you change yesterday" or "who
   approved that". Answers are plain chat, not structured "conclusion, evidence, next step".
6. **Dashboard.** No agent-activity or pending-decisions panel beyond incidents; mobile is a
   responsive desktop, not a phone-first layout; no installable app or push notifications.
7. **Accountability.** Actions, approvals, memory, and transcripts are recorded but not linked
   into one chain ("this change came from this task, approved by you at 21:04, verified by this
   check, rolled back by that one").

## 3. Decisions (the owner, 2026-10-08)

**Decided:**

1. **Name:** the product stays **Hearth**; **Ember** is the AI companion inside it.
2. **Jurisdiction** is a configurable, enforceable product feature. Each installation's AI is
   bound to its owner's registry; the owner's lists Home Vault and authorized homelab resources.
3. **Terminals:** restrictions apply only to work Ember dispatches or controls. the owner's
   own Codex and Claude Code terminals are untouched.
4. **Imports:** unrelated website work, business and client work, Gig Tracker, and other
   independent projects are excluded. Mixed sessions are reviewed one by one. The 135 suggested
   memories are **not** auto-approved.
5. **ai-box:** enroll only specifically authorized homelab services, directories, and
   operations. No blanket access to the computer.
6. **AI usage:** configurable daily token and cost budgets, usage reporting, warnings, and
   minimal context per question.
7. **Seerr and Kometa:** Jellyseerr was deliberately replaced by Seerr 3.5.0 (port 5056); the
   old container is stopped on purpose. Kometa is stopped pending decisions. Neither is an
   incident or restarted automatically.

The original questions, kept for the record:

1. **Name.** Rename the whole product Ember, or keep Hearth as the product and
   call the resident AI Ember? (The code can rename cheaply now; the later it happens,
   the more it costs.)
2. **Public project (D12) versus "exclusively Home Vault".** Proposed reconciliation: the
   product has a *jurisdiction* concept; every installation's AI is bound to its owner's
   registry. Yours lists Home Vault, the home server, and ai-box. Nothing Home Vault-specific
   goes into the product itself. Confirm, or say if the public plan has changed.
3. **Terminals.** Should homelab-mode terminal sessions also be bounded (for example, a Cave
   worker that can only touch registered repositories), or stay full Claude Code sessions that
   merely share the memory? Recommendation: keep personal terminals as they are, and put the
   boundary on work that Ember itself dispatches.
4. **What is in the kingdom.** The import includes material the purpose rule would exclude:
   website and business work, AI experiments on ai-box, and app development projects that
   serve the homelab without being part of it. Proposed: leave business and unrelated projects
   out during review; decide the software projects explicitly.
5. **ai-box's role.** It is a GPU workstation and personal PC. Enrol only its homelab duties
   (Moonlight/Sunshine, transcode scratch, any containers), not the whole machine.
6. **AI cost.** Each conversation with the operator spends Claude usage (about 33k tokens of
   baseline per run today). Set a daily budget, or plan for a local model for routine questions
   (P1 makes that possible).

## 4. Security, permissions, and infrastructure concerns

These shape the design from the start:

- **No general shell, anywhere.** Every change Ember can make is an *operation* from a
  typed catalogue (name, parameters with validation, preconditions, risk tier, verification,
  rollback). The model may only *request* operations. The server checks jurisdiction and policy
  and runs them. A host agent executes only catalogue operations, never a command string.
- **Compose files are code.** "Install this app" means running someone's compose file. Validate
  every compose plan: refuse privileged containers, host PID/network unless approved, mounts of
  the Docker socket, `/`, system or key folders, and storage outside registered roots; pin
  images; show the exact diff in the approval.
- **Docker access is root-equivalent.** Hearth's user is in the home server's docker group today.
  That is acceptable for a control plane, but it makes Hearth itself a high-value target:
  keep it tailnet-only (Funnel off), keep sign-in strong, and keep the operator unable to reach
  anything but catalogue operations.
- **Approvals bind to a plan, once.** An approval covers one plan with its exact parameters
  (hashed), expires, can be used once, and policy is re-checked at execution (as `runApproved`
  already does for restarts).
- **Untrusted text everywhere.** Logs, container labels, web pages, imported notes, and agent
  output can carry instructions aimed at the AI. Treat them as data: tool output can never raise
  a permission, and every operation still passes jurisdiction and policy.
- **Jurisdiction enforced twice.** A scope check before any work starts ("is this request about
  the homelab?") gives the polite refusal; the real guarantee is that every operation's targets
  must resolve to registered resources, so a misjudged request still cannot touch an
  unregistered repository, path, or machine.
- **Worker agents (Codex, Claude Code) get a box, not a key ring.** Each task runs in its own
  working copy of one registered repository, with no secrets, no network beyond what the task
  needs, a task identity, a time limit, and its output reviewed before anything is deployed.
  Deploying is a separate, approved operation. Existing interactive sessions are not remote
  controlled: Ember starts new non-interactive runs through the supported command-line
  modes (Claude Code's `-p` with tool restrictions, which Hearth already uses; Codex's
  non-interactive mode with its sandbox settings, to be verified when built).
- **Secrets stay in the vault.** Operations that need a credential get it injected by
  Hearth at execution time; neither the model nor a worker sees the value.
- **Host agents are a new attack surface.** Each enrolled machine runs a small agent with its own
  key, a fixed operation list, outbound-only connection to Hearth (no listening port),
  and the ability to refuse anything not in its list. On Home Vault (Windows) it runs as a
  normal user, with elevation only for operations that need it, approved per run.
- **Single point of failure.** If the home server is down, Ember is blind. The Home Vault agent
  should report "the home server unreachable" on its own (by notification), and backups already live off
  The home server.
- **Rollback before risk.** No Tier 2 operation without a recorded way back (previous image tag,
  previous compose file, config snapshot, backup taken first).

## 5. Architecture, evolving what exists

Six layers, mostly mapping to modules that already exist:

| Layer | Today | Grows into |
| --- | --- | --- |
| UI | React app, Home, Memory, Agent page | Conversation-first Home on phones, tasks and decisions panels, installable app |
| Inventory | `hosts`, `services`, `volumes`, `disks`, dependencies | Plus routes (proxy, DNS), networks, mounts, compose projects, repositories; each fact with source and last-verified time |
| Memory | `memory/` (entries, transcripts, provenance, superseded) | Linked to tasks, operations, and inventory facts |
| Jurisdiction | Implicit (operator tool list) | `jurisdiction` registry + scope check; the resolver every operation must pass |
| Orchestration | Incidents, runbooks, escalation to one operator | Tasks: plan, steps, approvals, workers, progress, verification, report |
| Execution | `ActionRunner` on local Docker | Operation catalogue run by Hearth on the home server and by host agents elsewhere; workers in boxes |

No new frameworks are needed for any of it: the same Fastify server, SQLite, MCP tools, and
policy function, extended.

## 6. Roadmap

Each step is useful on its own and keeps everything that exists. M9 (Prowlarr), P1 (any AI), P2
(public), and M10 (installer) from `GAME_PLAN.md` fit in where noted.

### Cave 1: Ask Ember (recommended next)

**What you get:** the command bar on Home (and a phone-first conversation view) actually works.
You can ask "What's happening with my servers?", "Why did Jellyfin go down last night?", "Did my
backups finish?", "What did you change yesterday?", "Who approved that?", "What did the agents do
while I was away?", and get short answers that lead with the conclusion, say what was verified
just now versus remembered, and link to the evidence. It can run the checks and repairs it
already has, under your autonomy rules. Ask it to work on Gig Tracker and it says that is
outside its responsibilities.

**What it takes:**
- Give the operator read access to memory, the audit trail, actions, incidents, backups, and
  notifications (new MCP tools on the existing server), so answers come from records.
- A jurisdiction registry, first version: enrolled machines, registered repositories, storage
  roots, and domains, editable in Settings and seeded from discovery; plus a scope check that
  refuses out-of-scope requests before any work starts, and an audit entry for each refusal.
- Answers in a fixed shape (conclusion, what was checked, evidence links, decision needed),
  rendered as cards on the phone.
- Conversation state on the server, so a question asked on the phone survives closing the
  browser and the answer arrives as a notification if it takes a while (the Belle path already
  does this).
- A daily usage budget for the operator.

**Why first:** it uses only the safe boundary that already exists, delivers the "manage it by
talking to it" experience immediately, and builds the registry and the records every later step
depends on. Security risk is low: no new execution power.

### Cave 2: Tasks and the operation catalogue (the home server)

A job model (plan, steps, approvals bound to the plan, progress, logs, verification, rollback,
report) and the first Tier 2 operations on the home server's Docker: update a container image, change a
container's settings, install an app from a reviewed compose plan (with the compose validation
above), and remove an app with a backup first. "What did you change yesterday / can we roll it
back" become exact. **M9 Prowlarr** lands here as the first app-level integration (indexer health,
its own operations and runbook).

**Progress:** slice 1 built 2026-10-08: approvals are bound to one proposal. Each proposed repair
carries a fingerprint over the incident, the words shown, the action that would run (id, kind,
target), and its expiry. Approving must send that fingerprint back (the app does this; Home
Assistant reads it from `/api/status`). A changed proposal, an expired one (24 hours,
`APPROVAL_WINDOW_HOURS`), or a second use is refused and nothing runs; only the action the
fingerprint covers is carried out. Expiry is stored, so a restart cannot revive it; a sweep on
each monitoring pass closes lapsed proposals with a timeline note and an audit entry. Declining
revokes. These are the binding rules section 8 asks for, in place before any new power exists.
Slice 2 built 2026-10-08: the job model for the existing operations (Jobs page, plan builder,
review with what each step does, how it is checked, and how it would be undone; approve once;
progress; stop after the current step; outcome). Each step runs through the same runner and
policy as any action, checked again when it runs; the first failure stops the job; completed
steps that can be undone are undone newest first (today's operations have nothing to undo, so
the framework is exercised with stand-in operations in tests). A restart or shutdown marks a
running job interrupted, never resumed by itself. The AI can propose a job (`propose_job`);
Ember counts jobs among "what changed" with links. Next: Tier 2 operations on the home server's
Docker, which change infrastructure: **proposal for the owner first** (operations, safeguards, risks).

### Command center (built 2026-10-08/09)

the owner's command center specification (`docs/design/command-center/`) became the app's shell: the
Ember hub at the centre of Home with projects around it, the conversation expanding in
place or docking beside a project or service workspace, a Systems explorer, and the Secure Vault.
It reuses the job model, approvals, runner, memory, and vault; nothing executes through a new
path. Projects are the memory projects, extended; jobs and conversations can belong to one.

Second pass (2026-10-09): live progress in the conversation (only steps that really happened,
written as they happen; plans shown as their live job, approvable in the chat), each project's
own ongoing conversation beside the main one (the choice survives moving between the chat, the
workspace, and full screen), and tablets keeping the split screen with the sidebar as a rail.

### Cave 3: Host agents (Home Vault, ai-box)

A small outbound-only agent with a fixed operation list on each enrolled machine: inventory
(processes, services, drives, memory), logs, service restart, Caddy routes read (then managed),
and "the home server is unreachable" alerts from Home Vault. Caddy, Sunshine, and Syncthing on
Home Vault become watched services. Networking enters the inventory (Caddy routes, Tailscale
devices, DNS names).

### Cave 4: Workers (Codex and Claude Code, dispatched)

Ember dispatches software work on registered repositories (Ember itself, the
compose definitions, homelab scripts) to Claude Code or Codex running non-interactively in a box:
own working copy, task identity, no secrets, time limit, output reviewed, deploy as a separate
approved operation. Multi-step jobs like "move this service from Windows to the home server" combine host
agent operations, the home server operations, and verification into one plan you approve once per risky
step. Builds on **P1** (provider-neutral companion core).

### Cave 5: Phone-first and polish

Installable app (offline shell, push notifications for decisions), the mobile layout led by
conversation, decisions, and active tasks; agent activity and pending decisions panels on Home.
Overlaps with **M10/M11**; **P2** (public release) after this, if still wanted.
**Progress 2026-10-08:** installable app (manifest, icons, offline shell that never caches your
data); jobs awaiting approval on Home. Push notifications for decisions still to come.

### Cave 1 results (built 2026-10-08)

- **Ask page** (`/ask`, in the phone's bottom bar): a conversation thread. Each answer says how
  it was produced (*Answered from live state and records*, *From Hearth's records*, or
  *Outside what I look after*) and carries numbered evidence, each tagged live, record, or
  memory, linking to the service, incident, backup, or memory entry. Earlier conversations are
  one tap away; an unsent question survives closing the page; a question interrupted by a
  restart is closed with a note at startup.
- **Jurisdiction registry** (Settings > Ember, or `pnpm jurisdiction`): in-scope and
  out-of-scope entries (machine, repository, path, domain, service, topic). A request naming an
  out-of-scope entry is declined **before** any AI runs, politely and with an audit entry.
  Unclear requests go to the AI, which is told the registry and must answer "OUT OF SCOPE:" if
  the request is not homelab work. Only a signed-in session can change the registry; access keys
  (including the AI's) cannot.
- **Question-specific context:** Hearth classifies the question (health, incidents,
  changes, backups, history, a named service), picks a time window ("last night", "yesterday",
  "since my last visit"), and hands the AI a short evidence pack (at most 6,000 characters) with
  `[E#]` labels instead of letting it fetch everything.
- **Graceful degradation:** no AI connected, AI failure, budget exhausted, or the server's AI
  unreachable all fall back to an answer built straight from the evidence pack, labelled as such.
- **Usage and budgets** (Settings > Ember): every AI run is recorded (tokens, cost,
  model, turns, what it was for). Daily cost and token limits, a per-run cap, a warning at 80%,
  and the model for questions (Sonnet by default) and for incident investigations.
- **New read-only tools for the AI:** incidents, recent changes, memory recall, backup status.
  Logs are trimmed to warnings, errors, and the last 20 lines.
- **No new powers.** The AI still requests actions through the same runner and policy; nothing
  in Cave 1 can change infrastructure.

**Where the 33K tokens came from (measured):** the Claude Code harness alone is about 640 input
tokens and the tool list about 2.5k. The cost was multi-turn re-reading (each turn re-sends the
whole context), broad tool outputs, full logs (10 to 13k characters, about 3k tokens, per read),
and Opus as the default model. A typical question was 3 turns and about 9k input tokens ($0.036
on Opus); "why did Jellyfin go down" was 6 turns and about 15.6k ($0.04). Cave 1 answers: fewer
turns (the evidence pack is in the first message), trimmed logs, Sonnet for questions (about half
the cost), and a turn and spend cap per run.

**Retired versus failing (investigated):** previously every container that was not running
became "failing", then an incident with a restart proposal. Now: (1) each service has a
lifecycle, *watched*, *paused* (off on purpose for now), or *retired* (replaced or removed), set
on its page or with `pnpm service <id> --paused|--retired|--watch --note "why"`; paused and
retired services are not checked, never raise incidents, and the runner refuses automatic
changes to them; marking one resolves its open incidents and records a memory entry. (2) A
container that exited cleanly (exit code 0 or 143, a normal `docker stop`) is reported as
"stopped on purpose" (information, not a failure) and is not restarted automatically. A crash
(any other exit code) is still an incident.

## 7. Existing documents and sources of truth

Proposed rule: **Ember holds live state and memory; documents are inputs or outputs,
never a second truth.**

- The reviewed import brings MASTER_STATE's ledger, the STATE files, and the Home Lab reference
  docs in once, with conflicts kept as history.
- After that, the Home Lab reference docs can be regenerated from Ember (the readable
  Markdown export already exists) instead of hand-maintained in parallel. That is a change for
  Codex's workflow too, so it needs the owner's and Codex's agreement before anything is retired.
- Codex writes to the same memory through its own key once P1 lands, instead of a separate
  ledger.

## 8. Just-in-Time Administrator Approval (roadmap, not built)

**The feature:** when a job needs administrator rights (install a package, edit a system
service, change a firewall rule, mount a drive), Ember does not get those rights.
Instead it prepares an exact plan, the owner reviews it, approves it once, and a separate, narrow
privileged executor carries out exactly that plan and nothing else. The experience is "ask,
review, approve, continue".

**What the owner sees before approving:** the target machine; every change, step by step, with the
exact values; the services affected and expected downtime; the risks; the rollback for each step;
and whether a backup or snapshot is taken first. Destructive operations (delete, format, remove
data, change disks or permissions) get a stronger confirmation: typing the target's name and a
fresh sign-in.

**The rules:**

- **The AI never gets root.** The model can only *propose* a plan built from catalogue
  operations. It never holds a credential, a privileged session, or a shell.
- **Approval is bound to the plan.** The approval covers a hash of the exact plan (operations,
  parameters, target machine, order). Any change, even one value, makes a new plan that needs a
  new approval.
- **Short-lived and single-use.** An approval expires after a few minutes (configurable), is
  consumed by the first execution, and is stored with its expiry, so a restart cannot revive an
  expired one. Pending approvals can be revoked at any time.
- **Constrained privileged executor.** A small separate process (on the home server first, on host agents
  later) that runs as the elevated identity and accepts only allowlisted operation names with
  validated parameters. It does not accept commands, scripts, or file contents chosen by the AI.
  Each operation has its own fixed implementation, preconditions, verification, and rollback.
- **Credentials never reach the AI.** The executor holds or is granted the elevation (for
  example a sudoers rule that allows only the executor's fixed binary, or a Windows scheduled
  task running as administrator); the AI and Hearth's web process never see a password.
- **Verify and audit.** After each step the executor reports what changed; Hearth checks
  the result independently, records plan, approval, executor output, and verification in the
  audit trail, and rolls back on failure where the plan says so.

**How it fits what exists:**

- **Autonomy engine:** `decideAction` already returns allow, ask, or refuse from the action, the
  requester, the autonomy level, and the area. Administrator operations would be a new risk tier
  that the policy always answers with "ask", whatever the autonomy level: no setting makes them
  automatic. `runApproved` already re-evaluates policy at execution time; JIT extends it with the
  plan hash, expiry, and single-use checks before anything runs.
- **Cave 2:** this is the natural extension of Cave 2's job model and operation catalogue.
  Cave 2 introduces plans, steps, approvals bound to a plan, verification, and rollback for
  Docker operations, which need no elevation (Hearth's user is already in the docker
  group). JIT adds a second executor and a set of operations marked "needs administrator".
  Recommended order: build Cave 2's plan and approval model with JIT's binding rules from the
  start (hash, expiry, single use, revocation, survives restarts), so the privileged executor in
  Cave 3 plugs in without a redesign.
- **Cave 3 (host agents):** the first real privileged operations probably live on Home Vault
  (Windows services, Caddy) and on the home server's system level (packages, mounts). The host agent's
  fixed operation list is where "needs administrator" operations are declared.

**Not now:** per the owner's instruction, no elevation is implemented and no system permissions are
changed. Designing the executor's privilege mechanism (sudoers entry, polkit rule, or Windows
task) is a decision for the owner when Cave 3 begins.
