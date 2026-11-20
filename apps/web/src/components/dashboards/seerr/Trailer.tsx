import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/** The YouTube video id in a trailer address (Seerr's, as Hearth gives it). */
export const youtubeKey = (url?: string) => /[?&]v=([\w-]{11})(?:&|$)/.exec(url ?? "")?.[1];

/**
 * A trailer, played right here in Hearth (11-19, the owner: "the trailer plays in panel
 * awesome"): YouTube's own player, without its tracking cookies, with play, pause, seek and full
 * screen. Escape or the backdrop closes it.
 */
export function TrailerPlayer({
  videoKey,
  title,
  onClose,
}: {
  videoKey: string;
  title: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [onClose]);
  return createPortal(
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`Trailer: ${title}`}
      onClick={onClose}
      data-testid="trailer-player"
    >
      <div className="relative w-[min(960px,100%)]" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          aria-label="Close the trailer"
          onClick={onClose}
          className="absolute -top-12 right-0 grid h-10 w-10 place-items-center rounded-full border border-line-strong bg-panel text-ink hover:border-gold hover:text-gold"
        >
          <X className="h-5 w-5" />
        </button>
        <iframe
          title={`Trailer: ${title}`}
          src={`https://www.youtube-nocookie.com/embed/${videoKey}?autoplay=1&rel=0`}
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          allowFullScreen
          className="aspect-video w-full rounded-xl border border-line bg-black shadow-2xl"
        />
      </div>
    </div>,
    // Over a title's details (a modal dialog, in the top layer) it goes inside that dialog.
    [...document.querySelectorAll("dialog[open]")].at(-1) ?? document.body,
  );
}
