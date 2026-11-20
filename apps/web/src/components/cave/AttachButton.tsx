import { useRef, useState } from "react";
import { Loader2, Paperclip } from "lucide-react";
import { useCave } from "../shell/cave-context";
import { cx } from "../ui";
import { ATTACH_ACCEPT, readAttachment } from "./attachFile";

/**
 * The paperclip: pick photos or text files for your next message. Photos join the
 * attachments shown above the box (removable there); a text file's contents are handed to
 * `onText` to go into the message.
 */
export function AttachButton({
  onText,
  onError,
  className,
  label,
  onPicked,
}: {
  onText: (f: { name: string; text: string }) => void;
  onError: (message: string | null) => void;
  className?: string;
  /** Written beside the paperclip (the phone's + menu). */
  label?: string;
  /** After the files are read (the + menu closes). */
  onPicked?: () => void;
}) {
  const cave = useCave();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    onError(null);
    try {
      for (const file of [...files].slice(0, 4)) {
        const a = await readAttachment(file);
        if (a.kind === "image") cave.attach(a.attachment);
        else onText(a);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "It could not be attached.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
      onPicked?.();
    }
  };
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={ATTACH_ACCEPT}
        className="hidden"
        onChange={(e) => void pick(e.target.files)}
        data-testid="attach-input"
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={busy}
        aria-label="Attach a photo or file"
        title="Attach a photo or a text file"
        className={cx(
          label
            ? "flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-[0.92rem] text-ink hover:bg-gold/10 disabled:opacity-50"
            : "flex h-11 w-9 shrink-0 items-center justify-center rounded-lg text-faint transition-colors duration-200 hover:text-gold disabled:opacity-50",
          className,
        )}
        data-testid="attach"
      >
        {busy ? (
          <Loader2 strokeWidth={1.5} className="h-5 w-5 animate-spin motion-reduce:animate-none" />
        ) : (
          <Paperclip strokeWidth={1.5} className={cx("h-5 w-5", label && "text-gold")} />
        )}
        {label}
      </button>
    </>
  );
}
