import { useState } from "react";
import { Search } from "lucide-react";
import type { AppViewProps } from "../../panels/registry";
import {
  Check,
  Guard,
  LoadError,
  Loading,
  Pager,
  ProposeError,
  SubNav,
  btn,
  btnGold,
  day,
  input,
  usePropose,
} from "../radarr/common";
import { useLidarr } from "./data";

/**
 * Lidarr's Wanted tab (missing albums and albums below their quality cutoff, each with Search, or
 * Search all) and its Import files (files Lidarr found in a folder, each matched to an album's
 * tracks, moved or copied in by Lidarr itself).
 */

type Part = "missing" | "cutoff";

export function LidarrWanted({ serviceId, sub, onSub, onGo }: AppViewProps) {
  const part: Part = sub === "cutoff" ? "cutoff" : "missing";
  const [page, setPage] = useState(1);
  const q = useLidarr(serviceId, part, { page });
  const act = usePropose(serviceId);
  return (
    <div className="space-y-3" data-testid="lidarr-wanted">
      <SubNav
        label="Wanted"
        target="wanted"
        value={part}
        onChange={(p) => {
          setPage(1);
          onSub?.(p === "missing" ? null : p);
        }}
        options={[
          { value: "missing", label: "Missing" },
          { value: "cutoff", label: "Below cutoff" },
        ]}
      />
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <LoadError error={q.error} />
      ) : (
        <Guard meta={q.data.meta} sample={q.data.sample}>
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-auto text-[0.8rem] text-muted">
              {q.data.total} {part === "missing" ? "missing albums" : "albums below their cutoff"}
            </p>
            {q.data.total > 0 && (
              <button
                type="button"
                className={btnGold}
                disabled={!act.can || act.busy}
                data-hearth-target={`wanted:${part}:search-all`}
                onClick={() =>
                  act.propose(
                    "app-arr-command",
                    {
                      command: part === "missing" ? "MissingAlbumSearch" : "CutoffUnmetAlbumSearch",
                    },
                    part === "missing" ? "Search for every missing album" : "Search for upgrades",
                  )
                }
              >
                <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Search all
              </button>
            )}
          </div>
          <ProposeError error={act.error} />
          {act.dialog}
          {q.data.records.length === 0 ? (
            <p className="text-[0.84rem] text-muted">Nothing here.</p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {q.data.records.map((al) => (
                <li
                  key={al.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5"
                  data-testid="lidarr-wanted-album"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => onGo?.("library", al.artistId ? `artist/${al.artistId}` : null)}
                    data-hearth-target={`wanted:album:${al.id}`}
                  >
                    <span className="block truncate text-[0.86rem] text-ink hover:text-gold">
                      {al.artist ? `${al.artist}: ` : ""}
                      {al.title}
                    </span>
                    <span className="block text-[0.74rem] text-faint">
                      {day(al.released)}
                      {al.monitored ? "" : " · not monitored"}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={btn}
                    disabled={!act.can || act.busy}
                    data-hearth-target={`wanted:search:${al.id}`}
                    onClick={() =>
                      act.propose(
                        "app-arr-command",
                        { command: "AlbumSearch", albumIds: String(al.id) },
                        `Search for ${al.title}`,
                      )
                    }
                  >
                    <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Search
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Pager
            page={q.data.page}
            pageSize={q.data.pageSize}
            total={q.data.total}
            onPage={setPage}
          />
        </Guard>
      )}
    </div>
  );
}

export function LidarrImport({ serviceId }: { serviceId: string }) {
  const [text, setText] = useState("/downloads");
  const [folder, setFolder] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [copy, setCopy] = useState(false);
  const q = useLidarr(serviceId, "imports", { folder }, folder.length > 0);
  const act = usePropose(serviceId);
  const files = q.data?.files ?? [];
  const ready = files.filter((f) => f.albumId && f.tracks.length);
  return (
    <div className="space-y-3" data-testid="lidarr-import">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setFolder(text.trim());
          setPicked([]);
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Folder as Lidarr sees it"
          placeholder="A folder as Lidarr sees it"
          className={`${input} min-w-0 flex-1`}
          data-hearth-target="import:folder"
        />
        <button
          type="submit"
          className={btn}
          disabled={!text.trim()}
          data-hearth-target="import:look"
        >
          Look
        </button>
      </form>
      {q.isFetching && <Loading />}
      {q.isError && <LoadError error={q.error} />}
      {folder && q.data && (
        <>
          {files.length === 0 ? (
            <p className="text-[0.84rem] text-muted">Lidarr found nothing to import in {folder}.</p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line text-[0.82rem]">
              {files.map((f) => {
                const ok = Boolean(f.albumId && f.tracks.length);
                return (
                  <li key={f.path} className="space-y-1 px-3 py-2" data-testid="lidarr-import-file">
                    <Check
                      checked={picked.includes(f.path)}
                      onChange={(on) =>
                        setPicked((p) => (on ? [...p, f.path] : p.filter((x) => x !== f.path)))
                      }
                      label={<span className="break-all">{f.name}</span>}
                      target={`import:file:${f.name}`}
                    />
                    <p className={ok ? "text-faint" : "text-amber"}>
                      {ok
                        ? `${f.artist}: ${f.album}, ${f.tracks.map((t) => `${t.number ?? ""} ${t.title}`.trim()).join(", ")}${f.quality ? ` · ${f.quality}` : ""}`
                        : "Lidarr could not match it to an album's tracks; match it in Lidarr itself."}
                      {f.rejections.length ? ` (Lidarr noted: ${f.rejections.join("; ")})` : ""}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
          {ready.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <Check
                checked={copy}
                onChange={setCopy}
                label="Copy (keep the originals)"
                target="import:copy"
              />
              <button
                type="button"
                className={btnGold}
                disabled={!picked.length || !act.can || act.busy}
                data-hearth-target="import:review"
                onClick={() =>
                  act.propose(
                    "app-arr-command",
                    {
                      command: "ManualImport",
                      folder,
                      importMode: copy ? "copy" : "move",
                      files: JSON.stringify(
                        files
                          .filter((f) => picked.includes(f.path))
                          .map((f) => ({
                            path: f.path,
                            albumId: f.albumId,
                            trackIds: f.tracks.map((t) => t.id),
                          })),
                      ),
                    },
                    "Import files into Lidarr",
                  )
                }
              >
                Review import
              </button>
            </div>
          )}
          <ProposeError error={act.error} />
          {act.dialog}
        </>
      )}
    </div>
  );
}
