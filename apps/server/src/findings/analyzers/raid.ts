import type { RaidReport } from "@dragon-control/core";
import type { FindingDraft } from "../store";
import { MIN, type Analyzer } from "./types";

/**
 * RAID arrays (Storage > RAID / Arrays): a degraded, failed, or stopped array, a member marked
 * failed or asking to be replaced, and mismatches a check found. Read from the kernel through
 * the RAID reader; it changes nothing. Findings go through Hearth's usual notifications.
 */
const KIND: Record<string, string> = {
  mdadm: "RAID array",
  zfs: "ZFS pool",
  btrfs: "Btrfs filesystem",
  snapraid: "SnapRAID array",
  "storage-spaces": "Storage pool",
};

export function raidAnalyzer(report: () => Promise<RaidReport>): Analyzer {
  return {
    id: "storage.raid",
    source: "storage",
    label: "RAID arrays",
    intervalMs: 5 * MIN,
    async run({ now }) {
      let r: RaidReport;
      try {
        r = await report();
      } catch (error) {
        return {
          status: "unavailable",
          note: `Arrays could not be read: ${error instanceof Error ? error.message : String(error)}`,
          drafts: [],
          covered: () => false,
        };
      }
      // Simulated arrays (demo and tests) never raise findings.
      if (r.sample) return { status: "ok", drafts: [], covered: (key) => key.startsWith("raid:") };
      const at = now.toISOString();
      const drafts: FindingDraft[] = [];
      const next = [
        "Open Storage > RAID / Arrays to see each member and what can be done.",
        "Ask Ember why, and to plan the fix.",
      ];
      for (const a of r.arrays) {
        // In the technology's own words: a RAID array, a ZFS pool, a Btrfs filesystem...
        const kind = KIND[a.tech] ?? "RAID array";
        const where = `${a.name} (${a.device ?? a.id}) on ${r.host}`;
        const resources = [{ kind: "volume" as const, name: where, id: a.id }];
        const evidence = [
          {
            label: "State",
            value: `${a.health}: ${a.counts.active} active, ${a.counts.failed} failed, ${a.counts.missing} missing, ${a.counts.spare} spare`,
            at,
          },
          ...(a.sync
            ? [{ label: "Running", value: `${a.sync.action} ${a.sync.progressPct ?? "?"}%`, at }]
            : []),
        ];
        if (a.health === "failed" || a.health === "inactive")
          drafts.push({
            key: `raid:down:${a.id}`,
            kind: "problem",
            nature: "failure",
            severity: "critical",
            title: `${kind} ${a.name} is ${a.health === "failed" ? "failed" : "not running"}`,
            summary: a.healthText,
            why: "Its data cannot be read safely until it is assembled with enough members. Writing to it now can make recovery harder.",
            nextSteps: ["Do not write to it or reformat anything.", ...next],
            evidence,
            resources,
            signature: a.health,
          });
        else if (a.health === "degraded" || (a.health === "rebuilding" && a.counts.missing))
          drafts.push({
            key: `raid:degraded:${a.id}`,
            kind: "problem",
            nature: "degraded",
            severity: a.canLose === 0 ? "critical" : "high",
            title: `${kind} ${a.name} is ${a.health === "rebuilding" ? "rebuilding" : "degraded"}`,
            summary: `${a.healthText} ${a.warnings[0] ?? ""}`.trim(),
            why:
              a.canLose === 0
                ? "One more drive failure would lose the array's data. Replace the failed drive, and make sure a backup exists."
                : "It has less protection until it is rebuilt.",
            nextSteps:
              a.health === "rebuilding"
                ? ["Let the rebuild finish; avoid heavy use meanwhile.", ...next]
                : next,
            evidence,
            resources,
            signature: `${a.health}:${a.counts.failed}:${a.counts.missing}`,
          });
        const failing = a.members.filter(
          (m) => m.states.includes("want_replacement") || (m.errors ?? 0) > 0,
        );
        if (failing.length && a.health !== "failed")
          drafts.push({
            key: `raid:member:${a.id}`,
            kind: "suspected",
            nature: "risk",
            severity: "medium",
            title: `A drive in ${a.name} is showing errors`,
            summary: failing
              .map(
                (m) =>
                  `${m.device}${m.serial ? ` (serial ${m.serial})` : ""}: ${
                    m.errorCounts
                      ? Object.entries(m.errorCounts)
                          .filter(([, n]) => n)
                          .map(([k, n]) => `${n} ${k} errors`)
                          .join(", ")
                      : m.errors
                        ? `${m.errors} read errors corrected`
                        : "asks to be replaced"
                  }`,
              )
              .join("; "),
            why: "Drives that start correcting errors often fail soon. Replacing one while the array is whole keeps its protection throughout.",
            nextSteps: ["Check its SMART report in the Drives tab.", ...next],
            evidence,
            resources,
            signature: failing.map((m) => m.serial ?? m.device).join(","),
          });
        // Files the technology could not repair (ZFS's permanent errors, SnapRAID's errors).
        if (a.dataErrors && a.dataErrors.count > 0)
          drafts.push({
            key: `raid:data:${a.id}`,
            kind: "problem",
            nature: "risk",
            severity: "high",
            title: `${kind} ${a.name} reports damaged data`,
            summary: a.dataErrors.text,
            why: "Some blocks could not be read correctly. Repair what can be repaired from the other copies or parity; anything else needs a backup.",
            nextSteps: [
              a.tech === "snapraid"
                ? "Fix the errors found from parity (RAID / Arrays)."
                : "List the damaged files (Ember can) and restore them from a backup.",
              ...next,
            ],
            evidence,
            resources,
            signature: String(a.dataErrors.count),
          });
        if (a.mismatches && a.mismatches > 0 && !a.sync)
          drafts.push({
            key: `raid:mismatch:${a.id}`,
            kind: "observation",
            nature: "risk",
            severity: a.level === "raid1" || a.level === "raid10" ? "low" : "medium",
            title: `The last check of ${a.name} found ${a.mismatches.toLocaleString("en-US")} mismatched blocks`,
            summary: "The members did not agree everywhere.",
            why:
              a.level === "raid1" || a.level === "raid10"
                ? "Some mismatches on mirrors are harmless (swap, interrupted writes). Many, or growing, deserve a look before any repair."
                : "On parity RAID, mismatches mean the parity or data disagree somewhere. Find out why before repairing.",
            nextSteps: [
              "Ask Ember to look at the drives' SMART reports and the system log.",
              ...next,
            ],
            evidence,
            resources,
            signature: String(a.mismatches),
          });
      }
      return {
        status: r.arrays.length || r.tech.some((t) => t.support === "manage") ? "ok" : "partial",
        drafts,
        covered: (key) => key.startsWith("raid:"),
      };
    },
  };
}
