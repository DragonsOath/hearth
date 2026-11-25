import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Panel } from "../ui";
import { api } from "../../data/api";
import type { PcInfo } from "../../data/pcs";

/** This PC's own address for its Hearth; another PC's through your Hearth. */
const base = (pc: { id: string; hub?: boolean }) =>
  pc.hub ? "/api" : `/api/on/${encodeURIComponent(pc.id)}`;

interface FolderView {
  folder: string;
  projects: { name: string; path: string }[];
}

/**
 * The Projects folder, per PC (the owner, 11-24): where War Room projects made on that PC are
 * saved, with their files, notes and docs. Changing it sends new projects there; ticking the box
 * moves the existing ones too, each one listed first.
 */
export function ProjectsFolder({
  pc,
  onDone,
}: {
  pc: PcInfo & { hub?: boolean };
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const key = ["projects-folder", pc.id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<FolderView>("GET", `${base(pc)}/engine/projects-folder`),
  });
  const [folder, setFolder] = useState<string>();
  const [move, setMove] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api<{ folder: string; moved: string[] }>("PUT", `${base(pc)}/engine/projects-folder`, {
        folder: (folder ?? "").trim(),
        move,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });
  const now = q.data?.folder ?? "";
  const typed = folder ?? now;
  const inside = (q.data?.projects ?? []).filter((p) => p.path.startsWith(now));
  const changed = typed.trim() !== "" && typed.trim() !== now;
  return (
    <Panel className="mb-5 p-5">
      <div className="max-w-2xl space-y-3" data-testid="projects-folder">
        <p className="text-[0.95rem] text-ink">{pc.name}: Projects folder</p>
        <p className="text-[0.84rem] leading-relaxed text-muted">
          Where War Room projects made on {pc.hub ? "this PC" : pc.name} are saved: each project
          gets its own folder here, with its files, notes and docs. Pick a folder on a drive with
          room, and somewhere you back up.
        </p>
        {q.isLoading ? (
          <p className="text-[0.84rem] text-muted">Reading it…</p>
        ) : q.error ? (
          <p className="text-[0.84rem] text-warn">
            {pc.online === false
              ? `${pc.name} is offline. Its Projects folder can be changed once it is back.`
              : q.error.message}
          </p>
        ) : (
          <>
            <label className="block text-[0.84rem] text-ink">
              Folder
              <input
                value={typed}
                onChange={(e) => setFolder(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                className="mt-1 min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 font-mono text-[0.86rem] text-ink focus:border-gold/60 focus:outline-none"
                data-testid="projects-folder-path"
              />
            </label>
            <p className="text-[0.76rem] text-faint">
              The whole path, like <code>D:\Hearth Projects</code> on Windows or{" "}
              <code>/mnt/data/hearth-projects</code> on Linux. Hearth makes the folder if it
              isn&apos;t there yet.
            </p>
            {changed && inside.length > 0 && (
              <label className="flex items-start gap-2 text-[0.84rem] text-ink">
                <input
                  type="checkbox"
                  checked={move}
                  onChange={(e) => setMove(e.target.checked)}
                  className="mt-1 accent-[var(--color-gold)]"
                  data-testid="projects-folder-move"
                />
                <span>
                  Also move the {inside.length} project{inside.length === 1 ? "" : "s"} already
                  there: {inside.map((p) => p.name).join(", ")}. Otherwise they stay where they are
                  and keep working; only new projects go to the new folder.
                </span>
              </label>
            )}
            {save.data && (
              <p
                className="text-[0.84rem] text-ok"
                role="status"
                data-testid="projects-folder-done"
              >
                Saved. New projects go to {save.data.folder}.
                {save.data.moved.length ? ` Moved: ${save.data.moved.join(", ")}.` : ""}
              </p>
            )}
            {save.error && <p className="text-[0.84rem] text-warn">{save.error.message}</p>}
          </>
        )}
        <div className="flex gap-2">
          <Button
            tone="primary"
            disabled={!changed || save.isPending}
            onClick={() => save.mutate()}
            data-testid="projects-folder-save"
          >
            {save.isPending ? (move ? "Moving…" : "Saving…") : "Save"}
          </Button>
          <Button tone="quiet" onClick={onDone}>
            Close
          </Button>
        </div>
      </div>
    </Panel>
  );
}
