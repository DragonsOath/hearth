/**
 * Posts a published release to the Hearth Discord server. Run by
 * .github/workflows/discord-release.yml with Node 24 (which runs TypeScript directly). The webhook
 * addresses come from GitHub secrets and are never printed.
 */
import { announcement, emberHeadsUp } from "./announce.ts";

// Node's process, typed here so this service needs no extra type package.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } })
  .process.env;
const version = (env.RELEASE_TAG ?? "").replace(/^v/, "");
const title = env.RELEASE_NAME ?? "";
const notes = env.RELEASE_BODY ?? "";

async function post(hook: string | undefined, content: string, label: string): Promise<void> {
  if (!hook) {
    console.log(`${label}: no webhook set, skipped.`);
    return;
  }
  const r = await fetch(`${hook}?wait=true`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (!r.ok) throw new Error(`${label}: Discord answered ${r.status}.`);
  console.log(`${label}: posted.`);
}

if (!version) throw new Error("No release tag.");
await post(env.DISCORD_ANNOUNCE_WEBHOOK, announcement(version, title, notes), "#announcements");
await post(
  env.DISCORD_GENERAL_WEBHOOK,
  emberHeadsUp(version, notes, env.DISCORD_ANNOUNCE_CHANNEL_ID || undefined),
  "Ember in #general",
);
