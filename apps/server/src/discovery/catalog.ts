import type { ServiceCategory } from "@dragon-control/core";

/**
 * Applications Hearth recognises. Matching is by image name only
 * (registry and tag ignored), so it works for any homelab. Unknown images
 * are still discovered; they just arrive unnamed for you to identify.
 */
export interface CatalogEntry {
  id: string;
  name: string;
  category: ServiceCategory;
  /** Autonomy area that governs it (see the autonomy rules). */
  area: string;
  /** Matched against the image's repository path, e.g. "linuxserver/sonarr". */
  images: RegExp[];
  /** Port the web interface listens on inside the container. */
  webPort?: number;
  /** Infrastructure with nothing to open in a browser (databases, caches, workers). */
  supporting?: boolean;
  /** Distinctive local port to look for when the app runs outside Docker. */
  nativePort?: number;
}

const img = (...names: string[]) => names.map((n) => new RegExp(`(^|/)${n}$`, "i"));

export const CATALOG: CatalogEntry[] = [
  // Media
  {
    id: "jellyfin",
    name: "Jellyfin",
    category: "Media",
    area: "media",
    images: img("jellyfin"),
    webPort: 8096,
    nativePort: 8096,
  },
  {
    id: "plex",
    name: "Plex",
    category: "Media",
    area: "media",
    images: img("pms-docker", "plex"),
    webPort: 32400,
    nativePort: 32400,
  },
  {
    id: "emby",
    name: "Emby",
    category: "Media",
    area: "media",
    images: img("embyserver", "emby"),
    webPort: 8096,
  },
  {
    id: "tautulli",
    name: "Tautulli",
    category: "Media",
    area: "media",
    images: img("tautulli"),
    webPort: 8181,
  },
  {
    id: "audiobookshelf",
    name: "Audiobookshelf",
    category: "Media",
    area: "media",
    images: img("audiobookshelf"),
    webPort: 80,
  },
  {
    id: "kavita",
    name: "Kavita",
    category: "Media",
    area: "media",
    images: img("kavita"),
    webPort: 5000,
  },
  {
    id: "komga",
    name: "Komga",
    category: "Media",
    area: "media",
    images: img("komga"),
    webPort: 25600,
  },
  {
    id: "navidrome",
    name: "Navidrome",
    category: "Media",
    area: "media",
    images: img("navidrome"),
    webPort: 4533,
  },
  {
    id: "ersatztv",
    name: "ErsatzTV",
    category: "Media",
    area: "media",
    images: img("ersatztv"),
    webPort: 8409,
  },
  {
    id: "overseerr",
    name: "Overseerr",
    category: "Media",
    area: "media",
    images: img("overseerr"),
    webPort: 5055,
  },
  {
    id: "jellyseerr",
    name: "Jellyseerr",
    category: "Media",
    area: "media",
    images: img("jellyseerr"),
    webPort: 5055,
  },
  {
    id: "ombi",
    name: "Ombi",
    category: "Media",
    area: "media",
    images: img("ombi"),
    webPort: 3579,
  },
  {
    id: "wizarr",
    name: "Wizarr",
    category: "Media",
    area: "media",
    images: img("wizarr"),
    webPort: 5690,
  },
  {
    id: "romm",
    name: "RomM",
    category: "Media",
    area: "media",
    images: img("romm"),
    webPort: 8080,
  },

  // Media automation
  {
    id: "sonarr",
    name: "Sonarr",
    category: "Automation",
    area: "automation",
    images: img("sonarr"),
    webPort: 8989,
  },
  {
    id: "radarr",
    name: "Radarr",
    category: "Automation",
    area: "automation",
    images: img("radarr"),
    webPort: 7878,
  },
  {
    id: "lidarr",
    name: "Lidarr",
    category: "Automation",
    area: "automation",
    images: img("lidarr"),
    webPort: 8686,
  },
  {
    id: "readarr",
    name: "Readarr",
    category: "Automation",
    area: "automation",
    images: img("readarr"),
    webPort: 8787,
  },
  {
    id: "bazarr",
    name: "Bazarr",
    category: "Automation",
    area: "automation",
    images: img("bazarr"),
    webPort: 6767,
  },
  {
    id: "prowlarr",
    name: "Prowlarr",
    category: "Automation",
    area: "automation",
    images: img("prowlarr"),
    webPort: 9696,
  },
  {
    id: "jackett",
    name: "Jackett",
    category: "Automation",
    area: "automation",
    images: img("jackett"),
    webPort: 9117,
  },
  {
    id: "flaresolverr",
    name: "FlareSolverr",
    category: "Automation",
    area: "automation",
    images: img("flaresolverr"),
    supporting: true,
  },
  {
    id: "recyclarr",
    name: "Recyclarr",
    category: "Automation",
    area: "automation",
    images: img("recyclarr"),
    supporting: true,
  },
  {
    id: "kometa",
    name: "Kometa",
    category: "Automation",
    area: "automation",
    images: img("kometa", "plex-meta-manager"),
    supporting: true,
  },
  {
    id: "unpackerr",
    name: "Unpackerr",
    category: "Automation",
    area: "automation",
    images: img("unpackerr"),
    supporting: true,
  },
  {
    id: "autobrr",
    name: "autobrr",
    category: "Automation",
    area: "automation",
    images: img("autobrr"),
    webPort: 7474,
  },
  {
    id: "tdarr",
    name: "Tdarr",
    category: "Automation",
    area: "automation",
    images: img("tdarr"),
    webPort: 8265,
  },

  // Downloads
  {
    id: "qbittorrent",
    name: "qBittorrent",
    category: "Downloads",
    area: "automation",
    images: img("qbittorrent"),
    webPort: 8080,
  },
  {
    id: "qui",
    name: "qui",
    category: "Downloads",
    area: "automation",
    images: img("qui"),
    webPort: 7476,
  },
  {
    id: "sabnzbd",
    name: "SABnzbd",
    category: "Downloads",
    area: "automation",
    images: img("sabnzbd"),
    webPort: 8080,
  },
  {
    id: "nzbget",
    name: "NZBGet",
    category: "Downloads",
    area: "automation",
    images: img("nzbget"),
    webPort: 6789,
  },
  {
    id: "transmission",
    name: "Transmission",
    category: "Downloads",
    area: "automation",
    images: img("transmission"),
    webPort: 9091,
  },
  {
    id: "deluge",
    name: "Deluge",
    category: "Downloads",
    area: "automation",
    images: img("deluge"),
    webPort: 8112,
  },
  {
    id: "gluetun",
    name: "Gluetun VPN",
    category: "Network",
    area: "network",
    images: img("gluetun"),
    supporting: true,
  },

  // Network
  {
    id: "caddy",
    name: "Caddy",
    category: "Network",
    area: "proxy",
    images: img("caddy"),
    supporting: true,
  },
  {
    id: "traefik",
    name: "Traefik",
    category: "Network",
    area: "proxy",
    images: img("traefik"),
    webPort: 8080,
  },
  {
    id: "npm",
    name: "Nginx Proxy Manager",
    category: "Network",
    area: "proxy",
    images: img("nginx-proxy-manager"),
    webPort: 81,
  },
  {
    id: "cloudflared",
    name: "Cloudflare Tunnel",
    category: "Network",
    area: "network",
    images: img("cloudflared"),
    supporting: true,
  },
  {
    id: "adguard",
    name: "AdGuard Home",
    category: "Network",
    area: "network",
    images: img("adguardhome"),
    webPort: 3000,
  },
  {
    id: "pihole",
    name: "Pi-hole",
    category: "Network",
    area: "network",
    images: img("pihole"),
    webPort: 80,
  },
  {
    id: "tailscale",
    name: "Tailscale",
    category: "Network",
    area: "network",
    images: img("tailscale"),
    supporting: true,
  },
  {
    id: "uptime-kuma",
    name: "Uptime Kuma",
    category: "Network",
    area: "network",
    images: img("uptime-kuma"),
    webPort: 3001,
  },
  {
    id: "rustdesk",
    name: "RustDesk relay",
    category: "Network",
    area: "network",
    images: img("rustdesk-server"),
    supporting: true,
  },

  // Home
  {
    id: "home-assistant",
    name: "Home Assistant",
    category: "Home",
    area: "containers",
    images: img("home-assistant", "homeassistant"),
    webPort: 8123,
    nativePort: 8123,
  },
  {
    id: "zigbee2mqtt",
    name: "Zigbee2MQTT",
    category: "Home",
    area: "containers",
    images: img("zigbee2mqtt"),
    webPort: 8080,
  },
  {
    id: "mosquitto",
    name: "Mosquitto",
    category: "Home",
    area: "containers",
    images: img("eclipse-mosquitto", "mosquitto"),
    supporting: true,
  },
  {
    id: "node-red",
    name: "Node-RED",
    category: "Home",
    area: "containers",
    images: img("node-red"),
    webPort: 1880,
  },

  // Files & Photos
  {
    id: "immich",
    name: "Immich",
    category: "Files & Photos",
    area: "containers",
    images: img("immich-server"),
    webPort: 2283,
  },
  {
    id: "immich-ml",
    name: "Immich machine learning",
    category: "Files & Photos",
    area: "containers",
    images: img("immich-machine-learning"),
    supporting: true,
  },
  {
    id: "nextcloud",
    name: "Nextcloud",
    category: "Files & Photos",
    area: "containers",
    images: img("nextcloud"),
    webPort: 80,
  },
  {
    id: "paperless",
    name: "Paperless-ngx",
    category: "Files & Photos",
    area: "containers",
    images: img("paperless-ngx"),
    webPort: 8000,
  },
  {
    id: "syncthing",
    name: "Syncthing",
    category: "Files & Photos",
    area: "containers",
    images: img("syncthing"),
    webPort: 8384,
    nativePort: 8384,
  },
  {
    id: "photoprism",
    name: "PhotoPrism",
    category: "Files & Photos",
    area: "containers",
    images: img("photoprism"),
    webPort: 2342,
  },

  // System
  {
    id: "portainer",
    name: "Portainer",
    category: "System",
    area: "containers",
    images: img("portainer-ce", "portainer-ee", "portainer"),
    webPort: 9000,
  },
  {
    id: "homarr",
    name: "Homarr",
    category: "System",
    area: "containers",
    images: img("homarr"),
    webPort: 7575,
  },
  {
    id: "homepage",
    name: "Homepage",
    category: "System",
    area: "containers",
    images: img("homepage"),
    webPort: 3000,
  },
  {
    id: "vaultwarden",
    name: "Vaultwarden",
    category: "System",
    area: "containers",
    images: img("vaultwarden/server", "vaultwarden"),
    webPort: 80,
  },
  {
    id: "watchtower",
    name: "Watchtower",
    category: "System",
    area: "containers",
    images: img("watchtower"),
    supporting: true,
  },
  {
    id: "dozzle",
    name: "Dozzle",
    category: "System",
    area: "containers",
    images: img("dozzle"),
    webPort: 8080,
  },
  {
    id: "backrest",
    name: "Backrest",
    category: "System",
    area: "storage",
    images: img("backrest"),
    webPort: 9898,
  },
  {
    id: "duplicati",
    name: "Duplicati",
    category: "System",
    area: "storage",
    images: img("duplicati"),
    webPort: 8200,
  },

  // Supporting data stores
  {
    id: "postgres",
    name: "PostgreSQL",
    category: "System",
    area: "storage",
    images: img("postgres", "pgvecto-rs"),
    supporting: true,
  },
  {
    id: "mariadb",
    name: "MariaDB",
    category: "System",
    area: "storage",
    images: img("mariadb", "mysql"),
    supporting: true,
  },
  {
    id: "redis",
    name: "Redis",
    category: "System",
    area: "storage",
    images: img("redis", "valkey"),
    supporting: true,
  },
  {
    id: "mongo",
    name: "MongoDB",
    category: "System",
    area: "storage",
    images: img("mongo"),
    supporting: true,
  },
];

/** "ghcr.io/immich-app/immich-server:v3" -> "immich-app/immich-server" */
export function imageRepository(image: string): string {
  let ref = image.split("@")[0]!;
  const lastSlash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  if (colon > lastSlash) ref = ref.slice(0, colon);
  const parts = ref.split("/");
  // Drop a registry host ("ghcr.io", "lscr.io", "localhost:5000").
  if (parts.length > 1 && /[.:]|^localhost$/.test(parts[0]!)) parts.shift();
  return parts.join("/");
}

export function identify(image: string): CatalogEntry | undefined {
  const repo = imageRepository(image);
  return CATALOG.find((entry) => entry.images.some((re) => re.test(repo)));
}
