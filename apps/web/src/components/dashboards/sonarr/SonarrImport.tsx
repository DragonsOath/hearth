import { useState } from "react";
import { FolderInput } from "lucide-react";
import { cx } from "../../ui";
import {
  Guard,
  LoadError,
  ProposeError,
  btn,
  btnGold,
  input,
  inputAuto,
  usePropose,
} from "../radarr/common";
import { useSonarr, type EpisodeImportsView } from "./data";

/**
 * Activity > Import files for Sonarr (manual import): files Sonarr has not imported, each matched
 * to episodes of a series. Sonarr's own guess is used when it has one; otherwise choose the series
 * and the episode. One plan for all chosen files (app-arr-command ManualImport, the step Ember uses).
 */

const gbOf = (b: number) =>
  b >= 1024 ** 3
    ? `${(b / 1024 ** 3).toFixed(1)} GB`
    : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`;

type File = EpisodeImportsView["files"][number];
interface Choice {
  skip?: boolean;
  seriesId?: number;
  episodeId?: number;
}

export function SonarrImport({ serviceId }: { serviceId: string }) {
  const [text, setText] = useState("/downloads");
  const [folder, setFolder] = useState("");
  const q = useSonarr(serviceId, "imports", { folder }, folder.length > 0);
  const act = usePropose(serviceId);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [mode, setMode] = useState<"move" | "copy">("move");
  const files = q.data?.files ?? [];
  const chosen = files
    .map((f) => {
      const c = choices[f.path] ?? {};
      if (c.skip) return undefined;
      if (c.seriesId && c.episodeId)
        return { path: f.path, seriesId: c.seriesId, episodeIds: [c.episodeId] };
      if (!c.seriesId && f.seriesId && f.episodeIds.length)
        return { path: f.path, seriesId: f.seriesId, episodeIds: f.episodeIds };
      return undefined;
    })
    .filter((x): x is { path: string; seriesId: number; episodeIds: number[] } => Boolean(x));
  const ids = chosen.flatMap((c) => c.episodeIds);
  const twice = ids.length !== new Set(ids).size;
  return (
    <div className="space-y-3" data-testid="sonarr-import">
      <p className="text-[0.8rem] text-muted">
        Files Sonarr has not imported yet: say which episode each one is, then Sonarr moves (or
        copies) them into your library and renames them like the rest.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setChoices({});
          setFolder(text.trim());
        }}
      >
        <label className="sr-only" htmlFor={`simp-f-${serviceId}`}>
          Folder, as Sonarr sees it
        </label>
        <input
          id={`simp-f-${serviceId}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Folder, as Sonarr sees it"
          className={cx(input, "flex-1")}
          data-hearth-target="import:folder"
        />
        <button type="submit" className={btn} disabled={!text.trim()}>
          <FolderInput strokeWidth={1.5} className="h-3.5 w-3.5" /> Look
        </button>
      </form>
      {q.isFetching && !q.data && <p className="text-[0.82rem] text-faint">Asking Sonarr...</p>}
      {q.isError && <LoadError error={q.error} />}
      {q.data && folder && (
        <Guard meta={q.data.meta} sample={q.data.sample}>
          {files.length === 0 ? (
            <p className="text-[0.84rem] text-muted">Nothing is waiting in {q.data.folder}.</p>
          ) : (
            <div className="space-y-2">
              <ul className="divide-y divide-line rounded-xl border border-line text-[0.8rem]">
                {files.map((f) => (
                  <ImportRow
                    key={f.path}
                    serviceId={serviceId}
                    f={f}
                    series={q.data!.series}
                    choice={choices[f.path] ?? {}}
                    onChoice={(c) => setChoices((x) => ({ ...x, [f.path]: c }))}
                  />
                ))}
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
                        files: JSON.stringify(chosen),
                      },
                      `Import ${chosen.length} file${chosen.length === 1 ? "" : "s"} into Sonarr`,
                    )
                  }
                >
                  Review import of {chosen.length} file{chosen.length === 1 ? "" : "s"}
                </button>
                {twice && (
                  <span className="text-[0.76rem] text-alert">Choose one file per episode.</span>
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

function ImportRow({
  serviceId,
  f,
  series,
  choice,
  onChoice,
}: {
  serviceId: string;
  f: File;
  series: { id: number; title: string }[];
  choice: Choice;
  onChoice: (c: Choice) => void;
}) {
  const guessed = !choice.seriesId && f.seriesId && f.episodeIds.length > 0;
  const seriesId = choice.seriesId;
  const eps = useSonarr(serviceId, "series", { id: seriesId }, Boolean(seriesId));
  return (
    <li className="space-y-1 px-3 py-2" data-testid="sonarr-import-file">
      <p className="break-all text-ink">{f.name}</p>
      <p className="text-faint">
        {[gbOf(f.size), f.quality].filter(Boolean).join(" · ")}
        {f.rejections.length > 0 && ` · Sonarr notes: ${f.rejections.join("; ")}`}
      </p>
      {choice.skip ? (
        <p className="text-muted">
          Skipped.{" "}
          <button type="button" className="text-gold underline" onClick={() => onChoice({})}>
            Import it after all
          </button>
        </p>
      ) : guessed ? (
        <p className="text-muted">
          Sonarr matched it to <span className="text-ink">{f.series}</span>{" "}
          <span className="text-gold">{f.episodes.join(", ")}</span>.{" "}
          <button
            type="button"
            className="text-gold underline"
            onClick={() => onChoice({ seriesId: f.seriesId })}
            data-hearth-target={`import:change:${f.name}`}
          >
            Change
          </button>{" "}
          <button
            type="button"
            className="text-gold underline"
            onClick={() => onChoice({ skip: true })}
          >
            Skip
          </button>
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <select
            aria-label={`Series for ${f.name}`}
            value={String(choice.seriesId ?? "")}
            onChange={(e) =>
              e.target.value === "skip"
                ? onChoice({ skip: true })
                : onChoice({ seriesId: Number(e.target.value) || undefined })
            }
            className={cx(inputAuto, "max-w-full")}
            data-hearth-target={`import:series:${f.name}`}
          >
            <option value="">Choose the series</option>
            <option value="skip">Skip this file</option>
            {series.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
          {choice.seriesId && (
            <select
              aria-label={`Episode for ${f.name}`}
              value={String(choice.episodeId ?? "")}
              onChange={(e) =>
                onChoice({ ...choice, episodeId: Number(e.target.value) || undefined })
              }
              className={cx(inputAuto, "max-w-full")}
              data-hearth-target={`import:episode:${f.name}`}
            >
              <option value="">Choose the episode</option>
              {(eps.data?.episodes ?? [])
                .slice()
                .sort((a, b) => a.season - b.season || a.number - b.number)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.code} {e.title}
                    {e.hasFile ? " (has a file)" : ""}
                  </option>
                ))}
            </select>
          )}
        </div>
      )}
    </li>
  );
}
