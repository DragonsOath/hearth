import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import WebSocket from "ws";
import type { Auth } from "../auth/service";
import { randomToken } from "../auth/crypto";
import { resetOwner } from "../auth/reset";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { recordAudit } from "../store/audit";
import { ConflictError, InvalidRequestError } from "../store/errors";
import { deleteSetting, getSetting, setSetting } from "../store/settings";
import {
  LINK_HEADER,
  LINK_SECRET,
  MAX_BODY,
  PASS_HEADERS,
  type FromPc,
  type InstallInfo,
  type ToPc,
} from "./link";

/**
 * On a PC that joined another Hearth (docs/design/ONE_ACCOUNT.md): keeps the link to it open,
 * reconnecting by itself, and answers what comes down it by running each request here as one
 * from the owner.
 */

export interface InjectResult {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  rawPayload: Buffer;
}

export interface MemberDeps {
  handle: DbHandle;
  auth: Auth;
  keyDir: string;
  dataDir: string;
  version: string;
  /** Runs a request inside this Hearth (Fastify's inject). */
  inject: (o: {
    method: string;
    url: string;
    headers: Record<string, string>;
    payload?: Buffer;
  }) => Promise<InjectResult>;
  /** Where this Hearth listens, for forwarded WebSockets (null before it listens). */
  localAddress: () => { host: string; port: number } | null;
  /** How this installation was made (install.json beside the app), if it says. */
  install: () => InstallInfo | null;
  /** Removes Hearth from this PC (the installer's own way); null when it cannot. */
  uninstall?: (deleteData: boolean) => Promise<{ ok: boolean; message: string }>;
}

/** A join link: your Hearth's address and the one-time code. */
export function parseJoinLink(link: string): { hubUrl: string; code: string } {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    throw new InvalidRequestError(
      "That is not a join link. Copy it again from Link another Hearth.",
    );
  }
  const code = u.searchParams.get("code") ?? "";
  if (!/^https?:$/.test(u.protocol) || !code)
    throw new InvalidRequestError(
      "That is not a join link. Copy it again from Link another Hearth.",
    );
  return { hubUrl: u.origin, code };
}

export class HubMember {
  /** This PC's own Premium licences, sent up so your Hearth and its other PCs count them too. */
  licences?: () => Promise<string[]>;
  /** The licences your Hearth counts (an empty list when this PC leaves it). */
  onLicences?: (tokens: string[]) => Promise<void> | void;

  private ws: WebSocket | null = null;
  private retry = 1000;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly local = new Map<number, WebSocket>();
  online = false;

  constructor(private readonly d: MemberDeps) {}

  private get tokenFile() {
    return path.join(this.d.keyDir, "hub-link-token");
  }
  private get joinFile() {
    return path.join(this.d.dataDir, "join-link");
  }

  async joined() {
    return this.d.handle.db.select().from(t.hubLink).where(eq(t.hubLink.id, 1)).get();
  }

  /** What the PC's own page says: which Hearth it belongs to. */
  async status() {
    const row = await this.joined();
    return row ? { name: row.hubName, url: row.hubUrl, online: this.online, pcId: row.pcId } : null;
  }

  /** Starts the link if joined; joins first if the installer left a join link. */
  async start() {
    this.stopped = false;
    if (!(await this.joined()) && existsSync(this.joinFile)) {
      const link = readFileSync(this.joinFile, "utf8").trim();
      rmSync(this.joinFile, { force: true });
      try {
        await this.join(link);
      } catch (e) {
        // The setup page offers to join by hand; say why here too.
        console.error(`Hearth could not join with the installer's link: ${(e as Error).message}`);
      }
      return;
    }
    if (await this.joined()) this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close();
    for (const s of this.local.values()) s.close();
    this.local.clear();
  }

  /** Joins your Hearth with a join link. This PC then has no sign-in of its own. */
  /** This PC's own name, kept here too (Remote Control sessions are named after it). */
  private rememberName(name: string) {
    try {
      writeFileSync(path.join(this.d.dataDir, "this-pc.json"), JSON.stringify({ name }));
    } catch {
      // Only a label.
    }
    return name;
  }

  async join(link: string, choose: { name?: string; icon?: string; keepAccount?: boolean } = {}) {
    if (await this.joined()) throw new ConflictError("This PC already belongs to a Hearth.");
    const { hubUrl, code } = parseJoinLink(link);
    let res: Response;
    try {
      res = await fetch(`${hubUrl}/api/pcs/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code,
          // The name and icon picked in this PC's setup, else its own name.
          name: this.rememberName(choose.name?.trim() || hostname()),
          ...(choose.icon ? { icon: choose.icon } : {}),
          os: osName(),
          version: this.d.version,
          install: this.d.install(),
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ConflictError(
        `This PC can't reach your Hearth at ${hubUrl}. Check both are on the same network (or Tailscale).`,
      );
    }
    const body = (await res.json().catch(() => ({}))) as {
      pcId?: string;
      token?: string;
      hubName?: string;
      message?: string;
    };
    if (!res.ok || !body.pcId || !body.token)
      throw new ConflictError(body.message ?? `Your Hearth said no (${res.status}).`);
    mkdirSync(this.d.keyDir, { recursive: true });
    writeFileSync(this.tokenFile, `${body.token}\n`, { mode: 0o600 });
    await this.d.handle.db.insert(t.hubLink).values({
      id: 1,
      hubUrl,
      hubName: body.hubName ?? "your Hearth",
      pcId: body.pcId,
      joinedAt: new Date().toISOString(),
    });
    // Nobody signs in to this PC directly any more: secure it with a password nobody knows, so
    // its own page cannot be claimed by anyone else on the network.
    const setupCode = await this.d.auth.setupCode();
    if (setupCode) await this.d.auth.setup({ code: setupCode, password: randomToken(32) });
    // A PC that had its own account before joining keeps it, and goes back to it if your Hearth
    // ever removes it (instead of to a fresh setup page).
    if (choose.keepAccount) await setSetting(this.d.handle.db, "pc_kept_own_account", true);
    await recordAudit(this.d.handle.db, {
      actor: "you",
      action: `Joined the Hearth on ${body.hubName ?? hubUrl}`,
      target: "security",
    });
    this.connect();
    return { hubName: body.hubName ?? "your Hearth", hubUrl };
  }

  /** Forgets your Hearth (it removed this PC): back to its own setup page. */
  async forget() {
    this.stop();
    rmSync(this.tokenFile, { force: true });
    await this.d.handle.db.delete(t.hubLink);
    if (await getSetting(this.d.handle.db, "pc_kept_own_account"))
      await deleteSetting(this.d.handle.db, "pc_kept_own_account");
    else await resetOwner(this.d.handle);
    // No longer linked: your Hearth's licences stop counting here.
    await this.onLicences?.([]);
    this.online = false;
  }

  /** This PC's own licences changed: tells your Hearth, which passes them to its other PCs. */
  async shareLicences() {
    if (this.licences) this.send({ t: "licences", tokens: await this.licences().catch(() => []) });
  }

  private connect() {
    if (this.stopped) return;
    void (async () => {
      const row = await this.joined();
      if (!row || !existsSync(this.tokenFile)) return;
      const token = readFileSync(this.tokenFile, "utf8").trim();
      const ws = new WebSocket(`${row.hubUrl.replace(/^http/, "ws")}/api/link`, {
        headers: { authorization: `Bearer ${token}`, "x-hearth-pc": row.pcId },
        handshakeTimeout: 15_000,
      });
      this.ws = ws;
      ws.on("open", () => {
        this.online = true;
        this.retry = 1000;
        void (async () => {
          const licences = this.licences ? await this.licences().catch(() => []) : undefined;
          this.send({
            t: "hello",
            name: hostname(),
            os: osName(),
            version: this.d.version,
            install: this.d.install(),
            ...(licences ? { licences } : {}),
          });
        })();
      });
      ws.on("message", (raw) => {
        let m: ToPc;
        try {
          m = JSON.parse(String(raw)) as ToPc;
        } catch {
          return;
        }
        void this.handle(m);
      });
      ws.on("unexpected-response", (_req, res) => {
        // Your Hearth no longer knows this PC (removed while it was off): forget it.
        if (res.statusCode === 401) void this.forget();
      });
      ws.on("error", () => undefined);
      ws.on("close", () => {
        this.online = false;
        if (this.ws === ws) this.ws = null;
        for (const s of this.local.values()) s.close();
        this.local.clear();
        if (!this.stopped) {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.connect(), this.retry);
          this.retry = Math.min(this.retry * 2, 30_000);
        }
      });
    })();
  }

  private send(m: FromPc) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private async handle(m: ToPc) {
    switch (m.t) {
      case "ping":
        return this.send({ t: "pong" });
      case "req":
        return this.request(m);
      case "ws-open":
        return this.openLocal(m.sid, m.url, m.headers);
      case "ws-data": {
        const s = this.local.get(m.sid);
        const data = m.bin ? Buffer.from(m.d, "base64") : m.d;
        if (s?.readyState === WebSocket.OPEN) s.send(data, { binary: Boolean(m.bin) });
        // Still connecting: sent once it opens, in order.
        else if (s?.readyState === WebSocket.CONNECTING)
          s.once("open", () => s.send(data, { binary: Boolean(m.bin) }));
        return;
      }
      case "ws-close":
        this.local.get(m.sid)?.close();
        this.local.delete(m.sid);
        return;
      case "removed":
        return this.forget();
      case "licences":
        if (Array.isArray(m.tokens)) await this.onLicences?.(m.tokens);
        return;
      case "uninstall": {
        const answer = this.d.uninstall
          ? await this.d.uninstall(m.deleteData).catch((e: Error) => ({
              ok: false,
              message: e.message,
            }))
          : {
              ok: false,
              message:
                "Hearth was installed on this PC by hand, so it can't remove itself. Run its installer with --uninstall there.",
            };
        return this.send({ t: "uninstalling", ...answer });
      }
    }
  }

  private async request(m: Extract<ToPc, { t: "req" }>) {
    let res: InjectResult;
    try {
      const payload = m.body ? Buffer.from(m.body, "base64") : undefined;
      if (payload && payload.length > MAX_BODY) throw new Error("too large");
      res = await this.d.inject({
        method: m.method,
        url: m.url,
        headers: { ...m.headers, [LINK_HEADER]: LINK_SECRET },
        ...(payload ? { payload } : {}),
      });
    } catch (e) {
      return this.send({
        t: "res",
        id: m.id,
        status: 502,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ message: (e as Error).message })).toString("base64"),
      });
    }
    const headers: Record<string, string> = {};
    for (const h of PASS_HEADERS) {
      const v = res.headers[h];
      if (v !== undefined) headers[h] = String(v);
    }
    this.send({
      t: "res",
      id: m.id,
      status: res.statusCode,
      headers,
      body: res.rawPayload.toString("base64"),
    });
  }

  private openLocal(sid: number, url: string, headers: Record<string, string>) {
    const at = this.d.localAddress();
    if (!at) return this.send({ t: "ws-close", sid });
    const host = at.host === "0.0.0.0" || at.host === "::" ? "127.0.0.1" : at.host;
    const s = new WebSocket(`ws://${host}:${at.port}${url}`, {
      headers: { ...headers, [LINK_HEADER]: LINK_SECRET },
    });
    this.local.set(sid, s);
    s.on("message", (raw, isBinary) => {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      this.send(
        isBinary
          ? { t: "ws-data", sid, d: buf.toString("base64"), bin: true }
          : { t: "ws-data", sid, d: buf.toString("utf8") },
      );
    });
    s.on("error", () => undefined);
    s.on("close", (code) => {
      if (this.local.delete(sid)) this.send({ t: "ws-close", sid, code });
    });
  }
}

/** "Linux (Homeserver OS 18)" or "Windows 11", in plain words. */
export function osName(): string {
  if (process.platform === "win32") return "Windows";
  if (process.platform === "darwin") return "macOS";
  try {
    const rel = readFileSync("/etc/os-release", "utf8");
    const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(rel)?.[1];
    return pretty ? `Linux (${pretty})` : "Linux";
  } catch {
    return "Linux";
  }
}

/**
 * This PC's name: the one picked when it linked to your Hearth, or (on your main Hearth) the name
 * set for it in PCs and devices, else the computer's own name.
 */
export function thisPcName(dataDir: string): string {
  for (const f of [
    path.join(dataDir, "this-pc.json"),
    path.join(dataDir, "pc-icons", "hub.json"),
  ]) {
    try {
      const name = (JSON.parse(readFileSync(f, "utf8")) as { name?: unknown }).name;
      if (typeof name === "string" && name.trim()) return name.trim();
    } catch {
      // Not there: try the next.
    }
  }
  return hostname();
}
