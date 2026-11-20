import { DEFAULT_NEAR_MISS_SETTINGS } from "@dragon-control/core";
import { getSetting } from "../../store/settings";
import type { FindingDraft } from "../store";
import { MIN, plural, type Analyzer } from "./types";

/**
 * The Crucible's near misses in "Needs you" (and so the bell), only when the owner turned on
 * "Tell me in the bell" there: movies missing a while whose every release was turned down by the
 * owner's own rules. One finding per Radarr. It reads the daily check's results; it changes nothing.
 */
export function nearMissAnalyzer(): Analyzer {
  return {
    id: "crucible.near-misses",
    source: "app",
    label: "The Crucible: near misses",
    intervalMs: 30 * MIN,
    async run({ handle }) {
      const covered = (key: string) => key.startsWith("near-misses:");
      const settings = {
        ...DEFAULT_NEAR_MISS_SETTINGS,
        ...((await getSetting(handle.db, "crucible_near_miss_settings")) ?? {}),
      };
      if (!settings.notify) return { status: "ok", drafts: [], covered };
      const saved = await getSetting(handle.db, "crucible_near_misses");
      const blocked = (saved?.items ?? []).filter((i) => i.kind === "blocked");
      const byService = new Map<string, typeof blocked>();
      for (const i of blocked)
        byService.set(i.serviceId, [...(byService.get(i.serviceId) ?? []), i]);
      const drafts: FindingDraft[] = [];
      for (const [serviceId, items] of byService) {
        const one = items.length === 1 ? items[0] : undefined;
        drafts.push({
          key: `near-misses:${serviceId}`,
          kind: "observation",
          severity: "low",
          serviceId,
          title: one
            ? `${one.service}: ${one.title} is held back by your own rules`
            : `${items[0]!.service}: ${plural(items.length, "movie")} held back by your own rules`,
          summary: one
            ? one.sentence
            : `${items
                .slice(0, 3)
                .map((i) => i.title)
                .join("; ")}${items.length > 3 ? `; and ${items.length - 3} more` : ""}.`,
          why: "Releases exist, but your size limits or other rules turned every one down, so these look unavailable when they aren't.",
          nextSteps: [
            "Open the Crucible: Grab it anyway (one time, rules unchanged), or loosen that row's limit.",
          ],
          evidence: items
            .slice(0, 5)
            .map((i) => ({ label: i.title, value: i.sentence, at: i.checkedAt })),
          resources: items.slice(0, 10).map((i) => ({ kind: "item" as const, name: i.title })),
          signature: items
            .map((i) => `${i.movieId}:${i.closest?.guid ?? ""}`)
            .sort()
            .join("|"),
        });
      }
      return { status: "ok", drafts, covered };
    },
  };
}
