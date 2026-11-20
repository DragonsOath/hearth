import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MessageGoneError, sendDiscordRich } from "./providers";

// A stand-in for a Discord webhook: posting with ?wait=true answers the message (with its id),
// PATCH .../messages/{id} edits it, and a deleted message answers 404.
const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function fakeDiscord(opts: { deleted?: string } = {}) {
  const seen: { method: string; path: string }[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ method: req.method!, path: req.url! });
      if (opts.deleted && req.url!.includes(`/messages/${opts.deleted}`)) {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: "Unknown Message" }));
        return;
      }
      if (req.method === "PATCH" || req.url!.includes("wait=true")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: req.method === "PATCH" ? req.url!.split("/").pop() : "111" }));
        return;
      }
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/webhooks/1/tok`;
  return { url, seen };
}

describe("Discord webhook posts that can be edited", () => {
  it("posts and gets the id back, then edits that same message", async () => {
    const d = await fakeDiscord();
    expect(await sendDiscordRich(d.url, { content: "hi" })).toBeUndefined();
    expect(await sendDiscordRich(d.url, { content: "hi" }, [], { wait: true })).toBe("111");
    expect(await sendDiscordRich(d.url, { content: "edit" }, [], { messageId: "111" })).toBe("111");
    expect(d.seen).toEqual([
      { method: "POST", path: "/api/webhooks/1/tok" },
      { method: "POST", path: "/api/webhooks/1/tok?wait=true" },
      { method: "PATCH", path: "/api/webhooks/1/tok/messages/111" },
    ]);
  });

  it("says when the message to edit was deleted in Discord (the webhook still works)", async () => {
    const d = await fakeDiscord({ deleted: "222" });
    await expect(
      sendDiscordRich(d.url, { content: "edit" }, [], { messageId: "222" }),
    ).rejects.toBeInstanceOf(MessageGoneError);
  });
});

describe("a Discord webhook's own picture", () => {
  async function fakeWebhook(avatar: string | null) {
    const seen: { method: string; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        seen.push({ method: req.method!, body });
        res.setHeader("content-type", "application/json");
        if (req.method === "PATCH") avatar = "newhash";
        res.end(JSON.stringify({ id: "123", name: "Movies", avatar }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/webhooks/123/tok`,
      seen,
    };
  }

  it("reads it as Discord's picture address, or none", async () => {
    const { discordWebhookPicture } = await import("./providers");
    expect(await discordWebhookPicture((await fakeWebhook("abc123")).url)).toBe(
      "https://cdn.discordapp.com/avatars/123/abc123.png?size=128",
    );
    expect(await discordWebhookPicture((await fakeWebhook(null)).url)).toBeUndefined();
  });

  it("changes it with the picture itself", async () => {
    const { setDiscordWebhookPicture } = await import("./providers");
    const hook = await fakeWebhook(null);
    await setDiscordWebhookPicture(hook.url, "image/png", "iVBORw0KGgo=");
    expect(hook.seen[0]!.method).toBe("PATCH");
    expect(JSON.parse(hook.seen[0]!.body)).toEqual({
      avatar: "data:image/png;base64,iVBORw0KGgo=",
    });
  });
});
