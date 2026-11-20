import { describe, expect, it } from "vitest";
import type { networkInterfaces } from "node:os";
import { reachableAddresses } from "./addresses";

const nets = {
  lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  eth0: [{ address: "192.168.1.77", family: "IPv4", internal: false }],
  tailscale0: [{ address: "100.101.5.9", family: "IPv4", internal: false }],
} as unknown as ReturnType<typeof networkInterfaces>;

describe("addresses other devices can reach", () => {
  it("open to the network: home first, then Tailscale; an https page first of all", () => {
    const r = reachableAddresses({ host: "0.0.0.0", port: 7600 }, "http://localhost:7600", nets);
    expect(r.localOnly).toBe(false);
    expect(r.addresses.map((a) => a.url)).toEqual([
      "http://192.168.1.77:7600",
      "http://100.101.5.9:7600",
    ]);
    const s = reachableAddresses(
      { host: "0.0.0.0", port: 7600 },
      "https://homeserver.tail1a2b3c.ts.net",
      nets,
    );
    expect(s.addresses[0]).toMatchObject({
      url: "https://homeserver.tail1a2b3c.ts.net",
      kind: "tailscale",
    });
  });

  it("this PC only: just the address in front of it, and says so", () => {
    const r = reachableAddresses({ host: "127.0.0.1", port: 7600 }, "http://localhost:7600", nets);
    expect(r).toEqual({ addresses: [], localOnly: true });
    const proxied = reachableAddresses(
      { host: "127.0.0.1", port: 7600 },
      "https://hearth.example.com",
      nets,
    );
    expect(proxied.addresses.map((a) => a.url)).toEqual(["https://hearth.example.com"]);
  });

  it("leaves out networks that only exist inside the PC (Docker, VMs, WSL)", () => {
    const nic = (address: string) => ({
      address,
      family: "IPv4" as const,
      internal: false,
      netmask: "255.255.0.0",
      mac: "",
      cidr: null,
    });
    const r = reachableAddresses({ host: "0.0.0.0", port: 7600 }, undefined, {
      enp4s0: [nic("192.168.1.77")],
      docker0: [nic("172.17.0.1")],
      "br-dbbe21ba78c7": [nic("172.19.0.1")],
      "vEthernet (WSL)": [nic("172.25.64.1")],
      tailscale0: [nic("100.64.10.26")],
    });
    expect(r.addresses.map((a) => a.label)).toEqual(["Home network (192.168.1.77)", "Tailscale"]);
  });
});
