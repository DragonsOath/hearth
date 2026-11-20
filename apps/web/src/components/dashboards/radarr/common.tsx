import { createContext, useContext, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Film, MessageCircle } from "lucide-react";
import type { ActionKind, StepParams } from "@dragon-control/core";
import { ApproveDialog, useApproveHere } from "../../jobs/ApproveHere";
import { useCave } from "../../shell/cave-context";
import { Skeleton, cx } from "../../ui";
import { posterUrl, useServarr, type RadarrMeta } from "./data";
import { EmberMark } from "../../ember/EmberMark";

/**
 * Pieces every Radarr tab shares: proposing a change for approval right here (the same plan step
 * Ember uses), the version guard (D8: an unknown version gets read-only views), paging, posters,
 * and small form controls in Hearth's style.
 */

export const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.78rem] text-ink hover:border-gold hover:text-gold disabled:opacity-50 disabled:hover:border-line-strong disabled:hover:text-ink";
export const btnGold =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/60 bg-gold/10 px-3 text-[0.8rem] text-gold hover:bg-gold/20 disabled:opacity-50";
export const btnBad =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-alert/50 px-2.5 text-[0.78rem] text-alert hover:bg-alert/10 disabled:opacity-50";
const field =
  "min-h-10 min-w-0 rounded-lg border border-line-strong bg-bg px-3 text-[0.86rem] text-ink focus:border-gold/60 focus:outline-none";
export const input = `${field} w-full`;
/** A dropdown or field that takes only the room it needs (filters, toolbars). */
export const inputAuto = `${field} w-auto`;

/** Whether changes may be proposed (a supported Radarr version, and not sample data). */
const Writable = createContext<{ ok: boolean; why?: string }>({ ok: true });
export const useWritable = () => useContext(Writable);

export function Guard({
  meta,
  sample,
  children,
}: {
  meta: RadarrMeta;
  sample?: boolean;
  children: ReactNode;
}) {
  const w = useServarr();
  const why = sample
    ? `Sample data: connect a real ${w.name} to make changes.`
    : !meta.supported
      ? `${w.name} ${meta.version} is newer or older than the version Hearth was built for (${{ radarr: "6", sonarr: "4", prowlarr: "2", lidarr: "3" }[w.app]}.x), so this panel only reads. Make changes in ${w.name} itself until Hearth supports it.`
      : undefined;
  return (
    <Writable.Provider value={{ ok: !why, why }}>
      {why && (
        <p
          className="mb-3 rounded-lg border border-amber/40 bg-amber/[0.06] px-3 py-2 text-[0.8rem] text-amber"
          data-testid="radarr-readonly"
        >
          {why}
        </p>
      )}
      {children}
    </Writable.Provider>
  );
}

/** Plans one change and asks for approval in a pop-up (the same plan step Ember would make). */
export function usePropose(serviceId: string) {
  const w = useServarr();
  const c = useApproveHere(serviceId, `Proposed from the ${w.name} panel.`);
  const writable = useWritable();
  return {
    c,
    busy: c.busy,
    error: c.error,
    can: writable.ok,
    propose: (kind: ActionKind, params: StepParams, title: string) => {
      if (!writable.ok) return;
      void c.propose(kind, params, title);
    },
    proposeMany: (steps: { kind: ActionKind; params: StepParams }[], title: string) => {
      if (!writable.ok || steps.length === 0) return;
      void c.proposeMany(steps, title);
    },
    dialog: <ApproveDialog c={c} />,
  };
}

export function ProposeError({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-[0.82rem] text-bad">
      {error}
    </p>
  );
}

export function LoadError({ error }: { error: unknown }) {
  const w = useServarr();
  return (
    <p role="alert" className="rounded-lg border border-alert/40 px-3 py-2 text-[0.84rem] text-bad">
      {error instanceof Error ? error.message : `Could not read ${w.name}.`}
    </p>
  );
}

export function Loading() {
  return (
    <div className="space-y-2" aria-busy="true">
      <Skeleton className="h-10" />
      <Skeleton className="h-24" />
      <Skeleton className="h-24" />
    </div>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-2 pt-2">
      <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <ChevronLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> Newer
      </button>
      <span className="text-[0.78rem] text-faint tabular">
        Page {page} of {pages}
      </span>
      <button
        type="button"
        className={btn}
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
      >
        Older <ChevronRight strokeWidth={1.5} className="h-3.5 w-3.5" />
      </button>
    </nav>
  );
}

export function Poster({
  serviceId,
  poster,
  title,
  className,
}: {
  serviceId: string;
  poster?: string;
  title: string;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <div
      className={cx(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-raised",
        className,
      )}
    >
      {poster && !broken ? (
        <img
          src={posterUrl(serviceId, poster)}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <Film
          strokeWidth={1.25}
          className="h-5 w-5 text-faint"
          aria-label={`${title}: no poster`}
        />
      )}
    </div>
  );
}

export function AskEmber({ question, label = "Ask Ember" }: { question: string; label?: string }) {
  const cave = useCave();
  return (
    <button
      type="button"
      onClick={() => cave.ask(question)}
      className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
    >
      <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" />
      {label}
      <EmberMark />
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-[0.8rem] text-muted">
        {label}
      </label>
      {children}
      {hint && <p className="text-[0.74rem] text-faint">{hint}</p>}
    </div>
  );
}

export function Check({
  checked,
  onChange,
  label,
  target,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  target?: string;
}) {
  return (
    <label className="flex min-h-9 cursor-pointer items-center gap-2 text-[0.84rem] text-ink">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-hearth-target={target}
        className="h-4 w-4 accent-[var(--color-gold)]"
      />
      {label}
    </label>
  );
}

export function SubNav<T extends string>({
  label,
  value,
  options,
  onChange,
  target,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; count?: number }[];
  onChange: (v: T) => void;
  target: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            data-hearth-target={`${target}:${o.value}`}
            onClick={() => onChange(o.value)}
            className={cx(
              "min-h-9 rounded-full border px-3.5 text-[0.8rem] transition-colors",
              on
                ? "border-gold/60 bg-gold/10 text-gold"
                : "border-line text-muted hover:border-line-strong hover:text-ink",
            )}
          >
            {o.label}
            {o.count !== undefined && <span className="ml-1.5 text-faint tabular">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export const gb = (bytes?: number) =>
  bytes === undefined
    ? ""
    : bytes >= 1024 ** 4
      ? `${(bytes / 1024 ** 4).toFixed(1)} TB`
      : `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export const when = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};
export const day = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { dateStyle: "medium" });
};

export const EVENT_WORDS: Record<string, string> = {
  grabbed: "Grabbed",
  downloadFolderImported: "Imported",
  downloadFailed: "Download failed",
  movieFileDeleted: "File deleted",
  movieFileRenamed: "File renamed",
  downloadIgnored: "Ignored",
  movieFolderImported: "Imported from folder",
};

export const AVAILABILITY: { value: string; label: string }[] = [
  { value: "announced", label: "Announced" },
  { value: "inCinemas", label: "In cinemas" },
  { value: "released", label: "Released" },
];
