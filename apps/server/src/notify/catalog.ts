import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import * as t from "../db/schema";

/**
 * The channels and routes every installation has. They are settings, not
 * sample data: added when missing, never overwritten, and never cleared
 * when sample data is switched or your systems are re-scanned.
 */

export const CHANNEL_CATALOG = [
  { id: "email", name: "Email" },
  { id: "discord", name: "Discord" },
  { id: "ntfy", name: "ntfy" },
  { id: "telegram", name: "Telegram" },
  { id: "webhook", name: "Webhook" },
  { id: "push", name: "Browser push" },
  { id: "gotify", name: "Gotify" },
  { id: "slack", name: "Slack" },
] as const;

/** Channels that can be set up today; the rest are listed as coming later. */
export const SUPPORTED_CHANNELS = new Set([
  "email",
  "discord",
  "discord-bot",
  "hearth-bot",
  "ntfy",
  "push",
  "telegram",
  "webhook",
]);

export const ROUTE_CATALOG = [
  {
    id: "needs-you",
    event: "Needs your attention",
    description: "Anything Hearth cannot resolve on its own, and when it is resolved.",
  },
  {
    id: "auto-repaired",
    event: "Repaired automatically",
    description: "A short account of what happened and what was done.",
  },
  {
    id: "repair-failed",
    event: "Repair unsuccessful",
    description: "An automatic repair was attempted and did not hold.",
  },
  {
    id: "critical",
    event: "Critical",
    description: "Hosts offline, storage failing, or data at risk. Ignores quiet hours.",
  },
  {
    id: "weekly",
    event: "Weekly summary",
    description: "One quiet note each Sunday morning.",
  },
  {
    id: "check-in",
    event: "A word from Hearth",
    description:
      "When there is something worth telling you: what changed, a real win, work gone quiet, one idea. At most once a day, never in quiet hours. Nothing is sent until you pick a channel.",
  },
  {
    id: "long-work",
    event: "Long work",
    description:
      "Long jobs on your machines (voice training, big copies): when one stalls, fails, runs past its stop time, or finishes. Finished notes wait for quiet hours to end.",
  },
  {
    id: "releases",
    event: "Movie releases",
    description:
      "Movies you requested in Seerr: a release date announced or moved, out today, one that needs a look, and when it is in your library. Choose which on the Releases page. Held during quiet hours.",
  },
  {
    id: "hearth-updates",
    event: "Hearth updates",
    description:
      "A new version of Hearth is out: what's new, and Update now in Hearth (or the command to run).",
  },
  {
    id: "media-arrivals",
    event: "New in your library",
    description:
      "Movies and shows that just became available in Plex or Jellyfin, with artwork and a trailer, and, when you turn them on, new music, audiobooks, ebooks, comics, games and podcasts. Made for a friends and family channel; design them under Media announcements.",
  },
  {
    id: "agent-replies",
    event: "Answers from your AI operator",
    description:
      "Replies that took more than a moment, so your voice assistant can read them out when ready.",
  },
] as const;

export async function ensureNotificationCatalog(db: Database): Promise<void> {
  const channels = new Map((await db.select().from(t.notificationChannels)).map((c) => [c.id, c]));
  for (const [i, c] of CHANNEL_CATALOG.entries()) {
    const existing = channels.get(c.id);
    if (!existing) {
      await db
        .insert(t.notificationChannels)
        .values({ id: c.id, name: c.name, status: "available", detail: null, sort: i });
    } else if (existing.status === "configured" && !existing.config) {
      // Older sample data claimed a channel was set up without any settings; it never was.
      await db
        .update(t.notificationChannels)
        .set({ status: "available", detail: null })
        .where(eq(t.notificationChannels.id, c.id));
    }
  }
  const usable = new Set(
    (await db.select().from(t.notificationChannels))
      .filter((c) => c.status === "configured")
      .map((c) => c.id),
  );
  const routes = new Map((await db.select().from(t.notificationRoutes)).map((r) => [r.id, r]));
  for (const [i, r] of ROUTE_CATALOG.entries()) {
    const existing = routes.get(r.id);
    if (!existing) {
      // A route added in an update starts where "needs your attention" already goes, when it is
      // about something going wrong; otherwise it starts off until you choose.
      const inherit =
        r.id === "long-work" || r.id === "releases" || r.id === "hearth-updates"
          ? (routes.get("needs-you")?.channels ?? []).filter((c) => usable.has(c))
          : [];
      await db.insert(t.notificationRoutes).values({ ...r, channels: inherit, sort: i });
    } else {
      // Keep your choices, but drop channels that are no longer set up, and refresh wording.
      await db
        .update(t.notificationRoutes)
        .set({
          event: r.event,
          description: r.description,
          channels: existing.channels.filter((c) => usable.has(c)),
        })
        .where(eq(t.notificationRoutes.id, r.id));
    }
  }
}
