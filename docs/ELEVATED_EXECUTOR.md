# The elevated executor

Hearth runs as its own account and never as root. Some legitimate homelab work needs more than
that account may do: editing a Compose file that belongs to you, changing a protected system's
configuration, tightening a file's permissions, restarting a system service. The elevated
executor is how Ember does that work, with your approval, without ever holding root itself.

## What it is

A small program (`/usr/local/libexec/hearth/hearth-elevated.mjs`, owned by root) that systemd
starts once per request on a socket only Hearth's account can reach. It does one approved
operation, records it, and exits.

- **A fixed catalog.** It knows typed operations, not commands: write a file, restore a file from
  its own backup, remove a file, set a file's mode and owner, create or remove an empty folder,
  bring a Compose project up or down, start or stop a listed systemd unit, and undo an earlier
  operation. There is no shell and no "run this".
- **Only approved steps.** Hearth's backend asks it to act only while carrying out a step of a
  plan you approved. Each request carries an authorization for exactly that request (its
  fingerprint), valid once, for at most 15 minutes, signed with a key only root and Hearth's
  account can read. A replayed, altered, expired, or forged request does nothing.
- **Your scope.** It acts only inside the folders, operations, and units in its scope file
  (`/etc/hearth/elevation.json`, owned by root). systemd also makes everything outside those folders
  read-only to it, so the scope is enforced by the kernel too. Only you change the scope, on the
  machine itself.
- **Never its own files, never raw privilege.** It refuses its own program, scope, key, state, and
  log, Hearth's own services, and files that would hand out raw privileged access (sudo, accounts,
  logins, SSH keys), whatever the scope says.
- **Safe with the target.** It does nothing when the target is no longer exactly as approved. It
  never follows a symbolic link, never accepts a path with `..`, and never changes a file with other
  hard links.
- **Backed up and verified.** Before a change it backs the file up in the host's backup ledger
  (`<service>/<time>-hearth-elevated-<reason>/`, owned by root, readable by Hearth). After it, it
  reads the result back (content fingerprint, owner, mode, access list) and puts the original back
  if that does not match. A successful exit code is never taken as success on its own.
- **Its own record.** Every request, done or refused, is appended to
  `/var/log/hearth/elevated.jsonl`, each record chained to the one before by its fingerprint (and
  append-only where the filesystem allows), so a removed or edited record shows.

The AI never sees the key, the socket, or a request, and never gets a shell or credentials.
Ember plans steps; Hearth's backend computes the exact change; you approve it; the executor
carries it out.

## What it does not protect against

Hearth's account is usually in the `docker` group, which can already reach anything on the
machine through Docker. The executor does not change that. What it adds is that no privilege
reaches the AI, root work goes through a reviewed catalog instead of arbitrary commands,
every change is checked a second time by separate code, and its record and backups are out of
Hearth's reach.

## Setting it up

From Hearth's release or project folder, as root. Look first with `--dry-run`:

```sh
sudo bash deploy/linux/install-elevation.sh --service hearth \
  --root /srv/docker/compose --root /srv/docker/config --dry-run
```

Then without `--dry-run`, then check it:

```sh
sudo bash deploy/linux/install-elevation.sh --service hearth --verify
```

The installer writes the program, the scope file, the key, the state and log folders, a socket
and a service unit, and a small drop-in that tells Hearth where the executor is. It restarts
Hearth once. It changes nothing in your homelab.

## Changing the scope

Ember tells you when a task needs a folder or unit outside the scope, and exactly what would
allow it. Widening or narrowing it is your step:

```sh
sudo bash deploy/linux/install-elevation.sh --service hearth --add-root /etc/caddy
sudo bash deploy/linux/install-elevation.sh --service hearth --add-unit nginx.service
sudo bash deploy/linux/install-elevation.sh --service hearth --remove-root /etc/caddy
```

`--status` shows the scope and checks the log; Settings > Ember > Administration shows the same.

### Drive health (smart.read)

`smart.read` is the one operation that only reads. It returns smartctl's report for one whole
drive (`/dev/sda`, `/dev/nvme0n1`), with a fixed command (`smartctl --json=c -a`), and asks a USB
enclosure once more through SAT passthrough when the first answer says the bridge is unknown. It
needs no per-request authorization, because it changes nothing: switching it on is your approval.
Every read is still recorded in the log. It is off until you add it:

```sh
sudo bash deploy/linux/install-elevation.sh --service hearth --add-operation smart.read --dry-run
```

With it on, the executor's unit (and only while it is on) may open whole drives read-only
(`DeviceAllow=... r`, every other device closed) and holds the two capabilities SMART commands
need (`CAP_SYS_RAWIO` for ATA passthrough, `CAP_SYS_ADMIN` for NVMe logs). Hearth's own account
gets nothing: it is not added to the `disk` group and never opens a drive itself.

### RAID / Arrays (raid.*, zfs.*, btrfs.*, snapraid.run, storage.read)

The RAID / Arrays tab's changes on Linux: software RAID (mdadm), ZFS, Btrfs, and SnapRAID, and
the few storage reads that need root. Off until you switch them on together:

```sh
sudo bash deploy/linux/install-elevation.sh --service hearth --add-operation raid --dry-run
```

Each takes only array, pool, mount point, and drive names (`/dev/md0`, `tank`, `/srv/vault`,
`/dev/sdb`) and runs fixed commands (mdadm, zpool, btrfs, snapraid). Before writing to a drive,
the executor reads the machine itself: it refuses the drive holding the system, a mounted drive,
one in another array or an imported ZFS pool, LVM, or encryption, a drive whose serial is not
the approved one, and a drive holding data unless erasing it was approved with its serial.
Failing or taking offline a member is refused when nothing is left to spare. Afterwards it reads
the state back. Existing ZFS members are named to zpool by GUID, and new drives by their
/dev/disk/by-id name, so a renamed device can never point a command at the wrong drive.

Long work runs outside the request, in its own systemd unit, through systemd-run: a SnapRAID job
(`hearth-snapraid`: the same program in job mode, reporting its progress beside the log where
Hearth reads it), removing a Btrfs drive (`hearth-btrfs`), and creating a ZFS pool (so its mount
is the machine's, not only the sandbox's). One SnapRAID job at a time; snapraid.conf only in its
usual places. storage.read reads SnapRAID's status and differences and Btrfs's error counters
and last scrub, nothing else.

With these on, the executor's unit may write to drives, the kernel's md files, ZFS's pool cache,
and Btrfs's scrub records (`DevicePolicy=auto`, `ProtectKernelTunables=no`, `CAP_SYS_ADMIN`,
netlink for udev); Hearth's own account still never opens a drive. Loop devices are refused
unless the scope file says `"raidAllowLoop": true` (throwaway test arrays only). CI runs every
one of these on loop devices: mdadm, ZFS, Btrfs, and SnapRAID.

### Installing Docker and Tailscale (docker.install, tailscale.install)

For a beginner's homelab plan (Build my plan, docs/design/BUILDER.md). Each takes no settings:
it installs from the vendor's own package repository (download.docker.com, pkgs.tailscale.com,
never a piped install script) on Ubuntu, Debian, Fedora and the systems built on them, and acts
only for the scope file's `serviceUser` (Hearth's account, written by root at setup). Docker:
the Engine and Compose, started at boot, the account added to the docker group and allowed on
Docker's socket now (an ACL, renewed each time Docker starts) so Hearth needs no sign-out.
Tailscale: installed, started, and the account made its operator, so Hearth can fetch the
sign-in link for the owner. Package managers write all over the system, so each runs through
`systemd-run` outside the executor's sandbox, like the RAID jobs, and the executor reports
success only on the script's closing line. Both are protected plan steps: approving asks the
owner to confirm it's them (Docker access is close to administrator access).

Hearth's Linux installer (get.sh) offers to set the executor up with only these two switched
on. On its own, for a get.sh installation (a user service), no folders needed:

```sh
sudo bash ~/hearth/app/deploy/linux/install-elevation.sh --service hearth --user-service   --operations docker.install,tailscale.install
```

Already set up: `--add-operation build` switches both on. When the account's own Node.js is the
one get.sh brought, the executor gets a root-owned copy of it.

### Windows (spaces.*)

On Windows the executor is the same program and protocol, run by a startup task as SYSTEM and
listening on the named pipe `\\.\pipe\hearth-elevated` (there is no systemd to start one per
request). Set it up once, in PowerShell as administrator:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install-elevation.ps1 -Operations storage -DryRun
```

It copies Node.js and the program to `C:\Program Files\Hearth\elevated` and keeps its scope,
key, state, log, and backups in `C:\ProgramData\Hearth\elevation`, with inheritance switched
off: SYSTEM and Administrators may change them, Hearth's own account may read the key, the log,
and the backups, nobody else may read the key. Before every request it checks those permissions
by SID (so it holds in any Windows language) and refuses everything if anyone else could change
its files. It offers only the Storage Spaces operations (spaces.member, spaces.repair,
spaces.grow, spaces.create). Every value is checked against a strict pattern before it reaches
PowerShell, and the script checks the drive in Windows itself: never the drive holding Windows,
never a drive with a lettered volume, never a drive whose serial is not the approved one, never
erasing unless approved with its serial. Hearth finds the executor on its own (its key file).
`-Verify` checks it; `-Uninstall` removes it (the log stays). SnapRAID on Windows runs as the
owner's own account, so it needs no executor. CI installs it on a throwaway Windows machine and
runs Storage Spaces end to end on virtual drives.

## Removing it

```sh
sudo bash deploy/linux/install-elevation.sh --service hearth --uninstall
```

The program, units, scope, key, and drop-in are removed; the log, its state, and its backups are
kept. Protected changes then go back to being possible only for files Hearth's own account may
write.

## Adding an operation

An operation is one entry in the catalog in `apps/server/src/elevated/executor.ts` (its checks,
how it is verified, and what undoing it does), its name in `protocol.ts`, and tests. The
authorization, scope, log, transport, and installer stay as they are. A new operation is off
until the owner lists it in the scope.
