import http from "node:http";
import { connectDocker } from "../discovery/docker-client";
import { sanitizeConfig, type ContainerConfig, type InspectForConfig } from "./container-config";
import { redactLine } from "./redact";

/**
 * The only ways Hearth can touch a container. Reading (logs, a few
 * state facts) uses the GET-only discovery client; the only changes it can
 * make are restart, start, and stop. Whether one is allowed is decided before
 * these are ever called (see actions/service.ts). Nothing here creates,
 * removes, pulls, or reconfigures a container.
 */

export interface ContainerFacts {
  /** Labelled `dragon-control.sandbox=true`: a disposable test container. */
  sandbox: boolean;
  exitCode?: number;
  oomKilled?: boolean;
  error?: string;
  /** When its previous run ended (while running) or its last run ended (while stopped). */
  finishedAt?: string;
  running?: boolean;
  /** When the current run started (running only). */
  startedAt?: string;
  /** Restarts by Docker's restart policy since the container was created. */
  restartCount?: number;
}

/** Live, read-only state for the workspace: never environment variables or mounts. */
export interface ContainerRuntime {
  running: boolean;
  startedAt?: string;
  restartCount?: number;
  ports: string[];
  cpuPct?: number;
  memoryMb?: number;
  memoryLimitMb?: number;
}

export interface ContainerTools {
  restart(name: string): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  runtime(name: string): Promise<ContainerRuntime | undefined>;
  /**
   * Recent log lines, oldest first, already redacted. With a range, only lines
   * written in it (Docker's own since/until), each starting with its time.
   */
  logs(name: string, tail: number, range?: LogRange): Promise<string[]>;
  facts(name: string): Promise<ContainerFacts | undefined>;
  /** Where its volumes come from on this machine (source and destination paths only). */
  mounts(name: string): Promise<{ source: string; destination: string }[]>;
  /** Configuration with secrets left out (environment by name only). See container-config.ts. */
  config(name: string): Promise<ContainerConfig | undefined>;
  /** CPU, memory, and disk counters right now (one quick read), for resource history. */
  counters(name: string): Promise<ContainerCounters | undefined>;
}

/** A time window for logs, in Unix seconds, read by Docker itself (nothing is stored). */
export interface LogRange {
  since?: number;
  until?: number;
}

export const SANDBOX_LABEL = "dragon-control.sandbox";
const MAX_LINE = 500;

/** Docker multiplexes stdout/stderr with 8-byte frame headers unless the container has a TTY. */
export function demuxLogs(buf: Buffer): string {
  const framed = buf.length >= 8 && buf[0]! <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!framed) return buf.toString("utf8");
  const parts: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    parts.push(buf.subarray(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return Buffer.concat(parts).toString("utf8");
}

export function toLogLines(text: string, tail: number, timed = false): string[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(-tail)
    .map((l) => {
      // Docker's timestamp (RFC 3339 with nanoseconds), shortened to the second.
      const m = timed ? /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\S*\s(.*)$/.exec(l) : null;
      const body = m ? m[2]! : l;
      const clean = redactLine(body);
      const cut = clean.length > MAX_LINE ? `${clean.slice(0, MAX_LINE)}...` : clean;
      return m ? `${m[1]}Z ${cut}` : cut;
    });
}

const VERB_TEXT = { restart: "restart", start: "start", stop: "stop" } as const;

/** POST restart, start, or stop. 304 ("already started/stopped") counts as done. */
function postContainer(
  socketPath: string,
  name: string,
  verb: keyof typeof VERB_TEXT,
): Promise<void> {
  const path = `/containers/${encodeURIComponent(name)}/${verb}${verb === "start" ? "" : "?t=10"}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method: "POST", timeout: 60_000 }, (res) => {
      res.resume();
      res.on("end", () => {
        const code = res.statusCode ?? 500;
        if (code === 204 || (code === 304 && verb !== "restart")) resolve();
        else if (code === 404) reject(new Error("Docker has no container by that name any more."));
        else reject(new Error(`Docker refused the ${VERB_TEXT[verb]} (${code}).`));
      });
    });
    req.on("timeout", () =>
      req.destroy(new Error(`Docker did not finish the ${VERB_TEXT[verb]} in time.`)),
    );
    req.on("error", reject);
    req.end();
  });
}

async function reader() {
  const conn = await connectDocker();
  if ("error" in conn) throw new Error(conn.error);
  return conn.reader;
}

type PortMap = Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;

/** "8096 -> 8096/tcp", one per published port, unpublished ones left out. */
export function publishedPorts(ports: PortMap | undefined): string[] {
  const out = new Set<string>();
  for (const [inside, bindings] of Object.entries(ports ?? {})) {
    for (const b of bindings ?? []) if (b.HostPort) out.add(`${b.HostPort} -> ${inside}`);
  }
  return [...out].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

interface StatsSample {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: { inactive_file?: number; cache?: number };
  };
  blkio_stats?: {
    io_service_bytes_recursive?: { op?: string; value?: number }[] | null;
  };
}

/** Running counters for resource history: the history works out the change between samples. */
export interface ContainerCounters {
  cpuTotal: number;
  systemTotal: number;
  onlineCpus: number;
  memoryMb?: number;
  memoryLimitMb?: number;
  readBytes?: number;
  writeBytes?: number;
}

export function countersFromStats(s: StatsSample): ContainerCounters | undefined {
  const cpuTotal = s.cpu_stats?.cpu_usage?.total_usage;
  const systemTotal = s.cpu_stats?.system_cpu_usage;
  if (cpuTotal === undefined || systemTotal === undefined) return undefined;
  const io = s.blkio_stats?.io_service_bytes_recursive;
  const sum = (op: string) =>
    io?.length
      ? io.filter((e) => e.op?.toLowerCase() === op).reduce((n, e) => n + (e.value ?? 0), 0)
      : undefined;
  const usage = s.memory_stats?.usage;
  const cache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.cache ?? 0;
  return {
    cpuTotal,
    systemTotal,
    onlineCpus: s.cpu_stats?.online_cpus ?? 1,
    ...(usage !== undefined ? { memoryMb: (usage - cache) / 1048576 } : {}),
    ...(s.memory_stats?.limit ? { memoryLimitMb: s.memory_stats.limit / 1048576 } : {}),
    ...(io?.length ? { readBytes: sum("read"), writeBytes: sum("write") } : {}),
  };
}

/** CPU % and memory the way `docker stats` shows them. */
export function fromStats(s: StatsSample) {
  const cpuDelta =
    (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
  const cpus = s.cpu_stats?.online_cpus ?? 1;
  const cpuPct = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * cpus * 100 : undefined;
  const usage = s.memory_stats?.usage;
  const cache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.cache ?? 0;
  return {
    cpuPct: cpuPct === undefined ? undefined : Math.round(cpuPct * 10) / 10,
    memoryMb: usage === undefined ? undefined : Math.round((usage - cache) / 1048576),
    memoryLimitMb: s.memory_stats?.limit ? Math.round(s.memory_stats.limit / 1048576) : undefined,
  };
}

export const realContainerTools: ContainerTools = {
  async restart(name) {
    const r = await reader();
    await postContainer(r.endpoint, name, "restart");
  },
  async start(name) {
    const r = await reader();
    await postContainer(r.endpoint, name, "start");
  },
  async stop(name) {
    const r = await reader();
    await postContainer(r.endpoint, name, "stop");
  },
  async runtime(name) {
    const r = await reader();
    const id = encodeURIComponent(name);
    const info = await r
      .get<{
        State?: { Running?: boolean; StartedAt?: string };
        RestartCount?: number;
        NetworkSettings?: { Ports?: PortMap };
      }>(`/containers/${id}/json`)
      .catch(() => undefined);
    if (!info) return undefined;
    // Only state, restart count, and published ports are read from the inspect response.
    const running = info.State?.Running ?? false;
    const stats = running
      ? await r.get<StatsSample>(`/containers/${id}/stats?stream=false`).catch(() => undefined)
      : undefined;
    return {
      running,
      startedAt: running ? info.State?.StartedAt : undefined,
      restartCount: info.RestartCount,
      ports: publishedPorts(info.NetworkSettings?.Ports),
      ...(stats ? fromStats(stats) : {}),
    };
  },
  async logs(name, tail, range) {
    const r = await reader();
    const timed = range !== undefined;
    const window =
      (range?.since !== undefined ? `&since=${Math.floor(range.since)}` : "") +
      (range?.until !== undefined ? `&until=${Math.floor(range.until)}` : "");
    const buf = await r.getRaw(
      `/containers/${encodeURIComponent(name)}/logs?stdout=1&stderr=1&timestamps=${timed ? 1 : 0}&tail=${tail}${window}`,
    );
    return toLogLines(demuxLogs(buf), tail, timed);
  },
  async facts(name) {
    const r = await reader();
    const info = await r
      .get<{
        State?: {
          ExitCode?: number;
          OOMKilled?: boolean;
          Error?: string;
          FinishedAt?: string;
          Running?: boolean;
          StartedAt?: string;
        };
        RestartCount?: number;
        Config?: { Labels?: Record<string, string> | null };
      }>(`/containers/${encodeURIComponent(name)}/json`)
      .catch(() => undefined);
    if (!info) return undefined;
    // Only these fields are read; nothing else from the inspect response is kept.
    const finished = info.State?.FinishedAt;
    return {
      sandbox: info.Config?.Labels?.[SANDBOX_LABEL] === "true",
      exitCode: info.State?.ExitCode,
      oomKilled: info.State?.OOMKilled,
      error: info.State?.Error || undefined,
      finishedAt: finished && !finished.startsWith("0001") ? finished : undefined,
      running: info.State?.Running ?? false,
      ...(info.State?.Running && info.State.StartedAt ? { startedAt: info.State.StartedAt } : {}),
      ...(info.RestartCount !== undefined ? { restartCount: info.RestartCount } : {}),
    };
  },
  async mounts(name) {
    const r = await reader();
    const info = await r
      .get<{
        Mounts?: { Source?: string; Destination?: string }[];
      }>(`/containers/${encodeURIComponent(name)}/json`)
      .catch(() => undefined);
    // Only the paths are read.
    return (info?.Mounts ?? [])
      .filter((m) => m.Source && m.Destination)
      .map((m) => ({ source: m.Source!, destination: m.Destination! }));
  },
  async config(name) {
    const r = await reader();
    const info = await r
      .get<InspectForConfig>(`/containers/${encodeURIComponent(name)}/json`)
      .catch(() => undefined);
    if (!info) return undefined;
    // From the image only its build time is read.
    const image = info.Image
      ? await r
          .get<{ Created?: string }>(`/images/${encodeURIComponent(info.Image)}/json`)
          .catch(() => undefined)
      : undefined;
    return sanitizeConfig(info, image?.Created);
  },
  async counters(name) {
    const r = await reader();
    // one-shot: answers at once instead of waiting for a second sample.
    const stats = await r
      .get<StatsSample>(`/containers/${encodeURIComponent(name)}/stats?stream=false&one-shot=true`)
      .catch(() => undefined);
    return stats ? countersFromStats(stats) : undefined;
  },
};
