import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { networkInterfaces } from "node:os";
import si from "systeminformation";
import type { DiscoveryReport, PhysicalDisk, Volume } from "@dragon-control/core";
import { readDisks } from "./disks";
import { findMachines, neighboursOf, portOpen, type FoundMachine, type LanProbes } from "./lan";
import { analyzeContainers, findAppsAt, findNativeApps, type PageRead } from "./analyze";
import { connectDocker } from "./docker-client";
import { dockerVersion, listContainers, type ContainerInfo } from "./docker";

/** Everything discovery needs from the outside world, injectable for tests. */
export interface DiscoveryProbes {
  host: () => Promise<DiscoveryReport["host"]>;
  docker: () => Promise<
    { containers: ContainerInfo[]; version?: string; endpoint: string } | { error: string }
  >;
  probeHttp: (port: number, host?: string) => Promise<boolean>;
  /** A page on another machine, to tell which app answers there (remote scans only). */
  readPage?: (port: number, host: string) => Promise<PageRead | null>;
  /** This machine's home network, for "find it for me". */
  lan?: Pick<LanProbes, "neighbours" | "portOpen">;
  disks: (hostId: string) => Promise<PhysicalDisk[]>;
}

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "host"
  );
}

const IGNORED_FS = /^(tmpfs|devtmpfs|overlay|squashfs|proc|sysfs|cgroup2?|nsfs|autofs|fuse\..*)$/i;

/**
 * This machine's LAN address. On Linux it comes straight from the kernel's
 * default route: systeminformation's interface scan inspects every virtual
 * interface and took 8.6 s on a Docker host with 48 containers.
 */
async function defaultAddress(): Promise<string | undefined> {
  if (process.platform === "linux") {
    try {
      const routes = readFileSync("/proc/net/route", "utf8").split(/\r?\n/).slice(1);
      const iface = routes.map((l) => l.trim().split(/\s+/)).find((c) => c[1] === "00000000")?.[0];
      const address = iface
        ? networkInterfaces()[iface]?.find((a) => a.family === "IPv4" && !a.internal)?.address
        : undefined;
      if (address) return address;
    } catch {
      // Fall through to the general method.
    }
  }
  const nic = await si.networkInterfaces("default");
  return (Array.isArray(nic) ? nic[0] : nic)?.ip4 || undefined;
}

async function probeLocalHost(): Promise<DiscoveryReport["host"]> {
  const [os, cpu, load, mem, time, fsSizes, address] = await Promise.all([
    si.osInfo(),
    si.cpu(),
    si.currentLoad(),
    si.mem(),
    Promise.resolve(si.time()),
    si.fsSize(),
    defaultAddress(),
  ]);
  const hostId = slug(os.hostname);
  const volumes: Volume[] = fsSizes
    .filter((f) => f.size > 1e9 && !IGNORED_FS.test(f.type))
    .map((f, i) => ({
      id: `${hostId}-${slug(f.mount) || `vol-${i}`}`,
      hostId,
      label: f.mount,
      mount: f.mount,
      kind: /^(nfs|cifs|smb)/i.test(f.type) ? "nas" : "disk",
      totalTb: f.size / 1e12,
      usedTb: f.used / 1e12,
      smart: "ok",
    }));
  return {
    id: hostId,
    name: os.hostname,
    role: "This machine",
    os: [os.distro, os.release].filter(Boolean).join(" "),
    address: address || "127.0.0.1",
    cpu: {
      model: [cpu.manufacturer, cpu.brand].filter(Boolean).join(" "),
      cores: cpu.cores,
      usagePct: Math.round(load.currentLoad),
    },
    memory: { totalGb: mem.total / 1e9, usedGb: mem.active / 1e9 },
    uptimeHours: time.uptime / 3600,
    connection: "this-machine",
    docker: false,
    volumes,
  };
}

/** One read-only GET to see whether a local port speaks HTTP. Any HTTP answer counts. */
function probeHttp(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      // Generous: some self-hosted apps take several seconds to render their first page.
      { host, port, path: "/", method: "GET", timeout: 6000 },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

/**
 * One read-only GET of the page at a port on another machine, following its own redirects on the
 * same address (a sign-in page, /web/), keeping the first 64 KB: enough to tell which app it is.
 * Null when nothing speaks HTTP there.
 */
function readPage(port: number, host: string, path = "/", hops = 0): Promise<PageRead | null> {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path, method: "GET", timeout: 6000, headers: { accept: "text/html,*/*" } },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && hops < 3) {
          res.resume();
          let next: URL | undefined;
          try {
            next = new URL(
              location,
              `http://${host.includes(":") ? `[${host}]` : host}:${port}${path}`,
            );
          } catch {
            next = undefined;
          }
          // Only on the same address and port: never off to another site.
          if (next && next.protocol === "http:" && Number(next.port || 80) === port)
            return resolve(readPage(port, host, next.pathname + next.search, hops + 1));
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers))
          if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length >= 65_536) res.destroy();
        });
        const done = () => resolve({ status, headers, body: body.slice(0, 65_536) });
        res.on("end", done);
        res.on("close", done);
        res.on("error", done);
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

export const realProbes: DiscoveryProbes = {
  host: probeLocalHost,
  docker: async () => {
    const conn = await connectDocker();
    if ("error" in conn) return conn;
    const containers = await listContainers(conn.reader);
    return {
      containers,
      version: await dockerVersion(conn.reader),
      endpoint: conn.reader.endpoint,
    };
  },
  probeHttp,
  readPage: (port, host) => readPage(port, host),
  lan: {
    neighbours: async () => neighboursOf((await defaultAddress()) ?? ""),
    portOpen: (host, port) => portOpen(host, port),
  },
  disks: readDisks,
};

export async function runDiscovery(probes: DiscoveryProbes): Promise<DiscoveryReport> {
  const started = Date.now();
  const notes: string[] = [];
  // Docker first: the host probe can keep Node busy long enough to make a
  // healthy Docker look unresponsive if both run at once.
  const dockerResult = await probes.docker().catch((e: unknown) => ({
    error: `Docker could not be read: ${e instanceof Error ? e.message : String(e)}`,
  }));
  const host = await probes.host();

  const disks = await probes.disks(host.id).catch(() => {
    notes.push("Drive health could not be read on this machine.");
    return [] as PhysicalDisk[];
  });
  // A volume's drive type (SSD or hard drive) comes from the disk it lives on.
  const norm = (m: string) => m.replace(/[\\/]+$/, "").toLowerCase();
  const volumes = host.volumes.map((v) => {
    const disk = disks.find((d) => d.volumes.some((dv) => norm(dv) === norm(v.mount)));
    return disk && disk.type !== "unknown" && v.kind === "disk" ? { ...v, kind: disk.type } : v;
  });

  let containers: ContainerInfo[] = [];
  let docker: DiscoveryReport["docker"];
  if ("error" in dockerResult) {
    notes.push(dockerResult.error);
    docker = { available: false, error: dockerResult.error };
  } else {
    containers = dockerResult.containers;
    docker = { available: true, version: dockerResult.version, endpoint: dockerResult.endpoint };
  }

  const findings = [
    ...(await analyzeContainers({
      containers,
      hostAddress: host.address,
      probeHttp: probes.probeHttp,
    })),
    ...(await findNativeApps({
      containers,
      hostAddress: host.address,
      probeHttp: probes.probeHttp,
    })),
  ];

  return {
    id: randomUUID(),
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    host: { ...host, volumes, docker: docker.available },
    docker,
    disks,
    findings,
    notes,
  };
}

/**
 * Another machine on your network or tailnet, without installing anything
 * on it: which well-known apps answer at its address. Its processor,
 * memory, and drives are not visible this way.
 */
export async function runRemoteDiscovery(
  probes: Pick<DiscoveryProbes, "probeHttp" | "readPage">,
  input: { address: string; name: string },
): Promise<DiscoveryReport> {
  const started = Date.now();
  const id = slug(input.name);
  const findings = await findAppsAt({
    hostId: id,
    hostName: input.name,
    address: input.address,
    probeHttp: probes.probeHttp,
    readPage: probes.readPage,
  });
  return {
    id: randomUUID(),
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    host: {
      id,
      name: input.name,
      role: "Another machine",
      os: "Seen over the network",
      address: input.address,
      cpu: { model: "", cores: 0, usagePct: 0 },
      memory: { totalGb: 0, usedGb: 0 },
      uptimeHours: 0,
      connection: "network",
      docker: false,
      volumes: [],
    },
    docker: { available: false },
    disks: [],
    findings,
    notes: findings.length
      ? []
      : [
          probes.readPage
            ? `No app Hearth knows answered at ${input.address} on its usual port. Check the address, and that its firewall lets this machine in. An app on another port can be added by its address (Add a system).`
            : `Nothing answered at ${input.address} on the usual ports for Plex, Jellyfin, Home Assistant, or Syncthing. Check the address, and that its firewall lets this machine in.`,
        ],
  };
}

/** "Find it for me": the NAS and app machines on the home network (see lan.ts). */
export async function runFindMachines(
  probes: Pick<DiscoveryProbes, "readPage" | "lan">,
): Promise<FoundMachine[]> {
  if (!probes.readPage || !probes.lan) return [];
  return findMachines({ ...probes.lan, readPage: probes.readPage });
}
