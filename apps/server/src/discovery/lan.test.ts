import { describe, expect, it } from "vitest";
import { fakeProbes, FAKE_NAS } from "./fake";
import { findMachines, isHomeAddress, neighboursOf, type LanProbes } from "./lan";
import type { PageRead } from "./analyze";
import { runFindMachines, runRemoteDiscovery } from "./scan";

describe("finding the NAS on the home network", () => {
  it("only ever looks at home address ranges", () => {
    expect(isHomeAddress("192.168.1.40")).toBe(true);
    expect(isHomeAddress("10.0.0.5")).toBe(true);
    expect(isHomeAddress("172.20.1.2")).toBe(true);
    expect(isHomeAddress("172.40.1.2")).toBe(false);
    expect(isHomeAddress("8.8.8.8")).toBe(false);
    expect(isHomeAddress("100.64.0.1")).toBe(false);
    expect(neighboursOf("8.8.8.8")).toEqual([]);
  });

  it("asks the 253 other addresses around this machine, never itself", () => {
    const n = neighboursOf("192.168.1.40");
    expect(n).toHaveLength(253);
    expect(n).not.toContain("192.168.1.40");
    expect(n[0]).toBe("192.168.1.1");
    expect(n.at(-1)).toBe("192.168.1.254");
  });

  it("names the NAS and what runs on it, NAS first, and leaves out machines with nothing known", async () => {
    const pages: Record<string, Record<number, string>> = {
      "192.168.1.20": { 5000: "Synology DiskStation", 8989: "Login - Sonarr", 32400: "" },
      "192.168.1.30": { 32400: "", 8096: "Jellyfin" },
      "192.168.1.40": { 80: "My router" },
    };
    const probes: LanProbes = {
      neighbours: async () => ["192.168.1.20", "192.168.1.30", "192.168.1.40", "192.168.1.50"],
      portOpen: async (host, port) => pages[host]?.[port] !== undefined,
      readPage: async (port, host): Promise<PageRead | null> => {
        const title = pages[host]?.[port];
        if (title === undefined) return null;
        return port === 32400
          ? { status: 401, headers: { "x-plex-protocol": "1.0" }, body: "" }
          : { status: 200, headers: {}, body: `<title>${title}</title>` };
      },
    };
    expect(await findMachines(probes)).toEqual([
      { address: "192.168.1.20", nas: "Synology DSM", apps: ["Plex", "Sonarr"] },
      { address: "192.168.1.30", apps: ["Jellyfin", "Plex"] },
    ]);
  });

  it("finds the sample NAS, whose own scan then shows the NAS and its apps", async () => {
    const machines = await runFindMachines(fakeProbes);
    expect(machines[0]).toEqual({
      address: FAKE_NAS,
      nas: "Synology DSM",
      apps: ["qBittorrent", "Sonarr"],
    });
    const report = await runRemoteDiscovery(fakeProbes, { address: FAKE_NAS, name: "NAS" });
    expect(report.findings.map((f) => f.name)).toEqual(["Synology DSM", "qBittorrent", "Sonarr"]);
  });

  it("without network probes, finds nothing rather than failing", async () => {
    expect(await runFindMachines({})).toEqual([]);
  });
});
