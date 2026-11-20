import type { FindingDraft } from "../store";
import { DAY, HOUR, type Analyzer } from "./types";

/** How long before the donation service's GitHub token expires that the owner is told. */
export const TOKEN_WARN_DAYS = 14;

/**
 * The panel donation service's GitHub token, on the owner's issuing Hearth only (the owner
 * deploys and runs that service): in "Needs you" 14 days before it expires, or once it has, with
 * the steps to replace it. Donations still arrive and are kept while it is expired; only their
 * pull requests wait. It reads the service's status; it changes nothing.
 */
export function donationTokenAnalyzer(
  status: () => Promise<{ tokenExpiresAt?: string; tokenWorks?: boolean } | undefined>,
): Analyzer {
  return {
    id: "premium.donation-token",
    source: "app",
    label: "Panel donation service",
    intervalMs: 12 * HOUR,
    async run({ now }) {
      const covered = (key: string) => key === "donations:token";
      const s = await status().catch(() => undefined);
      if (s === undefined) return { status: "off", drafts: [], covered: () => false };
      const drafts: FindingDraft[] = [];
      const at = s.tokenExpiresAt ? Date.parse(s.tokenExpiresAt) : NaN;
      const left = Math.ceil((at - now.getTime()) / DAY);
      if (!Number.isNaN(at) && left <= TOKEN_WARN_DAYS) {
        const gone = left <= 0;
        drafts.push({
          key: "donations:token",
          kind: "observation",
          nature: gone ? "failure" : "risk",
          severity: gone ? "high" : "medium",
          title: gone
            ? "The panel donation service's GitHub token has expired"
            : `The panel donation service's GitHub token expires in ${left} day${left === 1 ? "" : "s"}`,
          summary: gone
            ? "Donated panels are still received and kept, but no pull requests are opened until the token is replaced."
            : "When it expires, donated panels are still received and kept, but their pull requests wait until it is replaced.",
          why: "Donations reach you for review as pull requests on the Premium repository, made with this token.",
          nextSteps: [
            "On GitHub, signed in as the dragonsoath-dev account: Settings > Developer settings > Fine-grained tokens > Generate new token.",
            "Resource owner DragonsOath, repository hearth-premium only; permissions Contents and Pull requests, read and write; nothing else. Pick an expiry.",
            "In a terminal, in the donation service's folder (services/panel-intake): npx wrangler secret put GITHUB_TOKEN, and paste the new token there only.",
            "Delete the old token on GitHub. Hearth picks up the new expiry date within a day.",
          ],
          evidence: [{ label: "Token expires", value: new Date(at).toISOString().slice(0, 10) }],
          resources: [],
          signature: gone ? "expired" : "soon",
        });
      }
      return { status: "ok", drafts, covered };
    },
  };
}
