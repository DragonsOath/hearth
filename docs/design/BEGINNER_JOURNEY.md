# The beginner journey: a design proposal

**Status:** proposal for the owner's review (2026-10-15). Nothing here is approved to build,
merge, or deploy. It answers the owner's brief, `docs/design/NEW_USER_EXPERIENCE.md`, and builds
on `docs/design/BUILDER.md`. The experienced path ("I already have a homelab") stays exactly as it
is; everything here is additive.

Words used carefully throughout: **built** (code exists and its tests pass), **proposed** (designed
here, not built), **verified** (checked working on a real machine).

## The rule for every step (owner, 2026-10-15)

*"The point is we give them options and we explain them and we inform them about any decision
that are going to make."* Wherever there is a real choice (which agent, which media app, Windows
or Linux, free or paid VPN, Docker or the app's own installer), Hearth lays out the
options, explains each in plain words with its cost and tradeoffs, recommends one for this person
and this machine, and lets them decide. Every decision that changes their computer or costs money
is announced before it happens. A recommendation is never a decision made for them.

## 1. What exists, and the real gaps

| Need in the brief | What exists today | Gap |
| --- | --- | --- |
| Welcome and choose a path | Welcome wizard (#6, merged). Branch `beginner-feedback` adds "Help me build one / I already run things" on its last screen | The choice should come first, before the companion steps, for a beginner |
| Create your AI companion | Five identities, 25 looks, own picture, name, theme (#6 to #8, merged). Branch adds looks that suit the voice | Short character introductions instead of style lines; pause and resume |
| Voices for everyone | Branch: the five voices on the `voices-v2` release (retrained clean 10-20; v1 retired), `pnpm voices check / download / start`, machine levels, ask-before-each-install wording. **Verified** on the home server's CPU | Windows and macOS speech setup not yet tried on a real machine |
| Human questionnaire | Branch: `/plan`, adapted from the dragonsoath.com intake form | Missing: experience level, budget, where the media is, "teach me" vs "build it for me", "decide for me"; must adapt more (section 3) |
| Inspect the real machine | Branch: read-only scan (OS, CPU, memory, graphics, drives, cable or Wi-Fi, Docker, what runs) of the machine Hearth runs on | Must say which machine was inspected, ask first, separate measured from estimated, count what the OS and other apps already use |
| Blueprint | Branch: plain rules give apps with what, why, needs, warnings | Must be **capabilities first** and a **starter build**; download tools must become an opt-in capability, never a default (section 5) |
| Build it with approval | Plans, approvals, verification, rollback for existing services (jobs). Credential broker and Secure Vault. Discovery and adoption | **Not built:** installing an app, the admin helper for root tasks, connecting apps to each other, a build ledger (section 6) |
| First success | Meet Ember (#10, open PR): introduction plus read-only check-up | Not built: "let's play something" with real files and a real device |
| The AI stays with them | Memory, context, to-do list, long work, Releases watch, Meet Ember | Not built: showing them around the real interface ("I'll show you") |
| Grow with them | Experienced UI exists | A per-person "how much detail" setting the AI and pages follow |

Two gaps the brief's example scenario exposes, which need the owner's decision (section 9):

- **The AI is Claude Code only.** Ember runs on Claude Code today, which needs a paid Claude plan.
  Decided 2026-10-15: any agent the person has, including free ones (section 11).
- **Hearth installs as a service on Linux only.** On Windows it runs in a terminal window
  ("trying it out"). A beginner's old laptop is most likely Windows.

## 2. The journey, screen by screen

Every screen can be left and resumed; progress lives on the server, not in the browser.

1. **Hello** (new). One sentence: *"Tell me what you'd like to build, and I'll help you build
   it."* Two big choices: **Help me build my first homelab** and **I already have a homelab**
   (today's welcome and Discover, unchanged).
2. **Meet your companion** (built; reordered). Pick an identity from five short introductions,
   each with its picture and a "hear me" button that only plays when voice really works; pick a
   look that suits it, a name, a theme. If voice is not available yet, the screen says so and the
   identity still works by text.
3. **What would you love to do?** (partly built). The questionnaire, section 3. The companion
   asks the questions in its own words, around the same answer cards.
4. **Let me look at your computer** (partly built). Asks permission first (section 4), then shows
   what it found in plain words, marked measured or estimated.
5. **Your plan** (partly built). The starter build, what it will let them do, what it costs (often
   nothing), how long it takes, what needs their approval, and "later, if you like" ideas. They can
   remove or add items and ask the companion about any of them.
6. **Let's build it** (not built). One approval for the plan as a whole, then a live list of
   steps: waiting, under way, done, failed, needs you. Anything sensitive asks again on its own
   (section 6).
7. **Your first movie** (not built). The companion opens the media app, finds their films, and
   asks them to press play on the device they care about. Success is a person watching a film, not
   a finished command.
8. **Home, with a companion** (partly built). The next day: a greeting, what happened, one small
   idea for later. "Show me" works on real pages (section 8).

## 3. The questionnaire

Short, adaptive, every question with **"I don't know"** or **"decide for me"**. It never asks for
a port, a folder path, a Docker network, or an API key.

| # | Question | Shown when | What it decides |
| --- | --- | --- | --- |
| 1 | What would you love to do? (movies and shows, music or audiobooks, photos, files, smart home, explore AI, just see what's possible) | always | the capabilities |
| 2 | How new is this to you? (brand new / a little / experienced) | always | detail level, "teach me" default |
| 3 | Keep it free, or happy to spend a little? (free / up to $5 a month / up to $15 / more) | always | Jellyfin vs Plex, VPN, paid apps |
| 4 | Do you already have movies or files? Where? (this computer / an external drive / several places / not yet) | movies, music, photos, files | reuse in place, no copying |
| 5 | Where will you enjoy it? (TV and which kind, phone, tablet, laptop) | movies, music | app choice, transcoding need |
| 6 | Only at home, or away too? | always | remote access (asked again before any change) |
| 7 | Build it for me and explain, or teach me each step? | always | pace of the build |
| 8 | How many people at once? | movies | capacity check |
| 9 | How bad would losing these files be? | photos, files | backups |

The dragonsoath.com questions not used: contact, timeline, quote budgets, and maintenance by
Home Vault (a business question, not a homelab one).

## 4. Looking at the machine

- **Which machine:** the scan runs on the machine Hearth runs on, which is the target.
  The screen says its name ("I looked at LAPTOP-7F3, the computer Hearth is running on"),
  so nobody mistakes it for the phone they are reading on. Another computer is never scanned
  without being asked, and only by address.
- **Permission first:** "Can I look at this computer's hardware, drives, and what's running? I
  won't change anything." No: they answer the hardware questions by hand instead.
- **Measured vs estimated:** total and free memory, drives, free space, Docker are measured;
  "can convert 4K for two people" is an estimate, labelled as one.
- **What is already in use:** free memory and the processor's load over a minute, not just the
  totals. A 4 GB laptop with 1.2 GB free is treated as a 1.2 GB server.
- **Drives are precious:** external drives are listed with what is on them (counts of video,
  music, photo files) so the plan can reuse them in place. Nothing is moved, renamed, or deleted.

## 5. The blueprint

Rules stay plain code (testable, same answers give the same plan); the AI explains them.

- **Capabilities first.** "Watch the movies on your drive" is a capability; Jellyfin is how.
- **Starter build first.** The smallest set that delivers the first wish, sized to the free memory
  measured. Everything else is "later, if you like", with what it would need.
- **Install method third.** Docker when the machine has room for it; the app's own installer when
  it does not (Docker Desktop alone wants about 2 GB on Windows, too much for a 4 GB laptop).
- **Download tools come with the wish that needs them** (decided 2026-10-15). When someone wants
  "request a movie and it handles the rest", qBittorrent, Prowlarr, Radarr, Sonarr and a VPN are
  part of their setup and get installed with the rest. "Watch the movies I already own" never
  includes them. Before anything installs, the plan says plainly that a **VPN that allows P2P**
  is required, and setup prompts them to link theirs (credentials straight into Secure Vault,
  through Gluetun). The AI checks providers' current terms at setup time and lays out the real
  choices: most free VPNs do not allow P2P, the few that do cap data at about 10 GB a month (one
  or two movies), and paid ones cost about $2 to $5 a month. Downloads never start without the VPN
  linked and verified. Creating the VPN account is the person's step; Hearth never signs
  up or pays for anything.
- Every item shows: what you can do with it, why it was picked, whether it fits this machine
  (comfortable / might be slow / wait), cost, disk use, what it needs from you, and which steps
  will ask for approval.

## 6. Building it: new, narrowly scoped capabilities

Proposed, in dependency order. None exists yet.

1. **Blueprints:** a recipe per app (image or installer, folders, ports, health check, first-run
   setup through the app's own API, how to verify, how to remove). Reviewed files in the repo.
2. **An "install app" plan step** for Docker apps, using the same plan, approval, verification,
   and rollback machinery as today's repairs. It creates only what a blueprint describes, records
   everything it made, and is safe to repeat (it finds what already exists).
3. **The admin helper** for the few tasks that need root or Administrator (installing Docker,
   mounting a drive, opening a firewall port): a separate small program that runs one approved
   task at a time after "Give admin rights for this task" and an it's-you check. *Needs the
   owner's explicit go-ahead before it is built, as already agreed.*
4. **Connection steps:** Jellyfin pointed at the drive, a library created and scanned, an
   account made, keys generated and put straight into Secure Vault. The AI never sees a key.
5. **A build ledger:** each step's state (waiting, under way, done, failed, needs you), so a build
   can stop and resume without duplicating anything.
6. **Verification that matters:** the app answers, the library holds their real files, a test
   stream plays. A command that exits cleanly is not proof.

Always asked separately, never part of a blanket approval: anything that costs money or creates an
outside account, accepting terms, exposing anything beyond the home network, VPN, firewall,
reverse proxy, and download tools.

## 6b. Your homelab and your accounts (built in stage 1, owner's request 2026-10-15)

After "Next: your apps and accounts" (called "Make it for me" until 2026-10-17, renamed so it no longer implies building exists): every app the plan will build as a card with its logo, what it does, and
why the AI picked it. Then the account details: email, username, and passwords, either one strong
password made per app (recommended, each saved in Secure Vault as it is created) or one password
The owner chooses, which goes straight into Secure Vault and is never returned, logged, or shown
to the AI. In stage 2, Hearth (not the AI) uses these to create each app's account through
the app's own API, generates its API key, and saves every login and key in Secure Vault, asking
first. Until then the screen says plainly that nothing has been installed or created.

## 7. The first success

"Your movie library is ready. Let's play something." Hearth opens Jellyfin at the right
address, shows the films it found on their drive, and offers the TV app's name for their device.
It asks them to press play and say whether it worked. If not, it checks the media app's logs and
the network through its read-only tools, explains, and proposes a fix. The milestone is recorded
in memory as theirs: *"Built a movie server on an old laptop, 2026-10-20."*

## 8. Showing them around (proposed)

New, read-only tools for the AI: **open a page**, **point at a part of it** (a registered list of
named spots: "the Radarr queue", "the backup button"), and **walk through** a few spots in order.
The page reports back that it really opened and highlighted, and the AI only says "here it is"
after that report. Pointing never presses anything; a change is still a plan. A "how much detail"
setting (new / comfortable / expert) shapes both the AI's explanations and how much each page
shows, and changes whenever the person likes.

## 9. Stages

| Stage | Delivers | Needs | Gate | Done when |
| --- | --- | --- | --- | --- |
| 0 (on branch `beginner-feedback`) | Voices for everyone, matching looks, honest voice messages, first plan page | nothing new | owner tries it | owner says it feels right |
| 1 (built on `beginner-feedback`, 2026-10-15) | Hello screen, reordered companion steps, the adaptive questionnaire, permissioned scan, capability-first starter plan | none (read only) | owner review of screens | a stranger completes it in under 10 minutes without help |
| 2 | Blueprints plus "install app" for Jellyfin, Audiobookshelf, Immich on Linux with Docker; build ledger; first-playback check | Docker access (already used today) | owner approves the install step's design | fresh Linux box: questionnaire to a playing film with only approvals |
| 3 | Admin helper (Docker install, drive mount) | owner's explicit go-ahead | security review, owner approval | same, on a machine without Docker |
| 4 | Windows path (service install, native Jellyfin) | decision below | owner decision | the 4 GB laptop scenario works end to end |
| 5 | "Show me" tools and detail levels | stage 1 | owner review | "What does Radarr do?" answered on the real page |

Each stage keeps the experienced path's tests passing, adds its own, and is verified on a real
machine before it is called done.

**Decisions for the owner:**

1. ~~Ember for people with no budget.~~ **Decided 2026-10-15:** any agent they want, including a
   free LLM. Some agent is required; the experience differs by agent, and Hearth says how.
   See section 11.
2. ~~Windows.~~ **Decided 2026-10-15:** both. Hearth gets a proper Windows install (runs
   in the background, starts with the computer), and the plan explains the choice honestly:
   Windows works and keeps their familiar computer; Linux is steadier for a machine that stays on
   day and night and leaves more memory for the apps. The person picks.
3. ~~Download tools for beginners.~~ **Decided 2026-10-15:** part of the setup when the person's
   wishes need them, with a required P2P VPN they are prompted to link (section 5).

## 10. Walkthrough: a 4 GB laptop, an external drive, 100 GB of films, no budget

What it would look like with stages 1 to 4 built. *Not possible today:* today it stops after the
plan.

1. A friend sends the README. They paste the prompt into the AI assistant they already use. It
   asks a few questions, shows each command, and **asks before** installing Node and pnpm.
   *(Today: works on Linux; Windows runs in a terminal window.)*
2. **Hello:** "Help me build my first homelab". They pick the Companion robot, call it Bolt, pick
   a theme. Voice check: 4 GB, about 1.2 GB free: "Bolt can talk by text for now; voice needs a
   bit more memory. We can try it later." No pretending.
3. **Questions:** movies; brand new; free; "on an external drive"; Roku TV and phone; just at
   home; "build it for me and explain".
4. **Permission:** "Can I look at this laptop? I won't change anything." Yes. Found: Windows 10,
   4 cores, 4 GB (1.2 GB free), Intel graphics (Quick Sync, measured), drive E: with 412 films
   (100 GB), Wi-Fi, no Docker.
5. **Plan:** one item, **Jellyfin**, installed with its own Windows installer, because Docker
   would need more memory than this laptop has free. Free; about 300 MB of memory; reads the films
   where they are on E:, nothing copied or moved. "Might be slow" if two people watch at once.
   Later, if you like: audiobooks, phone photos (needs more memory), voice.
6. **Approval:** one approval for the plan. Then separately: "Installing Jellyfin needs
   Administrator rights once. Approve?" (admin helper, its own it's-you check). An account for
   them is generated straight into Secure Vault.
7. **Build:** download, install, library pointed at `E:\Movies`, scan: "412 films found."
8. **First success:** "Let's play something on your Roku: add the Jellyfin channel, sign in, pick
   a film." It plays. Recorded as their first milestone.
9. **Next day:** "Morning. Your library has 412 films and Jellyfin has been healthy all night.
   Want to see how to add posters and trailers? Or not today." *(Stage 5 for "show me".)*

## 11. Any agent the person has (decided 2026-10-15)

The owner's decision: *"They should be able to use any agent that they want ... it requires some
sort of agent even if it's a free LLM ... they're going to get different experiences based on the
one they have ... but it should be built for anyone."*

What already makes this possible (built): Ember's abilities are Hearth's own tools, served
over MCP with a short-lived key per run, and every rule (approvals, jurisdiction, the vault, plan
checks) is enforced by the server, not by the AI. A weaker model can do less, but never more.
Today there is one adapter: Claude Code (`apps/server/src/agent/providers.ts`).

**Built (2026-10-17): Connect your AI.** The welcome's first step after the account, and the
AI Agent page's not-connected panel, are one component (`components/onboarding/ConnectAi.tsx`)
fed by the server's agent catalog: only an option the server can connect is offered as working.
Its connection test (`POST /api/agent/providers/:id/test`) checks three things separately:
installed, signed in and answering, and Ember able to read Hearth's overview through its own
tools. A new adapter appears there with no new screen; its words go in `SERVICE_WORDS`.

Proposed adapters:

| Kind | Examples | How it connects | Cost to the person |
| --- | --- | --- | --- |
| Agent programs with MCP | Claude Code (built), Codex CLI, Gemini CLI | Hearth starts the program with only its own tools; the program's own shell and file tools must be switched off, and a program that cannot switch them off is not offered | their existing plan or free tier |
| Chat APIs with tool calling | OpenAI-compatible endpoints: Ollama and LM Studio (local), OpenRouter, Gemini, OpenAI | Hearth runs the tool loop itself and calls its own tools; the key goes in Secure Vault through the broker | free (local or free tiers) to paid |

**What to expect, said plainly.** On connecting, Hearth runs a short read-only self-test
(call a tool, answer from what it returned, refuse a change in chat mode) and shows a level:

- **Full:** investigates, plans repairs, builds with approval, explains well.
- **Basic:** answers and explains from Hearth's data; multi-step plans may need more help.
- **Chat only:** talks, but cannot use tools reliably; Hearth's pages still do everything.

The installer and the welcome ask which agent they have (or offer free choices), and the beginner
plan accounts for it: a 4 GB laptop can run a small local model only slowly, so a free cloud tier
is usually the better start there, said with its privacy tradeoff.

**Stage:** adapters become their own stage after stage 1 (they do not block the questionnaire or
plan), starting with an OpenAI-compatible adapter, since it covers free local models and most
free cloud tiers at once.



## 12. Keeping every wish: the plan in three groups (issue #16, built 2026-10-16)

The owner's rule: a customer's stated requirement must never silently disappear from the plan.
The planner behaves like a consultant: it plans the best it can on this computer, and says
plainly what it left out, why, and what it would take. Built in four steps, each its own pull
request (#17, #18, #19, and the step 4 PR), none merged or deployed at the time of writing.

**The record (step 1).** `recommendBuild` returns `requirements`: one per goal they state (each
wish, away from home, keeping files safe, 4K, several viewers, an existing media server or VPN,
a free budget), with their words, whether it was theirs or a suggestion for someone exploring,
a status (included, partial, substituted, deferred, infeasible, declined), the reason, and the
apps that deliver it. A test sweeps thousands of plans to prove no wish is ever lost.

**Priorities and the computer as it really is (step 2).** They rank what matters most; the plan
fills in that order (the media server always ahead of the download tools). Memory is planned
three ways, and the plan says which it used:

- *Only a server:* all the memory less the system (an estimate), and a spare.
- *Used every day (the default when unsure):* today's free memory is never taken as always
  there. The plan counts on the lesser of what is free now (measured) and the memory left after
  the system and everyday use at its busiest (a quarter of it, at least 1 GB: an estimate), and
  keeps a spare (a tenth, at least 0.5 GB) on top.
- *Not looked at:* worked out from their answer, and said to be.

Processor (heavy apps on fewer than 4 cores), graphics (AI without an NVIDIA or Apple GPU), and
disk (apps that need room for themselves) are checked too, each with its reason on the app.
Every allowance is a working assumption, labelled as one, until it is measured (section 13).
A media server they already run (here or elsewhere) is used as it is: no rule makes them install
a local one, and their ranking stands.

**Dependencies (step 3).** Each app records what it needs. "Leave this out" first says what
would stop working, what only gets harder (Prowlarr: Radarr and Sonarr still work, with their
download sources added by hand), what goals change, and the memory freed, promised as useful
only when something waiting really fits in it. Waiting goals offer realistic other ways.

**The three groups (step 4).** The plan screen shows:

1. *Included in your plan:* each goal with its status (included, partly with the trade-off
   named, included anyway), then the apps that get set up.
2. *Requested but not included:* every goal they asked for that isn't in the starter, waiting on
   their decision, with why, what went first, other ways to get it, and their choices:
   *Include it anyway* (only when it waits for comfortable memory; never past more memory than
   the computer has, Docker that can't run, or a full disk), *Save for later*, or, for a
   substitute, *That's fine*.
3. *Saved for later:* what they saved, what they left out, and suggestions they didn't ask for.

"Include it anyway" shows the risks for this computer and plan first (the memory needed against
what's comfortable, what shares it, what else would change) and records the acknowledgment in
the change history. It changes the plan only: every install, account, and network change keeps
its own approval. Decisions are saved with the plan (the server dates them), and everything is
replanned from the saved answers, choices, left-out apps, and decisions each time, so undoing a
decision leaves nothing stale. Ember's context carries every goal, its rank, its status, their
decision, and the other ways, and is told never to imply an unmet wish was dropped.

**Not built yet (tracked in #16):** step 5, reassessing when the computer changes (more memory, a
new graphics card) and saying what became possible, never installing on its own; step 6, wishes
in their own words, mapped by Ember to the catalog or kept as "not in the catalog yet".


## 13. Checking the planning assumptions on real computers (owner's request, 2026-10-16)

The planner's memory allowances are working assumptions, reasoned rather than measured. They
live in one place, `PLANNING_ASSUMPTIONS` in `packages/core/src/build-plan.ts` (marked
`status: "provisional"`), and every plan says they are estimates. Until they are checked as
below, no plan presents them as guarantees.

| Assumption | Value now | How it is checked |
| --- | --- | --- |
| System use: Linux / Windows and macOS / not looked at | 1 / 3 / 2 GB | Memory in use at idle after a fresh boot, with nothing else open, read three times a day for a week on each test computer. |
| Everyday use at its busiest, on a computer also used for other things | a quarter of the memory, at least 1 GB | On a daily-use computer, the highest memory in use (without the homelab apps) over a normal week, sampled every few minutes. |
| Spare kept for busy moments and updates | a tenth, at least 0.5 GB | Whether the starter build ever swaps or slows when everything is busy at once (a film converting, a photo import, a request downloading). |
| Each app's memory (`memoryGb` in the catalog) | per app | Resource history (Settings > Monitoring) records each container's average and peak per hour; the catalog value should sit near the busy-hour average, below the peak. |
| Docker's own memory (Docker Desktop / Linux engine) | 2 / 0.2 GB | Memory in use with Docker running and no containers, against Docker stopped. |
| Heavy apps on fewer than 4 cores | "possible with trade-offs" | Time for Immich to index 1,000 photos and for Ollama to answer with a small model, on a 2-core and a 4-core machine. |

**Test computers:** The home server (Linux server, 8 cores), Home Vault (Windows, used daily), and a
small 4 to 8 GB machine or virtual machine standing in for a beginner's old laptop. A plan is made
on each, the starter is built (stage 2), and a week of resource history is compared with what the
plan said.

**When a value changes:** update `PLANNING_ASSUMPTIONS`, note the measurement and date in this
table, and the tests that pin exact figures are updated in the same change. When all rows have
been measured on at least two computers, the status becomes `"measured"` and the plan's wording
says so.
