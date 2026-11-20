import { useState } from "react";
import { Delete } from "lucide-react";
import { Modal } from "../workspace/dialogs";
import { cx } from "../ui";

/**
 * The unlock PIN (and the alarm's own code, when Home Assistant asks for one), on big keys a
 * finger can hit on a wall tablet. Neither is kept: they go with the one tap.
 */
export function PinPad({
  label,
  pinNeeded,
  alarmCode,
  onEnter,
  onCancel,
}: {
  label: string;
  /** Hearth's unlock PIN (opening a door, turning the alarm off). */
  pinNeeded: boolean;
  /** Home Assistant's alarm code too. */
  alarmCode: boolean;
  onEnter: (pin: string | undefined, code: string | undefined) => void;
  onCancel: () => void;
}) {
  const [stage, setStage] = useState<"pin" | "code">(pinNeeded ? "pin" : "code");
  const [pin, setPin] = useState("");
  const [code, setCode] = useState("");
  const value = stage === "pin" ? pin : code;
  const set = stage === "pin" ? setPin : setCode;
  const next = () => {
    if (stage === "pin" && alarmCode) return setStage("code");
    onEnter(pinNeeded ? pin : undefined, alarmCode ? code : undefined);
  };
  const key =
    "flex h-16 items-center justify-center rounded-2xl border border-line-strong text-[1.5rem] text-ink hover:border-gold/60 active:bg-gold/15";
  return (
    <Modal title={label} onCancel={onCancel}>
      <p className="mt-1 text-[0.9rem] text-muted">
        {stage === "pin" ? "Enter the home's unlock PIN." : "Enter the alarm's code."}
      </p>
      <p
        className="mt-3 h-10 text-center font-mono text-[1.8rem] tracking-[0.4em] text-ink"
        aria-live="polite"
        data-testid="pin-dots"
      >
        {"•".repeat(value.length) || " "}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2" data-testid="pin-pad">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((n) => (
          <button
            key={n}
            type="button"
            className={key}
            onClick={() => set((v) => (v + n).slice(0, 8))}
          >
            {n}
          </button>
        ))}
        <button type="button" className={cx(key, "text-[1rem] text-muted")} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={key} onClick={() => set((v) => (v + "0").slice(0, 8))}>
          0
        </button>
        <button
          type="button"
          className={key}
          aria-label="Delete"
          onClick={() => set((v) => v.slice(0, -1))}
        >
          <Delete className="h-6 w-6" />
        </button>
      </div>
      <button
        type="button"
        className="mt-3 min-h-14 w-full rounded-2xl bg-gold text-[1.1rem] text-bg hover:bg-gold-bright disabled:opacity-40"
        disabled={value.length < (stage === "pin" ? 4 : 1)}
        onClick={next}
        data-testid="pin-enter"
      >
        {stage === "pin" && alarmCode ? "Next" : "OK"}
      </button>
    </Modal>
  );
}
