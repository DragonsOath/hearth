import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useAiName, useWorkspace } from "../../data/api";
import { DragonEmblem } from "../shell/DragonEmblem";
import { Button, cx } from "../ui";

/**
 * The Ember mark (11-12, the owner: "I don't want them thinking I'm just clicking a button, no
 * harm"): every button that starts Ember carries it, so a click that spends the owner's AI plan
 * never looks like a plain one. It is Ember's own picture in a small glowing pill, with the AI
 * behind it (Claude, Codex, Ollama). Buttons that talk to an app directly never carry it.
 */

/** The AI that answers for Ember, short ("Claude", "Codex", "Ollama"), and its full name. */
export function useEmberEngine(): { short: string; full: string } {
  const ws = useWorkspace().data;
  const id = ws?.operator.agentId;
  const full = ws?.agents.find((a) => a.id === id)?.name ?? "your AI";
  return { short: full.replace(/ Code$/, ""), full };
}

/** What the mark means, said the same way everywhere. */
export function useEmberMarkMeaning(): string {
  const ai = useAiName();
  const { full } = useEmberEngine();
  return `Starts ${ai}: uses your ${full === "your AI" ? "AI" : `${full} plan`}`;
}

export function EmberMark({ className }: { className?: string }) {
  const { short } = useEmberEngine();
  const meaning = useEmberMarkMeaning();
  return (
    <span
      className={cx(
        "ember-mark inline-flex h-5 shrink-0 items-center gap-1 rounded-full pr-1.5 pl-0.5 text-[0.66rem] leading-none font-semibold",
        className,
      )}
      title={meaning}
      data-testid="ember-mark"
    >
      <DragonEmblem className="h-4 w-4 drop-shadow-[0_0_3px_rgba(232,145,58,0.9)]" />
      <span aria-hidden="true">{short}</span>
      <span className="sr-only">({meaning})</span>
    </span>
  );
}

/** The key: the mark, then what it means. */
export function EmberMarkLegend({ className }: { className?: string }) {
  const meaning = useEmberMarkMeaning();
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-[0.78rem] text-faint", className)}>
      <EmberMark />
      <span>= {meaning.replace(/^Starts [^:]+: /, "")}</span>
    </span>
  );
}

const SEEN = "dc-ember-mark-seen";

/** Whether this browser has seen the first-press note (a per-viewer convenience). */
export function emberMarkSeen(): boolean {
  try {
    return localStorage.getItem(SEEN) === "1";
  } catch {
    return false;
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN, "1");
  } catch {
    // Private window: the note shows again next time, which is harmless.
  }
}

/**
 * The first press of a marked button: before Ember starts, say plainly that it is Ember and that
 * it uses the owner's AI plan, and what the mark means from now on.
 */
export function EmberMarkNotice({ onRun, onClose }: { onRun: () => void; onClose: () => void }) {
  const ai = useAiName();
  const { full } = useEmberEngine();
  const [again, setAgain] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>("[data-testid=ember-mark-run]")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const plan = full === "your AI" ? "your AI" : `your ${full} plan`;
  return createPortal(
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ember-mark-title"
        className="w-full max-w-md space-y-4 rounded-2xl border border-gold/50 bg-panel p-5 shadow-2xl"
        data-testid="ember-mark-notice"
      >
        <div className="flex items-start justify-between gap-3">
          <h2
            id="ember-mark-title"
            className="flex items-center gap-3 font-display text-[1.3rem] text-ink"
          >
            <DragonEmblem className="h-11 w-11 drop-shadow-[0_0_8px_rgba(232,145,58,0.7)]" />
            This button starts {ai}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-faint hover:bg-raised hover:text-ink"
          >
            <X strokeWidth={1.5} className="h-5 w-5" />
          </button>
        </div>
        <p className="text-[0.9rem] leading-relaxed text-ink">
          {ai} takes it from here and works on it using {plan}, the same as asking in chat.
        </p>
        <div className="space-y-2 rounded-xl border border-line bg-bg/50 p-3 text-[0.84rem] text-muted">
          <EmberMarkLegend />
          <p>Buttons without it talk to your apps directly and use no AI.</p>
        </div>
        <label className="flex min-h-11 items-center gap-2.5 text-[0.86rem] text-ink">
          <input
            type="checkbox"
            checked={again}
            onChange={(e) => setAgain(e.target.checked)}
            className="h-5 w-5 accent-gold"
          />
          Got it, don&apos;t show this again
        </label>
        <div className="flex gap-2">
          <Button
            tone="primary"
            onClick={() => {
              if (again) markSeen();
              onRun();
            }}
            data-testid="ember-mark-run"
          >
            Start {ai}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
