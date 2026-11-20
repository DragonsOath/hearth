import type { CSSProperties } from "react";
import type { AppKind } from "@dragon-control/core";
import { logoFor } from "../../lib/logos";
import { mix } from "../../lib/theme";
import type { PanelSize } from "./size";

/**
 * Service branding for panels: every service panel sits in Hearth's glowing lava frame (Hearth's
 * part) with a header in the service's own identity (the service's part). The owner picks the look
 * in Settings, Themes, Service panels: Minimal (the default, no decoration), Service branding, or
 * Hearth branding (Hearth's own colors on every panel).
 *
 * Two kinds of service look:
 * - painted: the owner's artwork for that service (PAINTED, cut by scripts/brand-frame.py);
 * - automatic: for every other service, Hearth's frame with the header lit in the service's own
 *   color (BRAND_COLORS) and its real logo drawn large and faint, so each panel is recognisably
 *   its service while all of them look like one family.
 *
 * The frame (WorkspaceFrame) applies it, so no panel has theme code of its own. All of it is
 * decoration: behind the content, never clickable, hidden from screen readers, never animated.
 */

export interface PanelFrame {
  /** The image (WebP, in apps/web/public/brands). */
  src: string;
  /** Where to cut the image, in its own pixels: top, right, bottom, left. */
  slice: [number, number, number, number];
  /** How wide each cut edge is drawn in the panel, in CSS pixels: top, right, bottom, left. */
  width: [number, number, number, number];
}

export interface PanelBrand {
  /** The service's name (the decoration's label in tests and docs). */
  name: string;
  /** The service's main color: its header light, seam, logo glow and the frame's inner glow. */
  primary: string;
  /** A deeper second color for depth. */
  secondary: string;
  /** The frame image: the service's own painting, or Hearth's neutral frame. */
  frame: PanelFrame;
  /** Automatic look only: the service's logo, drawn large and faint in the header. */
  auto?: { logo?: string };
}

/** Hearth's flame, set into the bottom edge of every frame (never stretched). */
export const HEARTH_EMBLEM = "/brands/hearth-emblem.webp";

/**
 * How the owner's panel paintings are cut (1671 by 873 after scripts/brand-frame.py): the header
 * band is the top 200, the right 520 holds the header's main motif, and the lava edges are the
 * outer 230 at the left and 170 at the bottom.
 */
const SERVICE_SLICE: PanelFrame["slice"] = [200, 520, 170, 230];
const SERVICE_WIDTH: PanelFrame["width"] = [100, 250, 82, 110];

/** Hearth's own frame with a plain stone header, lit per service in code. Same cut as a painting. */
export const HEARTH_FRAME: PanelFrame = {
  src: "/brands/hearth-frame.webp",
  slice: SERVICE_SLICE,
  width: SERVICE_WIDTH,
};

const deeper = (c: string) => mix(c, "#000000", 0.55);

/** The services with the owner's painted artwork. */
const PAINTED: Partial<Record<AppKind, { name: string; file: string; primary: string }>> = {
  // Blue: mountains, film and a TV.
  sonarr: { name: "Sonarr", file: "sonarr", primary: "#35c5f4" },
  // Gold: a film strip, clapperboard, popcorn and a reel.
  radarr: { name: "Radarr", file: "radarr", primary: "#ffc230" },
  // Purple: a home cinema, a ticket, a screen of people and popcorn (Overseerr, Jellyseerr).
  seerr: { name: "Overseerr", file: "seerr", primary: "#a855f7" },
  // Blue: arrows, folders, a globe, a download and servers.
  qbittorrent: { name: "qBittorrent", file: "qbittorrent", primary: "#3b9cf6" },
};

/** The app kinds with the owner's painted artwork. */
export const PAINTED_KINDS = Object.keys(PAINTED) as AppKind[];

/**
 * Each service's own color, by its logo file (lib/logos.ts): what lights its header. Picked from
 * each project's own logo. A service without one gets Hearth's ember orange.
 */
export const BRAND_COLORS: Record<string, string> = {
  "adguard-home": "#68bc71",
  audiobookshelf: "#e8a33d",
  bazarr: "#8e6dd8",
  caddy: "#1fb5a5",
  chaptarr: "#e0614f",
  deluge: "#4c90e8",
  transmission: "#d0312d",
  nzbget: "#36a24a",
  docker: "#2496ed",
  ersatztv: "#2aa6de",
  flaresolverr: "#f48120",
  gluetun: "#4fbf6b",
  "home-assistant": "#41bdf5",
  immich: "#5b6ee1",
  jellyfin: "#aa5cc3",
  emby: "#52b54b",
  gitea: "#609926",
  jellyseerr: "#8b5cf6",
  kavita: "#4ac694",
  kometa: "#e5a00d",
  komga: "#2f6fd6",
  lidarr: "#22c55e",
  linux: "#f5c400",
  mariadb: "#c0765a",
  mealie: "#e58325",
  actual: "#8b5cf6",
  authentik: "#fd4b2d",
  frigate: "#3b82f6",
  authelia: "#4f6cf0",
  navidrome: "#3b82f6",
  nextcloud: "#0082c9",
  nginx: "#22a35a",
  "nginx-proxy-manager": "#f15933",
  opnform: "#3b82f6",
  overseerr: "#a855f7",
  paperless: "#3fa34d",
  "pi-hole": "#e0352b",
  plex: "#e5a00d",
  portainer: "#13bef9",
  tailscale: "#9aa4b2",
  "uptime-kuma": "#5cdd8b",
  "wg-easy": "#e2463f",
  vaultwarden: "#3b82f6",
  postgres: "#4f8cc9",
  prowlarr: "#ff8a1e",
  proxmox: "#e57000",
  qbittorrent: "#3b9cf6",
  qui: "#5b8def",
  radarr: "#ffc230",
  recyclarr: "#2fb5b5",
  redis: "#dc382d",
  romm: "#9b59ff",
  rustdesk: "#2f6bff",
  sabnzbd: "#f5c400",
  seerr: "#a855f7",
  sonarr: "#35c5f4",
  syncthing: "#0ea5e9",
  tautulli: "#e5a00d",
  traefik: "#24a1c1",
  "windows-11": "#0078d4",
  wizarr: "#845ef7",
};

/** Hearth's ember orange: the frame's own color, and the header of a service with no logo. */
export const HEARTH_ORANGE = "#ff8a1e";

/** The look of a service's panel: its painting when it has one, else the automatic look. */
export function brandFor(service: {
  kind?: AppKind;
  name: string;
  image?: string | null;
}): PanelBrand {
  const p = service.kind ? PAINTED[service.kind] : undefined;
  if (p)
    return {
      name: p.name,
      primary: p.primary,
      secondary: deeper(p.primary),
      frame: { src: `/brands/${p.file}-frame.webp`, slice: SERVICE_SLICE, width: SERVICE_WIDTH },
    };
  const logo = logoFor(service.name, service.image ?? undefined);
  const key = logo
    ?.split("/")
    .pop()
    ?.replace(/\.(svg|png|webp)$/, "");
  const primary = (key && BRAND_COLORS[key]) || HEARTH_ORANGE;
  return {
    name: service.name,
    primary,
    secondary: deeper(primary),
    frame: HEARTH_FRAME,
    auto: { logo },
  };
}

/** Hearth branding: Hearth's own look on every panel, the same for all services. */
export const HEARTH_BRAND: PanelBrand = {
  name: "Hearth",
  primary: HEARTH_ORANGE,
  secondary: deeper(HEARTH_ORANGE),
  frame: HEARTH_FRAME,
  auto: {},
};

/**
 * The look of a Hearth panel that is not an app (Storage & Files, a project, a workspace, the
 * to-do list): Hearth's own frame and orange, so with branding on every panel on the desk matches.
 */
export function hearthPanelBrand(name: string): PanelBrand {
  return { ...HEARTH_BRAND, name };
}

/** The CSS variables a branded frame carries, so its glow and decoration share its colors. */
export function brandStyle(brand: PanelBrand | undefined): CSSProperties | undefined {
  return brand
    ? ({ "--brand-primary": brand.primary, "--brand-secondary": brand.secondary } as CSSProperties)
    : undefined;
}

/**
 * How much of a frame's full size a panel of this size draws: a narrow panel or a phone gets
 * thinner edges, so the middle keeps its width and the artwork never squeezes into streaks.
 */
export const FRAME_SCALE: Record<PanelSize, number> = {
  mobile: 0.45,
  compact: 0.5,
  normal: 0.75,
  expanded: 1,
  maximized: 1,
};

/** A frame drawn as a nine-slice image, its edges at `scale` of their full width. */
export function FrameImage({
  frame,
  scale = 1,
  repeat = "stretch round",
}: {
  frame: PanelFrame;
  scale?: number;
  repeat?: string;
}) {
  return (
    <div
      className="absolute inset-0 rounded-[inherit]"
      style={{
        borderStyle: "solid",
        borderWidth: frame.width.map((w) => `${Math.round(w * scale)}px`).join(" "),
        borderImageSource: `url(${frame.src})`,
        borderImageSlice: `${frame.slice.join(" ")} fill`,
        // Across: stretched. Down: the lava edges repeat rather than smear on a tall panel.
        borderImageRepeat: repeat,
      }}
    />
  );
}

/**
 * The automatic header: the service's color lighting the header from the right and its real logo
 * large and faint, kept left of the window buttons. The glowing seam is the line under the tabs
 * (index.css), so it follows the header at every size.
 */
function AutoHeader({ brand, scale }: { brand: PanelBrand; scale: number }) {
  const band = Math.round(118 * scale) + 24;
  return (
    <div className="absolute inset-x-0 top-0" style={{ height: band + 24 }}>
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(55% 130% at 78% 0%, color-mix(in srgb, var(--brand-primary) 42%, transparent), color-mix(in srgb, var(--brand-secondary) 30%, transparent) 45%, transparent 75%)",
        }}
      />
      {brand.auto?.logo && (
        <img
          src={brand.auto.logo}
          alt=""
          draggable={false}
          className="absolute object-contain"
          style={{
            right: "clamp(56px, 16%, 170px)",
            top: Math.round(6 * scale) + 4,
            height: band + 10,
            width: band + 10,
            opacity: 0.26,
            filter: "drop-shadow(0 0 18px var(--brand-primary)) saturate(1.2)",
            // Soft edges: the logo reads as part of the artwork, not a sticker.
            maskImage: "radial-gradient(closest-side, #000 55%, transparent 100%)",
            WebkitMaskImage: "radial-gradient(closest-side, #000 55%, transparent 100%)",
          }}
        />
      )}
    </div>
  );
}

/** One look's layer: the frame, the automatic header when it has one, and Hearth's flame. */
function Layer({
  brand,
  layer,
  scale,
}: {
  brand: PanelBrand;
  layer: "service" | "hearth";
  scale: number;
}) {
  return (
    <div
      className="panel-brand absolute inset-0"
      data-layer={layer}
      data-panel-brand={brand.name.toLowerCase()}
      data-frame={brand.auto ? "auto" : "painted"}
      style={brandStyle(brand)}
    >
      <FrameImage frame={brand.frame} scale={scale} />
      {brand.auto && <AutoHeader brand={brand} scale={scale} />}
      <img
        src={HEARTH_EMBLEM}
        alt=""
        className="absolute bottom-0 left-1/2 -translate-x-1/2"
        style={{ width: Math.round(90 * scale) }}
        draggable={false}
      />
    </div>
  );
}

/**
 * The decoration behind a service panel: its own look and Hearth's, each shown only in its own
 * mode (the root's data-panels, set from the saved theme). Minimal shows neither.
 */
export function PanelDecoration({
  brand,
  size = "normal",
}: {
  brand: PanelBrand;
  size?: PanelSize;
}) {
  const scale = FRAME_SCALE[size];
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-[inherit]"
    >
      <Layer brand={brand} layer="service" scale={scale} />
      <Layer brand={HEARTH_BRAND} layer="hearth" scale={scale} />
    </div>
  );
}

/**
 * Ember's own panel (the conversation): Hearth's lava frame, flames along the header and embers
 * rising from the bottom, from the owner's artwork (the painted mascot and name removed: the panel
 * shows the AI's real picture and name). The image is 899 by 1543: the header and its flame line
 * are the top 240, the lava the bottom 330.
 */
export const EMBER_FRAME: PanelFrame = {
  src: "/brands/ember-frame.webp",
  slice: [240, 60, 330, 60],
  width: [96, 24, 132, 24],
};

/** The decoration behind Ember's panel, shown with Service or Hearth branding, never Minimal. */
export function EmberDecoration() {
  return (
    <div
      aria-hidden="true"
      className="ember-frame pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-[inherit]"
      data-frame="ember"
    >
      <FrameImage frame={EMBER_FRAME} />
    </div>
  );
}
