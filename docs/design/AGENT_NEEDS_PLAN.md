# Game plan: building what the agent needs

The owner approved all eleven needs in [AGENT_NEEDS.md](AGENT_NEEDS.md) on 2026-10-14 ("all of them
sound good") and asked for a list and a plan to tackle them. This is the plan. It is ordered so
each phase gives the owner something usable on its own, and so later phases reuse earlier ones
instead of building the same plumbing twice.

Sizes are rough: **S** is a day or less of work, **M** a few days, **L** a week or more.

## The list

| #   | Need                                       | Status today | Phase |
| --- | ------------------------------------------ | ------------ | ----- |
| 1   | One true map of the homelab                | partial      | 1     |
| 2   | Change history with one-click rollback     | partial      | 2     |
| 3   | Scoped app APIs and admin rights for a task | partial      | 4     |
| 4   | A practice run before every change         | partial      | 4     |
| 5   | Awareness of resources and of the person   | missing      | 3     |
| 6   | Long jobs that run themselves              | partial      | 3     |
| 7   | Tested recipes (blueprints)                | missing      | 6     |
| 8   | Hardware and network check-up              | missing      | 6     |
| 9   | Help with physical steps                   | missing      | 6     |
| 10  | Teach mode                                 | missing      | 6     |
| 11  | A profile of the person                    | partial      | 0, 5  |

## Phase 0: shared foundations (M)

Three small pieces that almost everything else stands on.

1. **Facts with a date.** One store for what Hearth knows about the homelab, where every
   fact records its source, when it was last checked, and whether it was verified or inferred.
   The agent's context shows "checked 2 days ago" next to each fact, and anything older than its
   refresh interval is marked stale instead of trusted.
2. **Tracked jobs.** A job record for anything that runs longer than a minute: progress, a
   heartbeat, a hard stop time, and a stall rule ("no progress for 10 minutes" raises an alert).
   Plans already run as jobs; this extends them to work that runs outside a plan.
3. **Profile basics.** A settings page with the owner's do-not-touch list (today Recyclarr and
   Kometa live only in notes), quiet hours, and reservations such as "GPU free by 7 PM".

Done when: the agent's context shows dated facts, a test job that stops reporting raises an alert
in the UI, and the do-not-touch list blocks a plan that names one of those systems.

## Phase 1: the live map (L)

What the owner sees: a **Map** page. Machines as cards (the home server, Gaming-PC, Home Vault), each with
its drives, containers, ports, and proxy addresses, and a "controlled by" line pointing at the
compose file or config that owns it. A stale badge on anything not checked recently. Clicking a
system shows its quirks and do-not-touch status.

What the agent gets: a `homelab_map` tool that answers "where does X run, what owns it, what
depends on it, and when did we last look" from facts, not memory.

Steps:

1. Map model and page built from what discovery already finds on the server (containers, disks,
   Caddy routes). **S**
2. **Other machines.** Decision needed (below): a small read-only reporter ("scout") installed on
   each machine, or read-only SSH from the server. The scout is recommended because it also suits
   beginners, who will not have SSH set up. It reports hardware, drives, running services, USB
   devices (so a moved microphone shows up), and scheduled tasks, and can never run commands. **M**
3. Scheduled tasks and timers, read only, per SCHEDULED_JOBS.md (already designed). **S**
4. Quirks and decisions attached to systems, imported from approved memory. **S**

## Phase 2: the change timeline (M)

What the owner sees: a **Timeline** page, and on every system "what changed recently". Each entry
says who or what made the change (Hearth, the owner, another AI session, a package
update), with a link to the backup and an Undo button where Hearth holds one.

What the agent gets: a `what_changed` tool ("since it last worked", "since 7 PM").

Steps:

1. One timeline that merges plan results and the journal (both exist). **S**
2. Detecting changes made outside Hearth: the map's facts are compared on each refresh
   (container image changed, compose file edited, package upgraded, device moved), and each
   difference becomes a timeline entry. **M**
3. Undo for entries that have a backup, as a plan the owner approves. **S**

## Phase 3: resource awareness and long jobs (M)

What the owner sees: live CPU, GPU, memory, and disk for every machine on the Map, and a **Jobs**
panel: "Voice training, 62%, finishes about 11:40, GPU free by 7 PM". A phone notification when a
job finishes, stalls, or is about to run into a reservation.

What the agent gets: before starting anything heavy it checks the machine's load and the owner's
reservations, and its jobs back off on their own.

Steps:

1. The scout reports GPU, CPU, memory, and disk load (needs Phase 1, step 2). **S**
2. Activity signals, opt-in and coarse: "a game is running", "a remote desktop session is open",
   "idle for 20 minutes". Names of programs only, never screen contents. Decision needed. **S**
3. Jobs declare what they use (GPU, a lot of CPU). Hearth pauses or slows them when the
   owner is using the machine, and refuses to start one that cannot finish before a reservation.
   **M**
4. The voice-training pipeline becomes the first managed job (it is the one that froze the
   owner's desktop and stalled silently on 2026-10-13). **S**

## Phase 4: safe actions (L)

What the owner sees: fewer "paste this command" moments. Plans gain new step types, each with a
preview, and a "Give admin rights for this task" button on the few that need root.

Steps:

1. **Home Assistant writes** through the credential broker: device rooms, areas, scenes, exposing
   entities to the assistants. The owner creates a Home Assistant token and adds it to the vault
   himself; the agent never sees it. **M**
2. **Preview of what will run.** For any step that runs a command or a scheduled task, the plan
   shows the exact resolved command before approval (the 2026-10-13 cloned-task mistake). **S**
3. **Disposable test copies.** A step type that tries a change on a throwaway copy first (for
   example a Home Assistant container with no network, as in the home server's backup proposal), then shows
   the result before the real change. **M**
4. **The admin helper**, designed in BUILDER.md and HOST_ADMINISTRATION.md: one task at a time,
   after the owner confirms it is them, with its own log. Needs the owner's explicit go-ahead in
   the conversation before any of it is written, because it adds a root-capable service. **L**

## Phase 5: the person (S)

The rest of the profile from need 11: skill level, goals, budget, and how much explanation they
want. Read by the agent in every conversation, editable in Settings. Needed before Phase 6, since
the builder adapts to it.

## Phase 6: building from nothing (L)

BUILDER.md owns this and its order stands. The agent-needs items slot in:

1. Onboarding plus the **check-up script** (need 8): hardware, drives, network, operating system,
   run once before anything is suggested. It is the scout from Phase 1 in a one-shot mode.
2. **Blueprints** and the install-app step (need 7).
3. **Physical steps** (need 9): checklists with an "I did it" button that the agent verifies
   through the scout ("I can see the new 4 TB drive"), and screenshots or photos as input.
4. **Teach mode** (need 10): explanations at the profile's level and a glossary that grows.
5. The builder conversation in the War Room.

## Decisions the owner needs to make (each one when its phase starts)

1. **Other machines:** install a small read-only scout on each, or read-only SSH? (Phase 1)
   Recommended: the scout.
2. **Activity signals:** may Hearth see which programs are running (names only) to know
   when you are gaming or streaming? (Phase 3)
3. **Home Assistant token:** create one and add it to the vault when Phase 4 starts.
4. **Admin helper:** the go-ahead to build and install it. (Phase 4, step 4)

## Working rules for every phase

- Branch and pull request per phase step, tests included, e2e before calling it done (CLAUDE.md).
- Approvals are never bypassed; the AI never sees secrets; Hearth never runs as root.
- Deploying to the home server follows the home server's procedure (backup, health check before and after, change
  record) and only with the owner's OK.
