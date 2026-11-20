import { useState } from "react";
import { Check, MessageSquare } from "lucide-react";
import { THREAD_LOOKS, threadLook, threadLookImage } from "@dragon-control/core";
import { Button, cx } from "../ui";
import { Modal } from "../workspace/dialogs";

/**
 * Ember Thread Looks (11-17): a small Ember picture on a thread, so the conversation list shows at
 * a glance what each one is about. Only on the thread (the list and the chat's header), never in
 * place of the owner's own Ember.
 */
export function LookImage({ look, className }: { look: string | undefined; className?: string }) {
  const l = threadLook(look);
  if (!l) return null;
  return (
    <img
      src={threadLookImage(l.id)}
      alt=""
      aria-hidden
      loading="lazy"
      draggable={false}
      className={cx("shrink-0 rounded-full bg-bg object-cover ring-1 ring-gold/30", className)}
      data-look={l.id}
    />
  );
}

/**
 * New conversation, or a thread's picture, in a pop-up (11-18, the owner: no side scroller; "a
 * pop-up ... click a image then ok a little box to rename that's it and it goes away after you
 * click ok"). The pictures wrap in rows (three across on a phone, four wider) and scroll only up
 * and down. Picking one shows a name box under them, filled with that picture's name; OK starts
 * the thread (or saves the change) and closes the pop-up.
 */
export function LookDialog({
  current,
  currentTitle,
  onDone,
  onCancel,
  title = "New conversation",
  noneLabel = "No image",
}: {
  /** The look already on the thread (changing a picture), marked. */
  current?: string | null;
  /** The thread's name now (changing a picture): the name box starts with it. */
  currentTitle?: string;
  onDone: (look: string | undefined, name: string | undefined) => void;
  onCancel: () => void;
  title?: string;
  noneLabel?: string;
}) {
  // undefined: nothing picked yet; null: No image.
  const [picked, setPicked] = useState<string | null | undefined>(
    currentTitle !== undefined ? (current ?? null) : undefined,
  );
  const [name, setName] = useState(currentTitle ?? "");
  const [typed, setTyped] = useState(false);
  const pick = (look: string | null) => {
    setPicked(look);
    // The name follows the picture until the owner types one of their own.
    if (!typed && currentTitle === undefined) setName(look ? (threadLook(look)?.name ?? "") : "");
  };
  const ok = () => {
    if (picked === undefined) return;
    onDone(picked ?? undefined, name.trim() || undefined);
  };
  const tile = (on: boolean) =>
    cx(
      "relative flex min-h-24 min-w-0 flex-col items-center gap-1 rounded-lg border p-1.5 text-center",
      on ? "border-gold/70 bg-gold/15" : "border-line hover:border-gold/50 hover:bg-raised",
    );
  return (
    <Modal title={title} onCancel={onCancel} wide>
      <div data-testid="look-picker">
        <p className="mt-1 mb-3 text-[0.84rem] text-muted">
          Pick a picture, or none. Ember stays your Ember; the picture only marks the conversation.
        </p>
        <div
          className="grid max-h-[min(50vh,24rem)] grid-cols-3 gap-1.5 overflow-x-hidden overflow-y-auto pr-0.5 sm:grid-cols-4"
          role="group"
          aria-label="Pictures"
        >
          <button
            type="button"
            onClick={() => pick(null)}
            aria-pressed={picked === null}
            className={cx(tile(picked === null), "justify-center")}
            data-testid="look-none"
            title="A plain conversation, named by your first message"
          >
            <span className="grid h-12 w-12 place-items-center rounded-full border border-dashed border-line-strong text-muted">
              <MessageSquare strokeWidth={1.5} className="h-5 w-5" aria-hidden />
            </span>
            <span className="text-[0.76rem] leading-tight text-ink">{noneLabel}</span>
          </button>
          {THREAD_LOOKS.map((l) => {
            const on = picked === l.id;
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => pick(l.id)}
                title={l.for}
                aria-label={`${l.name}: ${l.for}`}
                aria-pressed={on}
                className={tile(on)}
                data-testid="look-option"
                data-look={l.id}
              >
                <img
                  src={threadLookImage(l.id)}
                  alt=""
                  aria-hidden
                  loading="lazy"
                  draggable={false}
                  className="h-12 w-12 rounded-full object-cover"
                />
                <span className="w-full truncate text-[0.78rem] leading-tight font-semibold text-ink">
                  {l.name}
                </span>
                <span className="line-clamp-2 w-full text-[0.66rem] leading-tight break-words text-faint">
                  {l.for}
                </span>
                {on && (
                  <Check
                    strokeWidth={2}
                    className="absolute top-1 right-1 h-3.5 w-3.5 text-gold"
                    aria-hidden
                  />
                )}
              </button>
            );
          })}
        </div>
        {picked !== undefined && (
          <form
            className="mt-4 flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              ok();
            }}
          >
            <label className="min-w-0 flex-1 text-[0.84rem] text-muted">
              Name
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setTyped(true);
                }}
                maxLength={80}
                placeholder="Named by your first message"
                className="mt-1 min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink placeholder:text-faint focus:border-gold focus:outline-none"
                data-testid="look-name"
              />
            </label>
            <Button tone="primary" type="submit" data-testid="look-ok">
              OK
            </Button>
          </form>
        )}
      </div>
    </Modal>
  );
}
