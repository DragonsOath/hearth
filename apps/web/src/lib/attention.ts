import type { DashboardBriefing, Workspace } from "@dragon-control/core";
import { attentionIncidents } from "./format";

/**
 * What needs the owner, counted the same everywhere (Home's headline, the top bar, the
 * sidebar): incidents (live, so a new one counts at once), Hearth's other findings that need
 * attention, and plans waiting for approval that no finding already shows.
 */
/**
 * Where "N things need you" goes: Home's list of them. Incidents alone are on the Incidents
 * page, but findings and plans waiting for approval are not, so it opened to a page without them.
 */
export const NEEDS_YOU_HREF = "/#needs-you";

export function attentionItems(ws: Workspace, briefing: DashboardBriefing | undefined) {
  const incidents = attentionIncidents(ws);
  const all = [...(briefing?.attention ?? []), ...(briefing?.worthKnowing ?? [])];
  const byIncident = new Map(all.filter((f) => f.incidentId).map((f) => [f.incidentId!, f]));
  const findings = (briefing?.attention ?? []).filter((f) => !f.incidentId);
  const linkedJobs = new Set(all.map((f) => f.jobId).filter(Boolean));
  const jobs = ws.pendingJobs.filter((j) => !linkedJobs.has(j.id));
  return {
    incidents,
    byIncident,
    findings,
    jobs,
    count: incidents.length + findings.length + jobs.length,
  };
}
