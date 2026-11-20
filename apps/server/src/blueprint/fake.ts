import type { AssembleSource } from "./assemble";

/**
 * A stand-in machine for previews and browser tests (DC_FAKE_APPS=1, never in a real install): a
 * VPN, a downloader behind it, Sonarr with its own backups, and Plex, with one compose file.
 */
const COMPOSE = `services:
  gluetun:
    image: qmcgaw/gluetun:latest
    environment:
      - VPN_SERVICE_PROVIDER=protonvpn
      - WIREGUARD_PRIVATE_KEY=e2e-not-a-real-key-0000000000000000
  qbittorrent:
    image: lscr.io/linuxserver/qbittorrent:latest
    network_mode: service:gluetun
    environment:
      - PUID=1000
      - TZ=America/Chicago
    volumes:
      - /srv/qbittorrent:/config
      - /mnt/media/downloads:/downloads
  sonarr:
    image: lscr.io/linuxserver/sonarr:latest
    environment:
      - PUID=1000
    volumes:
      - /srv/sonarr:/config
      - /mnt/media/tv:/tv
`;

const labels = (service: string, deps?: string) => ({
  "com.docker.compose.project": "media",
  "com.docker.compose.service": service,
  "com.docker.compose.project.config_files": "/srv/media/compose.yaml",
  ...(deps ? { "com.docker.compose.depends_on": deps } : {}),
});

export function fakeMachine(
  vault: AssembleSource["vault"],
  services: AssembleSource["services"],
  notes: () => Promise<string>,
): AssembleSource {
  return {
    containers: async () =>
      [
        {
          name: "gluetun",
          state: "running",
          inspect: {
            Config: {
              Image: "qmcgaw/gluetun:latest",
              Env: ["VPN_SERVICE_PROVIDER=protonvpn", "WIREGUARD_PRIVATE_KEY=x"],
              Labels: labels("gluetun"),
            },
            HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
            NetworkSettings: {
              Ports: { "8080/tcp": [{ HostPort: "8080" }] },
              Networks: { media_default: {} },
            },
            Mounts: [],
          },
        },
        {
          name: "qbittorrent",
          state: "running",
          inspect: {
            Config: {
              Image: "lscr.io/linuxserver/qbittorrent:latest",
              Env: ["PUID=1000", "TZ=America/Chicago"],
              Labels: labels("qbittorrent", "gluetun:service_started:false"),
            },
            HostConfig: {
              RestartPolicy: { Name: "unless-stopped" },
              NetworkMode: "service:gluetun",
            },
            Mounts: [
              { Type: "bind", Source: "/srv/qbittorrent", Destination: "/config", RW: true },
              { Type: "bind", Source: "/mnt/media/downloads", Destination: "/downloads", RW: true },
            ],
          },
        },
        {
          name: "sonarr",
          state: "running",
          inspect: {
            Config: {
              Image: "lscr.io/linuxserver/sonarr:latest",
              Env: ["PUID=1000"],
              Labels: labels("sonarr"),
            },
            HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
            NetworkSettings: {
              Ports: { "8989/tcp": [{ HostPort: "8989" }] },
              Networks: { media_default: {} },
            },
            Mounts: [
              { Type: "bind", Source: "/srv/sonarr", Destination: "/config", RW: true },
              { Type: "bind", Source: "/mnt/media/tv", Destination: "/tv", RW: true },
            ],
          },
        },
        {
          name: "plex",
          state: "running",
          inspect: {
            Config: {
              Image: "lscr.io/linuxserver/plex:latest",
              Env: ["PUID=1000", "PLEX_CLAIM=x"],
            },
            HostConfig: { RestartPolicy: { Name: "unless-stopped" }, NetworkMode: "host" },
            Mounts: [
              { Type: "bind", Source: "/srv/plex", Destination: "/config", RW: true },
              { Type: "bind", Source: "/mnt/media", Destination: "/media", RW: false },
            ],
          },
        },
      ] as unknown as Awaited<ReturnType<AssembleSource["containers"]>>,
    networks: async () => [
      {
        name: "media_default",
        driver: "bridge",
        subnet: "172.20.0.0/16",
        containers: ["gluetun", "sonarr"],
      },
    ],
    host: async () => ({
      name: "sample-server",
      os: "Ubuntu 24.04 LTS (sample)",
      hearthVersion: "preview",
      mounts: [
        { source: "/dev/nvme0n1p2", target: "/", fsType: "ext4" },
        { source: "/dev/sdb1", target: "/mnt/media", fsType: "ext4" },
      ],
      interfaces: [{ name: "eth0", address: "192.168.1.50" }],
    }),
    services,
    vault,
    readFile: async (f) => (f === "/srv/media/compose.yaml" ? COMPOSE : undefined),
    exists: async (f) => f === "/srv/sonarr/Backups",
    notes,
    now: () => new Date(),
  };
}
