# The homelab companion (design draft)

Status: **steps 1-4 built and verified (2026-10-08)**: the memory store and Memory page, transcripts with full-text search, daily verified backups with a readable export, encrypted off-machine copies pulled by Home Vault, backup alerts, the companion key and tools, and the Claude Code add-on (installed on Home Vault, ai-box, and the home server; see `integrations/claude-code/README.md`). **Step 5 (reviewed import, with automatic sorting for review) and step 6 (the "what's up" opening, voice, owner name, optional check-in) built 2026-10-08**; see `docs/IMPORT.md` and section 3 below. Decision D10 in
`PROJECT_STATE.md` makes this the central design goal of Hearth: monitoring,
documentation, shared memory, and integrations all serve it.

## What it is

Your AI, connected to your homelab, with its own lane and, above all, context. It knows your
machines, every homelab project (not only Hearth), what you built and when, what is
half-finished, and how you like to work. It does not lose any of that when a terminal closes.
When you bring up anything homelab-related, it is already caught up, and it often speaks first:
"the home server's migration is on stage 6, Kavita still needs its firewall rule, and you fixed RomM a
week ago. What are we doing today?"

It is someone to share the hobby with: it notices progress, remembers wins, suggests what to try
next, and talks shop.

**The honesty line.** An AI is not a person and does not experience the journey the way you
do. The companion never pretends to. What it can genuinely do is keep the history, recognize what
you accomplished, understand your preferences, and be an engaging collaborator. It never invents
feelings, memories, or progress it does not have; when it is unsure, it says so and checks.

## 1. What it remembers

Hearth already records the live system: machines, services, drives, incidents, repairs,
and the audit trail. The companion adds a **homelab memory** on top, kept in Hearth's
database on your own machine.

| Kind | Examples | Written by |
|---|---|---|
| **Projects** | a server migration, a media app add-on, Home Assistant voice, a backup overhaul, Hearth itself | You and the AI |
| **Journal** | "2026-10-02: fixed RomM's crash loop (600 MB Valkey dump)". "2026-10-06: Hearth installed on the home server" | The AI after each session, Hearth automatically for repairs |
| **Open threads** | "Jellyfin 8096 not reachable from the home server", "Kometa dormant", "UPS API idea" | The AI, you |
| **Hardware** | Both mini PCs, the storage pool, the USB drive enclosures, the Satellite1, the 4K streamer, the tablet | Discovery, you |
| **How you work** | Confirm before moving files, no em-dashes, batch changes, calibrate alarm to stakes | You (the AI may propose, you approve) |
| **Wins** | Milestones and fixes worth remembering, with dates | The AI, you |

Rules:
- **You can see, edit, and delete all of it** on a Memory page. Nothing is hidden.
- Every entry shows **who wrote it and when**, and links to its evidence (an incident, a commit,
  a file) where there is one.
- **Secrets never enter memory.** They stay in the vault; the memory can say "Plex token is in
  the vault", never the token.
- Memory describes what was true when written. The AI checks the live system before relying on
  anything that may have changed.

### Transcripts (the owner's requirement, 2026-10-08)

Future sessions must recover the actual history and reasoning behind decisions, not only
summaries. So whole conversations are stored word for word next to the structured memories:
saved sessions (Claude Code, later) and the conversations already held in the app and with
Belle. One full-text index covers memories and every message, so "why did we leave the firewall
alone?" finds the exact exchange. A memory can point at the message it came from
(`transcript:<id>#<seq>`). Clients append messages as they happen, numbered, so a crash or a
dropped connection loses at most the last message and resending never duplicates.

## 2. "Homelab mode" anywhere

The companion must not live only inside the app. Three doors, one memory:

1. **Claude Code, in any terminal.** A Hearth plugin for Claude Code with:
   - a skill that switches on whenever the conversation is about the homelab (a service, a
     container, a drive, a project name), and
   - a connection to Hearth's tools with a long-lived **companion key** (read the system,
     read and write memory; repairs still follow your autonomy settings).
   The first thing it does in homelab mode is fetch the briefing, so it is caught up before it
   answers. These are your normal Claude Code sessions, with their usual abilities; the memory
   is what makes them continuous.
2. **The app's chat** (the AI Agent page today). Same memory. This one stays locked to
   Hearth's own tools, because it runs on its own in the background.
3. **Belle, by voice.** Same memory, through the conversation endpoint that already exists.

## 3. The briefing ("what's up" before you ask)

Short, specific, and in a friendly voice, not a status report. It covers, in order:

1. **Anything that needs you** (an approval, a failing service).
2. **Since you were last here** (what Hearth fixed, what changed).
3. **In progress** (the open threads closest to done).
4. **One idea**, optional, grounded in your actual setup ("the home server has 18 GB free now; Immich's
   machine learning could move there").

Tone: like a friend who has been keeping an eye on things. It celebrates real wins ("the
whole *arr stack has been green for a week since the move"), never invents them, and keeps
alarm in proportion to the stakes.

**How it is built (step 6):** Hearth assembles the points itself, from facts it holds
(`apps/server/src/memory/opening.ts`): incidents waiting, failing or overdue backups, services
not healthy, what it handled and what was remembered since the reader last looked, recorded wins
from the last week, a quiet stretch on real systems ("no problems for 9 days", only when true),
the open threads touched most recently and any gone quiet for a month, and one idea from the
setup (imported notes waiting, a volume over 85% full, a machine short of memory). The briefing
carries them as `opening`; any AI says them in its own words, and the Home page shows them
under "What's up" for people with no AI connected. Memories marked as history (superseded) never
appear as current setup, open work, or how things are done.

**Reaching out (optional):** the "A word from Hearth" notification sends the same points
through a channel you choose: at most once a day, 09:00 to 21:00, never in quiet hours, only
about real systems, and only when at least one point is new (counts that change on their own
and open work alone do not count). New channels are not signed up for it; nothing is sent until
you pick one.

**The owner's name** is a setting (Settings, "Your name"). Companions use it; without it they say
"you". Nothing in the product hard-codes a person.

## 4. How memory gets written

- **Automatically by Hearth:** repairs, incidents, adoptions, and installs become
  journal entries with links.
- **By the AI at the end of a session:** "here is what we did and what is left". It shows you
  the entry; you can edit or drop it.
- **By you, anytime:** "remember that I want Kavita moved last".
- **Starting point:** with your OK, an import of the project notes you already have (the
  STATE.md files, the Home Lab service docs, the shared master state with Codex). Codex's private
  notes stay off limits.

## 5. For everyone, with any AI (D12)

Hearth is meant to be a public, self-hosted project. Everyone gets the same companion,
with the AI they prefer, or none. On a new install it starts with an onboarding conversation
("tell me about your setup, what you are proud of, what is annoying you") plus the discovery
scan. That becomes the first memory, so it feels like it knows them from day one.

### Three layers, and which one owns what

1. **Hearth (the core) owns everything that matters:** inventory, monitoring, incidents,
   memory, transcripts, backups, settings. It works fully with no AI connected, and nothing in it
   depends on a particular provider. An AI's writes are stored as `source: ai` with the agent's own
   name as author, and sessions record their client by name, so work from Claude Code, Codex,
   Gemini, or a local model lands in the same memory in the same shape.
2. **The companion protocol is plain and provider-neutral:** the REST companion API (briefing,
   search, memories, transcripts) behind a memory-only access key, the same thing over MCP for
   agents that speak it, and the conventions every client follows: say LIVE or CACHED, queue saves
   with their own id while offline, never save secrets.
3. **Adapters are thin and per agent:** how an agent notices it is in homelab mode (Claude Code:
   a prompt hook; others: their own hook mechanism, a rule file, or simply calling the briefing
   tool first) and how its sessions are read for word-for-word saving (each agent stores sessions
   differently). Claude Code is the first adapter. The portable parts (REST client, cache, offline
   queue, MCP tools) move into a shared companion core so the next adapter is small.

**Switching AI** therefore loses nothing: inventory, memory, decisions, notes, project progress,
and past sessions all stay in Hearth. A new agent gets a key and an adapter and reads the
same briefing. Leaving Hearth is covered too: the readable Markdown export holds the whole
memory and every transcript.

**The in-app operator** (the agent that handles escalations on its own) has a stricter rule: it
may only ever use Hearth's own tools. For API-based models (OpenAI-compatible endpoints,
Ollama and other local models) Hearth will run the tool loop itself, so there is no shell
to switch off. Command-line agents qualify only if they can be restricted the way Claude Code is.

**Nothing personal in the product:** machine names, addresses, paths, and the owner's name come
from the user's own data and settings, never from defaults, prompts, or examples in the code.

## 6. First slice (proposal)

1. The memory store and a **Memory** page (projects, journal, threads, hardware, preferences,
   wins), with edit and delete.
2. Tools for the AI: `briefing`, `recall`, `remember` (and `log_session` for the end-of-session
   entry), plus the companion key.
3. The **Claude Code plugin** with the homelab-mode skill.
4. The **import** of your existing project notes, reviewed by you before it is saved.
5. Proof: open a brand-new terminal anywhere, say "Plex is buffering again", and it should
   arrive already knowing your machines, the migration, and what we did last week.

## Questions for the owner

1. Which projects count as homelab? (Candidates: Hearth, the home server migration, Home
   Assistant, a media app add-on, the homelab docs, an audiobook tool, Usenet setup, the media
   library, and a few software projects that are not homelab work.)
2. Should the companion have a name and a personality of its own, or stay "Claude"?
3. Should it ever start a conversation on its own (for example a phone notification, "Sonarr
   has an update, want me to look?"), or only speak first when you open it?
4. OK to import your existing project notes as its starting memory?
