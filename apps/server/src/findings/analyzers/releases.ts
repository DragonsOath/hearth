import { isNull } from "drizzle-orm";
import type { MovieAssessment, MovieFacts } from "@dragon-control/core";
import * as t from "../../db/schema";
import type { FindingDraft } from "../store";
import { MIN, type Analyzer } from "./types";

/**
 * Requested movies that need a look (release watch, docs/design/RELEASE_WATCH.md) as findings, so
 * an overdue request shows in the same list as everything else and Ember sees it there. The
 * watch keeps doing the checking and the telling (once per piece of news); a finding resolves
 * when its watch no longer needs a look (grabbed, imported, declined, or dismissed).
 */

const URGENT = new Set(["download-failed", "download-stuck", "request-failed"]);

/** Whole days from a date to the owner's local today (as the release watch counts). */
const daysSince = (date: string, now: Date) => {
  const today = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
  return Math.max(
    0,
    Math.round(
      (new Date(`${today}T00:00:00Z`).getTime() - new Date(`${date}T00:00:00Z`).getTime()) /
        86_400_000,
    ),
  );
};

export function releasesAnalyzer(): Analyzer {
  return {
    id: "releases.watches",
    source: "app",
    label: "Movie requests (release watch)",
    intervalMs: 5 * MIN,
    async run({ handle, now }) {
      const rows = await handle.db.select().from(t.watches).where(isNull(t.watches.dismissedAt));
      // Only for services still in Hearth: a removed Seerr's old watches are not news.
      const services = new Map(
        (await handle.db.select().from(t.services))
          .filter((s) => s.lifecycle === "active")
          .map((s) => [s.id, s]),
      );
      const drafts: FindingDraft[] = [];
      for (const w of rows) {
        if (w.state !== "needs-look") continue;
        const a = w.assessment as MovieAssessment | null;
        const f = w.facts as MovieFacts | null;
        if (!a?.problem) continue;
        if (!f?.request || !services.has(f.request.seerrServiceId)) continue;
        const radarr = f.radarr.found && services.get(f.radarr.serviceId);
        const seerr = services.get(f.request.seerrServiceId)!;
        const out = a.homeDate && a.dateStatus === "out" ? daysSince(a.homeDate, now) : undefined;
        const release =
          a.homeDate && out !== undefined
            ? `Its ${a.homeKind === "physical" ? "disc" : "digital"} release was ${out === 0 ? "today" : `${out} day${out === 1 ? "" : "s"} ago`} (${a.homeDate}).`
            : "";
        drafts.push({
          key: `release:${w.key}`,
          kind: "problem",
          nature: "failure",
          signature: a.problem.code,
          severity: URGENT.has(a.problem.code) ? "high" : "medium",
          title:
            a.problem.code === "nothing-accepted" && out !== undefined
              ? `${w.title}: ${out === 0 ? "out today" : `${out} day${out === 1 ? "" : "s"} past its digital release`}, not grabbed`
              : `${w.title} needs a look`,
          summary: `${release} ${a.problem.text}`.trim(),
          why: "You requested it, and it is not on its way to your library yet. A release date passing does not prove a release is on offer, so Hearth says what Radarr actually reports.",
          nextSteps: [
            "Ask Ember why it has not been grabbed: it reads Radarr's search results, indexers, and download client.",
            "Open the Overseerr panel to see every request at once.",
          ],
          evidence: [
            ...(a.homeDate
              ? [
                  {
                    label: "Release date",
                    value: `${a.homeDate} (${a.dateSource === "radarr" ? "from Radarr" : "TMDB through Seerr"})`,
                  },
                ]
              : []),
            { label: "Radarr", value: a.doing },
            {
              label: "Certainty",
              value: a.problem.confirmed
                ? "Confirmed by Radarr or Seerr"
                : "Suspected: nothing found yet",
            },
          ],
          resources: [
            { kind: "service" as const, id: seerr.id, name: seerr.name },
            ...(radarr ? [{ kind: "service" as const, id: radarr.id, name: radarr.name }] : []),
          ],
          serviceId: radarr ? radarr.id : seerr.id,
        });
      }
      return { status: "ok", drafts, covered: (key) => key.startsWith("release:") };
    },
  };
}
