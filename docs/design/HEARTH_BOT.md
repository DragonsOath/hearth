# The official Hearth bot

Friends answer movie night invitations with **I'm in** and **Can't make it** buttons. Buttons
need a Discord bot, and a bot made by each owner means Discord's developer site and a token,
which is too much for most people. So Hearth also offers one official bot that anyone adds with
one click.

## How it fits together

```
Discord ──interactions (HTTPS, signed)──▶ relay (Cloudflare Worker) ◀──socket (outbound)── each Hearth
        ◀──posts/edits (bot token)────────        ◀──HTTPS (install id + secret)───────────
```

- **Relay** (`services/hearth-bot`): a Cloudflare Worker with D1 (which Hearth owns which server)
  and one Durable Object per Hearth (its open socket, hibernating when idle). It holds the bot
  token and OAuth client secret as Worker secrets.
- **A Hearth registers once** (`POST /v1/register`): an install id and a secret, kept in the
  Hearth's vault (`hearth_bot` setting). Every call carries `Authorization: Bearer id.secret`.
- **Add Hearth to my server**: Hearth asks the relay for the invite link (`/v1/invite`), signed
  with the install id (30 minutes). Discord returns the owner to `/v1/linked`, where the relay
  exchanges the code and learns the server, and links it to that Hearth.
- **Posting**: Hearth sends the message (same embed and pictures as a webhook, plus buttons) to
  `/v1/channels/:id/messages`; the relay checks the channel is in a server that Hearth linked.
- **A button press**: Discord POSTs it to `/interactions` (signature checked). The relay finds the
  Hearth that owns the server, hands the press to its socket, and answers Discord "thinking"
  (only the presser sees it). Hearth updates the guest list and answers with `/v1/reply`.
  If that Hearth is not connected, the presser is told to try again later.

## What the relay never sees or keeps

No Hearth's address, credentials or data; it keeps server ids and names, and each Hearth's
hashed secret. Messages pass through and are not stored.

## Kinds in Notifications

- **Discord (Hearth bot, one click)**: offered when the relay address is set (`DC_HEARTH_BOT_URL`,
  or the built-in default once the official relay runs).
- **Discord (your own bot, with buttons)**: the owner's own bot and token, for people who want it.
- **Discord** (webhook): posts only, no buttons.
