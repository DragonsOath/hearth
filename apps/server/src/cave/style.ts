import type { Memory } from "../memory/service";

/**
 * How the owner likes Ember to talk ("shorter answers", "skip the
 * jokes when something's down"). Kept apart from operational facts: these
 * are "How you work" memories carrying this link, they only shape how
 * answers are written, and they are never cited as facts about the homelab.
 * Ember can only suggest one (a pending draft); the owner accepts it.
 */
export const STYLE_LINK = { label: "How to talk with you", ref: "cave:conversation-style" };

export async function conversationStyle(memory: Memory, limit = 12): Promise<string[]> {
  const entries = await memory.list({ kind: "preference", limit: 200 });
  return entries
    .filter((e) => !e.superseded && e.links.some((l) => l.ref === STYLE_LINK.ref))
    .slice(0, limit)
    .map((e) => (e.body.trim() ? `${e.title}: ${e.body.trim()}` : e.title).slice(0, 300));
}
