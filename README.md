# Hearth

A self-hosted control plane for your homelab, with an AI administrator that works for you.

**New to all this?** Hearth is the place to start, even with nothing set up yet. It asks what you
want in plain words, looks at your computer (changing nothing), and plans a media server that
suits it. Then Ember, its AI, builds it with you: Docker, Jellyfin or Plex, Seerr, Radarr, Sonarr,
Prowlarr, qBittorrent through your VPN, and Tailscale, one step at a time, each only after you
approve it (on Linux for now). If an AI assistant is helping you install, point it at
[AI_README.md](AI_README.md).

## Install

Pick one. Each ends by opening Hearth's setup page in your browser, where you choose your
password, name your AI, and let it find the systems you already run.

**Linux** (as your everyday account; Hearth runs as your own service, and it may ask for your
password once so it keeps running while nobody is signed in):

```sh
curl -fsSL https://raw.githubusercontent.com/DragonsOath/hearth/main/deploy/get.sh | bash
```

**Windows** (PowerShell; no administrator rights needed):

```powershell
irm https://raw.githubusercontent.com/DragonsOath/hearth/main/deploy/get.ps1 | iex
```

The installer also adds Hearth to your app menu (Start menu on Windows)
and desktop: it opens in its own window, like an app. Run the same command again to update: your
data and settings are kept. After that, Hearth tells you when a new version is out (the Update
button at the top, the bell, and your notifications) and updates itself with Update now.
To remove Hearth, run it with `bash -s -- --uninstall` at the end on Linux, or set
`$env:HEARTH_UNINSTALL = "1"` before it on Windows; it asks before deleting your data. Or
uninstall it from any of your devices: Settings, PCs and devices, Uninstall.

**More PCs, one account.** Install Hearth on your always-on machine first. Then, on that
Hearth, open **PCs and devices**, **Link another Hearth** (Hearth Connected, Premium): it gives you one command, with a join link inside,
to paste on the next PC. That PC installs Hearth and joins: its projects and systems show up in
your Hearth, marked with the icon you pick for it, and you work on them from any device. A PC
that already runs Hearth on its own joins from its own Settings, PCs and devices, **Join another
Hearth**, keeping everything it has.

**Phones and tablets.** Open your Hearth in the browser, or get the Hearth app for Android
(`hearth-<version>-android.apk` on each release). In your Hearth, **PCs and devices**, **Add a
device** shows a QR code: scan it with the app and you are signed in. Voice works in the app too.

**Or have your AI agent do it.** Paste this into Claude Code, Codex, or whichever agent you use,
on the machine that will run Hearth:

```text
Install Hearth for me. Read https://github.com/DragonsOath/hearth/blob/main/AI_README.md
(use the GitHub CLI if you need to sign in) and follow it step by step. Ask me its questions as you
go, show me every command before you run it, and ask before anything that needs sudo or
administrator rights. Stop when you give me the setup link: I choose my own password, recovery
key, and passkey.
```

Prefer to do every step yourself? See [Manual install](#manual-install) below.

It does two things. It can **manage a homelab you already have**: watch it, explain what is wrong,
and fix it through plans you approve. And it is growing a way to **help you build one from
nothing**: you say what you want in your own words, and its AI plans the setup with you and
installs each piece with your approval. Managing, planning, and building the media starter on
Linux work today (see [`docs/design/BUILDER.md`](docs/design/BUILDER.md)).

Hearth finds the machines, containers, and apps you run, watches them, and shows what
each one is actually doing: Radarr's queue, qBittorrent's stalled torrents, who is watching Plex.
When something breaks, its AI administrator (you name it; until you do, it is **Ember**)
investigates, explains what it found in plain words, and proposes a fix. Nothing that changes
your systems runs until you approve that exact plan, and every change is backed up, checked
afterwards, and undone on its own if it does not work.

> **Status: early.** Hearth runs one real homelab every day, but it is young. Expect
> rough edges, breaking changes, and setup steps that are not polished yet. Linux is the main
> target; Windows installs with one command too.

## What it does

- **Discovery and monitoring.** Docker containers, native services, and web addresses on the
  machine it runs on, with health checks, uptime, restart history, and resource trends.
- **Application-aware panels.** Live readers for Radarr, Sonarr, Lidarr, Prowlarr, Bazarr,
  qBittorrent, SABnzbd, Plex, Tautulli, Seerr/Overseerr, Syncthing, Home Assistant, and more.
  Every service shows real app data, or says exactly what is missing (usually an API key).
- **An AI administrator.** It reads logs, files, and app state through tools Hearth
  gives it, never a raw shell. It plans repairs step by step: retest an indexer, change
  qBittorrent's seeding limits, edit a configuration file, switch a VPN to another server.
- **Plans you approve.** Each plan shows the before and after of every change. Changes to
  protected systems (VPN, reverse proxy, networking) also ask you to confirm it is you.
- **The War Room.** Claude Code or Codex, running on this machine with your homelab's memory,
  in a control center: projects as tabs, a terminal, GitHub, a task queue with approvals and a
  kill switch, plus Hearth's panels for your systems, to-dos, and plans.
- **The Lair.** The AI beside your systems' panels, where it builds lists and workflows with you.
- **A secure vault.** API keys and passwords are encrypted locally. The AI never sees a secret:
  Hearth's credential broker uses keys on its behalf and only shows it the results.
- **Your reverse proxy.** Web addresses are read from Caddy, so "Open web UI" goes to
  `radarr.example.com` rather than an IP and port (or to the host, if you prefer).
- **Themes.** Four built in, or pick your own main and secondary colors.
- **Passkeys, backups, notifications**, and an audit log of everything that happened.

## Requirements

- Linux or Windows. The one-command installers bring their own Node.js 24; a manual install
  needs Node.js 24 and pnpm 11.
- Docker (optional; without it only native apps and web addresses are watched).
- For the AI administrator: the [Claude Code](https://claude.com/claude-code) CLI, signed in on
  the same machine.
- For voice (optional): a Whisper speech-to-text server and a Piper text-to-speech server on
  your network.

## Manual install

On Linux, install it as a service. Check first with a dry run, which changes nothing and shows
every command it would run; then run the same command without `--dry-run`:

```sh
DC_DATA_DIR=/srv/homelab/dragon-control/data \
DC_KEY_DIR=/srv/homelab/secrets/dragon-control \
DC_BACKUP_DIR=/srv/homelab/backups/dragon-control \
  bash deploy/linux/install.sh --dry-run
```

Run it as your everyday user, not root; it asks for sudo only to write and start the service.
Keep a copy of the key folder somewhere safe: backups cannot be opened without it. To update
later, `git pull` and run `bash deploy/linux/install.sh` again: it keeps the installed settings.
`--status` shows the installation, and `--uninstall` removes its service (keeping its data). A
second installation on the same machine, such as a temporary trial with its own account and
resource limits: [docs/MULTIPLE_INSTALLS.md](docs/MULTIPLE_INSTALLS.md).

To try it without a service (any OS):

```sh
pnpm install
pnpm build
pnpm start        # http://127.0.0.1:7400
```

On first start Hearth prints a one-time setup link. Open it to choose your password,
save your recovery key, and add a passkey. Settings come from environment variables; every one
is listed in [`.env.example`](.env.example).

For development (hot reload, tests, layout) see [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).
If an AI agent is installing it for you, point it at [`AI_README.md`](AI_README.md).

## How it keeps you in charge

- Hearth never has admin (root) rights. In the War Room the AI works as Claude Code or Codex on
  this machine, as your account; work with risky words (sudo, docker, deleting) waits for your
  approval, and a kill switch stops everything.
- Reading is automatic; changing anything is a plan you approve, step by step.
- Secrets stay in the vault, encrypted, and are never shown to the AI or written to logs.
- Every change is recorded with who asked for it, what changed, and how it was verified.

Design notes live in [`docs/design`](docs/design).

Want a full panel for an app you run, or a feature on one? Ask, or vote for one already asked
for, on the
[panel request board](https://github.com/DragonsOath/hearth/discussions/categories/panel-requests).
[How requests work](docs/HOW_REQUESTS_WORK.md) says how they are chosen. Bugs and ideas: see
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

Hearth is free for home use, source available, under the
[PolyForm Noncommercial License 1.0.0](LICENSE). You may use it, change it, and share it for any
noncommercial purpose: your own homelab, hobby projects, family and friends, schools, charities and
research. Using Hearth to make money (selling it, selling hosting or setup built on it, or running
it inside a business) needs a commercial license from the maintainer. Ask through an issue.

Service logos come from [Dashboard Icons](https://github.com/homarr-labs/dashboard-icons)
(Apache 2.0); each logo is a trademark of its project. Fonts are under the SIL Open Font License.
