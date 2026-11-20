import { DatabaseBackup, MessageCircle, RefreshCw } from "lucide-react";
import type { KavitaDashboard as Data } from "@dragon-control/core";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { useCave } from "../shell/cave-context";
import { Button, Skeleton, cx } from "../ui";
import { ChangeCard, useConfirmedChange } from "./ConfirmedChange";
import { PasteKey } from "./PasteKey";
import { ScanLibraries } from "./ScanLibraries";
import { EmberMark } from "../ember/EmberMark";

/**
 * Kavita from Hearth: how much is in it (series, files, size, hours read), each library and when
 * it was last scanned, its scheduled jobs, and files it could not read (and why). Scanning one
 * library or all and backing up the database are plans confirmed here.
 */

const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.76rem] text-muted hover:border-gold/60 hover:text-gold";

function LibraryRow({ serviceId, l }: { serviceId: string; l: Data["libraries"][number] }) {
  const c = useConfirmedChange(serviceId);
  return (
    <li
      className="space-y-1.5 py-2.5"
      data-testid="kv-library"
      data-capture-item
      data-capture-label={l.name}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[0.88rem] text-ink">{l.name}</p>
          <p className={cx("text-[0.76rem]", l.lastScanned ? "text-faint" : "text-amber")}>
            {l.kind} · {l.folders} {l.folders === 1 ? "folder" : "folders"} ·{" "}
            {l.lastScanned ? `scanned ${ago(l.lastScanned)}` : "never scanned"}
          </p>
        </div>
        <button
          type="button"
          className={btn}
          data-testid="kv-scan"
          onClick={() =>
            void c.propose(
              "app-kavita-control",
              { op: "scan-library", libraryId: l.id },
              `Scan ${l.name}`,
            )
          }
        >
          <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" /> Scan
        </button>
      </div>
      <ChangeCard c={c} />
    </li>
  );
}

export function KavitaDashboard({ serviceId, name }: { serviceId: string; name: string }) {
  const q = useDashboard(serviceId, true, 30_000);
  const all = useConfirmedChange(serviceId);
  const cave = useCave();
  const d: Data | undefined = q.data?.data?.app === "kavita" ? q.data.data : undefined;
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return q.data.error.kind === "needs-key" || q.data.error.kind === "rejected" ? (
      <PasteKey
        serviceId={serviceId}
        name={name}
        where="your user settings as an administrator, then the API Key (or Auth Keys) section, and copy the key"
        message={q.data.error.message}
      />
    ) : (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="kv-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
      </div>
    );
  if (!d) return null;
  return (
    <section
      className="@container space-y-4"
      data-testid="kv-dashboard"
      aria-label={`${name}: reading`}
    >
      <ScanLibraries
        serviceId={serviceId}
        kind="app-kavita-control"
        name={name}
        testId="kv-scan-libraries"
      />
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        {(
          [
            [
              "Series",
              d.series.toLocaleString(),
              `${d.volumes.toLocaleString()} volumes, ${d.chapters.toLocaleString()} chapters`,
            ],
            ["Files", d.files.toLocaleString(), `${d.sizeGb} GB`],
            ["Hours read", d.readingHours.toLocaleString(), "by everyone"],
            [
              "Unreadable files",
              `${d.unreadable.count}`,
              d.unreadable.count ? "need a look" : "none",
            ],
          ] as const
        ).map(([label, value, sub]) => (
          <div key={label} className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
            <p className="text-[0.72rem] tracking-wide text-faint uppercase">{label}</p>
            <p
              className={cx(
                "stat-value text-ink tabular",
                label === "Unreadable files" && d.unreadable.count > 0 && "text-amber",
              )}
              data-testid={
                label === "Series"
                  ? "kv-series"
                  : label === "Unreadable files"
                    ? "kv-unreadable"
                    : undefined
              }
            >
              {value}
            </p>
            <p className="text-[0.74rem] text-faint">{sub}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 @2xl:grid-cols-2">
        <div>
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <p className="flex-1 text-[0.72rem] tracking-wide text-faint uppercase">Libraries</p>
            <Button
              tone="outline"
              data-testid="kv-backup"
              onClick={() =>
                void all.propose("app-kavita-control", { op: "backup-db" }, "Back up Kavita")
              }
            >
              <DatabaseBackup className="h-4 w-4" /> Back up
            </Button>
          </div>
          <ChangeCard c={all} />
          <ul className="divide-y divide-line">
            {d.libraries.map((l) => (
              <LibraryRow key={l.id} serviceId={serviceId} l={l} />
            ))}
          </ul>
        </div>
        <div className="space-y-4">
          {d.unreadable.count > 0 && (
            <div>
              <p className="mb-1 text-[0.72rem] tracking-wide text-faint uppercase">
                Files Kavita could not read
              </p>
              <ul className="space-y-1.5 text-[0.82rem]" data-testid="kv-errors">
                {d.unreadable.files.map((f, i) => (
                  <li key={i} className="break-words">
                    <span className="text-ink">{f.file}</span>
                    {f.where && <span className="text-faint"> · {f.where}</span>}
                    {f.why && <p className="text-[0.78rem] text-amber">{f.why}</p>}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
                onClick={() =>
                  cave.ask(
                    `Kavita could not read ${d.unreadable.count} files, for example ${d.unreadable.files
                      .slice(0, 3)
                      .map((f) => `${f.file} (${f.why})`)
                      .join("; ")}. Why, and how do I fix them?`,
                  )
                }
              >
                <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask why
                <EmberMark />
              </button>
            </div>
          )}
          {d.jobs.length > 0 && (
            <div>
              <p className="mb-1 text-[0.72rem] tracking-wide text-faint uppercase">
                Scheduled jobs
              </p>
              <ul className="divide-y divide-line text-[0.82rem]">
                {d.jobs.map((j) => (
                  <li key={j.name} className="flex flex-wrap gap-x-3 py-1.5">
                    <span className="flex-1 text-ink">{j.name}</span>
                    <span className="text-faint">
                      {j.lastRan ? `ran ${ago(j.lastRan)}` : "has not run"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
      <p className="text-[0.74rem] text-faint">
        {q.data?.sample ? "Sample data · " : ""}
        {d.version ? `${name} ${d.version} · ` : ""}live, every 30 s
      </p>
    </section>
  );
}
