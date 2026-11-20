/**
 * Release announcements for the public Hearth Discord server. When a release is published, the
 * GitHub Action (.github/workflows/discord-release.yml) runs announce-cli.ts, which posts:
 * 1. the full release notes to #announcements, through the "Hearth" webhook;
 * 2. Ember's short heads-up in #general, through the "Ember" webhook, pointing people to it.
 *
 * Ember's heads-up names the top three items of the notes' "Highlights" list, so each release's
 * notes should start with a short "## Highlights" list.
 */

const OPENERS = [
  "Special delivery! 🔥",
  "Hey everyone! 📬",
  "Fresh from the forge! 🔥",
  "Guess what just landed? ✨",
];

/** The first three bullet points under a "Highlights" heading, plain text. */
export function highlights(notes: string): string[] {
  const lines = notes.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s*highlights\b/i.test(l.trim()));
  if (start < 0) return [];
  const out: string[] = [];
  for (const raw of lines.slice(start + 1)) {
    const l = raw.trim();
    if (/^#{1,6}\s/.test(l)) break;
    const m = /^[-*]\s+(.*)$/.exec(l);
    if (m) out.push(m[1]!.replace(/\*\*|__|`/g, "").replace(/\.$/, ""));
    if (out.length === 3) break;
  }
  return out;
}

/** "a", "a and b", "a, b and c". */
function listOf(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Ember's heads-up in #general. */
export function emberHeadsUp(
  version: string,
  notes: string,
  announceChannelId: string | undefined,
  pick: (n: number) => number = (n) => Math.floor(Math.random() * n),
): string {
  const opener = OPENERS[pick(OPENERS.length) % OPENERS.length]!;
  const where = announceChannelId ? `<#${announceChannelId}>` : "#announcements";
  const top = highlights(notes);
  const what = top.length ? `, with ${listOf(top)}` : "";
  return `${opener} Hearth ${version} just landed${what}. The full letter's waiting in ${where}!`;
}

/** The full announcement, kept inside Discord's 2,000-character limit. */
export function announcement(version: string, title: string, notes: string): string {
  const head = `## 🔥 Hearth ${version}${title && title !== version ? `: ${title}` : ""}\n\n`;
  const room = 2000 - head.length;
  const body = notes.trim();
  return head + (body.length > room ? `${body.slice(0, room - 2).trimEnd()} …` : body);
}
