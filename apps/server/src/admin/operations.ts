import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { eq } from "drizzle-orm";
import {
  ACTIONS,
  COMPOSE_ACTIONS,
  type Blocker,
  type ConfigEdit,
  type JobStepInput,
  type Requester,
  type StepChange,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { ActionRunner } from "../actions/service";
import type { ContainerTools } from "../actions/tools";
import type { Memory } from "../memory/service";
import { recordAudit } from "../store/audit";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { redactLine } from "../actions/redact";
import {
  caddyAddress,
  parseCaddyConfig,
  probeLocal,
  probeThroughCaddy,
  readCaddyConfig,
  siteEdits,
  type SiteChange,
} from "./caddy-panel";
import { ComposeOperations, composeRoot } from "./compose-ops";
import type { Elevation } from "./elevation";
import {
  applyEdits,
  backupFile,
  type BackupManifest,
  EditError,
  findBackup,
  formatOf,
  maskSecrets,
  readBackup,
  readTarget,
  sha256,
  writeAtomic,
} from "./files";
import {
  backupKey,
  COMPOSE_PROTECTED_KEYS,
  containerOf,
  GapError,
  isRecyclarr,
  type HostScopes,
} from "./scope";
import {
  applyCompose,
  caddyFor,
  caddyReload,
  caddyValid,
  composeFileOf,
  composeServices,
  currentEndpoint,
  exitAddress,
  isComposeFile,
  protonServers,
  switchEdits,
  type ProtectedDeps,
} from "./protected";
import {
  composeJson,
  guardAll,
  homelabRootsFrom,
  newIssues,
  semanticDiff,
  servicesOf,
  type GuardPolicy,
} from "./compose";
import {
  describeSettings,
  type ProfileSetting,
  type Recyclarr,
  type RecyclarrReport,
} from "./recyclarr";
import { clock } from "../findings/analyzers/types";

/**
 * Configuration management as plan steps (feature request 21): edit any ordinary text file inside
 * the host scope, restore it from a backup, or run Recyclarr's sync. Same rules as every other
 * operation:
 *
 * - plan: read the file now, apply the exact edits in memory, show the diff (secrets masked) and,
 *   where the app has a dry run, what it would do with and without the change. The approval
 *   fingerprint covers the file's fingerprint before and after.
 * - run: the host scope must still allow it, the file must be exactly as planned (else nothing is
 *   done), the app's check must still pass; then a backup into the host's backup ledger, an atomic
 *   write that keeps owner and mode, and a read-back of the exact fingerprint.
 * - undo: the file is put back from that backup, only if it is still as this step left it.
 */

class PlanError extends Error {}

const PROTECTED_REASON =
  "Changes a protected system (VPN, Caddy, or networking): it waits for your approval, and approving asks you to confirm it's you. A backup is made first; if it does not come back working, it is put back as it was.";

/** Whether a line of a Compose file sits under a protected key (ports, networks, privileges...). */
export function underProtectedKey(content: string, line: number): boolean {
  const lines = content.split("\n");
  const first = lines[line - 1] ?? "";
  let indent = first.length - first.trimStart().length;
  const isItem = first.trimStart().startsWith("-");
  for (let i = line - 2; i >= 0; i--) {
    const l = lines[i]!;
    if (!l.trim() || l.trimStart().startsWith("#")) continue;
    const ind = l.length - l.trimStart().length;
    const parent = ind < indent || (isItem && ind === indent && !l.trimStart().startsWith("-"));
    if (!parent) continue;
    if (COMPOSE_PROTECTED_KEYS.test(l)) return true;
    indent = ind;
    if (ind === 0) break;
  }
  return false;
}

export class ConfigOperations {
  /** How the Caddy panel checks a site is live (replaced in tests). */
  probes: {
    local: (dial: string) => Promise<boolean>;
    through: (
      caddy: { host: string; port: number },
      site: string,
    ) => Promise<{ ok: boolean; why?: string; certExpires?: string }>;
  } = { local: (d) => probeLocal(d), through: (c, h) => probeThroughCaddy(c, h) };

  constructor(
    private readonly handle: DbHandle,
    private readonly scopes: HostScopes,
    private readonly recyclarr: Recyclarr,
    private readonly containers: ContainerTools,
    private readonly runner: ActionRunner,
    /** The host's backup ledger root (the home server: /srv/homelab/backups). */
    private readonly backupRoot: string,
    private readonly memory?: Memory,
    /** Applying protected changes (Compose, Caddy) and reading the VPN's server list. */
    private readonly protectedDeps?: ProtectedDeps,
    /** The root-owned executor, for changes Hearth's own account cannot (or should not) make. */
    private readonly elevation?: Elevation,
  ) {
    this.compose = new ComposeOperations({
      scopes,
      runner,
      run: (cmd, args, timeoutMs) => this.deps().run(cmd, args, timeoutMs),
      ...(elevation ? { elevation } : {}),
      writer: this,
      guardPolicy: () => this.guardPolicy(),
      ...(protectedDeps?.wait ? { wait: protectedDeps.wait } : {}),
    });
  }

  /** Compose administration steps (update an image, install, remove). */
  readonly compose: ComposeOperations;

  /**
   * How an approved change to `file` will be written. Protected changes go through the elevated
   * executor whenever it is set up and covers the file, so each one has its own independent
   * record; so do files Hearth's own account cannot write. Hearth writes the rest itself. When
   * neither can, the answer says exactly what the owner can set up: a step to take, never a
   * permanent "no".
   */
  async route(file: string, isProtected: boolean): Promise<"direct" | "elevated"> {
    const writable = await Promise.all([
      fs.access(file, fsConstants.W_OK),
      fs.access(path.dirname(file), fsConstants.W_OK),
    ]).then(
      () => true,
      () => false,
    );
    if (!isProtected && writable) return "direct";
    const cover = this.elevation ? await this.elevation.covers("file.write", file) : undefined;
    if (cover?.ok) return "elevated";
    if (writable) return "direct";
    const why =
      cover?.why ??
      "The elevated executor is not set up on this machine (the owner installs it once, with a scope they choose).";
    throw new GapError(
      `Hearth's own account cannot write ${file}. ${why} Once that is done, Ember can make this change with your approval.`,
      cover?.scope ? "out-of-scope" : "missing-permission",
    );
  }

  /** Rows that say who carries the change out, for the plan the owner approves. */
  viaRows(via: "direct" | "elevated"): StepChange["settings"] {
    return via === "elevated"
      ? [
          {
            name: "Carried out by",
            before: "Hearth's own account",
            after:
              "Hearth's elevated executor: only this approved change, with its own backup, check, and log",
          },
        ]
      : [];
  }

  /**
   * Writes the approved content: through the executor (which backs up, writes, and verifies
   * itself) or directly (backup into the ledger, atomic write). Hearth reads the result back
   * either way.
   */
  async put(
    step: StepRun,
    key: string,
    file: string,
    cur: Awaited<ReturnType<typeof readTarget>>,
    next: string,
    reason: string,
  ): Promise<
    { ok: true; backup: string; receipt?: string } | { ok: false; stale?: boolean; result: string }
  > {
    if (step.params?.via === "elevated") {
      if (!this.elevation)
        return { ok: false, result: "The elevated executor is not configured in this Hearth." };
      const r = await this.elevation.perform(
        "file.write",
        {
          path: file,
          key,
          beforeHash: cur.hash,
          afterHash: sha256(next),
          content: Buffer.from(next, "utf8").toString("base64"),
        },
        step,
      );
      if (!r.ok)
        return {
          ok: false,
          stale: r.outcome === "stale",
          result: `The elevated executor did not change ${path.basename(file)}: ${r.result}`,
        };
      return { ok: true, backup: r.backup ?? "none", ...(r.receipt ? { receipt: r.receipt } : {}) };
    }
    const backup = await backupFile(this.backupRoot, key, file, cur.content, {
      reason,
      beforeHash: cur.hash,
      afterHash: sha256(next),
    });
    await writeAtomic(file, next, cur);
    return { ok: true, backup };
  }

  async backupOnly(
    key: string,
    file: string,
    cur: Awaited<ReturnType<typeof readTarget>>,
  ): Promise<string> {
    return backupFile(this.backupRoot, key, file, cur.content, {
      reason: "remove",
      beforeHash: cur.hash,
    });
  }

  /** Puts the file back as it was before `put`, the same way it was written. */
  async putBack(
    step: StepRun,
    w: { receipt?: string },
    file: string,
    cur: Awaited<ReturnType<typeof readTarget>>,
  ): Promise<{ ok: boolean; detail: string }> {
    if (step.params?.via === "elevated") {
      if (!this.elevation || !w.receipt)
        return { ok: false, detail: "The executor gave no receipt to put it back with." };
      const r = await this.elevation.perform("revert", { receipt: w.receipt }, step);
      return { ok: r.ok, detail: r.ok ? "" : r.result };
    }
    await writeAtomic(file, cur.content, await readTarget(file));
    return { ok: true, detail: "" };
  }

  /** The executor's own newest backup of `file` that matches, by its manifest (always readable). */
  private async executorBackup(
    key: string,
    file: string,
    match: (m: BackupManifest) => boolean,
  ): Promise<{ id: string; manifest: BackupManifest } | undefined> {
    const root = (await this.elevation?.state())?.status?.backupRoot;
    if (!root) return undefined;
    const dirs = (await fs.readdir(path.join(root, key)).catch(() => [] as string[]))
      .filter((d) => d.includes("-hearth-elevated-"))
      .sort()
      .reverse();
    for (const d of dirs) {
      const m = JSON.parse(
        await fs.readFile(path.join(root, key, d, "manifest.json"), "utf8").catch(() => "null"),
      ) as BackupManifest | null;
      if (m && m.file === file && match(m)) return { id: `${key}/${d}`, manifest: m };
    }
    return undefined;
  }

  /** A backup of `file` that Hearth or the executor made, newest first. */
  private async anyBackup(
    key: string,
    file: string,
    match: Parameters<typeof findBackup>[3],
  ): ReturnType<typeof findBackup> {
    const own = await findBackup(this.backupRoot, key, file, match);
    if (own) return own;
    const root = (await this.elevation?.state())?.status?.backupRoot;
    return root ? findBackup(root, key, file, match) : undefined;
  }

  private deps(): ProtectedDeps {
    if (!this.protectedDeps)
      throw new PlanError("Protected changes are not available on this machine.");
    return this.protectedDeps;
  }

  private guardPolicy(): GuardPolicy {
    return {
      homelabRoots: homelabRootsFrom(process.env),
      classify: (p) => this.scopes.classify(p),
    };
  }

  /**
   * A change to a Compose file, judged the way it would take effect: Compose must accept the
   * new version, the change is described per service in Compose's own resolved terms, and the
   * mount guard looks at what it newly lets a container reach. Refused things stop the plan;
   * protected ones make it a protected change (the owner confirms it is them).
   */
  private async composeCheck(
    file: string,
    before: string,
    after: string,
  ): Promise<{ rows: StepChange["settings"]; protected: boolean }> {
    const run = this.deps().run;
    const [b, a] = await Promise.all([
      composeJson(run, file, before),
      composeJson(run, file, after),
    ]);
    if (a.error) throw new PlanError(`Compose rejects the changed file: ${a.error}`);
    const policy = this.guardPolicy();
    const sb = b.config ? servicesOf(b.config) : [];
    const sa = servicesOf(a.config!);
    const added = newIssues(guardAll(sb, policy), guardAll(sa, policy));
    const refused = added.filter((i) => i.verdict === "refused");
    if (refused.length)
      throw new PlanError(
        `Refused: ${refused.map((i) => `${i.service} would get ${i.what} (${i.why})`).join("; ")}. Hearth never gives a container that.`,
      );
    const rows: StepChange["settings"] = semanticDiff(sb, sa).map((d) => ({
      name: `${d.service} (as Compose reads it)`,
      before: "As it is now",
      after: d.change,
    }));
    for (const i of added.filter((x) => x.verdict === "protected"))
      rows.push({
        name: `${i.service}: needs your confirmation`,
        before: "Not allowed now",
        after: `${i.what}: ${i.why}`,
      });
    return { rows, protected: added.some((i) => i.verdict === "protected") };
  }

  /** A Compose file as Compose reads it, with the mount guard's view of each service. Read only. */
  async composeInspect(file: string) {
    await this.scopes.require("investigate");
    const cls = this.scopes.classify(file);
    if (cls.class === "secret") throw new GapError(`${file} is ${cls.why}.`, "secret");
    if (!isComposeFile(file)) throw new PlanError(`${file} is not a Compose file.`);
    const r = await composeJson(this.deps().run, file);
    if (r.error) return { file, valid: false, error: r.error };
    const services = servicesOf(r.config!);
    const issues = guardAll(services, this.guardPolicy());
    return {
      file,
      valid: true,
      project: r.config!.name,
      homelabFolders: this.guardPolicy().homelabRoots,
      services: services.map((x) => ({
        ...x,
        guard: issues
          .filter((i) => i.service === x.name)
          .map((i) => `${i.verdict}: ${i.what} (${i.why})`),
      })),
    };
  }

  /**
   * Every Compose project on this machine, its state, and how a change to its file would be
   * carried out (by Hearth's account, by the elevated executor, or what setup it needs). Read only.
   */
  async composeProjects() {
    await this.scopes.require("investigate");
    const run = this.deps().run;
    const ls = await run("docker", ["compose", "ls", "-a", "--format", "json"], 30_000);
    let rows: { Name?: string; Status?: string; ConfigFiles?: string }[] = [];
    try {
      rows = JSON.parse(ls.out || "[]") as typeof rows;
    } catch {
      rows = [];
    }
    const projects = [];
    for (const r of rows) {
      const file = r.ConfigFiles?.split(",")[0]?.trim();
      let change: string;
      if (!file) change = "Docker does not say which file made it.";
      else {
        const cls = this.scopes.classify(file);
        try {
          const via = await this.route(file, cls.class === "protected");
          change =
            via === "elevated"
              ? "Through the elevated executor, with your approval"
              : "By Hearth's own account, with your approval";
        } catch (error) {
          change = error instanceof Error ? error.message : String(error);
        }
        if (cls.class === "protected")
          change += ` (protected: ${cls.why}; approving asks you to confirm it's you)`;
      }
      projects.push({ name: r.Name, status: r.Status, file, change });
    }
    const elevated = this.elevation ? await this.elevation.state() : undefined;
    return {
      composeRoot: (await composeRoot(run)) ?? "unknown (set DC_COMPOSE_ROOT)",
      elevatedExecutor: elevated?.summary ?? "Not configured in this Hearth.",
      projects,
    };
  }

  /** The VPN servers a Gluetun service can switch to, and which one it uses now. */
  async vpnServers(serviceId: string) {
    await this.scopes.require("investigate");
    const s = await this.scopes.service(serviceId);
    const container = containerOf(s);
    if (!container || !/gluetun/i.test(`${s.image ?? ""} ${container}`))
      throw new GapError(`${s.name} is not a Gluetun VPN container.`, "unsupported");
    const d = this.deps();
    const file = await composeFileOf(d.run, container);
    const compose = file ? (await readTarget(file)).content : "";
    const servers = await protonServers(d.exec, container);
    const ip = currentEndpoint(compose);
    return {
      container,
      composeFile: file,
      current: ip ? (servers.find((x) => x.ip === ip) ?? { ip }) : null,
      exitAddress: await exitAddress(d.exec, container),
      servers,
    };
  }

  /**
   * What the Gluetun panel shows: whether the VPN container is up, the server it uses and the
   * internet address it gets, which containers send their traffic through it, and the servers it
   * can switch to (names and places only; their keys stay out). Read only.
   */
  async vpnPanel(serviceId: string) {
    const v = await this.vpnServers(serviceId);
    const d = this.deps();
    const fmt =
      "{{.Id}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.StartedAt}}|{{.RestartCount}}";
    const me = await d.run("docker", ["inspect", "--format", fmt, v.container], 15_000);
    const [id = "", status = "unknown", health = "", startedAt = "", restarts = "0"] = me.out
      .trim()
      .split("|");
    const names = (await d.run("docker", ["ps", "--format", "{{.Names}}"], 15_000)).out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const modes = names.length
      ? (
          await d.run(
            "docker",
            ["inspect", "--format", "{{.Name}}|{{.HostConfig.NetworkMode}}", ...names],
            15_000,
          )
        ).out
      : "";
    const routed = modes
      .split("\n")
      .map((l) => l.trim().replace(/^\//, "").split("|"))
      .filter(([, mode]) => mode === `container:${id}` || mode === `container:${v.container}`)
      .map(([name]) => name!)
      .sort();
    return {
      container: v.container,
      status,
      ...(health ? { health } : {}),
      ...(startedAt && !startedAt.startsWith("0001") ? { since: startedAt } : {}),
      restarts: Number(restarts) || 0,
      current: v.current
        ? {
            ip: v.current.ip,
            ...("name" in v.current
              ? { name: v.current.name, country: v.current.country, city: v.current.city }
              : {}),
          }
        : null,
      exitAddress: v.exitAddress ?? null,
      routed,
      servers: v.servers.map((s) => ({
        name: s.name,
        country: s.country,
        city: s.city,
        portForward: s.portForward,
        streaming: s.streaming,
      })),
    };
  }

  /**
   * What the Caddy panel shows (Observe): every site, where it sends visitors, how they sign in,
   * each certificate's expiry, and recent errors from its log. This needs no host administration
   * when it can be read narrowly: Caddy's running configuration with a plain GET to its admin API
   * from this machine (when Caddy shares the host's network, as it usually does), certificate
   * expiry from the live HTTPS check itself, and errors from Docker's log, as every panel reads
   * them. Only with host administration on does it fall back to reading inside the container.
   * The configuration is reduced to host names and addresses at once (caddy-panel.ts). Manage
   * (the add and edit form) is reported separately, with exactly what still stands in its way.
   */
  async caddyPanel(serviceId: string) {
    const s = await this.scopes.service(serviceId);
    const container = containerOf(s);
    if (!container || !/caddy/i.test(`${s.image ?? ""} ${container}`))
      throw new GapError(`${s.name} is not a Caddy container.`, "unsupported");
    const runtime = await this.containers.runtime(container).catch(() => undefined);
    if (!runtime)
      throw new GapError(`Docker has no container named ${container}.`, "unsupported", {
        kind: "service-down",
        title: `Docker has no container named ${container}.`,
        detail: "If Caddy was renamed or moved, scan for services again so Hearth finds it.",
      });
    if (!runtime.running)
      throw new GapError(`${s.name} is not running, so its sites cannot be read.`, "temporary", {
        kind: "service-down",
        title: `${s.name} is not running.`,
        detail:
          "Every site it serves is down until it starts. Start it from Container above, or ask Ember why it stopped.",
      });
    const facts = await this.containers.config(container).catch(() => undefined);
    let config: unknown;
    let readVia: "caddy-api" | "container" = "caddy-api";
    if (facts?.networkMode === "host") config = await this.caddyApi().catch(() => undefined);
    if (config === undefined) {
      // No narrow way in: Caddy's admin API listens inside its own network. Reading there is
      // host administration (running a command in the container), so it waits for that.
      const blocked = await this.scopes.blocker("investigate");
      if (blocked)
        throw new GapError(
          facts?.networkMode === "host"
            ? `${s.name}'s admin API did not answer on this machine (it may be switched off in its configuration).`
            : `${s.name} keeps its admin API inside its own network, so reading its sites needs host administration.`,
          "missing-permission",
          blocked,
        );
      const d = this.deps();
      const cfg = await d.exec.exec(
        container,
        ["wget", "-qO-", "http://localhost:2019/config/"],
        20_000,
      );
      if (cfg.exitCode !== 0)
        throw new GapError(
          `${s.name}'s admin API did not answer inside its container (it may be switched off in its configuration).`,
          "unsupported",
          {
            kind: "missing-config",
            title: `${s.name}'s admin API is switched off.`,
            detail:
              "Hearth reads Caddy's sites from its admin API. With it off (admin off in the Caddyfile), only the live checks are possible; ask Ember to plan switching it back on.",
          },
        );
      config = JSON.parse(cfg.output.slice(cfg.output.indexOf("{"))) as unknown;
      readVia = "container";
    }
    const sites = parseCaddyConfig(config);
    const caddy = caddyAddress(config);
    const lines = await this.containers
      .logs(container, 400, { since: Date.now() / 1000 - 86_400 })
      .catch(() => [] as string[]);
    const errors = lines
      .filter((l) => /"level":"error"/.test(l))
      .slice(-8)
      .map((l) => {
        try {
          const j = JSON.parse(l.slice(l.indexOf("{"))) as {
            ts?: number;
            msg?: string;
            logger?: string;
            error?: string;
            request?: { host?: string };
          };
          return {
            ...(j.ts ? { at: new Date(j.ts * 1000).toISOString() } : {}),
            text: redactLine(
              `${j.request?.host ? `${j.request.host}: ` : ""}${j.msg ?? "error"}${j.error ? ` (${j.error})` : ""}`,
            ).slice(0, 240),
          };
        } catch {
          return { text: redactLine(l).slice(0, 240) };
        }
      });
    // Which of Hearth's services each address belongs to, by its local address.
    const known = await this.handle.db
      .select({ name: t.services.name, url: t.services.localUrl })
      .from(t.services);
    const nameOf = (dial: string) => known.find((k) => k.url && new URL(k.url).host === dial)?.name;
    const checked = await Promise.all(
      sites.map(async (x) => {
        const [local, through] = await Promise.all([
          Promise.all(x.upstreams.map((u) => this.probes.local(u))),
          x.fixed && !x.upstreams.length
            ? Promise.resolve({ ok: true } as { ok: boolean; why?: string; certExpires?: string })
            : this.probes.through(caddy, x.hosts[0]!),
        ]);
        return {
          ...x,
          services: x.upstreams.map(nameOf).filter((n): n is string => Boolean(n)),
          ...(through.certExpires ? { certExpires: through.certExpires } : {}),
          localUp: local.length ? local.every(Boolean) : null,
          works: through.ok,
          ...(through.why ? { why: through.why } : {}),
        };
      }),
    );
    return {
      container,
      readVia,
      // Live checks, all at once: the app answers locally, and the site works through Caddy.
      sites: checked,
      checkedAt: new Date().toISOString(),
      certificates: checked.filter((x) => x.certExpires).length,
      errors,
      manage: await this.caddyManage(container),
    };
  }

  /**
   * Whether the add and edit form can work, and if not, the first thing in its way, precisely:
   * host administration (host-wide), where the Caddyfile is, whether Hearth's own account can read
   * it, and who would write it (a protected file goes through the elevated executor).
   */
  async caddyManage(
    container: string,
  ): Promise<
    { ok: true; path: string; via: "direct" | "elevated" } | { ok: false; blocker: Blocker }
  > {
    const admin = await this.scopes.blocker("propose");
    if (admin) return { ok: false, blocker: admin };
    const mount = (await this.containers.mounts(container).catch(() => [])).find(
      (m) => m.destination === "/etc/caddy/Caddyfile",
    );
    if (!mount)
      return {
        ok: false,
        blocker: {
          kind: "missing-config",
          title: "Caddy's Caddyfile is not a file from this machine.",
          detail:
            "The form edits the Caddyfile Caddy reads, so it has to be mounted from this machine (to /etc/caddy/Caddyfile). Ask Ember how Caddy is configured here.",
        },
      };
    const account = os.userInfo().username;
    const readable = await fs.access(mount.source, fsConstants.R_OK).then(
      () => true,
      () => false,
    );
    if (!readable)
      return {
        ok: false,
        blocker: {
          kind: "file-access",
          path: mount.source,
          account,
          access: "read",
          title: `Hearth's account (${account}) cannot read ${mount.source}.`,
          detail:
            "The sites above are read from Caddy itself, so they stay visible. To change them, Hearth has to read the Caddyfile: a narrow read permission on that one file, or the elevated executor. Nothing changes until you approve it.",
        },
      };
    try {
      return { ok: true, path: mount.source, via: await this.route(mount.source, true) };
    } catch (error) {
      if (error instanceof GapError)
        return {
          ok: false,
          blocker: {
            kind: "capability",
            path: mount.source,
            account,
            access: "write",
            title: `Hearth's account (${account}) cannot write ${mount.source}.`,
            detail: error.message,
          },
        };
      throw error;
    }
  }

  /** Caddy's running configuration, from its admin API on this machine (GET only; replaced in tests). */
  caddyApi: () => Promise<unknown> = () => readCaddyConfig("http://127.0.0.1:2019/config/");

  /**
   * The exact Caddyfile edits for the Caddy panel's form (add, change, or remove a site), built
   * from the file as it is now. Nothing is written here: the panel proposes them as the usual
   * protected config-edit plan, which Caddy validates, you confirm, and Hearth puts back on failure.
   */
  async caddySiteEdits(serviceId: string, change: SiteChange) {
    const s = await this.scopes.service(serviceId);
    const container = containerOf(s);
    if (!container || !/caddy/i.test(`${s.image ?? ""} ${container}`))
      throw new GapError(`${s.name} is not a Caddy container.`, "unsupported");
    // The same check the panel shows, so the form never gets further than the panel says it can.
    const manage = await this.caddyManage(container);
    if (!manage.ok)
      throw new GapError(
        manage.blocker.title,
        manage.blocker.kind === "host-admin" ? "missing-permission" : "unsupported",
        manage.blocker,
      );
    const cur = await readTarget(manage.path);
    try {
      return { path: manage.path, edits: JSON.stringify(siteEdits(cur.content, change)) };
    } catch (error) {
      throw new PlanError(error instanceof Error ? error.message : String(error));
    }
  }

  /** A switch of a Gluetun service to another ProtonVPN server: the plan, with the exact edit. */
  private async planSwitch(
    s: Awaited<ReturnType<HostScopes["service"]>>,
    p: Record<string, unknown>,
  ) {
    const d = this.deps();
    const container = containerOf(s);
    if (!container || !/gluetun/i.test(`${s.image ?? ""} ${container}`))
      throw new PlanError(`${s.name} is not a Gluetun VPN container.`);
    const file = await composeFileOf(d.run, container);
    if (!file) throw new PlanError(`Docker does not say which Compose file made ${container}.`);
    await this.scopes.requireChangeable(file, { allowProtected: true });
    const via = await this.route(file, true);
    const cur = await readTarget(file);
    const servers = await protonServers(d.exec, container);
    const want = String(p.server ?? "")
      .trim()
      .toLowerCase();
    if (!want)
      throw new PlanError("Say which server (params.server), e.g. US-CA#149 (see vpn_servers).");
    const to = servers.find(
      (x) => x.name.toLowerCase() === want || x.hostname.toLowerCase() === want || x.ip === want,
    );
    if (!to)
      throw new PlanError(
        `No ProtonVPN WireGuard server "${p.server}". List them with vpn_servers.`,
      );
    const ip = currentEndpoint(cur.content);
    if (ip === to.ip) throw new PlanError(`${s.name} already uses ${to.name}.`);
    const edits = switchEdits(cur.content, to);
    if (typeof edits === "string") throw new PlanError(edits);
    const after = applyEdits(cur.content, edits).after;
    const services = await composeServices(d.run, file);
    const from = servers.find((x) => x.ip === ip);
    const change: StepChange = {
      summary: `Switch ${s.name} to VPN server ${to.name} (${to.city})`,
      settings: [
        {
          name: "VPN server",
          before: from ? `${from.name}, ${from.city} (${ip})` : (ip ?? "unknown"),
          after: `${to.name}, ${to.city} (${to.ip})`,
        },
        {
          name: "Server's public key",
          before: "The current server's",
          after: `${to.publicKey.slice(0, 10)}...`,
        },
        { name: "Your private key", before: "Unchanged", after: "Unchanged (never read)" },
        {
          name: "Then",
          before: "Running",
          after: `Recreate ${services.join(", ")} (about a minute without a connection), then check the VPN's new internet address`,
        },
        ...this.viaRows(via),
      ],
    };
    return {
      label: change.summary,
      change,
      params: {
        path: file,
        edits: JSON.stringify(edits),
        beforeHash: cur.hash,
        afterHash: sha256(after),
        protected: "yes",
        apply: "compose",
        vpn: container,
        server: to.name,
        ...(via === "elevated" ? { via } : {}),
      },
    };
  }

  /** Makes a written change take effect: Compose recreates, Caddy reloads. */
  private async applyChange(p: Record<string, unknown>): Promise<{ ok: boolean; detail: string }> {
    try {
      return await this.applyNow(p);
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private async applyNow(p: Record<string, unknown>) {
    const d = this.deps();
    if (p.apply === "compose") return applyCompose(d.run, String(p.path), d.wait);
    if (p.apply === "caddy") return caddyReload(d.exec, String(p.caddy), String(p.caddyPath));
    return { ok: true, detail: "" };
  }

  private async logDir(serviceId: string): Promise<{ container: string; logDir: string }> {
    const s = await this.scopes.service(serviceId);
    const container = containerOf(s);
    if (!container) throw new PlanError(`${s.name} has no container Hearth knows.`);
    const mounts = await this.containers.mounts(container);
    const cfg = mounts.find((m) => m.destination === "/config");
    if (!cfg) throw new PlanError(`${s.name}'s /config folder is not mounted from this machine.`);
    return { container, logDir: path.posix.join(cfg.source, "logs", "cli") };
  }

  /**
   * What the Recyclarr panel shows: its last run from its own log (what it set, errors,
   * warnings, when), and on request what a sync now would change (Recyclarr's own preview,
   * which changes nothing). Read only.
   */
  async recyclarrPanel(serviceId: string, preview: boolean) {
    await this.scopes.require("investigate");
    const s = await this.scopes.service(serviceId);
    if (!isRecyclarr(s)) throw new GapError(`${s.name} is not Recyclarr.`, "unsupported");
    const { container, logDir } = await this.logDir(serviceId);
    const last = await this.recyclarr.lastRun(logDir);
    const now = preview ? await this.recyclarr.preview(container, logDir) : undefined;
    return {
      container,
      lastRun: last
        ? {
            at: last.at,
            set: last.settings,
            errors: last.errors,
            warnings: last.warnings.slice(0, 10),
          }
        : null,
      ...(now
        ? {
            preview: {
              ok: now.ok,
              at: now.at,
              changes: now.settings.filter((x) => x.from !== x.to),
              unchanged: now.settings.filter((x) => x.from === x.to).length,
              errors: now.errors,
              warnings: now.warnings.slice(0, 10),
            },
          }
        : {}),
    };
  }

  /** What Recyclarr would do with the file as it is and with the change, side by side. */
  async compare(serviceId: string, current: string, candidate: string) {
    const { container, logDir } = await this.logDir(serviceId);
    const without = await this.recyclarr.preview(container, logDir, current);
    const withChange = await this.recyclarr.preview(container, logDir, candidate);
    return { without, withChange };
  }

  private parseEdits(raw: unknown): ConfigEdit[] {
    try {
      const v = JSON.parse(String(raw ?? "")) as unknown;
      if (!Array.isArray(v)) throw new Error();
      return v as ConfigEdit[];
    } catch {
      throw new PlanError(
        'Give the edits as JSON: [{"find": "exact text", "replace": "new text"}].',
      );
    }
  }

  async plan(step: JobStepInput, requestedBy: Requester): Promise<PlannedStep> {
    if (COMPOSE_ACTIONS.includes(step.kind)) return this.compose.plan(step, requestedBy);
    const s = await this.scopes.service(step.serviceId).catch(() => undefined);
    const base: PlannedStep = {
      label: ACTIONS[step.kind].describe(s?.name ?? step.serviceId),
      serviceName: s?.name ?? step.serviceId,
      changes: true,
      policy: "refuse",
      policyReason: "",
    };
    try {
      if (!s) throw new PlanError(`No service "${step.serviceId}".`);
      const { decision } = await this.runner.policyFor(step.kind, s.id, requestedBy);
      const done = (
        p: Omit<PlannedStep, "policy" | "policyReason" | "serviceName" | "changes">,
      ) => ({
        ...base,
        ...p,
        policy: decision.outcome === "allow" ? ("approve-first" as const) : decision.outcome,
        policyReason:
          decision.outcome === "refuse"
            ? decision.reason
            : p.params?.protected === "yes"
              ? PROTECTED_REASON
              : "Changes a service's configuration: it always waits for your approval.",
      });
      const p = step.params ?? {};
      if (step.kind === "app-recyclarr-sync") {
        await this.requireRecyclarr(s);
        const { container, logDir } = await this.logDir(s.id);
        const now = await this.recyclarr.preview(container, logDir);
        if (!now.ok)
          throw new PlanError(`Recyclarr's own check fails right now: ${now.errors.join("; ")}`);
        const changes = now.settings.filter((x) => x.from !== x.to);
        const change: StepChange = {
          summary: `Run Recyclarr's sync now (${s.name})`,
          settings: changes.length
            ? changes.map((x) => ({
                name: `${x.instance}: ${x.setting}`,
                before: x.from,
                after: x.to,
              }))
            : [
                {
                  name: "Quality profiles",
                  before: "Already as the configuration says",
                  after: "No change expected",
                },
              ],
        };
        return done({
          label: change.summary,
          change,
          params: { preview: describeSettings(changes).join("; ").slice(0, 500) },
        });
      }
      if (step.kind === "vpn-switch-server") return done(await this.planSwitch(s, p));
      const file = String(p.path ?? "");
      if (!path.posix.isAbsolute(file) && !path.isAbsolute(file))
        throw new PlanError("Say which file (params.path, its full path on the host).");
      const gate = await this.scopes.requireChangeable(file, { allowProtected: true });
      // How a protected change takes effect, checked before it is planned.
      const prot = async (
        next: string,
      ): Promise<{ extra: Record<string, string>; then?: string }> => {
        if (isComposeFile(file)) {
          const services = await composeServices(this.deps().run, file);
          return {
            extra: { protected: "yes", apply: "compose" },
            then: `Recreate ${services.join(", ")} (each drops for about a minute), then check they all run`,
          };
        }
        const caddy = await caddyFor((c) => this.containers.mounts(c), this.deps().run, file);
        if (caddy) {
          const bad = await caddyValid(this.deps().exec, caddy.container, next);
          if (bad) throw new PlanError(`Caddy rejects the changed file: ${bad}`);
          return {
            extra: {
              protected: "yes",
              apply: "caddy",
              caddy: caddy.container,
              caddyPath: caddy.inside,
            },
            then: "Caddy checked the new file; it reloads with it (no downtime)",
          };
        }
        return { extra: { protected: "yes" }, then: undefined };
      };
      // Any Compose change takes effect the same way: its project is recreated and checked, and
      // the file is put back if it does not come back working (protected or not).
      const recreate = async (): Promise<{ extra: Record<string, string>; then?: string }> => {
        const services = await composeServices(this.deps().run, file);
        return {
          extra: { apply: "compose" },
          then: `Recreate ${services.join(", ")} (each drops for about a minute), then check they all run; if not, the file is put back`,
        };
      };
      const format = formatOf(file);
      const validator = await this.validatorFor(s, file);
      const cur = await readTarget(file);
      if (step.kind === "config-restore") {
        const key = backupKey(s);
        const want = typeof p.backup === "string" && p.backup ? p.backup : undefined;
        const chosen = want
          ? await readBackup(want, file)
          : await findBackup(this.backupRoot, key, file, () => true);
        if (!chosen)
          throw new PlanError(`No Hearth backup of ${file} was found${want ? ` in ${want}` : ""}.`);
        if (sha256(chosen.content) === cur.hash)
          throw new PlanError("The file already matches that backup.");
        const change: StepChange = {
          summary: `Restore ${path.basename(file)} (${s.name}) from the backup of ${clock(chosen.manifest.at)}`,
          settings: [
            {
              name: "File",
              before: `${file} as it is now`,
              after: `As backed up in ${chosen.dir}`,
            },
          ],
        };
        const restoreCheck = isComposeFile(file)
          ? await this.composeCheck(file, cur.content, chosen.content)
          : undefined;
        if (restoreCheck) change.settings.push(...restoreCheck.rows);
        const pr =
          gate.protected || restoreCheck?.protected
            ? await prot(chosen.content)
            : restoreCheck
              ? await recreate()
              : undefined;
        if (pr?.then) change.settings.push({ name: "Then", before: "Running", after: pr.then });
        const via = await this.route(file, pr?.extra.protected === "yes");
        change.settings.push(...this.viaRows(via));
        return done({
          label: change.summary,
          change,
          params: {
            path: file,
            backupDir: chosen.dir,
            beforeHash: cur.hash,
            afterHash: sha256(chosen.content),
            ...pr?.extra,
            ...(via === "elevated" ? { via } : {}),
          },
        });
      }
      // config-edit
      const edits = this.parseEdits(p.edits);
      let applied: ReturnType<typeof applyEdits>;
      try {
        applied = applyEdits(cur.content, edits);
      } catch (e) {
        throw new PlanError(e instanceof EditError ? e.message : String(e));
      }
      const networking =
        isComposeFile(file) &&
        applied.hunks.some(
          (h) =>
            COMPOSE_PROTECTED_KEYS.test(h.before) ||
            COMPOSE_PROTECTED_KEYS.test(h.after) ||
            underProtectedKey(cur.content, h.line),
        );
      const composeCheck = isComposeFile(file)
        ? await this.composeCheck(file, cur.content, applied.after)
        : undefined;
      const pr =
        gate.protected || networking || composeCheck?.protected
          ? await prot(applied.after)
          : composeCheck
            ? await recreate()
            : undefined;
      const settings: StepChange["settings"] = applied.hunks.map((h) => ({
        name: `${path.basename(file)}, line ${h.line}`,
        before: maskSecrets(h.before, format),
        after: maskSecrets(h.after, format),
      }));
      if (composeCheck) settings.push(...composeCheck.rows);
      let checked = composeCheck ? "Compose accepts the changed file" : "no dry run for this file";
      if (validator === "recyclarr") {
        const { without, withChange } = await this.compare(s.id, cur.content, applied.after);
        if (!withChange.ok)
          throw new PlanError(
            `Recyclarr rejects the changed file: ${withChange.errors.join("; ") || `exit ${withChange.exitCode}`}`,
          );
        const key = (x: ProfileSetting) => `${x.instance}|${x.setting}`;
        const w = new Map(without.settings.map((x) => [key(x), x]));
        for (const x of withChange.settings) {
          const before = w.get(key(x));
          if (before && before.to === x.to) continue;
          settings.push({
            name: `Next sync, ${x.instance}: ${x.setting}`,
            before: `Without this change it sets ${before?.to ?? "?"} (now ${x.from})`,
            after: `With it: ${x.to}`,
          });
        }
        checked = "Recyclarr's own preview of the changed file passed";
      }
      if (pr?.then) settings.push({ name: "Then", before: "Running", after: pr.then });
      const via = await this.route(file, pr?.extra.protected === "yes");
      settings.push(...this.viaRows(via));
      const change: StepChange = {
        summary: `Edit ${path.basename(file)} (${s.name}): ${applied.hunks.length} change${applied.hunks.length === 1 ? "" : "s"}; ${checked}`,
        settings,
      };
      return done({
        label: `Edit ${path.basename(file)} of ${s.name}`,
        change,
        params: {
          path: file,
          edits: JSON.stringify(edits),
          beforeHash: cur.hash,
          afterHash: sha256(applied.after),
          ...pr?.extra,
          ...(via === "elevated" ? { via } : {}),
        },
      });
    } catch (error) {
      return { ...base, policyReason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Recyclarr's sync: the host scope allows proposals and the service really is Recyclarr. */
  private async requireRecyclarr(s: Awaited<ReturnType<HostScopes["service"]>>) {
    await this.scopes.require("propose");
    if (!isRecyclarr(s)) throw new PlanError(`${s.name} is not Recyclarr.`);
  }

  /** The app's own dry run for this file, when there is one (Recyclarr's main configuration). */
  private async validatorFor(
    s: Awaited<ReturnType<HostScopes["service"]>>,
    file: string,
  ): Promise<"recyclarr" | undefined> {
    if (!isRecyclarr(s)) return undefined;
    const name = containerOf(s);
    if (!name) return undefined;
    const cfg = (await this.containers.mounts(name).catch(() => [])).find(
      (m) => m.destination === "/config",
    );
    if (!cfg) return undefined;
    const rel = path.posix.relative(cfg.source, file.replaceAll("\\", "/"));
    return /^recyclarr\.ya?ml$/i.test(rel) ? "recyclarr" : undefined;
  }

  async record(
    step: StepRun,
    serviceName: string,
    serviceId: string,
    result: string,
    verified: boolean,
    detail: Record<string, unknown>,
  ) {
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: step.change?.summary ?? step.kind,
      target: `service:${serviceId}`,
      detail: { ...detail, verified },
    });
    if (verified && this.memory) {
      // A new app on this machine (serviceId this-host) has no service row yet: remembering it
      // must never turn a step that worked into a failure (11-22: FlareSolverr installed and
      // ran, but the plan said "No service this-host" and skipped the rest).
      const s = await this.scopes.service(serviceId).catch(() => undefined);
      const host = s
        ? await this.handle.db.select().from(t.hosts).where(eq(t.hosts.id, s.hostId)).get()
        : undefined;
      await this.memory
        .recordSystem(this.handle.db, {
          title: step.change?.summary ?? `${serviceName}: configuration`,
          body: `${result} Approved as a step of a plan, then verified.`,
          happenedAt: new Date().toISOString(),
          machine: host?.name ?? (s ? undefined : os.hostname()),
          links: [{ label: serviceName, ref: `service:${serviceId}` }],
        })
        .catch(() => undefined);
    }
  }

  async run(step: StepRun, opts: { undo?: boolean } = {}): Promise<StepOutcome> {
    if (COMPOSE_ACTIONS.includes(step.kind)) return this.compose.run(step, opts);
    try {
      const s = await this.scopes.service(step.serviceId);
      const p = step.params ?? {};
      if (step.kind === "app-recyclarr-sync") {
        await this.requireRecyclarr(s);
        const { container, logDir } = await this.logDir(s.id);
        const r = await this.recyclarr.sync(container, logDir);
        if (!r.ok) {
          const result = `Recyclarr's sync did not finish cleanly: ${r.errors.join("; ") || `exit ${r.exitCode}`}.`;
          await this.record(step, s.name, s.id, result, false, { errors: r.errors });
          return { ok: false, result };
        }
        // Verified by Recyclarr's own check right after: nothing left to change means Radarr and Sonarr match the file.
        const after = await this.recyclarr.preview(container, logDir);
        const drift = after.settings.filter((x) => x.from !== x.to);
        const verified = after.ok && drift.length === 0;
        const applied = r.settings.filter((x) => x.from !== x.to);
        const state = after.settings
          .filter((x) => x.setting === "Upgrade Allowed")
          .map((x) => `${x.instance} upgrades ${x.to === "True" ? "on" : "off"}`);
        const result = verified
          ? `Recyclarr synced${applied.length ? `: ${describeSettings(applied).join("; ")}` : " (nothing needed changing)"}. Verified: its own check right after shows Radarr and Sonarr match the configuration (${state.join(", ")}).`
          : `Recyclarr synced, but its check right after still wants to change: ${describeSettings(drift).join("; ")}.`;
        await this.record(step, s.name, s.id, result, verified, {
          applied: describeSettings(applied),
          log: r.log,
        });
        return { ok: verified, result };
      }
      const file = String(p.path ?? "");
      await this.scopes.requireChangeable(file, { allowProtected: p.protected === "yes" });
      const validator = await this.validatorFor(s, file);
      const cur = await readTarget(file);
      const key = backupKey(s);
      if (opts.undo) {
        if (cur.hash !== p.afterHash)
          return {
            ok: false,
            result: `${path.basename(file)} changed since this step; it was not put back.`,
          };
        const match = (m: BackupManifest) =>
          m.afterHash === p.afterHash && m.beforeHash === p.beforeHash;
        // The executor's own backup, restored by the executor (it may be readable by root only).
        const own = p.via === "elevated" ? await this.executorBackup(key, file, match) : undefined;
        let from: string;
        if (own) {
          const r = await this.elevation!.perform(
            "file.restore",
            {
              path: file,
              key,
              backup: own.id,
              beforeHash: cur.hash,
              backupHash: own.manifest.beforeHash,
            },
            step,
          );
          if (!r.ok) return { ok: false, result: `The executor did not put it back: ${r.result}` };
          from = own.id;
        } else {
          const b = await this.anyBackup(key, file, match);
          if (!b)
            return {
              ok: false,
              result: "No backup from this step was found; nothing was put back.",
            };
          // Only content that is exactly what the backup recorded, and what was there before.
          if (sha256(b.content) !== b.manifest.beforeHash)
            return {
              ok: false,
              result: `The backup in ${b.dir} does not match its own record; nothing was put back.`,
            };
          const w = await this.put(step, key, file, cur, b.content, "undo");
          if (!w.ok) return { ok: false, result: w.result };
          from = b.dir;
        }
        const b = { dir: from };
        const back = await readTarget(file);
        let ok = back.hash === p.beforeHash;
        let tail = "";
        if (ok && p.apply) {
          const a = await this.applyChange(p);
          ok = a.ok;
          tail = ` ${a.detail}`;
        }
        const result = ok
          ? `Put ${path.basename(file)} back from ${b.dir}.${tail}`
          : `Tried to put ${path.basename(file)} back, but it did not come back cleanly.${tail}`;
        await this.record(step, s.name, s.id, result, ok, { undo: true, backup: b.dir });
        return { ok, result };
      }
      if (cur.hash !== p.beforeHash)
        return {
          ok: false,
          stale: true,
          result: `${path.basename(file)} changed since this plan was approved. Nothing was changed; plan it again.`,
        };
      let next: string;
      if (step.kind === "config-restore") {
        const chosen = await readBackup(String(p.backupDir ?? ""), file);
        if (!chosen || sha256(chosen.content) !== p.afterHash)
          return {
            ok: false,
            stale: true,
            result: "The backup is no longer as approved. Nothing was changed.",
          };
        next = chosen.content;
      } else {
        const edits = this.parseEdits(p.edits);
        next = applyEdits(cur.content, edits).after;
        if (sha256(next) !== p.afterHash)
          return {
            ok: false,
            stale: true,
            result: "The edits no longer give the approved result. Nothing was changed.",
          };
        if (p.apply === "caddy") {
          const bad = await caddyValid(this.deps().exec, String(p.caddy), next);
          if (bad)
            return {
              ok: false,
              result: `Caddy now rejects the changed file (${bad}). Nothing was changed.`,
            };
        }
        if (validator === "recyclarr") {
          const { container, logDir } = await this.logDir(s.id);
          const check = await this.recyclarr.preview(container, logDir, next);
          if (!check.ok)
            return {
              ok: false,
              result: `Recyclarr now rejects the changed file (${check.errors.join("; ")}). Nothing was changed.`,
            };
        }
      }
      const exitBefore = p.vpn ? await exitAddress(this.deps().exec, String(p.vpn)) : undefined;
      const w = await this.put(
        step,
        key,
        file,
        cur,
        next,
        step.kind === "config-restore" ? "restore" : "edit",
      );
      if (!w.ok) return { ok: false, ...(w.stale ? { stale: true } : {}), result: w.result };
      const backup = w.backup;
      const back = await readTarget(file);
      let verified = back.hash === p.afterHash;
      let tail = "";
      if (verified && p.apply) {
        const a = await this.applyChange(p);
        let problem = a.ok ? undefined : a.detail;
        let exitNow: string | undefined;
        if (!problem && p.vpn) {
          exitNow = await exitAddress(this.deps().exec, String(p.vpn));
          if (!exitNow) problem = "The VPN did not get an internet connection on the new server.";
        }
        if (problem) {
          // Put it back exactly as it was, and apply that, so a failed change leaves nothing broken.
          const undone = await this.putBack(step, w, file, cur);
          if (!undone.ok) {
            const result = `${problem} Putting ${path.basename(file)} back did not work (${undone.detail}); it is still as changed. Backup: ${backup}.`;
            await this.record(step, s.name, s.id, result, false, { file, backup });
            return { ok: false, result };
          }
          const again = await this.applyChange(p);
          const result = `${problem} So ${path.basename(file)} was put back as it was${again.ok ? " and everything is running again" : `, but bringing it back also had trouble: ${again.detail}`}. Backup: ${backup}.`;
          await this.record(step, s.name, s.id, result, false, { file, backup, rolledBack: true });
          return { ok: false, result };
        }
        tail = p.vpn
          ? ` Now on ${String(p.server)}: the VPN's internet address is ${exitNow} (was ${exitBefore ?? "unknown"}). ${a.detail}`
          : ` ${a.detail}`;
        verified = true;
      }
      if (verified && validator === "recyclarr") {
        const { container, logDir } = await this.logDir(s.id);
        const now: RecyclarrReport = await this.recyclarr.preview(container, logDir);
        const pending = now.settings.filter((x) => x.from !== x.to);
        tail = now.ok
          ? ` Recyclarr's check of the file in place passes; its next sync will set: ${pending.length ? describeSettings(pending).join("; ") : "nothing new"}.`
          : ` Recyclarr's check of the file in place reports: ${now.errors.join("; ")}.`;
      }
      const result = verified
        ? `${step.kind === "config-restore" ? "Restored" : "Changed"} ${file}, verified by reading it back (exact fingerprint). Backup: ${backup}.${tail}`
        : `Wrote ${file}, but it does not read back as approved. The backup is in ${backup}.`;
      await this.record(step, s.name, s.id, result, verified, {
        file,
        backup,
        beforeHash: cur.hash,
        afterHash: back.hash,
        ...(p.via === "elevated" ? { via: "elevated executor" } : {}),
      });
      return { ok: verified, result };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        result: error instanceof GapError ? `${msg} Nothing was changed.` : msg,
      };
    }
  }

  async undo(step: StepRun): Promise<StepOutcome | undefined> {
    if (step.kind === "app-recyclarr-sync") return undefined;
    return this.run(step, { undo: true });
  }
}
