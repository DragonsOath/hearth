import path from "node:path";
import type { ContainerExec } from "./docker-exec";
import type { Runner } from "./host";

/**
 * Protected changes (Phase 2, "Warden needs to have these types of control... with
 * approval"). The Ember may now plan changes to protected systems (the VPN, Caddy, Compose files of
 * networking services). Each runs only as a step of a plan you approve, and approving one asks you
 * to confirm it is you. Secrets stay out of reach: private keys and passwords are never shown or
 * written by the AI; a VPN server switch only changes the server's address and its public key.
 *
 * After the file is written it is applied the way that system takes changes (Compose recreates the
 * project's containers, Caddy reloads), then checked. If applying or the check fails, the file is
 * put back and applied again, so a failed change leaves things as they were.
 */

export interface ProtectedDeps {
  run: Runner;
  exec: ContainerExec;
  /** Waiting between checks while containers come back (tests pass a no-op). */
  wait?: (ms: number) => Promise<void>;
}

/** How a file's change takes effect. */
export type ApplyKind = "compose" | "caddy";

export const isComposeFile = (file: string) =>
  /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/i.test(path.basename(file));

/** The Compose file a container was made from (Compose's own label). */
export async function composeFileOf(run: Runner, container: string): Promise<string | undefined> {
  const r = await run(
    "docker",
    [
      "inspect",
      "-f",
      '{{index .Config.Labels "com.docker.compose.project.config_files"}}',
      container,
    ],
    20_000,
  );
  const f = r.out.trim().split(",")[0]?.trim();
  return r.code === 0 && f && f !== "<no value>" ? f : undefined;
}

/** The containers a Compose file makes, by service (from Compose itself, nothing is changed). */
export async function composeServices(run: Runner, file: string): Promise<string[]> {
  const r = await run("docker", ["compose", "-f", file, "config", "--services"], 30_000);
  if (r.code !== 0) throw new Error(`Compose cannot read ${file}: ${r.out.trim().slice(0, 300)}`);
  return r.out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Compose's own check of the file as written. */
export async function composeValid(run: Runner, file: string): Promise<string | undefined> {
  const r = await run("docker", ["compose", "-f", file, "config", "-q"], 30_000);
  return r.code === 0 ? undefined : r.out.trim().slice(0, 400) || `exit ${r.code}`;
}

interface PsRow {
  Service?: string;
  Name?: string;
  State?: string;
  Health?: string;
}

/**
 * Recreates the project's containers from the file, then waits (up to two minutes) for every one
 * to be running and none unhealthy. Containers that share another's network (Gluetun) are
 * recreated together, which is why the whole project is recreated.
 */
export async function applyCompose(
  run: Runner,
  file: string,
  wait = (ms: number) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ ok: boolean; detail: string }> {
  const bad = await composeValid(run, file);
  if (bad) return { ok: false, detail: `Compose rejects the file: ${bad}` };
  const up = await run("docker", ["compose", "-f", file, "up", "-d", "--force-recreate"], 300_000);
  if (up.code !== 0)
    return { ok: false, detail: `Compose could not start it: ${up.out.trim().slice(-400)}` };
  const want = await composeServices(run, file);
  let last = "";
  for (let i = 0; i < 24; i++) {
    await wait(5_000);
    const ps = await run("docker", ["compose", "-f", file, "ps", "-a", "--format", "json"], 30_000);
    const rows: PsRow[] = ps.out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{"))
      .map((l) => {
        try {
          return JSON.parse(l) as PsRow;
        } catch {
          return {};
        }
      });
    const notUp = want.filter((s) => {
      const r = rows.find((x) => x.Service === s);
      return !r || r.State !== "running" || r.Health === "starting" || r.Health === "unhealthy";
    });
    last = notUp
      .map((s) => {
        const r = rows.find((x) => x.Service === s);
        return `${s} ${r ? (r.Health ? `${r.State}, ${r.Health}` : r.State) : "missing"}`;
      })
      .join("; ");
    if (!notUp.length) return { ok: true, detail: `${want.join(", ")} recreated and running.` };
  }
  return { ok: false, detail: `Not all came back within two minutes: ${last}.` };
}

/** The address the internet sees from inside a VPN container (asked from inside it). */
export async function exitAddress(exec: ContainerExec, container: string) {
  for (const url of ["https://ipinfo.io/ip", "https://api.ipify.org"]) {
    const r = await exec
      .exec(container, ["wget", "-qO-", "-T", "10", url], 20_000)
      .catch(() => undefined);
    const ip = r?.exitCode === 0 ? r.output.trim() : "";
    if (/^[0-9a-f.:]{3,45}$/i.test(ip)) return ip;
  }
  return undefined;
}

export interface VpnServer {
  name: string;
  country: string;
  city: string;
  hostname: string;
  ip: string;
  publicKey: string;
  portForward: boolean;
  streaming: boolean;
}

interface GluetunEntry {
  vpn?: string;
  country?: string;
  city?: string;
  server_name?: string;
  hostname?: string;
  wgpubkey?: string;
  port_forward?: boolean;
  stream?: boolean;
  secure_core?: boolean;
  tor?: boolean;
  ips?: string[];
}

/** ProtonVPN's WireGuard servers, from the list Gluetun itself ships (no account login needed). */
export async function protonServers(exec: ContainerExec, container: string): Promise<VpnServer[]> {
  const r = await exec.exec(container, ["cat", "/gluetun/servers/protonvpn.json"], 30_000);
  if (r.exitCode !== 0) throw new Error("Gluetun's ProtonVPN server list could not be read.");
  const start = r.output.indexOf("{");
  const data = JSON.parse(r.output.slice(start)) as { servers?: GluetunEntry[] };
  return (data.servers ?? [])
    .filter((s) => s.vpn === "wireguard" && s.wgpubkey && s.ips?.[0] && !s.secure_core && !s.tor)
    .map((s) => ({
      name: s.server_name ?? s.hostname ?? "",
      country: s.country ?? "",
      city: s.city ?? "",
      hostname: s.hostname ?? "",
      ip: s.ips![0]!,
      publicKey: s.wgpubkey!,
      portForward: Boolean(s.port_forward),
      streaming: Boolean(s.stream),
    }));
}

/** The server a custom WireGuard Compose file points at now (address only; keys are not read). */
export function currentEndpoint(compose: string): string | undefined {
  return /^\s*-?\s*WIREGUARD_ENDPOINT_IP\s*[=:]\s*["']?([0-9a-f.:]+)/im.exec(compose)?.[1];
}

/**
 * The edits that point a custom WireGuard setup at another server: its address and its public key,
 * each line found exactly once. The private key and addresses are left as they are (Proton's keys
 * work with any of its servers).
 */
export function switchEdits(
  compose: string,
  to: VpnServer,
): { find: string; replace: string }[] | string {
  if (!/^\s*-?\s*VPN_SERVICE_PROVIDER\s*[=:]\s*["']?custom/im.test(compose))
    return "This Gluetun is not set up with its own WireGuard server (VPN_SERVICE_PROVIDER=custom), so there is no server line to switch.";
  const edits: { find: string; replace: string }[] = [];
  for (const [key, value] of [
    ["WIREGUARD_ENDPOINT_IP", to.ip],
    ["WIREGUARD_PUBLIC_KEY", to.publicKey],
  ] as const) {
    const re = new RegExp(`^(\\s*-?\\s*${key}\\s*[=:]\\s*["']?)([^"'\\s]+)(["']?)\\s*$`, "gm");
    const found = [...compose.matchAll(re)];
    if (found.length !== 1)
      return `${key} appears ${found.length} times in the Compose file, so the switch is not clear-cut.`;
    const m = found[0]!;
    edits.push({ find: m[0], replace: `${m[1]}${value}${m[3]}` });
  }
  return edits;
}

/** The Caddy container a file is mounted into, and where it sits inside it. */
export async function caddyFor(
  mountsOf: (c: string) => Promise<{ source: string; destination: string }[]>,
  run: Runner,
  file: string,
): Promise<{ container: string; inside: string } | undefined> {
  const r = await run("docker", ["ps", "--format", "{{.Names}}\t{{.Image}}"], 20_000);
  for (const line of r.out.split("\n")) {
    const [name, image] = line.split("\t");
    if (!name || !/caddy/i.test(`${name} ${image ?? ""}`)) continue;
    const mounts = await mountsOf(name).catch(() => []);
    for (const m of mounts) {
      if (m.source === file) return { container: name, inside: m.destination };
      if (file.startsWith(`${m.source.replace(/\/$/, "")}/`))
        return {
          container: name,
          inside: path.posix.join(m.destination, file.slice(m.source.length)),
        };
    }
  }
  return undefined;
}

/** Caddy's own check of a candidate Caddyfile, copied into the container's /tmp first. */
export async function caddyValid(
  exec: ContainerExec,
  container: string,
  content: string,
): Promise<string | undefined> {
  await exec.putFile(container, "/tmp", "Caddyfile.dc-check", Buffer.from(content));
  const r = await exec.exec(
    container,
    ["caddy", "validate", "--adapter", "caddyfile", "--config", "/tmp/Caddyfile.dc-check"],
    60_000,
  );
  await exec
    .exec(container, ["rm", "-f", "/tmp/Caddyfile.dc-check"], 15_000)
    .catch(() => undefined);
  return r.exitCode === 0
    ? undefined
    : r.output.trim().split("\n").slice(-3).join(" ").slice(0, 400);
}

export async function caddyReload(exec: ContainerExec, container: string, inside: string) {
  const r = await exec.exec(
    container,
    ["caddy", "reload", "--adapter", "caddyfile", "--config", inside],
    60_000,
  );
  return r.exitCode === 0
    ? { ok: true, detail: "Caddy reloaded with the new file." }
    : { ok: false, detail: `Caddy refused to reload: ${r.output.trim().slice(-300)}` };
}
