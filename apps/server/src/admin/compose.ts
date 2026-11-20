import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PathClass } from "@dragon-control/core";
import type { Runner } from "./host";

/**
 * Compose, read the way Compose itself reads it, and the mount guard that every Compose change
 * Hearth plans must pass. Nothing here writes a Compose file or starts a container: it reads a
 * file (or a proposed version of it, from a private temporary copy) through `docker compose
 * config`, and judges what the result would let a container reach on this machine.
 */

/** One service as Compose resolves it (paths absolute, defaults filled in). */
export interface ComposeServiceSpec {
  name: string;
  image?: string;
  restart?: string;
  volumes: { type: string; source?: string; target: string; readOnly: boolean }[];
  ports: string[];
  /** Variable names only: values can be secrets and are never kept. */
  environment: string[];
  networkMode?: string;
  privileged: boolean;
  pid?: string;
  ipc?: string;
  userns?: string;
  capAdd: string[];
  devices: string[];
  securityOpt: string[];
}

interface RawService {
  image?: string;
  restart?: string;
  volumes?: { type?: string; source?: string; target?: string; read_only?: boolean }[];
  ports?: { published?: string | number; target?: number; protocol?: string; host_ip?: string }[];
  environment?: Record<string, unknown>;
  network_mode?: string;
  privileged?: boolean;
  pid?: string;
  ipc?: string;
  userns_mode?: string;
  cap_add?: string[];
  devices?: ({ source?: string; target?: string } | string)[];
  security_opt?: string[];
}

export interface ComposeJson {
  name?: string;
  services?: Record<string, RawService>;
}

/**
 * Compose's own reading of a file, or of proposed contents for it (written to a private
 * temporary file, resolved against the real file's folder so relative paths and .env behave the
 * same). Returns Compose's error in its own words when it rejects it.
 */
export async function composeJson(
  run: Runner,
  file: string,
  content?: string,
): Promise<{ config?: ComposeJson; error?: string }> {
  let dir: string | undefined;
  try {
    let target = file;
    if (content !== undefined) {
      dir = await mkdtemp(path.join(tmpdir(), "hearth-compose-"));
      target = path.join(dir, path.basename(file));
      await writeFile(target, content, { mode: 0o600 });
    }
    const r = await run(
      "docker",
      [
        "compose",
        "--project-directory",
        path.dirname(file),
        "-f",
        target,
        "config",
        "--format",
        "json",
      ],
      30_000,
    );
    if (r.code !== 0) return { error: r.out.trim().slice(0, 500) || `exit ${r.code}` };
    return { config: JSON.parse(r.out) as ComposeJson };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function servicesOf(config: ComposeJson): ComposeServiceSpec[] {
  return Object.entries(config.services ?? {}).map(([name, s]) => ({
    name,
    ...(s.image ? { image: s.image } : {}),
    ...(s.restart ? { restart: s.restart } : {}),
    volumes: (s.volumes ?? []).map((v) => ({
      type: v.type ?? "volume",
      ...(v.source ? { source: v.source } : {}),
      target: v.target ?? "",
      readOnly: Boolean(v.read_only),
    })),
    ports: (s.ports ?? []).map(
      (p) =>
        `${p.host_ip ? `${p.host_ip}:` : ""}${p.published ?? ""}:${p.target ?? ""}/${p.protocol ?? "tcp"}`,
    ),
    environment: Object.keys(s.environment ?? {}).sort(),
    ...(s.network_mode ? { networkMode: s.network_mode } : {}),
    privileged: Boolean(s.privileged),
    ...(s.pid ? { pid: s.pid } : {}),
    ...(s.ipc ? { ipc: s.ipc } : {}),
    ...(s.userns_mode ? { userns: s.userns_mode } : {}),
    capAdd: s.cap_add ?? [],
    devices: (s.devices ?? []).map((d) =>
      typeof d === "string" ? d : `${d.source ?? ""}:${d.target ?? ""}`,
    ),
    securityOpt: s.security_opt ?? [],
  }));
}

/* ---------- The mount guard ---------- */

export interface GuardPolicy {
  /** Folders a container may be given (the homelab's own: docker config, media drives). */
  homelabRoots: string[];
  /** Hearth's path rules: secret and protected paths (scope.ts classify). */
  classify: (p: string) => { class: PathClass; why?: string };
}

/**
 * What a service would be allowed to reach that needs a decision. refused: never through
 * Hearth (secrets, the whole machine). protected: possible only with the owner's explicit
 * confirmation that it is them (full host access, devices, folders outside the homelab).
 */
export interface GuardIssue {
  service: string;
  verdict: "refused" | "protected";
  what: string;
  why: string;
}

const DOCKER_SOCKET = /^\/(var\/)?run\/docker\.sock$/;
/** The usual way to give a container the machine's clock: harmless when read only. */
const CLOCK = /^\/etc\/(localtime|timezone)$|^\/usr\/share\/zoneinfo(\/|$)/;
const under = (p: string, root: string) =>
  p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

/** The homelab folders, from DC_HOMELAB_ROOTS (comma-separated absolute paths). */
export function homelabRootsFrom(env: NodeJS.ProcessEnv): string[] {
  return (env.DC_HOMELAB_ROOTS ?? "")
    .split(",")
    .map((r) => path.posix.normalize(r.trim()))
    .filter((r) => r.startsWith("/") && r !== "/");
}

export function guardService(s: ComposeServiceSpec, policy: GuardPolicy): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const add = (verdict: GuardIssue["verdict"], what: string, why: string) =>
    issues.push({ service: s.name, verdict, what, why });
  for (const v of s.volumes) {
    if (v.type !== "bind" || !v.source) continue;
    const src = path.posix.normalize(v.source.replaceAll("\\", "/"));
    const what = `${src} mounted at ${v.target}${v.readOnly ? " (read only)" : ""}`;
    if (src === "/") {
      add("refused", what, "the whole machine's files");
      continue;
    }
    if (CLOCK.test(src) && v.readOnly) continue;
    if (DOCKER_SOCKET.test(src)) {
      add("protected", what, "control of Docker, which is control of the whole machine");
      continue;
    }
    const cls = policy.classify(src);
    if (cls.class === "secret") {
      add("refused", what, cls.why ?? "a secret location");
      continue;
    }
    if (cls.class === "protected") {
      add("protected", what, cls.why ?? "a protected location");
      continue;
    }
    if (!policy.homelabRoots.length) {
      add(
        "protected",
        what,
        "no homelab folders are configured (DC_HOMELAB_ROOTS), so every folder mount needs your approval",
      );
    } else if (!policy.homelabRoots.some((r) => under(src, r))) {
      add("protected", what, `outside your homelab folders (${policy.homelabRoots.join(", ")})`);
    }
  }
  if (s.privileged)
    add("protected", "privileged: true", "full access to the machine and its devices");
  for (const [key, value] of [
    ["network_mode", s.networkMode],
    ["pid", s.pid],
    ["ipc", s.ipc],
    ["userns_mode", s.userns],
  ] as const)
    if (value === "host")
      add("protected", `${key}: host`, "shares the machine's own namespace instead of its own");
  if (s.capAdd.length)
    add("protected", `cap_add: ${s.capAdd.join(", ")}`, "extra kernel privileges");
  if (s.devices.length)
    add("protected", `devices: ${s.devices.join(", ")}`, "direct access to hardware");
  const unconfined = s.securityOpt.filter((o) => /unconfined/i.test(o));
  if (unconfined.length)
    add("protected", `security_opt: ${unconfined.join(", ")}`, "switches off a security profile");
  return issues;
}

export function guardAll(specs: ComposeServiceSpec[], policy: GuardPolicy): GuardIssue[] {
  return specs.flatMap((s) => guardService(s, policy));
}

/** Issues a change introduces: in the new version and not in the current one. */
export function newIssues(before: GuardIssue[], after: GuardIssue[]): GuardIssue[] {
  const had = new Set(before.map((i) => `${i.service}|${i.what}`));
  return after.filter((i) => !had.has(`${i.service}|${i.what}`));
}

/** What a change does to each service, in Compose's own resolved terms (values of variables never shown). */
export function semanticDiff(
  before: ComposeServiceSpec[],
  after: ComposeServiceSpec[],
): { service: string; change: string }[] {
  const out: { service: string; change: string }[] = [];
  const b = new Map(before.map((s) => [s.name, s]));
  const a = new Map(after.map((s) => [s.name, s]));
  for (const [name, s] of a) {
    const was = b.get(name);
    if (!was) {
      out.push({ service: name, change: `New service (${s.image ?? "no image"})` });
      continue;
    }
    if (was.image !== s.image)
      out.push({ service: name, change: `Image: ${was.image ?? "none"} to ${s.image ?? "none"}` });
    if (was.restart !== s.restart)
      out.push({
        service: name,
        change: `Restart: ${was.restart ?? "no"} to ${s.restart ?? "no"}`,
      });
    const list = (label: string, x: string[], y: string[]) => {
      const added = y.filter((v) => !x.includes(v));
      const removed = x.filter((v) => !y.includes(v));
      if (added.length) out.push({ service: name, change: `${label} added: ${added.join(", ")}` });
      if (removed.length)
        out.push({ service: name, change: `${label} removed: ${removed.join(", ")}` });
    };
    const vol = (v: ComposeServiceSpec["volumes"][number]) =>
      `${v.source ?? `(${v.type})`}:${v.target}${v.readOnly ? ":ro" : ""}`;
    list("Volumes", was.volumes.map(vol), s.volumes.map(vol));
    list("Ports", was.ports, s.ports);
    list("Environment variables", was.environment, s.environment);
    list("Kernel privileges", was.capAdd, s.capAdd);
    list("Devices", was.devices, s.devices);
    if (was.networkMode !== s.networkMode)
      out.push({
        service: name,
        change: `Network mode: ${was.networkMode ?? "default"} to ${s.networkMode ?? "default"}`,
      });
    if (was.privileged !== s.privileged)
      out.push({ service: name, change: `Privileged: ${was.privileged} to ${s.privileged}` });
  }
  for (const name of b.keys())
    if (!a.has(name)) out.push({ service: name, change: "Service removed" });
  return out;
}
