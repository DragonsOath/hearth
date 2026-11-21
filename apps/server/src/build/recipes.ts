import type { VpnProvider } from "@dragon-control/core";

/**
 * Hearth's reviewed recipes for a beginner's media starter (docs/design/BUILDER.md): the exact
 * Compose file for each app, with pinned versions, its own folder, and the person's drive mounted
 * where the app needs it. The AI never writes these: it picks the next step, Hearth fills in the
 * recipe from the saved plan, and the owner approves exactly that.
 *
 * Every app joins one Docker network ("hearth"), so they reach each other by name (radarr:7878).
 * The drive with their movies and shows is mounted read-only into Jellyfin (it only plays them)
 * and as /data into Radarr, Sonarr and qBittorrent (one mount, so finished downloads move into
 * the library without copying where the drive allows it). Nothing on the drive is moved, renamed
 * or deleted by setting these up.
 */

export type RecipeId =
  "jellyfin" | "plex" | "seerr" | "radarr" | "sonarr" | "prowlarr" | "qbittorrent";

export const RECIPE_IDS: readonly RecipeId[] = [
  "jellyfin",
  "plex",
  "seerr",
  "radarr",
  "sonarr",
  "prowlarr",
  "qbittorrent",
];

export const NETWORK = "hearth";

export interface RecipeContext {
  /** The account Hearth runs as: the apps run as it, so the files they write are the owner's. */
  uid: number;
  gid: number;
  tz: string;
  /** The drive (its mount point) holding the movies and shows. */
  drive: string;
  /** qBittorrent's VPN: the provider, and which login Secure Vault holds for it. */
  vpn?: { provider: VpnProvider; type: "openvpn" | "wireguard" };
  /** Tests only (no VPN account in CI): qBittorrent on its own. Never set from the interface. */
  noVpnForTests?: boolean;
}

export interface Recipe {
  id: RecipeId;
  name: string;
  /** Where its web page answers on this computer. */
  port: number;
  /** The containers it makes. */
  containers: string[];
  /** The address Hearth talks to it on, from this computer. */
  local: string;
  /** Its Compose file, from the context. */
  compose(ctx: RecipeContext): string;
  /** Settings filled in from Secure Vault when it starts (written to its .env, never shown). */
  secrets?(ctx: RecipeContext): string[];
  /** A VPN: approving it asks the owner to confirm it's them. */
  protected?(ctx: RecipeContext): boolean;
  /** Images, pinned. */
  images: Record<string, string>;
}

/** Gluetun's names for the providers the plan knows. */
export const GLUETUN_PROVIDER: Record<VpnProvider, string> = {
  proton: "protonvpn",
  mullvad: "mullvad",
  nord: "nordvpn",
  surfshark: "surfshark",
  pia: "private internet access",
  express: "expressvpn",
  windscribe: "windscribe",
  airvpn: "airvpn",
};

/** Providers that need WireGuard in Gluetun (no username and password login). */
export const WIREGUARD_ONLY: readonly VpnProvider[] = ["airvpn"];

const IMAGES = {
  jellyfin: "jellyfin/jellyfin:12.4",
  plex: "lscr.io/linuxserver/plex:1.43.5",
  seerr: "ghcr.io/seerr-team/seerr:v3.5.2",
  radarr: "lscr.io/linuxserver/radarr:7.0.3",
  sonarr: "lscr.io/linuxserver/sonarr:4.0.20",
  prowlarr: "lscr.io/linuxserver/prowlarr:3.0.2",
  qbittorrent: "lscr.io/linuxserver/qbittorrent:5.3.0",
  gluetun: "qmcgaw/gluetun:v3.41.3",
} as const;

/** A YAML string: JSON's quoting is valid YAML, so no path or value can break the file. */
const q = (v: string) => JSON.stringify(v);

const network = `networks:
  default:
    name: ${NETWORK}
    external: true
`;

const header = (id: string) =>
  `# Set up by Hearth from its ${id} recipe, for your homelab plan. Your files are never moved.\nname: hearth-${id}\n`;

function lsio(
  ctx: RecipeContext,
  name: RecipeId,
  port: number,
  data: boolean,
  extra: string[] = [],
) {
  return `${header(name)}services:
  ${name}:
    image: ${IMAGES[name]}
    container_name: ${name}
    restart: unless-stopped
    environment:
      PUID: ${q(String(ctx.uid))}
      PGID: ${q(String(ctx.gid))}
      TZ: ${q(ctx.tz)}
${extra.map((l) => `      ${l}\n`).join("")}    ports:
      - ${q(`${port}:${port}`)}
    volumes:
      - ./config:/config
${data ? `      - ${q(`${ctx.drive}:/data`)}\n` : ""}${network}`;
}

export const RECIPES: Record<RecipeId, Recipe> = {
  jellyfin: {
    id: "jellyfin",
    name: "Jellyfin",
    port: 8096,
    containers: ["jellyfin"],
    local: "http://127.0.0.1:8096",
    images: { jellyfin: IMAGES.jellyfin },
    compose: (ctx) => `${header("jellyfin")}services:
  jellyfin:
    image: ${IMAGES.jellyfin}
    container_name: jellyfin
    restart: unless-stopped
    user: ${q(`${ctx.uid}:${ctx.gid}`)}
    environment:
      TZ: ${q(ctx.tz)}
    ports:
      - "8096:8096"
    volumes:
      - ./config:/config
      - ./cache:/cache
      # Your drive, read only: Jellyfin plays your movies and shows, never changes them.
      - ${q(`${ctx.drive}:/media:ro`)}
${network}`,
  },
  plex: {
    id: "plex",
    name: "Plex",
    port: 32400,
    containers: ["plex"],
    local: "http://127.0.0.1:32400",
    images: { plex: IMAGES.plex },
    // The host's network, as Plex recommends, so TVs and phones on the home network find it.
    // The owner signs in on its own page, which makes the server theirs.
    compose: (ctx) => `${header("plex")}services:
  plex:
    image: ${IMAGES.plex}
    container_name: plex
    restart: unless-stopped
    network_mode: host
    environment:
      PUID: ${q(String(ctx.uid))}
      PGID: ${q(String(ctx.gid))}
      TZ: ${q(ctx.tz)}
      VERSION: docker
    volumes:
      - ./config:/config
      # Your drive, read only: Plex plays your movies and shows, never changes them.
      - ${q(`${ctx.drive}:/media:ro`)}
`,
  },
  seerr: {
    id: "seerr",
    name: "Seerr",
    port: 5055,
    containers: ["seerr"],
    local: "http://127.0.0.1:5055",
    images: { seerr: IMAGES.seerr },
    compose: (ctx) => `${header("seerr")}services:
  seerr:
    image: ${IMAGES.seerr}
    container_name: seerr
    restart: unless-stopped
    init: true
    user: ${q(`${ctx.uid}:${ctx.gid}`)}
    environment:
      TZ: ${q(ctx.tz)}
      LOG_LEVEL: info
    # Plex runs on the computer's own network: Seerr reaches it as host.docker.internal.
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "5055:5055"
    volumes:
      - ./config:/app/config
${network}`,
  },
  radarr: {
    id: "radarr",
    name: "Radarr",
    port: 7878,
    containers: ["radarr"],
    local: "http://127.0.0.1:7878",
    images: { radarr: IMAGES.radarr },
    compose: (ctx) => lsio(ctx, "radarr", 7878, true),
  },
  sonarr: {
    id: "sonarr",
    name: "Sonarr",
    port: 8989,
    containers: ["sonarr"],
    local: "http://127.0.0.1:8989",
    images: { sonarr: IMAGES.sonarr },
    compose: (ctx) => lsio(ctx, "sonarr", 8989, true),
  },
  prowlarr: {
    id: "prowlarr",
    name: "Prowlarr",
    port: 9696,
    containers: ["prowlarr"],
    local: "http://127.0.0.1:9696",
    images: { prowlarr: IMAGES.prowlarr },
    compose: (ctx) => lsio(ctx, "prowlarr", 9696, false),
  },
  qbittorrent: {
    id: "qbittorrent",
    name: "qBittorrent with a VPN",
    port: 8080,
    containers: ["gluetun", "qbittorrent"],
    local: "http://127.0.0.1:8080",
    images: { gluetun: IMAGES.gluetun, qbittorrent: IMAGES.qbittorrent },
    protected: (ctx) => !ctx.noVpnForTests,
    secrets: (ctx) =>
      ctx.noVpnForTests
        ? []
        : ctx.vpn?.type === "wireguard"
          ? ["WIREGUARD_PRIVATE_KEY", "WIREGUARD_ADDRESSES"]
          : ["OPENVPN_USER", "OPENVPN_PASSWORD"],
    compose: (ctx) => {
      if (ctx.noVpnForTests) return lsio(ctx, "qbittorrent", 8080, true, ['WEBUI_PORT: "8080"']);
      if (!ctx.vpn) throw new Error("qBittorrent needs your VPN first.");
      const wg = ctx.vpn.type === "wireguard";
      return `${header("qbittorrent")}services:
  # The VPN: every byte qBittorrent sends goes through it, and nothing goes out if it drops.
  gluetun:
    image: ${IMAGES.gluetun}
    container_name: gluetun
    restart: unless-stopped
    cap_add:
      - NET_ADMIN
    devices:
      - /dev/net/tun:/dev/net/tun
    environment:
      VPN_SERVICE_PROVIDER: ${q(GLUETUN_PROVIDER[ctx.vpn.provider])}
      VPN_TYPE: ${wg ? "wireguard" : "openvpn"}
${
  wg
    ? `      WIREGUARD_PRIVATE_KEY: \${WIREGUARD_PRIVATE_KEY}
      WIREGUARD_ADDRESSES: \${WIREGUARD_ADDRESSES:-}
`
    : `      OPENVPN_USER: \${OPENVPN_USER}
      OPENVPN_PASSWORD: \${OPENVPN_PASSWORD}
`
}      TZ: ${q(ctx.tz)}
    ports:
      - "8080:8080"
  qbittorrent:
    image: ${IMAGES.qbittorrent}
    container_name: qbittorrent
    restart: unless-stopped
    network_mode: "service:gluetun"
    depends_on:
      gluetun:
        condition: service_healthy
    environment:
      PUID: ${q(String(ctx.uid))}
      PGID: ${q(String(ctx.gid))}
      TZ: ${q(ctx.tz)}
      WEBUI_PORT: "8080"
    volumes:
      - ./config:/config
      - ${q(`${ctx.drive}:/data`)}
${network}`;
    },
  },
};

/**
 * Inside the apps: Jellyfin reaches qBittorrent's Web UI through the VPN container's name when
 * there is one. What Radarr, Sonarr and Seerr use to reach each app.
 */
export function internalHost(id: RecipeId, ctx: Pick<RecipeContext, "noVpnForTests">): string {
  if (id === "qbittorrent") return ctx.noVpnForTests ? "qbittorrent" : "gluetun";
  return id;
}
