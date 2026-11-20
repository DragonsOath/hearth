# Ember: personality

The owner's direction (2026-10-09): a knowledgeable friend who loves homelabbing, but who knows when to
stop talking and get to work. Warm, curious, occasionally witty, technically sharp, honest. Never
confuses enthusiasm with authorization.

## How it is built

It lives in the orchestration, not in a rewrite of answers afterwards
(`apps/server/src/cave/personality.ts`). Every system prompt is composed in layers:

1. **Who it is**: the identity, plus the personality text built from the owner's settings
   (enthusiasm calm/warm/lively, humor none/light/playful, technical detail
   simple/balanced/deep; default warm, light, balanced). The personality text contains nothing about
   permissions.
2. **How the owner likes to talk**: approved "How you work" memories carrying the
   conversation-style link (`cave/style.ts`). Style only, kept out of the gathered facts and never
   cited as facts about the homelab.
3. **What it can do**: jurisdiction, context rules, plan operations, protected infrastructure.
4. **What this message is**: read on the server from the owner's words and the conversation
   (`intentOf`): chat, brainstorm, build, fix, question, or affirm. Each has its own guidance
   (brief for chat; explore without planning for brainstorming; collaborative planning for build;
   focused, memory/dependency/diagnostics-first for fix).
5. **The rules** (`CAVE_RULES`), last and identical for every personality and every intent:
   enthusiasm is never authorization, only the Approve button on an exact plan approves; never
   claim an operation worked unless confirmed; never claim to remember what is not in the records;
   live vs history vs unreviewed kept apart; autonomy, jurisdiction, and approvals enforced; no
   secrets.

Incident runs use the same personality and rules.

## Enforced, not just suggested

- In **chat** and **brainstorm** the server marks the run quiet: `propose_job` and
  `restart_service` refuse ("Not now: the owner is exploring an idea...") whatever the AI tries.
  Chat also gets a smaller turn limit (3 instead of 8).
- A bare **"yes"** (`affirm`) carries on what was being discussed: after brainstorming it is still
  brainstorming (nothing planned); after a build or fix it may lead to a proposed plan. It never
  approves anything: approvals only happen through the plan's own Approve control, and nothing in
  a conversation calls the approval path.
- "That would be cool" is brainstorming; "Let's build it" moves to planning, which still produces
  plans that wait for approval.

## Preferences

When the owner says how they like it to talk, the AI can call `suggest_preference`. That creates
a pending draft in Memory > Review (kind "How you work", basis "You said", with the
conversation-style link). It is used only after the owner accepts it. Pending imports are never
approved by this.

## Settings

Settings > Ember: personality (`GET/PUT /api/agent/personality`, session only, audited).
The section says plainly that it changes how Ember talks, not what it may do.

## Tests

`cave/personality.test.ts` (classification of casual talk, brainstorming, build, fix, questions,
and bare agreement; the rules are independent of all 27 personality combinations) and the
"personality" tests in `app.test.ts` (brainstorming refuses plans and restarts server-side, "yes"
after brainstorming plans nothing, "let's build it" plans for approval, "yes do it!" leaves a plan
awaiting approval, urgent troubleshooting gets the focused mode, preferences are only suggested and
used once accepted, the rules block is identical across settings).
