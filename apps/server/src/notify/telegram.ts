/**
 * Telegram alerts (11-13, Talome Gap Plan item 4): Hearth's messages to a Telegram chat through a
 * bot the owner makes with @BotFather. Alerts only, one way: nothing typed to the bot is acted on.
 *
 * Set up: paste the bot's token, send the bot any message, and Hearth finds the chat itself
 * (getUpdates), so nobody looks up a chat id. The token is a secret (the vault); it travels only
 * in the request path to api.telegram.org and is never put in an error or a log.
 */

const API = "https://api.telegram.org";
const TIMEOUT_MS = 10_000;

export const TELEGRAM_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;

type Fetch = typeof fetch;

async function call<T>(
  token: string,
  method: string,
  body: Record<string, unknown> | undefined,
  fetchImpl: Fetch,
): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${API}/bot${token}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error("Telegram did not answer.");
  }
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    description?: string;
    parameters?: { retry_after?: number };
  };
  if (res.status === 401 || res.status === 404)
    throw new Error(
      "Telegram doesn't accept this bot token. In Telegram, ask @BotFather for the token again (/token) and paste it here.",
    );
  if (res.status === 403)
    throw new Error(
      "The bot can't message that chat. Open the chat with your bot in Telegram, press Start (or unblock it), then try again.",
    );
  if (res.status === 429)
    throw new Error(
      `Telegram asked to wait ${data.parameters?.retry_after ?? 5} s before the next message.`,
    );
  if (!res.ok || !data.ok)
    throw new Error(
      `Telegram refused it (${res.status}${data.description ? `: ${data.description.slice(0, 200)}` : ""}).`,
    );
  return data.result as T;
}

/** The bot behind a token: its @name (checks the token works). */
export async function telegramBot(token: string, fetchImpl: Fetch = fetch) {
  const me = await call<{ username?: string; first_name?: string }>(
    token,
    "getMe",
    undefined,
    fetchImpl,
  );
  return { username: me.username ?? me.first_name ?? "your bot" };
}

/**
 * The chat to send to: the newest one that wrote to the bot (a private chat, a group or a
 * channel it was added to). Undefined when nobody has written to it yet.
 */
export async function telegramChat(
  token: string,
  fetchImpl: Fetch = fetch,
): Promise<{ id: string; name: string } | undefined> {
  type Chat = { id: number; type: string; title?: string; first_name?: string; username?: string };
  const updates = await call<
    {
      message?: { chat: Chat };
      channel_post?: { chat: Chat };
      my_chat_member?: { chat: Chat };
    }[]
  >(
    token,
    "getUpdates",
    { limit: 50, allowed_updates: ["message", "channel_post", "my_chat_member"] },
    fetchImpl,
  );
  for (const u of [...updates].reverse()) {
    const chat = u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat;
    if (!chat) continue;
    const name =
      chat.type === "private"
        ? (chat.first_name ?? chat.username ?? "your chat")
        : (chat.title ?? "a group");
    return { id: String(chat.id), name };
  }
  return undefined;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One message, as Telegram HTML: the title in bold, then the lines, then the link. */
export async function sendTelegram(
  token: string,
  chatId: string,
  message: { title: string; lines: string[]; severity: string; link?: string },
  fetchImpl: Fetch = fetch,
) {
  const mark =
    message.severity === "critical" ? "🚨 " : message.severity === "warning" ? "⚠️ " : "";
  const text = [
    `<b>${esc(mark + message.title)}</b>`,
    ...message.lines.map(esc),
    ...(message.link ? [esc(message.link)] : []),
  ]
    .join("\n\n")
    .slice(0, 4000);
  await call(
    token,
    "sendMessage",
    { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true },
    fetchImpl,
  );
}
