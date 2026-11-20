import { useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  CloudDownload,
  FileInput,
  FilePen,
  MessageCircle,
  PackageCheck,
  Search,
} from "lucide-react";
import type { DownloadTrail as Trail, DownloadTrailStep } from "@dragon-control/core";
import { ago } from "../../lib/format";
import { cx } from "../ui";
import { useAiName } from "../../data/api";
import { useCave } from "../shell/cave-context";
import { EmberMark } from "../ember/EmberMark";

/** What to ask about a download that went wrong: everything the trail knows about it. */
export function trailQuestion(app: string, t: Trail): string {
  const bad = [...t.steps].reverse().find((s) => s.kind === "stuck" || s.kind === "failed");
  return [
    t.status === "failed"
      ? `${app}'s download of "${t.title}" did not finish.`
      : `${app} downloaded "${t.title}" but did not import it.`,
    t.release ? `Release: ${t.release}.` : "",
    bad ? `${app} says: ${bad.text}` : "",
    bad?.to ? `File: ${bad.to}` : "",
    "Why did this happen, and what is the fix? If you can fix it, propose a plan.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** "Ask Ember" on a download that went wrong (10-26): the whole trail goes with the question. */
function AskAboutTrail({ app, t }: { app: string; t: Trail }) {
  const cave = useCave();
  const aiName = useAiName();
  return (
    <button
      type="button"
      onClick={() => cave.ask(trailQuestion(app, t))}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.78rem] text-gold hover:bg-gold/10"
      data-testid="trail-ask"
    >
      <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" aria-hidden />
      Ask {aiName}
      <EmberMark />
    </button>
  );
}

/**
 * Each recent download's trail, in Radarr, Sonarr, Chaptarr, and Lidarr panels (10-26):
 * grabbed (from which indexer, to which download client), downloading (into which folder),
 * imported (from the download folder into the library, under its new name), renamed later, or
 * failed. Paths are the app's own (inside its container), exactly as it reported them.
 */

const STATUS: Record<Trail["status"], { label: string; cls: string }> = {
  grabbed: { label: "Grabbed", cls: "border-gold/40 text-gold" },
  downloading: { label: "Downloading", cls: "border-gold/40 text-gold" },
  importing: { label: "Importing", cls: "border-gold/40 text-gold" },
  stuck: { label: "Not imported", cls: "border-amber/50 text-amber" },
  imported: { label: "In the library", cls: "border-live/40 text-live" },
  renamed: { label: "Renamed", cls: "border-live/40 text-live" },
  failed: { label: "Did not finish", cls: "border-alert/40 text-alert" },
};

const ICON: Record<DownloadTrailStep["kind"], typeof Check> = {
  grabbed: Search,
  downloading: CloudDownload,
  importing: FileInput,
  stuck: AlertTriangle,
  imported: PackageCheck,
  renamed: FilePen,
  failed: AlertTriangle,
};

/** A path split so the file name stands out from its folder. */
function Path({ label, path }: { label: string; path: string }) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const folder = cut > 0 ? path.slice(0, cut + 1) : "";
  const file = cut >= 0 ? path.slice(cut + 1) : path;
  return (
    <p className="font-mono text-[0.74rem] leading-snug break-all" data-testid="trail-path">
      <span className="mr-1.5 font-sans text-[0.68rem] tracking-wide text-faint uppercase">
        {label}
      </span>
      <span className="text-faint">{folder}</span>
      <span className="text-ink">{file}</span>
    </p>
  );
}

function Step({ s, last }: { s: DownloadTrailStep; last: boolean }) {
  const Icon = ICON[s.kind];
  const bad = s.kind === "failed" || s.kind === "stuck";
  return (
    <li
      className="relative flex gap-2.5 pb-3 last:pb-0"
      data-testid="trail-step"
      data-kind={s.kind}
    >
      {!last && <span className="absolute top-6 bottom-0 left-[11px] w-px bg-line" aria-hidden />}
      <span
        className={cx(
          "z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-bg",
          bad ? "border-alert/50 text-alert" : "border-gold/50 text-gold",
        )}
      >
        <Icon strokeWidth={1.75} className="h-3.5 w-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className={cx("text-[0.82rem]", bad ? "text-alert" : "text-ink")}>
          {s.text}
          {s.at && <span className="text-faint"> · {ago(s.at)}</span>}
        </p>
        {s.progressPct !== undefined && (
          <div
            className="h-1.5 overflow-hidden rounded-full bg-line"
            role="progressbar"
            aria-valuenow={s.progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Download progress"
          >
            <div className="h-full rounded-full bg-gold" style={{ width: `${s.progressPct}%` }} />
          </div>
        )}
        {s.from && <Path label="From" path={s.from} />}
        {s.from && s.to && <ArrowDown className="ml-1 h-3 w-3 text-faint" aria-hidden />}
        {s.to && (
          <Path
            label={
              s.kind === "downloading" || s.kind === "importing" || s.kind === "stuck" ? "In" : "To"
            }
            path={s.to}
          />
        )}
      </div>
    </li>
  );
}

export function DownloadTrails({ trails, app }: { trails?: Trail[]; app: string }) {
  const [open, setOpen] = useState<string | undefined>(trails?.[0]?.key);
  if (!trails?.length)
    return (
      <p className="text-[0.86rem] text-muted">
        Nothing {app} downloaded, imported, or renamed lately.
      </p>
    );
  return (
    <div className="space-y-2" data-testid="download-trails">
      <p className="text-[0.76rem] text-faint">
        Folders as {app} sees them. Downloads land in the download folder; {app} then renames each
        file and moves it into your library.
      </p>
      <ul className="space-y-2">
        {trails.map((t) => {
          const st = STATUS[t.status];
          const isOpen = open === t.key;
          return (
            <li
              key={t.key}
              className="rounded-xl border border-line bg-bg/40"
              data-testid="download-trail"
              data-capture-item
              data-capture-label={t.title}
            >
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? undefined : t.key)}
                className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 p-3 text-left"
              >
                <span className="min-w-0 flex-1 text-[0.88rem] break-words text-ink">
                  {t.title}
                </span>
                <span
                  className={cx("fit-pill rounded-full border px-2 py-0.5 text-[0.7rem]", st.cls)}
                  data-testid="trail-status"
                >
                  {st.label}
                </span>
                {t.updatedAt && (
                  <span className="text-[0.74rem] text-faint">{ago(t.updatedAt)}</span>
                )}
              </button>
              {isOpen && (
                <div className="space-y-2 border-t border-line px-3 pt-2.5 pb-3">
                  {t.release && (
                    <p className="text-[0.74rem] break-all text-faint">Release: {t.release}</p>
                  )}
                  <ol>
                    {t.steps.map((s, i) => (
                      <Step key={i} s={s} last={i === t.steps.length - 1} />
                    ))}
                  </ol>
                  {(t.status === "stuck" || t.status === "failed") && (
                    <div className="flex justify-end pt-1">
                      <AskAboutTrail app={app} t={t} />
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
