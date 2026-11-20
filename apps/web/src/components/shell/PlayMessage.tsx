import { Loader2, Play, Square } from "lucide-react";
import { speaker, useSpeaker, useVoice } from "../../data/voice";
import { cx } from "../ui";

/**
 * Read one message aloud in the AI's voice (10-26): the Standard voice built into Hearth,
 * or the character's voice on your own speech machine. One message at a time; pressing it again,
 * or another message's, stops this one. Hidden only when voice isn't set up at all.
 */
export function PlayMessage({
  text,
  messageKey,
  className,
  look = "chip",
}: {
  text: string;
  messageKey: string;
  className?: string;
  /** "chip": beside Copy under a Lair answer. "room": the War Room's corner button. */
  look?: "chip" | "room";
}) {
  const voice = useVoice();
  const s = useSpeaker();
  if (!voice.data?.configured) return null;
  const mine = s.key === messageKey;
  const loading = mine && s.status === "loading";
  const playing = mine && s.status === "playing";
  const label = playing ? "Stop reading" : loading ? "Getting the voice" : "Read aloud";
  const icon = loading ? (
    <Loader2 strokeWidth={1.75} className="h-3.5 w-3.5 animate-spin" />
  ) : playing ? (
    <Square strokeWidth={1.75} className="h-3.5 w-3.5" />
  ) : (
    <Play strokeWidth={1.75} className="h-3.5 w-3.5" />
  );
  const press = () =>
    mine && s.status !== "idle" ? speaker.stop() : void speaker.say(text, undefined, messageKey);
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          press();
        }}
        aria-label={label}
        title={label}
        aria-pressed={playing}
        data-testid="play-message"
        className={cx(
          look === "room"
            ? "play"
            : "-ml-1.5 inline-flex min-h-8 items-center gap-1 rounded px-1.5 text-faint transition-colors duration-200 hover:text-gold",
          playing && "text-gold",
          className,
        )}
      >
        {icon}
        {look === "chip" && <span>{playing ? "Stop" : "Play"}</span>}
      </button>
      {mine && s.status === "idle" && s.error && (
        <span role="alert" className="text-[0.72rem] text-bad" data-testid="play-message-error">
          {s.error}
        </span>
      )}
    </>
  );
}
