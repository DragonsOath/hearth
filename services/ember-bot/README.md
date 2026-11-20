# Ember Bot

The community bot for the public Hearth Discord server, in the voice of Messenger Ember. It is
separate from the official Hearth bot (`services/hearth-bot`), which lives in owners' own servers.

- **Slash commands:** `/install`, `/help`, `/request-panel`, `/about`.
- **around-the-fire:** every five minutes, each new post gets a 🔥 reaction and one reply that fits
  its tag (Hidden Gem, Wall Screen, My Setup and so on). Whether Ember already answered is read from
  the post, so she never answers twice.
- **Releases:** when a release is published, `.github/workflows/discord-release.yml` posts the full
  notes to #announcements and Ember's heads-up in #general. Start release notes with a short
  `## Highlights` list: Ember names the top three.

Her replies are written ahead of time (`src/ember.ts`, `src/announce.ts`), never by AI, so the bot
costs nothing to run beyond Cloudflare's free tier.

## Setup (owner, once)

GitHub, in this repository's **Settings, Secrets and variables, Actions**:

| Name | Kind | What |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Secret | Cloudflare, My Profile, API Tokens, Create Token, template "Edit Cloudflare Workers" |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Cloudflare dashboard, Workers & Pages, Account ID (right side) |
| `DISCORD_BOT_TOKEN` | Secret | Discord Developer Portal, Ember, Bot, Reset Token |
| `DISCORD_ANNOUNCE_WEBHOOK` | Secret | The "Hearth" webhook in #announcements |
| `DISCORD_GENERAL_WEBHOOK` | Secret | The "Ember" webhook in #general |
| `DISCORD_ANNOUNCE_CHANNEL_ID` | Variable | `1569123495122698431` (#announcements, so Ember can link it) |

Then run **Actions, ember-bot, Run workflow**. When it finishes, put the Worker's address (shown at
the end of the run, like `https://ember-bot.<name>.workers.dev`) in the Discord Developer Portal:
Ember, General Information, **Interactions Endpoint URL**, and save. Discord checks it straight away.

Paste secrets only into those fields: never into a chat, a file or a screenshot.
