import { useState } from "react";
import { Button } from "../../components/ui";

/** A recovery key, shown once, with a way to copy it and a promise that it was saved. */
export function RecoveryKeyPanel({
  recoveryKey,
  onDone,
  doneLabel = "Continue",
}: {
  recoveryKey: string;
  onDone: () => void;
  doneLabel?: string;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <>
      <p className="mb-5 text-[0.9rem] leading-relaxed text-muted">
        If you ever lose your password and passkeys, this key is the only way back in. Nobody can
        recover it for you, including the people who make Hearth. Print it or keep it in a password
        manager.
      </p>
      <p
        data-testid="recovery-key"
        data-sensitive
        className="mb-4 rounded-xl border border-gold/40 bg-bg px-4 py-5 text-center font-mono text-[1.05rem] tracking-[0.12em] break-all text-gold sm:text-[1.15rem]"
      >
        {recoveryKey}
      </p>
      <Button
        tone="quiet"
        onClick={() => {
          void navigator.clipboard?.writeText(recoveryKey).then(() => setCopied(true));
        }}
      >
        {copied ? "Copied" : "Copy to clipboard"}
      </Button>
      <label className="mt-6 flex min-h-11 cursor-pointer items-start gap-3 text-[0.9rem] text-ink">
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
          className="mt-1 h-4 w-4 accent-[var(--color-gold)]"
        />
        I have saved my recovery key somewhere safe.
      </label>
      <Button tone="primary" className="mt-6 w-full" disabled={!saved} onClick={onDone}>
        {doneLabel}
      </Button>
    </>
  );
}
