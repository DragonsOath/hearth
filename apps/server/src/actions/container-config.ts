import { redactLine } from "./redact";

/**
 * A container's configuration with every value that could hold a secret left
 * out: environment variables by name only, no command line, no labels except
 * the compose project, the health check as its timing only. Built from Docker's
 * inspect response by picking fields, never by copying it and deleting some.
 */
export interface ContainerConfig {
  image: string;
  imageId?: string;
  /** When the image was built (from the image itself). */
  imageCreated?: string;
  created?: string;
  restartPolicy: string;
  /** Times only; the command is left out because it can carry a password. */
  healthCheck?: {
    configured: true;
    intervalSeconds?: number;
    timeoutSeconds?: number;
    retries?: number;
  };
  ports: string[];
  mounts: { source: string; destination: string; type?: string; readOnly: boolean }[];
  networks: string[];
  networkMode?: string;
  limits: { memoryMb?: number; cpus?: number; pidsLimit?: number };
  composeProject?: string;
  composeService?: string;
  /** Names only, sorted. The values are never read into the result. */
  environmentNames: string[];
  /**
   * The few settings whose value is a plain file or folder path inside the container (a name
   * ending in FILE, PATH or DIR, an absolute path with no spaces): where an app keeps a file.
   * Anything else in the environment stays out.
   */
  pathSettings: Record<string, string>;
  privileged: boolean;
  addedCapabilities: string[];
  devices: string[];
}

/** The parts of `GET /containers/{id}/json` that are read. */
export interface InspectForConfig {
  Image?: string;
  Created?: string;
  Config?: {
    Image?: string;
    Env?: string[] | null;
    Labels?: Record<string, string> | null;
    Healthcheck?: { Interval?: number; Timeout?: number; Retries?: number; Test?: string[] } | null;
  };
  HostConfig?: {
    RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
    NetworkMode?: string;
    Memory?: number;
    NanoCpus?: number;
    PidsLimit?: number | null;
    Privileged?: boolean;
    CapAdd?: string[] | null;
    Devices?: { PathOnHost?: string; PathInContainer?: string }[] | null;
  };
  NetworkSettings?: {
    Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;
    Networks?: Record<string, unknown> | null;
  };
  Mounts?: { Type?: string; Source?: string; Destination?: string; RW?: boolean }[];
}

const seconds = (ns?: number) => (ns ? Math.round(ns / 1e9) : undefined);

export function sanitizeConfig(info: InspectForConfig, imageCreated?: string): ContainerConfig {
  const policy = info.HostConfig?.RestartPolicy;
  const hc = info.Config?.Healthcheck;
  const hasHealth = !!hc?.Test?.length && hc.Test[0] !== "NONE";
  const labels = info.Config?.Labels ?? {};
  const ports = Object.entries(info.NetworkSettings?.Ports ?? {}).flatMap(([inside, binds]) =>
    binds?.length
      ? binds.map(
          (b) =>
            `${b.HostIp && b.HostIp !== "0.0.0.0" ? `${b.HostIp}:` : ""}${b.HostPort} -> ${inside}`,
        )
      : [`${inside} (not published)`],
  );
  return {
    image: info.Config?.Image ?? "unknown",
    ...(info.Image ? { imageId: info.Image.replace(/^sha256:/, "").slice(0, 12) } : {}),
    ...(imageCreated ? { imageCreated } : {}),
    ...(info.Created ? { created: info.Created } : {}),
    restartPolicy:
      policy?.Name && policy.Name !== "no"
        ? `${policy.Name}${policy.Name === "on-failure" && policy.MaximumRetryCount ? ` (${policy.MaximumRetryCount} tries)` : ""}`
        : "no (does not restart by itself)",
    ...(hasHealth
      ? {
          healthCheck: {
            configured: true as const,
            intervalSeconds: seconds(hc?.Interval),
            timeoutSeconds: seconds(hc?.Timeout),
            retries: hc?.Retries,
          },
        }
      : {}),
    ports,
    // Paths can carry a credential in a URL-like source (rare); redact like log lines.
    mounts: (info.Mounts ?? [])
      .filter((m) => m.Destination)
      .map((m) => ({
        source: redactLine(m.Source ?? ""),
        destination: m.Destination!,
        ...(m.Type ? { type: m.Type } : {}),
        readOnly: m.RW === false,
      })),
    networks: Object.keys(info.NetworkSettings?.Networks ?? {}),
    ...(info.HostConfig?.NetworkMode ? { networkMode: info.HostConfig.NetworkMode } : {}),
    limits: {
      ...(info.HostConfig?.Memory
        ? { memoryMb: Math.round(info.HostConfig.Memory / 1048576) }
        : {}),
      ...(info.HostConfig?.NanoCpus ? { cpus: info.HostConfig.NanoCpus / 1e9 } : {}),
      ...(info.HostConfig?.PidsLimit ? { pidsLimit: info.HostConfig.PidsLimit } : {}),
    },
    ...(labels["com.docker.compose.project"]
      ? { composeProject: labels["com.docker.compose.project"] }
      : {}),
    ...(labels["com.docker.compose.service"]
      ? { composeService: labels["com.docker.compose.service"] }
      : {}),
    // Only the part before "=" ever leaves this line.
    environmentNames: [
      ...new Set((info.Config?.Env ?? []).map((e) => e.split("=", 1)[0]!).filter(Boolean)),
    ].sort(),
    pathSettings: Object.fromEntries(
      (info.Config?.Env ?? [])
        .map((e) => [e.split("=", 1)[0]!, e.slice(e.indexOf("=") + 1)] as const)
        .filter(([k, v]) => /(FILE|PATH|DIR)$/.test(k) && /^\/[\w./-]{0,300}$/.test(v)),
    ),
    privileged: info.HostConfig?.Privileged === true,
    addedCapabilities: info.HostConfig?.CapAdd ?? [],
    devices: (info.HostConfig?.Devices ?? [])
      .filter((d) => d.PathOnHost)
      .map((d) => `${d.PathOnHost} -> ${d.PathInContainer ?? d.PathOnHost}`),
  };
}
