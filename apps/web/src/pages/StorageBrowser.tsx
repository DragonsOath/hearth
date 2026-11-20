import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { File, FileVideo, Folder, Info, Search, X } from "lucide-react";
import type { FileEntry, ItemProperties } from "@dragon-control/core";
import { BackLink } from "./ServiceDetail";
import { Button, EmptyState, Figure, PageSkeleton, Segmented, cx } from "../components/ui";
import { useBrowse, useItemProperties, useRemoveLocation, useWorkspace } from "../data/api";
import { bytes, dateTime, exactBytes, fullDateTime } from "../lib/format";

type SortKey = "name" | "size" | "modified";

const videoExt = /\.(mkv|mp4|m4v|avi|mov|wmv|ts|webm)$/i;

function sortBy(entries: FileEntry[], key: SortKey): FileEntry[] {
  if (key === "name") return entries; // server order: folders first, natural names
  return [...entries].sort((a, b) =>
    key === "size"
      ? (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1)
      : (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? ""),
  );
}

function PropertiesSheet({
  locationId,
  path,
  onClose,
}: {
  locationId: string;
  path: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { data, error, isFetching } = useItemProperties(locationId, path);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const rows: [string, string][] = data ? propertyRows(data) : [];
  return (
    <dialog
      ref={ref}
      aria-label="Properties"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
      className="fixed inset-x-0 top-auto bottom-0 m-0 max-h-[85vh] w-full max-w-none overflow-y-auto rounded-t-2xl border-t border-line bg-panel p-0 text-ink backdrop:bg-black/70 sm:inset-y-0 sm:right-0 sm:left-auto sm:h-full sm:max-h-none sm:w-[420px] sm:rounded-none sm:border-t-0 sm:border-l"
    >
      <div className="flex items-start justify-between gap-4 px-6 pt-6">
        <div className="min-w-0">
          <p className="eyebrow mb-2">Properties</p>
          <p className="font-display text-[1.6rem] leading-tight break-words text-ink">
            {data?.name ?? path.split("/").pop()}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={() => ref.current?.close()}
          className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center text-muted hover:text-gold"
        >
          <X strokeWidth={1.25} className="h-5 w-5" />
        </button>
      </div>
      <div className="px-6 pt-4 pb-8">
        {isFetching && !data && (
          <p className="py-6 text-[0.88rem] text-muted" aria-busy="true">
            Counting everything inside. Large folders take a moment.
          </p>
        )}
        {error && (
          <p role="alert" className="py-6 text-[0.88rem] text-bad">
            {error.message}
          </p>
        )}
        {data && (
          <>
            <p
              className="mb-6 font-display text-[2.4rem] leading-none text-gold tabular"
              data-testid="properties-size"
            >
              {bytes(data.sizeBytes)}
            </p>
            <dl className="divide-y divide-line">
              {rows.map(([k, v]) => (
                <div key={k} className="flex gap-6 py-3">
                  <dt className="w-24 shrink-0 text-[0.8rem] text-faint">{k}</dt>
                  <dd className="min-w-0 flex-1 text-[0.88rem] break-words text-ink tabular">
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
            {!data.complete && (
              <p className="mt-4 text-[0.8rem] text-warn">
                This folder is very large, so it was only partly counted. The true total is higher.
              </p>
            )}
          </>
        )}
      </div>
    </dialog>
  );
}

function propertyRows(p: ItemProperties): [string, string][] {
  const rows: [string, string][] = [
    [
      "Type",
      p.kind === "folder" ? "Folder" : p.extension ? `${p.extension.toUpperCase()} file` : "File",
    ],
    ["Location", p.displayPath],
    ["Size", `${bytes(p.sizeBytes)} (${exactBytes(p.sizeBytes)})`],
  ];
  if (p.kind === "folder") {
    rows.push([
      "Contains",
      `${(p.files ?? 0).toLocaleString()} files, ${(p.folders ?? 0).toLocaleString()} folders`,
    ]);
  }
  if (p.createdAt) rows.push(["Created", fullDateTime(p.createdAt)]);
  if (p.modifiedAt) rows.push(["Modified", fullDateTime(p.modifiedAt)]);
  if (p.accessedAt) rows.push(["Accessed", fullDateTime(p.accessedAt)]);
  rows.push(["Attributes", p.readOnly ? "Read-only" : "None"]);
  return rows;
}

function EntryRow({
  entry,
  onOpen,
  onProperties,
}: {
  entry: FileEntry;
  onOpen: () => void;
  onProperties: () => void;
}) {
  const Icon = entry.kind === "folder" ? Folder : videoExt.test(entry.name) ? FileVideo : File;
  return (
    <li className="flex items-center gap-1">
      <button
        type="button"
        onClick={onOpen}
        className="group -mx-3 flex min-h-14 min-w-0 flex-1 items-center gap-4 rounded-lg px-3 py-3 text-left transition-colors duration-200 hover:bg-raised/60"
      >
        <Icon
          strokeWidth={1.25}
          className={cx("h-5 w-5 shrink-0", entry.kind === "folder" ? "text-gold" : "text-faint")}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.92rem] text-ink">{entry.name}</span>
          <span className="block text-[0.75rem] text-faint">
            {entry.kind === "folder" && entry.itemCount !== undefined
              ? `${entry.itemCount} ${entry.itemCount === 1 ? "item" : "items"}`
              : entry.modifiedAt
                ? dateTime(entry.modifiedAt)
                : ""}
          </span>
        </span>
        <span
          className="shrink-0 text-right text-[0.88rem] text-ink tabular"
          data-testid="entry-size"
        >
          {bytes(entry.sizeBytes)}
        </span>
      </button>
      {entry.kind === "folder" ? (
        <button
          type="button"
          onClick={onProperties}
          aria-label={`Properties of ${entry.name}`}
          className="flex h-11 w-11 shrink-0 items-center justify-center text-faint hover:text-gold"
        >
          <Info strokeWidth={1.25} className="h-[18px] w-[18px]" />
        </button>
      ) : (
        <span className="w-11 shrink-0" aria-hidden="true" />
      )}
    </li>
  );
}

function StopWatching({ id, label }: { id: string; label: string }) {
  const remove = useRemoveLocation();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="mt-14 border-t border-line pt-6">
      {confirming ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="w-full text-[0.82rem] text-muted">
            Hearth stops watching {label}. The folder and everything in it stay exactly as they are.
          </p>
          <Button
            onClick={() => remove.mutate(id, { onSuccess: () => navigate("/storage") })}
            disabled={remove.isPending}
          >
            Stop watching
          </Button>
          <Button tone="quiet" onClick={() => setConfirming(false)}>
            Keep watching
          </Button>
        </div>
      ) : (
        <Button tone="quiet" className="px-0" onClick={() => setConfirming(true)}>
          Stop watching this folder
        </Button>
      )}
    </div>
  );
}

export function StorageBrowserPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const path = params.get("path") ?? "";
  const { data: ws } = useWorkspace();
  const location = ws?.storageLocations.find((l) => l.id === id);
  const listing = useBrowse(id, path);
  const folderProps = useItemProperties(id, path);
  const [sort, setSort] = useState<SortKey>("name");
  const [filter, setFilter] = useState("");
  const [inspect, setInspect] = useState<string | null>(null);

  const entries = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = listing.data?.entries ?? [];
    return sortBy(q ? list.filter((e) => e.name.toLowerCase().includes(q)) : list, sort);
  }, [listing.data, filter, sort]);

  const go = (next: string) => {
    setFilter("");
    setParams(next ? { path: next } : {});
  };

  if (listing.error) {
    return (
      <>
        <BackLink to="/storage">Storage</BackLink>
        <EmptyState title="Can't show this folder">{listing.error.message}</EmptyState>
      </>
    );
  }
  if (!listing.data) return <PageSkeleton />;
  const data = listing.data;
  const title = data.breadcrumbs.at(-1)?.name ?? location?.label ?? "Folder";

  return (
    <>
      <BackLink to="/storage">Storage</BackLink>

      <nav
        aria-label="Folder path"
        className="mb-3 flex flex-wrap items-center gap-x-1 text-[0.8rem] text-faint"
      >
        {data.breadcrumbs.map((b, i) => (
          <span key={b.path} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden="true">/</span>}
            {i < data.breadcrumbs.length - 1 ? (
              <Link
                to={b.path ? `?path=${encodeURIComponent(b.path)}` : "?"}
                onClick={() => setFilter("")}
                className="underline decoration-line-strong underline-offset-4 hover:text-gold"
              >
                {b.name}
              </Link>
            ) : (
              <span className="text-muted">{b.name}</span>
            )}
          </span>
        ))}
      </nav>
      <h1 className="font-display text-[2.4rem] leading-[1.05] break-words text-ink sm:text-[3rem]">
        {title}
      </h1>
      <p className="mt-2 text-[0.82rem] break-all text-faint tabular">{data.displayPath}</p>

      <div className="mt-10 mb-10 grid grid-cols-3 gap-6">
        <Figure
          value={folderProps.data ? bytes(folderProps.data.sizeBytes) : "…"}
          label={folderProps.data && !folderProps.data.complete ? "At least, so far" : "Total size"}
        />
        <Figure
          value={(folderProps.data?.files ?? data.totals.files).toLocaleString()}
          label="Files"
        />
        <Figure
          value={(folderProps.data?.folders ?? data.totals.folders).toLocaleString()}
          label="Folders"
        />
      </div>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <Segmented
          label="Sort by"
          value={sort}
          onChange={setSort}
          options={[
            { value: "name", label: "Name" },
            { value: "size", label: "Largest" },
            { value: "modified", label: "Newest" },
          ]}
        />
        <label className="flex min-h-11 items-center gap-2 rounded-full border border-line px-4 focus-within:border-gold/50 sm:w-64">
          <Search strokeWidth={1.25} className="h-4 w-4 text-faint" />
          <span className="sr-only">Filter this folder</span>
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter"
            className="w-full bg-transparent text-[0.85rem] text-ink placeholder:text-faint focus:outline-none"
          />
        </label>
      </div>

      {entries.length === 0 ? (
        <EmptyState title={filter ? "No matches" : "This folder is empty"} />
      ) : (
        <ul className="divide-y divide-line" aria-label="Folder contents">
          {entries.map((e) => (
            <EntryRow
              key={e.path}
              entry={e}
              onOpen={() => (e.kind === "folder" ? go(e.path) : setInspect(e.path))}
              onProperties={() => setInspect(e.path)}
            />
          ))}
        </ul>
      )}
      {data.truncated && (
        <p className="mt-4 text-[0.8rem] text-faint">
          Showing the first {data.entries.length.toLocaleString()} items in this folder.
        </p>
      )}

      {location?.source === "fs" && path === "" && <StopWatching id={id} label={location.label} />}
      {inspect !== null && (
        <PropertiesSheet locationId={id} path={inspect} onClose={() => setInspect(null)} />
      )}
    </>
  );
}
