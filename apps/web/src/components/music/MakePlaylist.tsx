import { useState } from "react";
import { Sparkles } from "lucide-react";
import { useCaveMaybe } from "../shell/cave-context";
import { EmberMark } from "../ember/EmberMark";
import { cx } from "../ui";

/**
 * Have Ember make a playlist from your own music (11-12, the owner: "if I owned my own music and
 * was using Plexamp, would it still work?"): the same flow as the Home Assistant music card, in
 * the panel of a server that holds the music itself (Plex, Jellyfin, Navidrome). Ember picks only
 * songs that are in the library, opens them in the Forge to swap, and makes the playlist in that
 * app after your yes, so Plexamp and the other players see it straight away.
 */
export function ownMusicPlaylistPrompt(
  app: string,
  serviceId: string,
  serviceName: string,
  what: string,
  count: number,
  name: string,
  library?: string,
) {
  return [
    `Make me a playlist in ${serviceName} (${app} service ${serviceId}${library ? `, its "${library}" library` : ""}) from my own music: ${what}. About ${count} songs.`,
    name ? `Call it "${name}".` : "Suggest a name.",
    "Ask me anything you still need first, one short question at a time.",
  ].join(" ");
}

const field =
  "min-h-11 w-full rounded-lg border border-line-strong bg-bg/60 px-3 text-[0.88rem] text-ink focus:border-gold/60 focus:outline-none";

export function MakePlaylist({
  app,
  serviceId,
  serviceName,
  library,
  className,
}: {
  app: "Plex" | "Jellyfin" | "Emby" | "Navidrome";
  serviceId: string;
  serviceName: string;
  library?: string;
  className?: string;
}) {
  const cave = useCaveMaybe();
  const [open, setOpen] = useState(false);
  const [what, setWhat] = useState("");
  const [count, setCount] = useState("50");
  const [name, setName] = useState("");
  if (!cave) return null;
  if (!open)
    return (
      <button
        type="button"
        className={cx(
          "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-3 text-[0.8rem] text-gold hover:bg-gold/10",
          className,
        )}
        onClick={() => setOpen(true)}
        data-testid="make-playlist"
      >
        <Sparkles strokeWidth={1.5} className="h-3.5 w-3.5" aria-hidden /> Have Ember make a
        playlist
      </button>
    );
  const n = Math.min(300, Math.max(5, Number(count) || 50));
  return (
    <form
      className={cx("space-y-3 rounded-xl border border-gold/40 bg-gold/5 p-3", className)}
      data-testid="make-playlist-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!what.trim()) return;
        cave.ask(
          ownMusicPlaylistPrompt(app, serviceId, serviceName, what.trim(), n, name.trim(), library),
        );
        setOpen(false);
        setWhat("");
        setName("");
      }}
    >
      <label className="block space-y-1">
        <span className="text-[0.82rem] text-muted">What kind of playlist?</span>
        <textarea
          value={what}
          onChange={(e) => setWhat(e.target.value)}
          rows={2}
          placeholder="2010s rock like Muse, a rainy-day mix, songs for a road trip"
          className={cx(field, "py-2")}
          data-testid="make-playlist-what"
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="space-y-1">
          <span className="block text-[0.82rem] text-muted">About how many songs</span>
          <input
            type="number"
            min={5}
            max={300}
            value={count}
            onChange={(e) => setCount(e.target.value)}
            className={cx(field, "w-28")}
          />
        </label>
        <label className="min-w-48 flex-1 space-y-1">
          <span className="block text-[0.82rem] text-muted">Name (optional)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={field} />
        </label>
      </div>
      <p className="text-[0.8rem] text-muted">
        Ember picks songs from {serviceName}&apos;s library and opens them in the Forge so you can
        swap any. Nothing is made until you say yes.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={!what.trim()}
          className="dc-primary inline-flex min-h-11 items-center gap-2 rounded-lg px-4 text-[0.85rem] font-medium disabled:opacity-40"
          data-testid="make-playlist-go"
        >
          Ask Ember to make it <EmberMark />
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="inline-flex min-h-11 items-center rounded-lg border border-line-strong px-4 text-[0.85rem] text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
