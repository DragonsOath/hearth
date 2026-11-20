# Hearth brand

Hearth is the product ("Your digital home"). Its AI administrator is **Ember** by default
(confirmed by the owner 2026-10-16). Branded by default, personal by choice: whatever someone
names their own AI, and whichever look, voice, and personality they choose, always wins. The
theme once called "Ember" is shown as "Dragonfire" so the two don't share a name; its saved id is
still `ember`.

Ember's default picture is the owner's approved flame (`ember-flame-source.png`: gender-neutral,
no face), rendered to `apps/web/public/avatars/ember.webp` by `scripts/render-icons.mjs`. Installations claimed before the rebrand keep the pictures they
had (migration 0048 sets `ai_look_style` to `classic`). The living, voice-reactive flame and
optional fireplace sounds are tracked in issue #24.

## Files

- `hearth-logo-source.png`: the owner's logo artwork (mark and wordmark). The source of every
  icon: `node scripts/render-icons.mjs` cuts the mark from it and writes the app icons, the
  favicon, `apps/web/public/brand/hearth-mark.png`, and the trimmed `hearth-logo.webp`.
- `ember-flame-source.png`: Ember's approved default picture (transparent PNG), approved
  2026-10-16.
- `hearth-brand-sheet.jpg`: the owner's brand sheet (palette, lockups, app icons, sidebar),
  for reference.

## Palette (the Hearth theme, `apps/web/src/lib/theme.ts`)

| Name | Hex | Used for |
| --- | --- | --- |
| Ember | #FF8A00 | highlights, links, focus, the selected item |
| Flame | #FF5A1F | the main action button |
| Warm White | #F6E6D7 | text and titles |
| Charcoal | #1A1A1A | raised surfaces |
| Midnight | #0B0F14 | the background |

Contrast on the Midnight background: text 15.8:1, secondary text 8.9:1, faint text 5.9:1,
Ember 8.1:1, and the action button's text 6.2:1, all above WCAG AA. Status colors (green,
amber, red) are not brand colors and keep their meaning in every theme.

## Rules

- Hearth is the default theme only where nobody has chosen one; a chosen theme is never replaced.
- The wordmark is "hearth" in lowercase, in Warm White.
- The glow behind the Hearth theme is two static gradients: no blur, animation, or fixed
  backgrounds, so it costs nothing to scroll on a phone.
- Machine-facing names (repository, packages, `DC_*` settings, the service, paths, URLs, the
  name Hearth gives itself to Plex and in notification headers) still say Hearth until
  the owner approves the infrastructure rename separately.
