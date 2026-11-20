import { PROBLEM_LABEL, type DownloadHealthItem } from "@dragon-control/core";
import { getSetting } from "../../store/settings";
import type { FindingDraft } from "../store";
import { MIN, plural, type Analyzer } from "./types";

/**
 * Download Health's problems in "Needs you" (and so the bell and the usual notifications): a
 * download its client reports stuck or failed (stalled, never started, a failed Usenet download)
 * once it reached the strike limit. One finding per download client, listing its downloads.
 *
 * Problems only the grabbing app sees (a failed import in Sonarr's queue) are left out: the
 * app's own findings already show them. It reads Download Health's last check; it changes nothing.
 */
const STALE_MS = 30 * MIN;

export function downloadsAnalyzer(): Analyzer {
  return {
    id: "downloads.health",
    source: "app",
    label: "Download Health",
    intervalMs: 5 * MIN,
    async run({ handle, now }) {
      const saved = await getSetting(handle.db, "download_health");
      const overview = saved?.overview;
      const covered = (key: string) => key.startsWith("downloads:");
      if (!overview?.checkedAt)
        return {
          status: "unavailable",
          note: "Download Health has not checked yet.",
          drafts: [],
          covered: () => false,
        };
      // Simulated downloads (demo and tests) never raise findings.
      if (saved?.sample) return { status: "ok", drafts: [], covered };
      if (now.getTime() - Date.parse(overview.checkedAt) > STALE_MS)
        return {
          status: "partial",
          note: "Download Health's last check is out of date.",
          drafts: [],
          covered: () => false,
        };
      const byClient = new Map<string, DownloadHealthItem[]>();
      for (const i of overview.items) {
        if (i.state !== "attention" || i.clientServiceId === i.appServiceId) continue;
        byClient.set(i.clientServiceId, [...(byClient.get(i.clientServiceId) ?? []), i]);
      }
      const drafts: FindingDraft[] = [];
      for (const [clientServiceId, items] of byClient) {
        const client = items[0]!.client;
        const one = items.length === 1 ? items[0] : undefined;
        const names = items.map((i) => i.title);
        const shown =
          names.slice(0, 3).join("; ") + (names.length > 3 ? `; and ${names.length - 3} more` : "");
        drafts.push({
          key: `downloads:${clientServiceId}`,
          kind: "problem",
          nature: "failure",
          severity: "medium",
          serviceId: clientServiceId,
          title: one
            ? `${client}: ${one.title} is ${PROBLEM_LABEL[one.problem].toLowerCase()}`
            : `${client}: ${plural(items.length, "download")} stuck or failed`,
          summary: one ? one.explain : `${shown}.`,
          why: "These will not arrive on their own. Usually another copy (another release) is the fix.",
          nextSteps: [
            `Ask Ember to grab another copy${one?.app ? ` in ${one.app}` : ""}: it plans it, you approve.`,
            "Open Download Health to see each one and why.",
          ],
          evidence: items.slice(0, 5).map((i) => ({
            label: `${PROBLEM_LABEL[i.problem]}${i.app ? ` (${i.app})` : ""}`,
            value: `${i.title}: ${i.detail ?? i.explain}`,
            at: i.since,
          })),
          resources: items.slice(0, 10).map((i) => ({ kind: "item" as const, name: i.title })),
          signature: items
            .map((i) => i.key)
            .sort()
            .join("|"),
        });
      }
      // What Automatic Recovery did in the last day: said once, so the owner knows.
      const fixed = ((await getSetting(handle.db, "download_health_log")) ?? []).filter(
        (r) => r.event === "fixed" && now.getTime() - Date.parse(r.at) < 24 * 60 * MIN,
      );
      if (fixed.length)
        drafts.push({
          key: "downloads:recovered",
          kind: "observation",
          severity: "info",
          title: `Automatic Recovery: ${plural(fixed.length, "stuck download")} handled`,
          summary: fixed
            .slice(0, 3)
            .map((r) => `${r.title}: ${r.text}`)
            .join(" "),
          why: "Automatic Recovery is on in Download Health, so Hearth fixes stuck downloads and tells you after.",
          nextSteps: [
            "Open Download Health to see each one, or turn Automatic Recovery off there.",
          ],
          evidence: fixed.slice(0, 5).map((r) => ({ label: r.title, value: r.text, at: r.at })),
          resources: fixed.slice(0, 10).map((r) => ({ kind: "item" as const, name: r.title })),
          signature: fixed
            .map((r) => `${r.key}@${r.at}`)
            .sort()
            .join("|"),
        });
      return { status: "ok", drafts, covered };
    },
  };
}
