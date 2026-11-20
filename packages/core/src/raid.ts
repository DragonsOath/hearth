/**
 * RAID and pools, as the Storage panel's RAID / Arrays tab and Ember see them. Every fact comes
 * from the machine (the kernel's md files, lsblk); every action says whether it can run now,
 * what blocks it, or why the technology does not support it.
 */

export type RaidTech =
  | "mdadm"
  | "zfs"
  | "btrfs"
  | "snapraid"
  | "lvm"
  | "unraid"
  | "hardware"
  | "storage-spaces"
  | "drivepool";

/** In plain words, for the tab and Ember. */
export const RAID_TECH_NAME: Record<RaidTech, string> = {
  mdadm: "Linux software RAID (mdadm)",
  zfs: "ZFS",
  btrfs: "Btrfs",
  snapraid: "SnapRAID",
  lvm: "LVM",
  unraid: "Unraid",
  hardware: "Hardware RAID",
  "storage-spaces": "Storage Spaces",
  drivepool: "StableBit DrivePool",
};

export type RaidHealth =
  | "healthy"
  | "degraded"
  | "rebuilding"
  | "resyncing"
  | "checking"
  | "reshaping"
  | "failed"
  | "inactive"
  | "unknown";

export type RaidMemberRole =
  | "active"
  | "spare"
  | "faulty"
  | "rebuilding"
  | "replacing"
  | "write-mostly"
  | "missing"
  /** Taken offline on purpose (ZFS): brought back with re-add. */
  | "offline"
  /** Retired (Storage Spaces): its data is being moved off before it is removed. */
  | "retired"
  /** SnapRAID: a drive holding files, or one holding parity. */
  | "data"
  | "parity"
  /** ZFS support devices: a read cache or an intent log. */
  | "cache"
  | "log";

export interface RaidDisk {
  /** The whole drive (/dev/sdb) a member lives on. */
  disk?: string;
  model?: string;
  serial?: string;
  sizeBytes?: number;
  transport?: string;
  rotational?: boolean;
}

export interface RaidMember extends RaidDisk {
  /** The member device (/dev/sdb1 or /dev/sdb); absent for a missing slot. */
  device?: string;
  /** Its slot in the array (0-based), when it holds one. */
  slot?: number;
  role: RaidMemberRole;
  /** The kernel's own state words for it ("in_sync", "faulty", "spare", "want_replacement"). */
  states: string[];
  /** Read errors the kernel corrected on this member. */
  errors?: number;
  /** Errors by kind (ZFS read/write/checksum; Btrfs's device statistics). */
  errorCounts?: Record<string, number>;
  /** The group it belongs to (a ZFS vdev like "raidz1-0", "spares"; SnapRAID's Data or Parity). */
  group?: string;
  /** Its own name in its technology's configuration (SnapRAID's "d1"). */
  name?: string;
  /** Where it is used from (a SnapRAID data or parity path, a drive letter). */
  path?: string;
  /** Free and used space on it, when it is its own filesystem (SnapRAID). */
  usedBytes?: number;
  freeBytes?: number;
  /** How the technology says it (ZFS "UNAVAIL", Storage Spaces "Lost Communication"). */
  stateText?: string;
}

export interface RaidSync {
  /** What the array is doing: resync, recover (rebuild), check, repair, reshape. */
  action:
    | "resync"
    | "recover"
    | "check"
    | "repair"
    | "reshape"
    | "scrub"
    | "resilver"
    | "balance"
    | "sync"
    | "optimize";
  progressPct?: number;
  /** KiB per second, as the kernel reports. */
  speedKiBs?: number;
  /** Estimated minutes left, from the remaining blocks and speed. */
  etaMinutes?: number;
  /** A check stopped part way, which resume continues from. */
  paused?: boolean;
}

/** One thing that can be done to an array, and whether it can be done now. */
export interface RaidAction {
  id: RaidActionId;
  label: string;
  /**
   * available: can be proposed now. blocked: the array or disks are not ready (reason says what
   * would make it possible). unsupported: this technology or level cannot do it (reason says
   * why). running: it is happening now.
   */
  status: "available" | "blocked" | "unsupported" | "running";
  reason?: string;
  /** Can never be undone (creating, adding a disk with data on it). */
  irreversible?: boolean;
  /** Plain words: what could go wrong. */
  risk?: string;
}

export type RaidActionId =
  | "add-disk"
  | "add-spare"
  | "remove-spare"
  | "replace"
  | "mark-failed"
  | "remove"
  | "re-add"
  | "check"
  | "repair"
  | "pause-check"
  | "resume-check"
  | "cancel-check"
  | "speed"
  | "grow-devices"
  | "grow-size"
  | "grow-filesystem"
  | "change-level"
  | "save-config"
  | "schedule-check"
  | "identify"
  /** Reset a member's error counters once the cause is dealt with (ZFS, Btrfs). */
  | "clear-errors"
  /** Spread data evenly over the members (Btrfs balance, Storage Spaces optimize). */
  | "rebalance"
  /** SnapRAID: bring parity up to date with the files now on the data drives. */
  | "sync"
  /** SnapRAID: rebuild a lost drive's files from parity onto its replacement. */
  | "fix"
  /** SnapRAID: what changed since the last sync (read only). */
  | "diff";

export interface RaidArray {
  /** Stable within a machine: "mdadm:md0". */
  id: string;
  tech: RaidTech;
  /** md0, or the name mdadm gave it ("homelab:media"). */
  name: string;
  device?: string;
  uuid?: string;
  level?: string;
  /** The level in plain words ("RAID-Z2", "Two-way mirror", "2 parity drives"). */
  levelText?: string;
  layout?: string;
  chunkKiB?: number;
  metadata?: string;
  health: RaidHealth;
  /** In plain words, what the health means for the data. */
  healthText: string;
  /** Usable size of the array (what a filesystem on it gets). */
  sizeBytes?: number;
  /** Size each member contributes. */
  memberSizeBytes?: number;
  /** Total raw size of the member drives. */
  rawBytes?: number;
  /** Space used on its filesystem, when mounted. */
  usedBytes?: number;
  raidDevices?: number;
  counts: { active: number; failed: number; missing: number; spare: number };
  /** How many more members can fail before data is lost (from level and current state). */
  canLose?: number;
  members: RaidMember[];
  mount?: string;
  fstype?: string;
  sync?: RaidSync;
  /** sync_speed_min / max in KiB/s (the array's own, or the system default when "system"). */
  speedLimit?: {
    minKiBs: number;
    maxKiBs: number;
    minFrom: "array" | "system";
    maxFrom: "array" | "system";
  };
  /** Blocks found different by the last check (0 is clean). */
  mismatches?: number;
  bitmap?: string;
  /** Listed in mdadm.conf, so it is assembled with the same name after a restart. */
  inConfig?: boolean;
  /** Groups inside it (ZFS vdevs), with their own level and health. */
  groups?: { name: string; level?: string; health: RaidHealth; stateText?: string }[];
  /** The last full check (scrub or sync), in words, with when and what it found. */
  lastCheck?: { at?: string; text: string; errors?: number };
  /** Files or blocks the technology reports as damaged (ZFS "errors:", SnapRAID errors). */
  dataErrors?: { count: number; text: string };
  /** Managed in its own app (Unraid, DrivePool): where, in words, and a link when known. */
  managedElsewhere?: { text: string; url?: string };
  /** What the technology itself says (ZFS status and action lines), word for word. */
  notes?: string[];
  /** The managing tool's version ("2.2.2" for OpenZFS), when it decides what is possible. */
  toolVersion?: string;
  warnings: string[];
  actions: RaidAction[];
}

/** A drive or partition that could join an array, or why it cannot. */
export interface RaidCandidate extends RaidDisk {
  device: string;
  kind: "disk" | "part";
  /** usable: empty and free. has-data: free, but holds a filesystem or signature that would be erased. */
  state: "usable" | "has-data" | "excluded";
  /** Why it is excluded, or what is on it. */
  reason?: string;
  fstype?: string;
}

/** How each technology is handled on this machine. */
export interface RaidTechSupport {
  tech: RaidTech;
  /** What was seen, as evidence ("No arrays in /proc/mdstat"). */
  seen: string;
  /** manage: read and changed through approved plans. read: shown only. detect: presence only. none: not applicable here. */
  support: "manage" | "read" | "detect" | "none";
  /** How it was verified: on real arrays (live), on throwaway loop devices (loopback), on captured output (fixtures), or not at all. */
  verified: "live" | "loopback" | "fixtures" | "none";
  /** Tools it needs and whether they are here. */
  tools?: { name: string; present: boolean }[];
}

/** A recurring consistency check (Hearth's own, or one the operating system already runs). */
export interface RaidSchedule {
  arrayId?: string;
  /** hearth: approved in Hearth. system: the distribution's own timer or cron job. */
  by: "hearth" | "system";
  every?: "weekly" | "monthly";
  /** In words: "First Sunday of the month at 01:06 (Debian checkarray)". */
  text: string;
  next?: string;
  last?: string;
}

export interface RaidReport {
  host: string;
  at: string;
  arrays: RaidArray[];
  candidates: RaidCandidate[];
  tech: RaidTechSupport[];
  schedules: RaidSchedule[];
  /** The elevated executor and its RAID operations: what is needed before changes can run. */
  changes: {
    ready: boolean;
    /** Plain words: what is missing ("The elevated executor is not set up"). */
    why?: string;
    operations: string[];
    /** Each technology on its own (ZFS may be ready while mdadm's operations are off). */
    byTech?: Partial<Record<RaidTech, { ready: boolean; why?: string }>>;
  };
  /** What can be created here, by technology (only those whose tools are present). */
  create?: RaidCreateOption[];
  /** "linux" or "windows": the words and tools differ. */
  platform?: "linux" | "windows";
  /** Backups that cover data on arrays, as far as Hearth knows. */
  backups: { known: boolean; text: string };
  /** Sample data (demo or tests). */
  sample?: boolean;
}

/** Parameters of a storage-raid plan step (flat values, like every plan step's). */
export interface RaidStepParams {
  action: RaidActionId | "create";
  arrayId?: string;
  /** The member or candidate device. */
  device?: string;
  /** The device's serial when planned: the step does nothing if a different drive is there. */
  serial?: string;
  /** For replace: the member being replaced. */
  replaces?: string;
  /** Erase what is on the device (it held data); the serial must match. */
  erase?: boolean;
  minKiBs?: number | "system";
  maxKiBs?: number | "system";
  every?: "weekly" | "monthly" | "off";
  /** Create: the level, the devices and their serials (comma separated, same order), the name. */
  level?: string;
  devices?: string;
  serials?: string;
  /** Create: devices (comma separated) whose data the owner approved erasing. */
  eraseDevices?: string;
  name?: string;
  /** Create: also make an empty ext4 filesystem on the new array (not mounted). */
  mkfs?: "ext4" | "none";
  /** Create: which technology (mdadm when absent). */
  tech?: RaidTech;
  /** Create on Windows: the new volume's filesystem. */
  fs?: "ntfs" | "refs";
  /** SnapRAID sync: stop when more than this many files were deleted (a missing drive looks like that). */
  deleteThreshold?: number;
  /** SnapRAID fix: the data drive's name in snapraid.conf (d1). */
  disk?: string;
}

/** One way to create an array here, and its layouts. */
export interface RaidCreateOption {
  tech: RaidTech;
  label: string;
  levels: { id: string; label: string; min: number; words: string; tolerance: number }[];
  /** Filesystem choices for the new volume, when it makes one. */
  filesystems?: { id: string; label: string }[];
  /** What else creation does, in words ("mounted at /mnt/<name>"). */
  note?: string;
}

/** Fault tolerance by level: members that may fail without losing data. */
export function raidTolerance(level: string | undefined, devices: number): number | undefined {
  switch (level) {
    case "mirror":
      return Math.max(0, devices - 1);
    case "raidz1":
    case "btrfs-raid1":
    case "btrfs-raid5":
    case "btrfs-raid10":
    case "spaces-mirror":
    case "spaces-parity":
      return 1;
    case "raidz2":
    case "btrfs-raid1c3":
    case "btrfs-raid6":
    case "spaces-mirror3":
    case "spaces-parity2":
      return 2;
    case "raidz3":
    case "btrfs-raid1c4":
      return 3;
    case "stripe":
    case "btrfs-single":
    case "spaces-simple":
      return 0;
    case "raid1":
      return Math.max(0, devices - 1);
    case "raid4":
    case "raid5":
      return 1;
    case "raid6":
      return 2;
    case "raid10":
      return 1; // At least one; more if the failures land in different mirror pairs.
    case "raid0":
    case "linear":
      return 0;
    default:
      return undefined;
  }
}

/** Usable capacity for a level from member sizes (the smallest member counts for all). */
export function raidUsableBytes(level: string, sizes: number[]): number | undefined {
  if (!sizes.length) return undefined;
  const n = sizes.length;
  const min = Math.min(...sizes);
  const total = sizes.reduce((a, b) => a + b, 0);
  const largest = Math.max(...sizes);
  switch (level) {
    case "mirror":
      return min;
    case "raidz1":
      return n >= 2 ? min * (n - 1) : undefined;
    case "raidz2":
      return n >= 3 ? min * (n - 2) : undefined;
    case "raidz3":
      return n >= 4 ? min * (n - 3) : undefined;
    case "stripe":
    case "btrfs-single":
    case "spaces-simple":
      return total;
    case "btrfs-raid1":
    case "btrfs-raid10":
      // Two copies on different drives, whatever their sizes.
      return Math.floor(Math.min(total / 2, total - largest));
    case "btrfs-raid1c3":
      return Math.floor(Math.min(total / 3, (total - largest) / 2));
    case "btrfs-raid1c4":
      return Math.floor(Math.min(total / 4, (total - largest) / 3));
    case "btrfs-raid5":
      return n >= 2 ? total - largest : undefined;
    case "btrfs-raid6":
      return n >= 3 ? total - 2 * largest : undefined;
    case "spaces-mirror":
      return Math.floor(total / 2);
    case "spaces-mirror3":
      return Math.floor(total / 3);
    case "spaces-parity":
      return n >= 3 ? Math.floor((total * (n - 1)) / n) : undefined;
    case "spaces-parity2":
      return n >= 7 ? Math.floor((total * (n - 2)) / n) : undefined;
    case "raid0":
      return min * n;
    case "linear":
      return sizes.reduce((a, b) => a + b, 0);
    case "raid1":
      return min;
    case "raid4":
    case "raid5":
      return n >= 2 ? min * (n - 1) : undefined;
    case "raid6":
      return n >= 4 ? min * (n - 2) : undefined;
    case "raid10":
      return n >= 2 ? Math.floor((min * n) / 2) : undefined;
    default:
      return undefined;
  }
}

/** The fewest members each level can be created with. */
export const RAID_MIN_DEVICES: Record<string, number> = {
  raid0: 2,
  raid1: 2,
  raid5: 3,
  raid6: 4,
  raid10: 4,
  mirror: 2,
  raidz1: 3,
  raidz2: 4,
  raidz3: 5,
  "btrfs-raid1": 2,
  "btrfs-raid1c3": 3,
  "btrfs-raid10": 4,
  "spaces-mirror": 2,
  "spaces-mirror3": 5,
  "spaces-parity": 3,
  "spaces-parity2": 7,
};
