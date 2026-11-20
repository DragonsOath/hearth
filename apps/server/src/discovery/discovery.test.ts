import { describe, expect, it } from "vitest";
import type { DiscoveryFinding } from "@dragon-control/core";
import { identify, imageRepository } from "./catalog";
import { toContainerInfo } from "./docker";
import { fakeProbes } from "./fake";
import { runDiscovery } from "./scan";
import { containerName } from "./analyze";

async function scan() {
  const report = await runDiscovery(fakeProbes);
  const find = (name: string): DiscoveryFinding => {
    const f = report.findings.find((x) => x.sourceName === name);
    if (!f) throw new Error(`no finding ${name}`);
    return f;
  };
  return { report, find };
}

describe("catalog", () => {
  it("strips registries and tags from image references", () => {
    expect(imageRepository("lscr.io/linuxserver/sonarr:latest")).toBe("linuxserver/sonarr");
    expect(imageRepository("ghcr.io/immich-app/immich-server:v3")).toBe("immich-app/immich-server");
    expect(imageRepository("localhost:5000/team/app:1")).toBe("team/app");
    expect(imageRepository("postgres@sha256:abc")).toBe("postgres");
    expect(imageRepository("audiobookshelf:pre-release-2026")).toBe("audiobookshelf");
  });

  it("recognises apps by image name regardless of publisher", () => {
    expect(identify("lscr.io/linuxserver/prowlarr:latest")?.id).toBe("prowlarr");
    expect(identify("ghcr.io/autobrr/qui:latest")?.id).toBe("qui");
    expect(identify("valkey/valkey:9")?.id).toBe("redis");
    expect(identify("someone/mystery-app")).toBeUndefined();
  });
});

describe("toContainerInfo", () => {
  it("keeps only safe fields and never carries environment variables", () => {
    const info = toContainerInfo(
      {
        Id: "x".repeat(64),
        Name: "/radarr",
        Config: {
          Image: "linuxserver/radarr",
          ExposedPorts: { "7878/tcp": {}, "1900/udp": {} },
          Labels: {
            "com.docker.compose.project": "media",
            "com.docker.compose.depends_on": "vpn:service_started:false,db:service_healthy:true",
          },
          // @ts-expect-error: deliberately present in the raw response
          Env: ["RADARR__API_KEY=supersecret", "PASSWORD=hunter2"],
        },
        State: { Status: "running", Health: { Status: "healthy" } },
        HostConfig: { NetworkMode: "media_default" },
        NetworkSettings: {
          Ports: {
            "7878/tcp": [
              { HostIp: "0.0.0.0", HostPort: "7878" },
              { HostIp: "::", HostPort: "7878" },
            ],
          },
        },
      },
      "lscr.io/linuxserver/radarr:latest",
    );
    expect(JSON.stringify(info)).not.toMatch(/supersecret|hunter2|API_KEY|PASSWORD/);
    expect(info.name).toBe("radarr");
    expect(info.bindings).toEqual([
      { privatePort: 7878, publicPort: 7878, ip: "0.0.0.0", protocol: "tcp" },
    ]);
    expect(info.exposedPorts).toEqual([7878]);
    expect(info.composeDependsOn).toEqual(["vpn", "db"]);
    expect(info.healthcheck).toBe("healthy");
  });
});

describe("analysis of a homelab", () => {
  it("routes VPN-published ports to the apps inside the VPN, and records the dependency", async () => {
    const { find } = await scan();
    expect(find("prowlarr")).toMatchObject({
      localUrl: "http://10.0.0.5:9696",
      dependsOn: ["container:vpn"],
      group: "recognised",
    });
    // Port 8080 inside the VPN is published as 8085 on the host.
    expect(find("sabnzbd").localUrl).toBe("http://10.0.0.5:8085");
    // The VPN itself keeps only ports nobody inside it claimed.
    expect(find("vpn").ports).toEqual(["8000"]);
    expect(find("vpn").group).toBe("supporting");
  });

  it("finds unknown web apps for you to name, and marks loopback-only ones", async () => {
    const { find } = await scan();
    expect(find("mystery-app")).toMatchObject({
      group: "unrecognised-web",
      recognised: false,
      name: "Mystery App",
      localUrl: "http://10.0.0.5:5959",
    });
    expect(find("private-tool")).toMatchObject({
      localUrl: "http://127.0.0.1:8092",
      localOnly: true,
    });
  });

  it("links compose dependencies and names datastores by owner", async () => {
    const { find } = await scan();
    expect(find("photos_server").dependsOn).toEqual(["container:photos_db"]);
    expect(find("photos_db")).toMatchObject({
      name: "PostgreSQL (photos_db)",
      group: "supporting",
      health: "attention",
    });
  });

  it("leaves stopped containers unselected and calm", async () => {
    const { find } = await scan();
    expect(find("audiobookshelf-backup")).toMatchObject({
      group: "stopped",
      selectedByDefault: false,
      health: "offline",
    });
  });

  it("finds apps installed directly on the host", async () => {
    const { report } = await scan();
    expect(report.findings.find((f) => f.key === "process:plex")).toMatchObject({
      source: "process",
      localUrl: "http://10.0.0.5:32400",
    });
  });

  it("reports Docker trouble as a note instead of failing", async () => {
    const report = await runDiscovery({
      ...fakeProbes,
      docker: async () => ({ error: "Docker was not found on this machine." }),
    });
    expect(report.docker.available).toBe(false);
    expect(report.notes).toContain("Docker was not found on this machine.");
    expect(report.host.name).toBe("testbox");
  });
});

describe("native apps", () => {
  it("records a loopback-only native app at the address that actually answers", async () => {
    const report = await runDiscovery(fakeProbes);
    expect(report.findings.find((f) => f.key === "process:syncthing")).toMatchObject({
      localUrl: "http://127.0.0.1:8384",
      localOnly: true,
    });
    // One that answers on the network keeps the network address.
    expect(report.findings.find((f) => f.key === "process:plex")?.localUrl).toBe(
      "http://10.0.0.5:32400",
    );
  });
});

describe("real-world container shapes", () => {
  const base = {
    state: "running" as const,
    bindings: [],
    exposedPorts: [],
    composeDependsOn: [],
  };

  it("gives a host-network container its address and never counts it twice as a native app", async () => {
    const jellyfin = {
      ...base,
      id: "j".repeat(64),
      name: "jellyfin",
      image: "jellyfin/jellyfin:latest",
      networkMode: "host",
      exposedPorts: [8096],
    };
    const probes = {
      ...fakeProbes,
      docker: async () => ({ containers: [jellyfin], version: "29", endpoint: "fake" }),
      probeHttp: async (port: number) => port === 8096,
    };
    const report = await runDiscovery(probes);
    expect(report.findings.map((f) => f.key)).toEqual(["container:jellyfin"]);
    expect(report.findings[0]).toMatchObject({
      name: "Jellyfin",
      localUrl: "http://10.0.0.5:8096",
    });
  });

  it("names Compose-generated containers after the app, and keeps names people chose", () => {
    expect(
      containerName({
        name: "tasterr-tasterr-1",
        composeProject: "tasterr",
        composeService: "tasterr",
      }),
    ).toBe("Tasterr");
    expect(
      containerName({
        name: "media-indexer-2",
        composeProject: "media",
        composeService: "indexer",
      }),
    ).toBe("Media Indexer");
    expect(
      containerName({
        name: "opnform-ingress",
        composeProject: "opnform",
        composeService: "ingress",
      }),
    ).toBe("Opnform Ingress");
    expect(containerName({ name: "mystery_app" })).toBe("Mystery App");
  });
});
