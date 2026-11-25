import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { hostname } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { isColor } from "@dragon-control/core";
import { ForbiddenAuthError, type Auth, type Session } from "../auth/service";
import { originOf, SESSION_COOKIE } from "../auth/routes";
import { reachableAddresses } from "./addresses";
import { openToNetwork } from "./network";
import { findHearths, type FoundHearth } from "./discover";
import type { HearthKey } from "./hearth-key";
import { ConflictError } from "../store/errors";
import { PcOfflineError, type Pcs } from "./hub";
import { LINK_HEADER, LINK_SECRET, LINK_VERIFIED_HEADER, MAX_BODY, type InstallInfo } from "./link";
import { osName, type HubMember } from "./member";

/**
 * PCs and devices (docs/design/ONE_ACCOUNT.md): addresses, one-time codes for devices, the PCs
 * in your Hearth (seeing, renaming, removing, uninstalling: free, so an owner whose licence ends
 * can still tidy up), the live link a joined PC keeps, and, on a PC that joins another Hearth,
 * joining. Linking new PCs and working on one through this Hearth are Hearth Connected, in the
 * Premium package (11-14): it gets what it needs from what registerPcs returns.
 */

export interface PcsDeps {
  auth: Auth;
  listen: { host: string; port: number };
  pcs: Pcs;
  member: HubMember;
  version: string;
  iconDir: string;
  /** How this installation was made, and removing it (Uninstall from any device). */
  install: () => InstallInfo | null;
  uninstall: (deleteData: boolean) => Promise<{ ok: boolean; message: string }>;
  /** Run first when your Hearth removes itself (the Crucible's clean exit). */
  beforeUninstall?: () => Promise<{ ok: boolean; lines: string[]; problems: string[] }>;
  /** The Hearth API key in the Secure Vault. */
  hearthKey: Pick<HearthKey, "ensure" | "refresh">;
  /** Finding your Hearth from a new PC (tests replace it). */
  findHearths?: () => Promise<FoundHearth[]>;
  /** Hearth's own backup, made before a set-up PC joins another Hearth. */
  backup?: () => Promise<{ ok: boolean; detail: string }>;
  /** Open to my home network (tests replace it). */
  openNetwork?: () => { ok: boolean; message: string };
  /** A joining PC scans itself, and adds what it found, before it joins (the Discover page's own). */
  scanHere?: () => Promise<unknown>;
  addHere?: (body: unknown) => Promise<{ services: number }>;
}

/**
 * What Hearth Connected (the Premium package) uses: the PC store and its live links, this Hearth's
 * look and addresses, sign-in checks, and the one socket server (one copy of the socket library).
 */
export interface ConnectedKit {
  pcs: Pcs;
  member: HubMember;
  addresses: (request: FastifyRequest) => ReturnType<typeof reachableAddresses>;
  hubLook: () => { icon: string | null; color: string | null; name: string };
  newPairCode: Auth["newPairCode"];
  linkWithKey: Auth["linkWithKey"];
  /** Throws "confirm it's you" unless the owner confirmed recently. */
  fresh: (session: Session, what: string) => void;
  /** The signed-in session behind a socket's request, if any. */
  socketSession: (req: http.IncomingMessage) => Promise<Session | null>;
  /** Accepts a socket on Hearth's own socket server. */
  acceptSocket: (
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    then: (ws: import("ws").WebSocket) => void,
  ) => void;
  refuse: (socket: Duplex, code: number, text: string) => void;
  offline: (message: string) => Error;
  /** The core's "not allowed" refusal (403), as its own routes use. */
  forbidden: (message: string) => Error;
  /** The address a request came in on (scheme and host), as the core works it out. */
  origin: (request: FastifyRequest) => string;
  linkVerifiedHeader: string;
  maxBody: number;
}

export function registerPcs(app: FastifyInstance, deps: PcsDeps): ConnectedKit {
  const { auth, pcs, member } = deps;
  const owner = (request: FastifyRequest) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return request.session;
  };
  const fresh = (session: Session, what: string) => {
    if (!auth.recentlyVerified(session))
      throw new ForbiddenAuthError(`Confirm it's you first, then ${what}.`);
  };
  const addresses = (request: FastifyRequest) =>
    reachableAddresses(deps.listen, originOf(request).origin);
  // Your Hearth's own icon, name and color (it is not in the PC list).
  const hubFile = path.join(deps.iconDir, "hub.json");
  const hubLook = (): { icon: string | null; color: string | null; name: string } => {
    try {
      const j = JSON.parse(readFileSync(hubFile, "utf8")) as Record<string, string>;
      return { icon: j.icon ?? null, color: j.color ?? null, name: j.name || hostname() };
    } catch {
      return { icon: null, color: null, name: hostname() };
    }
  };
  const saveHub = (patch: Partial<{ icon: string; color: string; name: string }>) => {
    mkdirSync(deps.iconDir, { recursive: true });
    writeFileSync(hubFile, JSON.stringify({ ...hubLook(), ...patch }));
  };

  app.get("/api/devices/addresses", async (request) => {
    owner(request);
    return addresses(request);
  });

  // Open to my home network: so your other PCs and devices can reach this Hearth. Needs a fresh
  // "it's you"; Hearth restarts a few seconds later.
  app.post("/api/devices/open-network", async (request) => {
    const session = owner(request);
    fresh(session, "open Hearth to your home network");
    return (deps.openNetwork ?? (() => openToNetwork(deps.install())))();
  });

  // A code that signs one device in (the QR in Add a device). Needs a fresh "it's you".
  app.post("/api/devices/codes", async (request) => {
    const session = owner(request);
    const { purpose } = z
      .object({ purpose: z.enum(["device", "home"]) })
      .strict()
      .parse(request.body ?? {});
    fresh(session, purpose === "home" ? "pair a home tablet" : "add the device");
    const { code, expiresAt } = await auth.newPairCode(purpose);
    return { code, expiresAt, ...addresses(request) };
  });

  /* ---------- Your Hearth: its PCs ---------- */

  app.get("/api/pcs", async (request) => {
    owner(request);
    return {
      hub: {
        id: "hub",
        os: osName(),
        version: deps.version,
        canUninstall: Boolean(deps.install()),
        ...hubLook(),
      },
      pcs: await pcs.list(),
      joinedTo: await member.status(),
    };
  });

  // A new PC joins with its link's code (no session: the code is the permission).
  // A new PC's installer checks it reached a Hearth it can link to.
  app.get("/api/pcs/hello", async () => ({
    app: "Hearth",
    name: hubLook().name,
    linkable: (await auth.claimed()) && !(await member.joined()),
  }));

  /* ---------- Linking this PC to the Hearth you already have ---------- */
  // In a new PC's setup, with its setup code (shown where it was installed). On a PC that is set
  // up already (installed on its own first), its owner, signed in and just confirmed: its
  // account, projects, systems, memory and vault stay; your Hearth is where it is used from then.
  const setupOrOwner = async (
    request: FastifyRequest,
    setupCode: string,
  ): Promise<"setup" | "owner"> => {
    const expected = await auth.setupCode();
    if (expected) {
      if (setupCode.trim().toUpperCase() !== expected)
        throw new ForbiddenAuthError(
          "That setup code is not right. It is shown where Hearth was installed.",
        );
      return "setup";
    }
    const session = owner(request);
    if (session.method === "home")
      throw new ForbiddenAuthError("This is a home tablet: join from Hearth itself.");
    fresh(session, "join another Hearth");
    if (await member.joined()) throw new ConflictError("This PC already belongs to a Hearth.");
    if ((await pcs.list()).length)
      throw new ConflictError(
        "Other PCs are linked to this Hearth, so it can't join another one. Remove them first (PCs and devices), or join them to the other Hearth instead.",
      );
    return "owner";
  };

  // Finds your Hearth: on this PC's home network and your Tailscale.
  app.post("/api/pcs/find", async (request) => {
    const body = z
      .object({ setupCode: z.string().max(20).optional() })
      .strict()
      .parse(request.body);
    await setupOrOwner(request, body.setupCode ?? "");
    const found = await (deps.findHearths ?? findHearths)();
    return { thisPc: hostname(), found };
  });

  // Before a new PC joins (11-24, the owner: "it's still going to scan Jon's PC too"): it scans
  // itself, and adds the apps you keep, so they come with it into your Hearth.
  app.post("/api/pcs/setup-scan", async (request) => {
    const body = z
      .object({ setupCode: z.string().max(20).optional() })
      .strict()
      .parse(request.body);
    await setupOrOwner(request, body.setupCode ?? "");
    if (!deps.scanHere) throw new ConflictError("This Hearth can't scan itself here.");
    return deps.scanHere();
  });
  app.post("/api/pcs/setup-add", async (request) => {
    const body = z
      .object({
        setupCode: z.string().max(20).optional(),
        reportId: z.string(),
        selections: z
          .array(z.object({ key: z.string(), name: z.string().max(60) }).strict())
          .max(500),
      })
      .strict()
      .parse(request.body);
    await setupOrOwner(request, body.setupCode ?? "");
    if (!deps.addHere) throw new ConflictError("This Hearth can't add apps here.");
    return deps.addHere({ reportId: body.reportId, selections: body.selections });
  });

  // The Hearth API key, sent to the Hearth you picked (or typed): a join link if it is right.
  app.post("/api/pcs/link-start", async (request) => {
    const body = z
      .object({
        setupCode: z.string().max(20).optional(),
        hubUrl: z.string().min(4).max(300),
        key: z.string().min(10).max(200),
      })
      .strict()
      .parse(request.body);
    await setupOrOwner(request, body.setupCode ?? "");
    let hub = body.hubUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(hub)) hub = `http://${hub}${/:\d+$/.test(hub) ? "" : ":7600"}`;
    let res: Response;
    try {
      res = await fetch(`${hub}/api/pcs/link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: body.key.trim() }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ConflictError(
        `This PC can't reach a Hearth at ${hub}. Check the address, and that this PC is on the same network (or Tailscale).`,
      );
    }
    const j = (await res.json().catch(() => ({}))) as {
      joinLink?: string;
      hubName?: string;
      taken?: { name: string; icon: string }[];
      message?: string;
    };
    if (!res.ok || !j.joinLink)
      throw new ConflictError(j.message ?? `That Hearth said no (${res.status}).`);
    return { joinLink: j.joinLink, hubName: j.hubName ?? "your Hearth", taken: j.taken ?? [] };
  });

  app.patch<{ Params: { id: string } }>("/api/pcs/:id", async (request, reply) => {
    owner(request);
    const body = z
      .object({
        name: z.string().trim().min(1).max(60).optional(),
        icon: z.string().max(30).optional(),
        color: z.string().max(7).optional(),
      })
      .strict()
      .parse(request.body ?? {});
    const id = request.params.id;
    if (body.name) {
      if (id === "hub") saveHub({ name: body.name });
      else await pcs.rename(id, body.name);
    }
    if (body.icon) {
      // One icon per PC: never two with the same one.
      const owners = [
        { id: "hub", name: hubLook().name, icon: hubLook().icon },
        ...(await pcs.list()),
      ];
      const taken = owners.find((o) => o.id !== id && o.icon === `preset:${body.icon}`);
      if (taken)
        throw new ConflictError(`${taken.name} already uses that icon. Pick one that's free.`);
      const v = await pcs.setIcon(id, {
        preset: body.icon,
        ...(body.color ? { color: body.color } : {}),
      });
      if (id === "hub") saveHub(v);
    } else if (body.color) {
      if (id === "hub") {
        if (!isColor(body.color)) throw new ForbiddenAuthError("Colors look like #ff9124.");
        saveHub({ color: body.color });
      } else await pcs.setColor(id, body.color);
    }
    return reply.code(204).send();
  });

  // A picture as its icon: { type, data (base64) }, small.
  app.put<{ Params: { id: string } }>(
    "/api/pcs/:id/icon",
    { bodyLimit: 1024 * 1024 },
    async (request, reply) => {
      owner(request);
      const body = z
        .object({
          type: z.string().max(40),
          data: z.string().max(700_000),
          color: z.string().max(7).optional(),
        })
        .strict()
        .parse(request.body);
      const v = await pcs.setIcon(request.params.id, {
        type: body.type,
        data: Buffer.from(body.data, "base64"),
        ...(body.color ? { color: body.color } : {}),
      });
      if (request.params.id === "hub") saveHub(v);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>("/api/pcs/:id/icon", async (request, reply) => {
    owner(request);
    const pic = pcs.iconPicture(request.params.id);
    if (!pic) return reply.code(404).send({ message: "No picture." });
    reply.header("content-type", pic.type);
    reply.header("cache-control", "private, max-age=31536000, immutable");
    reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
    return reply.send(createReadStream(pic.file));
  });

  app.delete<{ Params: { id: string } }>("/api/pcs/:id", async (request, reply) => {
    fresh(owner(request), "remove the PC");
    await pcs.remove(request.params.id);
    return reply.code(204).send();
  });

  // Uninstall Hearth from a PC. Typing its name is the confirmation.
  app.post<{ Params: { id: string } }>("/api/pcs/:id/uninstall", async (request) => {
    fresh(owner(request), "uninstall Hearth");
    const body = z
      .object({
        confirmName: z.string().max(80),
        deleteData: z.boolean(),
        /** Remove it even though the Crucible's clean exit didn't finish (warned in the dialog). */
        leaveWaiting: z.boolean().optional(),
      })
      .strict()
      .parse(request.body);
    const id = request.params.id;
    const name = id === "hub" ? hubLook().name : (await pcs.get(id)).name;
    if (body.confirmName.trim().toLowerCase() !== name.toLowerCase())
      throw new ForbiddenAuthError(`Type the PC's name, ${name}, to confirm.`);
    if (id !== "hub") return pcs.uninstall(id, body.deleteData);
    // Your Hearth itself: every PC is let go first (each goes back to its own setup page).
    if (!deps.install())
      return {
        ok: false,
        message:
          "Hearth was installed on this PC by hand, so it can't remove itself. Run its installer here with --uninstall.",
      };
    // The Crucible's clean exit first: Seerr searches by itself again, and every request waiting
    // for the Crucible gets its profile and is searched. If that can't finish, nothing is removed
    // unless the owner says to remove it anyway.
    const exit = deps.beforeUninstall ? await deps.beforeUninstall() : undefined;
    if (exit && !exit.ok && !body.leaveWaiting)
      return {
        ok: false,
        needsChoice: "leave-waiting",
        message: `Hearth was not removed. The Crucible couldn't finish handing requests back: ${exit.problems.join(" ")} Fix that and try again, or remove Hearth anyway: those requests then stay on "Hearth · Waiting for the Crucible" in Radarr, where nothing is ever downloaded for them, until you change their profile in Radarr (and turn Seerr's "Enable Automatic Search" back on).`,
      };
    for (const pc of await pcs.list()) await pcs.remove(pc.id);
    const done = await deps.uninstall(body.deleteData);
    return exit?.lines.length
      ? { ...done, message: `${exit.lines.join(" ")} ${done.message}` }
      : done;
  });

  /* ---------- A PC that joined another Hearth ---------- */

  // Join from the setup page: the join link, and this PC's setup code (proof you are at it).
  app.post("/api/pcs/join-hub", async (request) => {
    const body = z
      .object({
        link: z.string().min(10).max(500),
        setupCode: z.string().max(20).optional(),
        name: z.string().max(60).optional(),
        icon: z.string().max(30).optional(),
      })
      .strict()
      .parse(request.body);
    const how = await setupOrOwner(request, body.setupCode ?? "");
    if (how === "owner" && deps.backup) {
      // Everything on this PC is kept; a backup first all the same.
      const b = await deps.backup();
      if (!b.ok)
        throw new ConflictError(
          `Hearth's backup before joining didn't work (${b.detail}), so it didn't join. Try again.`,
        );
    }
    return member.join(body.link, {
      name: body.name,
      icon: body.icon,
      ...(how === "owner" ? { keepAccount: true } : {}),
    });
  });

  /* ---------- The Hearth API key, in the Secure Vault ---------- */

  // Which vault entry it is (made when missing), for its fixed place at the top of the vault.
  app.get("/api/vault/hearth-key", async (request) => {
    owner(request);
    return { id: await deps.hearthKey.ensure() };
  });
  // Refresh: a new key. PCs already linked stay linked. Needs a fresh "it's you".
  app.post("/api/vault/hearth-key/refresh", async (request) => {
    const session = owner(request);
    fresh(session, "make a new Hearth API key");
    return { id: await deps.hearthKey.refresh() };
  });

  /* ---------- WebSockets: a joined PC's live link (a browser's socket to a PC is Premium's) ---------- */

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY });
  const refuse = (socket: Duplex, code: number, text: string) =>
    socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () =>
      socket.destroy(),
    );
  app.server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url ?? "";
    const pathOnly = url.split("?")[0]!;
    if (pathOnly === "/api/link") {
      void (async () => {
        const token = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
        const pcId = String(req.headers["x-hearth-pc"] ?? "");
        const row = token && pcId ? await pcs.verify(pcId, token).catch(() => null) : null;
        if (!row) return refuse(socket, 401, "Unauthorized");
        wss.handleUpgrade(req, socket, head, (ws) => pcs.attach(row.id, ws));
      })();
      return;
    }
  });

  app.addHook("onReady", async () => {
    await member.start();
  });
  app.addHook("onClose", async () => {
    member.stop();
    pcs.closeAll();
    wss.close();
  });
  return {
    pcs,
    member,
    addresses,
    hubLook,
    newPairCode: (...a) => auth.newPairCode(...a),
    linkWithKey: (...a) => auth.linkWithKey(...a),
    fresh,
    socketSession: (req) => auth.session(cookieValue(req.headers.cookie)).catch(() => null),
    acceptSocket: (req, socket, head, then) => wss.handleUpgrade(req, socket, head, then),
    refuse,
    offline: (message) => new PcOfflineError(message),
    forbidden: (message) => new ForbiddenAuthError(message),
    origin: (request) => originOf(request).origin,
    linkVerifiedHeader: LINK_VERIFIED_HEADER,
    maxBody: MAX_BODY,
  };
}

function cookieValue(header: string | undefined): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** Whether a request came over this PC's link (set only inside the process). */
export const viaLink = (headers: http.IncomingHttpHeaders) => headers[LINK_HEADER] === LINK_SECRET;
