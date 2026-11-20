import type { DockerReader } from "./docker-client";

/**
 * The only container facts discovery keeps. Built field by field from the
 * Docker API response, so anything not listed here (notably Config.Env,
 * where API keys and passwords live) is dropped before it can be stored,
 * logged, or shown.
 */
export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: "running" | "stopped" | "restarting" | "paused";
  /** Docker healthcheck result, when the image defines one. */
  healthcheck?: "healthy" | "unhealthy" | "starting";
  /** "container:<id>" when sharing another container's network (e.g. behind a VPN). */
  networkMode?: string;
  bindings: PortBinding[];
  exposedPorts: number[];
  composeProject?: string;
  composeService?: string;
  composeDependsOn: string[];
}

export interface PortBinding {
  privatePort: number;
  publicPort: number;
  /** Interface the port is published on; "127.0.0.1" means this machine only. */
  ip: string;
  protocol: "tcp" | "udp";
}

interface RawListItem {
  Id: string;
  Names?: string[];
  Image: string;
  State?: string;
}

interface RawInspect {
  Id: string;
  Name?: string;
  Config?: {
    Image?: string;
    ExposedPorts?: Record<string, unknown> | null;
    Labels?: Record<string, string> | null;
  };
  State?: { Status?: string; Health?: { Status?: string } | null };
  HostConfig?: { NetworkMode?: string };
  NetworkSettings?: {
    Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;
  };
}

function mapState(status: string | undefined): ContainerInfo["state"] {
  if (status === "running") return "running";
  if (status === "restarting") return "restarting";
  if (status === "paused") return "paused";
  return "stopped";
}

function parsePortKey(key: string): { port: number; protocol: "tcp" | "udp" } | undefined {
  const [port, protocol] = key.split("/");
  const n = Number(port);
  if (!Number.isInteger(n)) return undefined;
  return { port: n, protocol: protocol === "udp" ? "udp" : "tcp" };
}

/** Converts one inspect response into ContainerInfo. Exported for tests. */
export function toContainerInfo(raw: RawInspect, image: string): ContainerInfo {
  const labels = raw.Config?.Labels ?? {};
  const bindings: PortBinding[] = [];
  const seen = new Set<string>();
  for (const [key, hostPorts] of Object.entries(raw.NetworkSettings?.Ports ?? {})) {
    const parsed = parsePortKey(key);
    if (!parsed || !hostPorts) continue;
    for (const hp of hostPorts) {
      const publicPort = Number(hp.HostPort);
      if (!Number.isInteger(publicPort) || publicPort <= 0) continue;
      // Docker lists IPv4 and IPv6 separately; keep one binding per port and interface class.
      const ip = hp.HostIp === "::" || !hp.HostIp ? "0.0.0.0" : hp.HostIp;
      const dedupe = `${parsed.port}/${parsed.protocol}/${publicPort}/${ip}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      bindings.push({ privatePort: parsed.port, publicPort, ip, protocol: parsed.protocol });
    }
  }
  const exposedPorts = Object.keys(raw.Config?.ExposedPorts ?? {})
    .map(parsePortKey)
    .filter((p): p is { port: number; protocol: "tcp" | "udp" } => p?.protocol === "tcp")
    .map((p) => p.port);
  const health = raw.State?.Health?.Status;
  const dependsOn = (labels["com.docker.compose.depends_on"] ?? "")
    .split(",")
    .map((d) => d.split(":")[0]!.trim())
    .filter(Boolean);

  return {
    id: raw.Id,
    name: (raw.Name ?? raw.Id.slice(0, 12)).replace(/^\//, ""),
    image,
    state: mapState(raw.State?.Status),
    healthcheck:
      health === "healthy" || health === "unhealthy" || health === "starting" ? health : undefined,
    networkMode: raw.HostConfig?.NetworkMode,
    bindings,
    exposedPorts: [...new Set(exposedPorts)],
    composeProject: labels["com.docker.compose.project"],
    composeService: labels["com.docker.compose.service"],
    composeDependsOn: dependsOn,
  };
}

export async function listContainers(docker: DockerReader): Promise<ContainerInfo[]> {
  const list = await docker.get<RawListItem[]>("/containers/json?all=true");
  const results: ContainerInfo[] = [];
  for (const item of list) {
    const raw = await docker.get<RawInspect>(`/containers/${encodeURIComponent(item.Id)}/json`);
    // List.Image is the reference the user ran ("lscr.io/linuxserver/sonarr:latest");
    // inspect's Config.Image is the same. Prefer the human-readable one.
    results.push(toContainerInfo(raw, item.Image || raw.Config?.Image || ""));
  }
  return results;
}

export async function dockerVersion(docker: DockerReader): Promise<string | undefined> {
  const v = await docker.get<{ Version?: string }>("/version").catch(() => undefined);
  return v?.Version;
}
