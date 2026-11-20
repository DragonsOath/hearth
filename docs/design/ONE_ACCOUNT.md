# One account, many PCs and devices

Status: built (2026-10-23), all six phases, branch one-account. Owner's words: "Say my account has the home server, Home Vault and
Gaming-PC, and then I install the app on the Android tablet." One sign-in shows everything; a
project lives on one PC but can be worked on from any device; anything can be uninstalled
cleanly from any device.

## Words

- **Your Hearth** (the hub): the first installation. It holds the account (password, passkeys,
  recovery key), the list of PCs and devices, and serves the interface every device uses.
  For the owner today: the home server, because it is always on.
- **A PC**: another installation that joined your Hearth. It runs Hearth's engine (Claude Code,
  Codex, terminals, /rc) and discovery for its own projects and systems. It has no sign-in of
  its own; you use it through your Hearth.
- **A device**: a browser or the Android app signed in to your Hearth (phone, tablet, laptop).
  Devices run nothing; they are windows into your Hearth.

## How a PC joins

1. On your Hearth: Settings → **PCs and devices** → **Link another Hearth** → pick Windows or Linux. It
   shows one command to copy, with a join link inside it (single use, 30 minutes).
2. On the new PC, paste the command. The installer installs Hearth and joins it to your Hearth
   with the link. No setup page, no password: the PC shows up in the list as soon as it starts.
3. A PC installed the usual way can join later from its own setup page: "Join a Hearth you
   already have", then paste the join link.

## The link

A joined PC dials **out** to your Hearth and keeps one WebSocket open (`/api/link`), with its PC
token (random, stored hashed on the hub, plaintext only in the PC's key folder). The PC needs to
reach your Hearth (home network or Tailscale); nothing has to reach the PC, so no ports or
firewall changes on it. It reconnects by itself with backoff.

Over the link the hub forwards requests: **`/api/on/:pc/<path>` on the hub is `/api/<path>` on
that PC**, run inside the PC as a request from its owner (the PC trusts what arrives over its
authenticated link; nothing else can make such a request). WebSockets (the War Room's live
connection, terminals) are forwarded the same way as streams. When a PC is offline, its
requests answer "Gaming-PC is offline" and its cached projects and systems show as offline.

## What each place shows

- **War Room**: tabs for projects on every PC, each labelled with its PC. A project's chat,
  queue, terminal, files, previews and /rc run on its PC. New project asks "Which PC should
  this live on?" (your Hearth by default).
- **Home, Lair, Systems**: every PC's systems, labelled by PC. The hub mirrors each PC's
  machine and services (host connection `agent`), refreshed from the PC; a system's panel reads
  through its PC.
- **PCs and devices** page: every PC (online or not, version, address) and every signed-in
  device, with Add, Rename, Remove, and Uninstall.

## Adding a device (the Android app, or any browser)

**Add a device** shows a QR code and a short code: a one-time sign-in link to your Hearth
(single use, 10 minutes, home network or Tailscale only). Scanning it in the app (or with a
phone's camera) signs that device in. A device signed in this way can do everything except the
vault's sensitive steps, which ask for your password or passkey as usual.

## Uninstalling, from any device

- **A device**: Remove (signs it out everywhere it is open). The Android app also has
  Disconnect, and uninstalls like any app.
- **A PC**: Remove from account (it forgets the link and shows its own setup page again), or
  Uninstall Hearth from it: it stops, removes its service or sign-in task, and deletes its
  folder if you choose. Confirmed by typing the PC's name, and it's-you.
- **Your Hearth itself**: the same, with a stronger warning (every PC and device is
  disconnected) and an offer to download a backup first.

Uninstall works for installations made by the one-command installers, which record how they
were installed (`install.json` beside the app). On Linux they use a systemd **user** service
(with lingering, so it runs without anyone signed in), so Hearth can remove itself without
root. Installations made by hand say what to run on that PC instead.

## Security

- Join links and device codes: random, single use, short lived, stored hashed, refused from
  the internet. Each use is audited.
- PC tokens are revocable from any device (Remove). A removed PC's link is cut at once.
- The hub never sends a PC the owner's password, passkeys or vault key; a PC's own secrets stay
  in its own vault.

## Phases

1. Devices: Add a device (QR and code), PCs and devices page, remove devices.
2. PCs join: join links, the link, forwarding, PC list, remove, the joined PC's own page.
3. War Room across PCs.
4. Systems across PCs.
5. Installers: join on install, Linux user service, install.json, uninstall from any device.
6. The Android app (built by GitHub Actions, attached to each release).

## Icons and names

Each PC (your Hearth included) gets one of the owner's ten icons (`apps/web/public/pc-icons`,
listed in `packages/core/src/pcs.ts` with their colors) or its own picture with a chosen color.
An icon belongs to one PC at a time: the picker greys out icons in use, and the server refuses a
taken one. The PC's name (its own name by default, changeable) is shown right under the icon in
the icon's color: on the PCs and devices cards, at the start of War Room tabs, and as a small
mark on systems in the Lair and the sidebar.

## Systems on other PCs

The browser merges each online PC's discovered systems into this Hearth's (a PC still on sample
data is left out). Their ids name their PC (`pc~<pc>~<id>`), and any API call naming one is sent
to that PC (`routeToPc`), so pages and panels need no changes to work across PCs.

## The Android app

`apps/android`: a native app showing your Hearth full screen. A home-network Hearth (plain http)
is opened through a forwarder on the device's own address (127.0.0.1), which Android treats as a
secure page, so the microphone works without certificates; every byte passes through unchanged.
Release builds are signed with the key in the repository's secrets (a copy and its password are
in `private/android-signing`, kept off git; keep them in your password manager too: updates only
install over a build signed with the same key).
