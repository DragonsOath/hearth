import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Folder,
  FolderPlus,
  Loader2,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import {
  CATALOG_DEFAULT_TITLE,
  MAX_CATALOG_SHELVES,
  guessShelfKind,
  type CatalogFile,
  type CatalogSettings,
  type CatalogShelfSetting,
  type CatalogState,
  type FolderListing,
} from "@dragon-control/core";
import { api } from "../../data/api";
import { onPc, useStoragePc } from "./pc";
import { ago, bytes } from "../../lib/format";
import { Button, cx } from "../ui";
import type { FileRootInfo } from "./FileManager";
import { useLiveQuery } from "../panels/lifecycle";

/**
 * Collection PDF (Storage & Files): pick the folders to list and what each holds, then Make PDF.
 * Hearth reads them in the background and makes a PDF of every movie and show, grouped by year,
 * that opens in the browser's PDF viewer, downloads, or shares to another app or person.
 * Reading the folders changes nothing in them.
 */

const btn =
  "inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-[0.82rem] text-ink hover:border-gold hover:text-gold disabled:opacity-50";
const field =
  "min-h-10 min-w-0 rounded-lg border border-line bg-raised px-3 text-[0.86rem] text-ink";

const fileUrl = (id: string, download = false) =>
  `/api/catalog/files/${encodeURIComponent(id)}${download ? "?download=1" : ""}`;

function where(roots: FileRootInfo[], s: Pick<CatalogShelfSetting, "rootId" | "path">) {
  const r = roots.find((x) => x.id === s.rootId);
  const label = r?.label ?? "A drive Hearth cannot see now";
  return s.path ? `${label} › ${s.path.split("/").join(" › ")}` : label;
}

/** Browse a drive or watched folder and choose one folder inside it. */
function FolderPicker({
  roots,
  onPick,
  onCancel,
}: {
  roots: FileRootInfo[];
  onPick: (p: { rootId: string; path: string; name: string }) => void;
  onCancel: () => void;
}) {
  const [rootId, setRootId] = useState(roots[0]?.id ?? "");
  const [folder, setFolder] = useState("");
  const pc = useStoragePc();
  const list = useQuery({
    queryKey: ["files", "list", rootId, folder, pc],
    queryFn: () =>
      api<FolderListing>(
        "GET",
        onPc(
          pc,
          `/api/files/list?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(folder)}`,
        ),
      ),
    enabled: Boolean(rootId),
  });
  const root = roots.find((r) => r.id === rootId);
  const folders = (list.data?.entries ?? []).filter((e) => e.kind === "folder");
  const name = folder ? folder.split("/").pop()! : (root?.label ?? "");
  return (
    <div
      className="space-y-3 rounded-xl border border-gold/40 bg-bg/60 p-3"
      data-testid="catalog-picker"
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-[0.82rem] text-muted">
          Drive or folder
          <select
            value={rootId}
            onChange={(e) => {
              setRootId(e.target.value);
              setFolder("");
            }}
            className={cx(field, "flex-1")}
            aria-label="Drive or folder"
          >
            {roots.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={btn}
          onClick={onCancel}
          aria-label="Cancel choosing a folder"
        >
          <X className="h-4 w-4" aria-hidden /> Cancel
        </button>
      </div>
      <nav className="flex flex-wrap items-center gap-1 text-[0.8rem]" aria-label="Where you are">
        {(list.data?.breadcrumbs ?? [{ name: root?.label ?? "", path: "" }]).map((b, i, all) => (
          <span key={b.path} className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={() => setFolder(b.path)}
              className={cx("hover:text-gold", i === all.length - 1 ? "text-ink" : "text-muted")}
            >
              {b.name}
            </button>
            {i < all.length - 1 && <ChevronRight className="h-3.5 w-3.5 text-faint" aria-hidden />}
          </span>
        ))}
      </nav>
      <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line">
        {list.isLoading ? (
          <li className="p-3 text-[0.82rem] text-muted">Reading…</li>
        ) : list.error ? (
          <li className="p-3 text-[0.82rem] text-alert">{list.error.message}</li>
        ) : folders.length ? (
          folders.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => setFolder(f.path)}
                className="flex min-h-10 w-full items-center gap-2 px-3 text-left text-[0.84rem] text-ink hover:bg-raised"
                data-testid="catalog-picker-folder"
              >
                <Folder className="h-4 w-4 text-gold" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <ChevronRight className="h-4 w-4 text-faint" aria-hidden />
              </button>
            </li>
          ))
        ) : (
          <li className="p-3 text-[0.82rem] text-muted">No folders inside.</li>
        )}
      </ul>
      <Button
        onClick={() => onPick({ rootId, path: folder, name })}
        data-testid="catalog-use-folder"
      >
        Use {name || "this folder"}
      </Button>
    </div>
  );
}

function SavedPdf({ f, onDelete }: { f: CatalogFile; onDelete: () => void }) {
  const pc = useStoragePc();
  const [note, setNote] = useState<string>();
  const name = `${f.title} ${f.at.slice(0, 10)}.pdf`;
  const share = async () => {
    setNote(undefined);
    try {
      const res = await fetch(fileUrl(f.id));
      if (!res.ok) throw new Error(`Hearth answered ${res.status}.`);
      const file = new File([await res.blob()], name, { type: "application/pdf" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: f.title });
        return;
      }
      // No file sharing in this browser (most desktops): save it instead.
      const a = document.createElement("a");
      a.href = URL.createObjectURL(file);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      setNote("This browser cannot share files, so it was downloaded to send yourself.");
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return; // closed the share sheet
      setNote(`Could not share: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <li
      className="space-y-2 py-3"
      data-testid="catalog-file"
      data-capture-item
      data-capture-label={name}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <FileText className="mt-0.5 h-5 w-5 shrink-0 text-gold" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[0.92rem] text-ink">{f.title}</p>
          <p className="text-[0.76rem] text-faint">
            Made {ago(f.at).toLowerCase()} · {f.titles.toLocaleString()} titles ·{" "}
            {bytes(f.libraryBytes)} of media · {bytes(f.fileBytes)} PDF
          </p>
          <p className="text-[0.76rem] text-faint">
            {f.shelves.map((s) => `${s.name} ${s.count.toLocaleString()}`).join(" · ")}
          </p>
          {f.partial?.length ? (
            <p className="text-[0.76rem] text-amber">
              Not finished in time: {f.partial.join(", ")}.
            </p>
          ) : null}
          {f.failed?.length ? (
            <p className="text-[0.76rem] text-amber">
              Could not read: {f.failed.map((x) => `${x.name} (${x.reason})`).join("; ")}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pl-8">
        <a
          className={btn}
          href={onPc(pc, fileUrl(f.id))}
          target="_blank"
          rel="noopener"
          data-testid="catalog-open"
        >
          <ExternalLink className="h-4 w-4" aria-hidden /> Open
        </a>
        <a
          className={btn}
          href={onPc(pc, fileUrl(f.id, true))}
          download={name}
          data-testid="catalog-download"
        >
          <Download className="h-4 w-4" aria-hidden /> Download
        </a>
        <button
          type="button"
          className={btn}
          onClick={() => void share()}
          data-testid="catalog-share"
        >
          <Share2 className="h-4 w-4" aria-hidden /> Share
        </button>
        <button type="button" className={btn} onClick={onDelete} aria-label={`Delete ${name}`}>
          <Trash2 className="h-4 w-4" aria-hidden /> Delete
        </button>
      </div>
      {note && <p className="pl-8 text-[0.78rem] text-muted">{note}</p>}
    </li>
  );
}

export function CollectionCatalog({ roots }: { roots: FileRootInfo[] }) {
  const qc = useQueryClient();
  const pc = useStoragePc();
  const q = useLiveQuery({
    queryKey: ["catalog", pc],
    queryFn: () => api<CatalogState>("GET", onPc(pc, "/api/catalog")),
    refetchInterval: (query) => (query.state.data?.status.running ? 1500 : 30_000),
  });
  // Your edits; until you change something, the saved settings.
  const [edits, setDraft] = useState<CatalogSettings>();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string>();
  const saved = q.data?.settings;
  const draft = edits ?? saved;
  const dirty = Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved));

  const save = useMutation({
    mutationFn: (s: CatalogSettings) =>
      api<CatalogSettings>("PUT", onPc(pc, "/api/catalog/settings"), s),
    onSuccess: () => {
      setDraft(undefined);
      void qc.invalidateQueries({ queryKey: ["catalog"] });
    },
  });
  const make = useMutation({
    mutationFn: async () => {
      if (draft && dirty) await save.mutateAsync(draft);
      return api("POST", onPc(pc, "/api/catalog/make"));
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["catalog"] }),
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api("DELETE", onPc(pc, `/api/catalog/files/${encodeURIComponent(id)}`)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["catalog"] }),
  });

  if (!q.data || !draft)
    return q.error ? (
      <p className="text-[0.86rem] text-alert">Could not read Collection PDF: {q.error.message}</p>
    ) : (
      <p className="text-[0.86rem] text-muted">Reading…</p>
    );
  const status = q.data.status;
  const setShelf = (i: number, patch: Partial<CatalogShelfSetting>) =>
    setDraft({
      ...draft,
      shelves: draft.shelves.map((s, j) => (j === i ? { ...s, ...patch } : s)),
    });

  return (
    <div className="space-y-5" data-testid="collection-catalog">
      <section className="space-y-3 rounded-xl border border-line p-4">
        <div>
          <h3 className="text-[1rem] text-ink">Collection PDF</h3>
          <p className="text-[0.84rem] text-muted">
            A printable list of every movie and show in the folders you choose, grouped by year,
            with sizes and a contents page you can tap through. Open it, download it, or share it.
            Hearth only reads the folders.
          </p>
        </div>
        <label className="flex flex-col gap-1 text-[0.8rem] text-muted">
          Title
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder={CATALOG_DEFAULT_TITLE}
            maxLength={80}
            className={field}
            aria-label="PDF title"
          />
        </label>

        <div className="space-y-2">
          <p className="text-[0.8rem] text-muted">Folders to list</p>
          {draft.shelves.length ? (
            <ul className="space-y-2">
              {draft.shelves.map((s, i) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2"
                  data-testid="catalog-shelf"
                >
                  <input
                    value={s.name}
                    onChange={(e) => setShelf(i, { name: e.target.value })}
                    maxLength={60}
                    className={cx(field, "w-40 flex-none")}
                    aria-label="Name in the PDF"
                  />
                  <select
                    value={s.kind}
                    onChange={(e) =>
                      setShelf(i, { kind: e.target.value as CatalogShelfSetting["kind"] })
                    }
                    className={field}
                    aria-label={`What ${s.name} holds`}
                  >
                    <option value="movies">Movies (one per folder)</option>
                    <option value="shows">Shows (one per folder)</option>
                    <option value="audiobooks">Audiobooks (by author)</option>
                    <option value="ebooks">Ebooks and comics (by author)</option>
                  </select>
                  <span
                    className="min-w-0 flex-1 truncate text-[0.78rem] text-faint"
                    title={where(roots, s)}
                  >
                    {where(roots, s)}
                  </span>
                  <button
                    type="button"
                    className={btn}
                    onClick={() =>
                      setDraft({ ...draft, shelves: draft.shelves.filter((_, j) => j !== i) })
                    }
                    aria-label={`Remove ${s.name}`}
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[0.84rem] text-faint">
              No folders yet. Add your movie, show, stand-up, cartoon, audiobook, or ebook folders.
            </p>
          )}
          {picking ? (
            <FolderPicker
              roots={roots}
              onCancel={() => setPicking(false)}
              onPick={(p) => {
                setPicking(false);
                setDraft({
                  ...draft,
                  shelves: [
                    ...draft.shelves,
                    {
                      id: `shelf-${Date.now().toString(36)}`,
                      name: p.name.slice(0, 60) || "Folder",
                      rootId: p.rootId,
                      path: p.path,
                      kind: guessShelfKind(p.name),
                    },
                  ],
                });
              }}
            />
          ) : (
            draft.shelves.length < MAX_CATALOG_SHELVES && (
              <button
                type="button"
                className={btn}
                onClick={() => setPicking(true)}
                disabled={!roots.length}
                data-testid="catalog-add-folder"
              >
                <FolderPlus className="h-4 w-4" aria-hidden /> Add a folder
              </button>
            )
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Button
            onClick={() => {
              setError(undefined);
              make.mutate();
            }}
            disabled={status.running || make.isPending || !draft.shelves.length}
            data-testid="catalog-make"
          >
            {status.running ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <FileText className="h-4 w-4" aria-hidden />
            )}
            {status.running ? "Making the PDF…" : "Make PDF"}
          </Button>
          {dirty && !status.running && (
            <button
              type="button"
              className={btn}
              onClick={() => save.mutate(draft)}
              disabled={save.isPending}
              data-testid="catalog-save"
            >
              Save folders
            </button>
          )}
          <span
            className="text-[0.8rem] text-muted"
            data-testid="catalog-status"
            aria-live="polite"
          >
            {status.running
              ? `Reading ${status.shelf ?? "folders"}… ${(status.folders ?? 0).toLocaleString()} folders read`
              : ""}
          </span>
        </div>
        {(error || status.error || save.error) && (
          <p className="text-[0.82rem] text-amber" data-testid="catalog-error">
            {error ?? status.error ?? save.error?.message}
          </p>
        )}
      </section>

      <section className="space-y-1">
        <h3 className="text-[0.95rem] text-ink">Your PDFs</h3>
        {q.data.files.length ? (
          <ul className="divide-y divide-line">
            {q.data.files.map((f) => (
              <SavedPdf key={f.id} f={f} onDelete={() => remove.mutate(f.id)} />
            ))}
          </ul>
        ) : (
          <p className="text-[0.84rem] text-faint">None yet. Make PDF puts the first one here.</p>
        )}
      </section>
    </div>
  );
}
