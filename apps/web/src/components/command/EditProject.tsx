import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ProjectColor } from "@dragon-control/core";
import { api } from "../../data/api";
import { ember } from "../ember/engine";
import { Field, Modal } from "../workspace/dialogs";
import { Button } from "../ui";
import { ProjectColorPicker } from "./ProjectColorPicker";

/**
 * Editing a project from anywhere it shows (the owner, 2026-11-02: Home's cards had no way to edit
 * one, and a Lair project's War Room tab had no right-click menu): its name, description and color
 * on Home. One dialog for both kinds: a Lair project saves to Hearth's projects, a War Room project
 * to its PC's War Room, as the War Room's own Edit project does.
 */

export type EditTarget =
  | { kind: "lair"; id: string; name: string; description: string; color?: ProjectColor }
  | {
      kind: "war-room";
      slug: string;
      /** The PC it lives on; absent for this one. */
      pc?: string | null;
      name: string;
      description: string;
      color?: ProjectColor;
    };

export function EditProjectDialog({
  target,
  onClose,
  onSaved,
}: {
  target: EditTarget;
  onClose: () => void;
  /** After a save, with the new name (the War Room updates its tab). */
  onSaved?: (name: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(target.name);
  const [desc, setDesc] = useState(target.description);
  const [color, setColor] = useState<ProjectColor | undefined>(target.color);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (target.kind === "lair") {
        await api("PATCH", `/api/projects/${encodeURIComponent(target.id)}`, {
          name: name.trim(),
          summary: desc,
          color: color ?? null,
        });
        await qc.invalidateQueries({ queryKey: ["projects"] });
      } else {
        await ember(`projects/${encodeURIComponent(target.slug)}`, {
          method: "PATCH",
          body: { name: name.trim(), description: desc, color: color ?? null },
          ...(target.pc ? { on: target.pc } : {}),
        });
        await qc.invalidateQueries({ queryKey: ["war-room-projects"] });
      }
      onSaved?.(name.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "It could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Edit project" onCancel={onClose}>
      <div data-testid="edit-project-dialog">
        <Field
          label="Project Name"
          value={name}
          onChange={setName}
          max={80}
          placeholder="Project name"
        />
        <Field
          label="Project Description"
          value={desc}
          onChange={setDesc}
          max={target.kind === "lair" ? 1000 : 8000}
          multiline
          placeholder="Project description"
        />
        <p className="mt-4 mb-1 text-[0.8rem] text-muted">Color on Home</p>
        <ProjectColorPicker value={color} onChange={setColor} />
        {error && (
          <p className="mt-3 text-[0.8rem] text-bad" role="alert">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" disabled={busy || !name.trim()} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
