import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { WebSocket } from "ws";
import type { Auth, SignInContext } from "../auth/service";
import { randomToken, sha256 } from "../auth/crypto";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { recordAudit } from "../store/audit";
import { NotFoundError } from "../store/errors";
import { isColor, pcIcon } from "@dragon-control/core";
import type { FromPc, InstallInfo, ToPc } from "./link";

/**
 * On your Hearth: the PCs that joined it, and the live link to each one that is online
 * (docs/design/ONE_ACCOUNT.md).
 */

export class PcOfflineError extends Error {
  override name = "Offline";
  statusCode = 503;
}

export interface PcRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Buffer;
}
export interface PcResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** The open link to one PC. */
export class PcLink {
  private next = 1;
  private readonly pending = new Map<
    number,
    { resolve: (r: PcResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  /** Forwarded WebSockets (a browser on your Hearth, to a socket on the PC). */
  private readonly streams = new Map<number, WebSocket>();
  hello: Extract<FromPc, { t: "hello" }> | null = null;
  onUninstalling?: (ok: boolean, message: string) => void;

  constructor(
    readonly pcId: string,
    private readonly ws: WebSocket,
    onHello: (h: Extract<FromPc, { t: "hello" }>) => void,
    onClose: () => void,
  ) {
    ws.on("message", (raw) => {
      let m: FromPc;
      try {
        m = JSON.parse(String(raw)) as FromPc;
      } catch {
        return;
      }
      if (m.t === "hello") {
        this.hello = m;
        onHello(m);
      } else if (m.t === "res") {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        p.resolve({ status: m.status, headers: m.headers, body: Buffer.from(m.body, "base64") });
      } else if (m.t === "ws-data") {
        // Data can arrive after the browser's socket closed: then there is nothing to send it to.
        // (Comparing s?.readyState with s?.OPEN was true for a missing socket, and the send
        // threw out of the message handler, taking the whole server down.)
        const s = this.streams.get(m.sid);
        if (s && s.readyState === s.OPEN)
          s.send(m.bin ? Buffer.from(m.d, "base64") : m.d, { binary: Boolean(m.bin) });
      } else if (m.t === "ws-close") {
        this.streams.get(m.sid)?.close();
        this.streams.delete(m.sid);
      } else if (m.t === "uninstalling") {
        this.onUninstalling?.(m.ok, m.message);
      }
    });
    ws.on("close", () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new PcOfflineError("That PC went offline."));
      }
      this.pending.clear();
      for (const s of this.streams.values()) s.close();
      this.streams.clear();
      onClose();
    });
  }

  get open() {
    return this.ws.readyState === this.ws.OPEN;
  }

  send(m: ToPc) {
    if (this.open) this.ws.send(JSON.stringify(m));
  }

  request(req: PcRequest, timeoutMs = 120_000): Promise<PcResponse> {
    if (!this.open) return Promise.reject(new PcOfflineError("That PC is offline."));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PcOfflineError("That PC did not answer in time."));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({
        t: "req",
        id,
        method: req.method,
        url: req.url,
        headers: req.headers,
        ...(req.body?.length ? { body: req.body.toString("base64") } : {}),
      });
    });
  }

  /** Connects a browser's WebSocket to one on the PC (the War Room's live connection, terminals). */
  stream(browser: WebSocket, url: string, headers: Record<string, string>) {
    const sid = this.next++;
    this.streams.set(sid, browser);
    this.send({ t: "ws-open", sid, url, headers });
    browser.on("message", (raw, isBinary) => {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      this.send(
        isBinary
          ? { t: "ws-data", sid, d: buf.toString("base64"), bin: true }
          : { t: "ws-data", sid, d: buf.toString("utf8") },
      );
    });
    browser.on("close", () => {
      if (this.streams.delete(sid)) this.send({ t: "ws-close", sid });
    });
  }

  close() {
    this.ws.close();
  }
}

export interface PcView {
  id: string;
  name: string;
  os: string;
  version: string;
  icon: string | null;
  /** The color its name is shown in. */
  color: string | null;
  online: boolean;
  joinedAt: string;
  lastSeenAt: string | null;
  /** Whether Hearth can uninstall itself there (installed by the one-command installer). */
  canUninstall: boolean;
}

const ICON_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

export class Pcs {
  private readonly links = new Map<string, PcLink>();
  /** Told when a PC comes online or goes offline, or the list changes. */
  onChange?: () => void;
  /** Told each time a PC connects (it said hello), to bring it up to date. */
  onHello?: (pcId: string) => void;

  constructor(
    private readonly handle: DbHandle,
    private readonly auth: Auth,
    private readonly iconDir: string,
  ) {}

  private get db() {
    return this.handle.db;
  }

  link(id: string): PcLink | undefined {
    const l = this.links.get(id);
    return l?.open ? l : undefined;
  }

  async list(): Promise<PcView[]> {
    const rows = await this.db.select().from(t.pcs);
    return rows
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
      .map((r) => {
        const install = r.install ? (JSON.parse(r.install) as InstallInfo) : null;
        return {
          id: r.id,
          name: r.name,
          os: r.os,
          version: r.version,
          icon: r.icon,
          color: r.color,
          online: Boolean(this.link(r.id)),
          joinedAt: r.joinedAt,
          lastSeenAt: r.lastSeenAt,
          canUninstall: Boolean(install && install.kind !== "manual"),
        };
      });
  }

  async get(id: string) {
    const row = await this.db.select().from(t.pcs).where(eq(t.pcs.id, id)).get();
    if (!row) throw new NotFoundError("No such PC.");
    return row;
  }

  /** A new PC joins with a join link's code. Returns its link token (shown only to it, once). */
  async join(
    code: string,
    info: { name: string; os: string; version: string; install: InstallInfo | null },
    ctx: SignInContext = {},
  ): Promise<{ pcId: string; token: string }> {
    await this.auth.usePairCode(code, "pc", ctx);
    const pcId = randomBytes(5).toString("hex");
    const token = randomToken(32);
    const now = new Date().toISOString();
    await this.db.insert(t.pcs).values({
      id: pcId,
      name: info.name.slice(0, 60) || "New PC",
      tokenHash: sha256(token),
      os: info.os.slice(0, 80),
      version: info.version.slice(0, 40),
      install: info.install ? JSON.stringify(info.install) : null,
      joinedAt: now,
      lastSeenAt: now,
    });
    await recordAudit(this.db, {
      actor: "you",
      action: `Added the PC ${info.name} to this Hearth`,
      target: `pc:${pcId}`,
    });
    this.onChange?.();
    return { pcId, token };
  }

  /** The PC's link token checks out: the PC row, else null. */
  async verify(pcId: string, token: string) {
    const row = await this.db.select().from(t.pcs).where(eq(t.pcs.id, pcId)).get();
    return row && row.tokenHash === sha256(token) ? row : null;
  }

  /** A PC's link opened. */
  attach(pcId: string, ws: WebSocket): PcLink {
    this.links.get(pcId)?.close();
    const link = new PcLink(
      pcId,
      ws,
      (h) => {
        void this.db
          .update(t.pcs)
          .set({
            os: h.os.slice(0, 80),
            version: h.version.slice(0, 40),
            install: h.install ? JSON.stringify(h.install) : null,
            lastSeenAt: new Date().toISOString(),
          })
          .where(eq(t.pcs.id, pcId))
          .then(() => this.onChange?.())
          // Hearth is shutting down (its database already closed): nothing to record.
          .catch(() => undefined);
        this.onHello?.(pcId);
      },
      () => {
        if (this.links.get(pcId) === link) this.links.delete(pcId);
        void this.db
          .update(t.pcs)
          .set({ lastSeenAt: new Date().toISOString() })
          .where(eq(t.pcs.id, pcId))
          .then(() => this.onChange?.())
          // Hearth is shutting down (its database already closed): nothing to record.
          .catch(() => undefined);
      },
    );
    this.links.set(pcId, link);
    this.onChange?.();
    return link;
  }

  async rename(id: string, name: string) {
    await this.get(id);
    await this.db
      .update(t.pcs)
      .set({ name: name.trim().slice(0, 60) })
      .where(eq(t.pcs.id, id));
    this.onChange?.();
  }

  /**
   * Its icon: one of the owner's set (its name then shows in that icon's color), or a picture
   * (stored in the data folder) with a color you choose. Returns what was stored.
   */
  async setIcon(
    id: string,
    icon: { preset: string; color?: string } | { type: string; data: Buffer; color?: string },
  ): Promise<{ icon: string; color: string }> {
    if (id !== "hub") await this.get(id);
    let value: string;
    let color: string;
    if ("preset" in icon) {
      const known = pcIcon(icon.preset);
      if (!known) throw new NotFoundError("No such icon.");
      value = `preset:${known.id}`;
      color = icon.color && isColor(icon.color) ? icon.color : known.color;
    } else {
      const ext = ICON_TYPES[icon.type];
      if (!ext) throw new NotFoundError("Pictures can be PNG, JPEG, WebP or SVG.");
      if (icon.data.length > 512 * 1024)
        throw new NotFoundError("That picture is too big (512 KB).");
      mkdirSync(this.iconDir, { recursive: true });
      for (const e of Object.values(ICON_TYPES)) rmSync(this.iconFile(id, e), { force: true });
      writeFileSync(this.iconFile(id, ext), icon.data);
      value = `image:${ext}:${Date.now()}`;
      color = icon.color && isColor(icon.color) ? icon.color : "#ff9124";
    }
    if (id !== "hub") {
      await this.db.update(t.pcs).set({ icon: value, color }).where(eq(t.pcs.id, id));
      this.onChange?.();
    }
    return { icon: value, color };
  }

  /** A new color for its name (a picture's, or to change an icon's own). */
  async setColor(id: string, color: string) {
    if (!isColor(color)) throw new NotFoundError("Colors look like #ff9124.");
    await this.get(id);
    await this.db.update(t.pcs).set({ color }).where(eq(t.pcs.id, id));
    this.onChange?.();
  }

  iconFile(id: string, ext: string) {
    return path.join(this.iconDir, `${id.replace(/[^a-z0-9-]/g, "")}.${ext}`);
  }

  /** The picture file for an "image:" icon, if there is one. */
  iconPicture(id: string): { file: string; type: string } | null {
    for (const [type, ext] of Object.entries(ICON_TYPES)) {
      const file = this.iconFile(id, ext);
      if (existsSync(file)) return { file, type };
    }
    return null;
  }

  /** Takes a PC out of your Hearth: its link is cut and it forgets your Hearth. */
  async remove(id: string) {
    const row = await this.get(id);
    const link = this.link(id);
    link?.send({ t: "removed" });
    await this.db.delete(t.pcs).where(eq(t.pcs.id, id));
    for (const ext of Object.values(ICON_TYPES)) rmSync(this.iconFile(id, ext), { force: true });
    setTimeout(() => link?.close(), 500);
    await recordAudit(this.db, {
      actor: "you",
      action: `Removed the PC ${row.name} from this Hearth`,
      target: `pc:${id}`,
    });
    this.onChange?.();
  }

  /** Asks a PC to uninstall Hearth from itself; it answers whether it could. */
  async uninstall(id: string, deleteData: boolean): Promise<{ ok: boolean; message: string }> {
    const row = await this.get(id);
    const link = this.link(id);
    if (!link) throw new PcOfflineError(`${row.name} is offline. Turn it on, then try again.`);
    const answer = await new Promise<{ ok: boolean; message: string }>((resolve) => {
      const timer = setTimeout(
        () => resolve({ ok: false, message: `${row.name} did not answer.` }),
        20_000,
      );
      link.onUninstalling = (ok, message) => {
        clearTimeout(timer);
        resolve({ ok, message });
      };
      link.send({ t: "uninstall", deleteData });
    });
    if (answer.ok) {
      await this.db.delete(t.pcs).where(eq(t.pcs.id, id));
      await recordAudit(this.db, {
        actor: "you",
        action: `Uninstalled Hearth from ${row.name}${deleteData ? " and deleted its data" : ""}`,
        target: `pc:${id}`,
      });
      this.onChange?.();
    }
    return answer;
  }

  closeAll() {
    for (const l of this.links.values()) l.close();
  }
}
