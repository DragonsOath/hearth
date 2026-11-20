import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../data/api";

export const CAPTURE_FOLDER_KEY = ["capture-folder"] as const;

/** The folder screen captures are saved to on Hearth's computer, if one is set. */
export function useCaptureFolder() {
  return useQuery({
    queryKey: CAPTURE_FOLDER_KEY,
    queryFn: () => api<{ path: string | null }>("GET", "/api/captures/folder"),
    staleTime: 60_000,
  });
}

/**
 * Settings > General > Screen captures (11-18): a folder on the computer Hearth runs on. Saved when
 * you press Save or Enter; Hearth makes the folder if it isn't there. Empty: Save downloads.
 */
export function CaptureFolderField() {
  const q = useCaptureFolder();
  const client = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const current = q.data?.path ?? "";
  const value = draft ?? current;
  const save = useMutation({
    mutationFn: (path: string) =>
      api<{ path: string | null }>("PUT", "/api/captures/folder", { path }),
    onSuccess: (r) => {
      client.setQueryData(CAPTURE_FOLDER_KEY, r);
      setDraft(null);
    },
  });
  const dirty = draft !== null && draft.trim() !== current;
  return (
    <div className="space-y-1.5">
      <label className="sr-only" htmlFor="capture-folder">
        Folder for screen captures
      </label>
      <div className="flex gap-2">
        <input
          id="capture-folder"
          value={value}
          placeholder="Empty: they download in the browser"
          spellCheck={false}
          maxLength={500}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && dirty) save.mutate(value);
            if (e.key === "Escape") setDraft(null);
          }}
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-panel px-3 font-mono text-[0.84rem] text-ink focus:border-gold/60 focus:outline-none"
          data-testid="capture-folder"
        />
        <button
          type="button"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate(value)}
          className="min-h-11 shrink-0 rounded-lg border border-line-strong px-4 text-[0.84rem] text-ink hover:border-gold hover:text-gold disabled:opacity-40"
          data-testid="capture-folder-save"
        >
          {save.isPending ? "Checking..." : "Save"}
        </button>
      </div>
      {save.isError ? (
        <p role="alert" className="text-[0.8rem] text-bad">
          {(save.error as Error).message}
        </p>
      ) : save.isSuccess && !dirty ? (
        <p role="status" className="text-[0.8rem] text-gold" data-testid="capture-folder-note">
          {save.data.path
            ? "Captures will be saved there."
            : "Captures will download in the browser."}
        </p>
      ) : null}
    </div>
  );
}
