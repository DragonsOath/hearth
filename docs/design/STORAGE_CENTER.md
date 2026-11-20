# Storage & Files

Added 2026-10-20. The owner's full specification (HEARTH_STORAGE_RAID_MANAGEMENT_SPEC) is kept in the private docs and tracked as section 35 of the feature checklist. He asked for it as a Lair panel like the others, with all of the specification's information. This note covers what was built, the gap to the full specification, what the machines can actually support, the security model, and the approvals still needed.

Status words follow the specification:
- **built:** the code exists.
- **automated-tested:** unit and e2e tests pass.
- **deployed:** running on the home server.
- **live-verified:** checked against real data.
- **owner-verified:** the owner confirmed it.

## The panel

`tool:storage` is a new kind of Lair panel. It opens from:
- the Lair's top strip (an on/off switch, like the systems);
- the sidebar (a top-level Storage item);
- the Home storage tile.

Its tab is kept in the address. Browsing is read only; file changes are plans you confirm.

| View | What it shows | Source |
| --- | --- | --- |
| Overview | Laid out from the owner's mockup: summary (drives by verdict, capacity used and free without double counting, overall status, temperature range), a row per drive (verdict, temperature, space), recent activity with All, Downloads, Imported, Waiting, Issues, a compact explorer, current operations, and a machine selector. | All below |
| Drives | Model, type, connection, size, the drive's own verdict, temperature, power-on hours, SSD rated life used (the SSD's own figure), errors, volumes. No health percentage for hard drives. Behind a disclosure, the drive's own SMART report: verdict with its reasons (reallocated, pending, offline uncorrectable sectors, CRC errors; NVMe media errors and rated life), last self-test, power cycles. A USB enclosure that hides SMART, or a sleeping drive, is said plainly. | Hearth's disk reader (unprivileged); SMART through the elevated executor's read-only smart.read |
| Files | A file manager over this machine's drives from their mount points: back, forward, up, breadcrumbs, sortable columns, filter, bounded search below a folder, folder sizes, a details drawer with text (redacted) and image preview, audited download, copy path. New folder, rename, move, and copy are plans you confirm (see File changes). Secrets and Hearth's own keys are never listed; settings files are listed but never opened. | /api/files (read); file-manage plan steps |
| Recently Added | Every file Hearth saw arrive, with its full path (drive name first), size, the folder it landed in (a library or download folder, from the apps' own mounts), and the window it arrived in: between the previous check and the one that found it, so a gap after downtime shows as a wider window, never a false "just now". Files already there when a drive was first indexed are opt-in and labelled "Before Hearth was watching" with their file date. A finished partial download says so; a move names where it came from; a hardlink (the seeding copy and the imported copy are one file) names its twin and uses no extra space. Moves and deletions kept, Open in folder. | file_index (seen_after, moved_from, file_key, links), refreshed every ten minutes |
| File journeys | One card per download: grabbed, downloaded, imported, in the library, in Plex. Each step is confirmed (an app said so), inferred (Hearth matched two reports), or unknown, with the app's timestamps, the exact source and destination (the app's own path and the host path), and where it stopped. Grouped as Needs a look, Waiting, Done, Downloads only. A failed or stuck import shows the app's reason, Import it in Radarr (an approved plan) and Ask Ember with the evidence. | Radarr/Sonarr history and queue (grouped by download id), qBittorrent (by hash), SABnzbd, Plex recently added file paths |
| RAID / Arrays | Every array or pool read now (Linux software RAID, ZFS, Btrfs, SnapRAID, Storage Spaces), with its health in plain words, level, capacity (usable, raw, used), members (model, serial, size, role, corrected errors), a running check or rebuild with progress and time left, warnings, and every action with its status: available, needs something first (and what), not supported (and why), or running. Guided changes, each a plan you confirm in place (see RAID management). Drives that could join an array, schedules, how each technology is handled, backup coverage, recovery info to download, Ask Ember. Linked PCs' arrays are read through the hub. The disks, partitions, and mounts are kept under a disclosure. | One driver per technology (mdadm, ZFS, Btrfs, SnapRAID, Storage Spaces), read without root; changes through the elevated executor's raid.*, zfs.*, btrfs.*, snapraid.run, and (Windows) spaces.* operations |
| Health & history | Open storage incidents and findings; space over time per volume, plotted by date (a missing day is a gap) under the drive's size, with a growth rate and a plain forecast ("full in about 3 months at this rate") in amber within 90 days and red within 30 or above 90% used; what is available versus not built, behind a disclosure. | Findings, incidents, volume_usage_daily |

## RAID management (added 2026-10-24, every technology 2026-10-25)

The RAID / Arrays tab manages the storage most homelabs use, on Linux and Windows. Baseline: what most homelabbers run (ZFS on TrueNAS and Proxmox; SnapRAID for media libraries on both systems; Storage Spaces built into Windows), plus Linux software RAID and Btrfs. Code: `apps/server/src/storage/raid/` (one driver per technology in `driver.ts`, `zfs.ts`, `btrfs.ts`, `snapraid.ts`, `spaces.ts`, `drivepool.ts`; mdadm in `read.ts`, `actions.ts`, `service.ts`; simulators `sample*.ts`) and `apps/server/src/elevated/` (the executor's operations: `raid.ts`, `zfs.ts`, `btrfs.ts`, `snapraid.ts`, `spaces.ts`).

| Technology | Platform | Read from (no privilege) | Managed |
| --- | --- | --- | --- |
| Linux software RAID (mdadm) | Linux | /proc/mdstat, /sys/block/mdN/md, lsblk | Replace, rebuild, spares, mark failed, remove, re-add, check, repair, pause, resume, cancel, speed, grow (members, size, filesystem), save to mdadm.conf, schedule, create |
| ZFS | Linux | `zpool status -P -L -p`, `zpool list`, `zfs get` | Replace (failed or working), spares, offline and online, detach a mirror member, widen a mirror (and RAID-Z on OpenZFS 2.3+), expand, clear errors, scrub, pause, resume, stop, schedule, create a pool (mounted at /mnt/name) |
| Btrfs (several drives) | Linux | /sys/fs/btrfs; error counters and scrub through storage.read | Add, replace, remove a drive, scrub, pause, resume, balance, convert the profile in place (RAID 1 to 1C3 and back), reset counters, use full size, schedule, create |
| SnapRAID | Linux and Windows | snapraid.conf, `snapraid status`, `snapraid diff` | Sync with a safety stop (no sync after more than 50 deletions: a missing drive looks like that), scrub, fix the errors found, rebuild a lost drive from parity, stop a job, nightly sync and scrub, what changed |
| Storage Spaces | Windows | Get-StoragePool, Get-VirtualDisk, Get-PhysicalDisk, Get-StorageJob | Replace, add a drive or a spare, retire and put back, remove, repair, optimize, extend, create a pool with a formatted volume |
| Unraid, StableBit DrivePool, LVM RAID, hardware RAID | | Detected | Not managed: each has its own app or vendor tool |

- **Every drive shows model and serial**, grouped the technology's way (ZFS vdevs, SnapRAID data and parity), so the right physical drive is pulled. On Windows drives are named as Disk Management names them (Disk 2).
- **Each action is decided from the real state** (available, needs something first, not supported with why, running) per technology.
- **Every change is a `storage-raid` plan step** you confirm, naming the host, array, and drives (model, serial, size) and what it erases or cannot undo. Hearth plans it from the state now, checks again when it runs (the same drive by serial), and the executor checks the drive a third time itself. Drives in any array or pool, the system drive, mounted drives, and (on Windows) lettered volumes are never offered.
- **Schedules:** checks and scrubs weekly or monthly; SnapRAID's sync and small scrub nightly or weekly. Each run is its own recorded plan under the approval. The system's own schedules (Debian checkarray, zfsutils scrubs, SnapRAID cron jobs) are shown too.
- **Long jobs** (a SnapRAID sync, a Btrfs removal) run in the background and report progress to the tab.
- **Alerts** (`findings/analyzers/raid.ts`) for every technology: degraded, failed, drives with errors, damaged data, mismatches.
- **Ember:** `storage_raid` reads the same report; Ember proposes `storage-raid` steps that wait for your approval.
- **Setting it up:** Linux: `sudo bash deploy/linux/install-elevation.sh --service hearth --add-operation raid`. Windows: `deploy\windows\install-elevation.ps1 -Operations storage` in PowerShell as administrator (SnapRAID on Windows needs nothing: it runs as the owner's account). Until then the tab reads and says what is missing.
- **Tested:** unit tests per technology and for each executor's checks; the tab end to end on simulated Linux and Windows machines (desktop and phone); in CI on throwaway drives, for real: mdadm, ZFS (OpenZFS 2.4), Btrfs, and SnapRAID on loop devices, and Storage Spaces on virtual drives through the installed Windows executor. Not yet run on a machine with real arrays: none of the owner's machines has one.

## Drive names

Drives can be named (Film, TV, Alternative Media on the home server). A name is stored by the filesystem's UUID when the system reports one (lsblk), otherwise by mount point, so a remount keeps the name and a replacement drive at the same mount does not inherit it. Names are display only: mount points and filesystems are never touched. They appear in every view and in storage alerts, with the real path beside them. Set from the Drives view or `tools-cli storage-name <mount> "<name>"`.

## File changes

New folder, rename, move, and copy, from the file manager. Each is a `file-manage` plan step
(serviceId `this-host`) you confirm in place, carried out by Hearth's own account, never elevated,
and checked afterwards by reading the result back.

- **Never deletes, never replaces.** The destination must not exist. A move to another drive
  would be a copy and a delete, so it is refused and a copy offered instead. A copy or a new
  folder is not undone by deleting it; a rename or move is put back if a later step fails.
- **Stale approvals do nothing.** The item's size and time are recorded when planned; if it
  changed before the step runs, nothing is done.
- **Apps keep their folders.** Inside folders Radarr, Sonarr, Lidarr, Readarr, or a download
  client manage (from their containers' mounts), renaming, moving, and copying in are refused
  with the reason: those apps track files by path, so it is done in the app. Copying out is
  allowed. Folders only Plex or Jellyfin read are allowed, with a note that they pick the change up
  on their next scan.
- **Secrets and settings** are never changed; paths cannot leave the drive or watched folder.
- **Permissions decide.** Where Hearth's account cannot write, the plan says so before you approve, and nothing changes. On the home server today the media drives belong to homeuser, so Hearth cannot write there until you decide otherwise.
- Delete is not offered. Ember cannot propose file changes yet (it has no file listing tools).

## Drive health (SMART)

Read through the elevated executor's `smart.read` (docs/ELEVATED_EXECUTOR.md), which is off until
The owner switches it on (`install-elevation.sh --add-operation smart.read`). Hearth's own account
never opens a drive and is not added to the `disk` group. Reports are cached half an hour; "Read
drives again" reads them afresh. A sleeping drive is not woken (`-n standby,0`). A USB bridge that
smartctl does not recognise is asked once more through SAT passthrough; if it still hides SMART,
the panel says the enclosure does not pass it through, not that the drive is bad.

## Rules it keeps (from the specification)

- **Evidence before conclusions.** Every fact says where it came from. Inferred matches are labelled as inferred. Missing data says "Not shared", never zero.
- **Seeding is not failed.** A finished download no queue tracks is shown as downloaded, with the uncertainty stated. It is never called failed.
- **Disks are spared.** The index walks every ten minutes within a time and entry budget, never follows symlinks, skips recycle bins and code folders, and on the app drive reads only library, download and watched folders. A pass that stops early never marks a file as gone.
- **Accurate capacity.** Volumes add up because they are separate mounts. Drive sizes are never added on top.
- **Redundancy is not backup**, said where arrays are shown.
- **Unsupported is explicit.** The capability list marks each area as available, partly, needs your OK, not applicable here, or not built yet.

## Feasibility on the real machines (read only, 10-20)

- **The home server (Linux):**
  - **Drives:** three USB hard drives (NTFS) and two NVMe drives (ext4: root and /mnt/storage).
  - **Arrays:** none; /proc/mdstat is empty, and there is no ZFS, Btrfs or Unraid.
  - **Tools:** smartctl 7.4 is installed. hdparm is present. inotifywait is not.
  - **Temperatures:** NVMe temperatures come from hwmon without root. drivetemp is not loaded, and the USB drives share nothing without SMART.
  - **SMART access:** Hearth's account cannot open /dev/sd* (root:disk). SMART on the USB drives also needs SAT passthrough.
  - **inotify:** 224,477 watches available.
- **Desktop-PC (Windows):** two NVMe drives and one USB drive. Reliability counters return nothing without administrator rights. No smartctl, no pools.
- **Gaming-PC (Windows):** two NVMe drives, one SATA SSD and one SATA hard drive, plus one Storage Spaces pool, which Hearth cannot read yet. No smartctl. Hearth does not collect from this machine today; it shows as a host only.

## Gap to the full specification

- **SMART (spec 5).** Built (v0.26.0): the executor's read-only `smart.read` and the Drives disclosure. Not yet: a stored SMART history and thresholds over time, self-test scheduling, and Windows (needs an elevated collector). The executor is not installed on the home server; that and switching smart.read on are the owner's steps.
- **Live file tracking (spec 7).**
  - **Needs building:** a watcher with periodic reconciliation, first-observed times, history after moves, retention, and redaction.
  - **Suggested scope:** the downloads and import folders only, never whole libraries.
  - **Approval:** needs the owner's choice of watched roots.
- **File journeys, later stages (spec 8):** done in v0.25.0 for Radarr, Sonarr and Plex (history, path mapping from the apps' own mounts, Plex by exact path). Still open: Jellyfin, history older than the last 100 events, and starting from a title or a missing library item.
- **Explorer additions (spec 6):** preview, folder-size index, cross-host search, write operations. Writes need a separate review of app-aware safety (Radarr and Sonarr ownership) and rollback.
- **Array readers (spec 10):** ZFS, Btrfs, Unraid and hardware RAID, built only where testable. Windows Storage Spaces (Gaming-PC) should come first.
- **Other spec sections:**
  - Guided recovery (spec 11).
  - Duplicates and largest-files views (spec 12).
  - Drive-level alerts (spec 13).
  - Ember tools for each view (spec 14).
  - Collectors on the other machines.

## Proposed order

1. **Done 10-20:** the read-only panel and the journey sources (outputPath, content path).
1. **Done 10-21 (v0.25.0):** honest arrival times, end-to-end journeys with Plex, drive names.
1. **Built 10-21 (v0.26.0):** smart.read in the executor, the dated capacity chart, array adapters, confirmed file changes.
2. SMART through the elevated executor's read-only operation, once the owner approves installing the executor on the home server.
3. Watched roots chosen by the owner, then the watcher with reconciliation.
4. Journeys: Plex and Jellyfin recognition, path mapping, history.
5. A Windows collector (Gaming-PC's Storage Spaces pool, and reliability counters elevated).
6. Ember tools per view, then management (approved plans), then guided recovery.

## Approvals still needed (nothing here has been done)

- Installing the elevated executor on the home server, with its read-only SMART operation.
- Which folders to watch on each machine (Hearth's own record; a read-only scan).
- Any collector on Desktop-PC or Gaming-PC, and running it with administrator rights.
- Each file change (new folder, rename, move, copy) is its own plan you confirm; delete is not offered. Any permission change, array or parity operation, or networking change: each separately, never as a class.
