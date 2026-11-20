import type http from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";

/**
 * A browser as a Music Assistant speaker (11-05: "there needs to be a way to add speakers",
 * "make sure you can add a speaker from remote connection"). The page where Hearth is open
 * (this computer, a phone, the PC you remote-desktop from) plays music through Music Assistant's
 * Sendspin, the same way Music Assistant's own web player does. The browser talks to Hearth;
 * Hearth opens Music Assistant's Sendspin connection, signs it in with the Music Assistant key
 * from Secure Vault (the key never reaches the browser), and passes the rest through as it is.
 *
 * Only a signed-in Hearth page (the owner, or a paired home tablet) on Hearth's own address
 * may open it.
 */

export const SPEAKER_PATH = "/api/home/speaker/socket";

export interface SpeakerUpstream {
  /** Music Assistant's Sendspin address (ws://host:8095/sendspin). */
  url: string;
  /** Sends the sign-in message with the key (inside the vault's use). */
  signIn: (send: (token: string) => void) => Promise<void>;
}

export interface SpeakerRelayDeps {
  /** Whether the request carries a signed-in Hearth session. */
  signedIn: (req: http.IncomingMessage) => Promise<boolean>;
  /** Music Assistant, when Hearth holds its key; null when it isn't linked. */
  upstream: () => Promise<SpeakerUpstream | null>;
  /** For tests: how the connection to Music Assistant opens. */
  open?: (url: string) => WebSocket;
}

const closeCode = (code: number) => (code >= 3000 && code < 5000 ? code : 1000);
const reason = (s: string) => s.slice(0, 120);

export function attachSpeakerRelay(server: http.Server, deps: SpeakerRelayDeps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const refuse = (socket: Duplex, code: number, text: string) =>
    socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () =>
      socket.destroy(),
    );
  const onUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://hearth.local");
    if (url.pathname !== SPEAKER_PATH) return;
    void (async () => {
      const origin = req.headers.origin;
      const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "");
      try {
        if (origin && new URL(origin).host !== host) return refuse(socket, 403, "Forbidden");
      } catch {
        return refuse(socket, 403, "Forbidden");
      }
      if (!(await deps.signedIn(req).catch(() => false)))
        return refuse(socket, 401, "Unauthorized");
      const up = await deps.upstream().catch(() => null);
      if (!up) return refuse(socket, 409, "Conflict");
      const clientId = url.searchParams.get("client") ?? "";
      wss.handleUpgrade(req, socket, head, (browser) =>
        relay(browser, up, /^[\w-]{8,100}$/.test(clientId) ? clientId : undefined, deps.open),
      );
    })();
  };
  server.on("upgrade", onUpgrade);
  return () => {
    server.off("upgrade", onUpgrade);
    for (const c of wss.clients) c.terminate();
    wss.close();
  };
}

function relay(
  browser: WebSocket,
  up: SpeakerUpstream,
  clientId: string | undefined,
  open: (url: string) => WebSocket = (u) => new WebSocket(u),
) {
  // What the browser says before Music Assistant has signed Hearth in waits here.
  const waiting: { data: RawData; binary: boolean }[] = [];
  let ready = false;
  let ma: WebSocket;
  try {
    ma = open(up.url);
  } catch {
    browser.close(1011, "Music Assistant could not be reached.");
    return;
  }
  const end = (code: number, why: string) => {
    if (browser.readyState === WebSocket.OPEN) browser.close(closeCode(code), reason(why));
    if (ma.readyState === WebSocket.OPEN || ma.readyState === WebSocket.CONNECTING) ma.terminate();
  };
  browser.on("message", (data, binary) => {
    if (ready) ma.send(data, { binary });
    else if (waiting.length < 200) waiting.push({ data, binary });
  });
  browser.on("close", () => end(1000, ""));
  browser.on("error", () => end(1011, ""));
  ma.on("open", () => {
    up.signIn((token) =>
      ma.send(
        JSON.stringify({ type: "auth", token, ...(clientId ? { client_id: clientId } : {}) }),
      ),
    ).catch(() => end(4001, "Hearth could not use the Music Assistant key."));
  });
  ma.on("message", (data, binary) => {
    if (ready) {
      if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary });
      return;
    }
    // The first answer is Music Assistant's sign-in reply, for Hearth, not the player.
    let ok: boolean;
    try {
      ok = (JSON.parse(String(data)) as { type?: string }).type === "auth_ok";
    } catch {
      ok = false;
    }
    if (!ok) return end(4001, "Music Assistant refused Hearth's key.");
    ready = true;
    for (const m of waiting.splice(0)) ma.send(m.data, { binary: m.binary });
  });
  ma.on("close", (code, why) =>
    end(code === 4001 ? 4001 : code, String(why) || "Music Assistant closed the connection."),
  );
  ma.on("error", () => end(1011, "Music Assistant could not be reached."));
}
