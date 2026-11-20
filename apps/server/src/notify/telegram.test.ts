import { describe, expect, it } from "vitest";
import { sendTelegram, telegramBot, telegramChat, TELEGRAM_TOKEN } from "./telegram";

const TOKEN = "123456789:AAH-fake_token_for_tests_only_abcdefgh";

/** A stand-in Telegram: records calls, answers by method. */
function fakeTelegram(answers: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; body?: unknown }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const method = u.split("/").pop()!;
    const a = answers[method] ?? { status: 404, body: { ok: false } };
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

describe("Telegram alerts", () => {
  it("recognises a bot token", () => {
    expect(TELEGRAM_TOKEN.test(TOKEN)).toBe(true);
    expect(TELEGRAM_TOKEN.test("not a token")).toBe(false);
  });

  it("finds the bot, and the newest chat that wrote to it", async () => {
    const { f } = fakeTelegram({
      getMe: { body: { ok: true, result: { username: "my_lab_bot" } } },
      getUpdates: {
        body: {
          ok: true,
          result: [
            { message: { chat: { id: 1, type: "private", first_name: "Old" } } },
            { message: { chat: { id: -100200, type: "group", title: "Homelab" } } },
          ],
        },
      },
    });
    expect(await telegramBot(TOKEN, f)).toEqual({ username: "my_lab_bot" });
    expect(await telegramChat(TOKEN, f)).toEqual({ id: "-100200", name: "Homelab" });
  });

  it("says when nobody has written to the bot yet", async () => {
    const { f } = fakeTelegram({ getUpdates: { body: { ok: true, result: [] } } });
    expect(await telegramChat(TOKEN, f)).toBeUndefined();
  });

  it("sends the title in bold, escaped, and never puts the token in an error", async () => {
    const { f, calls } = fakeTelegram({ sendMessage: { body: { ok: true, result: {} } } });
    await sendTelegram(
      TOKEN,
      "42",
      { title: "Disk <almost> full", lines: ["Media is 91% full."], severity: "warning" },
      f,
    );
    expect(calls[0]!.body).toMatchObject({
      chat_id: "42",
      parse_mode: "HTML",
      text: "<b>⚠️ Disk &lt;almost&gt; full</b>\n\nMedia is 91% full.",
    });
    const bad = fakeTelegram({ getMe: { status: 401, body: { ok: false } } });
    const err = await telegramBot(TOKEN, bad.f).catch((e: Error) => e);
    expect(String(err)).toMatch(/doesn't accept this bot token/);
    expect(String(err)).not.toContain(TOKEN);
    const blocked = fakeTelegram({ sendMessage: { status: 403, body: { ok: false } } });
    await expect(
      sendTelegram(TOKEN, "42", { title: "x", lines: [], severity: "info" }, blocked.f),
    ).rejects.toThrow(/press Start/);
  });
});
