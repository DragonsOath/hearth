# Service panel branding

Owner request, 2026-11-02: each service's panel can carry its own visual identity (about 70% the
service, 30% Hearth) while still feeling like Hearth. Prowlarr is the first theme.

## How it works

- **Every service panel has a look** (`brandFor` in `apps/web/src/components/panels/brands.tsx`):
  - **painted**: the owner's artwork for that service (`PAINTED`: Sonarr, Radarr, Overseerr,
    qBittorrent);
  - **automatic**, for every other service: Hearth's neutral frame (`hearth-frame.webp`, the lava
    edges and stone with a plain header), the header lit in the service's own color
    (`BRAND_COLORS`, by its logo) and its real logo drawn large and faint. A service with no
    logo gets Hearth's orange.
- **Hearth's part on every panel**: the lava frame, the flame in the bottom edge, a strong orange
  glow around it, Hearth's type, tabs and buttons. The line under the tabs glows in the
  service's color.
- **Where it is applied**: once, in the panel frame (`WorkspaceFrame`), used by desk panels and the
  phone's service panel. `ServiceWorkspace` passes the service's app kind, name and image.
- **The look**: the owner's choice, saved with the theme (`ThemeChoice.panels`, Settings, General,
  Themes, **Service panels**) and set on the page root as `data-panels`; CSS shows the layer.
  - `minimal` (the default): no decoration. Today's look.
  - `service`: each service's own look.
  - `hearth`: Hearth's orange look on every panel.

## What a theme sets

| Field | What it does |
|---|---|
| `primary` | The service's color: header light, logo glow, tab line, the frame's inner glow. |
| `secondary` | A deeper second color for depth (derived from `primary`). |
| `frame` | The frame image and how it is cut: the service's painting, or Hearth's frame. |
| `auto.logo` | Automatic look only: the logo drawn large and faint in the header. |

Hearth's part never changes per service: its type, buttons, tabs, the lava frame and flame, and
the status colors (green, amber, red).

## Rules for a theme

- Decoration only: `aria-hidden`, `pointer-events: none`, behind the content (its own stacking
  layer in the frame), never animated.
- The frame's edges thin out on narrow panels and phones (`FRAME_SCALE`) and repeat down tall
  ones, so nothing squeezes or smears.
- One small WebP per painted service (60 to 90 KB) and one shared Hearth frame (about 27 KB); no
  libraries.
- The e2e test (`tests/e2e/panel-branding.spec.ts`) checks the color-contrast results stay the
  same as in Minimal.

## Painted frames (the owner's artwork)

Most themes are painted: the owner makes one image per service in a shared template (Hearth's lava
frame and dark stone, the "Hearth" title top left, the service's logo and name in the header, its
own motifs across the header, and Hearth's flame at the bottom centre; 1671 by 941).
`scripts/brand-frame.py` turns it into `apps/web/public/brands/<service>-frame.webp`:

- it crops off the title above the frame;
- it removes the logo and name painted in the header, because AI-made logos are not the real ones
  and the panel already shows the service's real logo and name in that spot;
- it lifts Hearth's flame out of the bottom edge (`hearth-emblem.webp`), so it is placed on its
  own and never stretches.

The frame is drawn as a nine-slice image (CSS `border-image`): the corners keep their shape at any
size, edges stretch across and repeat down, and the edges get thinner on a narrow panel or a phone
(`FRAME_SCALE`) so the middle never squeezes. Around it, a strong glow: Hearth's orange outside,
the service's color inside. Each image is 60 to 90 KB.

Painted so far: Sonarr (blue), Radarr (gold), Overseerr (purple) and qBittorrent (blue). Every other
service uses the automatic look until its painting arrives.

**Ember's panel** (the conversation, `CavePanel`) has its own painted frame (`EMBER_FRAME`,
`ember-frame.webp`, from the owner's Ember artwork with the painted mascot and name removed, so
the panel shows the AI's real picture and name). It shows with Service or Hearth branding, never
with Minimal.

To add a service: save its image, run
`python3 scripts/brand-frame.py <image> <app-kind> [where-the-logo-ends]`, and add one line to
`PAINTED` in `brands.tsx` (name, file, color).
