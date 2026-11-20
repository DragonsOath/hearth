import { afterEach, describe, expect, it, vi } from "vitest";
import { pressOf, sendDiscordBot } from "./discord-bot";
import { PROVIDERS } from "./providers";

afterEach(() => vi.unstubAllGlobals());

describe("your Discord bot", () => {
  it("reads a button press, with the name the server shows", () => {
    expect(
      pressOf({
        type: 3,
        data: { custom_id: "mn:in:abc", component_type: 2 },
        member: { nick: "Sammy", user: { id: "1", username: "sam", global_name: "Sam" } },
      }),
    ).toEqual({ customId: "mn:in:abc", name: "Sammy", userId: "1" });
    expect(
      pressOf({
        type: 3,
        data: { custom_id: "x", component_type: 2 },
        user: { id: "2", username: "alex" },
      })?.name,
    ).toBe("alex");
    // Slash commands and other interactions are not presses.
    expect(pressOf({ type: 2, data: { name: "hi" } })).toBeUndefined();
  });

  it("posts as the bot with buttons, without webhook-only fields, and never shows the token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ id: "99" }), { status: 200 });
      }),
    );
    const id = await sendDiscordBot(
      "t0ken",
      "123",
      { username: "Hearth", avatar_url: "x", embeds: [{ title: "Hi" }] },
      [],
      { components: [{ type: 1 }] },
    );
    expect(id).toBe("99");
    expect(calls[0]!.url).toBe("https://discord.com/api/v10/channels/123/messages");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bot t0ken");
    const body = JSON.parse(String((calls[0]!.init.body as FormData).get("payload_json")));
    expect(body).toEqual({ embeds: [{ title: "Hi" }], components: [{ type: 1 }], attachments: [] });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    const err = await sendDiscordBot("t0ken", "123", {}).catch((e: Error) => e.message);
    expect(err).toMatch(/did not accept the bot token/);
    expect(err).not.toContain("t0ken");
  });

  it("asks for the channel's link and a real token", () => {
    const p = PROVIDERS["discord-bot"];
    expect(p.validate({ channel: "movie-chat" }, "x".repeat(70))).toMatch(/Copy Link/);
    expect(
      p.validate({ channel: "https://discord.com/channels/1/1565080201413795884" }, "short"),
    ).toMatch(/bot token/);
    expect(
      p.validate({ channel: "https://discord.com/channels/1/1565080201413795884" }, "a".repeat(72)),
    ).toBeUndefined();
  });
});
