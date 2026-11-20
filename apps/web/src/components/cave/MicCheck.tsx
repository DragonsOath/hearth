import { useEffect, useState } from "react";
import { MicOff } from "lucide-react";
import { chooseMic, listMics, useMicChoice } from "../../lib/micChoice";

/**
 * Shown in a conversation when the microphone gives only silence: which mic that is, and the
 * others this browser can use, to switch with one choice. A remote-desktop or virtual mic is
 * often the browser's default and never hears anyone.
 */
export function MicCheck({ aiName, micName }: { aiName: string; micName?: string }) {
  const chosen = useMicChoice();
  const [mics, setMics] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let live = true;
    const load = () =>
      void listMics()
        .then((m) => live && setMics(m))
        .catch(() => undefined);
    load();
    navigator.mediaDevices?.addEventListener?.("devicechange", load);
    return () => {
      live = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", load);
    };
  }, []);
  const current = mics.find((m) => m.id === chosen)?.id ?? "";

  return (
    <div
      className="mt-3 w-full max-w-md rounded-xl border border-amber/50 bg-bg/80 p-3 text-[0.84rem] text-muted"
      role="alert"
      data-testid="mic-silent"
    >
      <p className="flex items-center gap-2 text-ink">
        <MicOff strokeWidth={1.5} className="h-4 w-4 shrink-0 text-amber" />
        {aiName} isn&apos;t hearing anything{micName ? ` from "${micName}"` : ""}.
      </p>
      {mics.length > 1 ? (
        <label className="mt-2 block">
          <span className="mb-1 block">Try another microphone:</span>
          <select
            className="w-full rounded-lg border border-line bg-raised px-2 py-1.5 text-ink"
            value={current}
            onChange={(e) => chooseMic(e.target.value || undefined)}
            data-testid="mic-choice"
          >
            <option value="">The browser&apos;s default</option>
            {mics.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="mt-1">
          This is the only microphone the browser can see. Check it is plugged in and not muted, or
          connect one to this computer.
        </p>
      )}
      <p className="mt-2 text-[0.78rem] text-faint">
        Or check it isn&apos;t muted in your computer&apos;s sound settings.
      </p>
    </div>
  );
}
