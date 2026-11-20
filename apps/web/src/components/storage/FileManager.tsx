import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Copy,
  Download,
  File,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  HardDrive,
  RefreshCw,
  Ruler,
  Search,
  X,
} from "lucide-react";
import type { FileEntry, FolderListing, ItemProperties } from "@dragon-control/core";
import { api } from "../../data/api";
import { onPc, useStoragePc } from "./pc";
import { ago, bytes, exactBytes, fullDateTime } from "../../lib/format";
import { Button, cx } from "../ui";
import { ChangeCard, useConfirmedChange } from "../dashboards/ConfirmedChange";

/**
 * The Storage & Files file manager (spec section 6): start at a drive on this machine (or a
 * folder you watch), then navigate anywhere inside it: back, forward, up, breadcrumbs, sort by
 * any column, filter, search below the current folder, folder sizes on demand, and a details
 * drawer with a preview (text and images), download, and copy path. Browsing is read only;
 * creating a folder, renaming, moving, and copying are plans you confirm (file-manage), which
 * never delete or replace anything and leave folders the download and library apps manage to
 * those apps. Secrets and Hearth's own keys are never listed; settings files are never opened.
 */

export interface FileRootInfo {
  id: string;
  label: string;
  path: string;
  hostId: string;
  kind: "drive" | "watched" | "sample";
}
export interface FileTarget {
  rootId: string;
  folder: string;
  highlight?: string;
}

type Listing = FolderListing & { hidden: number };
type SortKey = "name" | "size" | "modified" | "type";

const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
const VIDEO = /\.(mkv|mp4|m4v|avi|mov|wmv|ts|webm)$/i;
const IMAGE = /\.(jpe?g|png|gif|webp|bmp)$/i;
const TEXT = /\.(txt|log|nfo|srt|ass|ssa|vtt|md|csv|tsv|sub)$/i;

function typeOf(e: FileEntry): string {
  if (e.kind === "folder") return "Folder";
  const ext = e.name.includes(".") ? e.name.split(".").pop()!.toUpperCase() : "";
  if (VIDEO.test(e.name)) return `${ext} video`;
  if (IMAGE.test(e.name)) return `${ext} image`;
  if (TEXT.test(e.name)) return `${ext} file`;
  return ext ? `${ext} file` : "File";
}

function Icon({ e }: { e: FileEntry }) {
  const cls = "h-4 w-4 shrink-0";
  if (e.kind === "folder") return <Folder className={cx(cls, "text-gold")} aria-hidden />;
  if (VIDEO.test(e.name)) return <FileVideo className={cx(cls, "text-rose-400")} aria-hidden />;
  if (IMAGE.test(e.name)) return <FileImage className={cx(cls, "text-live")} aria-hidden />;
  if (TEXT.test(e.name)) return <FileText className={cx(cls, "text-muted")} aria-hidden />;
  return <File className={cx(cls, "text-muted")} aria-hidden />;
}

const toolBtn =
  "grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-line text-muted hover:border-gold/50 hover:text-ink disabled:opacity-40 disabled:hover:border-line disabled:hover:text-muted";

export function FileManager({
  roots,
  hostName,
  target,
  compact,
  onOpenFull,
}: {
  roots: FileRootInfo[];
  hostName?: string;
  target?: FileTarget;
  /** The Overview's version: the first rows, and a way to the full manager. */
  compact?: boolean;
  onOpenFull?: (t: FileTarget) => void;
}) {
  const first = roots[0];
  const [loc, setLoc] = useState<{ rootId: string; folder: string }>(() => ({
    rootId: target?.rootId ?? first?.id ?? "",
    folder: target?.folder ?? "",
  }));
  const [highlight, setHighlight] = useState(target?.highlight);
  const [back, setBack] = useState<{ rootId: string; folder: string }[]>([]);
  const [forward, setForward] = useState<{ rootId: string; folder: string }[]>([]);
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "name", desc: false });
  const [selected, setSelected] = useState<FileEntry>();
  const [show, setShow] = useState(200);

  // Open in folder from elsewhere in the panel lands here (adjusted while rendering, not in an
  // effect, so there is no extra render pass).
  const [seenTarget, setSeenTarget] = useState(target);
  if (target !== seenTarget) {
    setSeenTarget(target);
    if (target) {
      setLoc({ rootId: target.rootId, folder: target.folder });
      setHighlight(target.highlight);
    }
  }

  const root = roots.find((r) => r.id === loc.rootId) ?? first;
  // Another PC's files are read through this Hearth; changes to them are made on that PC.
  const pc = useStoragePc();
  const list = useQuery({
    queryKey: ["files", "list", root?.id, loc.folder, pc],
    queryFn: () =>
      api<Listing>("GET", onPc(pc, `/api/files/list?${q({ root: root!.id, path: loc.folder })}`)),
    enabled: Boolean(root),
    retry: false,
  });
  const found = useQuery({
    queryKey: ["files", "search", root?.id, loc.folder, search, pc],
    queryFn: () =>
      api<{ results: (FileEntry & { folder: string })[]; complete: boolean; scanned: number }>(
        "GET",
        onPc(pc, `/api/files/search?${q({ root: root!.id, path: loc.folder, q: search })}`),
      ),
    enabled: Boolean(root) && search.trim().length > 1,
    retry: false,
  });

  const go = (next: { rootId: string; folder: string }, keepHighlight?: string) => {
    if (next.rootId === loc.rootId && next.folder === loc.folder) return;
    setBack((b) => [...b, loc]);
    setForward([]);
    setLoc(next);
    setHighlight(keepHighlight);
    setSelected(undefined);
    setFilter("");
    setSearch("");
    setShow(200);
  };
  const up = () => {
    const parts = loc.folder.split("/").filter(Boolean);
    if (parts.length) go({ rootId: loc.rootId, folder: parts.slice(0, -1).join("/") });
  };

  const entries = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const all = (list.data?.entries ?? []).filter((e) => !f || e.name.toLowerCase().includes(f));
    const dir = sort.desc ? -1 : 1;
    const by = (a: FileEntry, b: FileEntry) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      if (sort.key === "size") return ((a.sizeBytes ?? -1) - (b.sizeBytes ?? -1)) * dir;
      if (sort.key === "modified")
        return (a.modifiedAt ?? "").localeCompare(b.modifiedAt ?? "") * dir;
      if (sort.key === "type") return typeOf(a).localeCompare(typeOf(b)) * dir;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) * dir;
    };
    return [...all].sort(by);
  }, [list.data, filter, sort]);

  if (!roots.length)
    return (
      <p className="text-[0.86rem] text-muted">
        Hearth has not found any drives on this machine yet.
      </p>
    );

  const header = (key: SortKey, label: string, cls?: string) => (
    <button
      type="button"
      onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" }))}
      className={cx("text-left hover:text-ink", cls, sort.key === key && "text-ink")}
      aria-label={`Sort by ${label}`}
    >
      {label}
      {sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
    </button>
  );
  const rows = compact ? entries.slice(0, 8) : entries.slice(0, show);
  const crumbs = list.data?.breadcrumbs ?? [{ name: root?.label ?? "", path: "" }];
  const shownPath = list.data?.displayPath ?? root?.path ?? "";

  return (
    <div className="space-y-2" data-testid="file-manager">
      {/* Drives and watched folders */}
      {!compact && roots.length > 1 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Drives">
          {roots.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => go({ rootId: r.id, folder: "" })}
              aria-pressed={r.id === root?.id}
              className={cx(
                "inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-[0.8rem]",
                r.id === root?.id
                  ? "border-gold bg-gold/10 text-gold"
                  : "border-line text-muted hover:text-ink",
              )}
            >
              <HardDrive className="h-3.5 w-3.5" aria-hidden /> {r.label}
            </button>
          ))}
        </div>
      )}

      {/* Toolbar: history, breadcrumbs, search, tools */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className={toolBtn}
          aria-label="Back"
          disabled={!back.length}
          onClick={() => {
            const prev = back.at(-1)!;
            setBack((b) => b.slice(0, -1));
            setForward((f) => [loc, ...f]);
            setLoc(prev);
            setSelected(undefined);
          }}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={toolBtn}
          aria-label="Forward"
          disabled={!forward.length}
          onClick={() => {
            const next = forward[0]!;
            setForward((f) => f.slice(1));
            setBack((b) => [...b, loc]);
            setLoc(next);
            setSelected(undefined);
          }}
        >
          <ArrowRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={toolBtn}
          aria-label="Up one folder"
          disabled={!loc.folder}
          onClick={up}
        >
          <ArrowUp className="h-4 w-4" />
        </button>
        <nav
          aria-label="Folder path"
          className="flex min-h-10 min-w-0 flex-1 flex-wrap items-center gap-1 rounded-lg border border-line bg-raised/60 px-3 text-[0.84rem]"
        >
          {hostName && (
            <>
              <span className="text-muted">{hostName}</span>
              <ChevronRight className="h-3.5 w-3.5 text-faint" aria-hidden />
            </>
          )}
          {crumbs.map((b, i) => (
            <span key={b.path} className="inline-flex min-w-0 items-center gap-1">
              {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-faint" aria-hidden />}
              <button
                type="button"
                className={cx(
                  "truncate hover:text-gold",
                  i === crumbs.length - 1 ? "text-ink" : "text-muted",
                )}
                onClick={() => go({ rootId: loc.rootId, folder: b.path })}
              >
                {b.name}
              </button>
            </span>
          ))}
        </nav>
        {!compact && (
          <>
            <button
              type="button"
              className={toolBtn}
              aria-label="Refresh"
              onClick={() => void list.refetch()}
            >
              <RefreshCw className={cx("h-4 w-4", list.isFetching && "animate-spin")} />
            </button>
            <button
              type="button"
              className={toolBtn}
              aria-label="Copy this folder's path"
              title="Copy path"
              onClick={() => void navigator.clipboard?.writeText(shownPath)}
            >
              <Copy className="h-4 w-4" />
            </button>
          </>
        )}
        {compact && onOpenFull && (
          <button
            type="button"
            className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-line-strong px-3 text-[0.78rem] text-ink hover:border-gold hover:text-gold"
            onClick={() => onOpenFull({ rootId: loc.rootId, folder: loc.folder })}
          >
            Open full <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>

      {!compact && (
        <div className="grid gap-2 @md:grid-cols-2">
          <label className="flex min-h-10 items-center gap-2 rounded-lg border border-line bg-raised px-3">
            <span className="sr-only">Filter this folder</span>
            <span className="text-[0.76rem] text-faint">Filter</span>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Names in this folder"
              className="min-w-0 flex-1 bg-transparent text-[0.86rem] text-ink outline-none"
            />
          </label>
          <form
            className="flex min-h-10 items-center gap-2 rounded-lg border border-line bg-raised px-3"
            onSubmit={(e) => {
              e.preventDefault();
              const v = new FormData(e.currentTarget).get("q");
              setSearch(String(v ?? "").trim());
            }}
          >
            <Search className="h-4 w-4 text-faint" aria-hidden />
            <input
              name="q"
              aria-label="Search this folder and everything below"
              placeholder="Search here and below"
              className="min-w-0 flex-1 bg-transparent text-[0.86rem] text-ink outline-none"
            />
            {search && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setSearch("")}
                className="text-muted hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </form>
        </div>
      )}

      {search ? (
        <SearchResults
          query={search}
          state={found}
          onOpen={(r) =>
            r.kind === "folder"
              ? go({ rootId: loc.rootId, folder: r.path })
              : go({ rootId: loc.rootId, folder: r.folder }, r.name)
          }
        />
      ) : list.isLoading ? (
        <div className="h-40 animate-pulse rounded-lg bg-raised/50" />
      ) : list.error || !list.data ? (
        <p
          className="rounded-lg border border-amber/40 p-3 text-[0.84rem] text-amber"
          data-testid="file-manager-error"
        >
          {list.error?.message ?? "This folder could not be read."}
        </p>
      ) : (
        <div
          className={cx(
            "grid gap-3",
            selected && !compact && "@3xl:grid-cols-[minmax(0,1fr)_20rem]",
          )}
        >
          <div className="min-w-0">
            <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] gap-3 border-b border-line px-2 pb-1.5 text-[0.74rem] text-faint @lg:grid-cols-[minmax(0,1fr)_6rem_8rem_8rem]">
              {header("name", "Name")}
              {header("size", "Size", "text-right @lg:text-left")}
              {header("modified", "Modified", "hidden @lg:block")}
              {header("type", "Type", "hidden @lg:block")}
            </div>
            <ul className="divide-y divide-line/60" data-testid="file-manager-rows">
              {rows.map((e) => (
                <li key={e.path}>
                  <button
                    type="button"
                    data-testid="file-row"
                    data-highlight={highlight === e.name ? "true" : undefined}
                    onClick={() =>
                      e.kind === "folder"
                        ? go({ rootId: loc.rootId, folder: e.path })
                        : setSelected(e)
                    }
                    className={cx(
                      "grid w-full grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-3 rounded-md px-2 py-1.5 text-left text-[0.84rem] hover:bg-raised/60 @lg:grid-cols-[minmax(0,1fr)_6rem_8rem_8rem]",
                      highlight === e.name && "bg-gold/10 ring-1 ring-gold/50",
                      selected?.path === e.path && "bg-raised",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Icon e={e} />
                      <span className="truncate text-ink">{e.name}</span>
                    </span>
                    <span className="text-right text-muted tabular @lg:text-left">
                      {e.sizeBytes !== undefined
                        ? bytes(e.sizeBytes)
                        : e.kind === "folder"
                          ? "-"
                          : ""}
                    </span>
                    <span className="hidden text-muted @lg:block">
                      {e.modifiedAt ? ago(e.modifiedAt) : ""}
                    </span>
                    <span className="hidden truncate text-muted @lg:block">{typeOf(e)}</span>
                  </button>
                </li>
              ))}
              {!rows.length && (
                <li className="px-2 py-3 text-[0.84rem] text-muted">
                  {filter ? "Nothing here matches." : "This folder is empty."}
                </li>
              )}
            </ul>
            {!compact && entries.length > show && (
              <button
                type="button"
                className="mt-2 text-[0.8rem] text-gold hover:underline"
                onClick={() => setShow((n) => n + 200)}
              >
                Show {Math.min(200, entries.length - show)} more of {entries.length}
              </button>
            )}
            {compact && entries.length > rows.length && onOpenFull && (
              <button
                type="button"
                className="mt-1 text-[0.8rem] text-gold hover:underline"
                onClick={() => onOpenFull({ rootId: loc.rootId, folder: loc.folder })}
              >
                {entries.length - rows.length} more in this folder
              </button>
            )}
            <p className="mt-2 text-[0.74rem] text-faint">
              {list.data.displayPath} · {list.data.totals.folders} folders, {list.data.totals.files}{" "}
              files, {bytes(list.data.totals.fileBytes)} in files here
              {list.data.hidden ? ` · ${list.data.hidden} hidden (secrets)` : ""}
              {list.data.truncated ? " · very large folder: first 5,000 shown" : ""}
              {!compact && !pc && roots.find((r) => r.id === loc.rootId)?.kind !== "sample" && (
                <>
                  {" · "}
                  <NewFolder
                    key={`${loc.rootId}/${loc.folder}`}
                    rootId={loc.rootId}
                    folder={loc.folder}
                  />
                </>
              )}
            </p>
          </div>
          {selected && !compact && (
            <Details
              rootId={loc.rootId}
              entry={selected}
              roots={roots}
              onClose={() => setSelected(undefined)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function SearchResults({
  query,
  state,
  onOpen,
}: {
  query: string;
  state: {
    isLoading: boolean;
    error: Error | null;
    data?: { results: (FileEntry & { folder: string })[]; complete: boolean; scanned: number };
  };
  onOpen: (r: FileEntry & { folder: string }) => void;
}) {
  if (state.isLoading) return <div className="h-32 animate-pulse rounded-lg bg-raised/50" />;
  if (state.error) return <p className="text-[0.84rem] text-amber">{state.error.message}</p>;
  const d = state.data;
  if (!d) return null;
  return (
    <div data-testid="file-search">
      <ul className="divide-y divide-line/60">
        {d.results.map((r) => (
          <li key={r.path}>
            <button
              type="button"
              onClick={() => onOpen(r)}
              className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-1.5 text-left text-[0.84rem] hover:bg-raised/60"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Icon e={r} />
                <span className="min-w-0">
                  <span className="block truncate text-ink">{r.name}</span>
                  <span className="block truncate text-[0.74rem] text-faint">
                    {r.folder || "/"}
                  </span>
                </span>
              </span>
              <span className="text-muted tabular">
                {r.sizeBytes !== undefined ? bytes(r.sizeBytes) : ""}
              </span>
            </button>
          </li>
        ))}
        {!d.results.length && (
          <li className="px-2 py-3 text-[0.84rem] text-muted">
            Nothing named like "{query}" here or below.
          </li>
        )}
      </ul>
      <p className="mt-2 text-[0.74rem] text-faint">
        {d.scanned.toLocaleString()} items looked at
        {d.complete
          ? ""
          : ", stopped early to spare the drives (search a deeper folder to go further)"}
        .
      </p>
    </div>
  );
}

/** A change to files: planned, shown for you to confirm, then the folder is read again. */
function useFileChange() {
  const c = useConfirmedChange("this-host");
  const qc = useQueryClient();
  const status = c.job?.status;
  useEffect(() => {
    if (status === "succeeded") void qc.invalidateQueries({ queryKey: ["files"] });
  }, [status, qc]);
  return c;
}

const FIELD =
  "min-h-9 min-w-0 flex-1 rounded-lg border border-line-strong bg-raised px-2 text-[0.8rem] text-ink";

/** Rename, move, or copy the selected item: each asks you to confirm before anything changes. */
function ItemChanges({
  rootId,
  entry,
  roots,
}: {
  rootId: string;
  entry: FileEntry;
  roots: FileRootInfo[];
}) {
  const c = useFileChange();
  const folder = entry.path.split("/").slice(0, -1).join("/");
  const [mode, setMode] = useState<"rename" | "move" | "copy">("rename");
  const [name, setName] = useState(entry.name);
  const [to, setTo] = useState(folder);
  const [toRoot, setToRoot] = useState(rootId);
  const usable = roots.filter((r) => r.kind !== "sample");
  const propose = () => {
    if (mode === "rename")
      void c.propose(
        "file-manage",
        { op: "rename", root: rootId, path: entry.path, name },
        `Rename ${entry.name}`,
      );
    else
      void c.propose(
        "file-manage",
        {
          op: mode,
          root: rootId,
          path: entry.path,
          to,
          ...(mode === "copy" && toRoot !== rootId ? { toRoot } : {}),
        },
        `${mode === "move" ? "Move" : "Copy"} ${entry.name}`,
      );
  };
  return (
    <details className="rounded-lg border border-line p-2" data-testid="file-changes">
      <summary className="cursor-pointer text-[0.78rem] text-muted">
        Rename, move, or copy (asks you first)
      </summary>
      <div className="mt-2 space-y-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Change">
          {(["rename", "move", "copy"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={cx(
                "min-h-8 rounded-md border px-2 text-[0.76rem]",
                mode === m ? "border-gold text-gold" : "border-line text-muted",
              )}
            >
              {m === "rename" ? "Rename" : m === "move" ? "Move" : "Copy"}
            </button>
          ))}
        </div>
        <form
          className="flex flex-wrap gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            propose();
          }}
        >
          {mode === "rename" ? (
            <input
              className={FIELD}
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="New name"
              data-testid="file-change-name"
            />
          ) : (
            <>
              {mode === "copy" && usable.length > 1 && (
                <select
                  className={FIELD}
                  value={toRoot}
                  onChange={(e) => setToRoot(e.target.value)}
                  aria-label="To drive"
                >
                  {usable.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              )}
              <input
                className={FIELD}
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="Folder on the drive"
                aria-label="To folder"
                data-testid="file-change-to"
              />
            </>
          )}
          <Button tone="outline" type="submit" disabled={c.busy} data-testid="file-change-plan">
            Review
          </Button>
        </form>
        <p className="text-[0.72rem] text-faint">
          Nothing is deleted or replaced. Folders Radarr, Sonarr, or a download client manage are
          changed in those apps instead. A move to another drive is offered as a copy.
        </p>
        <ChangeCard c={c} />
      </div>
    </details>
  );
}

/** A new folder inside the one you are in. */
function NewFolder({ rootId, folder }: { rootId: string; folder: string }) {
  const c = useFileChange();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  if (!open)
    return (
      <button
        type="button"
        className="text-gold hover:underline"
        onClick={() => setOpen(true)}
        data-testid="file-new-folder"
      >
        New folder here
      </button>
    );
  return (
    <span className="mt-1 block space-y-1.5" data-testid="file-new-folder-box">
      <form
        className="flex flex-wrap gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void c.propose(
            "file-manage",
            { op: "mkdir", root: rootId, path: folder, name: name.trim() },
            "New folder",
          );
        }}
      >
        <input
          className={FIELD}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Folder name"
          aria-label="New folder name"
          autoFocus
          data-testid="file-new-folder-name"
        />
        <Button tone="outline" type="submit" disabled={c.busy || !name.trim()}>
          Review
        </Button>
        <Button tone="quiet" type="button" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </form>
      <ChangeCard c={c} />
    </span>
  );
}

function Details({
  rootId,
  entry,
  onClose,
  roots,
}: {
  rootId: string;
  entry: FileEntry;
  onClose: () => void;
  roots: FileRootInfo[];
}) {
  const pc = useStoragePc();
  const props = useQuery({
    queryKey: ["files", "properties", rootId, entry.path, pc],
    queryFn: () =>
      api<ItemProperties>(
        "GET",
        onPc(pc, `/api/files/properties?${q({ root: rootId, path: entry.path })}`),
      ),
    retry: false,
  });
  const preview = useQuery({
    queryKey: ["files", "preview", rootId, entry.path, pc],
    queryFn: () =>
      api<
        | { kind: "text"; text: string; truncated: boolean }
        | { kind: "image" }
        | { kind: "none"; why: string }
      >("GET", onPc(pc, `/api/files/preview?${q({ root: rootId, path: entry.path })}`)),
    retry: false,
  });
  const p = props.data;
  const open = onPc(pc, `/api/files/open?${q({ root: rootId, path: entry.path })}`);
  return (
    <aside
      className="space-y-3 rounded-xl border border-line bg-bg/60 p-3 text-[0.82rem]"
      data-testid="file-details"
      aria-label="File details"
    >
      <div className="flex items-start gap-2">
        <Icon e={entry} />
        <p className="min-w-0 flex-1 break-all text-ink">{entry.name}</p>
        <button
          type="button"
          aria-label="Close details"
          onClick={onClose}
          className="text-muted hover:text-ink"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {preview.data?.kind === "image" && (
        <img
          src={`${open}&inline=1`}
          alt={entry.name}
          className="max-h-56 w-full rounded-lg object-contain"
        />
      )}
      {preview.data?.kind === "text" && (
        <pre
          className="max-h-56 overflow-auto rounded-lg bg-raised/70 p-2 text-[0.72rem] whitespace-pre-wrap text-muted"
          data-testid="file-preview"
        >
          {preview.data.text}
          {preview.data.truncated ? "\n…" : ""}
        </pre>
      )}
      {preview.data?.kind === "none" && <p className="text-faint">{preview.data.why}</p>}
      {p && (
        <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1">
          <dt className="text-faint">Size</dt>
          <dd className="text-ink">
            {p.sizeBytes !== undefined
              ? `${bytes(p.sizeBytes)} (${exactBytes(p.sizeBytes)})`
              : "Not known"}
          </dd>
          <dt className="text-faint">Modified</dt>
          <dd className="text-ink">{p.modifiedAt ? fullDateTime(p.modifiedAt) : "Not known"}</dd>
          {p.createdAt && (
            <>
              <dt className="text-faint">Created</dt>
              <dd className="text-ink">{fullDateTime(p.createdAt)}</dd>
            </>
          )}
          <dt className="text-faint">Where</dt>
          <dd className="break-all text-ink">{p.displayPath}</dd>
        </dl>
      )}
      <div className="flex flex-wrap gap-2">
        {preview.data?.kind !== "none" || !/settings/i.test(preview.data.why) ? (
          <a
            href={open}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.78rem] text-ink hover:border-gold hover:text-gold"
            data-testid="file-download"
          >
            <Download className="h-3.5 w-3.5" aria-hidden /> Download
          </a>
        ) : null}
        <button
          type="button"
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.78rem] text-ink hover:border-gold hover:text-gold"
          onClick={() => p && void navigator.clipboard?.writeText(p.displayPath)}
        >
          <Copy className="h-3.5 w-3.5" aria-hidden /> Copy path
        </button>
      </div>
      {!pc && roots.find((r) => r.id === rootId)?.kind !== "sample" && (
        <ItemChanges key={entry.path} rootId={rootId} entry={entry} roots={roots} />
      )}
    </aside>
  );
}

/** A folder's full size, on request (it can take a few seconds on a big drive). */
export function FolderSize({ rootId, path }: { rootId: string; path: string }) {
  const [asked, setAsked] = useState(false);
  const pc = useStoragePc();
  const s = useQuery({
    queryKey: ["files", "properties", rootId, path, pc],
    queryFn: () =>
      api<ItemProperties>("GET", onPc(pc, `/api/files/properties?${q({ root: rootId, path })}`)),
    enabled: asked,
  });
  if (!asked)
    return (
      <button
        type="button"
        onClick={() => setAsked(true)}
        className="inline-flex items-center gap-1 text-[0.78rem] text-gold hover:underline"
      >
        <Ruler className="h-3.5 w-3.5" aria-hidden /> Folder size
      </button>
    );
  if (s.isLoading) return <span className="text-[0.78rem] text-faint">Measuring…</span>;
  return (
    <span className="text-[0.78rem] text-muted">
      {s.data
        ? `${bytes(s.data.sizeBytes)}${s.data.kind === "folder" && !s.data.complete ? " or more" : ""}`
        : ""}
    </span>
  );
}
