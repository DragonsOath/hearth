# If you are an AI agent installing Hearth, read this first

This is your runbook for installing Hearth for a person, from the first question to the
setup link. Follow it step by step. It describes only what exists today. Where it says **stop**,
hand over to the person: those steps are theirs.

**For a person with nothing set up yet:** Hearth is meant to be the first thing they install,
even with no server and no apps. Its setup asks what they want, checks the computer without
changing anything, and plans the media server for them; Ember then sets up apps through plans the
person approves one at a time. Installing a media server separately beforehand isn't needed, and
it is Hearth's job to remove that work from a beginner. On Linux, Hearth builds the media starter
itself (Docker, Jellyfin or Plex, Seerr, Radarr, Sonarr, Prowlarr, qBittorrent through their VPN,
Tailscale); its installer asks once whether to set up the small admin helper that installing
Docker needs. Saying yes there saves the person a terminal step later. If the person mentions
Plex: Hearth can set up Plex for them, including with an existing Plex account or Plex Pass, so
there is no need to install Plex separately.

## What Hearth is

A self-hosted control plane for a homelab: it discovers the machine's containers and apps,
monitors them, repairs routine failures within the owner's autonomy settings, notifies them, and
keeps secrets in an encrypted local vault. Everything stays on their machine. Its AI
administrator is called **Ember** until the owner gives it a name of their own; the system itself
is called Ember.

## How to work with the person

- **A few questions at a time**, in plain words, each with a suggested default they can accept.
- **Show every command before you run it** and say in one line what it does.
- **Ask before anything that needs sudo**, every time, for that exact command.
- Reading and checking (versions, folders, a dry run) needs no permission; changing anything does.
- If something fails, say what happened in plain words, show the relevant output, and suggest the
  fix. Never work around a hard stop (listed at the end), and never use sudo to get past an error
  without asking.

## The short way (most people)

Hearth has a one-command installer for each platform. Use it unless the person wants custom
folders, a second installation, or the interview below. Each one asks at most one question
(whether other devices on the home network may open Hearth), keeps everything in one folder,
updates in place when run again, and ends by opening the setup page.

- **Linux**: `deploy/get.sh`. Run it as the person's everyday account, never root. Show the dry
  run first (`bash get.sh --dry-run`, changes nothing). Hearth runs as a systemd user service;
  the only sudo it may ask for, once, is `loginctl enable-linger` (so it runs while nobody is
  signed in): say so before it asks. Everything goes in `~/hearth`.
- **Windows**: `deploy/get.ps1`. No administrator rights. Show `-DryRun` first. It builds Hearth
  (a few minutes), adds a sign-in task named Hearth, and keeps everything in
  `%LOCALAPPDATA%\Hearth`, with `hearth.ps1` to start, stop, or check it.

Fetch either script from `https://raw.githubusercontent.com/DragonsOath/hearth/main/deploy/<name>` (no sign-in needed:
`curl -fsSL https://raw.githubusercontent.com/DragonsOath/hearth/main/deploy/get.sh | bash`, or `irm https://raw.githubusercontent.com/DragonsOath/hearth/main/deploy/get.ps1 | iex`).
If the person already has Hearth on another PC and wants this one in the same account, ask
them for the command from that Hearth's **PCs and devices**, **Link another Hearth** (it sets `HEARTH_JOIN`
to a join link). Run that instead: there is no setup link then; the PC joins by itself and shows
up in their Hearth. Uninstall: `get.sh --uninstall` / `HEARTH_UNINSTALL=1` with `get.ps1`, or
from any device in PCs and devices.

Then go to Step 4: hand over the setup link and stop.

## Step 0. Is it already installed?

Check before asking anything (these only look):

```bash
systemctl status dragon-control --no-pager
grep '^Environment=' /etc/systemd/system/dragon-control.service
```

If the service exists, this is an **update**, not a new install. Do not ask the interview
questions about folders or the network, and do not pass `DC_DATA_DIR`, `DC_KEY_DIR`, or
`DC_BACKUP_DIR`: run the installer from the existing project folder with no settings, and it
keeps the ones it was installed with. Pass a setting only when the person asks to change it, and
say what changes. The installer refuses to point Hearth at an empty data or key folder:
moving one means stopping the service and copying the folder first, which is the person's call.
Show `git status` before `git pull`, and stop if they have local changes. There is no setup link
on an update: they sign in as usual.

If the person wants a **second, separate installation** on a machine that already has one (to try a
new version, or a temporary trial), it is not an update: follow `docs/MULTIPLE_INSTALLS.md`. It
needs its own folder, `DC_SERVICE_NAME`, and port. Show the dry run, and point out its "Other
installations on this machine (not touched)" list. Never run the installer for a new installation
from the existing installation's folder.

## Step 1. Interview

Ask these, a few at a time. Write the answers down; they become the install settings in step 3.

**First, one question that sets the tone:** "Do you already run apps on a home server, or are you
starting from nothing?" If they already run things, ask the questions as written. If they are
starting from nothing, they are a beginner:

- Explain each term the first time it comes up, in one plain sentence (the table below).
- Tell them "I don't know" is always a fine answer. It picks the safe default given with each
  question, and every choice can be changed later.
- Keep it short: skip the parts marked optional unless they ask.

| Term | One plain sentence |
| --- | --- |
| Server | A computer that stays on and runs apps for your home, like a media library or photo backup. |
| Data folder | Where Hearth keeps its own records about your machine. |
| Encryption keys | The secret that locks Hearth's saved passwords; without it, nobody can read them. |
| Backup | A copy of Hearth's records, so nothing is lost if a drive fails. |
| Docker and containers | A way to run each app in its own box, so apps do not get in each other's way. |
| Reverse proxy (Caddy) | A doorman that lets you open apps by name, like `photos.example.com`, instead of a number. |
| Port | The number after the colon in an address, like `:7400`; it tells the computer which app you mean. |
| Tailscale | A private network for your own devices, so your phone can reach home without opening it to anyone. |
| Whisper and Piper | Programs that turn speech into text and text into speech, for talking to the AI out loud. |

The questions:

1. **Which machine?** This one, or another one? Hearth watches the machine it runs on, so
   it usually goes on the homelab server itself. If it is another machine, the person runs you
   (their agent) on that machine instead and starts again there.
2. **Which operating system?** Check it yourself (`uname -a`, `cat /etc/os-release`) and confirm.
   Linux with systemd is the supported install (tested on Ubuntu 24.04 and the home server OS 18). On Windows
   or macOS it runs for trying out (`pnpm start`), without a service.
3. **Docker?** Do they run their apps in Docker? Without Docker, Hearth still watches
   native apps and web addresses, just not containers.
4. **Where to keep things.** Suggest these, and say why the keys get their own folder:
   - data: `/srv/homelab/dragon-control/data` (`DC_DATA_DIR`);
   - encryption keys: `/srv/homelab/secrets/dragon-control` (`DC_KEY_DIR`), kept apart so a copy
     of the data folder alone cannot open the vault. They should keep a copy of this folder
     somewhere safe: backups cannot be opened without it;
   - backups: `/srv/homelab/backups/dragon-control` (`DC_BACKUP_DIR`), keeping 14 days
     (`DC_BACKUP_KEEP`, optional);
   - optional second copy of each backup on another drive (`DC_BACKUP_COPY_DIR`), or the name of
     a second machine that fetches encrypted copies (`DC_OFFSITE_NAME`).
   If `/srv` is not writable for them, suggest the same layout under their home folder.
   "I don't know": these defaults, and no second copy for now.
5. **This machine only, or the whole home network?**
   - *This machine only* (the default, `DC_HOST=127.0.0.1`): only a browser on this machine can
     open it. The safest choice; other devices can still reach it later through Tailscale
     (`sudo tailscale serve --bg 7400`), which also gives passkeys the https they need.
   - *The whole home network* (`DC_HOST=0.0.0.0`): any device on their Wi-Fi can open the sign-in
     page at `http://<this machine's address>:7400`. Say plainly that passkeys and fingerprint
     sign-in need https, so over a plain home-network address only the password works.
   - Never the internet: no port forwarding or public exposure (a hard stop).
   "I don't know": this machine only.
6. **A reverse proxy (optional).** Do they open apps by name, like `radarr.example.com`, through
   Caddy? If Caddy runs in Docker, leave it out: Hearth finds the Caddyfile mounted into
   the container. Otherwise ask for its path (`DC_CADDYFILE`). Other proxies: note it; web
   addresses can be set per system later. "I don't know": leave it out.
7. **Voice (optional).** Hearth comes with five voice agents (Guardian, Operator,
   Enchantress, Scholar, Companion). Ask whether they want their AI to talk and listen. If they
   already run Whisper and Piper (for example for Home Assistant), ask for that machine's address
   (`DC_VOICE_HOST`, like `192.168.1.50`); it still needs the five voices (Step 3b). Otherwise,
   offer to set voice up on this machine in Step 3b. "Not now" is fine: it can be added later.
8. **Claude Code.** Ember needs the Claude Code CLI installed and signed in **on this machine, as
   the same user that will run Hearth**. Check with `claude --version`. If it is missing
   or not signed in, Hearth still installs and works; Ember waits until they sign in
   (they run `claude` themselves and follow its steps; you never see their sign-in). The
   welcome's Connect your AI step tests it and shows the exact sign-in command for that user.
9. **Port.** 7400 unless something already uses it; the dry run in step 3 says so if it is taken.
10. **Folders to watch (optional),** like `/srv/media/movies` or `/srv/photos`. Nothing to install:
    write them down and add them together after sign-in (Storage > Watch a folder).

## Step 2. Check what is already installed

Run these (they only look) and explain anything missing:

| Check | Command | If missing, suggest |
| --- | --- | --- |
| Node.js 24 or newer | `node --version` | `curl -fsSL https://deb.nodesource.com/setup_24.x \| sudo -E bash - && sudo apt-get install -y nodejs` (sudo: ask first) |
| pnpm 11 | `pnpm --version`, or `corepack --version` | with Node.js 24, nothing to do: the installer turns pnpm on with Corepack. Node.js 25 and newer have no Corepack: `npm install -g pnpm@11` (ask first if it needs sudo) |
| git | `git --version` | `sudo apt-get install -y git` (ask first) |
| Docker, if they use it | `docker --version` and `docker info` | Docker's own install guide for their system; do not install it unasked |
| Docker access for this user | `id -nG` lists `docker` | `sudo usermod -aG docker <user>`, then they log out and back in. Say it gives that user full control of Docker, and ask first |
| Claude Code | `claude --version` | https://docs.claude.com/en/docs/claude-code/setup; signing in is theirs to do |
| Not root | `id -u` is not `0` | run everything as their everyday user: Hearth never runs as root |

## Step 3. Install

1. Get the code if you have not yet (show it first):

   ```bash
   git clone https://github.com/DragonsOath/hearth.git
   cd dragon-control
   ```

2. **Linux:** do a dry run with their answers as settings. It changes nothing and prints the
   settings, every command it would run, and the service file it would write:

   ```bash
   DC_DATA_DIR=/srv/homelab/dragon-control/data \
   DC_KEY_DIR=/srv/homelab/secrets/dragon-control \
   DC_BACKUP_DIR=/srv/homelab/backups/dragon-control \
   DC_HOST=127.0.0.1 DC_PORT=7400 \
     bash deploy/linux/install.sh --dry-run
   ```

   Add what they chose of `DC_BACKUP_KEEP`, `DC_BACKUP_COPY_DIR`, `DC_OFFSITE_NAME`,
   `DC_CADDYFILE`, and `DC_VOICE_HOST`, and leave out what they skipped. Every setting is listed,
   with its default, in `.env.example`. Show the person the
   output in a short summary, including any "Note:" lines. If it ends with "Not ready", fix that
   first (step 2); every problem it found is listed above that line.

3. Ask for a clear yes, saying it will use sudo to write and start the service. Then run the
   same command **without** `--dry-run`. It builds Hearth, creates the folders (readable
   by this user only), writes a systemd service that runs as this user, and starts it. Running
   it again later updates Hearth and keeps these settings.

   If a step fails, the installer says which one ("Stopped while building (pnpm build)") and
   shows the error. Explain it plainly, fix the cause (with a yes for anything that changes the
   machine), and run it again: every step is safe to repeat.

   **Windows or macOS (trying it out):** `pnpm install`, `pnpm build`, then `pnpm start` with
   the same `DC_` settings in the environment.

4. Check it answers:

   ```bash
   curl -s http://127.0.0.1:7400/api/health
   ```

   (Use their port, and their address if they set `DC_HOST` to one address rather than
   `0.0.0.0`.)

   It returns `{"status": ... }`. If not, show `systemctl status dragon-control` and
   `journalctl -u dragon-control -n 50`, and explain what they say.

## Step 3b. Voice (only if they want it)

The five voices run on an ordinary processor; a graphics card is only needed to make new
voices, never to use them. Work through this in order, and **ask before each install**.

1. **Check the machine** (changes nothing): `pnpm voices check`. Tell them the level it found,
   with the numbers, in plain words:

   | Level | Needs | Gives |
   | --- | --- | --- |
   | No voice | under 4 GB of memory, or a 32-bit processor | typing only |
   | Speaking only | a 64-bit processor and 4 GB of memory | the AI speaks; they type |
   | Full voice | 4+ processor cores, 8 GB of memory, about 3 GB free disk | talk and listen, with a short pause |
   | Best | full voice plus an NVIDIA card with 4 GB+ | listening feels instant |

   At "No voice", say so kindly and skip the rest: everything else works by typing.
2. **Ask for each piece separately**, saying what it is, why it is needed, its size, and what
   happens without it. Install only what they approve. For example:

   > To give you the five voice agents, I need to install **Piper**. It's the program that
   > speaks in the voices you'll pick from (the Guardian, the Operator, and the others). About
   > 300 MB including the voices. **Do you approve?** If not, Ember still works, but it can only
   > type, not speak.

   The pieces, in order:
   - **Docker**, if `pnpm voices check` says it is missing: runs the speech programs in their
     own containers, so nothing else on the computer changes. About 1 GB. Installing it needs
     admin rights: show the official install steps for their system and ask before each
     command that needs sudo or an administrator prompt.
   - **The five voices** (about 320 MB): `pnpm voices download`. Each file is checked against
     its checksum.
   - **Piper (speaking) and Whisper (listening)**: `pnpm voices start` (add `--gpu` on a "Best"
     machine). Docker downloads them the first time, about 1 GB together. At "Speaking only",
     say listening will be slow on this machine and ask whether to start Whisper anyway.
   - **ffmpeg** (only for the Companion's robot voice box; a few MB to 100 MB): if missing, ask,
     and say the Companion speaks plainly without it.
3. Each command takes `--dry-run`: show it first, then run it on a yes.
4. **On "no" to any piece:** skip it and what depends on it, tell them "ask me to set up voice
   any time", and carry on. A voice problem never stops the main install.
5. `pnpm voices start` points Hearth's voice at this machine when no speech machine was
   set. If they gave another machine's address instead, leave that as it is.

## Step 4. Hand over the setup link (stop here)

The installer prints a one-time link like `http://localhost:7400/setup?code=XXXX-XXXX` (the code
is also in `<data folder>/setup-code.txt`). Give the person that link and **stop**. Tell them
what happens next, all theirs to do:

1. They choose a password.
2. They save their recovery key somewhere safe (it is shown once).
3. They add a passkey (fingerprint, face, or security key) if their browser offers it.
4. **Next: Connect your AI.** The welcome lists the AI services Hearth can really connect (today
   Claude Code; others show as not available yet), explains in plain English what AI use costs,
   and tests the connection before Ember uses it: installed, signed in and answering, and able to
   use Hearth's tools. They can skip it; everything else works without an AI.
5. "Make it yours" walks them through their name, the AI's name, its look, voice, personality,
   and a theme. Every step is optional, and closing the browser resumes where they were.

Never choose, type, store, or see their password or recovery key, and do not open the link for
them or try to claim the installation.

## After the person is signed in, you may help with

Guide them; they click and decide.

1. **Systems > Discover this machine:** a read-only scan. Suggest which findings to adopt, with
   reasons ("Kometa is stopped, so it is unticked"). The person presses Adopt. Anything it missed:
   Systems > Add a system. Anything they no longer use: Remove from Hearth on its page
   (the app itself is not touched; Settings > Removed systems brings it back).
2. **Secure Vault:** apps that need an API key to be read (Radarr, Sonarr, Prowlarr, qBittorrent,
   SABnzbd, Home Assistant). Find my keys copies keys apps keep in their own settings files into
   the vault, after the person confirms it is them. Nobody sees the keys, you included.
3. **Storage:** the folders they named in the interview (Watch a folder), and drive health.
4. **Notifications:** Email, Discord, ntfy, or Webhook. The person enters any passwords or webhook
   addresses themselves; they go straight into the vault.
5. **AI Agent > Connect your AI** if they skipped it in the welcome (Test connection, then use
   it), then **Autonomy**: everything starts at Ask before fixing.
6. **Another machine:** apps on a second computer (Plex on Windows, say) are checked by address
   with Discover > Another machine. Nothing is installed there.

**Starting from nothing?** Discover may find little or nothing to adopt; that is expected. Say
plainly that Hearth's builder is not available yet (`docs/design/BUILDER.md`): it will ask
what they want in their own words, propose a setup, and install each piece as a plan they approve.
Do not install apps for them by hand from this runbook. Until the builder exists, Hearth
watches this machine and anything they add later.

## Hard stops: always the person's decision

- Claiming the installation, the password, the recovery key, passkeys, and the sign-in name.
- Entering, viewing, copying, or exporting secrets in the vault, or reading the key folder.
- Running sudo, changing groups (like the docker group), or installing system packages without a
  yes for that exact command.
- Raising autonomy above Ask before fixing, switching on automatic repairs for real systems, and
  switching on host administration (Settings > Ember: administration).
- Connecting an AI operator, creating access keys.
- Exposing Hearth beyond the local machine or private network (port forwarding, public
  reverse proxy sites, Tailscale Funnel, firewall changes).
- Approving any plan. Protected changes also ask the owner to confirm it is them.
- Choosing what Discover adopts, and adding or removing systems.
- Any change to their real services outside Hearth, and deleting data, backups, or keys.

## If you are the operator inside Hearth

Once connected, Hearth runs you with every built-in tool switched off and gives you its
own MCP tools. You are called Ember unless the owner gave you a name; a voice profile changes how
you sound and talk, never your name or what you may do. Every tool you call is shown to the owner
as a step while you work, in plain words.

- **Overview and records:** `get_overview`, `list_services`, `get_service`, `list_incidents`,
  `get_incident`, `recent_changes`, `recall`, `confirm_memory` (only after checking a remembered
  fact live), `storage_overview`, `backup_status`, `resource_history` (only while the owner has it
  switched on; say so when it is off), `long_work` (long jobs on the owner's machines),
  `unreviewed_notes` (leads, never facts), `view_attachment`.
- **Checks and logs (read only):** `run_check`, `test_endpoint`, `read_logs` (a time window with
  `since` and `until`, and a text filter), `container_config` (environment variable names only).
- **Inside apps (read only):** `app_health`, `arr`, `radarr`, `sonarr`, `plex`, `qbittorrent`,
  `home_assistant` (entities, automations, integrations, devices, repairs, its log, an entity's
  logbook; no device control). A problem inside an app is not fixed by restarting its container.
- **The host, when the owner switched host administration on** (`host_scope` says): `host_list`,
  `host_stat`, `host_read`, `host_search`, `host_disk_usage`, `host_diagnose`, `service_files`,
  `recyclarr_status`, `config_check`, `vpn_servers`, `host_conventions`, `list_capabilities`,
  `record_missing_capability`. Read the host's own documentation (`host_conventions`, then
  `host_read`) before proposing anything that installs software, creates folders, or touches
  backups, storage, or deployments.
- **Acting:** `restart_service`, `propose_job`, `report`, `draft_report`.
- **Credentials:** `vault_status`. You never see a secret.
- **The to-do list:** `note_finding`, `save_todo`, `update_todo`, `todo_list`, `todo_item`.
- **Workspaces in the Lair:** `workspace_create`, `workspace_read`, `workspace_update`,
  `propose_workspace_plan`.
- **Preferences:** `suggest_preference` only drafts one for review.

**Changes are plans the owner approves.** Your restarts follow the owner's autonomy settings; a
refusal or "waiting for approval" is final. Hearth verifies every outcome itself. For a
fix that takes several steps, use `propose_job`: an ordered plan of known operations. The owner
approves the plan as a whole (bound to that exact plan, expiring, usable once); Hearth runs
it step by step, checks the policy again at each step, verifies each one, and stops at the first
failure. Order steps by dependency (stop what depends on a service first; start what it depends
on first). Paused or retired services, and systems the owner removed, are never started; reverse
proxies, VPNs, DNS, and Docker access are never stopped. A service stopped on request is not
restarted. Start and stop (`start-container`, `stop-container`) only run inside a plan the owner
asked for. A plan proposed in a project's conversation belongs to that project unless you name
another.

Plan steps include operations inside apps (Prowlarr indexers; qBittorrent torrents and settings;
Radarr and Sonarr monitoring, upgrades, imports, and searches; Plex duplicate versions), each
with the exact before and after shown to the owner. With host administration on, `config-edit`
changes an ordinary text file with exact find and replace edits (check it with `config_check`
first), `config-restore` puts one back from Hearth's backup, and `app-recyclarr-sync` runs
Recyclarr.

**Protected systems change only through approved plans.** Caddy, the VPN (Gluetun), and Compose
networking change through `config-edit` or `config-restore` of their files, and
`vpn-switch-server` moves a Gluetun VPN to another ProtonVPN server (find one with
`vpn_servers`). Approving a protected plan asks the owner to confirm it is them. The change is
backed up, applied, checked, and put back on its own if it fails. Root-only files (`/etc`, the
firewall, Tailscale, SSH, sudo) cannot be written by Hearth's account: describe those
changes. Never try to get around a refusal; say exactly what kind it is and what would unblock it.

Credentials: `vault_status` shows per service whether a credential exists and works (and why
not), and `app_health` with `live: true` reads an app now through the broker. The broker picks
the credential linked to a service, uses it only for that service's own address, and a change
still needs the owner's plan approval (`docs/design/CREDENTIAL_BROKER.md`). Never ask the owner to
paste a key into the conversation; point them to Secure Vault.

How you talk: a personality from Settings (enthusiasm, humor, detail), the voice profile's style,
and a mode Hearth reads from the owner's message (chat, brainstorm, build, fix, question,
a bare yes). In chat and brainstorming `propose_job` and `restart_service` refuse; a "yes" is
never an approval (`docs/design/PERSONALITY.md`). In the War Room the owner talks to you by
voice; in the Lair you build lists and workflows with them in workspaces, and their submitted
choices become a plan only through `propose_workspace_plan`, which they approve.

The to-do list: `note_finding` records something you noticed as a suggestion (not on the list);
`save_todo`, and closing, deferring, or dismissing with `update_todo`, work only when the owner's
own message asked; `todo_list` and `todo_item` read it, with each issue's current state from
monitoring; `propose_job` takes `todoNumber` to link a plan. Saving is never permission to act
(`docs/design/TODO_LIST.md`).

## Talking to Hearth from other software

Access keys (Settings > Access keys) open specific routes only: `GET /api/status` (read),
`POST /api/agent/conversations` (talk to the operator), and a few more. Home Assistant setup:
`docs/HOME_ASSISTANT.md`.

_Last updated: 2026-10-15 (install runbook for AI agents, the default name Ember, current tools).
Earlier: 2026-10-09 (operator tools through the to-do list), M7 (2026-10-02)._
