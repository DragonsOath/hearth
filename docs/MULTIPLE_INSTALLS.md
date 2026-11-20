# More than one installation on one machine

Most people need one installation. A second one on the same machine is useful for trying a new version before upgrading, for a temporary trial, or for a demo, without touching the installation you rely on.

Each installation is **its own project folder and its own systemd service**. The installer (`deploy/linux/install.sh`) keeps them apart:

- **It manages one installation per run, and with more than one on the machine you must name it** (`DC_SERVICE_NAME`). A run without the name stops and lists the installations instead of guessing from the folder. A machine with a single installation works as before.
- **It never builds, restarts, updates, or removes a service that was installed from a different folder.** It stops and says which folder that service belongs to.
- **It won't share anything.** It refuses to give a second installation another installation's port, or a data, key, or backup folder that's the same as, inside, or around another installation's. It also refuses to install one folder twice under two names.
- **It never takes over a folder that already exists** for a dedicated account. Creating the account's folders would otherwise hand an existing folder, and everything in it, to that account.
- **The dry run names everything first:** the installation, service file, account, folders, limits, and every command. It also lists the other installations it will leave alone.
- **A port answered by another program, another Hearth included, is never taken for this installation.** Only this installation's own service, on its own port, counts as an update.

## Settings for a second installation

| Setting | What it does | Example |
| --- | --- | --- |
| `DC_SERVICE_NAME` | The service's name: lowercase letters, digits, dashes. The first installation keeps the default, `dragon-control`. | `hearth-preview` |
| `DC_SERVICE_USER` | The account it runs as. Defaults to you. A dedicated account keeps the trial away from your files, your Docker access, and your Claude Code login. | `hearth` |
| `DC_PORT` | Its own port. | `7500` |
| `DC_DATA_DIR`, `DC_KEY_DIR`, `DC_BACKUP_DIR` | Its own folders. They default to `data/` inside its project folder. | |
| `DC_AUTOSTART` | `no` keeps it off when the machine starts. You start and stop it by hand. | `no` |
| `DC_MEMORY_MAX` | A hard memory limit (systemd `MemoryMax`). | `1G` |
| `DC_MEMORY_HIGH` | Above this, systemd slows it down before the hard limit (`MemoryHigh`). | `768M` |
| `DC_MEMORY_SWAP_MAX` | Swap it may use (`MemorySwapMax`). `0` keeps it out of swap, so it can't push the machine's other apps into swap. | `0` |
| `DC_CPU_QUOTA` | A processor limit (`CPUQuota`; 100% is one core). | `100%` |
| `DC_RESTART_LIMIT` | After this many failed starts in this many seconds, systemd stops restarting it and leaves it stopped (`StartLimitBurst`, `StartLimitIntervalSec`). Off by default, so it keeps restarting after a failure, as before. | `5/600` |

**Re-runs:**
- Running the installer again from the same folder keeps every setting, the limits included, so you only pass a setting to change it.
- `none` removes a limit, for example `DC_CPU_QUOTA=none`.

**What the limits cover:** the limits apply to the whole service: the server and everything it starts, including the AI's Claude Code runs. Those stay in the service's control group. If it reaches `DC_MEMORY_MAX`:
- The kernel ends a process *inside that service only*, and the rest of the machine is unaffected.
- If it was the server, systemd restarts it after 5 seconds.
- If it keeps hitting the limit, it keeps restarting, unless `DC_RESTART_LIMIT` is set. Then, after that many failed starts, systemd leaves it stopped, and its log says "Start request repeated too quickly". To start again, run `sudo systemctl reset-failed <name>`, then start it.

**Sizing:** one installation uses about 0.5 GB of memory at rest, and up to about 0.9 GB while the AI is answering. `DC_MEMORY_MAX=1G` suits a trial without the AI, and `1536M` a trial with it.

The build runs at low priority (`nice`, and `ionice` when present), so the apps already on the machine stay responsive while it compiles. It still takes a minute or two of processor time and about 1 to 2 GB of memory while it runs.

## A temporary trial with a dedicated account

The account has no sudo and no Docker group. An administrator (you) runs the installer, which builds and runs everything as that account. Show each command before running it.

1. **The account.** It has a home folder but no password, so nobody signs in as it:

   ```bash
   sudo useradd --create-home --shell /usr/sbin/nologin hearth
   ```

2. **The code, owned by that account,** in its own folder:

   ```bash
   sudo install -d -o hearth -g hearth /srv/homelab/hearth-preview
   sudo -u hearth -H git clone https://github.com/DragonsOath/hearth.git /srv/homelab/hearth-preview
   ```

3. **Folders the account can reach.** Every folder above each of these must let the account in. Don't loosen an existing owner-only folder (for example a secrets folder) to make room. Choose a place the account can reach instead, such as its home folder for keys.

4. **Dry run.** Read it all: the installation name, the account, the folders, the limits, and "Other installations on this machine (not touched)".

   ```bash
   cd /srv/homelab/hearth-preview
   DC_SERVICE_NAME=hearth-preview DC_SERVICE_USER=hearth DC_PORT=7500 \
   DC_KEY_DIR=/home/hearth/keys DC_BACKUP_DIR=/srv/homelab/backups/hearth-preview \
   DC_AUTOSTART=no DC_MEMORY_MAX=1G DC_MEMORY_HIGH=768M DC_MEMORY_SWAP_MAX=0 DC_CPU_QUOTA=100%    DC_RESTART_LIMIT=5/600 \
     bash deploy/linux/install.sh --dry-run
   ```

5. **Install.** Run the same command without `--dry-run`. It starts the service once to check that it answers, and prints the one-time setup link.

### Start, stop, check

| | Command |
| --- | --- |
| Start | `sudo systemctl start hearth-preview` |
| Stop (nothing of it keeps running: systemd stops every process in its group) | `sudo systemctl stop hearth-preview` |
| This installation's state, folders, limits, and commit | `bash deploy/linux/install.sh --status` (from its folder) |
| Memory and processor in use | `systemctl show hearth-preview -p MemoryCurrent -p MemoryPeak -p CPUUsageNSec -p TasksCurrent` |
| Its log | `journalctl -u hearth-preview -n 100` |

**Opening it from another computer:**
- It listens on this machine only (`127.0.0.1`). To open it from your desk without changing any network settings, use an SSH tunnel: `ssh -L 7500:127.0.0.1:7500 you@server`, then open http://localhost:7500.
- `tailscale serve --bg PORT` *replaces* what the machine already serves. If another installation uses Tailscale serve, give this one its own https port: `tailscale serve --bg --https=8443 7500`.

### Update and roll back
- **Update:** `sudo -u hearth -H git -C /srv/homelab/hearth-preview pull`, then run the installer from that folder with `DC_SERVICE_NAME=hearth-preview` and nothing else. It keeps its settings.
- **Your first installation:** while a second one exists, update it with `DC_SERVICE_NAME=dragon-control` too. Without a name the installer stops rather than guess.
- **Roll back:** `sudo -u hearth -H git -C <folder> checkout <earlier commit>`, then run the installer again. The database only moves forward, and an older version starts on a newer database (see DEVELOPMENT.md, "Migrations, backups, and rolling back").

### Remove it

1. **The service only:** `DC_SERVICE_NAME=hearth-preview bash deploy/linux/install.sh --uninstall`, from its folder (`--dry-run` first shows what it will do). It stops and removes that service and prints the folders it kept. It never touches another installation.

2. **Its files,** only when you're sure (this is permanent):

   ```bash
   sudo rm -rf /srv/homelab/hearth-preview /srv/homelab/backups/hearth-preview
   sudo userdel --remove hearth      # the account and its home: keys, pnpm cache, Claude Code login
   ```

**What a trial installation creates**, so you can check it's all gone:
- the service file in `/etc/systemd/system/`
- the account and its home folder
- its project folder, including `data/`
- its key and backup folders
- its lines in the system journal, which the journal rotates away by itself

Linked apps keep their own record of it. Remove those in each app if you linked any:
- **Plex:** a device under Authorized Devices.
- **Home Assistant:** a long-lived token.

It shares, and must never remove, Node.js, Corepack, git, and systemd.

## What a second installation can't see yet

**Containers:**
- An account outside the `docker` group sees no containers.
- Docker's socket gives full control, so a trial shouldn't get it.
- A read-only view of containers (through a Docker socket proxy that allows reads only) is planned, not built.

**Apps:** a second installation reads them the same way the first does, through each app's own API key or login in its own vault. Those keys are usually full access by the app's design. The installation's "read" scope is Hearth's own rule, not a limit the app enforces.
