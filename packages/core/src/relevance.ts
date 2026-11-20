/**
 * Is this text about the homelab? Plain word matching with no network, so
 * it is cheap enough to run on every prompt: well-known homelab vocabulary,
 * plus the names of the owner's own machines, projects, and services, which
 * come from their memory and systems (never built in).
 */

export const HOMELAB_WORDS = [
  "homelab",
  "home lab",
  "home-lab",
  "self-hosted",
  "selfhosted",
  "hearth",
  // The old name, so notes and conversations from before the rename still count.
  "dragon control",
  "server",
  "servers",
  "docker",
  "container",
  "containers",
  "compose",
  "plex",
  "jellyfin",
  "emby",
  "kavita",
  "sonarr",
  "radarr",
  "lidarr",
  "readarr",
  "prowlarr",
  "bazarr",
  "overseerr",
  "jellyseerr",
  "tautulli",
  "sabnzbd",
  "nzbget",
  "qbittorrent",
  "gluetun",
  "flaresolverr",
  "immich",
  "audiobookshelf",
  "romm",
  "kometa",
  "recyclarr",
  "wizarr",
  "ersatztv",
  "homarr",
  "portainer",
  "notifiarr",
  "uptime kuma",
  "caddy",
  "traefik",
  "nginx proxy manager",
  "reverse proxy",
  "tailscale",
  "wireguard",
  "syncthing",
  "home assistant",
  "proxmox",
  "truenas",
  "unraid",
  "nas",
  "raid",
  "backup",
  "backups",
  "media library",
  "arr stack",
  "usenet",
  "indexer",
  "indexers",
  "transcode",
  "transcoding",
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function patterns(extraNames: string[]): RegExp[] {
  const names = [
    ...HOMELAB_WORDS,
    ...extraNames.map((n) => n.toLowerCase().trim()).filter((n) => n.length >= 3),
  ];
  return [...new Set(names)].map((name) => new RegExp(`(^|[^a-z0-9])${escape(name)}($|[^a-z0-9])`));
}

/** True when the text mentions homelab vocabulary or one of `extraNames`. */
export function isHomelab(text: string, extraNames: string[] = []): boolean {
  const lower = text.toLowerCase();
  if (/\*arr\b|\barrs?\b/.test(lower)) return true;
  return patterns(extraNames).some((p) => p.test(lower));
}

/** For checking many texts against the same names: builds the patterns once. */
export function homelabMatcher(extraNames: string[] = []): (text: string) => boolean {
  const list = patterns(extraNames);
  return (text) => {
    const lower = text.toLowerCase();
    return /\*arr\b|\barrs?\b/.test(lower) || list.some((p) => p.test(lower));
  };
}
