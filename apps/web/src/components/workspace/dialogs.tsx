import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button, cx } from "../ui";

/** Closes the dialog a button sits in (Escape, the Close button and the backdrop close it too). */
const close = (e: MouseEvent<HTMLButtonElement>) => e.currentTarget.closest("dialog")?.close();

/**
 * Dialogs shared by a workspace panel and Saved work: saving (as a working file or a note),
 * editing a working file's details, and the deliberate delete of a working file.
 */

export function Modal({
  title,
  onCancel,
  children,
  role = "dialog",
  describedBy,
  wide,
}: {
  title: string;
  /** Room for a grid of choices (the conversation pictures). */
  wide?: boolean;
  onCancel: () => void;
  children: ReactNode;
  role?: "dialog" | "alertdialog";
  describedBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      role={role}
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      onClose={onCancel}
      // A tap outside the window closes it (11-05: on a tablet there is no Escape key).
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        const outside =
          e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
        if (outside) e.currentTarget.close();
      }}
      className={cx(
        "relative m-auto rounded-2xl border border-gold/40 bg-panel p-6 text-ink backdrop:bg-black/70",
        wide ? "w-[min(40rem,calc(100vw-2rem))]" : "w-[min(28rem,calc(100vw-2rem))]",
      )}
    >
      <h2 id={titleId} className="pr-10 font-display text-[1.35rem] leading-tight">
        {title}
      </h2>
      <button
        type="button"
        onClick={close}
        aria-label="Close"
        data-testid="modal-close"
        className="absolute top-3 right-3 flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-line hover:text-ink"
      >
        <X aria-hidden strokeWidth={1.6} className="h-5 w-5" />
      </button>
      {children}
    </dialog>
  );
}

const inputClass =
  "mt-1 min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold focus:outline-none";

export function Field({
  label,
  value,
  onChange,
  max,
  list,
  multiline,
  hint,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  list?: string[];
  multiline?: boolean;
  hint?: string;
  /** Greyed-out text while the box is empty. */
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="mt-4">
      <label className="block text-[0.8rem] text-muted" htmlFor={id}>
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          value={value}
          maxLength={max}
          rows={3}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={cx(inputClass, "py-2")}
        />
      ) : (
        <input
          id={id}
          value={value}
          maxLength={max}
          list={list?.length ? `${id}-list` : undefined}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        />
      )}
      {list && list.length > 0 && (
        <datalist id={`${id}-list`}>
          {list.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      )}
      {hint && <p className="mt-1 text-[0.74rem] text-faint">{hint}</p>}
    </div>
  );
}

export type SaveTarget = "file" | "note";

/**
 * Save: as a working file (the whole interactive workspace moves into Saved work, never cleared)
 * or as a note (what it found, copied into Memory as reference; the workspace is unchanged).
 */
export function SaveDialog({
  title,
  canFile,
  folders,
  busy,
  error,
  onCancel,
  onSave,
}: {
  title: string;
  /** False when it already is a working file: only a note can be made. */
  canFile: boolean;
  folders: string[];
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onSave: (target: SaveTarget, input: { title: string; folder?: string }) => void | Promise<void>;
}) {
  const [target, setTarget] = useState<SaveTarget>(canFile ? "file" : "note");
  const [name, setName] = useState(title);
  const [folder, setFolder] = useState("");
  const options: { id: SaveTarget; label: string; detail: string }[] = [
    ...(canFile
      ? [
          {
            id: "file" as const,
            label: "Working file",
            detail:
              "Keeps the whole workspace interactive: the list, your choices, and its conversation. Reopen and keep working from the Forge Library. Never cleared.",
          },
        ]
      : []),
    {
      id: "note",
      label: "Note",
      detail:
        "Copies what it found (the items and your choices) into Memory as reference for you and Ember. The workspace itself stays as it is.",
    },
  ];
  return (
    <Modal title="Save this workspace" onCancel={onCancel}>
      <>
        <div className="mt-4 space-y-2" role="radiogroup" aria-label="Save as">
          {options.map((o) => (
            <label
              key={o.id}
              className={cx(
                "flex cursor-pointer gap-3 rounded-xl border p-3",
                target === o.id ? "border-gold/60 bg-gold/5" : "border-line",
              )}
            >
              <input
                type="radio"
                name="save-target"
                checked={target === o.id}
                onChange={() => setTarget(o.id)}
                className="mt-1 accent-[var(--color-gold)]"
              />
              <span>
                <span className="block text-[0.9rem] text-ink">{o.label}</span>
                <span className="block text-[0.78rem] text-muted">{o.detail}</span>
              </span>
            </label>
          ))}
        </div>
        <Field label="Name" value={name} onChange={setName} max={120} />
        {target === "file" && (
          <Field
            label="Folder (optional)"
            value={folder}
            onChange={setFolder}
            max={60}
            list={folders}
            hint="Group related working files, for example Media cleanup."
          />
        )}
        {error && (
          <p className="mt-3 text-[0.8rem] text-bad" role="alert">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={close}>Cancel</Button>
          <Button
            tone="primary"
            disabled={busy || !name.trim()}
            onClick={() =>
              onSave(target, {
                title: name.trim(),
                ...(target === "file" && folder.trim() ? { folder: folder.trim() } : {}),
              })
            }
          >
            {target === "file" ? "Save as working file" : "Save as note"}
          </Button>
        </div>
      </>
    </Modal>
  );
}

/** A working file's name, description, and folder. */
export function EditDialog({
  title,
  description,
  folder,
  folders,
  busy,
  error,
  onCancel,
  onSave,
}: {
  title: string;
  description?: string;
  folder?: string;
  folders: string[];
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onSave: (patch: { title: string; description: string; folder: string | null }) => void;
}) {
  const [name, setName] = useState(title);
  const [desc, setDesc] = useState(description ?? "");
  const [dir, setDir] = useState(folder ?? "");
  return (
    <Modal title="Edit working file" onCancel={onCancel}>
      <>
        <Field label="Name" value={name} onChange={setName} max={120} />
        <Field label="Description" value={desc} onChange={setDesc} max={1000} multiline />
        <Field
          label="Folder"
          value={dir}
          onChange={setDir}
          max={60}
          list={folders}
          hint="Leave empty for no folder."
        />
        {error && (
          <p className="mt-3 text-[0.8rem] text-bad" role="alert">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={close}>Cancel</Button>
          <Button
            tone="primary"
            disabled={busy || !name.trim()}
            onClick={() =>
              onSave({ title: name.trim(), description: desc, folder: dir.trim() || null })
            }
          >
            Save changes
          </Button>
        </div>
      </>
    </Modal>
  );
}

/** Deleting a working file is its own deliberate step, with its own confirmation. */
export function DeleteFileDialog({
  title,
  busy,
  onCancel,
  onDelete,
}: {
  title: string;
  busy: boolean;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const bodyId = useId();
  return (
    <Modal title="Delete working file?" onCancel={onCancel} role="alertdialog" describedBy={bodyId}>
      <>
        <div id={bodyId} className="mt-3 space-y-2 text-[0.88rem] text-muted">
          <p>
            "{title}" and its list and choices will be deleted. This cannot be undone. Notes you
            saved from it stay in Memory.
          </p>
          <p className="text-[0.8rem] text-faint">
            Your files and services are not touched, and approved plans keep running.
          </p>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button autoFocus onClick={close}>
            Cancel
          </Button>
          <Button tone="primary" disabled={busy} onClick={onDelete}>
            Delete working file
          </Button>
        </div>
      </>
    </Modal>
  );
}
