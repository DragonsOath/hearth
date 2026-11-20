# Builder: a homelab from nothing

Hearth has two jobs. The first, built today, is **managing** a homelab you already
have: watching it, explaining what is wrong, and fixing it through plans you approve. The
second is **building** one for someone who has never run a server. They say what they want in
their own words ("a media server I can watch from anywhere", "back up the family photos"), and
the AI plans the setup with them, installs and connects each piece with their approval, and
then looks after what it built.

The goal: Hearth is the first stop for anyone who wants a home server and does not
know where to begin.

## The journey

1. **Find it.** The README offers two paths: "Set it up with your AI" (paste one prompt into
   Claude Code or a similar agent) or "Do it yourself".
2. **Install Hearth.** The user's agent follows `docs/INSTALL_WITH_AI.md`. It checks the
   machine, asks about folders, drives, and the network, shows the install command, runs it on
   a yes, and hands over the one-time setup link. The person picks their own password.
3. **Choose a path** on first sign-in: "I already run things" (discover and adopt, today's
   flow) or "Help me build" (below).
4. **Interview.** In the War Room, the AI asks about goals first, then what it cannot see:
   - which devices will watch or use it;
   - whether they want access from outside the home;
   - whether they own a domain;
   - their budget (a VPN is a subscription).

   It reads what it can see for itself through host tools: CPU, memory, GPU, disks and free
   space, and what is already running.
5. **Blueprint.** It proposes a setup in plain words: which apps, why each one, where their
   data lives, what it costs, and what it needs from the person. The person changes it until
   it is right.
6. **Build, stage by stage.** Each stage is a plan with the usual approval (before and after,
   checked, undone on failure): folders, then each app, then the connections between apps,
   then remote access. Nothing installs without approval.
7. **Hand over.** Every app it built appears in Hearth already adopted, with its keys in
   the vault, its web address set, and its health checks running. From then on it is managed
   like everything else.

## What exists that the builder reuses

- Plans, approvals, verification, and automatic rollback (`apps/server/src/jobs`).
- Host investigation (read only): disks, mounts, containers, Compose, logs (`admin/host.ts`).
- Configuration edits with backups, and protected changes with an identity check
  (`admin/operations.ts`, `admin/protected.ts`), including applying a Compose file and waiting
  for every container to be healthy.
- The credential broker and Find my keys: app keys go from an app's own settings file into the
  vault without the AI seeing them.
- Readers for the common apps (the *arr apps, qBittorrent, SABnzbd, Plex, Jellyfin, Seerr,
  Home Assistant), so the builder can confirm an app really works, not just that it started.
- Reverse proxy addresses read from Caddy.

## What has to be built

### 1. Blueprints (curated app recipes)

A blueprint is a reviewed, tested description of one app, kept in the repository (not written by
the AI on the fly):

- its image and a pinned version;
- the folders it needs and who owns them;
- its ports, and which ones a reverse proxy should publish;
- its environment settings, with secrets generated into the vault rather than written in clear;
- its health check, and the reader that proves it works;
- what it connects to (Sonarr uses Prowlarr and a download client), and what each connection needs.

The first set is a media starter (Jellyfin or Plex, Sonarr, Radarr, Prowlarr, qBittorrent behind
Gluetun, Seerr), then Caddy, Immich, Home Assistant, and a backup tool. The AI picks and fills
in blueprints; it does not invent Compose files from scratch for a beginner.

### 2. An "install app" plan step

It creates the folders, writes the Compose file from the blueprint, starts it, waits for it to
be healthy, checks it with its reader, then adopts it into Hearth.

The undo stops and removes the containers but keeps the data folders. The plan shows the
exact Compose file, the folders, and the ports before approval.

### 3. Connection steps

App-to-app wiring through each app's own API, using keys from the vault:
- add Prowlarr's indexers to Sonarr and Radarr;
- set the download client;
- point Seerr at the media server;
- add the Caddy site for each app.

Each connection is a step with a before and after, and is read back to confirm it took.

### 4. The builder conversation

A "Help me build" mode in the War Room: the interview, the blueprint, then plans one stage at
a time. Progress is kept as a project, so it can stop and resume. The blueprint document is
something the person can read and keep.

### 5. Tasks that need admin rights

Installing Docker, preparing and mounting drives, firewall rules, and Tailscale need root.
Hearth never runs as root. The design is a small separate admin helper that takes one
task at a time, only after the owner presses "Give admin rights for this task" and confirms it
is them. The helper keeps its own log, and network changes undo themselves unless the owner
confirms they can still connect.

Formatting a drive additionally needs the owner to type the drive's name; it is never offered
for a drive that holds data.

## Order of work

1. The onboarding documents: README paths, `docs/INSTALL_WITH_AI.md`, preflight, `.env.example`.
2. The blueprint format, the install-app step, and the first two blueprints, tested against
   disposable containers.
3. The rest of the media starter, and the connection steps between them.
4. The builder conversation in the War Room.
5. The admin helper for root tasks (needs the owner's go-ahead to install it on a machine).

## Rules that do not change

- Every change is a plan the person approves; a spoken "yes" is not an approval.
- The AI never sees a secret; generated passwords and keys go straight into the vault.
- Nothing is deleted or formatted without its own explicit, specific approval.
- Plain words throughout: the person should understand every step without knowing the jargon.
