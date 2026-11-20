import { HeartPulse } from "lucide-react";

/**
 * The pictures of Hearth's own panels (the owner's Ember mascot artwork, 2026-11-02): Ember at the
 * filing cabinet for Storage & Files, Ember with a clipboard for the to-do list, Ember with a
 * spyglass for her browser. Shown on the
 * panel's header and its switch in the Lair.
 */
export const TOOL_IMAGES = {
  storage: "/brand/ember-storage.webp",
  todo: "/brand/ember-todo.webp",
  browser: "/brand/ember-browser.webp",
  // Ember as an usher with a clapperboard, for Home rows (the owner's artwork, 2026-11-06).
  "home-rows": "/brand/ember-home-rows.webp",
  // Ember as a doctor with her clipboard, for Download Health (the owner's artwork, 2026-11-07).
  downloads: "/brand/ember-download-health.webp",
  // Ember the curator with her glasses, film reel, headphones and book (the owner's artwork,
  // 2026-11-09).
  curator: "/brand/ember-curator.webp",
  // Ember at her anvil, for the Forge (the owner's artwork, 2026-11-10).
  forge: "/brand/ember-forge.webp",
  // Ember the herald with her beret, megaphone and scroll, for Movie nights (the owner's artwork,
  // 2026-11-12).
  "movie-nights": "/brand/ember-movie-nights.webp",
  // Ember the quality inspector with her goggles, magnifying glass and checklist, for the
  // Crucible (the owner's artwork, 2026-11-17).
  crucible: "/brand/ember-crucible.webp",
} as const;

const FALLBACK_ICONS: Partial<Record<keyof typeof TOOL_IMAGES, typeof HeartPulse>> = {};

export function ToolImage({
  id,
  className = "h-11 w-11",
}: {
  id: keyof typeof TOOL_IMAGES;
  className?: string;
}) {
  if (!TOOL_IMAGES[id])
    return (
      <span
        aria-hidden
        className={`${className} flex shrink-0 items-center justify-center rounded-full border border-gold/40 text-gold`}
      >
        {(() => {
          const Icon = FALLBACK_ICONS[id] ?? HeartPulse;
          return <Icon strokeWidth={1.5} className="h-1/2 w-1/2" />;
        })()}
      </span>
    );
  return (
    <img
      src={TOOL_IMAGES[id]}
      alt=""
      width={128}
      height={128}
      draggable={false}
      className={`${className} shrink-0 object-contain select-none`}
    />
  );
}
