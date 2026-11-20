import { handle, socketCaller, type Env, type PressEvent, type Store } from "./relay";

/**
 * The relay on Cloudflare: D1 keeps which Hearth owns which Discord server, and one Durable
 * Object per Hearth holds the socket that Hearth keeps open, so a button press reaches it at once.
 * Sockets use hibernation, so an idle connection costs nothing.
 */

// The few Cloudflare types used here (no extra package needed to build or test).
interface D1Result<T> {
  results: T[];
}
interface D1Statement {
  bind(...v: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
  run(): Promise<unknown>;
}
interface D1Database {
  prepare(sql: string): D1Statement;
}
interface DurableObjectStub {
  fetch(req: Request | string, init?: RequestInit): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}
interface DurableObjectState {
  acceptWebSocket(ws: WebSocket): void;
  getWebSockets(): WebSocket[];
}
declare const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } };

interface Bindings extends Env {
  DB: D1Database;
  HUB: DurableObjectNamespace;
}

function d1Store(db: D1Database): Store {
  return {
    async addInstall(id, secretHash) {
      await db
        .prepare("INSERT INTO installs (id, secret_hash, created_at) VALUES (?, ?, ?)")
        .bind(id, secretHash, new Date().toISOString())
        .run();
    },
    async installSecretHash(id) {
      const r = await db
        .prepare("SELECT secret_hash FROM installs WHERE id = ?")
        .bind(id)
        .first<{ secret_hash: string }>();
      return r?.secret_hash;
    },
    async linkGuild(guildId, installId, name) {
      await db
        .prepare(
          "INSERT INTO guilds (guild_id, install_id, name, linked_at) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id) DO UPDATE SET install_id = excluded.install_id, name = excluded.name, linked_at = excluded.linked_at",
        )
        .bind(guildId, installId, name, new Date().toISOString())
        .run();
    },
    async guildsOf(installId) {
      const r = await db
        .prepare("SELECT guild_id AS id, name FROM guilds WHERE install_id = ?")
        .bind(installId)
        .all<{ id: string; name: string }>();
      return r.results;
    },
    async installOf(guildId) {
      const r = await db
        .prepare("SELECT install_id FROM guilds WHERE guild_id = ?")
        .bind(guildId)
        .first<{ install_id: string }>();
      return r?.install_id;
    },
    async unlinkGuild(guildId) {
      await db.prepare("DELETE FROM guilds WHERE guild_id = ?").bind(guildId).run();
    },
  };
}

export default {
  async fetch(req: Request, env: Bindings): Promise<Response> {
    const store = d1Store(env.DB);
    const hub = (installId: string) => env.HUB.get(env.HUB.idFromName(installId));
    const deps = {
      env,
      store,
      fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
      deliver: async (installId: string, event: PressEvent) => {
        const r = await hub(installId).fetch("https://hub/deliver", {
          method: "POST",
          body: JSON.stringify(event),
        });
        return r.ok;
      },
    };
    // A Hearth opens its socket here; it is held by that Hearth's own Durable Object.
    if (new URL(req.url).pathname === "/v1/socket") {
      if (req.headers.get("upgrade") !== "websocket")
        return new Response("Expected a WebSocket.", { status: 426 });
      const install = await socketCaller(req, deps);
      if (!install) return new Response("Unknown Hearth.", { status: 401 });
      return hub(install).fetch(req);
    }
    return handle(req, deps);
  },
};

/** One per Hearth: holds its open socket(s) and hands it button presses. */
export class Hub {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
    }
    const sockets = this.state.getWebSockets();
    if (!sockets.length) return new Response("offline", { status: 503 });
    const body = await req.text();
    for (const ws of sockets) ws.send(body);
    return new Response("ok");
  }

  // Keep-alive pings from Hearth are answered; nothing else comes this way.
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") ws.send("pong");
  }
  webSocketClose(ws: WebSocket) {
    ws.close();
  }
}
