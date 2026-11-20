import { tmpdir } from "node:os";
import path from "node:path";
import type { ContainerInfo } from "./docker";
import type { DiscoveryProbes } from "./scan";

/**
 * A synthetic homelab for tests and end-to-end runs. It reproduces the
 * tricky shapes real environments have (apps routed through a VPN
 * container, unknown web apps, loopback-only ports, compose databases,
 * stopped copies, a natively installed media server) without touching
 * real Docker.
 */
const SYSTEM_ROOT = path.parse(tmpdir()).root;

const vpnId = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

export const FAKE_CONTAINERS: ContainerInfo[] = [
  {
    id: vpnId,
    name: "vpn",
    image: "qmcgaw/gluetun:latest",
    state: "running",
    healthcheck: "healthy",
    networkMode: "bridge",
    bindings: [
      { privatePort: 9696, publicPort: 9696, ip: "0.0.0.0", protocol: "tcp" },
      { privatePort: 8080, publicPort: 8085, ip: "0.0.0.0", protocol: "tcp" },
      { privatePort: 8000, publicPort: 8000, ip: "0.0.0.0", protocol: "tcp" },
    ],
    exposedPorts: [8000, 8080, 9696],
    composeProject: "media",
    composeService: "vpn",
    composeDependsOn: [],
  },
  {
    id: "b".repeat(64),
    name: "prowlarr",
    image: "lscr.io/linuxserver/prowlarr:latest",
    state: "running",
    networkMode: `container:${vpnId}`,
    bindings: [],
    exposedPorts: [9696],
    composeProject: "media",
    composeService: "prowlarr",
    composeDependsOn: ["vpn"],
  },
  {
    id: "c".repeat(64),
    name: "sabnzbd",
    image: "lscr.io/linuxserver/sabnzbd:latest",
    state: "running",
    networkMode: `container:${vpnId}`,
    bindings: [],
    exposedPorts: [8080],
    composeProject: "media",
    composeService: "sabnzbd",
    composeDependsOn: ["vpn"],
  },
  {
    id: "d".repeat(64),
    name: "sonarr",
    image: "lscr.io/linuxserver/sonarr:latest",
    state: "running",
    networkMode: "media_default",
    bindings: [{ privatePort: 8989, publicPort: 8989, ip: "0.0.0.0", protocol: "tcp" }],
    exposedPorts: [8989],
    composeProject: "media",
    composeService: "sonarr",
    composeDependsOn: [],
  },
  {
    id: "e".repeat(64),
    name: "mystery-app",
    image: "someone/mystery-app:1.2",
    state: "running",
    networkMode: "bridge",
    bindings: [{ privatePort: 5000, publicPort: 5959, ip: "0.0.0.0", protocol: "tcp" }],
    exposedPorts: [5000],
    composeDependsOn: [],
  },
  {
    id: "f".repeat(64),
    name: "private-tool",
    image: "private-tool",
    state: "running",
    networkMode: "bridge",
    bindings: [{ privatePort: 8092, publicPort: 8092, ip: "127.0.0.1", protocol: "tcp" }],
    exposedPorts: [8092],
    composeDependsOn: [],
  },
  {
    id: "1".repeat(64),
    name: "photos_server",
    image: "ghcr.io/immich-app/immich-server:v2",
    state: "running",
    healthcheck: "healthy",
    networkMode: "photos_default",
    bindings: [{ privatePort: 2283, publicPort: 2283, ip: "0.0.0.0", protocol: "tcp" }],
    exposedPorts: [2283],
    composeProject: "photos",
    composeService: "server",
    composeDependsOn: ["database"],
  },
  {
    id: "2".repeat(64),
    name: "photos_db",
    image: "ghcr.io/immich-app/postgres:14",
    state: "running",
    healthcheck: "unhealthy",
    networkMode: "photos_default",
    bindings: [],
    exposedPorts: [5432],
    composeProject: "photos",
    composeService: "database",
    composeDependsOn: [],
  },
  {
    id: "3".repeat(64),
    name: "audiobookshelf-backup",
    image: "ghcr.io/advplyr/audiobookshelf:2.10",
    state: "stopped",
    networkMode: "bridge",
    bindings: [],
    exposedPorts: [80],
    composeDependsOn: [],
  },
];

/** Ports that answer HTTP in the fake world. 32400 is a natively installed Plex. */
const httpPorts = new Set([5959, 8092, 8384, 32400]);
/** Answer only on 127.0.0.1, like Syncthing's default GUI setting. */
const loopbackOnlyPorts = new Set([8384]);

export const fakeProbes: DiscoveryProbes = {
  host: async () => ({
    id: "testbox",
    name: "testbox",
    role: "This machine",
    os: "Ubuntu 24.04",
    address: "10.0.0.5",
    cpu: { model: "Example CPU", cores: 8, usagePct: 12 },
    memory: { totalGb: 32, usedGb: 9.5 },
    uptimeHours: 120,
    connection: "this-machine",
    docker: true,
    volumes: [
      {
        // The drive holding the temp folder, so tests can watch real folders
        // on any OS ("C:\\" on Windows, "/" elsewhere).
        id: "testbox-root",
        hostId: "testbox",
        label: SYSTEM_ROOT,
        mount: SYSTEM_ROOT,
        kind: "disk",
        totalTb: 1,
        usedTb: 0.4,
        smart: "ok",
      },
      {
        id: "testbox-media",
        hostId: "testbox",
        label: "/mnt/media",
        mount: "/mnt/media",
        kind: "nas",
        totalTb: 20,
        usedTb: 12.5,
        smart: "ok",
      },
    ],
  }),
  docker: async () => ({ containers: FAKE_CONTAINERS, version: "28.0.0", endpoint: "fake" }),
  probeHttp: async (port, host = "127.0.0.1") =>
    httpPorts.has(port) && (host === "127.0.0.1" || !loopbackOnlyPorts.has(port)),
  disks: async (hostId) => [
    {
      id: `${hostId}-disk-0`,
      hostId,
      model: "Example NVMe 1TB",
      type: "ssd",
      bus: "NVMe",
      sizeTb: 1,
      health: "healthy",
      volumes: [SYSTEM_ROOT.replace(/[\\/]+$/, "") || "/"],
      checkedAt: new Date().toISOString(),
      limitation: "Temperature, power-on hours, and wear need elevated access.",
    },
    {
      id: `${hostId}-disk-1`,
      hostId,
      model: "Example NAS share",
      type: "hdd",
      bus: "Network",
      sizeTb: 20,
      health: "healthy",
      volumes: ["/mnt/media"],
      checkedAt: new Date().toISOString(),
    },
  ],
};
