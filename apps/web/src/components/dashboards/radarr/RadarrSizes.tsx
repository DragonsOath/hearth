import { useState } from "react";
import { FolderInput, Plus, Search, Trash2 } from "lucide-react";
import { cx } from "../../ui";
import { useServarr, useRadarr, type SizesView } from "./data";
import {
  Guard,
  LoadError,
  Loading,
  Pager,
  ProposeError,
  btn,
  btnBad,
  btnGold,
  input,
  inputAuto,
  usePropose,
} from "./common";

/**
 * Three smaller Radarr areas (checklist 46.9l): quality sizes (Settings), import list exclusions
 * (Settings) and importing files Radarr found in a folder (Activity). Each change is a plan for
 * approval, the same step Ember uses.
 */

/* ---------- Quality sizes ---------- */

type Row = SizesView["sizes"][number];
type Draft = { minSize: string; preferredSize: string; maxSize: string };
const asText = (v: number | null) => (v === null ? "" : String(v));
const asValue = (t: string) => (t.trim() === "" ? null : Number(t));

export function QualitySizes({ serviceId }: { serviceId: string }) {
  const q = useRadarr(serviceId, "sizes");
  if (q.isPending) return <Loading />;
  if (q.isError) return <LoadError error={q.error} />;
  return (
    <Guard meta={q.data.meta} sample={q.data.sample}>
      <SizesTable serviceId={serviceId} d={q.data} />
    </Guard>
  );
}

function SizesTable({ serviceId, d }: { serviceId: string; d: SizesView }) {
  const act = usePropose(serviceId);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const draftOf = (r: Row): Draft =>
    drafts[r.id] ?? {
      minSize: asText(r.minSize),
      preferredSize: asText(r.preferredSize),
      maxSize: asText(r.maxSize),
    };
  const changed = d.sizes.filter((r) => {
    const x = drafts[r.id];
    return (
      x &&
      (asValue(x.minSize) !== r.minSize ||
        asValue(x.preferredSize) !== r.preferredSize ||
        asValue(x.maxSize) !== r.maxSize)
    );
  });
  const bad = (x: Draft) => {
    const nums = [x.minSize, x.preferredSize, x.maxSize].map(asValue);
    if (x.minSize.trim() === "") return true;
    if (
      nums.some((n) => n !== null && (!Number.isFinite(n) || n < d.limits.min || n > d.limits.max))
    )
      return true;
    const [min, pref, max] = [nums[0]!, nums[1] ?? nums[2] ?? Infinity, nums[2] ?? Infinity];
    return min > pref || pref > max;
  };
  const review = () => {
    const steps = changed.map((r) => {
      const x = draftOf(r);
      const changes: Record<string, number | null> = {};
      if (asValue(x.minSize) !== r.minSize) changes.minSize = asValue(x.minSize);
      if (asValue(x.preferredSize) !== r.preferredSize)
        changes.preferredSize = asValue(x.preferredSize);
      if (asValue(x.maxSize) !== r.maxSize) changes.maxSize = asValue(x.maxSize);
      return {
        kind: "app-arr-edit" as const,
        params: { resource: "qualitydefinition", id: r.id, changes: JSON.stringify(changes) },
      };
    });
    act.proposeMany(
      steps,
      changed.length === 1
        ? `Change the size limits for ${changed[0]!.title}`
        : `Change size limits for ${changed.length} qualities`,
    );
  };
  return (
    <div className="space-y-2" data-testid="radarr-sizes">
      <p className="text-[0.8rem] text-muted">
        How big a release may be for each quality, in MB per minute of video (2 hours at 50 MB per
        minute is about 6 GB). Leave Preferred or Maximum empty for no limit.
      </p>
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full sm:min-w-[30rem] text-[0.8rem]">
          <thead className="text-left text-faint">
            <tr>
              <th className="px-3 py-2 font-normal">Quality</th>
              <th className="px-2 py-2 font-normal">Minimum</th>
              <th className="px-2 py-2 font-normal">Preferred</th>
              <th className="px-2 py-2 font-normal">Maximum</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {d.sizes.map((r) => {
              const x = draftOf(r);
              const wrong = bad(x);
              const cell = (k: keyof Draft, label: string) => (
                <td className="px-2 py-1">
                  <input
                    aria-label={`${r.title}: ${label} (MB per minute)`}
                    inputMode="decimal"
                    value={x[k]}
                    placeholder={k === "minSize" ? "0" : "No limit"}
                    onChange={(e) =>
                      setDrafts((all) => ({ ...all, [r.id]: { ...x, [k]: e.target.value } }))
                    }
                    className={cx(inputAuto, "w-24", wrong && "border-alert/60")}
                    data-hearth-target={`size:${r.id}:${k}`}
                  />
                </td>
              );
              return (
                <tr key={r.id} data-testid="radarr-size">
                  <td className="px-3 py-1 text-ink">{r.title}</td>
                  {cell("minSize", "Minimum")}
                  {cell("preferredSize", "Preferred")}
                  {cell("maxSize", "Maximum")}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={btnGold}
          disabled={
            !act.can || act.busy || changed.length === 0 || changed.some((r) => bad(draftOf(r)))
          }
          onClick={review}
          data-hearth-target="sizes:review"
        >
          Review{" "}
          {changed.length
            ? `${changed.length} change${changed.length === 1 ? "" : "s"}`
            : "changes"}
        </button>
        {changed.length > 0 && (
          <button type="button" className={btn} onClick={() => setDrafts({})}>
            Undo edits
          </button>
        )}
        <span className="text-[0.74rem] text-faint">
          Allowed: {d.limits.min} to {d.limits.max}; minimum, then preferred, then maximum.
        </span>
      </div>
      <ProposeError error={act.error} />
      {act.dialog}
    </div>
  );
}

/* ---------- Import list exclusions ---------- */

export function Exclusions({ serviceId }: { serviceId: string }) {
  const w = useServarr();
  const [page, setPage] = useState(1);
  const q = useRadarr(serviceId, "exclusions", { page });
  const act = usePropose(serviceId);
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  const look = useRadarr(serviceId, "lookup", { title: term }, term.length > 0);
  if (q.isPending) return <Loading />;
  if (q.isError) return <LoadError error={q.error} />;
  const excluded = new Set(q.data.records.map((r) => r.key));
  return (
    <Guard meta={q.data.meta} sample={q.data.sample}>
      <div className="space-y-3" data-testid="radarr-exclusions">
        <p className="text-[0.8rem] text-muted">
          {w.items[0]!.toUpperCase() + w.items.slice(1)} your import lists will never add, even when
          a list includes them.
        </p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setTerm(text.trim());
          }}
        >
          <label className="sr-only" htmlFor={`ex-q-${serviceId}`}>
            Movie to exclude
          </label>
          <input
            id={`ex-q-${serviceId}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Find a ${w.item} to exclude`}
            className={cx(input, "flex-1")}
            data-hearth-target="exclusions:search"
          />
          <button type="submit" className={btn} disabled={!text.trim()}>
            <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Find
          </button>
        </form>
        {look.data && term && (
          <ul className="divide-y divide-line rounded-xl border border-line text-[0.82rem]">
            {look.data.results.length === 0 && (
              <li className="px-3 py-2 text-muted">
                {w.name} found nothing for &ldquo;{term}&rdquo;.
              </li>
            )}
            {look.data.results.slice(0, 8).map((r) => (
              <li
                key={r.key}
                className="flex items-center gap-2 px-3 py-2"
                data-testid="radarr-exclude-pick"
              >
                <span className="min-w-0 flex-1 text-ink">
                  {r.title} <span className="text-faint">{r.year}</span>
                </span>
                {excluded.has(r.key) ? (
                  <span className="text-faint">Excluded</span>
                ) : (
                  <button
                    type="button"
                    className={btnGold}
                    disabled={!act.can || act.busy}
                    data-hearth-target={`exclusions:add:${r.key}`}
                    onClick={() =>
                      act.propose(
                        "app-arr-create",
                        {
                          resource: "exclusion",
                          body: JSON.stringify(
                            w.app === "radarr"
                              ? { tmdbId: r.key }
                              : w.app === "lidarr"
                                ? { foreignId: r.key }
                                : { tvdbId: r.key },
                          ),
                        },
                        `Exclude ${r.title} from import lists`,
                      )
                    }
                  >
                    <Plus strokeWidth={1.5} className="h-3.5 w-3.5" /> Exclude
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {q.data.records.length === 0 ? (
          <p className="text-[0.84rem] text-muted">Nothing is excluded.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line text-[0.82rem]">
            {q.data.records.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-2 px-3 py-2"
                data-testid="radarr-exclusion"
              >
                <span className="min-w-0 flex-1 text-ink">
                  {r.title} {r.year && <span className="text-faint">{r.year}</span>}
                </span>
                <button
                  type="button"
                  className={btnBad}
                  disabled={!act.can || act.busy}
                  data-hearth-target={`exclusions:remove:${r.id}`}
                  onClick={() =>
                    act.propose(
                      "app-arr-delete",
                      { resource: "exclusion", id: r.id },
                      `Let import lists add ${r.title} again`,
                    )
                  }
                >
                  <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove
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
        <ProposeError error={act.error} />
        {act.dialog}
      </div>
    </Guard>
  );
}

/* ---------- Import files (manual import) ---------- */

const gbOf = (b: number) =>
  b >= 1024 ** 3
    ? `${(b / 1024 ** 3).toFixed(1)} GB`
    : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`;

export function ImportFiles({ serviceId }: { serviceId: string }) {
  const w = useServarr();
  const [text, setText] = useState("/downloads");
  const [folder, setFolder] = useState("");
  const q = useRadarr(serviceId, "imports", { folder }, folder.length > 0);
  const act = usePropose(serviceId);
  const [pick, setPick] = useState<Record<string, number | undefined>>({});
  const [mode, setMode] = useState<"move" | "copy">("move");
  const files = q.data?.files ?? [];
  const chosen = files
    .map((f) => ({ path: f.path, movieId: pick[f.path] ?? f.movieId, on: pick[f.path] !== 0 }))
    .filter((f) => f.on && f.movieId);
  const twice = chosen.length !== new Set(chosen.map((c) => c.movieId)).size;
  return (
    <div className="space-y-3" data-testid="radarr-import">
      <p className="text-[0.8rem] text-muted">
        Files {w.name} has not imported yet: say which movie each one is, then {w.name} moves (or
        copies) them into your library and renames them like the rest.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPick({});
          setFolder(text.trim());
        }}
      >
        <label className="sr-only" htmlFor={`imp-f-${serviceId}`}>
          Folder, as {w.name} sees it
        </label>
        <input
          id={`imp-f-${serviceId}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Folder, as ${w.name} sees it`}
          className={cx(input, "flex-1")}
          data-hearth-target="import:folder"
        />
        <button type="submit" className={btn} disabled={!text.trim()}>
          <FolderInput strokeWidth={1.5} className="h-3.5 w-3.5" /> Look
        </button>
      </form>
      {q.isFetching && !q.data && <p className="text-[0.82rem] text-faint">Asking {w.name}...</p>}
      {q.isError && <LoadError error={q.error} />}
      {q.data && folder && (
        <Guard meta={q.data.meta} sample={q.data.sample}>
          {files.length === 0 ? (
            <p className="text-[0.84rem] text-muted">Nothing is waiting in {q.data.folder}.</p>
          ) : (
            <div className="space-y-2">
              <ul className="divide-y divide-line rounded-xl border border-line text-[0.8rem]">
                {files.map((f) => {
                  const id = pick[f.path] ?? f.movieId ?? "";
                  return (
                    <li
                      key={f.path}
                      className="space-y-1 px-3 py-2"
                      data-testid="radarr-import-file"
                    >
                      <p className="break-all text-ink">{f.name}</p>
                      <p className="text-faint">
                        {[gbOf(f.size), f.quality].filter(Boolean).join(" · ")}
                        {f.rejections.length > 0 &&
                          ` · ${w.name} notes: ${f.rejections.join("; ")}`}
                      </p>
                      <select
                        aria-label={`Movie for ${f.name}`}
                        value={String(id)}
                        onChange={(e) =>
                          setPick((p) => ({ ...p, [f.path]: Number(e.target.value) }))
                        }
                        className={cx(inputAuto, "max-w-full")}
                        data-hearth-target={`import:movie:${f.name}`}
                      >
                        <option value="0">Skip this file</option>
                        {!f.movieId && !pick[f.path] && <option value="">Choose the movie</option>}
                        {q.data!.movies.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.title}
                          </option>
                        ))}
                      </select>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap items-center gap-3">
                <select
                  aria-label="Move or copy"
                  value={mode}
                  onChange={(e) => setMode(e.target.value === "copy" ? "copy" : "move")}
                  className={inputAuto}
                >
                  <option value="move">Move the files</option>
                  <option value="copy">Copy (keep the originals)</option>
                </select>
                <button
                  type="button"
                  className={btnGold}
                  disabled={!act.can || act.busy || chosen.length === 0 || twice}
                  data-hearth-target="import:review"
                  onClick={() =>
                    act.propose(
                      "app-arr-command",
                      {
                        command: "ManualImport",
                        folder: q.data!.folder,
                        importMode: mode,
                        files: JSON.stringify(
                          chosen.map(({ path, movieId }) => ({ path, movieId })),
                        ),
                      },
                      `Import ${chosen.length} file${chosen.length === 1 ? "" : "s"} into ${w.name}`,
                    )
                  }
                >
                  Review import of {chosen.length} file{chosen.length === 1 ? "" : "s"}
                </button>
                {twice && (
                  <span className="text-[0.76rem] text-alert">Choose one file per movie.</span>
                )}
              </div>
            </div>
          )}
        </Guard>
      )}
      <ProposeError error={act.error} />
      {act.dialog}
    </div>
  );
}
