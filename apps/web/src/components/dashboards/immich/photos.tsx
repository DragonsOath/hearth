import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  Heart,
  Check,
  Crop,
  Link2,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Share2,
  Undo2,
  X,
} from "lucide-react";
import {
  IMMICH_PHOTO_PREFS_DEFAULT,
  type ImmichPhoto,
  type ImmichPhotoPage,
  type ImmichPhotoPrefs,
} from "@dragon-control/core";
import { api, useWorkspace } from "../../../data/api";
import { keyPageHref } from "../../../lib/keyPage";
import { ApproveDialog, useApproveHere } from "../../jobs/ApproveHere";
import { Button, Skeleton, cx } from "../../ui";
import type { AppViewProps } from "../../panels/registry";
import {
  AS_TAKEN,
  chunkIds,
  type AlbumsAnswer,
  EditTools,
  OrganizeDialog,
  previewTransform,
  sameEdit,
  SelectionBar,
  useSelection,
  type EditsAnswer,
  type EditState,
  type Selection,
} from "./organize";

/**
 * Immich photos in Hearth: Recent photos on the Overview, every photo in the Photos tab, and a full
 * view with sharing. Pictures come through Hearth, so Immich's key never reaches the browser.
 *
 * Blurring and hiding are Hearth's own display choices (kept in Hearth, Immich is not changed): a
 * blurred photo stays blurred until clicked, a hidden one is also left off the Overview, and the
 * Overview's Recent photos can be blurred or switched off altogether.
 *
 * Sharing: "Share photo" hands the picture itself to the device's own share menu (Messages, email
 * and so on) and changes nothing. "Share a link" makes a link anyone can open, which changes Immich,
 * so it is a plan you approve first; then Text, Email or Copy link.
 */

export const thumbUrl = (
  serviceId: string,
  id: string,
  size: "thumbnail" | "preview" = "thumbnail",
  /** The photo's version (it changes when edited, so the browser fetches it afresh). */
  version?: string,
  /** False: as taken, without Immich's edits (where editing starts from). */
  edited = true,
) =>
  `/api/services/${encodeURIComponent(serviceId)}/dashboard/immich-thumb?asset=${encodeURIComponent(id)}${size === "preview" ? "&size=preview" : ""}${version ? `&v=${encodeURIComponent(version)}` : ""}${edited ? "" : "&edited=0"}`;

const prefsUrl = (serviceId: string) =>
  `/api/services/${encodeURIComponent(serviceId)}/dashboard/immich/prefs`;

export const taken = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "";

/** How this panel shows photos, and a way to change it. */
export function usePhotoPrefs(serviceId: string) {
  const qc = useQueryClient();
  const key = ["immich-photo-prefs", serviceId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<ImmichPhotoPrefs>("GET", prefsUrl(serviceId)),
  });
  const set = useMutation({
    mutationFn: (change: {
      recent?: ImmichPhotoPrefs["recent"];
      photo?: { id: string; show: "blur" | "hide" | "normal" };
    }) => api<ImmichPhotoPrefs>("PUT", prefsUrl(serviceId), change),
    onSuccess: (next) => qc.setQueryData(key, next),
  });
  return { prefs: q.data ?? IMMICH_PHOTO_PREFS_DEFAULT, set: set.mutate, saving: set.isPending };
}

type Show = "normal" | "blur" | "hide";
const showOf = (prefs: ImmichPhotoPrefs, id: string): Show => prefs.photos[id] ?? "normal";

/** Show normally, blur, or hide one photo. */
function PhotoMenu({
  show,
  onChange,
  onClose,
}: {
  show: Show;
  onChange: (s: Show) => void;
  onClose: () => void;
}) {
  const options: { value: Show; label: string; hint: string }[] = [
    { value: "normal", label: "Show normally", hint: "" },
    { value: "blur", label: "Blur", hint: "Blurred until you click it" },
    { value: "hide", label: "Hide", hint: "Blurred, and left off the Overview" },
  ];
  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="menu"
        aria-label="How this photo shows in Hearth"
        className="w-64 rounded-xl border border-line-strong bg-panel p-1.5 text-left shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <p className="px-2.5 pt-1.5 pb-1 text-[0.86rem] text-ink">How this photo shows</p>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="menuitemradio"
            aria-checked={show === o.value}
            autoFocus={show === o.value}
            onClick={(e) => {
              e.stopPropagation();
              onChange(o.value);
              onClose();
            }}
            className={cx(
              "block min-h-9 w-full rounded-md px-2.5 py-1.5 text-left text-[0.82rem] hover:bg-raised",
              show === o.value ? "text-gold" : "text-ink",
            )}
            data-testid={`im-photo-${o.value}`}
          >
            {o.label}
            {o.hint && <span className="block text-[0.72rem] text-faint">{o.hint}</span>}
          </button>
        ))}
        <p className="px-2.5 pt-1 pb-1.5 text-[0.7rem] text-faint">
          Only in Hearth: Immich is not changed.
        </p>
      </div>
    </div>
  );
}

/** One photo: blurred when asked, with its own menu; a click opens the full view. */
function PhotoTile({
  serviceId,
  photo,
  show,
  blurAll,
  choosing,
  chosen,
  onOpen,
  onShow,
  onChoose,
}: {
  serviceId: string;
  photo: ImmichPhoto;
  show: Show;
  blurAll?: boolean;
  /** Choosing photos: a click chooses this one instead of opening it. */
  choosing?: boolean;
  chosen?: boolean;
  onOpen: () => void;
  onShow: (s: Show) => void;
  onChoose?: (shift: boolean) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [menu, setMenu] = useState(false);
  const blurred = (show !== "normal" || blurAll) && !revealed;
  const label = `${photo.name}${photo.takenAt ? `, ${taken(photo.takenAt)}` : ""}`;
  return (
    <li
      className={cx(
        "group relative aspect-square overflow-hidden rounded-lg border bg-raised",
        chosen ? "border-gold ring-2 ring-gold" : "border-line",
      )}
      data-testid="im-photo"
      data-show={show}
      {...(choosing ? { "data-chosen": chosen ? "true" : "false" } : {})}
    >
      <button
        type="button"
        className="block h-full w-full select-none"
        aria-label={
          choosing
            ? `${chosen ? "Unchoose" : "Choose"} ${label}`
            : blurred
              ? `Show ${label} (blurred)`
              : `Open ${label}`
        }
        {...(choosing ? { "aria-pressed": Boolean(chosen) } : {})}
        title={label}
        onClick={(e) =>
          choosing ? onChoose?.(e.shiftKey) : blurred ? setRevealed(true) : onOpen()
        }
      >
        <img
          src={thumbUrl(serviceId, photo.id, "thumbnail", photo.version)}
          alt={blurred ? "" : label}
          loading="lazy"
          decoding="async"
          className={cx(
            "h-full w-full object-cover transition duration-200",
            blurred ? "scale-110 blur-xl" : "group-hover:scale-105",
          )}
        />
        {blurred && (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/30 text-[0.72rem] text-white">
            <EyeOff strokeWidth={1.5} className="h-4 w-4" />
            {show === "hide" ? "Hidden" : choosing ? "" : "Click to show"}
          </span>
        )}
        {choosing && (
          <span
            aria-hidden
            className={cx(
              "absolute top-1.5 left-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2 shadow",
              chosen
                ? "border-gold bg-gold text-black"
                : "border-white bg-black/30 text-transparent",
            )}
          >
            <Check strokeWidth={3} className="h-3.5 w-3.5" />
          </span>
        )}
      </button>
      {photo.favorite && !blurred && (
        <Heart
          aria-label="Favorite"
          strokeWidth={1.5}
          className="pointer-events-none absolute bottom-1 left-1 h-3.5 w-3.5 fill-white text-white drop-shadow"
        />
      )}
      {!choosing && (
        <button
          type="button"
          aria-label={`Blur or hide ${photo.name}`}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
          className="absolute top-1 right-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white opacity-100 transition-opacity @lg:opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          data-testid="im-photo-menu"
        >
          <MoreHorizontal strokeWidth={1.75} className="h-4 w-4" />
        </button>
      )}
      {menu &&
        createPortal(
          <PhotoMenu
            show={show}
            onClose={() => setMenu(false)}
            onChange={(s) => {
              setRevealed(false);
              onShow(s);
            }}
          />,
          document.body,
        )}
    </li>
  );
}

/** A photo opened large, with sharing, blurring, and the photos before and after it. */
function FullView({
  serviceId,
  name,
  photos,
  index,
  prefs,
  onShow,
  onIndex,
  onClose,
}: {
  serviceId: string;
  name: string;
  photos: ImmichPhoto[];
  index: number;
  prefs: ImmichPhotoPrefs;
  onShow: (id: string, s: Show) => void;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const photo = photos[index]!;
  const show = showOf(prefs, photo.id);
  const [revealed, setRevealed] = useState<string>();
  const blurred = show !== "normal" && revealed !== photo.id;
  const service = useWorkspace().data?.services.find((x) => x.id === serviceId);
  const inImmich = keyPageHref(service, `/photos/${photo.id}`);
  const c = useApproveHere(serviceId, "From Immich's panel in Hearth.");
  const [days, setDays] = useState(7);
  const [copied, setCopied] = useState(false);
  const [shareError, setShareError] = useState<string>();
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const preview = thumbUrl(serviceId, photo.id, "preview", photo.version);

  // Editing: flips and turns preview live on the photo as taken; Save is one approved edit.
  const qc = useQueryClient();
  const [editing, setEditing] = useState<string>();
  const isEditing = editing === photo.id;
  const edits = useQuery({
    queryKey: ["immich-edits", serviceId, photo.id],
    queryFn: () =>
      api<EditsAnswer>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/dashboard/immich/edits?asset=${encodeURIComponent(photo.id)}`,
      ),
    enabled: isEditing,
  });
  const start: EditState = edits.data
    ? { rotate: edits.data.rotate, mirrorH: edits.data.mirrorH, mirrorV: edits.data.mirrorV }
    : AS_TAKEN;
  const [draft, setDraft] = useState<EditState>();
  const state = draft ?? start;
  const e = useApproveHere(serviceId, "From Immich's panel in Hearth: editing a photo.");
  const [seen, setSeen] = useState<string>();
  if (e.job?.status === "succeeded" && seen !== e.job.id) {
    // The edit is in: fetch the photo list again (each edited photo gets a new version, so its
    // pictures load afresh) and leave editing.
    setSeen(e.job.id);
    setEditing(undefined);
    setDraft(undefined);
    void qc.invalidateQueries({ queryKey: ["immich-photos", serviceId] });
    void qc.invalidateQueries({ queryKey: ["immich-edits", serviceId] });
  }
  const stopEditing = () => {
    setEditing(undefined);
    setDraft(undefined);
  };

  // A shared link made here, for this photo, once Immich has made it.
  const done = c.job?.status === "succeeded" ? c.job : undefined;
  const made =
    done && String(done.steps[0]?.params?.assetId ?? "")
      ? /Send this link: (\S+)/.exec(done.steps.map((x) => x.result ?? "").join(" "))?.[1]
      : undefined;
  const madeFor = String(done?.steps[0]?.params?.assetId ?? "");
  // Kept after the pop-up closes (which forgets the plan), so it can still be sent.
  const [links, setLinks] = useState<Record<string, string>>({});
  if (made && madeFor && links[madeFor] !== made) setLinks({ ...links, [madeFor]: made });
  const link = links[photo.id];

  useEffect(() => {
    const key = (ev: KeyboardEvent) => {
      // While a pop-up or the editor is open, the keys belong to it.
      if (e.open || editing) return;
      if (ev.key === "Escape") onClose();
      if (ev.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      if (ev.key === "ArrowRight" && index < photos.length - 1) onIndex(index + 1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [index, photos.length, onClose, onIndex, e.open, editing]);

  const sharePhoto = async () => {
    setShareError(undefined);
    try {
      const blob = await (await fetch(preview, { credentials: "same-origin" })).blob();
      const ext = blob.type.split("/")[1] ?? "jpg";
      const file = new File([blob], `${photo.name.replace(/\.[^.]+$/, "")}.${ext}`, {
        type: blob.type,
      });
      if (navigator.canShare?.({ files: [file] }))
        await navigator.share({ files: [file], title: photo.name });
      else
        setShareError("This device cannot share a picture directly. Download it, or share a link.");
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError"))
        setShareError("The photo could not be shared from here. Download it, or share a link.");
    }
  };
  const message = `A photo for you: ${link ?? ""}`;
  const action =
    "inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-white/25 px-3 text-[0.82rem] text-white hover:border-gold hover:text-gold disabled:opacity-50";

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${photo.name}, full view`}
      className="fixed inset-0 z-[80] flex flex-col bg-black text-white"
      data-testid="im-full-view"
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.9rem]">{photo.name}</p>
          <p
            className="truncate text-[0.74rem] whitespace-nowrap text-white/60"
            data-testid="im-full-meta"
          >
            {taken(photo.takenAt)}
            {photo.favorite ? " · Favorite" : ""} · {index + 1} of {photos.length}
          </p>
        </div>
        {inImmich && (
          <a
            href={inImmich}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open in ${name}`}
            title={`Open in ${name}`}
            className="inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center gap-1 text-[0.8rem] text-white/80 hover:text-gold"
          >
            {/* On a phone only the icon, so the name and date keep their line. */}
            <span className="hidden max-w-[16rem] truncate sm:inline">Open in {name}</span>
            <ExternalLink strokeWidth={1.5} className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </a>
        )}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/10"
          data-testid="im-full-close"
        >
          <X strokeWidth={1.75} className="h-5 w-5" />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2">
        {index > 0 && !isEditing && (
          <button
            type="button"
            aria-label="Previous photo"
            onClick={() => onIndex(index - 1)}
            className="absolute left-2 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-black/50 hover:bg-black/70"
          >
            <ChevronLeft strokeWidth={1.75} className="h-6 w-6" />
          </button>
        )}
        {isEditing ? (
          // A square frame, so a quarter turn always fits.
          <img
            key={`${photo.id}-edit`}
            src={thumbUrl(serviceId, photo.id, "preview", photo.version, false)}
            alt={`${photo.name}, as it will look`}
            style={{ transform: previewTransform(state) }}
            className="h-[min(60vh,92vw)] w-[min(60vh,92vw)] object-contain transition-transform duration-200"
            data-testid="im-edit-preview"
            data-transform={previewTransform(state)}
          />
        ) : (
          <img
            key={photo.id}
            src={preview}
            alt={blurred ? "" : photo.name}
            className={cx("h-full w-full object-contain", blurred && "scale-105 blur-2xl")}
            data-testid="im-full-image"
          />
        )}
        {blurred && !isEditing && (
          <button
            type="button"
            onClick={() => setRevealed(photo.id)}
            className="absolute inline-flex min-h-11 items-center gap-2 rounded-full bg-black/70 px-4 text-[0.86rem]"
          >
            <Eye strokeWidth={1.5} className="h-4 w-4" /> Show this photo
          </button>
        )}
        {index < photos.length - 1 && !isEditing && (
          <button
            type="button"
            aria-label="Next photo"
            onClick={() => onIndex(index + 1)}
            className="absolute right-2 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-black/50 hover:bg-black/70"
          >
            <ChevronRight strokeWidth={1.75} className="h-6 w-6" />
          </button>
        )}
      </div>

      {isEditing ? (
        <div className="space-y-2 px-4 py-3">
          {edits.isPending ? (
            <p className="text-center text-[0.82rem] text-white/70">Reading its edits…</p>
          ) : edits.data && !edits.data.supported ? (
            <p className="text-center text-[0.84rem] text-amber" data-testid="im-edit-unsupported">
              This {name} cannot edit photos. Immich 2.5 or later flips and turns photos without
              changing the original file.
            </p>
          ) : (
            <>
              {edits.data?.cropped && (
                <p className="text-center text-[0.76rem] text-white/60">
                  Its crop in {name} is kept; the preview shows it uncropped.
                </p>
              )}
              <EditTools
                state={state}
                start={start}
                edited={Boolean(edits.data?.edited)}
                busy={e.busy}
                onChange={setDraft}
                onCancel={stopEditing}
                onSave={() =>
                  void (sameEdit(state, AS_TAKEN) && edits.data?.edited
                    ? e.propose(
                        "app-immich-control",
                        { op: "edit-reset", assetId: photo.id },
                        `Restore ${photo.name}`,
                      )
                    : e.propose(
                        "app-immich-control",
                        {
                          op: "edit",
                          assetId: photo.id,
                          rotate: state.rotate,
                          mirrorH: state.mirrorH,
                          mirrorV: state.mirrorV,
                        },
                        `Edit ${photo.name}`,
                      ))
                }
                onRestore={() =>
                  void e.propose(
                    "app-immich-control",
                    { op: "edit-reset", assetId: photo.id },
                    `Restore ${photo.name}`,
                  )
                }
              />
            </>
          )}
          {e.error && <p className="text-center text-[0.8rem] text-amber">{e.error}</p>}
          {!edits.isPending && edits.data && !edits.data.supported && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={stopEditing}
                className={action}
                data-testid="im-edit-cancel"
              >
                Back
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2 px-4 py-3" data-testid="im-share">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={action}
              onClick={() => {
                setDraft(undefined);
                setEditing(photo.id);
              }}
              data-testid="im-edit"
            >
              <Crop strokeWidth={1.5} className="h-4 w-4" /> Edit
            </button>
            {canShare && (
              <button
                type="button"
                className={action}
                onClick={() => void sharePhoto()}
                data-testid="im-share-photo"
              >
                <Share2 strokeWidth={1.5} className="h-4 w-4" /> Share photo
              </button>
            )}
            <a href={preview} download={photo.name} className={action} data-testid="im-download">
              <Download strokeWidth={1.5} className="h-4 w-4" /> Download
            </a>
            <span className="mx-1 hidden h-6 w-px bg-white/20 sm:block" />
            <label className="inline-flex items-center gap-1.5 text-[0.8rem] text-white/75">
              Link works for
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="min-h-10 rounded-lg border border-white/25 bg-black px-2 text-[0.82rem] text-white"
                data-testid="im-share-days"
              >
                <option value={1}>1 day</option>
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={0}>Until I remove it</option>
              </select>
            </label>
            <button
              type="button"
              className={action}
              disabled={c.busy}
              onClick={() =>
                void c.propose(
                  "app-immich-control",
                  { op: "share-link", assetId: photo.id, expiresDays: days },
                  `Share ${photo.name} with a link`,
                )
              }
              data-testid="im-share-link"
            >
              <Link2 strokeWidth={1.5} className="h-4 w-4" /> Share a link
            </button>
            <span className="ml-auto inline-flex items-center gap-1 text-[0.78rem] text-white/70">
              In Hearth:
              {(["normal", "blur", "hide"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={show === s}
                  onClick={() => onShow(photo.id, s)}
                  className={cx(
                    "min-h-9 rounded-full border px-2.5",
                    show === s ? "border-gold text-gold" : "border-white/20 hover:text-white",
                  )}
                  data-testid={`im-full-${s}`}
                >
                  {s === "normal" ? "Show" : s === "blur" ? "Blur" : "Hide"}
                </button>
              ))}
            </span>
          </div>
          {shareError && <p className="text-[0.8rem] text-amber">{shareError}</p>}
          {link && (
            <div
              className="flex flex-wrap items-center gap-2 rounded-lg border border-gold/40 bg-gold/10 p-2"
              data-testid="im-link"
            >
              <span
                className="min-w-0 flex-1 truncate font-mono text-[0.78rem]"
                data-testid="im-link-url"
              >
                {link}
              </span>
              <a
                className={action}
                href={`sms:?&body=${encodeURIComponent(message)}`}
                data-testid="im-link-text"
              >
                <MessageSquare strokeWidth={1.5} className="h-4 w-4" /> Text
              </a>
              <a
                className={action}
                href={`mailto:?subject=${encodeURIComponent(`A photo: ${photo.name}`)}&body=${encodeURIComponent(message)}`}
                data-testid="im-link-email"
              >
                <Mail strokeWidth={1.5} className="h-4 w-4" /> Email
              </a>
              <button
                type="button"
                className={action}
                onClick={() =>
                  void navigator.clipboard?.writeText(link).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  })
                }
                data-testid="im-link-copy"
              >
                <Copy strokeWidth={1.5} className="h-4 w-4" /> {copied ? "Copied" : "Copy link"}
              </button>
              {canShare && (
                <button
                  type="button"
                  className={action}
                  onClick={() =>
                    void navigator.share({ url: link, title: photo.name }).catch(() => undefined)
                  }
                >
                  <Share2 strokeWidth={1.5} className="h-4 w-4" /> More
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <ApproveDialog c={c} />
      <ApproveDialog c={e} />
    </div>,
    document.body,
  );
}

/** A grid of photos with blurring, hiding and the full view. */
function PhotoGrid({
  serviceId,
  name,
  photos,
  blurAll,
  className,
  testId,
  sel,
}: {
  serviceId: string;
  name: string;
  photos: ImmichPhoto[];
  blurAll?: boolean;
  className?: string;
  testId?: string;
  /** Choosing photos (the Photos tab). */
  sel?: Selection;
}) {
  const { prefs, set } = usePhotoPrefs(serviceId);
  const [open, setOpen] = useState<number>();
  return (
    <>
      <ul className={className} data-testid={testId}>
        {photos.map((p, i) => (
          <PhotoTile
            key={p.id}
            serviceId={serviceId}
            photo={p}
            show={showOf(prefs, p.id)}
            {...(blurAll ? { blurAll } : {})}
            choosing={Boolean(sel?.on)}
            chosen={Boolean(sel?.ids.has(p.id))}
            onChoose={(shift) => sel?.toggle(i, shift)}
            onOpen={() => setOpen(i)}
            onShow={(s) => set({ photo: { id: p.id, show: s } })}
          />
        ))}
      </ul>
      {open !== undefined && photos[open] && (
        <FullView
          serviceId={serviceId}
          name={name}
          photos={photos}
          index={open}
          prefs={prefs}
          onShow={(id, s) => set({ photo: { id, show: s } })}
          onIndex={setOpen}
          onClose={() => setOpen(undefined)}
        />
      )}
    </>
  );
}

/** The Overview's Recent photos: shown, blurred, or off, without hidden ones. */
export function RecentPhotos({
  serviceId,
  name,
  photos,
  onAll,
}: {
  serviceId: string;
  name: string;
  photos: ImmichPhoto[];
  onAll?: () => void;
}) {
  const { prefs, set } = usePhotoPrefs(serviceId);
  const shown = useMemo(() => photos.filter((p) => prefs.photos[p.id] !== "hide"), [photos, prefs]);
  const modes: { value: ImmichPhotoPrefs["recent"]; label: string }[] = [
    { value: "show", label: "Show" },
    { value: "blur", label: "Blur all" },
    { value: "off", label: "Off" },
  ];
  return (
    <div data-testid="im-recent">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-[0.72rem] tracking-wide text-faint uppercase">Recent photos</p>
        {onAll && prefs.recent !== "off" && (
          <button
            type="button"
            onClick={onAll}
            className="min-h-8 text-[0.78rem] text-gold underline-offset-2 hover:underline"
            data-hearth-target="recent:all"
          >
            See all photos
          </button>
        )}
        <div
          role="radiogroup"
          aria-label="Recent photos on the Overview"
          className="ml-auto flex gap-1"
        >
          {modes.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={prefs.recent === m.value}
              onClick={() => set({ recent: m.value })}
              className={cx(
                "min-h-8 rounded-full border px-2.5 text-[0.74rem]",
                prefs.recent === m.value
                  ? "border-gold/60 bg-gold/10 text-gold"
                  : "border-line text-muted hover:text-ink",
              )}
              data-testid={`im-recent-${m.value}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      {prefs.recent === "off" ? (
        <p className="text-[0.82rem] text-muted" data-testid="im-recent-off-note">
          Recent photos are off here. Your photos are still in {name} and in the Photos tab.
        </p>
      ) : shown.length === 0 ? (
        <p className="text-[0.84rem] text-muted">No photos on the timeline yet.</p>
      ) : (
        <PhotoGrid
          serviceId={serviceId}
          name={name}
          photos={shown}
          blurAll={prefs.recent === "blur"}
          className="grid max-h-[26rem] grid-cols-3 gap-1.5 overflow-y-auto overscroll-contain pr-1 @md:grid-cols-4 @2xl:grid-cols-5"
          testId="im-recent-list"
        />
      )}
    </div>
  );
}

/** The albums, newest changed first: the order of the album tabs. */
export const albumOrder = <T extends { albumName: string; updatedAt?: string }>(list: T[]) =>
  [...list].sort(
    (a, b) =>
      (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0) ||
      a.albumName.localeCompare(b.albumName),
  );

/**
 * The tab row under Photos: All photos, then one tab per album, on one line. Albums that do not
 * fit go in More albums; the open album always has a visible tab.
 */
function AlbumTabs({
  albums,
  current,
  onPick,
}: {
  albums: AlbumsAnswer["albums"];
  current?: string;
  onPick: (albumId?: string) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(3);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    // About 9.5rem a tab, after All photos and More albums.
    const measure = () => setFit(Math.max(1, Math.floor((el.clientWidth - 260) / 152)));
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const ordered = albumOrder(albums);
  let shown = ordered.slice(0, fit);
  const picked = ordered.find((a) => a.id === current);
  if (picked && !shown.includes(picked)) shown = [...shown.slice(0, fit - 1), picked];
  const rest = ordered.filter((a) => !shown.includes(a));
  const tab = (on: boolean) =>
    cx(
      "inline-flex min-h-9 max-w-[9.5rem] shrink-0 items-center rounded-full border px-3 text-[0.8rem]",
      on ? "border-gold/60 bg-gold/10 text-gold" : "border-line text-muted hover:text-ink",
    );
  return (
    <div
      ref={row}
      role="tablist"
      aria-label="Albums"
      className="relative flex flex-nowrap items-center gap-1.5"
      data-testid="im-album-tabs"
    >
      <button
        type="button"
        role="tab"
        aria-selected={!current}
        className={tab(!current)}
        onClick={() => onPick(undefined)}
        data-testid="im-album-tab-all"
      >
        All photos
      </button>
      {shown.map((a) => (
        <button
          key={a.id}
          type="button"
          role="tab"
          aria-selected={a.id === current}
          title={a.albumName}
          className={tab(a.id === current)}
          onClick={() => onPick(a.id)}
          data-testid="im-album-tab"
        >
          <span className="truncate">{a.albumName}</span>
        </button>
      ))}
      {rest.length > 0 && (
        <div className="relative shrink-0">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            className={tab(false)}
            onClick={() => setOpen((o) => !o)}
            data-testid="im-album-more"
          >
            More albums ({rest.length})
          </button>
          {open && (
            <div
              role="menu"
              className="absolute right-0 z-20 mt-1 max-h-72 w-60 overflow-auto rounded-xl border border-line-strong bg-panel p-1 shadow-xl"
              data-testid="im-album-more-list"
            >
              {rest.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="menuitem"
                  aria-label={`${a.albumName}, ${a.assetCount ?? 0} photos`}
                  // Only opens the album's tab: Ember's cursor may press it.
                  data-hearth-target={`album:${a.id}:open`}
                  className="block min-h-9 w-full truncate rounded-md px-2.5 text-left text-[0.82rem] text-ink hover:bg-raised"
                  onClick={() => {
                    setOpen(false);
                    onPick(a.id);
                  }}
                >
                  {a.albumName}
                  <span className="ml-1.5 text-faint">{a.assetCount ?? 0}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The Photos tab: All photos (every photo on the timeline, newest first, loading more as you
 * scroll), then one tab per album with the same tools. The open album is in the address
 * ("photos/album/<id>").
 */
export function ImmichPhotos({ serviceId, name, sub, onSub, onGo }: AppViewProps) {
  const albums = useQuery({
    queryKey: ["immich-albums", serviceId],
    queryFn: () =>
      api<AlbumsAnswer>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/dashboard/immich/albums`,
      ),
  });
  const [local, setLocal] = useState<string>();
  const fromAddress = sub?.startsWith("album/") ? sub.slice(6) : undefined;
  const album = onSub ? fromAddress : local;
  const pick = (id?: string) => (onSub ? onSub(id ? `album/${id}` : null) : setLocal(id));
  const list = albums.data?.albums ?? [];
  const current = list.find((a) => a.id === album);
  return (
    <div className="space-y-3">
      {list.length > 0 && <AlbumTabs albums={list} current={album} onPick={pick} />}
      {album && albums.data && !current ? (
        <p className="text-[0.86rem] text-muted" data-testid="im-album-gone">
          This album is not in {name} any more.
        </p>
      ) : (
        <PhotosBody
          key={album ?? "all"}
          serviceId={serviceId}
          name={name}
          {...(current ? { album: current } : {})}
          onPick={pick}
          {...(onGo ? { onFiles: () => onGo("folders") } : {})}
        />
      )}
    </div>
  );
}

function PhotosBody({
  serviceId,
  name,
  album,
  onPick,
  onFiles,
}: {
  serviceId: string;
  name: string;
  album?: AlbumsAnswer["albums"][number];
  onPick: (albumId?: string) => void;
  onFiles?: () => void;
}) {
  const qc = useQueryClient();
  const pages = useInfiniteQuery({
    queryKey: ["immich-photos", serviceId, album?.id ?? "all"],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      api<ImmichPhotoPage>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/dashboard/immich/photos?page=${pageParam}${album ? `&album=${encodeURIComponent(album.id)}` : ""}`,
      ),
    getNextPageParam: (last) => last.next,
  });
  const photos = useMemo(() => pages.data?.pages.flatMap((p) => p.items) ?? [], [pages.data]);
  const sel = useSelection(serviceId, photos, album?.id);
  const [organizing, setOrganizing] = useState(false);
  // Taking photos out of this album: one approved plan, and Undo puts them back.
  const out = useApproveHere(
    serviceId,
    "From Immich's panel in Hearth: taking photos out of an album.",
  );
  const back = useApproveHere(
    serviceId,
    "From Immich's panel in Hearth: putting photos back in an album.",
  );
  const [removed, setRemoved] = useState<{ job: string; ids: string[] }>();
  if (out.job?.status === "succeeded" && removed?.job !== out.job.id) {
    setRemoved({
      job: out.job.id,
      ids: out.job.steps.flatMap((x) =>
        String(x.params?.body ?? "")
          .split(",")
          .filter(Boolean),
      ),
    });
    sel.done();
    void qc.invalidateQueries({ queryKey: ["immich-photos", serviceId] });
    void qc.invalidateQueries({ queryKey: ["immich-albums", serviceId] });
  }
  const [restored, setRestored] = useState<string>();
  if (back.job?.status === "succeeded" && restored !== back.job.id) {
    setRestored(back.job.id);
    setRemoved(undefined);
    void qc.invalidateQueries({ queryKey: ["immich-photos", serviceId] });
    void qc.invalidateQueries({ queryKey: ["immich-albums", serviceId] });
  }
  const steps = (op: string, ids: string[]) =>
    chunkIds(ids).map((part) => ({
      kind: "app-immich-control" as const,
      params: { op, albumId: album!.id, body: part.join(",") },
    }));
  const end = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = pages;
  useEffect(() => {
    const el = end.current;
    if (!el || !hasNextPage) return;
    const seen = new IntersectionObserver((e) => {
      if (e.some((x) => x.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    });
    seen.observe(el);
    return () => seen.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  if (pages.isPending) return <Skeleton className="h-64" />;
  if (pages.isError)
    return (
      <p role="alert" className="text-[0.86rem] text-bad">
        Could not read {name}&apos;s photos: {pages.error.message}
      </p>
    );
  return (
    <section
      className="@container space-y-3"
      data-testid="im-photos"
      aria-label={`${name}: photos`}
    >
      <div className="flex flex-wrap items-start gap-2">
        <p className="min-w-0 flex-1 text-[0.82rem] text-muted">
          {sel.on
            ? album
              ? "Tap photos to choose them (Shift-click chooses a run). Then put them in another album, or take them out of this one."
              : "Tap photos to choose them (Shift-click chooses a run). Then put them in an album."
            : album
              ? `${album.albumName}: ${(album.assetCount ?? photos.length).toLocaleString()} photos, newest first. Click one to see it large, share it, or flip and turn it.`
              : `Every photo on ${name}'s timeline, newest first. Click one to see it large, share it, or flip and turn it. Archived and locked photos are never shown here.`}
          {pages.data?.pages[0]?.sample && <span className="ml-2 text-faint">Sample data</span>}
        </p>
        {!sel.on && photos.length > 0 && (
          <button
            type="button"
            onClick={sel.start}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-line px-3 text-[0.84rem] text-ink hover:border-gold hover:text-gold"
            data-testid="im-select"
          >
            <Check strokeWidth={1.75} className="h-4 w-4" /> Select
          </button>
        )}
      </div>
      {photos.length === 0 ? (
        <p className="text-[0.86rem] text-muted">
          {album ? "No photos in this album." : "No photos on the timeline yet."}
        </p>
      ) : (
        <PhotoGrid
          serviceId={serviceId}
          name={name}
          photos={photos}
          className="grid grid-cols-3 gap-1.5 @md:grid-cols-4 @2xl:grid-cols-6"
          testId="im-photos-grid"
          sel={sel}
        />
      )}
      <div ref={end} className="h-px" />
      {hasNextPage && (
        <button
          type="button"
          onClick={() => void fetchNextPage()}
          disabled={isFetchingNextPage}
          className="min-h-10 w-full rounded-lg border border-line text-[0.84rem] text-muted hover:text-ink"
          data-testid="im-photos-more"
        >
          {isFetchingNextPage ? "Loading more…" : "Load more"}
        </button>
      )}
      {removed && album && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2 text-[0.82rem] text-muted"
          data-testid="im-album-removed"
        >
          <span className="flex-1">
            Took {removed.ids.length} photo{removed.ids.length === 1 ? "" : "s"} out of &quot;
            {album.albumName}&quot;. They are still in {name}.
          </span>
          <Button
            tone="quiet"
            disabled={back.busy}
            onClick={() =>
              void back.proposeMany(
                steps("album-add", removed.ids),
                `Put the photos back in "${album.albumName}"`,
              )
            }
            data-testid="im-album-removed-undo"
          >
            <Undo2 strokeWidth={1.5} className="mr-1 inline h-4 w-4" /> Undo
          </Button>
        </div>
      )}
      {sel.on && (
        <SelectionBar
          sel={sel}
          loaded={photos.length}
          more={Boolean(hasNextPage)}
          onOrganize={() => setOrganizing(true)}
          {...(album
            ? {
                album: album.albumName,
                onRemove: () =>
                  void out.proposeMany(
                    steps("album-remove", [...sel.ids]),
                    `Take photos out of "${album.albumName}"`,
                  ),
              }
            : {})}
        />
      )}
      <ApproveDialog c={out} />
      <ApproveDialog c={back} />
      {organizing && (
        <OrganizeDialog
          serviceId={serviceId}
          name={name}
          ids={[...sel.ids]}
          photos={photos}
          onClose={() => setOrganizing(false)}
          onDone={() => {
            setOrganizing(false);
            sel.done();
          }}
          onOpenAlbum={(id) => {
            setOrganizing(false);
            sel.done();
            onPick(id);
          }}
          {...(onFiles ? { onFiles } : {})}
        />
      )}
    </section>
  );
}
