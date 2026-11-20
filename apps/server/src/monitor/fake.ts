import { FAKE_CONTAINERS, fakeProbes } from "../discovery/fake";
import { sanitizeConfig } from "../actions/container-config";
import type { ContainerTools } from "../actions/tools";
import type { ContainerState, HttpResult, MonitorProbes } from "./probes";

/**
 * Monitoring's view of the synthetic homelab used by tests. Tests can take
 * containers or web addresses down and bring them back, and see which
 * restarts Hearth asked for.
 */
/** Stopped containers, with how they exited (none: unknown, as with older Docker data). */
const stoppedContainers = new Map<string, number | undefined>();
/** Web addresses that fail, and the container whose restart fixes them. */
const downUrls = new Map<string, string | undefined>();
/** Containers in a crash loop: their restart count climbs on every look. */
const crashLooping = new Map<string, number>();
/** Containers a restart does not help. */
const stuck = new Set<string>();
const sandboxes = new Set<string>();
const restarts: string[] = [];
const mounts = new Map<string, { source: string; destination: string }[]>();
/** Every start and stop requested, in order ("start:sonarr"). */
const power: string[] = [];
/** When each container last started (stable between looks), and how often Docker restarted it. */
const started = new Map<string, string>();
const dockerRestarts = new Map<string, number>();
const BOOT = new Date(Date.now() - 3 * 86_400_000).toISOString();
const startNow = (name: string) => started.set(name, new Date().toISOString());
const stoppedAt = new Map<string, string>();

export const fakeOutages = {
  /** Exit code 0 or 143 looks like someone stopped it; anything else like a crash. */
  stopContainer: (name: string, exitCode?: number) => {
    stoppedAt.set(name, new Date().toISOString());
    stoppedContainers.set(name, exitCode);
  },
  failUrl: (url: string, fixedByRestarting?: string) => downUrls.set(url, fixedByRestarting),
  crashLoop: (name: string) => crashLooping.set(name, 100),
  /** A restart of this container will not fix it. */
  stuck: (name: string) => stuck.add(name),
  markSandbox: (name: string) => sandboxes.add(name),
  /** A volume for a container, as Docker would report it. */
  mount: (name: string, source: string, destination: string) =>
    mounts.set(name, [...(mounts.get(name) ?? []), { source, destination }]),
  /** Every restart requested so far, in order. */
  restarts: () => [...restarts],
  power: () => [...power],
  /** Docker's restart policy brought it back after it exited (restart count goes up). */
  dockerRestarted: (name: string) => {
    dockerRestarts.set(name, (dockerRestarts.get(name) ?? 0) + 1);
    startNow(name);
  },
  restoreAll: () => {
    started.clear();
    dockerRestarts.clear();
    stoppedAt.clear();
    stoppedContainers.clear();
    downUrls.clear();
    crashLooping.clear();
    stuck.clear();
    sandboxes.clear();
    restarts.length = 0;
    power.length = 0;
    mounts.clear();
  },
};

export const fakeMonitorProbes: MonitorProbes = {
  async containers() {
    const map = new Map<string, ContainerState>();
    for (const c of FAKE_CONTAINERS) {
      const count = crashLooping.get(c.name);
      if (count !== undefined) crashLooping.set(c.name, count + 3);
      map.set(c.name, {
        state: stoppedContainers.has(c.name) ? "stopped" : c.state,
        ...(stoppedContainers.get(c.name) !== undefined
          ? { exitCode: stoppedContainers.get(c.name) }
          : {}),
        health: c.healthcheck,
        restartCount: count ?? 0,
      });
    }
    return map;
  },
  async inventory() {
    return FAKE_CONTAINERS.map((c) => {
      const stopped = stoppedContainers.has(c.name);
      const exitCode = stoppedContainers.get(c.name);
      return {
        name: c.name,
        image: c.image,
        imageId: `sha256:${c.name.padEnd(12, "0").slice(0, 12)}`,
        state: stopped ? ("stopped" as const) : c.state,
        ...(c.healthcheck && !stopped ? { health: c.healthcheck } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        statusText: stopped
          ? `Exited (${exitCode ?? 0}) 1 minute ago`
          : `Up 3 days${c.healthcheck ? ` (${c.healthcheck})` : ""}`,
        createdAt: BOOT,
        ...(c.composeProject ? { composeProject: c.composeProject } : {}),
      };
    });
  },
  async http(url): Promise<HttpResult> {
    return downUrls.has(url)
      ? { ok: false, ms: 5000, error: "connection refused" }
      : { ok: true, status: 200, ms: 25 };
  },
  async host() {
    return {
      cpuPct: 9,
      memUsedGb: 10.1,
      uptimeHours: 121,
      volumes: [],
    };
  },
  disks: fakeProbes.disks,
};

/** Samples taken per fake container, for steadily rising counters. */
const fakeTicks = new Map<string, number>();

export const fakeContainerTools: ContainerTools = {
  async runtime(name) {
    if (!FAKE_CONTAINERS.some((c) => c.name === name)) return undefined;
    const running = !stoppedContainers.has(name);
    return {
      running,
      startedAt: running ? new Date(Date.now() - 3 * 86_400_000).toISOString() : undefined,
      restartCount: 0,
      ports: running ? ["8080 -> 80/tcp"] : [],
      cpuPct: running ? 1.5 : undefined,
      memoryMb: running ? 256 : undefined,
      memoryLimitMb: running ? 4096 : undefined,
    };
  },
  async restart(name) {
    if (!FAKE_CONTAINERS.some((c) => c.name === name)) {
      throw new Error("Docker has no container by that name any more.");
    }
    restarts.push(name);
    if (stuck.has(name)) return;
    startNow(name);
    stoppedContainers.delete(name);
    for (const [url, owner] of downUrls) if (owner === name) downUrls.delete(url);
  },
  async start(name) {
    if (!FAKE_CONTAINERS.some((c) => c.name === name)) {
      throw new Error("Docker has no container by that name any more.");
    }
    power.push(`start:${name}`);
    if (!stuck.has(name)) {
      stoppedContainers.delete(name);
      startNow(name);
    }
  },
  async stop(name) {
    if (!FAKE_CONTAINERS.some((c) => c.name === name)) {
      throw new Error("Docker has no container by that name any more.");
    }
    power.push(`stop:${name}`);
    stoppedAt.set(name, new Date().toISOString());
    stoppedContainers.set(name, 0);
  },
  async logs(name, tail, range) {
    const lines = [
      `[${name}] Starting up`,
      `[${name}] Connected with apikey=[hidden]`,
      `[${name}] Ready`,
    ];
    if (!range) return lines.slice(-tail);
    const at = (range.until ?? Date.now() / 1000) - 60;
    const stamp = new Date(at * 1000).toISOString().slice(0, 19);
    return lines.map((l) => `${stamp}Z ${l}`).slice(-tail);
  },
  async mounts(name) {
    return mounts.get(name) ?? [];
  },
  async counters(name) {
    if (!FAKE_CONTAINERS.some((c) => c.name === name) || stoppedContainers.has(name))
      return undefined;
    // Steady load: half a core busy, 256 MB, 1 MB read and 2 MB written per sample.
    fakeTicks.set(name, (fakeTicks.get(name) ?? 0) + 1);
    const n = fakeTicks.get(name)!;
    return {
      cpuTotal: n * 5e9,
      systemTotal: n * 40e9,
      onlineCpus: 4,
      memoryMb: 256,
      memoryLimitMb: 1024,
      readBytes: n * 1048576,
      writeBytes: n * 2097152,
    };
  },
  async config(name) {
    if (!FAKE_CONTAINERS.some((c) => c.name === name)) return undefined;
    return sanitizeConfig({
      Config: {
        Image: `example/${name}:latest`,
        Env: ["TZ=UTC", "API_KEY=never-shown", "PUID=1000"],
        Labels: { "com.docker.compose.project": "media" },
      },
      HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
      NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] } },
      Mounts: (mounts.get(name) ?? []).map((m) => ({
        Source: m.source,
        Destination: m.destination,
        RW: true,
      })),
    });
  },
  async facts(name) {
    if (!FAKE_CONTAINERS.some((c) => c.name === name)) return undefined;
    const restartCount = dockerRestarts.get(name) ?? 0;
    return stoppedContainers.has(name)
      ? {
          sandbox: sandboxes.has(name),
          exitCode: 137,
          oomKilled: true,
          running: false,
          restartCount,
          ...(stoppedAt.has(name) ? { finishedAt: stoppedAt.get(name) } : {}),
        }
      : {
          sandbox: sandboxes.has(name),
          exitCode: 0,
          running: true,
          startedAt: started.get(name) ?? BOOT,
          restartCount,
        };
  },
};
