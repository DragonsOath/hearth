# Hearth bot relay

The official Hearth bot's relay (docs/design/HEARTH_BOT.md), a Cloudflare Worker.

## Deploy (owner, once)

1. `npx wrangler login` (opens Cloudflare in the browser).
2. `npx wrangler d1 create hearth-bot`, put the database id in `wrangler.toml`, then
   `npx wrangler d1 execute hearth-bot --remote --file schema.sql`.
3. Secrets, each pasted when asked (never in files):
   `npx wrangler secret put BOT_TOKEN` (Discord: Hearth app, Bot, Reset Token),
   `npx wrangler secret put CLIENT_SECRET` (OAuth2, Reset Secret),
   `npx wrangler secret put STATE_KEY` (any long random text).
4. `npx wrangler deploy`, then set `BASE_URL` in `wrangler.toml` to the address it prints and deploy
   again.
5. In Discord (Hearth app): General Information, Interactions Endpoint URL = `BASE_URL/interactions`;
   OAuth2, Redirects, add `BASE_URL/v1/linked`.
6. Set Hearth's built-in relay address (`DEFAULT_RELAY` in apps/server/src/notify/hearth-bot.ts) and
   release.
