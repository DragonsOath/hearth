import http from "node:http";
import https from "node:https";
import si from "systeminformation";
import type { PhysicalDisk } from "@dragon-control/core";
import { readDisks } from "../discovery/disks";
import { connectDocker } from "../discovery/docker-client";

/**
 * Read-only observations monitoring is built on. Nothing here can start,
 * stop, or change anything: Docker is asked for its container list, web
 * services get a plain GET, and the host reports its own metrics.
 */

export interface ContainerState {
  state: "running" | "stopped" | "restarting" | "paused";
  health?: "healthy" | "unhealthy" | "starting";
  /** How many times Docker has restarted it; a rising count means a crash loop. */
  restartCount?: number;
  /** For a stopped container: how its last run ended (0 or 143 = asked to stop). */
  exitCode?: number;
}

export interface HttpResult {
  ok: boolean;
  status?: number;
  ms: number;
  error?: string;
}

export interface HostMetrics {
  cpuPct: number;
  memUsedGb: number;
  uptimeHours: number;
  /** Used space per mount point, in TB. */
  volumes: { mount: string; usedTb: number; totalTb: number }[];
}

/** Every container on this machine, watched or not, from Docker's list (no inspect). */
export interface ContainerInventoryItem {
  name: string;
  image: string;
  imageId?: string;
  state: ContainerState["state"];
  health?: ContainerState["health"];
  exitCode?: number;
  /** Docker's own words: "Up 3 days (healthy)", "Exited (1) 2 weeks ago". */
  statusText: string;
  createdAt?: string;
  composeProject?: string;
}

export interface MonitorProbes {
  /** Container states by name, or why Docker could not be read. */
  containers(): Promise<Map<string, ContainerState> | { error: string }>;
  /** All containers (for findings about ones Hearth does not watch). */
  inventory?(): Promise<ContainerInventoryItem[] | { error: string }>;
  http(url: string): Promise<HttpResult>;
  host(): Promise<HostMetrics | undefined>;
  disks(hostId: string): Promise<PhysicalDisk[]>;
}

interface RawContainer {
  Id?: string;
  Names?: string[];
  State?: string;
  Status?: string;
  Image?: string;
  ImageID?: string;
  Created?: number;
  Labels?: Record<string, string>;
}

/** "Up 2 weeks (healthy)" -> healthy. Exported for tests. */
export function parseContainer(raw: RawContainer): ContainerState {
  const state =
    raw.State === "running"
      ? "running"
      : raw.State === "restarting"
        ? "restarting"
        : raw.State === "paused"
          ? "paused"
          : "stopped";
  const match = /\((healthy|unhealthy|health: starting)\)/.exec(raw.Status ?? "");
  const health = match
    ? match[1] === "health: starting"
      ? "starting"
      : (match[1] as "healthy" | "unhealthy")
    : undefined;
  const exited = /Exited \((\d+)\)/.exec(raw.Status ?? "");
  return { state, health, ...(exited ? { exitCode: Number(exited[1]) } : {}) };
}

export function httpCheck(url: string, timeoutMs = 5000): Promise<HttpResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      resolve({ ok: false, ms: 0, error: "not a valid address" });
      return;
    }
    const lib = target.protocol === "https:" ? https : http;
    const req = lib.request(
      target,
      // Self-signed certificates are normal on a homelab; we only ask "are you there?".
      { method: "GET", timeout: timeoutMs, rejectUnauthorized: false },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        resolve({ ok: status > 0 && status < 500, status, ms: Date.now() - started });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (e) =>
      resolve({
        ok: false,
        ms: Date.now() - started,
        error: /timed out/.test(e.message)
          ? `no answer within ${timeoutMs / 1000}s`
          : (e as NodeJS.ErrnoException).code === "ECONNREFUSED"
            ? "connection refused"
            : e.message,
      }),
    );
    req.end();
  });
}

export const realMonitorProbes: MonitorProbes = {
  async containers() {
    const conn = await connectDocker();
    if ("error" in conn) return conn;
    const list = await conn.reader.get<RawContainer[]>("/containers/json?all=true");
    const map = new Map<string, ContainerState>();
    await Promise.all(
      list.map(async (c) => {
        const name = c.Names?.[0]?.replace(/^\//, "");
        if (!name) return;
        const state = parseContainer(c);
        // Restart counts only come from inspect; only that field is read.
        if (c.Id) {
          const info = await conn.reader
            .get<{ RestartCount?: number }>(`/containers/${encodeURIComponent(c.Id)}/json`)
            .catch(() => undefined);
          state.restartCount = info?.RestartCount;
        }
        map.set(name, state);
      }),
    );
    return map;
  },
  async inventory() {
    const conn = await connectDocker();
    if ("error" in conn) return conn;
    const list = await conn.reader.get<RawContainer[]>("/containers/json?all=true");
    return list.flatMap((c) => {
      const name = c.Names?.[0]?.replace(/^\//, "");
      if (!name) return [];
      const state = parseContainer(c);
      return [
        {
          name,
          image: c.Image ?? "",
          ...(c.ImageID ? { imageId: c.ImageID } : {}),
          state: state.state,
          ...(state.health ? { health: state.health } : {}),
          ...(state.exitCode !== undefined ? { exitCode: state.exitCode } : {}),
          statusText: c.Status ?? "",
          ...(c.Created ? { createdAt: new Date(c.Created * 1000).toISOString() } : {}),
          ...(c.Labels?.["com.docker.compose.project"]
            ? { composeProject: c.Labels["com.docker.compose.project"] }
            : {}),
        },
      ];
    });
  },
  http: (url) => httpCheck(url),
  async host() {
    const [load, mem, fsSizes] = await Promise.all([si.currentLoad(), si.mem(), si.fsSize()]);
    return {
      cpuPct: Math.round(load.currentLoad),
      memUsedGb: mem.active / 1e9,
      uptimeHours: si.time().uptime / 3600,
      volumes: fsSizes.map((f) => ({
        mount: f.mount,
        usedTb: f.used / 1e12,
        totalTb: f.size / 1e12,
      })),
    };
  },
  disks: readDisks,
};
