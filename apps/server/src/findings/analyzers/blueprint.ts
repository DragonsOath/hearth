import type { BlueprintStatus } from "@dragon-control/core";
import type { FindingDraft } from "../store";
import { MIN, type Analyzer } from "./types";

/**
 * The Lab Blueprint in "Needs you": its last daily check failed, or it hasn't been brought up to
 * date for two days. Quiet when it isn't set up. It reads the blueprint's status; it changes nothing.
 */
export function blueprintAnalyzer(status: () => Promise<BlueprintStatus>): Analyzer {
  return {
    id: "backups.blueprint",
    source: "backup",
    label: "Lab Blueprint",
    intervalMs: 10 * MIN,
    async run() {
      const covered = (key: string) => key.startsWith("blueprint:");
      const s = await status().catch(() => undefined);
      if (!s)
        return {
          status: "unavailable",
          note: "Hearth couldn't read the Lab Blueprint.",
          drafts: [],
          covered: () => false,
        };
      const drafts: FindingDraft[] = [];
      if (s.config && (s.lastError || s.stale)) {
        const newest = s.versions[0];
        drafts.push({
          key: "blueprint:health",
          kind: "observation",
          nature: s.lastError ? "failure" : "state",
          severity: "medium",
          title: s.lastError
            ? "The Lab Blueprint couldn't be updated"
            : "The Lab Blueprint is more than two days old",
          summary:
            s.lastError?.text ??
            "Hearth hasn't been able to check the lab against its blueprint for two days.",
          why: "The blueprint is how you (or Ember) rebuild this lab if the machine is lost. An old one can miss apps and settings.",
          nextSteps: [
            "Open Settings > Backups > Lab Blueprint and press Update now.",
            "If the folder is a drive or share that isn't connected, connect it or choose another folder.",
          ],
          evidence: [
            { label: "Folder", value: s.config.destination },
            ...(newest ? [{ label: "Newest version", value: newest.file, at: newest.at }] : []),
            ...(s.lastError
              ? [{ label: "Last error", value: s.lastError.text, at: s.lastError.at }]
              : []),
          ],
          resources: [],
          signature: `${s.lastError?.at ?? ""}|${s.stale}`,
        });
      }
      return { status: "ok", drafts, covered };
    },
  };
}
