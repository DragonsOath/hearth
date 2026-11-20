import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { attachSpeakerRelay, SPEAKER_PATH } from "./speaker-relay";

// A Hearth page as a Music Assistant speaker: Hearth signs the Sendspin connection in with the
// key (the page never sees it), holds what the page says until then, and passes the rest
// through, text and audio alike. Pages that are not signed in, or from elsewhere, are refused.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function listen(server: http.Server) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return (server.address() as AddressInfo).port;
}

/** A stand-in Music Assistant: wants the key first, then echoes, and sends audio. */
async function fakeMusicAssistant(key: string) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: "/sendspin" });
  const seen: { auth?: Record<string, unknown>; messages: string[] } = { messages: [] };
  wss.on("connection", (ws) => {
    let authed = false;
    ws.on("message", (data, binary) => {
      if (!authed) {
        seen.auth = JSON.parse(String(data)) as Record<string, unknown>;
        if (seen.auth.token !== key) return ws.close(4001, "Invalid or expired token");
        authed = true;
        return ws.send('{"type": "auth_ok"}');
      }
      if (binary) return;
      seen.messages.push(String(data));
      ws.send(JSON.stringify({ type: "server/hello", echo: String(data) }));
      ws.send(Buffer.from([1, 2, 3, 4]), { binary: true });
    });
  });
  cleanups.push(() => {
    for (const c of wss.clients) c.terminate();
    wss.close();
  });
  const port = await listen(server);
  return { url: `ws://127.0.0.1:${port}/sendspin`, seen };
}

async function hearth(opts: { key: string; maUrl: string; signedIn?: boolean }) {
  const server = http.createServer();
  const stop = attachSpeakerRelay(server, {
    signedIn: async () => opts.signedIn ?? true,
    upstream: async () => ({ url: opts.maUrl, signIn: async (send) => send(opts.key) }),
  });
  cleanups.push(stop);
  const port = await listen(server);
  return `ws://127.0.0.1:${port}${SPEAKER_PATH}`;
}

const opened = (ws: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_req, res) => reject(new Error(String(res.statusCode))));
    ws.once("error", reject);
  });

describe("a Hearth page as a speaker", () => {
  it("signs in with the key, keeps early messages, and passes text and audio through", async () => {
    const ma = await fakeMusicAssistant("ma-key");
    const url = await hearth({ key: "ma-key", maUrl: ma.url });
    const page = new WebSocket(`${url}?client=abcdefgh1234`, {
      origin: url.replace("ws", "http").replace(SPEAKER_PATH, ""),
    });
    cleanups.push(() => page.terminate());
    const got: (string | Buffer)[] = [];
    page.on("message", (d, binary) => got.push(binary ? (d as Buffer) : String(d)));
    await opened(page);
    // Said straight away, before Music Assistant has signed Hearth in.
    page.send(JSON.stringify({ type: "client/hello" }));
    await expect.poll(() => got.length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
    expect(ma.seen.auth).toEqual({ type: "auth", token: "ma-key", client_id: "abcdefgh1234" });
    expect(ma.seen.messages).toEqual(['{"type":"client/hello"}']);
    // The sign-in reply is Hearth's, never passed to the page.
    expect(got.some((m) => typeof m === "string" && m.includes("auth_ok"))).toBe(false);
    expect(got[0]).toContain("server/hello");
    expect(Buffer.isBuffer(got[1]) && [...(got[1] as Buffer)]).toEqual([1, 2, 3, 4]);
  });

  it("closes when Music Assistant refuses the key", async () => {
    const ma = await fakeMusicAssistant("right");
    const url = await hearth({ key: "wrong", maUrl: ma.url });
    const page = new WebSocket(url);
    cleanups.push(() => page.terminate());
    const closed = new Promise<number>((r) => page.on("close", (code) => r(code)));
    await opened(page);
    expect(await closed).toBe(4001);
  });

  it("refuses a page that is not signed in, or from another site", async () => {
    const ma = await fakeMusicAssistant("k");
    const out = await hearth({ key: "k", maUrl: ma.url, signedIn: false });
    await expect(opened(new WebSocket(out))).rejects.toThrow("401");
    const url = await hearth({ key: "k", maUrl: ma.url });
    await expect(opened(new WebSocket(url, { origin: "https://evil.example" }))).rejects.toThrow(
      "403",
    );
  });
});
