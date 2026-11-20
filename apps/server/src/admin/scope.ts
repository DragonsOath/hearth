import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Blocker, GapKind, HostOperation, HostScope, PathClass } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { ContainerTools } from "../actions/tools";
import { recordAudit } from "../store/audit";
import { NotFoundError } from "../store/errors";

/**
 * The host scope (feature request 21, design docs/design/HOST_ADMINISTRATION.md): you switch
 * "Administer this host" on for a machine Hearth runs on. Inside it, every path is
 * ordinary, protected, or secret. The rules are in this file plus an optional root-owned
 * /etc/dragon-control/protected.json, which can only add to them; no AI tool or setting edits either.
 */

type ServiceRow = typeof t.services.$inferSelect;

/** Host administration, offered where it is needed: always described as the host-wide permission it is. */
export function hostAdminBlocker(
  host: { id: string; name: string },
  op: HostOperation,
  investigateOnly: boolean,
): Blocker {
  return {
    kind: "host-admin",
    host: { id: host.id, name: host.name },
    operations: op === "propose" ? ["investigate", "propose"] : ["investigate"],
    title: investigateOnly
      ? `Ember may look at ${host.name} but not propose changes to it.`
      : `Administering ${host.name} is switched off.`,
    detail:
      op === "propose"
        ? `This is a permission for the whole of ${host.name}, not only this app: Ember may read its configuration files and containers and propose changes to them. Every change still waits for your approval, and protected systems ask you to confirm it is you again.`
        : `This is a permission for the whole of ${host.name}, not only this app: Ember may read its configuration files and containers (never secrets). It changes nothing.`,
  };
}

/** A precise reason something cannot be done, for the Ember to say and ask for the right thing. */
export class GapError extends Error {
  constructor(
    message: string,
    readonly gap: GapKind,
    /** What the owner can do about it, offered in the panel where it happened (BLOCKERS.md). */
    readonly blocker?: Blocker,
  ) {
    super(message);
  }

  /** For the web routes: refused rather than failed. */
  get statusCode() {
    return this.gap === "temporary" ? 503 : this.gap === "unsupported" ? 400 : 403;
  }
}

/** Names of systems whose changes always need your separate approval (read for diagnosis is fine). */
const PROTECTED_NAME =
  /^(caddy|gluetun|tailscale|tailscaled|wireguard|wg-easy|openvpn|vpn|crowdsec|authelia|authentik|cloudflared|traefik|nginx-proxy-manager|npm|pihole|pi-hole|adguard|adguardhome|headscale|ufw|nftables|fail2ban|firewalld|docker-socket-proxy|socket-proxy|dragon-control|dragoncontrol)$/i;

/** Lines of a Compose file that change networking or host access: a change there is protected. */
export const COMPOSE_PROTECTED_KEYS =
  /^\s*-?\s*(network_mode|networks|ports|expose|privileged|cap_add|cap_drop|devices|extra_hosts|dns|dns_search|sysctls|security_opt|userns_mode|pid|ipc|volumes_from)\s*:/m;

const SECRET_BASENAME =
  /^(id_(rsa|dsa|ecdsa|ed25519)(_sk)?|.*\.(pem|key|p12|pfx|kdbx|keystore|jks)|\.netrc|\.pgpass|\.git-credentials|\.npmrc|\.pypirc|shadow-?|gshadow-?|ssh_host_.*_key|.*\.secret|secrets?\.(ya?ml|json|env)|\.credentials\.json)$/i;

const SECRET_COMPONENT = /^(\.gnupg|\.password-store|\.docker|secrets|\.ssh)$/i;
/** Public parts of SSH folders: protected (access control), not secret. */
const SSH_PUBLIC = /^(.*\.pub|known_hosts(\.old)?|authorized_keys2?|config)$/i;

interface ExtraRules {
  protected: string[];
  secret: string[];
  containers: string[];
}

const EXTRA_FILE = "/etc/dragon-control/protected.json";

function loadExtra(): ExtraRules {
  try {
    const v = JSON.parse(readFileSync(EXTRA_FILE, "utf8")) as Partial<ExtraRules>;
    const list = (x: unknown) =>
      Array.isArray(x) ? x.filter((p): p is string => typeof p === "string") : [];
    return { protected: list(v.protected), secret: list(v.secret), containers: list(v.containers) };
  } catch {
    return { protected: [], secret: [], containers: [] };
  }
}

const under = (p: string, root: string) =>
  p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

export interface ScopeRules {
  /** Hearth's own data and key folders: secret (the vault and database live there). */
  secretRoots: string[];
  /** Hearth's own code: protected. */
  protectedRoots: string[];
}

/** Ordinary, protected, or secret, with the reason in plain words. Pure: same answer for the same path. */
export function classify(
  p: string,
  rules: ScopeRules,
  extra: ExtraRules = loadExtra(),
): { class: PathClass; why?: string } {
  const abs = path.posix.normalize(p.replaceAll("\\", "/"));
  const parts = abs.split("/").filter(Boolean);
  const base = parts.at(-1) ?? "";
  for (const r of [...rules.secretRoots, ...extra.secret])
    if (under(abs, r)) return { class: "secret", why: "Hearth's own secrets, database, or keys" };
  if (under(abs, "/dev")) return { class: "secret", why: "devices (raw disks and terminals)" };
  if (/^\/proc\/[^/]+\/(environ|mem|auxv)$/.test(abs) || under(abs, "/proc/kcore"))
    return { class: "secret", why: "a process's environment or memory" };
  if (under(abs, "/var/lib/tailscale")) return { class: "secret", why: "Tailscale's node keys" };
  if (under(abs, "/etc/hearth") || under(abs, "/var/lib/hearth-elevated"))
    return { class: "secret", why: "the elevated executor's key and state" };
  if (SECRET_BASENAME.test(base))
    return { class: "secret", why: "a private key, password store, or credential file" };
  const comp = parts.slice(0, -1).find((c) => SECRET_COMPONENT.test(c));
  if (comp) {
    if (comp.toLowerCase() === ".ssh" && SSH_PUBLIC.test(base))
      return { class: "protected", why: "SSH access control" };
    return { class: "secret", why: `inside ${comp}` };
  }
  if (SECRET_COMPONENT.test(base) && base.toLowerCase() !== ".ssh")
    return { class: "secret", why: `${base} folder` };
  for (const r of [...rules.protectedRoots, ...extra.protected])
    if (under(abs, r)) return { class: "protected", why: "Hearth itself or a listed system" };
  for (const [root, why] of [
    ["/etc", "system configuration (users, SSH, sudo, firewall, mounts, services)"],
    ["/boot", "the boot loader and kernel"],
    ["/usr", "system software"],
    ["/bin", "system software"],
    ["/sbin", "system software"],
    ["/lib", "system software"],
    ["/lib64", "system software"],
    ["/var/lib/docker", "Docker's own storage"],
    ["/proc", "the kernel's view of processes"],
    ["/sys", "the kernel's view of hardware"],
    ["/root", "the root account"],
  ] as const)
    if (under(abs, root)) return { class: "protected", why };
  const named = parts.find((c) => PROTECTED_NAME.test(c));
  if (named) return { class: "protected", why: `${named} (networking, access, or Hearth)` };
  return { class: "ordinary" };
}

export function isProtectedContainer(name: string, image = "", extra = loadExtra()): boolean {
  const n = name.replace(/^\//, "");
  if (extra.containers.includes(n)) return true;
  const img = image.split("/").at(-1)?.split(":")[0] ?? "";
  return PROTECTED_NAME.test(n) || PROTECTED_NAME.test(img);
}

export const containerOf = (s: Pick<ServiceRow, "checkTarget">) =>
  s.checkTarget?.startsWith("container:") ? s.checkTarget.slice("container:".length) : undefined;

/** The folder name a service's backups go under (the container name, as the home server's ledger does). */
export const backupKey = (s: Pick<ServiceRow, "checkTarget" | "name">) =>
  (containerOf(s) ?? s.name)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "service";

/** Known configuration files per app, as the container sees them (hints, not limits). */
const KNOWN_FILES: { image: RegExp; files: { path: string; purpose: string }[] }[] = [
  {
    image: /recyclarr/i,
    files: [
      {
        path: "/config/recyclarr.yml",
        purpose:
          "Which quality profiles and custom formats Recyclarr syncs into Radarr and Sonarr.",
      },
      { path: "/config/settings.yml", purpose: "Recyclarr's own settings." },
    ],
  },
  {
    image: /kometa|plex-meta-manager/i,
    files: [{ path: "/config/config.yml", purpose: "Kometa's libraries, collections, overlays." }],
  },
  {
    image: /radarr|sonarr|lidarr|prowlarr|readarr/i,
    files: [
      { path: "/config/config.xml", purpose: "Port, URL base, authentication, API key (masked)." },
    ],
  },
  {
    image: /sabnzbd/i,
    files: [
      { path: "/config/sabnzbd.ini", purpose: "Folders, servers, categories (passwords masked)." },
    ],
  },
];

export const isRecyclarr = (s: Pick<ServiceRow, "image" | "name">) =>
  /recyclarr/i.test(s.image ?? "") || /recyclarr/i.test(s.name);

const scopeInput = z
  .object({
    hostId: z.string().min(1).max(200),
    operations: z
      .array(z.enum(["investigate", "propose"]))
      .min(1)
      .max(2),
    note: z.string().max(300).optional(),
  })
  .strict();

export class HostScopes {
  readonly rules: ScopeRules;

  constructor(
    private readonly handle: DbHandle,
    private readonly containers: ContainerTools,
    rules: Partial<ScopeRules> = {},
  ) {
    this.rules = {
      secretRoots: (rules.secretRoots ?? []).map((r) =>
        path.posix.normalize(r.replaceAll("\\", "/")),
      ),
      protectedRoots: (rules.protectedRoots ?? []).map((r) =>
        path.posix.normalize(r.replaceAll("\\", "/")),
      ),
    };
  }

  private get db() {
    return this.handle.db;
  }

  classify(p: string) {
    return classify(p, this.rules);
  }

  /** The machine Hearth runs on (the only one whose files it handles). */
  async localHost() {
    return this.db.select().from(t.hosts).where(eq(t.hosts.connection, "this-machine")).get();
  }

  async list(opts: { all?: boolean } = {}): Promise<HostScope[]> {
    const rows = await this.db
      .select()
      .from(t.hostScopes)
      .where(opts.all ? undefined : isNull(t.hostScopes.revokedAt));
    const hosts = await this.db.select().from(t.hosts);
    return rows.map((r) => ({
      id: r.id,
      hostId: r.hostId,
      hostName: hosts.find((h) => h.id === r.hostId)?.name,
      operations: r.operations as HostOperation[],
      ...(r.note ? { note: r.note } : {}),
      createdAt: r.createdAt,
      ...(r.revokedAt ? { revokedAt: r.revokedAt } : {}),
    }));
  }

  /** You switch it on (Settings, session only). A new grant replaces the old one for that host. */
  async enable(input: unknown): Promise<HostScope> {
    const g = scopeInput.parse(input);
    const host = await this.db.select().from(t.hosts).where(eq(t.hosts.id, g.hostId)).get();
    if (!host) throw new NotFoundError(`No host "${g.hostId}".`);
    if (host.connection !== "this-machine")
      throw new GapError(
        `${host.name} is not the machine Hearth runs on; it can only administer its own machine.`,
        "unsupported",
      );
    const ops: HostOperation[] = g.operations.includes("propose")
      ? ["investigate", "propose"]
      : ["investigate"];
    const now = new Date().toISOString();
    await this.db
      .update(t.hostScopes)
      .set({ revokedAt: now })
      .where(and(eq(t.hostScopes.hostId, host.id), isNull(t.hostScopes.revokedAt)));
    const row = {
      id: randomUUID(),
      hostId: host.id,
      operations: ops,
      note: g.note ?? null,
      createdAt: now,
      revokedAt: null,
    };
    await this.db.insert(t.hostScopes).values(row);
    await recordAudit(this.db, {
      actor: "you",
      action: `Allowed Ember to administer ${host.name}: ${ops.includes("propose") ? "investigate and propose changes" : "investigate (read only)"}`,
      target: `host:${host.id}`,
    });
    return { ...row, hostName: host.name, operations: ops, note: g.note, revokedAt: undefined };
  }

  async revoke(id: string): Promise<void> {
    const r = await this.db.select().from(t.hostScopes).where(eq(t.hostScopes.id, id)).get();
    if (!r) throw new NotFoundError("No such permission.");
    if (r.revokedAt) return;
    await this.db
      .update(t.hostScopes)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(t.hostScopes.id, id));
    await recordAudit(this.db, {
      actor: "you",
      action: "Withdrew Ember's administration of this host",
      target: `host:${r.hostId}`,
    });
  }

  /** The local host, if you allowed this operation on it; otherwise a precise reason. */
  async require(op: HostOperation) {
    const host = await this.localHost();
    if (!host)
      throw new GapError(
        "Hearth does not know the machine it runs on yet (no host connected as this machine).",
        "unsupported",
      );
    const scope = (await this.list()).find((s) => s.hostId === host.id);
    if (!scope)
      throw new GapError(
        `Administering ${host.name} is switched off. The owner can switch it on in Settings > Ember > Administration.`,
        "missing-permission",
        hostAdminBlocker(host, op, false),
      );
    if (!scope.operations.includes(op))
      throw new GapError(
        `On ${host.name} the Ember may investigate but not propose changes. The owner can allow proposals in Settings > Ember > Administration.`,
        "missing-permission",
        hostAdminBlocker(host, op, true),
      );
    return host;
  }

  /** Why an operation is not allowed on this machine yet, as a blocker; undefined when it is. */
  async blocker(op: HostOperation): Promise<Blocker | undefined> {
    try {
      await this.require(op);
      return undefined;
    } catch (error) {
      if (error instanceof GapError && error.blocker) return error.blocker;
      throw error;
    }
  }

  /**
   * A path the Ember may plan a change to: inside the scope, absolute, never secret. Protected
   * paths only when the caller allows them (a protected change: approving it asks you to
   * confirm it is you); the answer says which it is.
   */
  async requireChangeable(p: string, opts: { allowProtected?: boolean } = {}) {
    const host = await this.require("propose");
    if (!path.posix.isAbsolute(p.replaceAll("\\", "/")) && !path.isAbsolute(p))
      throw new GapError("Give the full path of the file.", "unsupported");
    const c = this.classify(p);
    if (c.class === "secret")
      throw new GapError(
        `${p} holds secret content (${c.why}); the Ember never reads or changes it.`,
        "secret",
      );
    if (c.class === "protected" && opts.allowProtected)
      return { host, protected: c.why ?? "protected" };
    if (c.class === "protected")
      throw new GapError(
        `${p} is protected (${c.why}). Ember can read it for diagnosis; changing it is a protected change: plan it as a step the owner approves (approving asks them to confirm it is them).`,
        "protected",
      );
    return { host, protected: undefined as string | undefined };
  }

  async service(serviceId: string): Promise<ServiceRow> {
    const s = await this.db.select().from(t.services).where(eq(t.services.id, serviceId)).get();
    if (!s) throw new NotFoundError(`No service "${serviceId}".`);
    return s;
  }

  /** A service's container mounts (host folder to container folder) and its known config files. */
  async discover(serviceId: string) {
    await this.require("investigate");
    const s = await this.service(serviceId);
    const name = containerOf(s);
    if (!name)
      return {
        service: s.name,
        note: `${s.name} has no container Hearth knows; look at its files with host_list instead.`,
        mounts: [],
        knownFiles: [],
      };
    const mounts = await this.containers.mounts(name).catch(() => []);
    const known = KNOWN_FILES.find((k) => k.image.test(s.image ?? "") || k.image.test(s.name));
    const knownFiles = [];
    for (const f of known?.files ?? []) {
      const m = mounts
        .filter(
          (x) =>
            f.path === x.destination || f.path.startsWith(`${x.destination.replace(/\/$/, "")}/`),
        )
        .sort((a, b) => b.destination.length - a.destination.length)[0];
      if (!m) continue;
      const hostPath = path.posix.join(m.source, path.posix.relative(m.destination, f.path));
      const st = await fs.stat(hostPath).catch(() => undefined);
      knownFiles.push({
        containerPath: f.path,
        hostPath,
        purpose: f.purpose,
        exists: Boolean(st?.isFile()),
        class: this.classify(hostPath).class,
      });
    }
    return {
      service: s.name,
      container: name,
      protected: isProtectedContainer(name, s.image ?? ""),
      mounts: mounts.map((m) => ({
        hostPath: m.source,
        containerPath: m.destination,
        class: this.classify(m.source).class,
      })),
      knownFiles,
    };
  }
}
