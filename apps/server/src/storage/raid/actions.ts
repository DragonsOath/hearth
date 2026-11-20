import type { RaidAction, RaidActionId, RaidArray, RaidCandidate } from "@dragon-control/core";

/**
 * What can be done to an mdadm array right now, decided from its real state: each action is
 * available, blocked (with what would make it possible), unsupported by mdadm or this level
 * (with why), or already running. The plan step checks all of it again before anything runs,
 * and the elevated executor checks the drives a third time itself.
 */

const REDUNDANT = new Set(["raid1", "raid4", "raid5", "raid6", "raid10"]);
const GROWABLE = new Set(["raid1", "raid4", "raid5", "raid6", "raid10"]);

export interface ActionContext {
  candidates: RaidCandidate[];
  /** Whether approved changes can run on this machine (the executor with RAID switched on). */
  changesReady: boolean;
  changesWhy?: string;
}

const LABELS: Record<RaidActionId, string> = {
  "add-disk": "Add a disk to rebuild",
  "add-spare": "Add a hot spare",
  "remove-spare": "Remove a spare",
  replace: "Replace a disk",
  "mark-failed": "Mark a member failed",
  remove: "Remove a failed member",
  "re-add": "Re-add a returning member",
  check: "Run a consistency check",
  repair: "Repair mismatches",
  "pause-check": "Pause the check",
  "resume-check": "Resume the check",
  "cancel-check": "Cancel the check",
  speed: "Rebuild and check speed",
  "grow-devices": "Add a member (more capacity or another mirror)",
  "grow-size": "Use the larger drives' full size",
  "grow-filesystem": "Grow the filesystem to the array's size",
  "change-level": "Change the RAID level",
  "save-config": "Save the array to mdadm.conf",
  "schedule-check": "Schedule regular checks",
  identify: "Identify the physical drives",
  "clear-errors": "Clear error counts",
  rebalance: "Rebalance",
  sync: "Sync parity",
  fix: "Rebuild a lost drive",
  diff: "What changed since the last sync",
};

export function mdActions(a: RaidArray, ctx: ActionContext): RaidAction[] {
  const level = a.level ?? "";
  const redundant = REDUNDANT.has(level);
  const busy = a.sync && !a.sync.paused ? a.sync.action : undefined;
  const usable = (min?: number) =>
    ctx.candidates.filter(
      (c) => c.state !== "excluded" && (min === undefined || (c.sizeBytes ?? 0) >= min),
    );
  const bigEnough = usable(a.memberSizeBytes);
  const offline = a.health === "inactive" || a.health === "failed";
  const out: RaidAction[] = [];
  const add = (
    id: RaidActionId,
    status: RaidAction["status"],
    reason?: string,
    extra: Partial<RaidAction> = {},
  ) => out.push({ id, label: LABELS[id], status, ...(reason ? { reason } : {}), ...extra });
  const noLevel = (what: string) =>
    `${level === "raid0" ? "RAID 0" : level || "This level"} keeps no redundant copy, so ${what}.`;
  const noDisk = a.memberSizeBytes
    ? `No free drive of at least ${gb(a.memberSizeBytes)} is connected. Connect one (it must not be the system drive or mounted), then read again.`
    : "No free drive is connected.";

  // Rebuilding a degraded array.
  if (!redundant) add("add-disk", "unsupported", noLevel("there is nothing to rebuild from"));
  else if (a.counts.missing === 0 && a.counts.failed === 0)
    add(
      "add-disk",
      "blocked",
      "Every member is in place. To use another drive, add it as a spare or grow the array.",
    );
  else if (busy === "recover") add("add-disk", "running", "A member is being rebuilt now.");
  else if (offline) add("add-disk", "blocked", "The array is not running, so it cannot rebuild.");
  else if (!bigEnough.length) add("add-disk", "blocked", noDisk);
  else
    add("add-disk", "available", undefined, {
      risk: "The rebuild reads every other member in full. A second drive failing during it can lose the array (and on RAID 5 there is no protection left until it finishes).",
    });

  // Spares.
  if (!redundant) add("add-spare", "unsupported", noLevel("a spare would have nothing to rebuild"));
  else if (offline) add("add-spare", "blocked", "The array is not running.");
  else if (!bigEnough.length) add("add-spare", "blocked", noDisk);
  else
    add("add-spare", "available", undefined, {
      risk: a.counts.missing
        ? "The array is missing a member, so a new spare is used at once and rebuilding starts."
        : "The drive waits unused and takes over automatically when a member fails.",
    });
  if (a.counts.spare)
    add(
      "remove-spare",
      busy ? "blocked" : "available",
      busy ? `Wait until the ${busy} finishes.` : undefined,
    );

  // Replacing a member.
  const failing = a.members.filter(
    (m) => m.role === "faulty" || m.states.includes("want_replacement") || (m.errors ?? 0) > 0,
  );
  if (!redundant)
    add(
      "replace",
      "unsupported",
      noLevel("a drive cannot be swapped without losing the array; copy the data off first"),
    );
  else if (offline) add("replace", "blocked", "The array is not running.");
  else if (busy && busy !== "check") add("replace", "blocked", `Wait until the ${busy} finishes.`);
  else if (!bigEnough.length) add("replace", "blocked", noDisk);
  else
    add(
      "replace",
      "available",
      failing.length ? `Suggested for ${failing.map((m) => m.device).join(", ")}.` : undefined,
      {
        risk: failing.some((m) => m.role === "faulty")
          ? "The failed member is removed and the new drive rebuilt from the others: less protection until it finishes."
          : "Replacing a working member copies it to the new drive while it stays in the array, so protection is kept throughout (mdadm --replace).",
      },
    );

  if (!redundant)
    add("mark-failed", "unsupported", noLevel("failing a member would take the array down"));
  else if (a.canLose === 0)
    add(
      "mark-failed",
      "blocked",
      "No redundancy left: failing another member would lose the array's data.",
    );
  else if (offline) add("mark-failed", "blocked", "The array is not running.");
  else
    add("mark-failed", "available", undefined, {
      risk: "The array loses that member's protection until it is replaced or re-added.",
    });

  if (a.counts.failed || a.counts.spare)
    add("remove", "available", undefined, {
      risk: "The member leaves the array; its drive is not erased.",
    });
  else
    add(
      "remove",
      "blocked",
      "Only failed members and spares can be removed. Mark a working member failed first (if it must go).",
    );

  const returning = ctx.candidates.filter(
    (c) => c.state === "has-data" && c.fstype === "linux_raid_member",
  );
  if (!redundant) add("re-add", "unsupported", noLevel("there is nothing to re-add into"));
  else if (!a.counts.missing && !a.counts.failed) add("re-add", "blocked", "No member is missing.");
  else if (!returning.length)
    add(
      "re-add",
      "blocked",
      'No drive that was an array member is connected. A new drive is added with "Add a disk to rebuild".',
    );
  else
    add(
      "re-add",
      "available",
      a.bitmap && a.bitmap !== "none"
        ? "The array has a write-intent bitmap: only what changed while it was gone is copied."
        : "No write-intent bitmap: mdadm may refuse; then add it as a new disk (full rebuild).",
    );

  // Checks.
  if (!redundant) {
    add("check", "unsupported", noLevel("there is nothing to compare against"));
    add("repair", "unsupported", noLevel("there is nothing to repair from"));
  } else {
    if (busy === "check") add("check", "running", progressText(a));
    else if (busy) add("check", "blocked", `The array is busy (${busy}); check when it finishes.`);
    else if (a.sync?.paused)
      add("check", "blocked", "A check is paused: resume it, or cancel it to start over.");
    else if (a.health !== "healthy")
      add("check", "blocked", "Check a whole, healthy array. Rebuild it first.");
    else
      add("check", "available", undefined, {
        risk: "Reads every block of every member: slower disk access while it runs (hours on large drives). Changes nothing.",
      });
    if (busy === "repair") add("repair", "running", progressText(a));
    else if (busy) add("repair", "blocked", `The array is busy (${busy}).`);
    else if (a.health !== "healthy")
      add("repair", "blocked", "Repair only a whole, healthy array.");
    else if (!a.mismatches)
      add(
        "repair",
        "blocked",
        "The last check found no mismatches, so there is nothing to repair. Run a check first.",
      );
    else
      add("repair", "available", undefined, {
        risk:
          level === "raid1" || level === "raid10"
            ? "Mismatched blocks are overwritten from the first in-sync copy; which copy was right cannot be known. Back up anything important first."
            : "Mismatched parity is rewritten from the data blocks. If a data block was the bad one, the bad data stays. Back up first.",
      });
  }
  if (busy === "check" || busy === "repair") {
    add("pause-check", "available", "Stops where it is; resume continues from there.");
    add("cancel-check", "available", "Stops it; the next check starts from the beginning.");
  } else if (busy) {
    add(
      "cancel-check",
      "unsupported",
      `A ${busy === "recover" ? "rebuild" : busy} cannot be stopped safely: it restores the array's protection.`,
    );
  }
  if (a.sync?.paused)
    add("resume-check", "available", `Continues from ${a.sync.progressPct ?? 0}%.`);

  add("speed", "available", "Lower it to keep the drives responsive; raise it to finish sooner.");

  // Growing.
  if (!GROWABLE.has(level))
    add(
      "grow-devices",
      "unsupported",
      level === "raid0"
        ? "Hearth does not grow RAID 0 (mdadm converts it through RAID 4, which needs care by hand)."
        : `mdadm cannot grow ${level || "this array"} by adding members.`,
    );
  else if (a.health !== "healthy")
    add("grow-devices", "blocked", "Grow only a whole, healthy array.");
  else if (busy) add("grow-devices", "blocked", `Wait until the ${busy} finishes.`);
  else if (!bigEnough.length && !a.counts.spare) add("grow-devices", "blocked", noDisk);
  else
    add(
      "grow-devices",
      "available",
      a.counts.spare ? "A spare is already in the array; growing can use it." : undefined,
      {
        irreversible: level !== "raid1",
        risk:
          level === "raid1"
            ? "Adds another full copy (more protection, not more space)."
            : "The array is reshaped across the new member: it runs for many hours, the array stays usable but slower, and going back to fewer members is a separate risky reshape. Have a backup first.",
      },
    );
  const smallest = Math.min(...a.members.filter((m) => m.sizeBytes).map((m) => m.sizeBytes!));
  if (!REDUNDANT.has(level) && level !== "raid0")
    add("grow-size", "unsupported", "Not for this level.");
  else if (!a.memberSizeBytes || !Number.isFinite(smallest))
    add("grow-size", "blocked", "The member sizes are not known.");
  else if (smallest < a.memberSizeBytes + 1024 ** 3)
    add(
      "grow-size",
      "blocked",
      "Every member must be on a larger drive first (replace them one at a time); then the array can use the extra space.",
    );
  else if (a.health !== "healthy" || busy)
    add("grow-size", "blocked", "Grow only a whole, idle array.");
  else
    add(
      "grow-size",
      "available",
      `Each member can give ${gb(smallest)} instead of ${gb(a.memberSizeBytes)}.`,
      {
        risk: "A resync of the new space follows. Grow the filesystem afterwards to use it.",
      },
    );
  if (!a.fstype) add("grow-filesystem", "blocked", "No filesystem was found on the array.");
  else if (!["ext4", "ext3", "xfs"].includes(a.fstype))
    add(
      "grow-filesystem",
      "unsupported",
      `Hearth grows ext4 and XFS filesystems; this one is ${a.fstype}.`,
    );
  else if (a.fstype === "xfs" && !a.mount)
    add("grow-filesystem", "blocked", "XFS grows only while mounted. Mount it first.");
  else
    add("grow-filesystem", "available", "Only useful after the array itself was grown.", {
      risk: "Growing is safe online for ext4 and XFS. Shrinking is never offered.",
    });
  add(
    "change-level",
    "unsupported",
    "mdadm can convert some levels (RAID 1 to 5, 5 to 6) with a long reshape. Hearth does not offer it: done wrong it loses the array. Do it by hand with a verified backup, or ask Ember to walk you through it.",
  );

  if (a.inConfig) add("save-config", "blocked", "Already listed in mdadm.conf.");
  else
    add(
      "save-config",
      "available",
      "Not in mdadm.conf: it may come back with another name (md127) after a restart.",
      {
        risk: "Adds one ARRAY line to mdadm.conf (backed up first). The boot image is not rebuilt; arrays that hold the system need that too.",
      },
    );
  if (!redundant) add("schedule-check", "unsupported", noLevel("there is nothing to check"));
  else add("schedule-check", "available");
  add(
    "identify",
    "available",
    "Each member's model and serial number are shown; match the serial on the drive's label.",
  );

  // Nothing changes unless the machine can carry out approved RAID steps.
  if (!ctx.changesReady)
    for (const x of out)
      if (x.status === "available" && !["identify"].includes(x.id)) {
        x.status = "blocked";
        x.reason = `${ctx.changesWhy ?? "Approved RAID changes are not set up on this machine."}${x.reason ? ` (${x.reason})` : ""}`;
      }
  return out;
}

function progressText(a: RaidArray) {
  const s = a.sync;
  if (!s) return undefined;
  return [
    s.progressPct !== undefined ? `${s.progressPct}%` : undefined,
    s.etaMinutes !== undefined ? `about ${eta(s.etaMinutes)} left` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
}

export const eta = (m: number) =>
  m < 90 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;

export const gb = (b: number) =>
  b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : `${Math.round(b / 1e9)} GB`;
