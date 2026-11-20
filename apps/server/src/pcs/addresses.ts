import { networkInterfaces } from "node:os";

/**
 * The addresses other devices can open this Hearth at, for the QR code and join links. Hearth
 * listening on this PC only (127.0.0.1) can still be reached through a proxy or Tailscale serve
 * in front of it, which is the address this page was opened with.
 */

export interface Address {
  url: string;
  kind: "this-page" | "home" | "tailscale";
  label: string;
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)(:\d+)?$/i;

/** 100.64.0.0/10: the addresses Tailscale hands out. */
export function isTailscale(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b < 128;
}

/**
 * Networks that only exist inside this PC (Docker, VMs, WSL): nothing else in the house can use
 * their addresses, and a server with many containers has dozens of them.
 */
export const isVirtual = (name: string) =>
  /^(docker|br-|veth|virbr|vEthernet|cni|flannel|podman|lxc|lxd|vmnet|vboxnet|VirtualBox|VMware|tun|wg|zt)/i.test(
    name,
  );

export function reachableAddresses(
  listen: { host: string; port: number },
  pageOrigin: string | undefined,
  nets: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): { addresses: Address[]; localOnly: boolean } {
  const out: Address[] = [];
  const add = (a: Address) => {
    if (!out.some((x) => x.url === a.url)) out.push(a);
  };
  if (pageOrigin) {
    try {
      const u = new URL(pageOrigin);
      if (!LOOPBACK.test(u.host))
        add({
          url: u.origin,
          kind: u.hostname.endsWith(".ts.net") ? "tailscale" : "this-page",
          label: u.hostname.endsWith(".ts.net") ? "Tailscale" : "The address you're using",
        });
    } catch {
      // Not an address.
    }
  }
  const everywhere = listen.host === "0.0.0.0" || listen.host === "::";
  if (everywhere) {
    for (const [name, list] of Object.entries(nets))
      for (const n of list ?? []) {
        if (n.internal || n.family !== "IPv4" || isVirtual(name)) continue;
        const ts = isTailscale(n.address);
        add({
          url: `http://${n.address}:${listen.port}`,
          kind: ts ? "tailscale" : "home",
          label: ts ? "Tailscale" : `Home network (${n.address})`,
        });
      }
  } else if (!LOOPBACK.test(listen.host)) {
    add({
      url: `http://${listen.host}:${listen.port}`,
      kind: isTailscale(listen.host) ? "tailscale" : "home",
      label: isTailscale(listen.host) ? "Tailscale" : "Home network",
    });
  }
  // A secure (https) address first: there a phone's browser also allows the microphone. Then
  // the home network, then Tailscale.
  const rank = { home: 0, tailscale: 1, "this-page": 2 };
  const secure = (a: Address) => (a.url.startsWith("https:") ? 0 : 1);
  out.sort((a, b) => secure(a) - secure(b) || rank[a.kind] - rank[b.kind]);
  return { addresses: out, localOnly: !everywhere && LOOPBACK.test(listen.host) };
}
