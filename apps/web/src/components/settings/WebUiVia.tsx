import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, useUpdateSettings, useWorkspace } from "../../data/api";
import { Button, cx } from "../ui";

/**
 * Settings > General: where "Open web UI" and a system's logo take you. Through your
 * reverse proxy (radarr.example.com) when a system has an address there, or straight to the host.
 */
export function WebUiVia() {
  const ws = useWorkspace();
  const save = useUpdateSettings();
  const qc = useQueryClient();
  const via = ws.data?.webUiVia ?? "proxy";
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const detect = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api<{ file: string | null; found: number; added: string[] }>(
        "POST",
        "/api/services/web-addresses/detect",
        {},
      );
      setNote(
        !r.file
          ? "No reverse proxy found (Hearth reads Caddy's configuration)."
          : r.added.length
            ? `Added ${r.added.length}: ${r.added.join(", ")}.`
            : `Your reverse proxy has ${r.found} matching address${r.found === 1 ? "" : "es"}; nothing new to add.`,
      );
      await qc.invalidateQueries({ queryKey: ["workspace"] });
    } catch (e) {
      setNote(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <div
        role="radiogroup"
        aria-label="Open web UIs"
        className="flex rounded-lg border border-line-strong p-0.5"
      >
        {(
          [
            ["proxy", "Reverse proxy"],
            ["host", "Host address"],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={via === v}
            onClick={() => save.mutate({ webUiVia: v })}
            className={cx(
              "min-h-10 rounded-md px-4 text-[0.84rem]",
              via === v ? "bg-gold/15 text-ink" : "text-muted hover:text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <Button tone="quiet" disabled={busy} onClick={() => void detect()}>
        {busy ? "Looking…" : "Find addresses in my reverse proxy"}
      </Button>
      {note && <p className="max-w-md text-[0.78rem] text-faint sm:text-right">{note}</p>}
    </div>
  );
}
