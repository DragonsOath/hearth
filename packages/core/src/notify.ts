/**
 * Notification channels you can set up, and the settings each needs.
 * Shared so the server validates and the web app builds its forms from
 * one definition. Fields marked secret go into the vault, never into
 * settings, the workspace, or logs.
 */

export type ChannelKind =
  "email" | "discord" | "discord-bot" | "hearth-bot" | "ntfy" | "push" | "telegram" | "webhook";

export interface ChannelField {
  key: string;
  label: string;
  type: "text" | "number" | "password" | "select";
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  hint?: string;
  options?: { value: string; label: string }[];
  defaultValue?: string;
}

export const CHANNEL_FIELDS: Record<ChannelKind, ChannelField[]> = {
  email: [
    { key: "to", label: "Send to", type: "text", required: true, placeholder: "you@example.com" },
    {
      key: "from",
      label: "Send from",
      type: "text",
      required: true,
      placeholder: "dragon-control@example.com",
    },
    {
      key: "host",
      label: "Mail server",
      type: "text",
      required: true,
      placeholder: "smtp.example.com",
    },
    { key: "port", label: "Port", type: "number", required: true, defaultValue: "587" },
    {
      key: "security",
      label: "Connection",
      type: "select",
      defaultValue: "starttls",
      options: [
        { value: "starttls", label: "STARTTLS (usually port 587)" },
        { value: "tls", label: "TLS (usually port 465)" },
        { value: "none", label: "Unencrypted (local relays only)" },
      ],
    },
    {
      key: "certificate",
      label: "Certificate",
      type: "select",
      defaultValue: "verify",
      options: [
        { value: "verify", label: "Verify it (recommended)" },
        { value: "self-signed", label: "Allow self-signed (e.g. Proton Bridge on this machine)" },
      ],
    },
    { key: "username", label: "Username", type: "text", placeholder: "Often your email address" },
    { key: "password", label: "Password", type: "password", secret: true },
  ],
  discord: [
    {
      key: "webhookUrl",
      label: "Webhook address",
      type: "password",
      required: true,
      secret: true,
      placeholder: "https://discord.com/api/webhooks/...",
      hint: "In Discord: channel settings, Integrations, Webhooks, Copy Webhook URL.",
    },
  ],
  // Your own Discord bot posting in one channel: its messages can carry buttons (movie night
  // RSVPs), which a webhook's cannot.
  "discord-bot": [
    {
      key: "token",
      label: "Bot token",
      type: "password",
      required: true,
      secret: true,
      hint: "In the Discord Developer Portal: your app, Bot, Reset Token, then Copy. Paste it here; it goes into Hearth's vault.",
    },
    {
      key: "channel",
      label: "Channel",
      type: "text",
      required: true,
      placeholder: "https://discord.com/channels/...",
      hint: "In Discord, right-click the channel and choose Copy Link. The bot must be in that server.",
    },
  ],
  // The official Hearth bot: added to a server with one click (no token), set up in its own steps.
  "hearth-bot": [
    {
      key: "channel",
      label: "Channel",
      type: "text",
      required: true,
      hint: "Picked from the servers you added Hearth to.",
    },
  ],
  ntfy: [
    {
      key: "server",
      label: "Server",
      type: "text",
      required: true,
      defaultValue: "https://ntfy.sh",
    },
    {
      key: "topic",
      label: "Topic",
      type: "text",
      required: true,
      hint: "Anyone who knows a topic on ntfy.sh can read it; pick something hard to guess.",
    },
    {
      key: "token",
      label: "Access token",
      type: "password",
      secret: true,
      hint: "Only for protected topics.",
    },
  ],
  // Browser push is turned on from each device (Notifications, Browser push), not with a form.
  push: [],
  telegram: [
    {
      key: "token",
      label: "Bot token",
      type: "password",
      required: true,
      secret: true,
      placeholder: "123456789:AA...",
      hint: "In Telegram, message @BotFather, send /newbot, pick a name, and copy the token it gives you. Then open your new bot and press Start (or add it to a group and say hello): Hearth finds the chat itself.",
    },
  ],
  webhook: [
    {
      key: "url",
      label: "Address",
      type: "password",
      required: true,
      secret: true,
      placeholder: "https://...",
      hint: "Receives a JSON POST: title, message, severity, link. Works with Home Assistant, n8n, and similar.",
    },
  ],
};

export function isChannelKind(id: string): id is ChannelKind {
  return id in CHANNEL_FIELDS;
}

/**
 * Why a destination can't be reached any more, in plain words, from the error of its last
 * delivery; undefined when the failure may pass on its own (a timeout, a busy server, a rate
 * limit). 11-13: a Discord webhook deleted in Discord answers 404 "Unknown Webhook".
 */
/** The Hearth bot isn't in the channel's server: the fix is "Add Hearth to that server". */
export const HEARTH_NOT_IN_SERVER =
  "Hearth isn't in that channel's server, so it can't post there. Add Hearth to that server, then send a test.";

export function brokenReason(error: string | null | undefined, kind?: string): string | undefined {
  if (!error) return undefined;
  // Three different fixes (the owner, 11-14), so three different messages.
  if (/not in a server you added Hearth/i.test(error)) return HEARTH_NOT_IN_SERVER;
  if (/Missing Access|Missing Permissions|\b5000[13]\b/i.test(error))
    return "That channel is private, so Hearth can't post in it. In Discord, open the channel's settings, then Permissions, and let Hearth view the channel and send messages. Or pick another channel.";
  if (/Unknown Channel|\b10003\b/i.test(error))
    return "That channel no longer exists in Discord. Pick another channel.";
  if (/Unknown Webhook|\b404\b/i.test(error))
    return kind === "discord"
      ? "This webhook was deleted in Discord, so nothing reaches it."
      : "The address it sends to no longer exists.";
  if (/Invalid Webhook Token|\b401\b|\b403\b|unauthori[sz]ed|forbidden/i.test(error))
    return "It was turned away: the key or token it uses no longer works.";
  return undefined;
}
