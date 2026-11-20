import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PROVIDERS, type Message } from "./providers";

// The real providers, talking to stand-in servers on this machine.

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** Just enough SMTP to accept one message and keep what it said. */
async function smtpSink() {
  const received: string[] = [];
  const server = net.createServer((socket) => {
    let data = false;
    let buffer = "";
    let body = "";
    socket.write("220 sink ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let i: number;
      while ((i = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (data) {
          if (line === ".") {
            data = false;
            received.push(body);
            body = "";
            socket.write("250 queued\r\n");
          } else {
            body += `${line}\n`;
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") socket.write("250-sink\r\n250 OK\r\n");
        else if (verb === "HELO") socket.write("250 sink\r\n");
        else if (verb === "DATA") {
          data = true;
          socket.write("354 go ahead\r\n");
        } else if (verb === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  return { port: (server.address() as AddressInfo).port, received };
}

async function httpSink(status = 204) {
  const received: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      received.push({ url: req.url ?? "", headers: req.headers, body });
      res.statusCode = status;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

const message: Message = {
  title: "Fixed: Jellyfin stopped responding",
  lines: ["Restarted the Jellyfin container automatically.", "Hearth on Home."],
  severity: "info",
  link: "https://dc.example/incidents/inc-1",
};

describe("email", () => {
  it("sends through an SMTP server", async () => {
    const sink = await smtpSink();
    await PROVIDERS.email.send(
      message,
      {
        host: "127.0.0.1",
        port: sink.port,
        security: "none",
        from: "dc@example.com",
        to: "owner@example.com",
      },
      undefined,
    );
    expect(sink.received).toHaveLength(1);
    const mail = sink.received[0]!;
    expect(mail).toContain("Subject: Fixed: Jellyfin stopped responding");
    expect(mail).toContain("To: owner@example.com");
    expect(mail).toContain("Restarted the Jellyfin container automatically.");
    expect(mail).toContain("https://dc.example/incidents/inc-1");
  });

  it("reports a server that is not there", async () => {
    await expect(
      PROVIDERS.email.send(
        message,
        { host: "127.0.0.1", port: 1, security: "none", from: "a@b.c", to: "d@e.f" },
        undefined,
      ),
    ).rejects.toThrow();
  });

  it("checks its settings", () => {
    const ok = { to: "a@b.c", from: "d@e.f", host: "smtp.x", port: 587 };
    expect(PROVIDERS.email.validate(ok, undefined)).toBeUndefined();
    expect(PROVIDERS.email.validate({ ...ok, to: "nope" }, undefined)).toMatch(/send to/);
    expect(PROVIDERS.email.validate({ ...ok, port: 70000 }, undefined)).toMatch(/port/);
  });
});

describe("webhooks", () => {
  it("posts a Discord embed with a user agent Discord accepts", async () => {
    const sink = await httpSink();
    await PROVIDERS.discord.send(
      { ...message, severity: "critical" },
      {},
      `${sink.url}/api/webhooks/1/x`,
    );
    const req = sink.received[0]!;
    expect(req.headers["user-agent"]).toMatch(/^DragonControl/);
    const body = JSON.parse(req.body);
    expect(body.embeds[0]).toMatchObject({
      title: "Fixed: Jellyfin stopped responding",
      url: "https://dc.example/incidents/inc-1",
      color: 0xb5534a,
    });
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it("posts to ntfy with title, priority, link, and token as headers", async () => {
    const sink = await httpSink(200);
    await PROVIDERS.ntfy.send(
      { ...message, severity: "warning" },
      { server: `${sink.url}/`, topic: "homelab-x7" },
      "tk_secret",
    );
    const req = sink.received[0]!;
    expect(req.url).toBe("/homelab-x7");
    expect(req.headers).toMatchObject({
      title: "Fixed: Jellyfin stopped responding",
      priority: "4",
      click: "https://dc.example/incidents/inc-1",
      authorization: "Bearer tk_secret",
    });
    expect(req.body).toContain("Restarted the Jellyfin container automatically.");
  });

  it("posts plain JSON to a generic webhook, and reports a refusal", async () => {
    const sink = await httpSink();
    await PROVIDERS.webhook.send(message, {}, `${sink.url}/hook`);
    expect(JSON.parse(sink.received[0]!.body)).toEqual({
      source: "dragon-control",
      title: "Fixed: Jellyfin stopped responding",
      message: "Restarted the Jellyfin container automatically.\n\nHearth on Home.",
      severity: "info",
      link: "https://dc.example/incidents/inc-1",
    });
    const refusing = await httpSink(500);
    await expect(PROVIDERS.webhook.send(message, {}, refusing.url)).rejects.toThrow(
      /The server answered 500/,
    );
  });

  it("only accepts real Discord webhook addresses", () => {
    const v = (url: string) => PROVIDERS.discord.validate({}, url);
    expect(v("https://discord.com/api/webhooks/123/abc")).toBeUndefined();
    expect(v("https://discordapp.com/api/webhooks/123/abc")).toBeUndefined();
    expect(v("http://discord.com/api/webhooks/123/abc")).toBeDefined();
    expect(v("https://evil.example/api/webhooks/1")).toBeDefined();
    expect(v("https://discord.com.evil.example/api/webhooks/1")).toBeDefined();
    expect(
      PROVIDERS.ntfy.validate({ server: "https://ntfy.sh", topic: "bad topic!" }, undefined),
    ).toBeDefined();
  });
});
