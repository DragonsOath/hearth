# What the agent needs to do its job

The owner asked (2026-10-13): if you were the agent inside Hearth, what would you want in
there to make the job easier, for someone maintaining a homelab or building one from nothing with
no experience? This is the answer, written from the agent's side, and checked against what already
exists. Each item points at the design that owns it. The order of work is in
[AGENT_NEEDS_PLAN.md](AGENT_NEEDS_PLAN.md).

Status words: **exists** (built and in use), **partial** (some of it is built), **missing**.

## Lessons from one evening (2026-10-13)

Every item below is grounded in something that went wrong or took too long:

- The agent's notes said the mic was shared over VirtualHere; two days earlier it had been
  excluded on purpose. The owner got wrong instructions. (Needs 1.)
- Assigning four bulbs to rooms in Home Assistant had to be done by the owner, by hand, because
  the agent had no scoped way to call Home Assistant's API. (Needs 3.)
- A scheduled task was cloned and started without checking what it would run, and restarted an
  old training job. A preview would have shown it. (Needs 4.)
- Voice training filled the GPU and made the owner's remote desktop crawl; the job then stalled
  for 40 minutes before anyone noticed. (Needs 5 and 6.)
- Several fixes ended in "paste this command" because the agent cannot get root for one task.
  (Needs 3.)

## Maintaining a homelab

### 1. One true map of the homelab, always current (partial)

Every machine, drive, container, port, network, and proxy address, and which file controls each
one, discovered automatically and refreshed on a schedule. Next to it, the "why": decisions,
quirks, and the owner's do-not-touch list.

- Exists: container and disk discovery (`discovery/`), proxy addresses from Caddy
  (`discovery/proxy-addresses.ts`), dependencies and neighbours in the agent's context
  (REPAIR_FRAMEWORK.md, "Memory and context").
- Missing: machines other than the one Hearth runs on (GPU box, workstation), USB and
  audio routing, scheduled tasks (SCHEDULED_JOBS.md is designed, not built), and a "last checked"
  date on every fact so stale notes are visible instead of trusted.

### 2. A change history with one-click rollback (partial)

For every change: who, why, the backup, and the undo. The first question when something breaks is
"what changed since it worked?", and the answer should take seconds.

- Exists: plan steps with before/after, verification, and automatic rollback (`jobs/`); verified
  changes journaled as facts (REPAIR_FRAMEWORK.md, "Durable operational knowledge").
- Missing: one timeline that also includes changes made outside Hearth (by the owner, by
  another AI session, by package updates), and a "what changed since <time>" question the agent
  can ask directly.

### 3. Safe ways to act instead of "paste this command" (partial)

- **Scoped app APIs through the vault.** Home Assistant (areas, devices, scenes), the *arr apps,
  Docker. The agent asks the broker to make a call; it never sees the key. Exists for the app
  readers and some operations (CREDENTIAL_BROKER.md); Home Assistant writes are missing.
- **Admin rights for one task.** The owner presses "Give admin rights for this task", confirms it
  is them, and a separate helper runs that one task with its own log. Designed in BUILDER.md
  ("Tasks that need admin rights") and HOST_ADMINISTRATION.md; not installed, waiting on the
  owner's go-ahead.

### 4. A practice run before every change (partial)

Show exactly what will change, try it on a throwaway copy where possible, then apply.

- Exists: plans show their steps before approval; protected changes back up, verify, and roll
  back.
- Missing: a preview of what a command or scheduled task will actually execute, and disposable
  test copies (for example, a Home Assistant container with no network to test a restore or an
  add-on, as in the home server's HOME_ASSISTANT_BACKUP_PROPOSAL).

### 5. Awareness of resources and of the person (missing)

Know what the GPU, processor, memory, and disks are doing on every machine, and what the owner is
doing (gaming, streaming, working). Long jobs back off instead of freezing the desktop. The owner
sets "quiet hours" and "GPU free by 7 PM" once and they are honoured. Host counters exist for the
server itself (`monitor/host-counters.ts`); nothing covers other machines or the owner's activity.

### 6. Long jobs that run themselves (partial)

Training runs, large downloads, and migrations as jobs with progress, a hard stop, retries, phone
notifications, and a stall detector ("no progress in 10 minutes" is an alert, not a surprise an
hour later). Notifications exist (`notify/`); long-running job tracking does not.

## Building from nothing (beginners)

BUILDER.md owns this. What the agent most needs from it, in order:

### 7. Tested recipes, not improvisation (missing; BUILDER.md "Blueprints")

Reviewed blueprints sized to the person's hardware. The agent adapts a recipe; it does not invent
Compose files for a beginner. Predictable to build, and fixable later by anyone.

### 8. A hardware and network check-up (missing)

One script the person runs first: CPU, GPU, drives and free space, router and network, operating
system. The agent suggests nothing until it has this.

### 9. Help with physical steps (missing)

Checklists for the things only a person can do (plug in a drive, change a BIOS setting, move a
cable), each with an "I did it" button that the agent then verifies ("I can see the new 4 TB
drive"). Screenshots or photos as input, so the agent can see what the person sees.

### 10. Teach mode (missing)

Every step explained in plain English at the person's level, with a glossary that grows as they
learn, so they come to understand their own homelab instead of depending on the agent.

### 11. A profile of the person (partial)

Skill level, goals, budget, preferences, and the systems they never want touched, kept as settings
the agent reads, not scattered through old conversations. Personality and voice exist
(PERSONALITY.md); the rest is missing.

## The three to build first

1. **The live map with "last checked" dates (1).** Most wrong answers start with a stale fact.
2. **Scoped app APIs plus admin rights for one task (3).** Most "paste this command" moments end.
3. **Resource awareness and stall detection (5, 6).** Long jobs stop hurting the owner's machines
   and stop failing silently.

For a beginner, BUILDER.md's order stands: onboarding, blueprints, the install-app step, the
builder conversation, then the admin helper. The check-up script (8) belongs with onboarding.

## Rules that do not change

Approvals are never bypassed. The AI never sees secrets. Protected systems change only through
protected plans. Hearth never runs as root. Plain English, no em-dashes.
