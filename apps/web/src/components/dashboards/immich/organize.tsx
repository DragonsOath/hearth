import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  FlipHorizontal2,
  FlipVertical2,
  FolderPlus,
  RotateCcw,
  RotateCw,
  Undo2,
  X,
} from "lucide-react";
import { previewPath, type ImmichPhoto } from "@dragon-control/core";
import { api } from "../../../data/api";
import { ApproveDialog, useApproveHere } from "../../jobs/ApproveHere";
import { useImmichFiles, type FilesAnswer } from "./files";
import { Button, cx } from "../../ui";

/**
 * Organizing photos in the Immich panel: choose photos, put them in an album (new or existing),
 * and flip or turn one photo. Each change is a plan you approve; nothing here moves, renames or
 * rewrites a file. Albums are Immich's own; edits are Immich's own non-destructive edits (2.5 and
 * later), so the original file stays as it is and Restore original brings it back.
 */

/** Photos per album step; a plan holds 12 steps (the server checks both). */
export const ALBUM_CHUNK = 500;
export const MAX_PHOTOS = ALBUM_CHUNK * 12;

const base = (serviceId: string) =>
  `/api/services/${encodeURIComponent(serviceId)}/dashboard/immich`;

export interface AlbumsAnswer {
  albums: { id: string; albumName: string; assetCount?: number; updatedAt?: string }[];
  storage: { known: boolean; enabled?: boolean; template?: string; usesAlbum?: boolean };
}

export interface EditState {
  rotate: number;
  mirrorH: boolean;
  mirrorV: boolean;
}

export interface EditsAnswer extends EditState {
  supported: boolean;
  cropped?: boolean;
  edited?: boolean;
}

export const AS_TAKEN: EditState = { rotate: 0, mirrorH: false, mirrorV: false };

/** Splits photo ids into the plan's album steps. */
export function chunkIds(ids: string[], size = ALBUM_CHUNK): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/**
 * The steps that put photos in an album: the first makes it (or adds to the existing one), the
 * rest add to it, ALBUM_CHUNK photos each, so the plan shows progress and a retry is safe.
 */
export function albumSteps(
  ids: string[],
  target: { albumId: string } | { name: string },
): { kind: "app-immich-control"; params: Record<string, string | boolean> }[] {
  return chunkIds(ids).map(
    (part, i): { kind: "app-immich-control"; params: Record<string, string | boolean> } => ({
      kind: "app-immich-control" as const,
      params:
        "albumId" in target
          ? { op: "album-add", albumId: target.albumId, body: part.join(",") }
          : i === 0
            ? { op: "album-create", name: target.name, body: part.join(",") }
            : { op: "album-add", name: target.name, made: true, body: part.join(",") },
    }),
  );
}

/**
 * A flip pressed on screen, in Immich's terms. Immich mirrors first and turns after, so once the
 * photo is turned a quarter, flipping what you see left to right is a top to bottom mirror.
 */
export function flip(s: EditState, onScreen: "h" | "v"): EditState {
  const sideways = s.rotate % 180 === 90;
  const h = (onScreen === "h") !== sideways;
  return h ? { ...s, mirrorH: !s.mirrorH } : { ...s, mirrorV: !s.mirrorV };
}

export const turn = (s: EditState, by: 90 | -90): EditState => ({
  ...s,
  rotate: (((s.rotate + by) % 360) + 360) % 360,
});

/** The CSS that previews Immich's edits on the unedited picture (mirror, then turn). */
export const previewTransform = (s: EditState) =>
  `rotate(${s.rotate}deg) scale(${s.mirrorH ? -1 : 1}, ${s.mirrorV ? -1 : 1})`;

export const sameEdit = (a: EditState, b: EditState) =>
  a.rotate === b.rotate && a.mirrorH === b.mirrorH && a.mirrorV === b.mirrorV;

/* ---------- Choosing photos ---------- */

export interface Selection {
  on: boolean;
  ids: Set<string>;
  /** What Select all covered, said in words. */
  scope?: "loaded" | "library";
  /** The whole library has more photos than Hearth reads at once. */
  partial?: boolean;
  loadingAll: boolean;
  start: () => void;
  done: () => void;
  clear: () => void;
  toggle: (index: number, shift: boolean) => void;
  selectLoaded: () => void;
  selectLibrary: () => Promise<void>;
}

/**
 * Which photos are chosen: kept by id, so it survives scrolling and loading more. Shift-click
 * chooses a run of photos from the last one clicked.
 */
export function useSelection(
  serviceId: string,
  photos: ImmichPhoto[],
  /** An album tab: Select all reads that album's photos. */
  albumId?: string,
): Selection {
  const [on, setOn] = useState(false);
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number>();
  const [scope, setScope] = useState<"loaded" | "library">();
  const [partial, setPartial] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const clear = () => {
    setIds(new Set());
    setScope(undefined);
    setAnchor(undefined);
  };
  return {
    on,
    ids,
    ...(scope ? { scope } : {}),
    partial,
    loadingAll,
    start: () => setOn(true),
    done: () => {
      setOn(false);
      clear();
    },
    clear,
    toggle: (index, shift) => {
      const photo = photos[index];
      if (!photo) return;
      const next = new Set(ids);
      if (shift && anchor !== undefined) {
        const [a, b] = anchor < index ? [anchor, index] : [index, anchor];
        for (const p of photos.slice(a, b + 1)) next.add(p.id);
      } else if (next.has(photo.id)) next.delete(photo.id);
      else next.add(photo.id);
      setIds(next);
      setAnchor(index);
      setScope(undefined);
    },
    selectLoaded: () => {
      setIds(new Set(photos.map((p) => p.id)));
      setScope("loaded");
    },
    selectLibrary: async () => {
      setLoadingAll(true);
      try {
        const r = await api<{ ids: string[]; complete: boolean }>(
          "GET",
          `${base(serviceId)}/photo-ids${albumId ? `?album=${encodeURIComponent(albumId)}` : ""}`,
        );
        setIds(new Set(r.ids));
        setScope("library");
        setPartial(!r.complete);
      } finally {
        setLoadingAll(false);
      }
    },
  };
}

/** The bar shown while choosing photos: how many, select all, and what to do with them. */
export function SelectionBar({
  sel,
  loaded,
  more,
  onOrganize,
  album,
  onRemove,
}: {
  sel: Selection;
  loaded: number;
  more: boolean;
  onOrganize: () => void;
  /** In an album tab: its name, and taking the chosen photos out of it. */
  album?: string;
  onRemove?: () => void;
}) {
  const n = sel.ids.size;
  const where = album ? "in this album" : "in the library";
  const what =
    sel.scope === "library"
      ? `All ${n.toLocaleString()} photos ${where}${sel.partial ? " (the first ones Hearth can read)" : ""}`
      : sel.scope === "loaded"
        ? `All ${n.toLocaleString()} photos shown so far`
        : `${n.toLocaleString()} chosen`;
  const chip =
    "inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-line px-3 text-[0.82rem] text-muted hover:text-ink disabled:opacity-50";
  return (
    <div
      className="sticky bottom-2 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-gold/50 bg-panel/95 p-2 shadow-xl backdrop-blur"
      data-testid="im-select-bar"
      role="toolbar"
      aria-label="Chosen photos"
    >
      <p
        className="min-w-[8rem] flex-1 px-1 text-[0.86rem] whitespace-nowrap text-ink"
        data-testid="im-select-count"
      >
        {what}
      </p>
      <button
        type="button"
        className={chip}
        onClick={sel.selectLoaded}
        disabled={!loaded}
        data-testid="im-select-loaded"
      >
        Select the {loaded.toLocaleString()} shown
      </button>
      {(more || sel.scope !== "library") && (
        <button
          type="button"
          className={chip}
          onClick={() => void sel.selectLibrary()}
          disabled={sel.loadingAll}
          data-testid="im-select-library"
        >
          {sel.loadingAll
            ? "Reading the photos…"
            : album
              ? "Select the whole album"
              : "Select whole library"}
        </button>
      )}
      <button
        type="button"
        className={chip}
        onClick={sel.clear}
        disabled={!n}
        data-testid="im-select-clear"
      >
        Clear
      </button>
      <Button tone="primary" disabled={!n} onClick={onOrganize} data-testid="im-organize">
        <FolderPlus strokeWidth={1.5} className="mr-1 inline h-4 w-4" />
        Put in an album
      </Button>
      {onRemove && (
        <button
          type="button"
          className={chip}
          disabled={!n}
          onClick={onRemove}
          data-testid="im-select-remove"
        >
          Take out of this album
        </button>
      )}
      <button type="button" className={chip} onClick={sel.done} data-testid="im-select-done">
        Done
      </button>
    </div>
  );
}

/* ---------- Albums ---------- */

/**
 * How the chosen photos' files will be named: Immich's storage template decides (Files and
 * folders sets it). Renaming files behind Immich's back is never offered: it would break its
 * library.
 */
function FileNames({
  files,
  name,
  album,
  chosen,
  onFiles,
}: {
  files: FilesAnswer | undefined;
  name: string;
  album: string;
  chosen: ImmichPhoto[];
  onFiles?: () => void;
}) {
  const st = files?.storage;
  const owner = files?.samples[0]?.owner ?? "";
  const link = onFiles && (
    <button
      type="button"
      onClick={onFiles}
      className="text-gold underline-offset-2 hover:underline"
      data-testid="im-organize-files"
    >
      Files and folders
    </button>
  );
  return (
    <div
      className="mt-4 rounded-lg bg-raised p-2.5 text-[0.78rem] text-muted"
      data-testid="im-organize-names"
    >
      <p className="text-[0.8rem] text-ink">File names</p>
      {!st?.known ? (
        <p>
          Hearth cannot read how {name} names files with this key. {name} decides that with its
          storage template{link ? <>; see {link}</> : ""}.
        </p>
      ) : st.enabled && st.template ? (
        <>
          <p>
            {name} names and files photos by its storage template. If this is their first album,
            they will be:
          </p>
          <ul className="mt-1 space-y-0.5 font-mono text-[0.72rem] break-all text-gold">
            {chosen.map((p) => (
              <li key={p.id}>
                {previewPath(
                  st.template!,
                  {
                    name: p.name,
                    takenAt: p.takenAt ?? new Date(0).toISOString(),
                    owner,
                    ...(album ? { album } : {}),
                  },
                  files?.zone.zones[0] ?? "UTC",
                )}
              </li>
            ))}
          </ul>
          <p className="mt-1">
            {name} moves them when its storage template job runs.{" "}
            {link ? <>Change it in {link}.</> : null}
          </p>
        </>
      ) : (
        <p>
          {name} keeps its own file names now. To name and file photos by album or date, turn on its
          storage template in {link ?? "Files and folders"}. Hearth never renames files behind{" "}
          {name}&apos;s back.
        </p>
      )}
    </div>
  );
}

/** Put the chosen photos in a new album or an existing one: preview, approve once, progress. */
export function OrganizeDialog({
  serviceId,
  name,
  ids,
  photos,
  onClose,
  onDone,
  onFiles,
  onOpenAlbum,
}: {
  serviceId: string;
  name: string;
  ids: string[];
  photos: ImmichPhoto[];
  onClose: () => void;
  onDone: () => void;
  /** Opens Files and folders (how Immich names and files photos). */
  onFiles?: () => void;
  /** Opens the album's own tab. */
  onOpenAlbum?: (albumId: string) => void;
}) {
  const files = useImmichFiles(serviceId);
  const qc = useQueryClient();
  const albums = useQuery({
    queryKey: ["immich-albums", serviceId],
    queryFn: () => api<AlbumsAnswer>("GET", `${base(serviceId)}/albums`),
  });
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [albumName, setAlbumName] = useState("");
  const [albumId, setAlbumId] = useState("");
  const c = useApproveHere(serviceId, "From Immich's panel in Hearth: organizing photos.");
  const undo = useApproveHere(serviceId, "From Immich's panel in Hearth: undoing an album change.");
  const list = albums.data?.albums ?? [];
  const trimmed = albumName.trim().replace(/\s+/g, " ");
  const clash = list.find((a) => a.albumName.toLowerCase() === trimmed.toLowerCase());
  const existing = list.find((a) => a.id === albumId);
  const tooMany = ids.length > MAX_PHOTOS;
  const ready =
    !tooMany &&
    (mode === "new" ? trimmed.length > 0 && trimmed.length <= 120 && !clash : !!existing);
  const byId = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);
  const preview = ids.slice(0, 8);

  // Kept once it succeeds: closing the approval pop-up forgets its plan.
  const [job, setJob] = useState<typeof c.job>();
  if (c.job?.status === "succeeded" && job?.id !== c.job.id) {
    setJob(c.job);
    void qc.invalidateQueries({ queryKey: ["immich-albums", serviceId] });
  }
  const finished = job?.status === "succeeded";
  const [undone, setUndone] = useState(false);
  if (undo.job?.status === "succeeded" && !undone) setUndone(true);
  // What the plan added, read from its approved steps (photos already in the album were left out).
  const added = (job?.steps ?? []).flatMap((s) =>
    s.status === "succeeded"
      ? String(s.params?.body ?? "")
          .split(",")
          .filter(Boolean)
      : [],
  );
  const target = mode === "new" ? trimmed : (existing?.albumName ?? "");

  const submit = () => {
    if (!ready || c.busy) return;
    void c.proposeMany(
      albumSteps(ids, mode === "new" ? { name: trimmed } : { albumId: existing!.id }),
      mode === "new" ? `Make the album "${trimmed}"` : `Add photos to "${target}"`,
    );
  };
  const undoIt = async () => {
    const fresh = await qc.fetchQuery({
      queryKey: ["immich-albums", serviceId],
      queryFn: () => api<AlbumsAnswer>("GET", `${base(serviceId)}/albums`),
      staleTime: 0,
    });
    const album = fresh.albums.find((a) => a.albumName.toLowerCase() === target.toLowerCase());
    if (!album) return;
    void undo.proposeMany(
      chunkIds(added).map((part) => ({
        kind: "app-immich-control" as const,
        params: { op: "album-remove", albumId: album.id, body: part.join(",") },
      })),
      `Take the photos out of "${album.albumName}" again`,
    );
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[75] flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && !c.open && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="im-organize-title"
        className="max-h-[92vh] w-full max-w-lg overflow-auto rounded-t-2xl border border-line-strong bg-panel p-4 shadow-2xl sm:rounded-2xl"
        data-testid="im-organize-dialog"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="im-organize-title" className="text-[1.05rem] text-ink">
            Put {ids.length.toLocaleString()} photo{ids.length === 1 ? "" : "s"} in an album
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-md p-1 text-muted hover:text-ink"
          >
            <X strokeWidth={1.5} className="h-4 w-4" />
          </button>
        </div>

        <ul className="mt-3 grid grid-cols-8 gap-1" aria-label="The chosen photos">
          {preview.map((id) => (
            <li key={id} className="aspect-square overflow-hidden rounded border border-line">
              <img
                src={`${base(serviceId)}-thumb?asset=${encodeURIComponent(id)}`}
                alt={byId.get(id)?.name ?? ""}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            </li>
          ))}
        </ul>
        {ids.length > preview.length && (
          <p className="mt-1 text-[0.76rem] text-faint">
            and {(ids.length - preview.length).toLocaleString()} more
          </p>
        )}

        {finished ? (
          <div className="mt-4 space-y-3" data-testid="im-organize-done">
            {undone ? (
              <p className="text-[0.9rem] text-ink" data-testid="im-organize-undone">
                Undone: the photos are out of &quot;{target}&quot; again.
              </p>
            ) : (
              <p className="flex items-center gap-2 text-[0.9rem] text-live">
                <Check strokeWidth={2} className="h-4 w-4" />
                {added.length.toLocaleString()} photo{added.length === 1 ? "" : "s"} in &quot;
                {target}&quot;, checked in {name}.
              </p>
            )}
            <p className="text-[0.8rem] text-muted">
              {files.data?.storage.enabled && /\{\{\s*album/.test(files.data.storage.template ?? "")
                ? `${name} files them by album the next time its storage template job runs (Files and folders starts it). Hearth did not move or rename anything.`
                : "The photos themselves were not moved, renamed or changed."}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              {added.length > 0 && !undone && (
                <Button tone="quiet" onClick={() => void undoIt()} data-testid="im-organize-undo">
                  <Undo2 strokeWidth={1.5} className="mr-1 inline h-4 w-4" /> Undo
                </Button>
              )}
              {onOpenAlbum && !undone && (
                <Button
                  tone="quiet"
                  onClick={() => {
                    const a = (albums.data?.albums ?? []).find(
                      (x) => x.albumName.toLowerCase() === target.toLowerCase(),
                    );
                    if (a) onOpenAlbum(a.id);
                  }}
                  data-testid="im-organize-open"
                  // Only opens the album's tab: Ember's cursor may press it.
                  data-hearth-target="album:open"
                >
                  Open the album
                </Button>
              )}
              <Button tone="primary" onClick={onDone} data-testid="im-organize-finish">
                Done
              </Button>
            </div>
          </div>
        ) : (
          <>
            <fieldset className="mt-4 space-y-2">
              <legend className="text-[0.78rem] text-muted">Album</legend>
              <div className="flex gap-2" role="radiogroup">
                {(["new", "existing"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    onClick={() => setMode(m)}
                    disabled={m === "existing" && !list.length}
                    className={cx(
                      "min-h-10 flex-1 rounded-lg border px-3 text-[0.84rem] disabled:opacity-50",
                      mode === m ? "border-gold bg-gold/10 text-gold" : "border-line text-muted",
                    )}
                    data-testid={`im-organize-${m}`}
                  >
                    {m === "new" ? "New album" : "Add to an album"}
                  </button>
                ))}
              </div>
              {mode === "new" ? (
                <label className="block text-[0.8rem] text-muted">
                  Name
                  <input
                    value={albumName}
                    onChange={(e) => setAlbumName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && submit()}
                    maxLength={120}
                    placeholder="Album name"
                    className="mt-1 block min-h-10 w-full rounded-lg border border-line bg-raised px-3 text-[0.9rem] text-ink"
                    data-testid="im-organize-name"
                  />
                  {clash && (
                    <span className="mt-1 block text-amber" data-testid="im-organize-clash">
                      {name} already has an album called &quot;{clash.albumName}&quot;. Choose Add
                      to an album to put them in it.
                    </span>
                  )}
                </label>
              ) : (
                <label className="block text-[0.8rem] text-muted">
                  Album
                  <select
                    value={albumId}
                    onChange={(e) => setAlbumId(e.target.value)}
                    className="mt-1 block min-h-10 w-full rounded-lg border border-line bg-raised px-2 text-[0.9rem] text-ink"
                    data-testid="im-organize-album"
                  >
                    <option value="">Choose an album</option>
                    {list.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.albumName} ({a.assetCount ?? 0})
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block text-faint">
                    Photos already in it are left as they are.
                  </span>
                </label>
              )}
            </fieldset>

            <FileNames
              files={files.data}
              name={name}
              album={mode === "new" ? trimmed : (existing?.albumName ?? "")}
              chosen={ids
                .slice(0, 3)
                .map((id) => photos.find((p) => p.id === id))
                .filter((p): p is ImmichPhoto => Boolean(p))}
              {...(onFiles ? { onFiles } : {})}
            />

            {tooMany && (
              <p className="mt-3 text-[0.82rem] text-amber">
                Up to {MAX_PHOTOS.toLocaleString()} photos go in one plan. Choose fewer, then add
                the rest after.
              </p>
            )}
            {c.error && <p className="mt-3 text-[0.82rem] text-amber">{c.error}</p>}
            <p className="mt-3 text-[0.76rem] text-faint">
              {chunkIds(ids).length > 1
                ? `This is one plan in ${chunkIds(ids).length} steps of up to ${ALBUM_CHUNK} photos, so you can watch it go.`
                : "You approve it once, then Hearth checks the album."}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button tone="quiet" onClick={onClose}>
                Cancel
              </Button>
              <Button
                tone="primary"
                disabled={!ready || c.busy || c.open}
                onClick={submit}
                data-testid="im-organize-review"
              >
                Review and approve
              </Button>
            </div>
          </>
        )}
        <ApproveDialog c={c} />
        <ApproveDialog c={undo} />
      </div>
    </div>,
    document.body,
  );
}

/* ---------- Flip and rotate ---------- */

/** The editing tools in the full view: a live preview first, then one approved edit. */
export function EditTools({
  state,
  start,
  edited,
  busy,
  onChange,
  onSave,
  onRestore,
  onCancel,
}: {
  state: EditState;
  start: EditState;
  edited: boolean;
  busy: boolean;
  onChange: (s: EditState) => void;
  onSave: () => void;
  onRestore: () => void;
  onCancel: () => void;
}) {
  const tool =
    "inline-flex min-h-11 min-w-11 flex-col items-center justify-center gap-0.5 rounded-lg border border-white/25 px-2.5 text-[0.72rem] text-white hover:border-gold hover:text-gold disabled:opacity-50";
  const changed = !sameEdit(state, start);
  return (
    <div className="space-y-2" data-testid="im-edit-tools" role="toolbar" aria-label="Edit photo">
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          className={tool}
          onClick={() => onChange(turn(state, -90))}
          data-testid="im-edit-rotate-left"
        >
          <RotateCcw strokeWidth={1.5} className="h-5 w-5" /> Turn left
        </button>
        <button
          type="button"
          className={tool}
          onClick={() => onChange(turn(state, 90))}
          data-testid="im-edit-rotate-right"
        >
          <RotateCw strokeWidth={1.5} className="h-5 w-5" /> Turn right
        </button>
        <button
          type="button"
          className={tool}
          onClick={() => onChange(flip(state, "h"))}
          data-testid="im-edit-flip-h"
        >
          <FlipVertical2 strokeWidth={1.5} className="h-5 w-5" /> Flip left to right
        </button>
        <button
          type="button"
          className={tool}
          onClick={() => onChange(flip(state, "v"))}
          data-testid="im-edit-flip-v"
        >
          <FlipHorizontal2 strokeWidth={1.5} className="h-5 w-5" /> Flip top to bottom
        </button>
        <button
          type="button"
          className={tool}
          disabled={sameEdit(state, AS_TAKEN)}
          onClick={() => onChange(AS_TAKEN)}
          data-testid="im-edit-reset"
        >
          <Undo2 strokeWidth={1.5} className="h-5 w-5" /> As taken
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <p className="w-full text-center text-[0.74rem] text-white/60 sm:w-auto">
          Saved as an edit in Immich. The original file is never changed.
        </p>
        <button
          type="button"
          className={`${tool} flex-row`}
          onClick={onCancel}
          data-testid="im-edit-cancel"
        >
          Cancel
        </button>
        {edited && (
          <button
            type="button"
            className={`${tool} flex-row`}
            disabled={busy}
            onClick={onRestore}
            data-testid="im-edit-restore"
          >
            Restore original
          </button>
        )}
        <button
          type="button"
          className={`${tool} flex-row border-gold text-gold`}
          disabled={!changed || busy}
          onClick={onSave}
          data-testid="im-edit-save"
        >
          Save
        </button>
      </div>
    </div>
  );
}
