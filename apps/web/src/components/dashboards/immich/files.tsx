import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, FolderTree, TriangleAlert } from "lucide-react";
import {
  buildTemplate,
  choicesOf,
  FOLDER_CHOICES,
  NAME_CHOICES,
  previewPath,
  previewPaths,
  templateProblem,
  type FolderChoice,
  type NameChoice,
} from "@dragon-control/core";
import { api } from "../../../data/api";
import { ApproveDialog, useApproveHere } from "../../jobs/ApproveHere";
import { Button, Skeleton, cx } from "../../ui";
import type { AppViewProps } from "../../panels/registry";

/**
 * Files and folders: how Immich names and files photos on disk, through its storage template (the
 * only supported way; Hearth never moves or renames a file itself). The owner builds a pattern from
 * a few choices and sees where some of their own photos would go; saving is one plan with the
 * pattern before and after, then Immich's own job moves and renames the files, and this tab shows
 * its progress and checks a few photos landed where the pattern says.
 */

export interface FilesAnswer {
  storage: {
    known: boolean;
    enabled?: boolean;
    template?: string;
    canChange: boolean;
    why?: string;
  };
  migration: { known: boolean; active: number; waiting: number; failed: number; paused: boolean };
  /**
   * The time zones Immich may be filing photos in, learnt from where it already filed them
   * (UTC first when it fits). known false: nothing tells yet, so the preview uses UTC.
   */
  zone: { known: boolean; zones: string[] };
  samples: {
    id: string;
    name: string;
    takenAt: string;
    owner: string;
    album?: string;
    path: string;
    expected?: string;
    inPlace?: boolean;
    external?: boolean;
  }[];
}

export const filesUrl = (serviceId: string) =>
  `/api/services/${encodeURIComponent(serviceId)}/dashboard/immich/files`;

/** Reads Files and folders; while Immich's job is busy it reads again every two seconds. */
export function useImmichFiles(serviceId: string, watch = false) {
  return useQuery({
    queryKey: ["immich-files", serviceId],
    queryFn: () => api<FilesAnswer>("GET", filesUrl(serviceId)),
    refetchInterval: (q) => {
      const m = q.state.data?.migration;
      return watch || (m && m.active + m.waiting > 0) ? 2000 : false;
    },
  });
}

export function ImmichFiles({ serviceId, name }: AppViewProps) {
  const c = useApproveHere(serviceId, "From Immich's panel in Hearth: files and folders.");
  // Once the plan has run, this tab keeps reading: at least twice more (Immich may not show its
  // job as started at once), and for as long as the job is busy. Then the spot check shows.
  const [plan, setPlan] = useState<{ job: string; at: number; reads: number }>();
  const files = useImmichFiles(serviceId, Boolean(plan && plan.reads < 2));
  if (c.job?.status === "succeeded" && plan?.job !== c.job.id)
    setPlan({ job: c.job.id, at: files.dataUpdatedAt, reads: 0 });
  else if (plan && files.dataUpdatedAt > plan.at)
    setPlan({ ...plan, at: files.dataUpdatedAt, reads: plan.reads + 1 });
  const data = files.data;
  const st = data?.storage;
  const current = st?.template ?? "";
  const start = choicesOf(current);
  const [folder, setFolder] = useState<FolderChoice>();
  const [file, setFile] = useState<NameChoice>();
  const f = folder ?? start?.folder ?? "album";
  const n = file ?? start?.name ?? "original";
  const template = buildTemplate(f, n);
  const changed = !st?.enabled || template !== current;
  const busy = Boolean(data && data.migration.active + data.migration.waiting > 0);

  if (files.isPending) return <Skeleton className="h-64" />;
  if (files.isError)
    return (
      <p role="alert" className="text-[0.86rem] text-bad">
        Could not read {name}&apos;s files and folders: {files.error.message}
      </p>
    );
  if (!data || !st?.known)
    return (
      <p className="text-[0.86rem] text-muted" data-testid="im-files-unknown">
        {st?.why ?? `${name} would not share its storage settings with this key.`}
      </p>
    );

  const checked = data.samples.filter((s) => s.inPlace !== undefined);
  const misplaced = checked.filter((s) => !s.inPlace);
  const save = (enabled: boolean) =>
    void c.proposeMany(
      [
        {
          kind: "app-immich-control",
          params: {
            op: "storage-template",
            body: JSON.stringify({ enabled, template: enabled ? template : current }),
          },
        },
        ...(enabled
          ? [{ kind: "app-immich-control" as const, params: { op: "storage-migrate" } }]
          : []),
      ],
      enabled
        ? `Name and file ${name}'s photos by a new pattern`
        : `Turn off ${name}'s storage template`,
    );

  const radio = (on: boolean) =>
    cx(
      "flex min-h-11 w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-[0.84rem]",
      on ? "border-gold bg-gold/10 text-ink" : "border-line text-muted hover:text-ink",
    );

  return (
    <section
      className="@container space-y-4"
      data-testid="im-files"
      aria-label={`${name}: files and folders`}
    >
      <div className="flex flex-wrap items-start gap-3 rounded-xl border border-line p-3">
        <FolderTree strokeWidth={1.5} className="mt-0.5 h-5 w-5 text-gold" />
        <div className="min-w-0 flex-1">
          <p className="text-[0.9rem] text-ink" data-testid="im-files-state">
            Storage template: {st.enabled ? "on" : "off"}
          </p>
          <p className="mt-0.5 break-all font-mono text-[0.76rem] text-muted">
            {current || "none"}
          </p>
          {!st.enabled && (
            <p className="mt-1 text-[0.78rem] text-faint">
              Off: {name} keeps uploads in its own folders, named by an internal id.
            </p>
          )}
        </div>
      </div>

      <ul className="space-y-1 text-[0.8rem] text-muted" data-testid="im-files-explain">
        <li>It applies to the whole library, not just some photos.</li>
        <li>
          {name} moves and renames the files it already has to match, with its own job. Hearth never
          moves a file itself.
        </li>
        <li>
          Names are made from the album, the date and the original name only. There is no 001, 002
          counter; if two photos would get the same name, {name} adds +1.
        </li>
        <li>{name} still shows each photo&apos;s original name.</li>
        <li>Photos in an external library are never moved.</li>
      </ul>

      {/* The choices and preview change nothing in Immich, so Ember's cursor may use them to
          show a pattern; saving (below, outside) stays the owner's. */}
      <div data-show-safe className="space-y-4">
        <div className="grid gap-4 @2xl:grid-cols-2">
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-[0.78rem] text-muted">Folders</legend>
            {FOLDER_CHOICES.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={f === o.value}
                onClick={() => setFolder(o.value)}
                className={radio(f === o.value)}
                data-testid={`im-files-folder-${o.value}`}
              >
                <span>
                  {o.label}
                  <span className="block text-[0.74rem] text-faint">{o.hint}</span>
                </span>
              </button>
            ))}
          </fieldset>
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-[0.78rem] text-muted">File names</legend>
            {NAME_CHOICES.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={n === o.value}
                onClick={() => setFile(o.value)}
                className={radio(n === o.value)}
                data-testid={`im-files-name-${o.value}`}
              >
                <span>
                  {o.label}
                  <span className="block text-[0.74rem] text-faint">{o.hint}</span>
                </span>
              </button>
            ))}
          </fieldset>
        </div>
        {st.enabled && current && !start && (
          <p className="text-[0.78rem] text-faint">
            The pattern {name} uses now was not made in Hearth. Choosing above replaces it.
          </p>
        )}

        <div data-testid="im-files-preview">
          <p className="mb-1 text-[0.78rem] text-muted">Where some of your photos would go</p>
          <p
            className="mb-2 break-all font-mono text-[0.74rem] text-faint"
            data-testid="im-files-pattern"
          >
            {template}
          </p>
          <ul className="space-y-2">
            {data.samples.map((s) => (
              <li
                key={s.id}
                className="rounded-lg border border-line p-2 text-[0.78rem]"
                data-testid="im-files-sample"
              >
                <p className="text-ink">
                  {s.name}
                  {s.album && <span className="text-faint"> · in {s.album}</span>}
                  {s.external && <span className="text-faint"> · external library, stays</span>}
                </p>
                <p className="break-all text-muted">
                  Now: <span className="font-mono">{s.path}</span>
                </p>
                <p className="break-all text-gold" data-testid="im-files-after">
                  After:{" "}
                  <span className="font-mono">
                    {s.external ? s.path : previewPath(template, s, data.zone.zones[0])}
                  </span>
                  {!s.external &&
                    previewPaths(template, s, data.zone.zones)
                      .slice(1)
                      .map((alt) => (
                        <span key={alt} className="block text-faint" data-testid="im-files-or">
                          or <span className="font-mono">{alt}</span> (the photos {name} filed so
                          far do not show which time zone it uses)
                        </span>
                      ))}
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[0.72rem] text-faint" data-testid="im-files-zone">
            {data.zone.known
              ? `${name} dates photos by when they were taken, in its own time zone: ${data.zone.zones.length === 1 ? data.zone.zones[0] : `${data.zone.zones[0]} or one of ${data.zone.zones.length - 1} others giving the same dates`}, worked out from where it already filed your photos. This preview uses it.`
              : `${name} dates photos by when they were taken, in its server's time zone, and does not say which zone that is. Until it has filed some photos by a dated pattern, this preview uses UTC (${name}'s default). If your ${name} has a time zone set, a photo taken within that many hours of midnight UTC lands on the day before or after.`}
          </p>
        </div>
      </div>

      {busy && (
        <p
          className="flex items-center gap-2 text-[0.84rem] text-amber"
          data-testid="im-files-progress"
          role="status"
        >
          {name} is moving and renaming files: {data.migration.active} running,{" "}
          {data.migration.waiting} waiting.
        </p>
      )}
      {!busy && st.enabled && checked.length > 0 && (
        <p
          className={cx(
            "flex items-center gap-2 text-[0.84rem]",
            misplaced.length ? "text-amber" : "text-live",
          )}
          data-testid="im-files-check"
        >
          {misplaced.length ? (
            <>
              <TriangleAlert strokeWidth={1.75} className="h-4 w-4" />
              {misplaced.length} of {checked.length} photos checked are not where the pattern says
              yet. Run the job again, or check {name}&apos;s Jobs page.
            </>
          ) : (
            <>
              <Check strokeWidth={2} className="h-4 w-4" />
              Checked: {checked.length} of {checked.length} photos are where the pattern says, and{" "}
              {name} still finds them.
            </>
          )}
        </p>
      )}

      {!st.canChange && (
        <p className="text-[0.82rem] text-amber" data-testid="im-files-cannot">
          {st.why}
        </p>
      )}
      {c.error && <p className="text-[0.82rem] text-amber">{c.error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {st.enabled && (
          <Button
            tone="quiet"
            disabled={!st.canChange || c.busy}
            onClick={() => save(false)}
            data-testid="im-files-off"
          >
            Turn it off
          </Button>
        )}
        <Button
          tone="primary"
          disabled={
            !st.canChange || !changed || c.busy || busy || Boolean(templateProblem(template))
          }
          onClick={() => save(true)}
          data-testid="im-files-save"
        >
          Review and approve
        </Button>
      </div>
      <ApproveDialog c={c} />
    </section>
  );
}
