import { useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { api } from "../../data/api";

/** A speaker as the pickers show it (the home view's music list). */
export interface SpeakerLike {
  entity: string;
  name: string;
  originalName?: string;
  renamed?: true;
}

/** Renames a speaker in Hearth (no name: back to its own). The name sticks everywhere. */
export function useRenameSpeaker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { entity: string; name?: string }) => api("PUT", "/api/home/speakers/name", v),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["home"] });
      void qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

const LONG_PRESS_MS = 550;

/**
 * One speaker in a picker, renamable in place (11-13, the owner: "the speaker picker shows model
 * numbers or IPs"): right-click on a desktop, a long press on a phone, or the pencil. Type the
 * name and press Enter; Escape keeps the old one; Reset name goes back to the speaker's own name.
 */
export function SpeakerChoice({
  x,
  pressed,
  onPick,
  className,
  target,
  children,
}: {
  x: SpeakerLike;
  pressed: boolean;
  onPick: () => void;
  className?: string;
  /** Show & Tell's name for the picking button. */
  target?: string;
  children?: ReactNode;
}) {
  const rename = useRenameSpeaker();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(x.name);
  const timer = useRef<number | undefined>(undefined);
  // A long press opens the box; the click that ends it must not also pick the speaker.
  const longPressed = useRef(false);
  const open = () => {
    setDraft(x.name);
    setEditing(true);
  };
  // Leaving the box: the long press that opened it is over, so the next tap picks again.
  const close = () => {
    longPressed.current = false;
    setEditing(false);
  };
  const save = (name: string | undefined) => {
    rename.mutate({ entity: x.entity, ...(name ? { name } : {}) });
    close();
  };

  if (editing)
    return (
      <form
        className="hd-spk-rename"
        data-testid="speaker-rename"
        onSubmit={(e) => {
          e.preventDefault();
          const name = draft.replace(/\s+/g, " ").trim();
          save(name && name !== x.originalName ? name : undefined);
        }}
      >
        <input
          autoFocus
          value={draft}
          maxLength={60}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
          aria-label={`New name for ${x.name}`}
          enterKeyHint="done"
        />
        {x.renamed && (
          <button type="button" onClick={() => save(undefined)} data-testid="speaker-reset">
            Reset name
          </button>
        )}
      </form>
    );

  return (
    <div className="hd-spk-row" data-testid="speaker-choice">
      <button
        type="button"
        className={className}
        aria-pressed={pressed}
        onClick={() => {
          if (longPressed.current) {
            longPressed.current = false;
            return;
          }
          onPick();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          open();
        }}
        onPointerDown={(e) => {
          if (e.pointerType === "mouse") return;
          longPressed.current = false;
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            longPressed.current = true;
            open();
          }, LONG_PRESS_MS);
        }}
        onPointerUp={() => window.clearTimeout(timer.current)}
        onPointerLeave={() => window.clearTimeout(timer.current)}
        onPointerCancel={() => window.clearTimeout(timer.current)}
        {...(target ? { "data-hearth-target": target } : {})}
      >
        {children}
      </button>
      <button
        type="button"
        className="hd-spk-pencil"
        onClick={open}
        aria-label={`Rename ${x.name}`}
        title="Rename"
        data-testid="speaker-pencil"
      >
        <Pencil size={14} aria-hidden />
      </button>
    </div>
  );
}
