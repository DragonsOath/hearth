import net from "node:net";
import { CATALOG } from "./catalog";
import { NAS_SYSTEMS, identifyPage, type PageRead } from "./analyze";

/**
 * "Find it for me": the machines on the home network that are a NAS or run apps Hearth knows,
 * for someone who doesn't know their NAS's address. Each neighbour on this machine's own
 * network (the 254 addresses around it, home ranges only) is asked whether a handful of ports
 * are open; only the ones that answer get one read-only page load, to say what they are.
 * Nothing is changed anywhere, and nothing outside the home network is touched.
 */

export interface FoundMachine {
  address: string;
  /** The NAS system, when its own sign-in page answered ("Synology DSM"). */
  nas?: string;
  /** Apps recognised on it, by name. */
  apps: string[];
}

export interface LanProbes {
  /** The other addresses on this machine's home network. */
  neighbours: () => Promise<string[]>;
  portOpen: (host: string, port: number) => Promise<boolean>;
  readPage: (port: number, host: string) => Promise<PageRead | null>;
}

/** NAS sign-in pages, then the apps people most often keep on a NAS or server. */
export const LAN_PORTS = [
  ...new Set([
    ...NAS_SYSTEMS.flatMap((n) => [...n.ports]),
    32400, // Plex
    8096, // Jellyfin, Emby
    8989, // Sonarr
    7878, // Radarr
    8123, // Home Assistant
    5055, // Seerr
    13378, // Audiobookshelf
    2283, // Immich
  ]),
];

/** Home address ranges only: a sweep never leaves the home network. */
export function isHomeAddress(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return (
    p[0] === 10 || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) || (p[0] === 192 && p[1] === 168)
  );
}

/** The 253 other addresses in a home /24 around this machine's own address. */
export function neighboursOf(own: string): string[] {
  if (!isHomeAddress(own)) return [];
  const base = own.split(".").slice(0, 3).join(".");
  const out: string[] = [];
  for (let i = 1; i <= 254; i++) if (`${base}.${i}` !== own) out.push(`${base}.${i}`);
  return out;
}

/** Runs at most `limit` checks at once, so a home router is never flooded. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export async function findMachines(probes: LanProbes): Promise<FoundMachine[]> {
  const hosts = await probes.neighbours();
  const checks = hosts.flatMap((host) => LAN_PORTS.map((port) => ({ host, port })));
  const open = await pool(checks, 128, (c) => probes.portOpen(c.host, c.port));
  const byHost = new Map<string, number[]>();
  checks.forEach((c, i) => {
    if (open[i]) byHost.set(c.host, [...(byHost.get(c.host) ?? []), c.port]);
  });

  const apps = CATALOG.filter((e) => !e.supporting && (e.nativePort ?? e.webPort));
  const found = await pool([...byHost], 16, async ([address, ports]) => {
    const machine: FoundMachine = { address, apps: [] };
    for (const port of ports) {
      const page = await probes.readPage(port, address).catch(() => null);
      if (!page) continue;
      const title = /<title[^>]*>([^<]*)<\/title>/i.exec(page.body)?.[1] ?? "";
      const nas = NAS_SYSTEMS.find(
        (n) => (n.ports as readonly number[]).includes(port) && n.sign.test(title || page.body),
      );
      if (nas) {
        machine.nas ??= nas.name;
        continue;
      }
      const onThisPort = apps.filter((e) => (e.nativePort ?? e.webPort) === port);
      const app =
        identifyPage(page, onThisPort, apps) ?? onThisPort.find((e) => e.nativePort === port);
      if (app && !machine.apps.includes(app.name)) machine.apps.push(app.name);
    }
    machine.apps.sort((a, b) => a.localeCompare(b));
    return machine;
  });

  // A NAS first, then the machine with the most apps; machines with nothing known are left out.
  return found
    .filter((m) => m.nas || m.apps.length)
    .sort((a, b) => Number(!!b.nas) - Number(!!a.nas) || b.apps.length - a.apps.length);
}

/** One quick TCP connect: is anything listening on that port? */
export function portOpen(host: string, port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
