# The Hearth manual

Everything Hearth does, page by page: every panel, button and setting, in plain words. Ember (the
AI inside Hearth) reads this to answer "how do I..." and "what does this do". It is kept current
with every release.

Lines like `<!-- feature: movie-nights -->` (hidden when the manual is shown) tie a part of it to
Hearth's feature list (`packages/core/src/features.ts`), which says what is built, what each
feature needs, and what Ember can do with it.

Names in **bold** are exactly what you see on screen. "The Lair" is the panel of your systems
beside Ember; "the War Room" is Ember's full-screen workspace.

---

<!-- feature: capabilities -->

## 1. What Hearth can do

Hearth is a homelab control center that lives on your PC (Linux or Windows). In short:

**Look after your homelab**

- Finds what you run (Docker containers, apps on other machines) and watches it, every minute.
- Tells you only what needs you, from Home's alert pills (**Requires your attention**).
- Fixes routine problems on its own, within the limits you set in **Autonomy**.
- Explains problems in plain words: what it saw, why it matters, what to do next.
- Keeps a full record of every check, change and decision (**Changes and activity**).

**An AI that knows your homelab (Ember)**

- Talk to it anywhere (the Lair) or full screen (the War Room), by typing or by voice.
- It reads inside your apps (Sonarr, Radarr, Plex, Jellyfin, qBittorrent, Home Assistant and
  more) with keys from your Secure Vault, never shown to it.
- It proposes changes as plans you approve, or does them directly, asking you first as you chose
  (**What it asks before acting**).
- Choose its brain: **Claude Code**, **Codex**, or **Ollama** (free, on your own hardware).
- It remembers your homelab: projects, decisions, fixes, wins, and how you like things done.
- Give it a name, a look, a voice and a personality.

**Live panels for your apps**

- Sonarr, Radarr, Lidarr, Chaptarr: queue, **Download trail** (grab to library), missing,
  coming, upgrades, collections, and **Search releases** to pick a release yourself.
- Overseerr / Jellyseerr: requests with release dates, overdue ones flagged, **Stop tracking**.
- Plex, Jellyfin, Emby, Tautulli: who is watching (stop a stream), libraries, scans, tasks, users.
- qBittorrent, Deluge, Transmission, SABnzbd, NZBGet: every download, with pause, resume, recheck and more as small plans.
- Wizarr: make invitation links for your media server.
- Home Assistant: lights and switches, routines, automations and scenes.
- Portainer: environments, stacks and containers; start, stop, restart, update a stack.
- Uptime Kuma: what is down and since when, every monitor's checks and uptime; pause, add, watch your apps.
- Nextcloud: free space, background jobs, open public links, setup checks; accounts (off or on,
  quota, groups) and apps (on or off).
- Paperless-ngx: the inbox to sort, failed imports and why, its health; tag, file and trash
  documents, search them all.
- Vaultwarden: who has two-step sign-in, open sign-ups, accounts (off, sign out, lost phone,
  invite); never anything inside a vault.
- Tailscale: devices online, waiting for approval, keys running out, exit nodes and routes;
  approve, never expire, rename, remove.
- wg-easy (WireGuard): who is connected now, handshakes and traffic; turn clients on or off, add,
  rename, end dates.
- Navidrome (music): who is listening now, the last scan, missing files; scan, users' roles.
- Komga (comics): libraries and scans, books it could not read, who signed in; scans, clean-ups.
- Gitea (git server): repositories, mirrors, Actions runners and runs; sync, re-run, runners.
- Forgejo (git server): the same panel as Gitea; runs per repository, no runner list.
- Mealie (recipes): health, version and backups; back up, clean up, unlock accounts.
- Actual Budget (budgets): server health, version and budget files; read only.
- Authentik (sign-in): sign-ins, failed sign-ins, apps protected, health; accounts off or on.
- Frigate (cameras): cameras, events, alerts, detector speed, storage; detection, events, restart.
- Authelia (sign-in): whether sign-in works, sign-ins, failed and banned sign-ins; read only.
- Any other app: a basic panel (status, logs, Ask Ember into its own API, and "This is a basic
  panel. Want a full one? **Request it**").
- Every full panel ends with **Request a feature**. Both links open a request on the Panel
  requests board, already filled in for that app; votes decide what is built, a panel at a time
  ([How requests work](HOW_REQUESTS_WORK.md)).
- Traefik: routers, refused routers, apps down behind it, certificates (read only); it also fills
  in Open web UI addresses.
- Nginx Proxy Manager: sites, where each forwards, certificates and expiry, sites nginx could
  not load; it also fills in Open web UI addresses.
- Proxmox VE: nodes, VMs and containers (start, shut down, back up, snapshot), backups, storage.
- AdGuard Home: protection, the query log and why a domain is blocked, custom rules, filter
  lists, blocked services, safety switches, DNS rewrites.
- Pi-hole: ad blocking, the query log and why a domain is blocked, pause, allow or block a
  domain or pattern, blocklists, local DNS names.
- Caddy (sites and sign-in), Tinyauth, Gluetun (VPN server), Prowlarr, Bazarr, Recyclarr,
  FlareSolverr, Audiobookshelf, Kavita, Immich, ErsatzTV, Syncthing.

**Storage**

- Every drive with its own health verdict, temperature and space, plus space over time.
- A file manager for your drives (rename, move, copy and new folder, each confirmed first).
- **Recently Added** and **File Journeys** (each download from grab to your library).
- **RAID / Arrays**: mdadm, ZFS, Btrfs, SnapRAID and Windows Storage Spaces, with checks,
  member changes and new arrays.
- **Collection PDF**: a printable catalog of your movies, shows, audiobooks and books.

**Friends and family**

- **New in your library** posts to Discord (or ntfy, email, webhook) with poster, trailer and
  details, designed the way you like: movies and shows, and, when you turn them on, music,
  audiobooks, ebooks, comics, games and podcasts, with a short line from Ember on top.
- **Movie nights**: invite friends to a movie from your library, with reminders and, with a
  Discord bot, **I'm in** and **Can't make it** buttons that keep the guest list.
- **Release watch**: follows every movie requested in Seerr until it is in your library.

**Safety and keys**

- **Secure Vault**: encrypted keys and passwords, unlocked with a passkey; AI agents never see
  them.
- Daily encrypted backups of Hearth itself, with a copy off the machine.
- **Homelab rules**: systems the AI may never change, and times a machine is reserved for you.
- Protected systems (VPN, reverse proxy, firewall, networking) change only after you confirm
  it is you.

**Everywhere you are**

- One account across all your PCs; each PC's projects and systems show everywhere.
- Phones and tablets sign in with a QR code; the Android app is a home-screen app.
- Notifications to Discord, email, ntfy or a webhook, with quiet hours.
- **Plan my first homelab**: a guided plan for someone starting from nothing.

---

## 2. Getting started

<!-- feature: first-run-setup -->

### First-run setup

A new Hearth opens with setup, one step at a time (you can stop and pick up later):

1. **Your account**: a password, then a passkey if your device supports it.
2. **Connect your AI**: sign in to Claude Code (or choose Codex, or Ollama later). The screen
   explains what AI costs before you connect. **Skip for now** works; Hearth runs without AI
   (monitoring, known fixes and notifications keep working).
3. **Make it yours**: your name and picture, **This PC** (its name and icon), your AI's name,
   its look, its voice, its personality, and your **Theme**.
4. **Finish**: three ways in. Someone starting from nothing gets **Build my setup** as the main
   button, with **Enter Hearth** beside it; someone who already runs apps gets **Enter Hearth**
   and **Find what I already run**.

Run it again any time: Settings, General, **First-run setup**, **Run the setup again**.

<!-- feature: plan-first-homelab -->

### Plan my first homelab

For someone with no homelab yet. It asks **What would you love to do?**, a little about you,
what you already have, and how you will enjoy it (on a TV, a phone, away from home). It checks
what this computer can run (**How much memory does this computer have?**) and builds a plan:

- Each app is marked **Runs comfortably here**, **Possible with trade-offs**, **Better later**,
  or **Left out**, with **Why**, **Cost**, **Memory** and **Installed with**.
- **Recommended for you** explains each choice. **Leave it out anyway**, **Include it anyway**,
  **Save for later**, **Bring it back** and **Undo my choice** let you shape it.
- Using Plex? It asks **Do you pay for Plex Pass?** and **Is your Plex server already set up on a
  computer?** What you already pay for counts as free: with Plex Pass, Plex is recommended even
  with **Keep it free**. A Plex account with no server gets one set up here, with your account.
- **Do you already download movies or shows from somewhere?** If yes, Ember helps you add the sites
  you use to Prowlarr later. Hearth never names or suggests any site.
- **The VPN rule**: Hearth never sets up downloading without a VPN that allows P2P. Without one,
  the plan says why and you pick **I'll get a VPN (about $2 to $5 a month)** or **Skip automatic
  downloads for now (just play my own files, free)**. Nothing is assumed until you pick.
  Hearth is free; you bring your own AI (Ollama is free) and, for downloads, your own VPN.
- **Your app accounts**: the email, username and passwords Hearth gives each app it sets up.
- **Start over** clears it.

<!-- feature: build-homelab -->

### Build my plan

After **Save my account details**, press **Build it with Ember**. Ember greets you, has your plan,
and builds it with you one step at a time. Nothing happens until you approve each step, the
same way as every other plan. **Building your homelab** on the plan page shows every step:
**Done**, **Under way**, **Waiting for your OK**, **Needs you**, **Next** or **Later**. No AI
connected? **Next step** there proposes the next step for you to approve yourself.

In the chat, every app goes the same way: its approval card appears, you approve it, and when it
is up Ember names it with an **Open** button (it opens in its own window) and says how to sign in
("Sign in with the username and password you saved at the start", or where its strong password
is in Secure Vault). Hearth reads the app's API key itself and keeps it in Secure Vault: you never
find or paste one. Then Ember proposes the next step. Under her latest message there is always
one **Next** action: approve the card, **Continue: set up** the next app, **Open** one, or **Try
again**. Ask her something else and she answers briefly, then brings you back to the build.
Until the plan is built, this holds in every chat with Ember, after restarts too: she knows where
the build is from your saved plan (what is done, what is stuck, what is next), every message ends
with "Ready to continue with" the next app or what is blocking it and the way past, and a new chat
starts with **Your build, where it left off**.

**I checked it myself, it works: continue**: when a step fails but its app runs and answers,
Hearth's own check may be what failed. Open the app and sign in; if it works, press this (under
the step on the plan page, or in the chat). It is a plan you approve: Hearth makes sure the app
answers, reads its API key into Secure Vault, notes that you confirmed it, and the build carries
on. It is never done for you.

The steps, in order (only the ones in your plan):

1. **Docker**, from Docker's own repository. Installing it needs administrator rights, which
   Hearth's own account doesn't have, so the first time a plan needs Docker (or Tailscale), the
   step says why and shows two ways:
   - **Set up the admin helper (once)**: a root service that runs only a fixed list of
     operations (install Docker, install Tailscale), each time you approve one. It has no shell
     and runs no other commands. **Its source** links to its code. Paste its command in a
     terminal (**Copy the command**) and type your password.
   - **Or install it yourself**: Docker's own commands (**Copy the commands**), then restart the
     computer so Hearth's account can use Docker. Hearth sees it and moves on.

   With the helper, installing Docker is a protected step: approving it asks you to confirm it's
   you, because using Docker is close to administrator access. Either way, your account ends up
   in the `docker` group.

2. **Jellyfin** (or **Plex**, if that's your plan: it starts here, and you **Sign in to Plex** on
   its own page to make it yours; Hearth then adds your libraries). Jellyfin comes with your drive shared read only, so your files are never moved, renamed or
   deleted. Hearth makes your account, finds your Movies and Shows folders by name (or makes
   empty ones), and adds them as libraries.
3. **Seerr**, signed in with your Jellyfin account (with Plex, you **Sign in to Seerr with Plex**
   on its own page).
4. **Radarr** and **Sonarr**, with your sign-in and their library folders on your drive.
5. **Prowlarr**, with your sign-in. It starts with no indexers (sites that list what's
   available to download). You add the ones you choose, and Hearth never suggests any.
6. **qBittorrent with your VPN**: every download goes through your VPN, and downloading stops if
   the VPN drops. Add your VPN login under that step (**Save my VPN login**). It goes straight
   into Secure Vault. This is a protected step.
7. **Connect the apps**: Seerr to Radarr and Sonarr, Radarr and Sonarr to qBittorrent, and
   Prowlarr to Radarr and Sonarr. Then Hearth starts watching them on its dashboard.
8. **Tailscale**, from its own repository (protected). Then **Sign in to Tailscale** with a free
   account to reach your apps from anywhere.

Each app gets its own folder in `hearth-apps` in your home folder, and runs on your home network
at its usual port (Jellyfin on 8096, Seerr on 5055). Every login and API key Hearth makes goes
into Secure Vault: Ember never sees them. Each recipe is fixed and reviewed: Ember picks the next
step, Hearth fills in every detail, and the approval card shows the exact file it will use.

If you skipped downloads and later want them, ask Ember: she explains why they need a VPN, helps
you pick one, and adds downloading to your plan.

Not built yet: the shared folder, backups and the other apps in a plan (the list says
which), and building on Windows (Hearth plans it there).

<!-- feature: discovery -->

### Find what I already run (Discovery)

Systems, **Discover** (or **Discover this machine** on Home). Hearth looks at this machine and
its containers and suggests what to watch. It only reads; nothing changes.

- **Recognised**: apps Hearth knows how to look after.
- **Needs a name**: web apps it does not know yet; name them so they read well.
- **Supporting**: databases, VPNs and helpers other apps rely on.
- **Stopped**: not running, left out unless you choose them.
- **Another machine**: for apps on another computer (Plex on a Windows PC): its **IP address**
  and a **Name**.
- **Start over** scans fresh. Systems you removed stay removed (**Removed by you**).

<!-- feature: sample-data -->

### Sample data

Before discovery, Hearth shows sample systems so every page has something in it. A gold
**SAMPLE DATA** tag in the top bar says so. Settings, Systems has **Discover this machine**,
**Sample scenarios** (calm or needs attention), **Scan again**, and **Show sample data
instead** / **Keep my systems**.

---

<!-- feature: navigation -->

## 3. Finding your way

- **Top bar**: search (**Find a service, or start a question**, Ctrl+K), the status pill
  (**All systems online** or **N things need you**), the bell, **War Room**, **The Lair**, and
  **Update Hearth** when a new version is out. A **SAMPLE DATA** tag shows on sample data.
- **Sidebar**: Home, Projects (All projects, Jobs), To-do, Releases, The Forge (Library, Open
  now, Notes), Agents, Systems (All services, Machines; a filter box and each service with
  its status dot), Storage, Secure Vault (the lock shows locked or open), Docker, Backups,
  Network, Monitoring (its tabs: Findings, Incidents, Autonomy, Notifications), Logs (Changes and
  activity, Memory, Integrations), Settings. The sidebar collapses with its edge button.
- **Getting started** on Home: a checklist for a new Hearth; **Hide this list** and **Show it on
  Home again**.
- Status dots: green healthy, amber needs attention, red down, grey paused or stopped on request.
  These colors mean the same in every theme.

---

<!-- feature: home -->

## 4. Home

Home fits on one screen on a computer (no scrolling); phones and tablets stack it.

- **Ember** in the middle: click the picture or the message box to open the conversation. It
  stays open as you move around Hearth until you minimize it.
- **Active projects** around Ember, from every PC: the ones that need you or are being worked
  on come first. Each card says **Lair** or **War Room** (who works on it) and which PC, with
  that PC's icon. A Lair project opens in the Lair; a War Room project opens the War Room on its
  PC. **+N more · View all** lists the rest. To change a project's name, description or color,
  use the pencil on its card (it shows when you point at the card, always on touch screens) or
  right-click the card: **Edit project**. In the War Room, right-click a project's tab, Lair
  projects too.
- **Start a project** (in an empty spot): first, who works on it. **The Lair**: homelab work
  (apps, drives, media, settings), done by Ember with Hearth's live tools, asking before anything
  risky. **War Room**: building something (an app, a website, a script) with Claude Code, Codex
  or Ollama in its own folder. Then **Project Name**, **Project Description**, **Color on Home** and which PC (for the Lair, which
  machine it is about), and **Start in the Lair** or **Start in the War Room**.

<!-- feature: project-colors -->

- **Color on Home**: when you start a project, pick **Red**, **Orange**, **Yellow**, **Green**,
  **Blue** or **Purple** and its card on Home glows in that color, with its line to Ember in the
  same color. **No color** (the default) keeps the plain card. Change it later on a Lair
  project's page (Overview, **Color on Home**) or, for a War Room project, right-click its tab,
  **Edit name, description and color**.
- **Alert pills** under Ember: **Critical**, **Warnings**, **Approvals** and **Offline**. Each
  opens **Requires your attention** in a side panel, with **Investigate with Ember**, **Add to
  to-do** (a reminder only; nothing runs) and a link to each plan to approve. **View all
  alerts** opens every one, plus **Worth knowing**. "N things need you" in the top bar and the
  bell open it too. **Remove** takes one off: for a finding, **Snooze a week**, **It's fine as it
  is** (back if it changes) or **Dismiss**; for an incident, **Dismiss** (back if it changes, or
  if it recovers and happens again). An incident's timeline keeps one line for its repeated
  checks ("3:10 PM to 6:40 PM, 42 checks").
- **At a glance**: CPU, memory, storage, containers, services and the last backup; each opens
  its page. With more than one PC, the numbers are for the PC you are at (a window opened from a
  joined PC shows that PC); **Stats for** switches to another PC or **All PCs**. A PC with no
  numbers yet offers **Discover** that PC, which looks at its own machine from here. The War
  Room opens on the PC you are at too.
- **Recent activity** (wide screens) and **Briefing**: what changed since you were last here,
  what is working well, what Ember is handling, this week, recent activity, systems, and what
  Hearth can see.
- On a fresh Hearth: **Welcome**, **Discover this machine**.

---

## 5. Ember, the AI

<!-- feature: lair lair-arrange -->

### The Lair

**The Lair** button (top bar, any page) opens Ember beside your systems' panels.

- The conversation on one side, panels on the other. **Open a panel** (search for a service or
  tool: Storage, To-do, Plans). Up to three panels sit beside the conversation and never get
  narrower to make room for a fourth: one opened while three are showing waits in the queue (its
  name under **Also open**). The arrows at the top right (**Slide the panels on** and **back**, with
  "2-4 of 5" between them and the number waiting on the arrow) slide the panels along; the
  conversation never moves. Pinned panels always stay. Panels can be moved (**Move panel left/right**), resized,
  pinned, minimized and closed; **Close unpinned** tidies up. **Minimize all** hides them.
- Ember's own panels (To-do, Ember's Browser, Storage & Files, Home rows, Download Health) sit on a
  row of their own above your systems.
- The row of systems along the top: tap one to open or close its panel. The ones you use most come
  first, or tap **Arrange** to set the order yourself: a box lists them all; drag each by its handle
  (or use the up and down arrow keys on it), then **Done** puts that order on the bar. The order is
  kept on your Hearth, so your phone's **Panels** list and every other device show the same order.
  **Most used first** goes back to the automatic order; **Cancel** changes nothing.
- **Layouts**: save the current set of panels with a name and reopen it later (**Saved
  layouts**).
- **Suggestions**: **Open beside this** offers related panels; **Open all** opens them.

<!-- feature: ember-opens-panels -->

- **Ask Ember to open one**: "open Seerr" opens its panel beside the chat (at the front on a
  phone). This works on every Hearth, with Show & Tell on or off; Show & Tell adds pointing at
  things on screen.
- **Back to the newest message**: scrolled up in a conversation, a round down arrow appears
  (bottom right on a phone); tap it to jump to the latest message.
- **Which conversation**: the main conversation, or a project's own.
- Keep this Lair as it is and go back to Home (everything stays open).
- **Your workspaces**: leaving the Lair keeps what was open as a workspace chip (top of every
  page); **Bring back** reopens it as it was. Opening the same panel link again (a bookmark, or a
  link in a message) goes back to the workspace that already has those panels, so no copies pile
  up.

<!-- feature: lair-phone -->

- **On a phone**, **Ask** in the bottom bar opens Ember's chat in the Lair (with your panels, the
  Lair you used last when you come from elsewhere). Ember and every open panel form a ring, in the order they were opened. Swipe
  sideways to go round it, either way; it wraps (right from Ember is the last panel). Scrolling up
  and down never switches, and neither does a swipe on something that moves sideways itself (a tab
  row, a slider, a text box, or while you are typing). The bar at the top shows the panel's name,
  its place (**Plex 2/4**) and dots; **Previous panel** and **Next panel** do what a swipe does,
  tapping the name lists every open panel to jump to, and the Ember button goes straight back to
  the conversation. Panels you visited keep their place (scroll, tab, what you typed), and Ember
  keeps writing its answer while you look at a panel. **Panels** (beside **Saved workspaces** at
  the top) drops down the same bubbles as a computer's Lair, Ember's panels then your systems;
  tapping one adds it to the ring and folds the list away. Long lines in the chat wrap, so it
  never slides sideways. The chat fits the screen, as in the Claude app: the box stays at the
  bottom, the conversation scrolls by itself and opens at the newest message every time you come
  back to it, and the box grows as you type so the whole message shows. **+** beside the box holds
  **Attach a photo or file**, **Open it in the Forge**, **Read answers aloud** and **Voice chat**;
  the menu (three lines, top left of the chat) holds what needs you, **Lair** and **Minimize all**,
  which AI answers and its model, **Panels** and **Saved workspaces**, the conversations (picking
  one closes it) and full screen. While the chat fills the screen, the header and the Ember and
  Minimize all buttons step aside for it; they come back on a panel. Every
  drop-down on a touch screen opens Hearth's own list from the bottom of the screen (a filter
  box when it is long) instead of the phone's. A tablet, upright or sideways, gets the computer's
  layout.
- The mic dictates; the paperclip attaches a photo or file.
- **Voice chat** (the waveform): talk back and forth with Ember right here, in the same
  conversation. It listens, sends what you said when you stop talking, and speaks the reply. It
  never listens while Ember is working on an answer or speaking, so it never hears itself. The
  **ear** beside it stops it hearing you (replies are still spoken); tap it again to talk. Tap
  the waveform again to end voice chat.

<!-- feature: capture -->

- **Capture** (camera icon on a panel): take a picture of a panel, a row, card or chart, or a
  region you draw, mark it up, and attach it to your next message. It stays on your Hearth.
  The camera in the top bar does the same for the whole Hearth screen: **Whole screen** (what is
  in the window now), **Pick an item** anywhere, or **Draw a region**. Hearth draws it from its own
  page, so there is no screen-sharing prompt, nothing outside Hearth shows, and passwords and keys
  are left out. **Save** puts the picture in the folder set in **Settings > General > Screen
  captures** (a folder on the computer Hearth runs on; Hearth makes it and names each file by the
  time, never over another), with **Download** beside it; with no folder set, Save downloads it.

<!-- feature: page-help -->

- **How this works** (the question-mark button in the top bar, and in a panel's header): what
  each feature on that page or panel is for, whether it is ready on your installation (and what
  to set up first), and the manual's own section for it. **Ask Ember about this** starts a
  conversation about it.
- **Open buttons**: when Ember explains part of Hearth, an **Open** button (for example **Open
  Movie nights**) appears under the answer, and Ember can put one in its words too. It takes you
  to that page, section, panel or tab. Nothing opens until you click it, and a link from the War
  Room opens in a new tab so the conversation stays as it was.

<!-- feature: war-room -->

### The War Room

**War Room** (top bar) opens Ember full screen.

- **The Lair** tab: always first, and it can't be closed. It is the Lair's own conversation
  (the same thread as the Lair: what you say in one shows in the other), with Ember's live
  Hearth tools, approvals and voice chat. Lair projects open as tabs too (**Open**, **In the
  Lair**), each with its own thread. Hearth no longer makes a Homelab project in the War Room;
  one made earlier is archived (still readable from **Open**), and the rules you added to it
  are under Settings, Ember, Homelab rules, **Your own rules**.
- **Projects** tabs: each has its own conversation. **New project** (**Project Name**, **Project Description**, **Color on Home**, which
  PC it lives on). Right-click a project to **Edit name, description and color** or **Delete project**. Projects on
  other PCs show with that PC's icon; **Open** lists every PC's projects.
- **AI tabs**: **Claude Code**, **Codex**, **Ollama** (see 5.3). Each keeps its own session
  per project, and switching keeps the conversation: the AI you switch to is first handed what
  was said since it last answered (your messages and the other AIs' answers), so it carries on
  where the last one left off.
- **View**: the chat view (voice and the task queue) or **Terminal** (the real Claude Code or
  Codex, live in the project's folder; **New session** starts fresh).
- **Message box**: **Request type** (chat with the agent, or auto route), **Model**, **Voice**
  (which voice speaks replies), **asks** (what it asks before acting), **approve first** (hold changes until you
  approve), the paperclip, **Dictate** (the mic), **Speak replies**, and **Free up voice
  memory** (the memory-chip button, shown while the voice program is loaded).
- **Task queue**: **Describe the task**, **Add to queue** (Ctrl+Enter). Tasks run one at a time;
  select one to see **Live progress** and the result. **Clear finished**. The **Kill switch**
  pauses the queue and stops the running task. **Allow 20 more today** lifts the day's task
  limit.
- **Claude needs your OK**: when a command needs approval, **Approve and run** or **No, cancel
  it**.
- **Which AI is answering**: at the top of Ember's panel in the Lair, **Claude Code**, **Codex**
  and **Ollama**, the one answering highlighted. Click another to switch right there (the same
  choice as the AI Agent page). The conversation carries over: whichever AI answers next sees it.
- **Plan usage bar**: how much of your AI plan's current window is left. Nothing is charged per
  message by Hearth.
- **GitHub**: your repositories, pull requests, commits, checks and diffs (read only), and what
  Ember is doing on GitHub.
- **Artifacts**: files the agent made, and your Claude artifacts; find and download them.
- **Screenshot**: capture the War Room, copy or save it, or attach it to your next message.
- **Hearth menu**: every page of Hearth, and **Open the Lair**.
- **Down arrow**: jumps to the newest message after you scroll up.

<!-- feature: remote-control -->

- **/rc**: type it to turn on Remote Control (the conversation also appears in the Claude app
  and claude.ai/code, as **Hearth • <PC> • War Room • <project>**); type it again to turn it off.
  It has Hearth's tools, as a War Room message does.
- **/rc in the Lair** works the same: type it in a Lair conversation and it appears in the Claude
  app as **Hearth • <PC> • Lair • Main** (or the project's name). A bar over the message box says
  it is on, with **Open in Claude**. Ember keeps her instructions, the conversation so far,
  Hearth's tools and your Full access setting, and changes are still plans you approve. Both
  sides show in the Lair; when Claude Code asks a question, type its number here or answer it in
  the app. **/rc** again turns it off, and the next message carries on with everything said. It
  needs Claude Code as Ember's AI (not Codex or Ollama).

<!-- feature: chat-login -->

- **/login** (Lair or War Room): signs Claude Code in on this computer from the chat, the same
  sign-in as the AI Agent page. The answer has **Open Anthropic's sign-in**; sign in there and
  paste the code Anthropic shows as your next message. The code is never kept (the chat shows "the
  one-time sign-in code"). Claude Code refuses /login inside the Claude app, so use it here; when
  Claude Code is signed out, a failed answer and **/rc** both say to type /login.
- **Play** on a reply reads it aloud.

<!-- feature: ai-choice -->

### Which AI (Claude Code, Codex, Ollama)

- **Claude Code**: the default. Signed in at setup (Settings, Ember).
- **Codex**: OpenAI's agent, signed in on this computer.
- **Ollama**: free AI on your own hardware. Hearth runs the same Claude Code with an Ollama model
  as its brain, so it has the same tools, Full access, guide and memory. Settings, Ember,
  **Ollama**: the **Ollama address** (this computer or another on your network) and **Use this
  model**. A model needs tool support and a 32k memory window; **Make a Hearth copy** makes one
  without changing the original. **Stop using Ollama** turns it off. Slower than the cloud, and
  smaller models make more mistakes.
- Every agent gets the same access and the same memory, in the War Room and the Lair.

<!-- feature: full-access -->

### What Ember asks before acting

In the War Room and the Lair, Ember is always the full Claude Code, Codex, or Ollama (which runs
through Claude Code): every tool and any command, nothing held back. You choose what it stops to
ask you first, in its reply, going on after you say yes. Settings, Ember, **What it asks before
acting**, or the **asks** picker in the War Room's footer, the same setting:

- **Ask before every change** (the default): it reads and looks around freely, and asks before it
  changes anything (a file, a setting, a container, an app).
- **Ask before risky steps**: routine, easily undone work goes ahead; restarts, app settings,
  installs, deleting data, networking, and sudo wait for your yes.
- **Ask only before serious steps**: it works on its own and asks only before what could be
  devastating or can't be put back (deleting data, wiping drives, networking, sudo). This is what
  Full access was.

With the first two, a War Room message with words like "delete" or "sudo" also waits for your
approval before it starts. It never gives itself sudo rights. Only you change this setting.

<!-- feature: ember-mark -->

**Buttons that start Ember** (Ask Ember, Ask why, Investigate, Improve this panel with Ember, and
the like) carry Ember's mark: its face in a small orange pill with the name of the AI behind it
(Claude, Codex or Ollama). Pressing one puts Ember to work, which uses your AI plan the same as
asking in chat. Buttons without the mark talk to your apps directly and use no AI. The same mark
sits beside the plan usage bar as its key. The first press of a marked button in a browser says
**This button starts Ember** first, with **Start Ember** and **Cancel** (and "don't show this
again"). Questions you type yourself never show it.

<!-- feature: show-and-tell -->

### Show & Tell: watch Ember work

Show & Tell is part of Hearth Premium (Settings, Premium). Without it, Settings, Ember, Show & Tell
says what it adds and how to get it, and Ember does everything else the same, in words.

**Settings, Ember, Show & Tell**: **Off** (the default), **Show me** or **Teach me**. While Ember
looks into something, Hearth opens what it is really reading (an app's panel, Storage & Files, a
page such as Machines) and rings the part that matters, with a short caption saying what to
notice. **Teach me** also explains why it matters. It works on any Hearth screen, including new
ones, because Ember picks from what is actually on screen. Ember only says "as you can see" when
the screen confirmed it; otherwise the caption says nothing could be highlighted.

**Ember's flame cursor** shows Show & Tell is at work: it appears (turning arcs) as soon as Ember
starts, glides to each thing, glows when it arrives, shows a text bar on text, and shows a ring
only when it really clicks. It gets around the way you would: it clicks the link, the tab or the
section that opens, and types into search and filter boxes. It never presses anything that saves,
approves, deletes or changes a setting: it points at it, says so, and those stay plans you
approve. Your own mouse pointer is unchanged.

On the caption: **Keep this open** (a panel Ember opened stays after it is done), **Stop
following** (Ember keeps working, the screen stays put), and close. **Stop following** pauses only
the walkthrough under way: **Following paused** with **Resume** shows beside the chat and in
Settings, Ember, Show & Tell, and the next question follows again by itself. Choosing **Show me**
or **Teach me** in Settings also resumes it. Only a clear "stop" or "cancel" (or the Stop button)
stops Ember; anything else typed while she works is added to the request. Ember's cursor uses one
Hearth window at a time (the one you last used): another window says **Showing on** (for example
"Chrome on Android") with **Show here instead**. When she can't show something, she says why in
one line and carries on. **Read captions aloud** uses
Ember's voice. **Tidy up afterwards** (on): once Ember answers, a card asks **Close what Ember
opened?** with the panels it opened; nothing closes until you press **Close them** (**Keep them**
leaves everything). Panels you kept or pinned are never offered, your own panels stay, and one
Ember switched to another tab goes back. Ask Ember to clean up and it brings up the same card
(it cannot close panels itself). In a demo Ember's cursor also opens items and photos, goes back
and presses **See all**, and presses Enter after typing in a search box. On a
phone the caption sits at the bottom and you come back to the conversation when it is done. Each
shown step is listed under the answer with **Show again**. Only one Hearth window presents at a
time, and only while it is visible.

**What Ember is doing, in words.** When a step has nothing to show (reading an app's API,
checking logs, looking a service up), a line at the bottom of the screen says what it is, the
same words as the step listed under the answer, while Ember's cursor works. It never moves or
clicks for something done through an app's API.

**Plans beside their setting.** When Ember proposes a change to something it showed you (a
Radarr profile's cutoff, say), the setting stays open when it finishes answering, ringed, with the
plan's card beside it: each setting's current and proposed value (read from the app when the plan
was made), why, and what changes if you approve. Approve or decline right there. While it runs,
Ember's cursor works beside it; afterwards the panel reads the app again, and the setting is
ringed once more only if Hearth's read-back matched what you approved ("Verified"). Anything else
is said plainly. **Done** tidies up; otherwise it tidies itself a few seconds later. The plan card
under the answer has **Show me** to put the setting back on screen. Show & Tell never approves
anything: the approve button is yours alone.

**Just looking.** Say so ("don't change anything", "just look", "read only") and that task is
look only: for that message and its follow-ups Hearth refuses every plan and change Ember tries,
and Ember runs without its shell, file edits or add-ons (whatever Full access says), with every
AI. Ask for the change in words ("go ahead and plan it") when you want it. Show & Tell on its own
never limits what Ember can do.

**Everyday questions run light.** A plain how-to ("how do I add a destination?", "what is a
quality profile?") is answered light, on the same model: reading tools and Hearth's own, without
the shell, file edits or add-ons, which keeps the answer quick and uses far fewer tokens. When the
question turns out to need real work, Ember switches to full mode by herself and answers the same
message again (the activity line says so). This works the same with Claude Code, Codex and Ollama.
A request to do something ("can you restart Radarr?") always runs in full.

<!-- feature: embers-browser -->

### Ember's Browser

When the web is the right way to do something (ratings, documentation, a download, or something
in one of your apps that Hearth has no control for), Ember uses **Ember's Browser**: a real
browser Hearth runs on this machine with its own profile (none of your logins, cookies or
history), closed and wiped after ten minutes unused. The page takes the panel's shape, so it fills
the panel at any size (a narrow phone panel shows a wider page, smaller). Open it from the row of systems in the Lair,
or it opens by itself while Show & Tell is on. The picture is the page itself, live; the orange
ring shows exactly where Ember clicked or typed, and the line under it says what she did last.
**Following Ember** keeps the view on her page; switch it off to look at another tab while she
keeps working. **Back**, **Forward**, **Reload**, the address box with **Go**, and **Close the
browser** are yours too.

What she may do there depends on the operation, not on it being a browser. On websites she
browses, searches, fills in and sends ordinary forms, and downloads (files go to Hearth's
downloads folder). Your systems in Hearth open in it too: signed in when you switched **Sign in
Ember's Browser** on for that app's web login in the Secure Vault (Hearth signs in itself and the
browser only gets the session; the password never reaches the page or the AI). Reading them is
free, and so is clicking around. When she saves a change in one of your apps (with Full access
off), Hearth holds it instead of sending it: the plan shows exactly what it changes, field by
field ("First Day Of Week: 0 to 1"). Approving it sends exactly that request once; Hearth then
reads the app back and says whether it is verified, and she shows you the result in the page.
An approval covers only that change: anything else she saves is held and shown on its own, a
held change expires after 30 minutes, and one the app changed in the meantime is not sent. With
Full access on, her changes are sent directly. She works the page as you would: links, buttons, dropdown lists, an app's
own pop-up menus, and keys such as the arrows, Enter and Escape. A lock above the page shows when
she is signed in to one of your apps. While you asked her only to look, nothing is sent. Protected
systems (VPN, proxy, firewall, Hearth) are never changed from it, other sites' pages can never
reach your apps, any other address on your network is refused until you add it to Hearth, she
never types a password, and an app's own secrets are hidden in what she reads. Each page she
reads is kept under her answer with its address and a short excerpt.

**When she needs you.** Ember never tries to get past a CAPTCHA or "are you human" check, and
never types a password. When a page needs one, she first looks for another source (for film
ratings, your Radarr or Sonarr lookup and Plex). If there is none, she hands you the page instead
of giving up: her answer and the chat say what she needs ("solve the check", "sign in"), with
**Open Ember's Browser**. A bar over the page says the same. Click on the live picture and it is
clicked on the page; type with your keyboard, paste, or use the **Type into the page** box (on a
phone too) and **Enter**. Then press **Give it back** and she carries on by herself from the page
as you left it. Nothing you type is recorded or shown to her. You can also press **Take over**
whenever you want the page for a moment: she waits until you give it back.

**When a site refuses her browser.** Some sites (IMDb, for one) refuse a browser that runs in
the background. Ember does not retry it the same way. She says so in a line and uses another
source she is allowed to: your own apps (for ratings, your Radarr or Sonarr lookup and Plex), an
official service, her own web search, or another reputable site, and she says where each fact
came from. If none has it, she asks to open that site in a normal visible browser window on the
machine Hearth runs on: **Open it**, **Always for** that site, or **No**. A visible window opens
only on a machine with a screen (a desktop session), uses its own empty profile like the
background browser, and is never disguised: if a site refuses it too, Ember leaves it and gives
you the link for your own browser, with an offer to walk you through it. Checks and passwords
still come to you through the hand-over. Sites you always allow are listed under the browser, each
with **Forget**.

**With Show & Tell on**, Ember adds a short caption under the page at the steps worth noticing,
and **Read captions aloud** reads them out.

### Ember using Hearth itself

Ask Ember to do something in Hearth and it does it, the way you would on the screen: start a
project ("make a project for the NAS move"), rename or finish one, add and tick off its tasks, and
the same for to-dos, release watches, the Lair's panels and layouts, workspaces, findings and
memory. It can read the rest of Hearth to answer you. The rest of Hearth (settings like the AI's name or
theme, services, notifications) it changes only through a plan you approve, showing each setting's
before and after, then reads it back. Never open to it, even with approval: sign-in, the vault,
credentials, access keys, its own permissions (agents, Full access, autonomy, automatic repairs,
host administration), approving plans, Hearth updates, pairing PCs or devices, and restores.
Everything it changes is in the audit log as Ember's.

<!-- feature: voice -->

### Voice

- **Mic** (dictation): your words appear in the box; sending turns the mic off.
- **Voice chat** (the waveform button): talk back and forth; replies are spoken. The **ear**
  button mutes listening (it still speaks). Listening pauses after a long silence; tap the ear.
- **Standard voice** (default): one built-in voice, downloaded once (about 500 MB), runs on the
  processor, works on any computer.
- **Advanced**: the five character voices (the Guardian, the Operator, the Enchantress, the
  Scholar, the Companion) on a speech machine running Piper (speaking) and Whisper (listening).
  Settings, Ember, voice: **Speech machine** (address and ports), **Hear a sample**, profiles
  (name, sounds like, personality).
- **Use this voice in Home Assistant**: offers the Standard voice over Wyoming (port 10210). In
  Home Assistant add the Wyoming Protocol integration with this PC's address, then pick Hearth as
  an assistant's text-to-speech.
- **Free up voice memory** stops the voice program now (it also stops itself after 10 minutes
  unused).

<!-- feature: personality -->

### Personality and look

Settings, Ember: **AI administrator name**, its picture (**Change picture** under the name: ten
Ember pictures, **Classic Ember** (the default), Chatty, Manager, Detective, Engineer, Gamer, IT,
Cosmic, Arcane and Cozy, or **Choose from your library** for your own; tap one to preview it, then
**Save**. A picture from before these, the older characters, shows as Classic Ember),
**Turn on persona** (in the same sheet, off by default: Ember talks in the personality of the
chosen picture, with one example line in its style shown before **Save**; for your own picture, a
box to describe its persona, empty meaning her normal personality. It changes how she talks in
conversation only, in the Lair and the War Room alike; plans, approvals, warnings and
notifications stay plain, and it never changes what she may do; a Remote Control session
starts again with the new persona, in the same conversation),
**Enthusiasm** (Calm, Warm, Lively), **Humor** (None, Light, Playful), **Technical detail**
(Simple, Balanced, Deep). Personality changes how it talks, never what it may do.

**Writing assistance** (Off, Basic, Enhanced): grammar suggestions as you type, offered, never
applied by themselves; technical text is left alone. This device only.

<!-- feature: conversations -->

### Ask page and conversations

While Ember is working, the list under your message shows each step as it happens (a command, a
file, a search) with how long the current one has been going ("still working, 1:20").
**Stop** beside the send button ends what it is doing at once, even if the AI does not answer;
sending a new message meanwhile stops the answer under way and sends yours next.

**Ask** keeps **Earlier conversations** and **New conversation**. The Lair's conversation list
searches them. A click opens one; **right-click** it (or press and hold) for **Rename** and
**Delete** (which asks first). Suggested questions for an empty conversation start with **What can Hearth do?**.

<!-- feature: thread-looks -->

### Thread Looks and "where did we talk about this?"

**New conversation** opens a window of small Ember pictures (in rows, scrolling up and down), each with a one-word name that hints at what the
thread is for: **Sprocket** (something's broken), **Brick** (projects and setting things up),
**Page** (media, what to watch), **Vinyl** (music), **Popcorn** (movie nights), **Warden**
(security), **Tutor** (how-to), **Ranger** (look around, change nothing), **Herald**
(notifications), **Ember** (no particular task), **Sleuth** (why did this happen), **Doc** (health
checks), **Keeper** (backups), **Sprout** (tidying storage), **Anvil** (custom panels), **Benson**
(home automation), **Parcel** (downloads and requests), **Pixel** (games), **Quill** (books),
**Lantern** (keep an eye on this), **Owl** (research) and **Dolly** (migrations). Tap a picture and
a **Name** box appears with its name filled in; keep it or type your own, then **OK** starts the
thread and the window closes (with the picture's name it becomes **Sprocket**, or **Sprocket 2**
when that name is taken). **No image**, first, starts a plain thread named by your first message,
unless you type a name. **Change picture** uses the same window, and its Name box renames the
thread too.

The picture shows only on the thread, in the conversation list and the chat's header: Ember stays
your Ember everywhere (name, picture, voice, personality). **Rename** a thread and it keeps its
picture; **right-click** it (or press and hold) for **Change picture**.

The search box (**Where did we talk about…**) searches the words of every conversation, not only
their names: type "Sonarr" and the threads that mention it show with the line that matched; a tap
opens the thread at that message. You can also ask Ember from any thread ("Where did we fix
Sonarr?") and she answers with the thread and a link to it. The search runs on your Hearth alone:
no AI, nothing leaves your lab.

<!-- feature: ai-budget -->

### What Ember looks after, and its budget

Settings, Ember:

- **AI use and limit**: **Model for questions** (your Claude Code's own model, Fable, Opus,
  Sonnet, Haiku; the same switch sits under the chat box as **Model**, and the War Room's
  options have their own per-message model), a daily limit in AI runs (**Most AI runs a day**), and **AI use by day** (runs and tokens).
  It starts with "Hearth never charges for AI. This shows how much of your own AI Ember uses.":
  today's use as **Light**, **Normal** or **Heavy**, questions today, runs this week, and each AI
  with its counts (Ollama says **Free, runs on your computer**). No money is shown, with one
  exception you choose: when Claude Code is signed in with an Anthropic Console account (billed
  per use), it says **This provider may charge you per use**, with **Show an estimated cost**
  (off at first; "Billed by Anthropic, not Hearth"). A limit set in dollars by an earlier
  version says **Your old limit from an earlier version is still on** until you set a new one or
  **Remove it**. Past the limit, answers come from records until midnight.
- **Administration**: what Ember can see and do on this machine (**Investigate** or
  **Investigate and propose changes**), the **Elevated executor** (a separate, narrow helper for
  root-only work such as drive health and file moves, installed only by you).
- **Tools and capabilities**: what it found missing while working.

<!-- feature: agents -->

### Agents page

**Agents**: **Your operator** (the connected AI service), **Hand unresolved incidents to the
operator** (once per incident, never where autonomy is Monitor), **It can** / **It cannot**,
**Disconnect**, **Recent work**, and **Other agents** (Codex, Ollama: **Use this one**). Each
agent keeps the same memory and access.

---

## 6. Your systems

<!-- feature: services -->

### All services

Systems, **All services**: every watched service with status. **Filter services** (All, Needs
attention) and **Search services**.

<!-- feature: service-panel -->

### A service's panel

Click a service (sidebar, Lair, or All services). The app's own tabs come first (**Overview**,
**Diagnostics**, and any deeper tabs the app has). Hearth's own tools for the service (**Health**,
**Logs**, **Terminal**, **Files**, **Settings**, **Notes**, **History**) are in the **Hearth**
menu at the end of the tab row; while one is open the button says so (**Hearth: Logs**) and is
underlined like a tab. The navigation follows the panel's room: a narrow column on the desk shows
one sections button that opens the list; a normal panel shows a row of tabs with the Hearth menu;
a wide or maximized panel shows the list down the left side, with **Hearth** as a group that folds
open; a phone shows the row of tabs and scrolls it. The tab you were
on, and the section inside it (Radarr's **Missing**, say), is part of the panel's address, so a
link, a saved layout or a refresh opens the same place: `?panels=service:radarr@overview/missing`.
A panel hidden behind an expanded one stops refreshing until it is shown again, and panels that do
not fit wait as chips without loading anything.

Tabs:

- **Diagnostics** (for apps Hearth knows): what the app itself reports. **Needs attention**,
  **Working on**, **Lately**, **Connected to**, plus the app's own dashboard (see section 7). If
  it needs its key: **Paste the API key** (straight into the vault) or **Find my keys**.
- **Overview**: container, host, image, address, category, **Autonomy** for this service,
  **Availability, 30 days**, **Right now** (uptime, ports, CPU, memory, **Restarts by Docker**,
  **Hearth's own check**), **Incidents**.
- **Health**: checks over time, **Restarts and stops**, **Resource use over time** (CPU and
  memory; needs resource history on in Settings, Monitoring).
- **Logs**: read live from Docker, secrets hidden, never stored. **Time range** (Latest, 1 hour
  to 7 days, Custom), **Only lines containing**, **Read the logs again**, **Ask** about a line.
- **Terminal**: captured output of what Hearth ran or read (there is no live shell here).
- **Files**, **Settings**, **Notes**, **History**.
- **Actions**: **Restart** (recorded and verified), **View recent logs**, **Recent actions**. A service that is down or degraded (not stopped on purpose) also shows **Ask Ember why it is down** (or degraded), which hands the question to the conversation.
- **Watching**: **Pause watching** (turned it off on purpose? say why, so it is not a failure),
  **Watch it again**, **Remove** (Hearth stops watching; the app is not touched).
- **Practice** (sample data only): **Make it fail**, **Fail so a restart won't help**, **Slow it
  down**, **Break what it depends on**, **Back to normal**, to see how Hearth reacts.

<!-- feature: machines -->

### Machines

Systems, **Machines**: **Your machines** with processor, memory, uptime, Docker and storage;
machines **Over the network** with address, services and **Last answered**. **Add another
machine** watches apps on another computer by address. **Scan again**.

<!-- feature: memory-breakdown -->

### Where the memory goes

**What's using memory** under a machine's memory bar (every PC, Linux and Windows): one bar for
the whole machine (containers, Hearth, apps, the system, cache, free), then every app, container
and part of Hearth by size. An app's processes count as one row (a browser's many tabs). Each row
says **Stays** and why when Hearth will not stop it (the system, networking and remote access,
terminals and AI sessions, servers your other devices use), or offers **Close**, **Stop** or
**Free**. **Quick win** frees the safe part in one approval: Hearth's voice when it is loaded, and
test or preview containers (or ones you paused) that are still running. **Ask Ember what else can
go** has Ember look and propose one plan for the rest. An app closes the normal way, so it can
ask about unsaved work; Hearth then checks it is gone. A full swap is called out.

<!-- feature: add-remove-system -->

### Add or remove a system

**Add a system** (for anything discovery missed): a container (exact Docker name), an app with a
web address (Hearth checks it answers), or something else. **Remove from Hearth** stops watching
(history stays; a scan will not add it back). **Removed systems** (Settings, Systems) brings one
back.

---

## 7. App panels

Each panel reads the app live with its key from the Secure Vault. Changes are plans you approve
(or direct with Full access). Every list has **Ask** / **Ask Ember** buttons that send the item
to Ember with its details.

<!-- feature: arr-panels -->

### Sonarr and Radarr

Tabs: **Queue**, **Download trail**, **Missing**, **Coming** (next 7 days), **Upgrades**,
**Collections** (Radarr), **Find**, **Search releases**, **Recently imported**.

- **Download trail**: each download from grab to library: Grabbed, Downloading, Importing, Not
  imported, In the library, Renamed, Did not finish, with its folders. A failed one has **Ask
  Ember**, which sends the whole trail.
- **Search releases**: find a title already in the app (Sonarr: a season or one episode), see
  every release every indexer offers with the app's verdict, and **Download this**, confirmed in
  place. Chaptarr's search also lists what its own search finds that isn't in your library yet,
  with **Add in Chaptarr**; once it is added, it can be searched here.

<!-- feature: crucible -->

- **The Crucible: Quality & Size** (in the Lair once Radarr or Sonarr is connected): the
  picture you want at a size you're happy with, in plain words. With nothing saved it opens on
  the **Balanced** rules, unsaved; **No limits**, **Storage-smart** and **Answer a few questions**
  sit above them to start from instead. **Everyday** shows each rule as a sentence with a switch
  ("Movies released in the last 2 years get 4K up to 40 GB, else 1080p up to 15 GB"): tap any
  dashed part to change what it means (what counts as old, new, a classic, a genre, a size), **+**
  adds a condition or a lower quality, and the first rule that fits a movie wins, so move the
  ones that matter most to the top. **Add a rule** offers ready-made ones (new releases get the
  best, older movies smaller, classics, a decade, kids, a genre, long movies), a blank one, or
  **Say it in your own words**: Ember asks what you mean by vague words and adds a suggestion you
  can add or ignore (she never saves it). **Suggest rules from what I watch** does the same from
  your history. Where two rules both fit some movies, it says which wins and offers **Let X win
  instead**. The preview finds any of your movies, shows its rule and **Why?**, and how much space
  your rules would use against today. **Expert** shows every condition (months since digital
  release, years, rating, length, genres to leave out, original language, **Any one condition is
  enough**), each rule's on switch, and saving or loading the rules as a file. **Follow age**
  (on unless you untick it) moves a title to its new rule as it gets older, once a day, only when
  it has no file yet or its file already fits. Shows have an **SD (DVD)** step too. Each rule is a group of movies
  (by how old, how new, popular right now, genre or Radarr tag; the first row that fits wins, the
  last takes the rest) and a ladder: the quality it tries first and the most it may cost in GB,
  then the next step down, so not finding 4K never means not getting the movie. Each step says
  what sizes are usual; each row says how many of your movies are in it and how many are bigger.
  **Upgrade later** replaces a download when a better one that fits turns up. **Save** is one plan
  you approve, showing what changes in Radarr first; **Also move the movies I already have** is
  separate and off unless you tick it (files already downloaded stay). Undo puts everything back.
  **Give new movies their row automatically** (on unless you untick it): Save also sets up Radarr
  to tell Hearth the moment a movie is added (a webhook to the address you opened Hearth from, with
  a private key), so it gets its row's profile at once, a Seerr request included; a check every
  few minutes catches any Hearth missed. Each new movie once, so one you later change by hand
  stays as you set it. Each is in the audit log and the journal.
  **The Crucible is the checkpoint for every request.** Requests made in Hearth (Curator, Ember,
  Add movie) go to Radarr already on their row's profile. Seerr searches the moment it adds a
  movie, before the Crucible can sort it: **Let the Crucible start Seerr's searches** (one plan you
  approve, with Undo) turns Seerr's automatic search off and makes Seerr add requests on
  **Hearth · Waiting for the Crucible**, a profile on which nothing can be grabbed, not by a search
  and not by Radarr's RSS sync. The Crucible then gives each its row and starts the search, so the
  first search uses the right profile. If Hearth is down, requests wait there, shown as **Waiting
  for the Crucible** in the Radarr panel and the Crucible, and are caught up when it's back.
  **Nothing is ever left waiting.** Turning the checkpoint off, unticking automatic sorting, Undo
  and uninstalling Hearth all hand requests back first: Seerr searches by itself again with the
  profile it used before, and every waiting movie gets its row (or that profile) and is searched.
  Undo of Save waits until the checkpoint is off. Uninstalling from inside Hearth (PCs > Uninstall)
  does this before anything is removed; if it can't finish, Hearth isn't removed unless you say so.
  Removing Hearth with its installer's --uninstall warns you, because it can't hand them back. A movie added in Radarr's own page with "Start search" ticked
  is sorted at once, but that first search may already have used the profile it was added with.
  Radarr's own Settings tab marks the Crucible's profiles and formats **Managed by The Crucible**.
  The Crucible makes Radarr's own profiles and formats, named "Hearth · ...", so Radarr follows
  them even when Hearth is off; it never touches profiles you, Recyclarr or Profilarr made. If a
  Hearth profile is changed in Radarr itself, the Crucible asks whether to keep that change or put
  its own back. **Advanced** lists exactly what it makes.

<!-- feature: near-miss -->

- **Why isn't it grabbing?** (Radarr and Sonarr): when nothing the indexers offer passes your
  rules, the search says so in plain words: nothing found at all, or found but turned down by your
  own rules, and why (for example "All are only over your size limit of 8 GB. Closest: 8.9 GB
  Bluray-1080p."). **Grab it anyway** downloads that closest one, once, for that title only, after
  you confirm; your rules stay as they are. Ask Ember "why isn't Radarr grabbing ...?" for the
  same answer.
- **Upgrades** / **Quality now**: movies below their profile's quality; pick a few to search
  (searching all at once would download a lot).
- **Collections**: collections you own part of that are missing a released movie.
  **Wait for 4K before settling for 1080p** (on a row with more than one step: No wait, 6 hours,
  1 day, 2 days or 1 week): Radarr holds off the lower step that long, and stops waiting as soon
  as the first quality turns up. It's a Radarr delay profile on the tag hearth-wait-<row>, which
  the Crucible puts on that row's movies when it gives them their row.
  **When two releases are the same quality, take the smaller one** (movies; on unless you untick
  it): size bands (for example 1080p under 4, 8 and 12 GB) each add 1 to a release's score, so
  Radarr picks the smaller of two equal releases. Upgrades still need a bigger improvement, so
  this never re-downloads anything on its own. Shows leave it out: a season pack's size is its
  total, so a band would wrongly favour single episodes.
  **Shows** (the second tab, Sonarr) works the same way, per episode: each row's ladder chooses
  its qualities, and the last row's sizes ("up to 2.5 GB an episode") become Sonarr's own size
  limits for every show. Those count minutes, so a season pack is judged per episode and shorter
  episodes get proportionally less. If Recyclarr or Profilarr manages Sonarr's sizes, the plan
  says so and leaves them alone. New shows and Seerr's TV requests get their row the same way,
  including the request checkpoint.
  **Near misses** (below the rows): once a day the Crucible searches a few movies that have been
  missing a while (**Check up to** 10 a day, missing at least 7 days, oldest first, each at most
  once a week; nothing is downloaded) and says which case it is: nothing exists, something fits
  (Radarr should take it), or your own rules turned every release down. When the only reason is
  size it names the closest one, with **Grab it anyway**: a one-time download you approve, your
  rules unchanged. **Check now** runs the same check straight away. **Tell me in Needs you and the
  bell** (off unless you tick it) raises one note per Radarr when a movie is held back by your
  rules. Download Health shows the same list under **Held back by your own rules**.

<!-- feature: radarr-panel -->

### Radarr's own tabs

Radarr's panel has its own tabs after **Overview** and **Diagnostics**, so Radarr's own web page
is rarely needed. Every change shows the exact before and after and waits for your approval
(**Review change**), then Hearth checks Radarr took it. Ember makes the same changes the same way.

- **Overview**: **Right now** (what needs you, what is downloading, what just arrived, each
  opening its tab), the library at a glance, and **Coming**, **Upgrades**, **Collections**,
  **Find** and **Search releases**. Old links to Overview's queue or missing list open Activity
  or Wanted. A health warning Hearth knows how to fix has a link straight to the setting (for
  example **Open indexers**, **Open download clients**, **Open root folders**), which opens with
  that part outlined.
- **Library**: **Add a movie** (Radarr's own search; pick the root folder, quality profile,
  monitoring, minimum availability, tags, and whether to search straight away). Every movie as
  a list or posters; search, show missing, downloaded, not monitored
  or not released yet; filter by quality profile or tag; sort. Tick several to monitor, stop
  monitoring or change their profile together. A movie opens on its own page: details, file,
  history, its settings (monitored, quality profile, minimum availability, tags), **Search now**,
  **Pick a release**, **Refresh**, **Rename files**, **Delete this file**, and **Remove from
  Radarr** (deleting its files is a separate tick).
- **Activity**: **Queue** (stuck and failed downloads with their fixes, Download trail,
  Recently imported), **Import files** (type a folder as Radarr sees it, **Look**, choose the
  movie for each file or skip it, move or copy, then **Review import**), **History** with a
  filter, **Blocklist** with **Remove**.
- **Wanted**: **Missing** and **Below cutoff**; search one, or **Search all**.
- **Settings**: **Quality profiles** (allowed qualities, upgrade until, custom format scores,
  Copy), **Custom formats** (conditions, and a box that asks Radarr itself what a release name
  matches), **Quality sizes** (minimum, preferred and maximum size per quality in MB per minute;
  empty means no limit; **Review changes**), **Tags and delays** (tags, delay profiles, release
  profiles), **Files and naming** (naming, importing and deleting, root folders), **Exclusions**
  (movies import lists never add: find one and **Exclude**, or **Remove**), **Connections**
  (download clients, indexers,
  notifications, import lists: switch on or off, ordinary settings, remove). Passwords and keys
  stay hidden; adding a connection or changing its password is done in Radarr for now.
- **System**: health (with the same link to the fixing setting, and **Ask Ember to fix it**), version, disk space, **Tasks** with **Run
  now**, **Backups** with **Back up now**, and Radarr's **Log**. Updating Radarr, its login and
  its API key stay in Radarr.

A Radarr version Hearth was not built for (not 6.x) shows these tabs read only, with a note.

<!-- feature: prowlarr-panel -->

### Prowlarr's own tabs

Prowlarr's panel has its own tabs after **Overview** (failing indexers first, **Test all**,
switching one off) and **Diagnostics**. Every change shows the exact before and after for your
approval and is read back afterwards; Ember uses the same steps.

- **Indexers**: every indexer with how it is doing this week (searches, grabs, failures, speed),
  failing ones first; **Test**, **On**/**Off**, **Test all**, **Push to apps**. An indexer opens on
  its own page: switches, priority, **Sync profile**, tags, its ordinary settings (logins and keys
  only as set or not set) and its recent activity, with **Review change** and **Remove**.
  **Add an indexer** searches Prowlarr's list of sites by name, kind (public, semi-private,
  private) and torrent or usenet; a site marked **Needs a login or key** must be added in
  Prowlarr for now, since Hearth does not send logins or keys from a plan yet.
- **Search**: one search across every indexer (or the ones you tick), anything, movies or TV,
  sorted by seeders, size or newest; **Download** sends a result to the download client after you
  approve. Download links never reach the page, because they carry keys.
- **History**: every search, RSS check and grab, by indexer and kind.
- **Settings**: **Apps and sync profiles** (how each app is synced: full, add and remove only, or
  off; **Push indexers now**; sync profiles for RSS, automatic and manual searches and the fewest
  seeders), **Connections** (download clients, indexer proxies such as FlareSolverr,
  notifications) and **Tags**. Adding an app needs its API key, so that is done in Prowlarr for now.
- **System**: the same as Radarr's: health, version, **Tasks** with **Run now**, **Backups**, and
  Prowlarr's **Log**, with keys hidden.

A Prowlarr version Hearth was not built for (not 2.x) shows these tabs read only, with a note.

<!-- feature: sonarr-panel -->

### Sonarr's own tabs

Sonarr's panel has the same kind of tabs after **Overview** and **Diagnostics**. Every change
shows the exact before and after for your approval and is read back afterwards; Ember uses the
same steps.

- **Overview**: **Right now** (what needs you, what is downloading, what just arrived, each
  opening its tab), Sonarr's health with links to the setting that fixes each warning, **Next 7
  days** and **Search releases**. The queue and missing episodes live in Activity and Wanted.
- **Library**: every series with how many of its episodes are on disk, search, filters (missing
  episodes, complete, still airing, ended, not monitored) and sort. **Add a show** uses Sonarr's
  own search: choose the root folder, quality profile, what to monitor (every episode, future
  episodes, missing, the first or latest season...), series type and season folders.
- A series' page: **Search missing**, **Refresh**, **Rename files**, its settings (monitored,
  quality profile, series type, new seasons, season folders, tags), **Seasons** (tick which seasons
  are monitored, then **Review season monitoring**; **Search** or **Pick a release** for a season),
  each season's episodes (monitor or stop monitoring one, search, pick a release, delete its file),
  history, and **Remove from Sonarr** (deleting its files is a separate tick).
- **Activity**: the queue, **Import files** (Sonarr's own match for each file, or choose the
  series and episode), history and blocklist.
- **Wanted**: **Missing** and **Below cutoff** episodes; search one, or **Search all**.
- **Settings** and **System**: the same as Radarr's, reading Sonarr (episode naming formats, season
  folders, import list exclusions by show).

A Sonarr version Hearth was not built for (not 4.x) shows these tabs read only, with a note.

<!-- feature: lidarr-panel -->

### Lidarr's own tabs

Lidarr's panel has its own tabs after **Overview** (the queue, download trail, missing albums and
release search) and **Diagnostics**. Every change shows the exact before and after for your
approval and is read back afterwards; Ember uses the same steps.

- **Library**: every artist with how much of their music is on disk; find, filter (missing music,
  complete, not monitored) and sort. **Add an artist** uses Lidarr's own music database: choose
  the root folder, quality and metadata profiles, what to monitor and what to do with new albums.
  An artist opens on its own page: **Search missing**, **Refresh**, **Rename files**, **Settings**
  (monitored, quality profile, metadata profile, new albums, tags), **Albums** (tick to monitor,
  **Search** one, open its tracks and files), history, and **Remove from Lidarr** (deleting files
  is a separate tick).
- **Activity**: **Import files** (type a folder as Lidarr sees it, **Look**, tick the files Lidarr
  matched to an album's tracks, move or copy, **Review import**), **History** and **Blocklist**.
- **Wanted**: **Missing** and **Below cutoff** albums; search one, or **Search all**.
- **Settings** and **System**: the same as Radarr's, reading Lidarr (track and artist folder
  naming, music quality profiles, import list exclusions by artist).

A Lidarr version Hearth was not built for (not 3.x) shows these tabs read only, with a note.

<!-- feature: books-music-panels -->

### Lidarr, Chaptarr (books), Readarr

**Queue**, **Download trail**, **Wanted** (Audiobooks, Ebooks), **Coming** (next 14 days),
**Authors**, **Search releases** (Chaptarr's hidden results, such as collections and packs, are
listed and marked **Hidden by Chaptarr**), **Recent activity**, **Stop wanting**, **Find an
author**.

<!-- feature: seerr-panel -->

### Overseerr / Jellyseerr / Seerr

Tabs: Overview (requests), Discover, Issues, People.

**Discover**: search, and under it (when nothing is searched) three rows of posters you scroll
sideways: **Trending movies**, **Recently released movies** (out in the last 60 days),
**Upcoming movies** and **Trending shows**, from Seerr's own lists (Overseerr 1.x too). Each says **Available**, **Requested**, **Processing**
or **Not requested**; **Hide what I have** (remembered) takes out what you own; **See all** pages
through a row. Tap a poster for its details (release, runtime, genres, TMDB rating, description)
and **Request** it (a show's seasons first): a plan you approve, never a request by tapping.
The details ask where it goes, as Seerr's own request box does: **Quality profile** and **Root
folder** (with free space), Seerr's defaults chosen to start with; the plan says what you picked.

**Movies** and **Shows**; **My requests** or **All requests**. Each request shows **In
cinemas**, **Digital** release dates, and what Radarr or Sonarr is doing. Filters: **Overdue**
(digital release passed, not grabbed: amber), **Needs a look**, **Waiting**, **Downloading**,
**In your library**. Sort by newest request, digital release, status, **Most overdue**.

- **Goes to**: change the root folder (**Move its files too**) or quality.
- **Stop tracking**: removes the request from Overseerr and stops Radarr (or Sonarr) monitoring
  it. The movie and its files stay. When Radarr or Sonarr already has it downloaded, Hearth first tells Seerr
  it is in your library, so Seerr doesn't go back to "not requested" (Seerr resets a title when
  its last request is removed before Seerr's own library scan caught up).
- **In your library**: Discover and search check Radarr and Sonarr too. A movie Radarr has that
  Seerr shows as not requested says **In your library**, with **Tell Seerr you have it** (marks it
  available in Seerr, so nobody requests it again by mistake) and **Request anyway**. A request
  for something you already have says so in its approval.
- **Retry**: on a request Seerr could not hand to Radarr or Sonarr; sends it again.
- Discover: **Find a movie or show** the way Seerr does, then **Request** a movie, or **Choose
  seasons** of a show (both open its details, with the quality profile and root folder) (seasons already in or requested are ticked and greyed). Each request is a
  plan you approve; one already requested is refused, and a retried plan never asks twice.
- Issues: **Open**, **Resolved**, **All**. Open one for its conversation: **Comment** (up to 200
  characters), **Resolve** or **Reopen**, **Delete**.
- People: who can request, how many requests each made, their limits. Permissions and limits are
  changed in Seerr (**Open Seerr's users**).

<!-- feature: media-server-panels -->

### Plex, Jellyfin, Tautulli

- **Who is watching**: each stream, with **Stop stream** and an optional **Message to show
  them**.
- **Libraries** with what is in them and **Scan**; **Library activity**; **Recently added** with
  posters. Jellyfin's Overview is laid out like Plex's.
- Jellyfin: **Tasks** tab, its scheduled tasks (**Run now**, **Stop**, **Turn on/off**); a failed
  one is flagged on the Overview.
- Plex: **Link Plex** signs Hearth in with your Plex account (what it grants is shown first).
- **Scan libraries**: rescans as a confirmed plan.

<!-- feature: jellyfin-panel -->

### Jellyfin's own tabs

Jellyfin's panel opens on **Home** (its home screen, above) and has its own tabs after
**Overview** (totals, who is watching, libraries, recently added), laid out like Plex's: **Library**, **Tasks** (scheduled tasks), **People**, **Devices**,
**Activity**, **Manage**, **Plugins**, **Settings** and **Logs**.
Every change shows the exact before and after for your approval and is read back afterwards;
Ember uses the same steps. Passwords, API keys and networking settings stay in Jellyfin.

- **Library**: each library's titles with posters, a search that filters as you type, a sort
  (**Recently added**, **Title**, **Year**, **Recently watched**) and **Not watched**. Open a title
  for its details and files, with **Mark watched** (or **Mark unwatched**), **Refresh details**
  and **Edit details** (title, sort title, year, summary; Jellyfin keeps them when it refreshes).
  A show opens to its seasons, a season to its episodes. **Scan** scans that library.
- **Manage**: every library with its folders. **Add a folder** (a path as Jellyfin sees it, checked
  with Jellyfin first), **Stop reading it**, **Remove** a library, **Add a library** (a name, a kind
  and a folder), **Scan** and **Scan all**. Files are never deleted.
- **Plugins**: what is installed with its version, **Update to** when a newer version this
  Jellyfin can run is out, **Disable**, **Enable** and **Remove** (plugins that come with Jellyfin
  can only be disabled). The **Catalog** below lists plugins to **Install**, with a search. Plugin
  changes finish when Jellyfin restarts: a banner offers **Restart Jellyfin** (anyone watching is
  cut off for about a minute).
- **Settings**: the everyday ones, collected and sent as one plan (**Review changes**): server
  name, metadata language and country, collections, specials, the streaming limit away from home,
  and video converting (hardware acceleration, hardware encoding, tone mapping); **Show advanced**
  adds resume points, encoding speed, throttling and how long logs are kept.

- **People**: everyone who can sign in, what they can reach and when they were last seen.
  **Change access** picks **All libraries** or some, and **Allow downloads**; **Review access**
  asks for your approval. **Disable account**, **Enable account** and **Remove** are there for
  everyone except an administrator, which Hearth never disables or removes.
- **Devices**: the apps and devices signed in, with **Sign out**.
- **Activity**: Jellyfin's own record of sign-ins (including failed ones), playback and changes.
- **Logs**: Jellyfin's log files, read with keys and tokens hidden.

<!-- feature: emby-panel -->

### Emby

Emby speaks Jellyfin's API (Jellyfin began as Emby's free version), so Emby gets every one of
Jellyfin's tabs with Emby's name: **Overview** (who is watching and whether it converts, and why;
libraries and counts; recently added), **Library** (browse, open a title, mark it watched, edit its
title, sort title, year and summary, refresh it), **Tasks**, **People** (turn someone off or on,
which libraries they can open, remove an account; never an administrator), **Devices** (**Sign
out**), **Activity**, **Manage** (add a library or a folder, stop reading a folder, remove a
library; files stay on disk), **Plugins**, **Settings** and **Logs** (keys hidden). Give Hearth an
Emby API key (Settings, Advanced, API Keys). Differences from Jellyfin: Emby has no switch to turn a
plugin off (remove it instead), **Settings** shows the settings Emby has (it names some its own way
and lacks a few), and Emby's plugin catalog is read from Emby's site, so installing from it needs
Emby to reach the internet.

<!-- feature: media-home-tab -->

### Home: the home screen, where Plex, Jellyfin and Emby open

The Plex, Jellyfin and Emby panels open on **Home**: the home screen laid out as that server
shows it. Each row has its name, then a line of posters with the title and year under each, which
scrolls sideways (drag, or the arrows at the ends). Jellyfin and Emby keep a home screen per
person: pick whose at the top. Nothing is changed here: **Change rows** opens **Home rows** for
that server. **Refresh** reads it again from the server, so a row you just made or moved in Home
rows, or a movie or show that just landed in Recently Added, shows at once. **Read just now** (or
how long ago) says when it was read.
**Overview** is the next tab.

<!-- feature: plex-panel -->

### Plex's own tabs

Plex's panel has its own tabs after **Home** and **Overview** (who is watching, libraries, scans,
duplicates).
Every change shows the exact before and after for your approval and is read back afterwards;
Ember uses the same steps. Sharing, users and remote access need your plex.tv account, and
networking settings and anything with a password stay in Plex (shown locked, with a link).

- **Library**: pick a library, find a title, sort, or show only what is not watched. A title opens
  on its own page: **Mark watched** / **Mark unwatched**, **Refresh details**, **Edit details**
  (title, sort title, year, summary; Plex keeps them when it refreshes), **Add to a collection**
  (pick one of the library's collections or type a new name; one approval), its files, and a show's
  seasons and episodes (mark a whole season watched). **Scan** and **Empty trash** (entries for
  files already gone from disk; files are not touched) are under the titles.
- **History**: what was watched, by whom and when.
- **Tasks**: what Plex is working on now, **Clean bundles**, **Optimize database**, and Plex's
  scheduled maintenance with **Run now**.
- **Manage**: Plex's Manage Libraries page. Your libraries with **Scan** (or **Scan all**), and
  **Merge Recently Added Items**. Pick a library to see its rows (Continue Watching, Recently
  Added, your collections) and tick where each shows: **Library Recommended**, **Home**,
  **Friends' Home** (a tick in the header does every row). The arrows change the order. Changes
  collect until you **Save**: one plan for them all; **Undo** drops them. **Who has access**: each
  friend and Plex Home member with the libraries they can see (**All libraries**, or tap for which
  ones), and invites not accepted yet, read from plex.tv with your server's own Plex token (it is
  sent to plex.tv and your server, nowhere else; emails are never shown). **Change sharing in
  Plex** for changes.
- **Settings**: Plex's server settings as Plex lists them, everyday ones first, **Show advanced**
  for the rest, and a search. Change any number, then **Review changes**.

<!-- feature: home-rows -->

### Home rows

Build your Plex home screen. Open **Home rows** in the Lair (or **Design it in Home rows** on
the Plex panel's Manage tab). The **Home** tab of the Plex, Jellyfin and Emby panels shows the
result as the server lays it out, with **Change rows** to come back here. On a wide Home rows panel you see both halves; on a narrow one they are two
tabs, **Your Home** and **Add a row**.

**Your Home** shows every row in the order Plex shows it, library by library, with posters.

- **Move up** and **Move down** reorder rows; **X** takes a row off Home (it comes back from
  **Taken off**).
- The sliders button opens **Who sees it**: **Me** (your Home), **Friends** (Friends' Home) and
  **In the library** (the library's own page). Plex rows are shared by everyone on the library.
- Rows Ember made carry an **Ember** badge, with **Change titles with Ember** and **Delete row and
  collection**.
- A collection you keep by hand has **+** (**Add a title**): search the library, pick the title,
  approve, and it joins the collection and its row.

**Add a row**:

- **Ask Ember for a row** and **Make a collection**: Ember asks what it should be, about how many
  titles, and movies, shows or both (a collection also asks whether it goes on Home). Then Ember
  picks from your library and lays them out in the Forge to keep or swap; the plan shows up
  under **Ember is building** for you to approve. A theme with movies and shows becomes one row
  per library with the same name, because Plex keeps libraries apart.
- **Quick picks**: Plex's own rows (Recently Added, Recently Released, Continue Watching,
  Rediscover and the rest). Pick one, then the library.
- **Your collections**: every collection on the server. Choose one and **Add**.
- **Ideas** and **From your apps** (only apps you have): tap one and Ember builds it.
- **Something else?**: search your collections, or **Ask Ember to make** whatever you typed.

Nothing changes on Plex while you arrange. Changes collect in the bar at the bottom: **Undo all**,
or **Save to Plex**, which shows exactly what will change and is one approval. Hearth reads it
back from Plex afterwards.

**Merge rows on Home** (under Your Home, when you have two or more libraries of a kind): a
merged row shows the titles from several libraries in one row, each title once. Recently Added and
Recently Released are separate choices, and both start as a row per library.

- **Recently Added**: pick **Separate row for each library** or **One merged row**. This is Plex's own Merge
  Recently Added, so it covers every library on Home (one row for movies, one for shows). With it
  on, the duplicate Recently Added rows come off by themselves; there is nothing to set.
- **Recently Released** (one list for your movie libraries, one for your show libraries): open it
  and tap the libraries whose Recently Released you want in one row; they light up, and a second
  tap takes one out. The rest keep their own.

Each has a tag, **Saved in Plex** or **Changed, not saved yet**, and your rows below change as you
tap. Plex changes only with **Save to Plex**, together with your other changes.

Plex has no setting for one Recently Released row (every row reads one library), so Hearth adds
the merged libraries' folders to the one whose rows show (no file moves; you can choose which under
**Rows show under**), and sets the others' Visibility to "Exclude from home screen and global
search": they stay in the sidebar and open as before. Because they are then one library, their
Recently Added is one row too; the card says so. Changing **Rows show under** on a saved merge
moves the rows to the other library in one step, as often as you like (each library changes once,
so Plex is never mid-scan between two changes). A library that leaves Home this way never takes
your own rows with it: each collection row it had on Home or Friends' Home (a Christmas row, say)
is made again in the library that shows the merged rows, with the same films, places and order,
once Plex has scanned them in. Plex also lists films new to a library as added today, so as it
scans them in Hearth gives each film its own added date back and Recently Added never fills with
old films. The card names the rows that come along before you save. **Go by home release, not theaters** (on the movies' Recently Released card) makes Recently Released count a film as released when it came out to watch at home: Hearth sets each film's release date in Plex to Radarr's digital date (else its disc date) and locks it, skipping re-releases (a home date more than a year after the film first came out), and does the same for new films every few hours. Plex shows that date on the film's page too. Turning it off puts every date back. Taking a library out moves its folders back; Plex
then rescans, which can take a few minutes. A merge made before 11-09 (folders only, every film
listed twice) shows a warning. Merging a 4K library warns that friends streaming from outside the
home may be offered the 4K copy.

**Saved home screens** (at the top of Your Home): name the home screen as it is now, build
another, and switch between them; rows are only shown or hidden, never deleted. **Undo last
switch** puts the one before back.

Hearth finds its own collections by Plex's ids, never by name, so your own collections are never
changed.

**Jellyfin**: pick your Jellyfin at the top of Home rows (or **open Home rows** on the Jellyfin
panel's Manage tab). Jellyfin builds each person's home screen from its own sections, so here you
choose **Whose home screen**, then:

- Move Jellyfin's sections (My Media, Continue Watching, Next Up, Recently Added and the rest) up
  and down, take them off with **X**, or add them from **Add a section**. Each shows the posters
  it would show that person now.
- Under **Libraries**: their order, which ones get a **Recently Added row**, which are **In My
  Media**, and whether watched titles stay out of Recently Added.
- **Give this home screen to others too** sends the same home screen to the people you tick.

**Save to Jellyfin** shows exactly what changes, person by person, as one approval, and Hearth
reads it back. **Undo** puts what was there back. Jellyfin apps pick it up the next time they open
the home screen. If the community plugin Home Screen Sections is switched on, it draws the home
screen instead, and Hearth says so at the top. A row of one collection needs two community
plugins, Home Screen Sections and Collection Sections; Hearth will set those rows up in a later
update.

**Emby**: pick your Emby at the top of Home rows (or **open Home rows** on the Emby panel's Manage
tab). Emby 4.8 and later keep each person's own rows, so here you choose **Whose home screen**,
then:

- Move rows up and down, take them off with **X**, or put Emby's own back from **Add one of
  Emby's rows** (My Media, Continue Watching, Latest Media, all collections, recently released
  movies and the rest). Each shows the posters it shows that person now.
- On **Latest Media**, untick a library to leave it out.
- **Make a row of your own**: **Titles you pick** (find titles by name; Hearth makes them a
  collection, then a row of it), **By filters** (movies or shows, a genre or tag, only unwatched
  or favorites, in the order you choose), **A collection** or **A playlist** you already have.
  Rename your own rows in place.
- Under **Libraries**: their order and which are **In My Media**.
- **Give this home screen to others too** sends the same rows to the people you tick.

**Save to Emby** is one approval, read back after, and **Undo** puts the rows back (a collection
Hearth made stays in Emby). An Emby older than 4.8 gets the Jellyfin editor above, which it
shares.

Emby, row schedules and rows that keep themselves up to date come later.

<!-- feature: curator -->

### Curator

Find something to watch, read or listen to. Open **Curator** in the Lair (it appears once Seerr,
Lidarr or Chaptarr is connected).

1. **What are you here for?** **Something new**, **Fill a gap** (a kind of title you have few of,
   such as kids movies), **Complete a niche** (the best titles in something you collect, such as
   time loop movies), or **Go deeper** (more of a genre you like).
2. Pick **Movies**, **Shows**, **Books**, **Audiobooks** or **Music**, say what you want, and add
   filters if you like: **From year**, **To year**, **Rated at least**, **Length**, and genres.
3. Choose what to show: **Missing from my collection**, **In my library** (what to watch
   from what you own; Hearth then sends Ember the names and years of your titles, nothing about
   who watched what), or **Both**.
4. Tick **Think outside the box** for adjacent titles too: ones with the same feel, season and
   heart that aren't strictly on theme (family snow films for Christmas, cozy autumn family films
   for Thanksgiving). Curator answers "On it", and each adjacent pick says how it connects.
5. Press **Find**. Ember suggests titles, each with a one-line reason.

**For You** is the second tab: what to watch next, from your own watch history.
Only your own Plex account is used; other people on your Plex are never included, so their
viewing never reaches Ember. Your history is read on your own network, from Tautulli when you have
it, otherwise from Plex itself; no outside service is used.

- **What should I watch?** at the top: type what you're in the mood for and press **Find**. Plain
  words are worked out by Hearth itself, with no AI: a genre ("something funny", "scary"), a length
  ("under 2 hours", "short"), years ("80s", "after 2010"), movie or show, and "like Bad Boys" (the
  picks start from that title). Only a vaguer ask ("a rainy Sunday feeling") goes to Ember, with
  your titles and genres and nothing about who watched what. Results can be in your library or
  not, each with its own buttons; the top says what was understood, with **Back to your picks**.
- **Hidden gem**: in your library, never played by you, and in what you watch most. The picks take
  turns across your top genres (for example Comedy, Drama and Action), not all one kind.
- **New in your library**: added in the last three months and not played yet.
- **Worth revisiting**: something you finished more than a year ago (or less, down to six weeks,
  when your history is young), mixed in among the gems.
- Each reason names a different title you finished, the closest one by genre (no title backs more
  than two reasons), so a show you watch every night doesn't speak for every pick.
- Each card in your library has **Open in Plex**, **More like this** (the picks start from that
  title, and the top says "More like Anchorman"), **Seen it** (the same "How was it?" as Discover:
  your rating steers the next picks, a new pick takes the card's place, and marking it watched on
  Plex is offered as a plan you approve) and **Not for me**.
- **Not in your library** is always shown: titles you'd probably like that aren't in Plex, from
  Seerr's own "similar" and "recommended" lists for up to four titles you finished lately, in
  turns. No AI and no tokens; only Seerr is asked, as it always is. Each card has a poster, a short
  reason ("Because you finished Anchorman"), **Request** (one sheet with your usual quality and
  folder; one tap sends it; **Requested** when it already is), **Watch trailer**, **More like this** and
  **Not for me**. Without Seerr it says to connect it.
- The reasons speak to you ("you've never played it"), never by your Plex username, and are worded
  a few different ways so the list doesn't read like a form.
- Each reason comes from Hearth's own records (when it was added, how many times it was watched).
  Ember puts it in her own words, and a line that adds a number or date Hearth doesn't have is
  dropped for Hearth's wording.
- **Not for me** never suggests it again.
- **What's missing: ask Ember, check in Seerr** (for vaguer ideas) opens Discover with movies like the ones you love
  that aren't in your collection. It is the one part that isn't only local: Ember gets the names
  of up to 4 films you finished and your top genres (nothing else, and nobody else's), and each
  suggestion is checked in Seerr's catalogue and your Plex.
- A note the first time explains that For You learns only from your own history.
- **Fresh picks** makes the list again (it is kept for 12 hours otherwise).

Hearth checks every suggestion before it is shown: one the catalogue can't find is left out, and
whether you have it is checked in your Plex and Jellyfin themselves (Seerr can be out of date).
What was hidden or left out is listed under the results, so nothing disappears silently.

- **Request** asks Seerr for a movie or show, requests a book or audiobook in Chaptarr (adds it
  into its audiobook or book folder if needed, marks that one book wanted and starts the search,
  then checks it is wanted), or adds an artist to Lidarr (choose its quality profile above the
  results). Each is one approval, and the title is marked **Requested**. A show you have some
  seasons of offers **Request missing seasons**. For movies and shows, Request opens one sheet that
  says your usual quality profile and root folder ("HD-1080p, saved to /movies"); **Change** opens
  the full choice (and the Radarr or Sonarr when you have several), as in Seerr's own request box,
  and is remembered for the next one. Tapping **Request** there sends it: that tap is your
  approval, with no second step, and it is recorded like any other change. A title that is already in your
  library or already requested says so instead. The same goes for Request on a Forge sheet.
- **Watch trailer** opens the title's YouTube trailer in a new tab. It shows only when there is
  one for that exact title (from Seerr), on Curator cards, the Forge sheet and Seerr's Discover.
- **Request all missing** asks for every title shown that you don't have, from the same one
  sheet and one tap.
- **Make it a Home row** hands the list to Ember, which builds a Plex Home row the usual way.
- **More like these** asks again and never repeats a title already shown.
- **Seen it** (**Read it** for books, **Know them** for music) asks **How was it?**: stars, **Loved
  it**, **OK**, **Not for me** or **Horrible**, and your own words, all optional (**Skip** just
  takes it off). Hearth keeps it, so the title is never suggested again, with **Undo** right after.
  If it is on your Plex or Jellyfin, Curator offers to mark it watched and put your rating there
  (Plex keeps the stars; Jellyfin a like, and Favorite when you loved it): one approval for all of
  it, and **No, leave it** changes nothing on your server.

Curator also sits at the bottom of a Forge pick sheet of Plex titles (the sheet Ember opens when
you make a Home row). When your library comes up short ("Your library has 24 of 25"), press **Find
ones I don't have** (tick **Think outside the box** for adjacent picks): each one has **Request it** (one approval; it joins **Selected** once it is in
Plex) and **Seen it** (with **Undo** right there), and titles you already have are named so you
can search for them above. The arrow in the Curator section's corner folds it away.

<!-- feature: tautulli-panel -->

### Tautulli's own tabs

Tautulli's panel has its own tabs after **Overview** (who is watching now, this week's tops).
Every change shows the exact before and after for your approval and is read back afterwards;
Ember uses the same steps. Notifications, newsletters and Tautulli's settings stay in Tautulli
(linked from System).

- **History**: every play, newest first; find a title, pick a person or a kind. Tick plays and
  **Delete selected** to remove those records from Tautulli (it cannot be undone; Plex's own
  watched state is not changed).
- **People**: who watches, how much and on what. A person's page shows their watch time (last
  day, 7 and 30 days, all time) and players; rename them in Tautulli, **Stop recording their
  plays**, or **Allow guest access**. **Read people from Plex again** picks up new friends.
- **Libraries**: plays per library, with **Stop recording plays** for one.
- **Graphs**: plays per day for 7, 30 or 90 days, TV and movies stacked.
- **System**: Tautulli's log with keys hidden, and **Back up database**.

<!-- feature: wizarr -->

### Wizarr

Tabs: Overview, People, Servers, Settings (General and Wizard, as in Wizarr).

- Overview: how many people have access and whose access ends this week (each opens People).
  **New invitation**: **Link works for** (or **Never expires**), **Their access lasts** (or **No
  end**), **Libraries** (none ticked means all), **Allow downloads**, **Allow live TV**, **Allow
  mobile uploads** (Plex), **Create invitation**, then **Copy link**. Your invitations, with
  **Delete** for one nobody used. Links use Wizarr's public address in Hearth; without one they
  use the local address, and the panel says friends outside cannot open them.
- People: **Find someone**, sort by name, **Access ending first** or **Newest first**. **Change
  access** on a person: **Extend by** 7 days, 30 days, 90 days or 1 year, **Ends on** a date
  (**Set end date**), **No end date**, **Disable account**, **Enable account**, **Remove** (their
  account on the media server is deleted too). Each is a plan you confirm. Wizarr cannot tell a
  server's own admin account apart, so the plan asks you to check. A password reset is a
  credential: **Open Wizarr's users** to make one there.
- Servers: each media server, whether Wizarr reaches it, what new people may use, and its
  libraries. Libraries an older Wizarr left unlinked are listed with how to fix them: Wizarr
  ignores them in a limit, so Hearth does not offer them. Adding a server stays in Wizarr:
  **Open Wizarr's settings**.
- Settings needs Wizarr's admin sign-in, because its API key cannot open those pages. The first
  time, it asks for it: **Admin username**, **Admin password**, **Connect**. It goes
  in Secure Vault, is only sent to Wizarr's own address, and is never shown again. An admin that
  signs in with a passkey cannot be used: make an admin without one in Wizarr (Settings, Admins).

<!-- feature: wizarr-setup -->

- Settings, **Wizard**, **Designs**: ready-made looks for the guide, starting with **Vault** (from the
  owner's wizarr-community-extras, for Jellyfin, Plex and Audiobookshelf). **Choose colors and
  wording**: **For** (the media server), **Colors** (**Original**, **Ember**, **Gold**,
  **Emerald**, **Ocean**, **Royal**, **Rose**, **Mono**), each step's **Small heading**,
  **Headline** and **Intro**, and a preview of it. When the server's steps already use a design,
  it starts from them: their colors and their own words (otherwise the design's standard words),
  and **Keep the current steps** saves only the colors and the words you changed (**Save colors
  and wording**). Or **Replace** the server's current steps, or **Add** the design's steps after
  them, and **Use this design**. Each is one plan you approve. Wizarr fills in the server's name
  and address itself.
- A step made from a design also has **Colors** in its pencil, with a preview. A new color goes on
  every design step of that server's guide in one plan (so the guide stays one color); titles,
  words, order and **Needs a click** stay as they are, and the approval shows the change as
  **Colors**, from one to the other. **Original** puts the step's first colors back exactly.
- Settings, **Wizard**: the guide someone sees when they open an invitation, one set per media server. **Before
  they accept** and **After they accept** lists, each step with its title and first words. Arrows
  move a step up or down, **Move to after they accept** (or before) moves it to the other list,
  the pencil edits it, the bin deletes it, and the eye previews that step in Wizarr. **Preview
  the guide** opens a server's whole guide in Wizarr, as Wizarr's own Preview Wizard does. **Add a step**: **Title**, **What it says**
  (Markdown), **They must click a button or link on it before Next works**, then **Add step** or
  **Save step**. Each change is a plan you approve in a pop-up that shows what changes. Step
  bundles, presets, import and export stay in Wizarr: **Open Wizarr's Wizard settings**.
- Settings, **General**: **Display name**, **Only people with an invitation can open the guide**, **When
  someone's access ends** (**Delete them** or **Disable them**), **Join page posters** (newer
  Wizarr), then **Save settings**. **Clean expired users** deletes or disables everyone whose
  access has ended, now. Alerts, connections, admins and LDAP stay in Wizarr: **Open Wizarr's
  settings**.

<!-- feature: download-panels -->
<!-- feature: qbittorrent-torrents -->
<!-- feature: sabnzbd-downloads -->

### qBittorrent, Deluge, Transmission and SABnzbd

- qBittorrent's **Overview**: connection, VPN, speeds and free space, **Add torrent**, **All
  torrents**, counts by status, what **Needs you** (errors, stalled, no seeders) and what is
  **Downloading now**; each opens in the Torrents tab.

<!-- feature: download-sources -->

- Each torrent and each SABnzbd job shows **where it came from**: the indexer that grabbed it and
  the app that did ("TrackerOne · via Sonarr"), from the grab history of Sonarr, Radarr, Lidarr,
  Readarr, Chaptarr and Prowlarr. A private tracker's own address names it when no app grabbed it.

<!-- feature: seeding-rules -->

- **Seeding rules** (beside Categories on the Torrents tab): **Add rule** picks one or more
  indexers (from Prowlarr's list and your torrents) or tracker addresses, the days of seeding
  (qBittorrent's seeding time; paused time doesn't count), an optional ratio, and then what
  happens: tell me, stop seeding, remove the torrent keeping its files, or delete it with its
  files. **Set rules** lists them with an on/off switch, **Edit rule** and **Remove rule**. Each
  torrent a rule covers shows the rule, time done and left, and what comes next. Rules start in
  **Preview** (they only say what they would do); **Go live** lets one act by itself, checked
  every 5 minutes (**Check now** for straight away), once per torrent. Delete needs you to type
  "delete files", and skips anything a media app hasn't imported or that sits in a library folder.
  **Stop every rule** halts them all. **Activity** and the bell show what they did. Torrents
  Hearth can't trace to an indexer are never touched. Your tracker may count seeding differently.

<!-- feature: download-health -->

- **Download Health** (a panel in the Lair, beside To-do and Storage & Files, once a download
  client is connected) opens on a **Checkup** with Ember, a card for each download client, and
  **Ask Ember to fix it** on each one that needs you. It shows stuck and failing downloads across qBittorrent, SABnzbd, Sonarr,
  Radarr, Lidarr and Chaptarr, and why, in plain words: stalled, never started, a Usenet
  download that couldn't be completed, a finished download that wasn't imported (with the app's
  own words underneath). **Strikes** tell broken from slow: a download needs you only after 3
  checks without progress over at least an hour, and any progress clears it; failures and stuck
  imports need you at once. A **shared cause** comes first: a client that doesn't answer (its
  downloads get no strikes meanwhile), a VPN that is down, less than 2 GB free, or 5 downloads in
  one client stopping at the same time. Only downloads an app tracks are judged; manual and
  seeding ones are left alone. It checks every 5 minutes (**Check now** for straight away), keeps
  a **History** of what needed you and when it recovered, and shows a line in qBittorrent's and
  SABnzbd's Overview. A download its client reports stuck or failed also goes in **Needs you**
  (and the bell), one item per client.
  - **Fix it** (Sonarr and Radarr downloads that stalled, never started or failed): one plan you
    approve. The download is removed from the app's queue and the download client, that one
    release is blocklisted so it is never grabbed again, and the app searches for another. A movie
    or episode gets at most 2 replacements; a third time, Hearth leaves it to you. A finished
    download that didn't import keeps the app's own Import or Remove (or **Ask Ember to fix it**).
  - **Automatic Recovery** (a switch in the panel, off unless you turn it on): Hearth does Fix it
    by itself for each one that needs you, and the bell and **History** say what was done.

<!-- feature: audiobook-intake -->

- Audiobookshelf's **Intake** tab brings finished audiobook downloads into your library.
  **Review the setup** proposes it from your own apps: your book libraries and their folders
  (read from Audiobookshelf; correct a folder if needed), and the download folders your audiobooks
  land in (SABnzbd and qBittorrent categories named for audiobooks, except the ones Chaptarr or
  Readarr import themselves). Each folder can remove originals some days after a verified import
  (0 keeps them; a torrent folder keeps them so it can seed). After you approve it, every few
  minutes each finished release is identified once: author and title from the first file's tags
  (ffprobe, when installed), an author already in your library, the folder layout, and the name.
  Books Hearth is sure of (80% by default) are copied in as **Author / Title** (the first author,
  no series folder, no subtitle), every file checked by size and SHA-256 before it is put in
  place, and Audiobookshelf scans. The rest wait under **Waiting for you** with the names
  editable, a library to choose, **Import** and **Skip**. A book already in your library with the
  same files is marked **In your library**, not copied again. Nothing in a download folder is
  ever moved. **Check now** looks straight away; **Turn off** stops it.

<!-- feature: manual-sort -->

- qBittorrent's **Manual downloads** tab: a torrent you add by hand has no category, so it stays
  in the default folder and no app imports it. **Review the setup** proposes where each type goes
  from your own categories and apps (movies follow Radarr's folder, shows Sonarr's, music Lidarr's,
  books Chaptarr's); **Change** on a type edits its category, download folder and library folder
  before you review, with options to save new manual downloads in another folder, to sort SABnzbd
  jobs with no category too, and to sort the finished ones already there. After you approve it,
  every finished manual torrent is judged by its files (the biggest ones decide; samples and
  subtitles are ignored), given its type's category so qBittorrent moves it (seeding carries on),
  and handed to the app that imports that type. Radarr and Sonarr add a title they do not have
  yet, without searching, then import it. Usenet jobs are judged by their name. Anything unclear
  (two kinds of media, look-alike videos, long numbered MP3s) waits under **Waiting for you**:
  pick what it is and **File it**. Every sort is listed with **Undo** (back to no category, never
  sorted again; an app's import stays). **Check now** runs a pass straight away; **Turn off**
  stops it. Torrents with a category (your apps' own) are never touched.
- qBittorrent's **Torrents** tab: **Add torrent** (magnet links or .torrent URLs, or **Choose
  .torrent files**; a category, **Save to** one of the folders qBittorrent already uses, tags,
  **Add it stopped**); **Categories** (create one; remove one no torrent is in and that Sonarr,
  Radarr and Lidarr do not send downloads to; qBittorrent cannot rename one). Filter by status
  (All, Downloading, Uploading, Stalled, Queued, Paused, Seeding, Completed, Errors), category,
  tag and tracker, **Find a torrent by name**, sort (**Needs attention first**). Open a torrent:
  **Pause** or **Resume**, **Force start**, **Recheck**, **Reannounce**, its **Category** (the plan
  says whether its files move, from where to where), its tags, and its **files** (each one's
  priority, **Do not download** to skip it), **trackers**, **peers** and **transfer** totals.
  **Remove, keep files** or **Remove and delete files** (permanent). Each change is a plan you
  approve, read back after. Default and category folders are never changed from Hearth.
- **Seeding, speed, and queue settings** opens the Settings tab: speed limits (KiB/s, 0 = none) and the alternative-limit schedule, seeding limits and **When a seeding limit is reached** (a red warning when that would delete files), queue limits, connections, disk. A setting that only matters when its switch is on stays greyed until then. Change what you need, then **Review N changes**: one plan with each before and after, read back once approved. **Undo my edits** drops them. Ports, proxies, the Web UI login, privacy settings and save paths stay in qBittorrent (**Open qBittorrent**).
  Shows whether the VPN is connected.

<!-- feature: deluge-panel -->

- **Deluge** (2.x, through its Web UI): the same **Overview** and **Torrents** tab as qBittorrent,
  with Deluge's words. Hearth signs in with the Web UI password (the vault calls it the **Web UI
  password**; Deluge's own default is "deluge") and, when the Web UI is not attached to a Deluge
  daemon, attaches it to the one it lists as online. Torrents tab: **Add torrent** (links or
  .torrent files, a label, **Add it paused**), **Labels** (Deluge's Label plugin: off until you
  approve **Turn on labels**; then create one, or remove one no torrent has), and for each torrent
  **Pause** or **Resume**, **Recheck**, **Reannounce**, its place in the **Queue** (**Top**,
  **Up**, **Down**, **Bottom**), its **Label**, its files, trackers (host names only, never the
  passkey in the announce address), peers and transfer, and **Remove, keep files** or **Remove and
  delete files**. There is no force start or tags in Deluge. **Settings**: speed limits (KiB/s, -1
  = none), seeding (stop or remove at a share ratio), queue, connections, disk; **Review N
  changes** is one plan with each before and after. The Web UI password, ports, the proxy and
  download folders stay in Deluge (**Open Deluge**).

<!-- feature: transmission-panel -->

- **Transmission** (3.x and 4.x, through its RPC): the same **Overview** and **Torrents** tab,
  with the Web UI username and password from the vault (if Transmission asks for none, save any).
  Its labels are free text: type one when you label a torrent (**Label**, then **Change**), or
  when you **Add torrent**; a torrent's first label is the one shown, and **Labels** lists those in
  use. Each torrent: **Pause** or **Resume**, **Recheck**, **Reannounce**, **Top**, **Up**,
  **Down**, **Bottom** in the queue, its files (Transmission has no "highest": high is the top),
  trackers (host names only, never a passkey), peers, and **Remove, keep files** or **Remove and
  delete files**. **Settings**: speed limits (kB/s) and the **alternative speed limits** (its
  turtle), seeding (**Share ratio to stop at**, idle time), queue and peer limits, as one plan.
  The RPC password and whitelist, ports, the proxy, the blocklist and download folders stay in
  Transmission (**Open Transmission**).
- SABnzbd's **Overview**: status, speed, what is left, free disk space, **Add NZB**, **All
  downloads**, **Pause all** or **Pause for...** a while (it resumes by itself), a speed limit
  (**Limit to 50%**, **No speed limit**), its warnings with **Clear warnings**, what **Needs you**
  (failed downloads, **Retry or remove them**) and what is **Downloading now**; each opens in the
  Downloads tab.
- SABnzbd's **Downloads** tab: **Add NZB** (links, or **Choose .nzb files**; a category, a
  priority, **Add it paused**, and a name when adding one). **Find a download by name**, filter by
  status and category. Open a download: **Pause** or **Resume**, its priority (**Force**, **High**,
  **Normal**, **Low**), **Move to top**, its category, its **Files** (how much of each is left), and
  **Remove** (with **Also delete what it downloaded**). The history: **Find in the history**,
  **Failed only**, by category, **Show more**; **Retry** a failed one, **Ask why**, or **Remove** it
  (its files stay unless you tick the box). Each is a plan you confirm, read back. An indexer
  link's key (after "?") is never shown in a plan. Usenet servers and their logins stay in SABnzbd.

<!-- feature: nzbget-panel -->

- **NZBGet** (with its control username and password in the vault): the same **Overview** and
  **Downloads** tab as SABnzbd. Its speed limit is a rate (**Limit to 5 MB/s** and so on, or **No
  speed limit**), not a share of the line. Its warnings come from NZBGet's own health check (no
  news server, a weak password) and the warnings in its log: they are fixed in NZBGet, so there is
  no **Clear warnings**. A failed download says why in plain words (**too many missing articles**,
  **unpacking failed**); **Retry** downloads it again, and **Remove** moves a download to NZBGet's
  history as deleted. News servers, their passwords, folders and scripts stay in NZBGet.

<!-- feature: romm-panel -->

### RomM (your game library)

- **Overview**: how many games and platforms, saves, how many RomM could not identify,
  **Recently added** and **Favourites** with their covers, the platforms (most games first),
  **Browse the library**, **Scan for new games** and **Open RomM**.
- **Library**: every game as a cover. **Find a game by name**, a platform, a genre,
  **Favourites**, and the order (name, recently added, release date, largest first); **Show
  more**. A game opens on its own page: cover, platform, year, regions, genres, who made it, its
  description and files, **Add to favourites**, **Open in RomM (play, download)** and **Ask Ember**.
- **Platforms**: each with its games and space; **Games** opens them in the Library.
- **Scan for new games** (and **Scan** beside a platform): choose **Quick** (new games only),
  **Identify again**, **New platforms**, **Update details** or **Complete**, and which platforms;
  you approve it first. A scan never deletes a game or a file. RomM lets only administrators
  scan: with another user's login, or a RomM API token, the panel browses and says so.
- What to put in the vault: a RomM user's username and password (an administrator's to run
  scans). Playing and downloading games stay in RomM.

<!-- feature: home-assistant -->

### Home Assistant

- **Lights and switches**: **Find a light or switch**, switch them.
- **Integrations not working**, with **Reload**.
- **Routines and automations**: **Routine** (runs when you start it), **Automation** (runs on
  its triggers; switch off to stop), **Scene**. Each shows **Starts when**, **Checks first**,
  **Last runs**, **Look before running**. **Run now** runs its steps straight away; anything
  beyond lights and the TV waits for your OK.

<!-- feature: home-dashboard -->

### The home dashboard (Home Assistant's Home tab)

Home Assistant's panel opens on its **Home** tab: a household command centre for a wall tablet
(**Overview** is the next tab).
**Full screen** (in **Dashboard settings**, the gear) opens it on its own (the page
**/home-screen**), with **Back to Hearth**. Behind it is a window on the real weather from Home
Assistant: rain, snow, sun, cloud, fog, wind and storms (with an occasional soft lightning
flash), by day or by night. It is drawn on the tablet itself, stops when the screen is off, and
draws less by itself on an older tablet.

Five pages, swiped sideways with a finger, or chosen from the bar at the top (the bottom on a
phone), the dots or the arrows:

- **Home**: the time written out ("Seven Thirteen in the Evening"), the date, and the weather
  now (feels like, humidity, wind, the chance of rain, sunrise and sunset), the next hours and
  the next days; tap the weather for the full forecast. Below: **Now Playing**, **Today**,
  **Lists**, **Home Status** and **Scenes**.
- **Rooms**: **Lights and switches** by room, with brightness for a light that is on; the
  thermostat (warmer, cooler, and its modes); scenes.
- **Media**: the player with the artwork, progress, play and pause, skip, shuffle, repeat,
  volume and mute; **Speakers** to choose one and where it plays from. Choosing another Music
  Assistant speaker while music plays moves the music there, and the old one goes quiet. **Audio** and **Video**
  show what is playing: Home Assistant cannot turn a song into its music video, so **Video** is
  only lit when a video is playing. Each music service allows different things; anything a
  speaker does not support is left out. While a song plays, a small player sits at the bottom
  of the other pages.
  <!-- feature: speaker-names -->
  Speakers show by name, never a model number or an address: the name you gave it in Home
  Assistant, the name its own system reports (Music Assistant, Sonos, Cast) when it is a real
  name, or else its room ("Kitchen speaker"). To rename one, right-click it in the speaker list
  (long-press on a phone), or press its pencil: type the name and press Enter (Escape keeps the
  old one). The name is used everywhere Hearth shows that speaker; **Reset name** goes back to its
  own.
- **Security**: **Doors and alarm**: locks (**Lock**, **Unlock**), a garage door or gate
  (**Close**, **Open**) and the alarm (**Home**, **Away**, **Turn off**). **Cameras** show a
  picture every few seconds; tap one for a bigger, faster one.
- **Household**: the calendar for the week (**Connect a calendar**: **Google Calendar**, **Apple
  iCloud** (CalDAV, with an app-specific password), **Proton, Outlook or any calendar link**
  (.ics), or one kept in Home Assistant; new events are added in each calendar's own app). When a
  calendar is set up but Home Assistant can't read it (Google stopped accepting its sign-in, for
  example), the card says so instead of "No calendars yet": **Sign in to Google Calendar again**
  goes straight to that sign-in and renews the connection you have, **Open Home Assistant's
  repairs** opens Home Assistant's own list, and **Ask Ember to fix it** hands it to Ember. And the
  lists in full (**Add a list**, tick items back, **Clear done**).

The chip at the top says **All systems normal**, or what is open (a door unlocked, the garage
open), or that Home Assistant is not answering; then a note says the screen shows what it last
said. Everything shown comes from Home Assistant; nothing is sample data.

<!-- feature: calendar-sign-in-again -->

**When a calendar stops**: the sign-in button works even when Home Assistant has no sign-in
waiting (one used up in an old tab): Hearth reloads that calendar in Home Assistant so it asks
afresh, then opens the sign-in page. It says **Connected** only once the calendars read again;
otherwise it says the sign-in didn't take. On a browser that never used My Home Assistant, a page
asks for your Home Assistant's address: the sign-in window shows it to copy (press Save, then Link
account). If Google keeps signing out about every 7 days, your Google Cloud app is still in
Testing: on its sign-in screen (Branding) add the home page `https://www.home-assistant.io`, the
privacy policy link `https://www.home-assistant.io/privacy/` and the domain `home-assistant.io`,
no logo, Save; then **Publish app** on Audience, and sign in again once. Ember knows these steps
and checks afterwards that the calendars came back.

**Widgets**: **Add widgets** (in Dashboard settings, or **Customize** below the Home page) opens
a gallery of every widget; tap one to add or remove it. **Customize** shows each widget's bar:
move it earlier or later, narrower or wider, its options, or remove it. Each screen keeps its own
choice.

- From Home Assistant: **Now Playing**, **Today**, **Lists**, **Home Status**, **Scenes**,
  **Devices and Sensors** (choose any switches, lights, fans, plugs or sensors; switches flip from
  the widget), **Thermostat**, **Cameras**, **Who's Home** (Home Assistant's people), **Doorbell**
  (when it last rang; when it rings, its camera comes up over everything for a minute, unless
  that is turned off in the settings), **Energy** (from Home Assistant's Energy dashboard),
  **Commute** (Waze or Google Maps travel time; **Add a trip with Waze** sets one up), **Scores**
  (the TeamTracker integration) and **Plants**.
- Kept by Hearth and shared by every screen in the house: **Chores and Stars** (chores that repeat
  on chosen days or every day; whoever is named gets the stars when it is ticked off),
  **Reminders** (bin day, watering; Waste Collection Schedule's bin days show there too),
  **Countdowns** and the **Message Board**. A home tablet can add and tick these. **Movie Night**
  shows the next movie night and who is coming (planned in the Movie nights panel).
- **News**: headlines from the RSS or Atom feeds you choose (its options, from Hearth, not a home
  tablet). **Photo Frame**: photos from Immich (an album you choose, or recent photos; archived,
  hidden and locked photos never show); a full screen can also show it when dimmed.

A widget with nothing to show yet says what would fill it, never sample data.

**Dashboard settings** (the gear), kept on that screen: the clock (**In words**, **12-hour**,
**24-hour**), the page it opens on, the weather animation (**Full**, **Light** for older tablets,
**Still**), dimming when no one touches a full screen (5, 10 or 30 minutes, or never; the first
touch only wakes it, and the time moves a little so nothing burns in), what a dimmed screen
shows (the time or the photo frame), and whether the doorbell brings its camera up. The owner also connects music, a calendar, a list or the weather
there.

A tap does it straight away, like Home Assistant's own app (no approval card for a song or a
grocery item). Ember's changes still go through plans. Opening a lock or a garage door, or
turning the alarm off, asks for the home's **unlock PIN** (4 to 8 digits, set under the dashboard
with **Set the PIN**; five wrong tries lock it for five minutes), checked by Hearth itself. An
alarm that has its own code asks for that too. Connecting a service runs Home Assistant's own
setup in Hearth, step by step, with the service's own sign-in page where it has one; Spotify and
Google need an app of your own first (Hearth shows where to make it and which redirect address to
add). Passwords and secrets typed there go to Home Assistant and are never kept by Hearth. Home
Assistant's token needs an administrator to connect services.

**Music Assistant and YouTube Music**: on the music card, **Connect**, then **Music Assistant**.
Give its address (Hearth suggests this machine, port 8095) and press **Sign in to Music
Assistant**: its own sign-in page opens in a window. Sign in there and Hearth does the rest:
it finishes Music Assistant's first-run setup and adds it to Home Assistant, and your speakers
show on the dashboard. Then **Open YouTube Music** opens an ordinary Chrome window on this
computer, made just for this (Google refuses sign-ins in Ember's Browser, which is
remote-controlled). Sign in to YouTube Music there and press **Done**: Hearth closes the window,
hands the sign-in straight to Music Assistant and deletes that window's profile. Nothing is shown,
kept or given to Ember. Music Assistant plays YouTube Music only with YouTube Music Premium, and
needs its token helper (the yt-po-token container) running.

<!-- feature: music-playlist -->

**Have Ember make a playlist** (Media page, in Hearth; not on a home tablet): say **What kind of
playlist?** (2010s rock like Muse, a rainy-day mix), **About how many songs** and a **Name**, then
**Ask Ember to make it**. Ember asks anything it still needs, picks the songs, checks each one is
real on YouTube Music, and opens them in the Forge so you can swap, add or remove. Nothing is made
until you send your selection and say yes; then it creates the playlist (private) through Music
Assistant, reads it back, and says what it changed. It uses your AI plan, like any Ember request.
With more than one music service in Music Assistant (YouTube Music, Spotify...), **Make it on**
chooses which. Your own music works the same way: **Have Ember make a playlist** is also on a
Plex, Jellyfin or Emby panel's Library tab when a music library is chosen, and on Navidrome's
Overview. Ember picks only songs that library has and makes the playlist in that app, so Plexamp
and the other players see it straight away.

**A home tablet**: Settings, PCs and devices, **Add a device**, choose **A home tablet (the home
dashboard only)**, **Show a QR code**, and scan it on the tablet (or open the Pair Hearth address
and type the code). The tablet opens the home dashboard full screen and stays signed in; it
cannot reach the rest of Hearth (Ember, plans, the vault, settings), and it cannot connect
services or change the PIN. **Unpair this tablet** (in Dashboard settings) signs it out; it also shows in
your devices to remove.

<!-- feature: other-panels -->

### Others

- **Prowlarr**: indexers and **Feeds these apps** on the Overview; its own tabs are above.
- **Bazarr**: missing subtitles, **Providers**, **Recently downloaded**.
- **Recyclarr**: **Last sync**, **What it set**, **A sync now would**.
- **Caddy**: sites (**Find a site, address, or service**), add or change a site (address,
  upstream, **Sign-in** with a sign-in service or password), **Remove site**, **Errors in the
  last day**. Caddy is protected: you confirm it is you, Caddy checks the change first.
- **Tinyauth**: **What Tinyauth does, and how to use it**; the sites **Behind Tinyauth** and the
  ones **Open to anyone with the address** (read from Caddy), with **Protect it** to put one behind
  it (the same protected Caddy change as the Caddy panel: you confirm it, Caddy checks it, it is
  put back if the site does not come up); **Users and passwords**: who can sign in (and who has a
  sign-in code), **Change password**, **Add a user**, **Rename**, **Remove** (never the last user).
  A password is typed only after you confirm it is you, scrambled by Hearth at once and never stored
  or shown; each change is a plan you approve: the users file is backed up, Tinyauth restarts (its
  sites wait a few seconds) and a new password is proved by signing in, or the old file is put back.
  Users set in Tinyauth's environment instead of a users file are shown as such (Ember explains);
  sign-ins, **Asks per hour**, **Busy hours**, **Who asked most**, **Its own errors**.
- **Gluetun**: the VPN connection, **Move to another server** (country, port forwarding,
  streaming), and which apps lose their connection if the VPN drops.
- **FlareSolverr**: challenges solved **By site**, **Latest**.

<!-- feature: portainer-panel -->

- **Portainer** (with an access token in the vault):
  - Overview: each environment with its containers running, stopped and unhealthy and its stacks
    (one not reachable is marked); **Unhealthy** containers with **Restart**, **Stop** and **Ask
    Ember why**; containers with a newer image waiting, where Portainer reports it.
  - Stacks and containers: every stack with its containers, **Update** (pull its images and
    deploy again with its own file and variables), **Stop** and **Start**; each container with
    **Restart**, **Stop** or **Start**; **Every environment** and **Find a stack or container**.
  - Each change is a plan you approve and is read back. A stack or container that runs networking
    asks you to confirm it is you; Hearth never stops itself. Deleting, editing Compose files or
    variables, registries and users stay in Portainer (**Open Portainer**). Image updates: Hearth's
    Updates page checks your images (Portainer's own check is in its Business edition).

<!-- feature: uptimekuma-panel -->

- **Uptime Kuma** (with the username and password you sign in to it with in the vault; not while
  two-factor sign-in is on):
  - Overview: **Up**, **Down** (with pending, paused and in maintenance), the average **Response**
    time and **Certificates** running out within two weeks. **Down now** lists each monitor that is
    down, since when and Uptime Kuma's own message, with **Ask Ember why** and **Pause**. Then
    **Recent changes** (each monitor going down or coming back), monitors that send no alerts,
    **Maintenance** windows with **Pause** or **Resume**, and links to your **Status pages**.
  - Monitors: every monitor by group with its latest checks as small bars, response time now and
    on average, uptime today and over 30 days, its certificate and how often it checks; **Pause**,
    **Resume** and remove (it asks first: its history goes too). **Find a monitor, address or
    group**, and show **All**, **Down** or **Paused**. **Your apps it does not watch** lists the
    apps in Hearth that no monitor checks, each a one-tap plan to watch it; or give a name and a
    website address and **Add monitor**.
  - Each change is a plan you approve and is read back. Monitor settings, notifications, status
    pages and users stay in Uptime Kuma (**Open Uptime Kuma**): their settings can hold
    passwords, which Hearth never reads.

<!-- feature: nextcloud-panel -->

- **Nextcloud** (an administrator's username and the password they sign in with in the vault;
  Nextcloud asks for the account's own password before any change, so an app password only reads,
  and two-factor sign-in on that account stops Hearth. A separate administrator for Hearth is best):
  - Overview: **Free space** and files, **Accounts** (how many are off, how many were active
    today), **Background jobs** (on time, late or never ran, when they last ran and how) and **App
    updates**. **Needs a look** lists background jobs that are late, public links without a
    password (with **Require a password on new links**), accounts almost out of space (**Change
    the quota** opens the account) and Nextcloud's own setup warnings and errors, each with **Ask
    Ember** and Nextcloud's guide. **Sharing and background jobs** turns **Require a password on
    public links** and **Allow public links** on or off and chooses what **Background jobs run
    by** (AJAX, Webcron or Cron; Cron needs the system to run cron.php every 5 minutes). Then the
    server (PHP, database, memory, load, cache), who was active, and Nextcloud's other notes.
    When Hearth reaches Nextcloud over plain http, Nextcloud's HTTPS and header checks judge
    Hearth's own connection, so Hearth lists them as notes, not problems.
  - Accounts: every account with its email, groups, storage used of its quota (with a bar) and
    last sign-in. **Find an account, email or group**, show **All**, **Off** or
    **Administrators**. **Turn off** (they cannot sign in or sync; their files stay) or **Turn
    on**, **Set quota** ("5 GB" or "none"), **Add to group** and take out of a group. Hearth never
    turns off or takes admin from the account it signs in as, nor the last administrator.
  - Apps: every app, on or off, with its version and any update (**Update in Nextcloud**). **Find
    an app**, **Turn on** or **Turn off** (never the apps Hearth reads through).
  - Each change is a plan you approve, is read back and can be undone. New accounts, passwords,
    new groups and installing apps stay in Nextcloud (**Open Nextcloud**).

<!-- feature: paperless-panel -->

- **Paperless-ngx** (an API token in the vault: in Paperless, your name, **My Profile**, **API Auth
  Token**; an administrator's sees every document). Hearth shows titles, never a document's text:
  - Overview: **Inbox** (new documents still to sort), **Importing**, **Failed** and
    **Documents** with free space and the trash. **Could not finish** lists each failed import
    or task with Paperless's own reason, **Ask Ember why** and **Dismiss** (it only leaves the
    list; a file from the consume folder stays there until it imports). **Importing now** lists
    files being read. **Paperless itself** shows its database, Redis, workers, search index,
    classifier and sanity check, with any message. **Tags** with how many documents each has
    (tap one to see them), and **Make tag** (tick "marks new documents" for an inbox tag).
    **Maintenance**: run the sanity check, train the classifier, optimize the search index, fetch
    mail now.
  - Inbox: the newest new documents with correspondent, type, date and tags. Tick some, or
    **Select all**, then **Mark done** (takes the inbox tag off), **Add a tag**,
    **Correspondent** or **Document type**; or **Done** on one. Each opens in Paperless-ngx.
  - Documents: **Search every document's text**, filter by tag, newest first a page at a time.
    Tick some to **Move to trash**, **Process again** (reads the text again) or sort them as in
    the inbox. **Trash** lists what is there; **Bring back** restores it.
  - Each change is a plan you approve, is read back and can be undone. New correspondents and
    document types, workflows, mail accounts and emptying the trash stay in Paperless-ngx
    (**Open Paperless-ngx**).

<!-- feature: vaultwarden-panel -->

- **Vaultwarden** (its admin page on, and its admin token in the vault: the plain token you sign
  in to /admin with, not its hash). Hearth never sees anything inside a vault, an account's keys,
  or a setting that holds a secret, and signs in to the admin page once every 15 minutes at most
  (Vaultwarden allows 3 sign-ins in 5 minutes):
  - Overview: **Accounts** (and how many are invited), **Two-step sign-in** (how many have it
    on), **Sign-ups** (open, some email domains, or closed) and **Version**. **Needs a look**:
    sign-ups open to anyone, no https, password hints shown on the sign-in page, and its own
    diagnostics, each with **Ask Ember**. Who has no two-step sign-in. **Who can get in**: its
    settings for sign-ups, invitations, email, emergency access, Sends, password hints and the
    web vault (changed on Vaultwarden's own admin page, since its settings hold secrets).
    Organizations, and **Back up the database now**.
  - Accounts: everyone with their status, two-step sign-in, last active and organizations.
    **Find an account or organization**, show **All**, **No two-step**, **Invited** or **Off**.
    **Turn off** (they cannot sign in or sync; the vault stays) or **Turn on**, **Sign out
    everywhere**, **Lost their phone** (turns off two-step sign-in: until they set it up again,
    their master password alone opens the vault), **Delete** (the account and its vault, no
    undo), and for invitations **Send again** or **Withdraw**. **Email to invite** and
    **Invite**.
  - Every change is a protected plan: approving asks you to confirm it is you. Turning off and
    inviting can be undone; deleting cannot.

<!-- feature: navidrome-panel -->

- **Navidrome** (an administrator's username and password in the vault; Navidrome locks an
  account for a while after a few wrong tries, so Hearth signs in once and reuses the session):
  - Overview: **Songs** (with albums and artists), **Listening** (who is playing now),
    **Last scan** and **Missing** files. **Playing now**: the song, artist and album, who and on
    which app. **Needs a look** lists files Navidrome can no longer find, with **Forget them**
    (only for files that are gone: a file that moved is found again by a scan). **Library**: each
    library's folder and last scan, **Scan for new music** and **Full scan** (reads every file
    again).
  - People: everyone with their role, when they were last on, what they are listening to and the
    apps they listen with. **Find a person**, **Make administrator** or **Make ordinary user**,
    and **Remove** (their playlists, stars and play counts go; the music stays). New people and
    passwords are made in Navidrome.
  - Each change is a plan you approve and is read back. Hearth never removes or demotes the
    administrator it signs in as.

<!-- feature: gitea-panel -->

- **Gitea** (an administrator's access token in the vault: in Gitea, Settings, Applications,
  Generate new token, with read and write access to admin and repository). Forgejo answers the same
  way and the panel names it:
  - Overview: **Repositories** (private and archived), **Mirrors** (amber when one is late),
    **Runners** online and **Failed runs** in the last day. **Mirrors**: each pull mirror, when it
    last synced and how often, with **Sync now**. **Changed lately**: the repositories changed most
    recently. The footer has the version, people, administrators and organizations.
  - Actions: **Runners**, each online, offline or off, with **Turn off** (it finishes its job and
    takes no new ones), **Turn on** and **Remove** (it must register again with a new token).
    **Recent runs** with **Run failed jobs again** on a failed one. **Scheduled tasks**: Gitea's
    own (sync every mirror, check repository health and more), each with **Run now**.
  - Each change is a plan you approve and is read back. Hearth never makes a runner registration
    token or reads a secret; repositories and people are changed in Gitea.

<!-- feature: forgejo-panel -->

- **Forgejo** uses Gitea's panel (the same kind of access token, made the same way). Forgejo's API
  does not list runners or every run, and cannot run failed jobs again, so its panel differs:
  - Overview shows **Waiting runs** (runs waiting for a runner) in place of Runners.
  - Actions: runners are managed on Forgejo's own page (Site administration, Actions, Runners).
    **Recent runs** are read from the most recently changed repositories, without **Run failed
    jobs again**. Mirrors, **Sync now** and **Scheduled tasks** work as for Gitea.

<!-- feature: authelia-panel -->

- **Authelia** (nothing to add to the vault), a light read-only panel on one page:
  - **Sign-in** (working or not, and since when), and from Authelia's metrics: **Sign-ins** (with
    how long each takes), **Failed** and **Banned** (refused after too many wrong tries) since it
    started; server errors and memory.
  - The counts need Authelia's metrics on (in its configuration, telemetry, metrics, enabled, port 9959) and reachable from Hearth; until then the panel says so.
  - Authelia has no admin API: people, groups and access rules are changed in its configuration
    files. Hearth reads no names, passwords or secrets from it.

<!-- feature: frigate-panel -->

- **Frigate** (the username and password you sign in to Frigate with in the vault, and Frigate's
  signed-in address, port 8971; Hearth accepts its self-signed certificate on your network and
  remembers it), on one page. Hearth never shows a camera's stream address (it usually holds the
  camera's password) or an image:
  - **Cameras** getting a picture, **Alerts today** (with detections and how many are not
    reviewed), **Detector** speed per frame, and **Recordings disk** (amber at 95% full).
  - **Cameras**: each camera's frames per second or "no picture", detection on or off, reconnects
    this hour and its recordings, with **Turn off detection** or **Turn on detection**, and under
    **Recording**, **Turn on recording** or **Turn off recording**.
  - **Recent events**: what was seen, on which camera and when, with **Keep** (stays after Frigate
    cleans up), **Stop keeping** and **Delete**. Under **More**, **Restart Frigate**.
  - Each change is a plan you approve. Detection is read back from Frigate's live stats, events
    from its list, and a restart by Frigate answering again. Zones, masks and cameras are set up in
    Frigate.

<!-- feature: authentik-panel -->

- **Authentik** (an administrator's API token in the vault: Admin interface, Directory, Tokens and
  App passwords, Create, intent API). Authentik holds everyone's sign-in secrets, so Hearth never
  shows or reads a password, token or secret, and never the details of a sign-in event:
  - Overview: **Sign-ins today**, **Failed today** (amber at 10 or more), **Apps protected**, and
    **Health** (with the version, and whether a newer one is out). **Failed sign-ins, last day**:
    who and from where. **Apps protected**: each app, the address it guards and its kind.
    **Health**: the worker, each outpost (checked in or last seen), certificates expiring within
    30 days, and failed background tasks with **Retry**.
  - People: everyone with their role, when they last signed in and failed sign-ins today. **Find a
    person**, **Turn off** (they cannot sign in anywhere Authentik guards) or **Turn on**.
  - Every change is a protected plan: approving asks you to confirm it is you. Hearth never turns
    off the account its token belongs to, or the last active administrator. Passwords, sign-in
    methods, apps and flows are changed in Authentik.

<!-- feature: actual-panel -->

- **Actual Budget** (its server password in the vault: the one you set when you first opened
  Actual), a light, read-only panel on one page:
  - **Server** (healthy or not, and how long it has been up), **Version** and memory, **Budgets**
    (and how many are in the trash), **Sign-in** (password, or single sign-on, and whether several
    people have their own accounts).
  - **Budget files**: each budget's name, whether it is encrypted (then only its own password opens
    it), and how many people can open it.
  - Hearth reads only the server: never what is in a budget. Budgets are opened and changed in Actual.

<!-- feature: mealie-panel -->

- **Mealie** (an administrator's API token in the vault: in Mealie, your profile, API Tokens,
  Generate), a light panel on one page:
  - A warning when Mealie still has its first-run administrator (changeme@example.com), whose
    password is published.
  - **Version** (and whether a newer one is out), **Recipes** (and how many have no category or
    tags), **People** and households, **Newest backup** (amber when older than a week). Mealie's own
    checks: email, base address, and LDAP or single sign-on when turned on; the database type.
  - **Backups**: the newest ones with their size, and **Back up now**.
  - Under **Storage and clean-up**: data, temporary files and backups sizes, **Clean temporary
    files**, **Delete unused images** (no recipe uses them), **Remove empty folders**, and **Unlock
    locked accounts** (locked by failed sign-ins).
  - Each change is a plan you approve; a backup is read back from Mealie's list. Hearth never reads
    Mealie's database address, which can hold its password.

<!-- feature: komga-panel -->

- **Komga** (an administrator's API key in the vault: in Komga, your account (top right), API
  Keys, Generate API key; Komga 1.13 or later):
  - Overview: **Books** (with series), **Unreadable** (books Komga could not open), **Readers
    today** (people who signed in in the last day) and **Failed sign-ins** (amber at 5 or more).
    **Libraries**: each library's series and books, folder and scan schedule, with **Scan for new
    books**; under **More**, **Deep scan** (reads every file again; slower), **Analyze books**,
    **Refresh metadata** and **Empty trash** (Komga forgets books whose files are gone, with their
    reading progress). **Added lately**: the newest books and their series.
  - Books: **Could not be read** lists each book with Komga's reason, and **Read it again** once
    its file is replaced or fixed. **History**: what Komga imported, converted or deleted.
  - People: everyone with their role and when they last signed in, and failed sign-ins in the last
    day with the address they came from. Komga keeps each person's reading progress to them, so
    Hearth shows sign-ins. New people, passwords and library access are set in Komga.
  - Each change is a plan you approve. A scan is read back by the library's book count.

<!-- feature: wgeasy-panel -->

- **wg-easy** (version 15 or later, with the username and password you sign in to it with in the
  vault; not while two-factor sign-in is on for that account). A client's configuration and QR code
  hold its private key, so Hearth never asks for them: they stay in wg-easy:
  - Overview: **Connected** (clients right now), **Clients** (and how many are off),
    **Traffic** to and from clients, and the address **Clients connect to**. **Needs a look**:
    clients past their end date that are still on (**Turn off**). **Connected now**: who, their
    address, where they connect from and what they moved. What new clients send through the
    tunnel and which DNS they use. **Restart WireGuard** (every client drops for a few seconds).
  - Clients: every client with its address, connected or when last seen, traffic, where it
    connects from and its end date. **Find a client or address**, show **All**, **Connected** or
    **Off**. **Turn off** or **Turn on**, **Rename**, **End date**, **Remove** (its configuration
    stops working for good). **New client's name**, an optional end date, and **Add client**; then
    scan its QR code in wg-easy on the device.
  - Every change is a protected plan: approving asks you to confirm it is you. All but removing
    and restarting can be undone.

<!-- feature: tailscale-panel -->

- **Tailscale** (read from Tailscale's own API, since it keeps your devices in its own service:
  make an access token in Tailscale's admin console, **Settings**, **Keys**, **Generate access
  token**, and add it to the vault for this service with the address
  `https://api.tailscale.com`; tokens last up to 90 days). Hearth never shows a device's keys.
  Not yet checked against a real tailnet:
  - Overview: **Online** (devices on the tailnet), **Waiting** (to be approved), **Keys**
    running out within two weeks and **Exit nodes**. **Needs a look**: devices that want to join
    (**Approve**), keys running out (**Never expire**) or expired, and exit nodes and subnet
    routes offered but not approved (**Approve exit node**, **Approve routes**). Devices with a
    Tailscale update, and MagicDNS and nameservers.
  - Devices: every device with its address, OS, user or tags, online or when last seen, key
    expiry, Tailscale version, exit node and routes. **Find a device, address, user or tag**,
    show **All**, **Offline**, **Waiting** or **Exit nodes and routes**. **Approve** or **Take
    access away**, **Never expire** or **Let the key expire**, approve or stop an exit node or
    routes, **Rename** (its tailnet address changes) and **Remove**. Devices shared in from
    another tailnet are changed there.
  - Every change is a protected plan: approving asks you to confirm it is you. All but removing
    can be undone. Access rules (ACLs), DNS and keys stay in Tailscale's admin console (**Open
    Tailscale**).

<!-- feature: traefik-panel -->

- **Traefik** (read from its API, api.insecure on port 8080 inside your network; no key):
  - Overview: **Routers**, routers Traefik **Refused** (with its own error), **Apps down** behind
    a router, **Certificates** expiring within two weeks, the entry points, and **Ask Ember how to
    fix it**.
  - Routers: every router with the names it answers, where it sends them (each app server, marked
    when down), https and middlewares (by name), with **Find a router**.
  - Certificates: each with its names, issuer and expiry.
  - Read only: Traefik is set up in its files and container labels. Ember explains a fix; a change
    to those files goes through host administration as a protected plan. Its routers also fill in
    Hearth's **Open web UI** addresses (**Open Traefik's dashboard**).

<!-- feature: npm-panel -->

- **Nginx Proxy Manager** (with the email and password you sign in to it with, in the vault):
  - Overview: **Sites on**, sites **Not loading** (nginx refused their settings, with nginx's own
    error and **Ask Ember why**), **Certificates** in use expiring within two weeks, redirections,
    streams and 404 hosts, and the **Latest changes** from its own log.
  - Sites: every proxy host with where it sends visitors, its certificate and expiry, https only,
    access list, an **On** switch, and **Change** (where it forwards, or **Remove the site**);
    **Add a site** with an existing certificate. **Find a site or address**.
  - Certificates: each with its names, Let's Encrypt or uploaded, expiry, the sites using it, and
    **Renew now** for Let's Encrypt.
  - Its sites also fill in Hearth's **Open web UI** addresses, as Caddy's do. It decides who
    reaches what, so every change asks you to confirm it is you, and is read back with whether
    nginx loaded it. New certificates, uploads and keys, access lists and their passwords, and
    custom nginx settings stay in Nginx Proxy Manager (**Open Nginx Proxy Manager**).

<!-- feature: proxmox-panel -->

- **Proxmox VE** (with an API token in the vault, written user@realm!tokenid=secret):
  - Overview: each node's CPU, memory and system disk, how long it has been up and **updates
    waiting**; how many VMs and containers are **Running**, how many were **Backed up this
    week**, **Failed tasks** and **Storage**; each storage's use; **Recent tasks**, with **Ask
    Ember why** when one failed.
  - VMs and containers: every guest with its state, CPU, memory, uptime and tags, **All**,
    **Running** or **Stopped** and **Find by name, id or tag**; **Start** or **Shut down** on
    each; open one for **Restart**, **Force stop** (only for one that does not answer), **Back up
    now** (to a storage you choose), **Take a snapshot** and its snapshots. Each is a plan you
    approve, and waits for Proxmox's own task.
  - Backups: **Backup jobs**, the **Newest backup of each guest** (a week old or none is marked),
    backup runs that failed, and every backup file.
  - Proxmox uses its own certificate: Hearth accepts it on your home network and remembers it, and
    refuses a different one later. Creating, deleting, migrating, consoles, restoring and rolling
    back stay in Proxmox (**Open Proxmox**). Not yet checked against a real Proxmox.

<!-- feature: adguard-panel -->

- **AdGuard Home** (with the username and password you sign in to it with, in the vault):
  - Overview: whether protection is on, **Pause protection** (5 minutes, 30 minutes, 1 hour, or
    until you turn it on) and **Turn protection on**; queries, blocked, sites blocked for safety
    and filter lists in the last 24 hours; queries per hour; **Most blocked**, each with
    **Allow**; **Busiest devices**; **Safety** switches for safe browsing, parental control and
    safe search; **Update filter lists**, with a link to any list that never downloaded, and
    **Ask Ember**. The numbers, domains and devices open the query log at what they count.
  - Query log: every recent lookup, newest first, with the device, what AdGuard did and which
    list did it, filtered to **All**, **Blocked** or **Allowed** and **Find a domain or
    device**; **Allow** or **Block** on any line; **Older** and **Newer**. Tap a domain, or **Why
    is it blocked or allowed?**, for AdGuard's own answer.
  - Filters: allow or block a domain (a custom rule for it and its subdomains), **Custom rules**
    with **Take off**, and filter lists (blocklists and allowlists) with an **On** switch,
    **Remove**, **Update filter lists** and **Add list**.
  - Blocked services: whole apps and sites (TikTok, Roblox) by group, **Find a service**, then
    **Review the change** as one plan.
  - DNS rewrites: names AdGuard answers itself (plex.home, or *.home for every name under it),
    **Add rewrite** and **Remove**.
  - AdGuard Home is your network's DNS, so it is protected: every change is a plan, and approving
    it asks you to confirm it is you. A list address that holds a key is shown masked. DNS
    servers, encryption, DHCP, clients and schedules stay in AdGuard Home (**Open AdGuard
    Home**).

<!-- feature: pihole-panel -->

- **Pi-hole** (Pi-hole 6 or newer, with its app password in the vault):
  - Overview: whether it is blocking ads, **Pause blocking** (5 minutes, 30 minutes, 1 hour, or
    until you turn it on) and **Turn blocking on**; queries, blocked, devices and domains on
    blocklists in the last 24 hours; queries per hour; **Most blocked**, each with **Allow**;
    **Busiest devices**; when the blocklists were last updated, **Update blocklists**, and a link
    to any list that could not be downloaded; Pi-hole's own warnings, with **Ask Ember**.
    The Queries and Blocked numbers, a most blocked domain and a busiest device open the query log
    at what they count.
  - Query log: every recent lookup, newest first, with the device that asked and what Pi-hole did
    (blocked by a blocklist, by a pattern or by name, or allowed from cache or upstream), filtered
    to **All**, **Blocked** or **Allowed**, a domain (**Find a domain**) and a device (**Every
    device**); **Allow** or **Block** on any line; **Older** and **Newer** move 100 at a time. Tap a
    domain, or **Why is it blocked or allowed?**, to see the rules and lists that decide it, with
    **Allow** or **Block** and **Ask Ember**.
  - Lists and domains: allow or block a domain by name, or tick **A pattern (regular
    expression)** to match many names; **Always allowed** and **Always blocked** (patterns marked)
    with **Take off**; every blocklist and allowlist with its domains and last update, an **On**
    switch, **Remove**, and **Add blocklist** (used from the next update).
  - Local DNS: **Local names** (plex.home is 192.168.1.10) with **Add name** and **Remove**, and
    **Aliases (CNAME)** with **Add alias** and **Remove**. Pi-hole restarts its DNS for a second
    after each change.
  - Pi-hole is your network's DNS, so it is protected: every change is a plan, and approving it
    asks you to confirm it is you. A list address that holds a key is shown masked. Groups,
    upstream DNS servers and DHCP stay in Pi-hole (**Open Pi-hole**).
- **Audiobookshelf**: **Listening now**, **Currently listening**, **Recently added**; a book on **Continue listening** has **Remove from Continue listening** (its progress is kept).
- **Kavita**: **Libraries**, **Files Kavita could not read**, **Scheduled jobs**.
- **Immich**: tabs Overview, Diagnostics, Photos, Files and folders.
  - Overview: **Recent photos**, the newest 20 on the timeline, in a box that scrolls up and down.
    **Show**, **Blur all** or **Off** for the whole section. Each photo's **...** menu: **Show
    normally**, **Blur** (blurred until you click it) or **Hide** (also left off the Overview).
    These are Hearth's own settings: Immich is not changed. **See all photos** opens Photos. Then
    **Jobs** and **Who uses the space**.
  - Photos: every photo on the timeline, newest first, loading more as you scroll down. Archived
    and locked photos are never shown in Hearth.
  - Album tabs: **All photos**, then one tab per album, the most recently changed first, on one
    line; albums that do not fit are under **More albums**. An album tab shows that album's
    photos with the same tools (select, full view, flip and turn). While choosing photos in an
    album, **Take out of this album** takes them out (they stay in Immich), with **Undo**. An
    album made in Hearth gets its tab straight away (**Open the album**).
  - **Select** chooses photos: tap or click each (a check shows on it), or Shift-click to choose
    a run from the last one. The bar at the bottom shows how many, **Select the N shown** (the
    photos loaded so far), **Select whole library** (every photo on the timeline; in an album tab,
    **Select the whole album**), **Clear** and **Done**. Chosen photos stay chosen as more load.
  - **Put in an album**: **New album** (type its name; a name Immich already has is refused, so
    you add to that one instead) or **Add to an album** (photos already in it are left as they
    are). It shows the chosen photos, then **Review and approve**: one plan, in steps of 500
    photos (up to 6,000 at once), with a progress bar. Hearth reads the album back before it says
    done; **Undo** takes the photos out again (they stay in Immich). If a step fails, the earlier
    steps are undone.
  - **File names** in that dialog: when Immich's storage template is on, it shows the names the
    first chosen photos will get (if this is their first album); otherwise it says Immich keeps
    its own names. Either way it links to **Files and folders**. Hearth never renames a file
    behind Immich's back: that would break Immich's library.
  - Click a photo for the full view: arrows (or the arrow keys) for the next one, **Open in
    Immich**, **Download**, **Share photo** (the device's own share menu sends the picture itself,
    where the device can), and **Share a link**: choose **Link works for** (1, 7 or 30 days, or
    until you remove it), approve the plan, then **Text**, **Email** or **Copy link**. Anyone with
    the link can see that photo. **In Hearth**: **Show**, **Blur** or **Hide**.
  - **Edit** in the full view: **Turn left**, **Turn right**, **Flip left to right**, **Flip top
    to bottom** and **As taken**, with a live preview; **Cancel** leaves it, **Save** is a plan you
    approve. It is Immich's own edit (Immich 2.5 or later): the original file is never changed,
    and **Restore original** removes the edit. An existing crop in Immich is kept. Live photos
    cannot be edited.
  - **Files and folders**: how Immich names and files photos on disk, with its storage template
    (the only supported way). It shows whether the template is on and its pattern. Build one
    from **Folders** (**By album**, photos in no album by year and month; **By year**; **By
    year, then month**) and **File names** (**Keep the original name**; **Date, then the original
    name**; **Album, date, then the original name**). **Where some of your photos would go**
    shows real photos, where each file is now and where it would go. Immich dates photos by when
    they were taken, in its server's time zone (its TZ setting). Its API does not say which, so
    Hearth works it out from photos Immich already filed by a dated pattern; until then the
    preview uses UTC, Immich's default, and says so. Ember's cursor may try the choices (they
    only change the preview), never **Review and approve**.
    - It applies to the whole library. Immich moves and renames the files it already has, with its
      own job. Names come from the album, date and original name only: there is no 001, 002
      counter (a clash gets +1). Immich still shows the original name. External-library photos
      are never moved.
    - **Review and approve** is one plan: the pattern before and after (in words and exactly),
      then Immich's storage template job. Hearth shows the job's progress, then checks a few
      photos are where the pattern says and Immich still finds them. **Turn it off** stops new
      renaming (files stay where they are). Changing it needs an administrator's key with the
      systemConfig.update permission (or all permissions); otherwise the tab says so.
- **ErsatzTV**: **Streaming** now and next, **Find a channel**.
- **Syncthing**: folders and **Other machines**.

<!-- feature: generic-panel -->

### Apps without a panel of their own

Any other web app you add shows **the app itself** on its Overview, its own page inside the panel,
with a thin strip above it: the app's name and **Hearth view** (switch between them; each app
remembers), start, stop and restart, **Open in a new tab**, and **Details** (the container). The
app decides whether it may be shown inside another page; Hearth only reads that and never changes
it. An app that says no gets a big **Open** button (it opens in its own tab) with the reason, and
Hearth's view below. Sign-in is the app's own. On a phone the Open button comes first, with
**Show it here anyway**.

**Hearth view** is the basic panel: whether it is **Answering** (and how
fast), its version, **Open web UI**, **Recent log lines** (for a container), **Ask Ember what is
in it** and a box to ask Ember to do something in it. Ember reaches the app's own API with its key
from the Secure Vault (you can add one for the app there); any change is a plan you approve, or
direct with Full access. Its container's state, restarts, CPU and memory follow below.
**Request a full panel** opens the panel request board with the app filled in; the most
asked-for are built first. When Hearth gets a full panel for the app, it replaces this one by
itself. Databases, caches and the VPN keep their plain container view.

<!-- feature: panel-builder -->

### Ember Panel Builder: a better panel for an app

On an app's panel, the sparkle button in the header opens **Improve this panel**. That works on a
basic panel and on Hearth's own panel for an app: there your panel goes over Hearth's, **Show
Hearth's panel** brings Hearth's back in one click, and Ember starts from what Hearth's panel does,
telling you before it leaves anything out. Network and security apps (VPN, proxy, DNS, sign-in and
password apps) always keep Hearth's panel. Before **Apply**, Hearth says how your panel reads the
app (its key or Hearth's saved sign-in) and that it can stop working if the app changes how it
answers, usually after you update the app or change its settings. If that happens the panel says
which part stopped, with **Ask Ember to fix it** and Hearth's panel one click away; a sign-in that
ran out is said as a sign-in, not a broken panel. Choosing to
improve it with Ember opens the Forge on that panel and starts the conversation: Ember says
you're working on your panel and asks how you'd like it to look. Describe it in your own words
(poster folders that open details, a trailer player, a Request button, anything); Ember looks at
what the app can show (its API documentation and real reads) and builds it, and the **Forge
preview** on the panel changes as you talk. Press **Apply** when you like it. A panel is either
Hearth's own blocks or Ember's own page for it, which runs sealed: no internet, no keys and no
Hearth session. It reads only that app, through Hearth, with its key kept in the vault; a trailer
plays in Hearth's own player over the panel; anything that changes the app (a Request button) is
a plan you approve, with the exact request shown. A list of movies
or shows whose app gives posters (Seerr, Tasterr, Radarr, Sonarr) shows as cover art, the
pictures fetched by Hearth from the movie database; lists show years and ratings plainly (2026,
8.2, and Not rated for none) and long ones show 8 rows with **Show all**. Ember's draft
shows on the panel itself, each block marked **Real** or **Not possible** (with why), with
**Kept** and **Dropped** per block. **Apply** lists what the panel reads and how often before
anything is applied, and is refused while a kept block (or one of its page's reads) has no working
read. **Show basic
panel**, **Back to basic** and earlier versions stay one click away; **Refine this panel** asks
Ember for a new version. Custom panels are kept in Hearth's database, so updates and backups
keep them. Anything custom is part of **Hearth Premium** (Panel Builder): building with Ember,
**Load a panel file** (a panel someone shared, or one you saved; it opens as a draft), installing
and sharing. Without Premium, those show what Panel Builder is instead, every app keeps Hearth's
own or basic panel, a custom panel made earlier is kept but the basic panel shows, and **Request
it** stays free. With Premium your panels stay private unless you choose to share one: **Donate
your panel** shows exactly what would be published, asks you to accept the contributor agreement,
and lets you choose who is credited (a name, a GitHub user name who becomes co-author of the commit
that adds it, or no credit). Donating doesn't mean your panel will be added: every panel is
reviewed, and if it's added you get credit. Donated panels that are added become **skins**: on an
app that has one, **Panel style** offers **Hearth's own** or **Skin by @name**, and a skin's panel
says **Made by @name**. Settings, About lists who made each skin. **Save panel file** keeps a copy
of the design (never a key, address or data). Apps with a panel Hearth ships, infrastructure
and Hearth's own tools are never changed this way.

<!-- feature: saved-sign-in -->

### Signing Hearth in to an app with no API key

Some apps (Tasterr, for example) have no API key: they only let in a browser that signed in.
Their panel shows **Sign Hearth in to** the app. Hearth signs in like a browser would, keeps the
session in the Secure Vault (encrypted, sent only to that app's own address, never to the page or
Ember) and reads the app with it. The box shows every way the app offers:

- **Sign in with Plex**, for an app you sign in to with your Plex account: press it, then
  **Allow** in the Plex window, once. No password is needed. Hearth reads the app now and then so
  the app keeps the session going; if the app ever ends it, the panel asks for **Sign in with
  Plex** again (Plex needs you to press Allow; Hearth can't do that for you).
- A user name and password, for a local account in the app (**I use a ... user name and password
  instead**, or straight away when it's the only way). It goes into the Secure Vault, and Hearth
  signs in again by itself whenever the session runs out, including after a Plex session ends.

Ember's draft panel says the same thing when a block can't be read yet: sign Hearth in above.
Apps that do have an API key (Seerr, Overseerr, Tautulli) use their key instead, whether you sign
in to them with Plex or not.

---

<!-- feature: storage -->

## 8. Storage & Files

Sidebar **Storage**, or the Lair panel **Storage & Files**. The **PC menu** at the top switches
every tab to another PC in your Hearth (read only from here; changes are made on that PC).

- **Overview**: physical drives, total capacity (used and free), overall status, average
  temperature, each drive with its verdict and space, **Recent file activity**, the **File
  explorer**, and **Current storage operations** (downloads, imports, scrubs, rebuilds).

<!-- feature: drive-health -->

- **Drives**: each drive's own health verdict and what the system shares (type, connection,
  size, temperature, powered on, rated life used, read and write errors, self-test, firmware).
  Hard drives have no single health percentage, so none is shown. Rename a drive (its name
  becomes the card title). Reading full drive health may need the elevated executor.

<!-- feature: file-manager -->

- **Files**: a file manager over your drives: **Back**, **Forward**, **Up one folder**, the path,
  **Filter this folder**, **Search here and below**, **Copy path**, details (size, dates,
  preview). **Rename, move, or copy (asks you first)** and **New folder here**: nothing is
  deleted or replaced, and folders Radarr, Sonarr or a download client manage are refused.

<!-- feature: file-journeys -->

- **Recently Added**: new files, by library or downloads, within a day to 3 months, by kind
  (video, audio, books, images, subtitles), searchable. **Open in folder**, **See its journey**.

<!-- feature: file-journeys -->

- **File Journeys**: each download from the grab to Plex (Radarr, Sonarr, qBittorrent, SABnzbd,
  Plex), sorted into **Needs a look**, **Waiting or in progress**, **Done**.

<!-- feature: raid -->

- **RAID / Arrays**: every array and pool (mdadm, ZFS, Btrfs, SnapRAID, Storage Spaces; Unraid,
  DrivePool, LVM and hardware RAID are detected). Each shows **Usable**, **Raw**, **Members**,
  **Can lose** (how many drives it can lose). Actions: checks and scrubs (with **Scheduled
  checks**), **Replace…** a member, add a spare, grow, convert, speed limits, and **create a new
  array** from **Drives Hearth could use** (any drive holding data needs you to type **ERASE**).
  Changes need the elevated executor and your approval. RAID is not a backup: keep a copy
  elsewhere.
- **Health & History**: **Space over time** with a forecast, and open incidents about storage.

<!-- feature: collection-pdf -->

- **Collection PDF**: a printable catalog of your library. **PDF title**, **Folders to list**
  (each named, as Movies, Shows, Audiobooks by author, or Ebooks and comics by author), **Save
  folders**, **Make PDF**. **Your PDFs**: open or download. Hearth only reads the folders.

**Watched folders** (Storage page): **Watch a folder** to browse it here; **Stop watching**.

---

## 9. Projects, plans and lists

<!-- feature: projects -->

- **Projects** (All projects): **Start a project** (name, what it is for, icon, systems it
  concerns). A project has **Overview** (checklist, open threads, systems, **Pause**, **Mark
  complete**), **Tasks**, **Logs**, **Terminal**, **Files**, **Notes**, **History**.

<!-- feature: jobs -->

- **Jobs**: plans of steps Hearth already knows. **New plan** (title, why, steps) then **Review
  the plan**. A job shows each step's **Exact change** (before and after), how it is checked,
  and what happens if a later step fails. **Approve and run** covers exactly that plan, once.
  **Stop after this step** while running. Jobs is the full list and history; it is never the
  only place to approve.

<!-- feature: approvals-here -->

- **Approvals where you are**: a plan Ember proposes in a chat (Ask, the Lair, the build
  hand-off, with any AI agent) shows its card right there in that chat: the steps, before and
  after, **Approve and run** and **Decline**. That includes a plan made in an automatic
  follow-up after a step finishes. A protected step asks you to confirm it's you in the same
  card. Once approved, the card shows each step as it runs, the result follows in the chat, and
  while building your plan Ember proposes the next step. On any other page (the War Room too), a
  plan Ember or Hearth proposed slides in as **Needs your approval** with the same card and
  buttons; **Later** hides it (it stays in Jobs). Hearth's own instructions to the AI (the
  automatic follow-ups) never show in the chat: only Ember's reply does.

<!-- feature: todo -->

- **To-do**: **To deal with**, **Deferred**, **Resolved**, **Dismissed**. **Add an item** (kind,
  title, details, system, project, priority, for later). Each item: **Mark resolved**, notes,
  history, evidence when it was noted. **Add to to-do** buttons elsewhere put things here.

<!-- feature: todo-panel -->

- **To-do in the Lair**: **To-do** in the Lair's row of systems opens the list as a panel beside
  Ember: **To deal with** and **Done**, tick an item off, add one, change its priority. **The whole
  list** opens the full page.

<!-- feature: saved-work -->

- **The Forge** (anvil icon; was Saved work): where you and Ember work through things together.
  Ask for anything with many items ("find duplicate movies in Plex and lay them out in the Forge")
  and Ember opens a Forge sheet beside the chat: every item, what it found and what it would do.
  Search, filter, choose for each one, and send your choices; nothing changes until you approve
  the plan Ember makes from them, and each item's result shows on the sheet afterwards. The
  anvil button in the chat box asks for what you typed (or this conversation) in the Forge.
  **Forge** in the top bar (Ember at her anvil) opens the sheet you had last, open or minimized;
  with none, the Forge page. Its number is sheets waiting for your choices. The Forge page: a short
  explanation with things to try, **Waiting for you** (unfinished sheets, **Carry on**), then
  **Library** (saved sheets in your folders), **Open now**, **Notes** (what a sheet found, kept in
  Memory). In a sheet: **Save workspace**, **Minimize workspace**, search, **Plan from your
  decisions**.
  Choosing a set (for example "a Plex collection of the 30 best horror movies") opens the sheet as
  **Selected** beside **Alternatives**: Ember's picks with her reasons and the ratings she found,
  and every other candidate. Search or sort, **Add**, **Remove** and **Swap** (then **Swap in**),
  and the count shows against the target (for example "28 of 30 selected: 2 to go"). Search forgives
  typos ("hot tube time machine"); a sheet of Plex titles also searches your whole Plex library
  under **From your library**, where **Add** puts a title straight into Selected. A title you
  don't have shows under **Not in your library** (from Seerr): **Request it** is the request as a
  plan you approve, and once Plex has the title it joins Selected by itself and Ember tells you in
  the sheet's chat, ready to add it where the sheet is for. While a search
  is on, "Showing 3 of 194" and **Clear search** say so. On a phone
  it is one list at a time with a Selected / Alternatives switch. **Send my selection to Ember**:
  your list is the one used; Ember then shows the plan (one step per title, for a Plex collection
  "Add ... to ..."), and after you approve, Plex adds them and Hearth reads the collection back.

---

<!-- feature: releases -->

## 10. Releases

**Releases** (**Release watch**): follows every movie requested in Seerr (Overseerr, Jellyseerr)
until it is in your library.

- **Upcoming**, **Needs a look**, **Arrived**, **Dismissed**. Each movie shows its dates (in
  cinemas, digital), what Radarr is doing, and **What is in the way**.
- A movie past its digital release with nothing grabbed is **overdue** (after the days you set);
  it moves to **Needs a look** and you get a notification.
- **Check now**, **Snooze a day**, **Snooze a week**, **Stop snoozing**, **Bring back**.
- **Release watch settings**: **Watch movie requests**, **Overdue after** (days), the **Country
  for release dates**, and **What to tell you** (which notifications).

---

## 11. Monitoring

**Monitoring** in the sidebar opens a page with four tabs, like Settings: **Findings**,
**Incidents**, **Autonomy** and **Notifications**. Each tab keeps its own address (for example
`/autonomy`), so links still open the right one.

<!-- feature: findings -->

- **Findings**: what Hearth noticed (not yet a problem, or a pattern). Each says **What Hearth
  saw**, **Why it matters**, **What to do next**, **Evidence**. **Add to my list**, **Mark as
  seen**, **Snooze a week**, **Accept as it is** (with a reason; **Stop accepting**),
  **Investigate**. Filters: Open, Resolved, Accepted, Dismissed.

<!-- feature: incidents -->

- **Incidents**: problems with a timeline, what happened, who handled it, and the **Proposed
  repair** (**Approve repair** when autonomy asks you). Every check and decision is recorded.

<!-- feature: autonomy -->

- **Autonomy**: how far Hearth and your AI may go: **Monitor**, **Diagnose**, **Ask before
  fixing**, **Fix automatically**. A default, then **By area** and per service. Some actions
  **Always ask you**, whatever the setting.

<!-- feature: notifications -->

### Notifications

- **Channels**: Discord, email, ntfy, Telegram, webhook and browser push. **Set up**, **Send
  test**, **Change**, **Stop**, and an on/off switch each.
- **Change** edits everything about a destination in place, in one save, never delete and redo:
  - **Name**, and **Send with**: the way it sends (Discord with the Hearth bot, a Discord webhook
    or your own bot, email, ntfy, Telegram, webhook). Switching asks only for what the new way
    needs (a webhook address, a token, a channel to pick); the name, who reads it, its messages,
    movie-night use and history stay.
  - The way's settings: server and channel picker, webhook address, token (kept in the vault;
    leave it empty to keep the saved one).
  - **Who reads it**, **Quiet hours** (**Hold until morning** or **Send any time**) and
    **Messages it gets** (friends-and-family destinations get media announcements only).
  - **Send test** tries the settings before they are saved. **Save changes** saves it all at once;
    the save shows in Changes and activity.
  - After a switch, the old way and its token are kept: **Switch back to ...** returns to it, and
    **Forget the old settings** removes them (and the old token).
  - **Undo last change** on the destination's row (for a day) puts the last save, or switch back,
    as it was.
- **Broken**: when a destination turns a message away for good (a Discord webhook deleted in
  Discord, a channel Hearth can no longer reach, a token that no longer works), its row says
  **Broken** with the reason, and the top of the page names it with **Fix it**, which opens its
  **Change**. A busy or slow server is not broken. The warning clears once a message gets through.
- **Add a destination**: another channel of a kind; **Who reads it**: **Just me** (any
  notification) or **Friends and family** (only media announcements, never alerts).
  Discord kinds:
  <!-- feature: hearth-bot -->
  - **Discord (Hearth bot, one click)** (where offered): **Add Hearth to my server**, then pick
    the channel. No token.
  - **Discord**: a webhook (channel settings, Integrations, Webhooks, Copy Webhook URL). Posts
    only.
  <!-- feature: discord-own-bot -->
  - **Browser push**: Hearth's messages as notifications on this device, even with Hearth
    closed. **Turn on for this device** (the browser asks to allow notifications) on each phone or
    computer you want them on; **Turn off for this device** stops them there. It needs a secure
    (https) address, such as your Tailscale one; on an iPhone, add Hearth to the home screen first.
    The channel shows how many devices have it.
  - **Telegram**: alerts to a Telegram chat through your own bot. In Telegram, message
    @BotFather, send /newbot and copy the token; open your new bot and press **Start** (or add it
    to a group and say hello); paste the token in **Bot token** and **Set up**: Hearth checks the
    token and finds the chat itself. Alerts only: nothing you write to the bot is acted on.
  - **Discord (your own bot, with buttons)**: a guided setup: make the bot on Discord's
    developer site, paste its token (**Check it**), **Add** (your bot's name) **to my server**, pick the channel.
- **What goes where**: each kind of message (needs your attention, repaired automatically,
  repair failed, critical, weekly summary, a word from Hearth, long work, movie releases, Hearth
  updates, new in your library) and which channels get it.

<!-- feature: briefs -->

- **Briefs and watches**: things you ask for in your own words, also by asking Ember ("every
  weekday at 7, send me a server summary", "tell me if a disk goes over 90%"). **Add a brief or
  watch**: **A server summary on a schedule** (days and a time: services, machines offline, the
  fullest disk, what needs you, what changed, what's working), **Tell me when a disk gets full**
  (any disk or one, over a level you pick), **Tell me if a service stops answering**, **Tell me
  if a machine goes offline** (any or one); **Send to** picks channels (none picked: where
  "Needs your attention" goes). Each has **Send now**, an on/off switch, **Change** (the same
  form, saved over it in place) and **Remove**. A summary
  goes once on each chosen day (up to three hours late if Hearth was off at the time); a watch
  says so once when it trips, and again when a service or machine is back, and waits out quiet
  hours. They only read and tell: anything that would change a system is still a plan you approve.
- **Quiet hours**: **Hold routine messages overnight** (22:00 to 07:00; only critical matters
  come through). A destination set to **Send any time** (its **Change**) gets everything at once.
- **Recently sent**: what went out.

<!-- feature: media-announcements -->

### Media announcements

When something becomes available in your library (not just downloaded). Movies and shows come
from Plex, Jellyfin or Emby; music from Plex, Jellyfin, Emby or Navidrome; audiobooks, ebooks and
podcast episodes from Audiobookshelf; books and comics from Kavita (not yet: it is switched on once checked against a real Kavita); games from RomM. Downloaders
(Lidarr, Readarr) never announce, and personal media (photo libraries, home videos, Immich, Kavita
image libraries) is never read. What is already in a library is never announced, including when a
kind is turned on later, and anything added more than two days earlier is not news.

- **What to post**: Movies, New series, New seasons, Episodes. Under **More from your library**,
  only the kinds an installed app can supply: **Music (albums)**, **Audiobooks**, **Ebooks**,
  **Comics**, **Games**, **Podcast episodes**. Each is off until you tick it. Several of a kind
  that comes in bursts (albums, ebooks, comics, podcast episodes) wait 15 minutes and go out as
  one post, like "6 new albums".
- **Ember's line on each post** (her name as you renamed her): **Playful**, **Gentle** or **Off**.
  A short line at the top, from a written set matched to the kind, genre and decade, never the
  same one twice in a row on a destination. It never names who asked for something; health,
  religion, sexuality, self-help and children's titles only get a plain line. **Let Ember write
  it**: she writes each line with your AI instead (counted in today's AI use), **Daily cap** of 5, 10, 20 or 50 lines a day (never more than 50; past it, the written lines until tomorrow); a line that fails the checks (too long, a name, a link, anything mocking) is
  swapped for a written one. The preview always shows a written line; a test send can be hers.
- **Customize for each destination**: what one destination gets and its line's tone, when they
  differ (a family channel with movies and audiobooks, a friends' channel with music only);
  **Use the settings above** goes back.
- Design each: **Style** (**Banner**: one picture Hearth makes with the heading, title, details
  and poster on the backdrop, above the post; **Cinematic**; **Streaming style**; **Compact**),
  **Heading**, **Accent color**, **Sender name**, **Sender picture**,
  **Branding line**, **Include** (poster or backdrop, synopsis, genre, runtime, ratings, trailer
  link when a verified one exists, available in Plex or Jellyfin).
- **When**: **As each one arrives** or **One daily roundup at** an hour; **Hold overnight**;
  announce per library; **Never announce titles containing**.
- **Preview with** a real title (with a test destination chosen, its tone is shown), **Send a
  test** (marked as a test), **Check now**, **Recent announcements** with **Try again**.

<!-- feature: movie-nights -->

### Movie nights

Its own panel in the Lair (**Movie nights**, once a media server is connected). Who gets invited
is the destination chosen for New in your library, in Notifications.

**Plan a movie night**: **Find a movie in your libraries**, **When**, **Spots** (or no limit),
**A note for your friends** (bold, in a quote box), saved **Discord channels** (click one to add
it to the note, or type #name), **Where to watch** (your words, saved places, or ideas such as
Plezy Watch Together and Jellyfin SyncPlay; empty uses the links Hearth finds), **Room code**,
**Style** (**Banner**: one picture Hearth makes, like a streaming app's banner, with the title,
time and poster over the movie's backdrop, leading the post; **Cinematic**: the poster beside the
details; **Streaming**: a wide picture under the invitation; **Compact**: a small poster and a
shorter story line), **Reminders** (a day before, an hour before, when it starts), **Invite**
(destinations; ones with RSVP buttons are marked). **Post the invitation**.

On Discord it is one message that updates itself. A planned night: **Who's coming?** (add
guests), **Change the time**, **Where to watch, room code**, **Change the style** (the Discord
post updates in place), **Cancel it** (tells everyone).

A movie in the Plex or Jellyfin panel has **Plan a movie night**: the panel opens with that movie
already chosen. With nowhere to send invitations yet, the panel asks **First, where do
invitations go?** and its button opens the setting (adding a channel, or choosing who is invited).
The Home dashboard's **Movie Night** widget shows the next night, when, and who is coming.
Posted by a bot, the invitation has **I'm in** and **Can't make it**: friends tap, the guest
list and the post update, and only they see the reply.

---

<!-- feature: vault -->

## 12. Secure Vault and keys

- **Secure Vault**: every key and password your homelab uses, encrypted the moment it reaches
  Hearth. Unlock with your passkey (PIN, fingerprint or face) or password; **Lock now**.
- **Add a credential**: name, category, which service it belongs to, username, where it is used,
  **How it can be used** (read only, or changes you approve), notes, tags.
- **Automation** keys are used by Hearth for you; **Protected** ones need you each time.
- The **Hearth API key** (top of the vault): links a new PC to this Hearth.
- **Find my keys**: Hearth finds the keys your apps already have (it asks first, then copies
  each into the vault).
- AI agents never see a key's value. Never paste a key into a conversation: use the app's
  panel (**Paste the API key**) or the vault.

---

## 13. Docker, Network, Backups, Logs, Memory, Integrations

<!-- feature: docker -->

- **Docker**: containers Hearth watches, by machine; open one for health, logs and history
  beside Ember.

<!-- feature: network -->

- **Network**: machines, the addresses services answer on, and which reverse proxy publishes
  them (**Public address**, **Through**, **Not published**).

<!-- feature: backups -->

- **Backups**: once a day after 3 in the morning, Hearth backs up its database and memory,
  checks the backup, and copies it off the machine when set up (**Off this machine**). **Keys to
  keep safe**: **Show the keys** (store them in your password manager).

<!-- feature: lab-blueprint -->

- **Lab Blueprint** (Settings, Backups): a written plan of the whole lab for rebuilding it on
  another machine: every app with its compose settings (values hidden), drives, networks, install
  order, where each app keeps its own backups, and the vault entries. Once a day after 4 in the
  morning Hearth checks the lab (no AI involved) and, when anything changed, saves a new dated
  version to a folder or cloud storage you choose, encrypted so only your recovery key opens it;
  the last 7 are kept. Choose **A folder** (a drive, NAS share, or a folder Dropbox, Google Drive
  or OneDrive syncs) or **Cloud storage**: Backblaze B2, Cloudflare R2, Wasabi, Amazon S3, other
  S3-compatible storage (MinIO, NAS), or Nextcloud and other WebDAV. Hearth tests the connection
  first and keeps the cloud login in the Secure Vault. Then **Save recovery sheet** or copy the
  key and type it back to finish. Daily versions leave out protected vault entries; **Update now** while the vault is
  unlocked includes them. **See what it says**, **Test my key**, **Change where or key**, notes
  for things Hearth can't see. On a new machine, **Import a blueprint** shows what it holds
  before adding vault entries; then ask Ember to plan the rebuild. If the folder is on the system
  disk you are warned, and a failed or two-day-old blueprint shows in Needs you.

<!-- feature: activity -->

- **Changes and activity**: every change by you, Hearth or the AI (the audit trail), and what
  monitoring noticed. Secret values never appear.

<!-- feature: memory -->

- **Memory**: what Hearth remembers about your homelab. **Remember something** (kind, title,
  details, project, how it is known), **Search memories and conversations**, filters (Threads,
  Journal, Wins, How you work, Hardware, Notes), **Projects**, **Saved sessions** (whole
  conversations, word for word), **Recently deleted**, **Review your notes** (imports).
  Never put passwords or keys in memory.

<!-- feature: integrations -->

- **Integrations**: which apps Hearth understands beyond "is it running": **Connected**, **Found
  on your network**, **Available**.

---

## 14. Settings

Tabs: **General**, **PCs and devices**, **Ember**, **Security**, **Backups**, **Monitoring**,
**Systems**, **Premium**, **About**. A link like `/settings#cave` opens a tab.

<!-- feature: settings-general -->

- **General**: **This PC** (name and icon), your name and picture, **Pictures beside
  messages**, **Open web UIs** (how app links open), **Time zone**, **Theme** (and your own
  colors; **Desktop** and **Phone**: phones use the desktop's look until you pick one for them,
  and **Use the desktop's look on phones** goes back), **First-run setup**, **Getting started**, **Removed systems**, **Support Hearth**
  (Buy Me a Coffee).

<!-- feature: panel-looks -->

- **Service panels** (under Themes): how service panels look. **Minimal** (the default) is the
  plain dark panel. **Service branding** gives every service panel its own identity inside Hearth's glowing lava
  frame and flame: Sonarr, Radarr, Overseerr and qBittorrent use their own painted artwork; every
  other service gets its own color lighting the header and its real logo drawn large and faint.
  Hearth's controls, type and ember accents stay the same everywhere. With Service or Hearth branding,
  Ember's own panel (the conversation) sits in its painted lava frame too. **Hearth branding** puts
  Hearth's ember look on every service panel. Only the look changes: every control and tab works
  the same. Saved to your account.

<!-- feature: pcs-and-devices -->

- **PCs and devices**: **PCs** (icon and name, **Link another Hearth** with a one-time join link and
  command, **Uninstall** from any device), **Devices** (**Add a device**: a QR code for a phone,
  tablet or the Hearth app; **Disconnect**), **Open to my home network**.
- **Ember**: identity, voice, personality, writing assistance, **Full
  access**, **Ollama**, administration, tools, AI use and budget, **Homelab rules** (**Do not
  touch** list, **Reserved times** when a machine or GPU is yours, and **Your own rules**: what
  Ember should always keep in mind, in your words, sent with every Lair message).

<!-- feature: security -->

- **Security**: **Passkeys** (fingerprint, face or Windows Hello; they need a secure https
  address, such as your Tailscale one), **Password** (change it), **Sign-in name and new
  password** (for signing in elsewhere without the old password), **Signed-in devices** (**Sign
  out** any, or **Sign out on every device**), **Recovery key** (**Make a new recovery key**;
  the old one stops working at once; keep it in your password manager), and **Access keys** for
  other software that talks to Hearth, such as Home Assistant (each does only what you allow;
  none can change settings, security or autonomy, or open the vault; shown once).
- **Backups**: see section 13.

<!-- feature: monitoring-settings -->

- **Monitoring**: **Check services** (how often), **Open an incident after** (failed checks in a
  row), **Resource history** (keep hourly CPU, memory and disk for), **Restart history**.
- **Systems**: discovery, sample data and scenarios.

<!-- feature: premium -->

- **Premium**: Hearth is free for your homelab, with no limits. The extras are Premium: **Hearth
  Connected** (linking two or more Hearth installations and working on one through another),
  **Ember Show & Tell** and **Panel Builder** (Ember building a custom panel for an app with you).
  All of Curator, For You included, is free. Each shows **Included** or **Not included**, and whether it is
  complimentary and until when. **Upgrade to Premium** works any time on a Hearth you already
  use: **Sponsor Dragon's Oath** (GitHub Sponsors, opens with the public launch) or **Enter a
  code** (bought, gifted or a promotion; a gifted code says so). Every Premium feature you don't
  have links here with **Upgrade**. **Redeem a code**, or **Add a licence key** someone sent you (it
  is checked on this Hearth, offline, and is made for one installation: give them **This
  installation's ID**). Paying is never done in Hearth, and Hearth never asks for card details. Premium never checks in on a schedule: Hearth reaches the licence service only when you enter a code (and then also learns of any licence taken back). When Premium ends or is taken back, Hearth only stops new links and
  Show & Tell; your links, settings and data are kept, and every Hearth works on its own.
  On the owner's issuing Hearth, **Issue Premium**: **Grant Premium** (who, which features, how
  long, their installation ID, a private note; $0, no card, never renews; a licence key to send
  them, shown once), **Make a promo code** (features, how many can use it, how long each grant
  lasts, redeem by; the code is shown once), **Revoke** or **Reinstate** a grant, **Switch off** a
  code.

<!-- feature: updates -->

- **About**: version, **Update now** (and every PC's version with **Update all my PCs**), and **Check for updates**: on, Hearth asks GitHub every few hours whether a newer Hearth is out; off, it never checks on its own, only when you press **Check now**. **Release channel**: **Stable** (the default) offers only releases marked stable, after they have run on the fast channel first; **Fast** offers every release as soon as it is out. Update now installs the version shown, and never moves Hearth to an older one.

---

<!-- feature: pcs-and-devices -->

## 15. More than one PC, phones and the app

- Linking PCs is **Hearth Connected** (Premium, Settings, Premium). You pay once: Premium on one
  Hearth covers every Hearth linked to it, with no code of its own (a PC linked to it shows its
  Premium features as **Included**; unlinked, it goes back to free). Every Hearth works fully on
  its own, free, on as many PCs as you like; reaching apps, Docker or a NAS on another machine is
  free too. Without it, **Link another Hearth** says so, and points to the free option: watching
  another machine's apps, Docker or a NAS is **Add a system** on the Services page. PCs already
  linked stay listed and can be unlinked.
- One Hearth account across PCs: install Hearth on another PC and choose **Link to my Hearth**
  (it finds your Hearth; paste the **Hearth API key**), then name it and pick its icon. Its
  projects and systems show everywhere, marked with its icon. A Hearth already set up on its own
  can join later: on it, Settings, PCs and devices, **Join another Hearth** (confirm it's you,
  then the same steps). Everything on it stays (its projects, systems, memory and keys), a
  backup is made first, and if your Hearth ever removes it, it goes back to its own account.
- **Layout** (Settings, PCs and devices): each Hearth keeps its own layout. **Copy another
  Hearth's layout** makes this one look like another of your Hearths: choose it (found on your
  home network and Tailscale, or type its address), paste its **Hearth API key** (from its
  Secure Vault; it only lets this Hearth read the layout), choose what to copy (the Lair's saved
  layouts, app strip order and chat dock; the home dashboard's widgets, Home Assistant devices,
  clock and start page; the theme and the AI's look; the sidebar), **See what changes**, then
  **Copy it here**. Apps and projects are matched by name; any this Hearth doesn't have are left
  out and named. **Undo** puts this Hearth's layout back. Do the same on the other Hearth to
  copy the other way.
- Storage, the War Room and the Lair can work on any PC from any device.
- Phones and tablets: Settings, PCs and devices, **Add a device**, scan the QR code. The Android
  app installs Hearth as a home-screen app.
- **Away from home**: the simplest safe way is Tailscale. Install it on the Hearth machine and on
  the phone or tablet, sign both in to the same account, and open Hearth at the machine's
  Tailscale address (a 100.x.y.z address, or its Tailscale name) with the same port, for
  example 100.64.0.5:7600. Nothing is opened to the internet, and only your own devices can reach
  it. Turn Tailscale on in the phone's app whenever you are out. A reverse proxy with https on
  your own domain also works, but it puts Hearth on the internet, so set up its sign-in first.

<!-- feature: updates -->

- **Update Hearth** in the top bar when a new version is out; you choose when. Other PCs show
  as **Behind** until updated.

---

<!-- feature: memory-usage -->

## 16. When Hearth uses a lot of memory

- **The voice program**: about 1.5 to 2 GB while loaded. It stops after 10 minutes unused, or now
  with **Free up voice memory** in the War Room.
- **The Hearth window**: a reload (Ctrl+R) brings it back down if it grew.
- **AI sessions**: a War Room message starts the AI and closes it after the reply. Only a
  **Terminal** view or a live **/rc** session (War Room or Lair) keep running; exit the
  terminal or type `/rc` again.
- **The Hearth server**: normally under 1 GB.

---

<!-- feature: safety -->

## 17. How Hearth keeps you safe

- Anything that changes a system is a **plan** you approve (or done directly with **Full
  access**, which still asks before anything risky).
- **Autonomy** decides which routine fixes run without asking; some always ask.
- Protected systems (VPN, reverse proxy, firewall, networking) need you to confirm it is you.

<!-- feature: homelab-rules -->

- **Homelab rules**: a **Do not touch** list the AI is refused, even with approval,
  **Reserved times**, and **Your own rules** for Ember (they never switch off an approval).
- Keys stay in the **Secure Vault**; the AI never sees them, and secrets never appear in logs.
- Root work goes only through the **elevated executor**'s short list of operations, never a
  general shell, and you install it yourself.
