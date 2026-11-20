import { useState } from "react";
import { AlertTriangle, Archive, ArrowRight, CheckCircle2, ExternalLink, Play } from "lucide-react";
import type { AppViewProps } from "../../panels/registry";
import { Meter, cx } from "../../ui";
import { useServarr, useRadarr } from "./data";
import { healthFix } from "./healthFix";
import {
  AskEmber,
  Guard,
  LoadError,
  Loading,
  Pager,
  ProposeError,
  SubNav,
  btn,
  gb,
  inputAuto,
  usePropose,
  when,
} from "./common";

/**
 * Radarr's System tab: what Radarr says is wrong (health), its version, disk space, scheduled
 * tasks with Run now, backups with Back up now, and its own log. Updating Radarr, its login and its
 * API key stay in Radarr (D6). Address: "status", "tasks", "backups", "logs".
 */

type Part = "status" | "tasks" | "backups" | "logs";
const PARTS: Part[] = ["status", "tasks", "backups", "logs"];

const every = (minutes: number) =>
  minutes <= 0
    ? "Not scheduled"
    : minutes < 60
      ? `Every ${minutes} min`
      : minutes < 1440
        ? `Every ${Math.round(minutes / 60)} h`
        : `Every ${Math.round(minutes / 1440)} days`;

export function RadarrSystem({ serviceId, sub, onSub, onGo }: AppViewProps) {
  const w = useServarr();
  const part: Part = PARTS.includes(sub as Part) ? (sub as Part) : "status";
  const q = useRadarr(serviceId, "system", {}, part !== "logs");
  const act = usePropose(serviceId);
  return (
    <div className="space-y-3" data-testid="radarr-system">
      <SubNav
        label="System"
        target="system"
        value={part}
        onChange={(p) => onSub?.(p === "status" ? null : p)}
        options={[
          { value: "status", label: "Health", count: q.data?.health.length },
          { value: "tasks", label: "Tasks" },
          { value: "backups", label: "Backups" },
          { value: "logs", label: "Log" },
        ]}
      />
      {part === "logs" ? (
        <Logs serviceId={serviceId} />
      ) : q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <LoadError error={q.error} />
      ) : (
        <Guard meta={q.data.meta} sample={q.data.sample}>
          {part === "status" && (
            <div className="space-y-4">
              {q.data.health.length === 0 ? (
                <p className="flex items-center gap-2 text-[0.86rem] text-ok">
                  <CheckCircle2 strokeWidth={1.5} className="h-4 w-4" /> {w.name} reports no
                  problems.
                </p>
              ) : (
                <ul className="space-y-2" data-testid="radarr-health">
                  {q.data.health.map((h, i) => {
                    const fix = onGo ? healthFix(h.source) : undefined;
                    return (
                      <li
                        key={i}
                        className={cx(
                          "flex items-start gap-2 rounded-xl border p-3 text-[0.84rem]",
                          h.type === "error"
                            ? "border-alert/50 text-alert"
                            : "border-amber/50 text-amber",
                        )}
                      >
                        <AlertTriangle strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0" />
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <p>{h.message}</p>
                          <div className="flex flex-wrap gap-2">
                            {fix && (
                              <button
                                type="button"
                                onClick={() => onGo?.(fix.tab, fix.sub)}
                                className={btn}
                                data-hearth-target="health:fix"
                              >
                                <ArrowRight strokeWidth={1.5} className="h-3.5 w-3.5" /> {fix.label}
                              </button>
                            )}
                            <AskEmber
                              label="Ask Ember to fix it"
                              question={`${w.name} (service ${serviceId}) reports: "${h.message}". What is wrong and how do we fix it?`}
                            />
                            {h.wiki && (
                              <a href={h.wiki} target="_blank" rel="noreferrer" className={btn}>
                                <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" /> {w.name}
                                's help
                              </a>
                            )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              <dl className="grid gap-x-4 gap-y-1 text-[0.82rem] sm:grid-cols-2">
                {[
                  [
                    "Version",
                    `${q.data.status.version}${q.data.status.branch ? ` (${q.data.status.branch})` : ""}`,
                  ],
                  [
                    "Running on",
                    [q.data.status.os, q.data.status.docker ? "Docker" : ""]
                      .filter(Boolean)
                      .join(", "),
                  ],
                  [".NET", q.data.status.runtime],
                  ["Started", when(q.data.status.started)],
                ].map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <dt className="text-faint">{k}</dt>
                    <dd className="text-ink">{v}</dd>
                  </div>
                ))}
              </dl>
              {q.data.disks.length > 0 && (
                <div className="space-y-2">
                  <h4 className="eyebrow">Disk space</h4>
                  {q.data.disks.map((d) => (
                    <div key={d.path} className="space-y-1">
                      <p className="flex justify-between text-[0.8rem]">
                        <span className="text-ink">{d.label || d.path}</span>
                        <span className="text-faint">
                          {gb(d.free)} free of {gb(d.total)}
                        </span>
                      </p>
                      <Meter
                        value={d.total ? ((d.total - (d.free ?? 0)) / d.total) * 100 : 0}
                        label={`${d.path} used`}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {part === "tasks" && (
            <ul
              className="divide-y divide-line rounded-xl border border-line text-[0.82rem]"
              data-testid="radarr-tasks"
            >
              {q.data.tasks.map((t) => (
                <li key={t.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-ink">{t.name}</p>
                    <p className="text-faint">
                      {every(t.interval)} · last {when(t.last) || "never"} · next {when(t.next)}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={btn}
                    disabled={
                      !act.can ||
                      act.busy ||
                      ["ApplicationUpdateCheck", "ApplicationUpdate"].includes(t.command)
                    }
                    data-hearth-target={`task:run:${t.command}`}
                    onClick={() =>
                      act.propose(
                        "app-arr-command",
                        { command: t.command },
                        `Run "${t.name}" now in ${w.name}`,
                      )
                    }
                  >
                    <Play strokeWidth={1.5} className="h-3.5 w-3.5" /> Run now
                  </button>
                </li>
              ))}
            </ul>
          )}
          {part === "backups" && (
            <div className="space-y-2" data-testid="radarr-backups">
              <button
                type="button"
                className={btn}
                disabled={!act.can || act.busy}
                data-hearth-target="backup:now"
                onClick={() =>
                  act.propose(
                    "app-arr-command",
                    { command: "Backup" },
                    `Make a backup of ${w.name} now`,
                  )
                }
              >
                <Archive strokeWidth={1.5} className="h-3.5 w-3.5" /> Back up now
              </button>
              {q.data.backups.length === 0 ? (
                <p className="text-[0.84rem] text-muted">No backups yet.</p>
              ) : (
                <ul className="divide-y divide-line rounded-xl border border-line text-[0.82rem]">
                  {q.data.backups.map((b) => (
                    <li key={b.id} className="px-3 py-2">
                      <p className="break-all text-ink">{b.name}</p>
                      <p className="text-faint">
                        {[
                          b.type === "manual" ? "Made by hand" : "Scheduled",
                          when(b.time),
                          b.size ? `${(b.size / 1e6).toFixed(1)} MB` : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[0.76rem] text-faint">
                Restoring a backup stays in {w.name} itself.
              </p>
            </div>
          )}
          <ProposeError error={act.error} />
          {act.dialog}
        </Guard>
      )}
    </div>
  );
}

function Logs({ serviceId }: { serviceId: string }) {
  const [page, setPage] = useState(1);
  const [level, setLevel] = useState("");
  const q = useRadarr(serviceId, "logs", { page, level });
  return (
    <div className="space-y-2" data-testid="radarr-log">
      <select
        aria-label="Log level"
        value={level}
        onChange={(e) => {
          setLevel(e.target.value);
          setPage(1);
        }}
        className={inputAuto}
      >
        <option value="">Everything</option>
        <option value="warn">Warnings and errors</option>
        <option value="error">Errors only</option>
      </select>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <LoadError error={q.error} />
      ) : (
        <>
          <ul className="divide-y divide-line rounded-xl border border-line font-mono text-[0.76rem]">
            {q.data.records.map((l) => (
              <li key={l.id} className="px-3 py-1.5">
                <span
                  className={cx(
                    "mr-2",
                    l.level === "error" || l.level === "fatal"
                      ? "text-alert"
                      : l.level === "warn"
                        ? "text-amber"
                        : "text-faint",
                  )}
                >
                  {when(l.time)}
                </span>
                <span className="break-all text-ink">{l.message}</span>
              </li>
            ))}
          </ul>
          <Pager
            page={q.data.page}
            pageSize={q.data.pageSize}
            total={q.data.total}
            onPage={setPage}
          />
        </>
      )}
    </div>
  );
}
