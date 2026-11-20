import { SEEDING_ACTION_LABEL, spell, type SeedingLogEntry } from "@dragon-control/core";
import type { FindingDraft } from "../store";
import { MIN, plural, type Analyzer } from "./types";

/**
 * Seeding rules in "Needs you" (and so the bell and the usual notifications, 11-11): what live
 * rules did (or are waiting on) that the owner hasn't seen yet. It goes away when the owner opens
 * the rules. It reads what the rules wrote; it changes nothing.
 */
export function seedingAnalyzer(
  unseen: () => Promise<{ serviceId: string; name: string; unseen: SeedingLogEntry[] }[]>,
): Analyzer {
  return {
    id: "downloads.seeding",
    source: "app",
    label: "Seeding rules",
    intervalMs: 5 * MIN,
    async run() {
      const covered = (key: string) => key.startsWith("seeding:");
      const list = await unseen().catch(() => undefined);
      if (!list)
        return {
          status: "unavailable",
          note: "Hearth couldn't read the seeding rules.",
          drafts: [],
          covered: () => false,
        };
      const drafts: FindingDraft[] = list.map(({ serviceId, name, unseen: items }) => {
        const failed = items.filter((e) => e.ok === false);
        const done = items.filter((e) => e.ok !== false);
        const one = items.length === 1 ? items[0] : undefined;
        return {
          key: `seeding:${serviceId}`,
          kind: "observation",
          nature: failed.length ? "failure" : "state",
          severity: failed.length ? "medium" : "low",
          serviceId,
          title: one
            ? `${name}: seeding rule "${one.rule}": ${one.ok === false ? "couldn't act on" : SEEDING_ACTION_LABEL[one.action].toLowerCase()} ${one.name}`
            : `${name}: seeding rules did ${plural(done.length, "thing")}${failed.length ? `, ${failed.length} waiting or failed` : ""}`,
          summary:
            one?.result ??
            items
              .slice(0, 3)
              .map((e) => e.name)
              .join("; "),
          why: "You asked to hear when a seeding rule's time is up, or when one acts.",
          nextSteps: ["Open qBittorrent > Torrents > Seeding rules to see the activity."],
          evidence: items.slice(0, 5).map((e) => ({
            label: `${e.rule}: ${SEEDING_ACTION_LABEL[e.action]}`,
            value: `${e.name}: ${spell(e.seedingSec)} seeded, ratio ${e.ratio.toFixed(2)}. ${e.result ?? ""}`,
            at: e.at,
          })),
          resources: items.slice(0, 10).map((e) => ({ kind: "item" as const, name: e.name })),
          signature: items.map((e) => `${e.hash}|${e.action}|${e.at}`).join(","),
        };
      });
      return { status: "ok", drafts, covered };
    },
  };
}
