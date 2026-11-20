import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { isVirtual } from "./addresses";

/**
 * A new PC's setup finds the Hearth you already have: it asks every address on this PC's home
 * network, and every device on your Tailscale, whether a Hearth answers there (its
 * /api/pcs/hello). Nothing is sent but that question; the key comes after, to the one you pick.
 */

export interface FoundHearth {
  url: string;
  name: string;
  /** Set up, and not itself part of another Hearth. */
  linkable: boolean;
  via: "home" | "tailscale";
}

const PORTS = [7600];
const isTailscaleIp = (ip: string) => {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
};
const isPrivate = (ip: string) =>
  /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

/** Every other address on this PC's home networks (/24 around each of its addresses). */
export function homeCandidates(nets = networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const [name, list] of Object.entries(nets))
    for (const n of list ?? []) {
      if (n.internal || n.family !== "IPv4" || !isPrivate(n.address) || isVirtual(name)) continue;
      const base = n.address.split(".").slice(0, 3).join(".");
      for (let i = 1; i < 255; i++) {
        const ip = `${base}.${i}`;
        if (ip !== n.address) for (const p of PORTS) out.add(`http://${ip}:${p}`);
      }
    }
  return [...out];
}

/** Your other Tailscale devices (its CLI), each at its address and, when served, its name. */
export async function tailscaleCandidates(): Promise<string[]> {
  const cli = [
    "tailscale",
    "C:\\Program Files\\Tailscale\\tailscale.exe",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ].find((c) => c === "tailscale" || existsSync(c))!;
  const json = await new Promise<string>((resolve) =>
    execFile(cli, ["status", "--json"], { timeout: 5000, windowsHide: true }, (err, out) =>
      resolve(err ? "" : out),
    ),
  );
  if (!json) return [];
  try {
    const status = JSON.parse(json) as {
      Peer?: Record<string, { TailscaleIPs?: string[]; DNSName?: string; Online?: boolean }>;
    };
    const out: string[] = [];
    for (const peer of Object.values(status.Peer ?? {})) {
      if (peer.Online === false) continue;
      const ip = peer.TailscaleIPs?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
      if (ip) for (const p of PORTS) out.push(`http://${ip}:${p}`);
      const dns = peer.DNSName?.replace(/\.$/, "");
      if (dns) out.push(`https://${dns}`);
    }
    return out;
  } catch {
    return [];
  }
}

/** Asks one address whether a Hearth answers there. */
export async function hello(url: string, timeoutMs = 900): Promise<FoundHearth | null> {
  try {
    const res = await fetch(`${url}/api/pcs/hello`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j = (await res.json()) as { app?: string; name?: string; linkable?: boolean };
    if (j.app !== "Hearth") return null;
    const host = new URL(url).hostname;
    return {
      url,
      name: j.name || host,
      linkable: Boolean(j.linkable),
      via: isTailscaleIp(host) || host.endsWith(".ts.net") ? "tailscale" : "home",
    };
  } catch {
    return null;
  }
}

/** Every Hearth that answers, one entry per Hearth (by name), home network first. */
export async function findHearths(
  deps: {
    home?: () => string[];
    tailscale?: () => Promise<string[]>;
    ask?: (url: string) => Promise<FoundHearth | null>;
  } = {},
): Promise<FoundHearth[]> {
  const candidates = [
    ...(deps.home ?? homeCandidates)(),
    ...(await (deps.tailscale ?? tailscaleCandidates)()),
  ];
  const ask = deps.ask ?? ((u: string) => hello(u));
  const found: FoundHearth[] = [];
  let next = 0;
  // A few dozen at a time: a whole home network takes a couple of seconds.
  await Promise.all(
    Array.from({ length: 48 }, async () => {
      while (next < candidates.length) {
        const r = await ask(candidates[next++]!);
        if (r) found.push(r);
      }
    }),
  );
  const byName = new Map<string, FoundHearth>();
  for (const f of found.sort((a, b) => (a.via === b.via ? 0 : a.via === "home" ? -1 : 1)))
    if (!byName.has(f.name)) byName.set(f.name, f);
  return [...byName.values()];
}
