/**
 * Which project logo a service gets (public/logos, from Dashboard Icons, Apache 2.0).
 * Matched on the Docker image and the name together. The order matters: a database or
 * helper container named after its app ("PostgreSQL (immich_postgres)") is matched as
 * the database first, and "Jellyseerr" or "Overseerr" before plain "Seerr".
 */
const LOGOS: [file: string, match: RegExp][] = [
  ["postgres.svg", /postgres/],
  ["redis.svg", /\bredis\b/],
  ["mariadb.svg", /mariadb|mysql/],
  ["nginx-proxy-manager.svg", /nginx-proxy-manager|nginx proxy manager|jc21/],
  ["nginx.svg", /\bnginx\b/],
  ["gluetun.svg", /gluetun/],
  ["flaresolverr.svg", /flaresolverr/],
  ["jellyseerr.svg", /jellyseerr/],
  ["overseerr.svg", /overseerr/],
  ["seerr.svg", /\bseerr\b/],
  ["jellyfin.svg", /jellyfin/],
  ["emby.svg", /\bemby/],
  ["tautulli.svg", /tautulli/],
  ["plex.svg", /\bplex/],
  ["ersatztv.svg", /ersatztv/],
  ["kometa.png", /kometa/],
  ["recyclarr.svg", /recyclarr/],
  ["prowlarr.svg", /prowlarr/],
  ["radarr.svg", /radarr/],
  ["sonarr.svg", /sonarr/],
  ["lidarr.svg", /lidarr/],
  ["bazarr.svg", /bazarr/],
  ["chaptarr.svg", /chaptarr/],
  ["wizarr.svg", /wizarr/],
  ["romm.svg", /\bromm\b/],
  ["audiobookshelf.svg", /audiobookshelf|\babs\b/],
  ["kavita.svg", /kavita/],
  ["immich.svg", /immich/],
  ["syncthing.svg", /syncthing/],
  ["sabnzbd.svg", /sabnzbd/],
  ["qbittorrent.svg", /qbittorrent|qbit\b/],
  ["deluge.svg", /\bdeluge/],
  ["transmission.svg", /transmission/],
  ["nzbget.svg", /nzbget/],
  ["qui.svg", /\bqui\b/],
  ["adguard-home.svg", /adguard/],
  ["proxmox.svg", /proxmox/],
  ["portainer.svg", /portainer/],
  ["uptime-kuma.svg", /uptime[- _]?kuma/],
  ["nextcloud.svg", /nextcloud/],
  ["paperless.png", /paperless/],
  ["vaultwarden.png", /vaultwarden|bitwarden_?rs/],
  ["tailscale.svg", /tailscale/],
  ["wg-easy.png", /wg-?easy/],
  ["navidrome.png", /navidrome/],
  ["komga.png", /komga/],
  ["mealie.png", /mealie/],
  ["authentik.svg", /authentik/],
  ["frigate.svg", /frigate/],
  ["authelia.png", /authelia/],
  ["actual.png", /actual[-_ ]?(server|budget)|actualbudget/],
  ["forgejo.svg", /forgejo/],
  ["gitea.svg", /gitea/],
  ["pi-hole.svg", /pi-?hole/],
  ["rustdesk.svg", /rustdesk|\bhbb[rs]\b/],
  ["opnform.svg", /opnform/],
  ["home-assistant.svg", /home.?assistant|\bha.ui\b/],
  ["caddy.svg", /\bcaddy\b/],
  ["traefik.svg", /traefik/],
  ["docker.svg", /^docker$/],
  ["windows-11.svg", /\bwindows\b/],
  ["linux.svg", /\blinux\b/],
];

/** The logo's address, or undefined when the service has none (it keeps its letters). */
export function logoFor(name: string, image?: string): string | undefined {
  // The image without its registry and tag: "ghcr.io/hotio/radarr:latest" is "radarr".
  const base =
    image
      ?.split("@")[0]!
      .replace(/:[^/]*$/, "")
      .split("/")
      .pop() ?? "";
  const text = name.toLowerCase().trim();
  const hit =
    LOGOS.find(([, re]) => re.test(text)) ??
    (base ? LOGOS.find(([, re]) => re.test(base.toLowerCase())) : undefined);
  return hit && `/logos/${hit[0]}`;
}
