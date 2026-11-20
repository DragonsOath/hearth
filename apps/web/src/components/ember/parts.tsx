import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ACTION_LABEL,
  ACTIONS,
  ACTIVE,
  ago,
  dur,
  levelWord,
  resetText,
  updatedText,
  type EmberQueue,
  type EmberSkill,
  type EmberTask,
  type LogEntry,
  type ProjectFile,
  type Tile,
  type UsageEngine,
} from "./engine";

/** Pieces of the War Room's side columns, drawn the way EMBER draws them. */

export const COPY_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z" />
  </svg>
);
const DONE_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" />
  </svg>
);

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers or no clipboard permission: a hidden text box.
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    let ok: boolean;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function CopyButton({ text }: { text: () => string }) {
  const [done, setDone] = useState<boolean | null>(null);
  const t = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(t.current), []);
  return (
    <button
      type="button"
      className={`copy${done ? " done" : ""}`}
      title={done === null ? "Copy" : done ? "Copied" : "Copy failed"}
      aria-label={done === null ? "Copy" : done ? "Copied" : "Copy failed"}
      onClick={(e) => {
        e.stopPropagation();
        void copyText(text()).then((ok) => {
          setDone(ok);
          window.clearTimeout(t.current);
          t.current = window.setTimeout(() => setDone(null), 1500);
        });
      }}
    >
      {done ? DONE_ICON : COPY_ICON}
    </button>
  );
}

/* ---------- usage ---------- */

const USTATUS: Record<string, string> = {
  live: "Live",
  stale: "Stale",
  unavailable: "No data",
  not_installed: "Not installed",
};

export function UsagePanel({
  engines,
  onRefresh,
}: {
  engines: UsageEngine[];
  onRefresh: (engine: string) => void;
}) {
  const [refreshing, setRefreshing] = useState<string | null>(null);
  // Once a second, so "updated N min ago" and the countdowns stay true.
  const [, tick] = useState(0);
  useEffect(() => {
    const i = window.setInterval(() => tick((n) => n + 1), 15000);
    return () => window.clearInterval(i);
  }, []);
  if (!engines.length) return <p className="muted">No usage reading yet.</p>;
  return (
    <>
      {engines.map((e) => (
        <section key={e.engine} className={`ue ue-${e.status}`} aria-label={`${e.label} usage`}>
          <div className="ue-head">
            <b>{e.label}</b>
            <span className={`badge b-${e.status}`}>{USTATUS[e.status] ?? e.status}</span>
            {e.installed && (
              <button
                type="button"
                className="ue-refresh"
                disabled={refreshing === e.engine}
                title={
                  e.engine === "codex"
                    ? "Ask Codex for current limits (no model call)"
                    : "Claude has no free usage check: this makes one tiny Haiku call"
                }
                onClick={() => {
                  setRefreshing(e.engine);
                  Promise.resolve(onRefresh(e.engine)).finally(() => setRefreshing(null));
                }}
              >
                ↻ {e.engine === "codex" ? "check" : "check (1 tiny call)"}
              </button>
            )}
            <span className="ue-upd">{e.observed_at ? updatedText(e.observed_at) : ""}</span>
          </div>
          {e.windows.map((w) => {
            const rem = w.remaining_pct;
            return (
              <div key={w.id} className={`uw lvl-${w.level}`}>
                <div className="uw-top">
                  <span className="uw-name">{w.label}</span>
                  <span className="uw-rem">
                    <span className="num">{rem == null ? "—" : `${Math.round(rem)}%`}</span>{" "}
                    <small>left</small>
                  </span>
                </div>
                <div
                  className="ubar"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={rem == null ? undefined : Math.round(rem)}
                  aria-valuetext={
                    rem == null
                      ? `${w.label}: unknown, ${e.status}`
                      : `${w.label}: ${Math.round(rem)} percent remaining, ${levelWord(w.level)}, ${resetText(w.resets_at)}${e.status === "stale" ? ", reading is stale" : ""}`
                  }
                  aria-label={`${e.label} ${w.label} allowance remaining`}
                >
                  <span className="fill" style={{ width: rem == null ? "0%" : `${rem}%` }} />
                </div>
                <div className="uw-sub">
                  <span className="used">
                    {w.reset_passed
                      ? "window has reset since this reading"
                      : `${Math.round(w.used_pct)}% used`}
                  </span>
                  <span className="rst">{w.reset_passed ? "" : resetText(w.resets_at)}</span>
                  <span className="lvl-tag">
                    {w.level === "ok" ? "" : "▲ " + levelWord(w.level)}
                  </span>
                </div>
              </div>
            );
          })}
          {e.note && <p className="ue-note">{e.note}</p>}
          {(e.plan || e.reset_credits != null) && (
            <div className="ue-extra">
              {e.plan ? `plan ${e.plan}` : ""}
              {e.reset_credits != null
                ? ` · ${e.reset_credits} reset credit${e.reset_credits === 1 ? "" : "s"} available`
                : ""}
            </div>
          )}
        </section>
      ))}
    </>
  );
}

/* ---------- systems and skills ---------- */

export function Tiles({ tiles }: { tiles: Tile[] }) {
  return (
    <>
      {tiles.map((t) => (
        <div key={t.label} className={`tile ${t.ok === true ? "ok" : t.ok === false ? "bad" : ""}`}>
          <div className="l">{t.label}</div>
          <div className="v">{t.value}</div>
          <div className="d" title={t.detail}>
            {t.detail}
          </div>
          {t.pct != null && (
            <div className="bar">
              <span style={{ width: `${Math.min(100, t.pct)}%` }} />
            </div>
          )}
        </div>
      ))}
    </>
  );
}

export function Skills({
  skills,
  onRun,
}: {
  skills: EmberSkill[];
  onRun: (s: EmberSkill) => void;
}) {
  if (!skills.length) return <p className="muted">No skills. Add .md files to vault/Skills.</p>;
  return (
    <>
      {skills.map((s) => (
        <button
          key={s.id}
          type="button"
          className="skill"
          title={s.description ?? ""}
          onClick={() => onRun(s)}
        >
          <div className="ic">{s.icon}</div>
          <div className="n">{s.name}</div>
          <div className="k">
            {s.kind}
            {s.input ? ` · asks: ${s.input}` : ""}
          </div>
        </button>
      ))}
    </>
  );
}

/* ---------- project files ---------- */

const HIDE = /^(\.ember\/|CLAUDE\.md$|AGENTS\.md$|\.gitignore$)/;
const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(0)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;

export function FilesList({
  files,
  previewBase,
  onOpen,
  onMore,
}: {
  files: ProjectFile[] | null;
  previewBase: string | null;
  onOpen: (f: ProjectFile) => void;
  onMore: () => void;
}) {
  if (!files) return <p className="muted">Loading…</p>;
  const shown = files.filter((f) => !HIDE.test(f.path)).sort((a, b) => b.mtime - a.mtime);
  const docs = shown.filter(
    (f) =>
      f.kind === "markdown" ||
      (f.kind === "text" && /\.(txt|pdf)$/i.test(f.path)) ||
      f.kind === "pdf",
  );
  const pics = shown.filter((f) => f.kind === "image");
  const rest = shown.filter((f) => !docs.includes(f) && !pics.includes(f));
  if (!shown.length)
    return (
      <p className="muted">
        No files yet. Add your documents and photos here; the agent reads them as part of this
        project.
      </p>
    );
  const row = (f: ProjectFile, icon: ReactNode) => (
    <a
      key={f.path}
      href="#"
      title={f.path}
      onClick={(e) => {
        e.preventDefault();
        onOpen(f);
      }}
    >
      <span className="ic">
        {f.kind === "image" && previewBase ? (
          <img
            src={previewBase + f.path.split("/").map(encodeURIComponent).join("/")}
            alt=""
            loading="lazy"
          />
        ) : (
          icon
        )}
      </span>
      <span className="nm">{f.path.split("/").pop()}</span>
      <span className="sz">{size(f.size)}</span>
    </a>
  );
  return (
    <>
      {docs.length > 0 && <div className="grp">Documents</div>}
      {docs.map((f) => row(f, "¶"))}
      {pics.length > 0 && <div className="grp">Photos</div>}
      {pics.slice(0, 30).map((f) => row(f, "▣"))}
      {rest.length > 0 && <div className="grp">Code and other</div>}
      {rest.slice(0, 8).map((f) => row(f, "{ }"))}
      {rest.length > 8 && (
        <a
          className="more"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onMore();
          }}
        >
          and {rest.length - 8} more in Artifacts…
        </a>
      )}
    </>
  );
}

/* ---------- queue ---------- */

export function QueueList({
  tasks,
  sel,
  engineLabel,
  emptyEngine,
  onSelect,
  onAct,
}: {
  tasks: EmberTask[];
  sel: number | null;
  engineLabel: (e: string) => string;
  emptyEngine: string;
  onSelect: (id: number) => void;
  onAct: (id: number, act: string) => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const i = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(i);
  }, []);
  const active = tasks
    .filter((t) => ACTIVE.includes(t.state))
    .sort((a, b) =>
      a.state === "running" ? -1 : b.state === "running" ? 1 : a.position - b.position,
    );
  const done = tasks
    .filter((t) => !ACTIVE.includes(t.state))
    .sort((a, b) => (b.finished_at || b.updated_at).localeCompare(a.finished_at || a.updated_at))
    .slice(0, 40);
  const row = (t: EmberTask) => (
    <div
      key={t.id}
      className={`task s-${t.state} ${sel === t.id ? "sel" : ""}`}
      onClick={() => onSelect(t.id)}
      onKeyDown={(e) => e.key === "Enter" && onSelect(t.id)}
      role="button"
      tabIndex={0}
      data-testid={`ember-task-${t.id}`}
    >
      <div className="row1">
        <span className="id">#{t.id}</span>
        <span className="t">{t.title}</span>
        <span className={`chip s-${t.state}`}>{t.state.replace("_", " ")}</span>
      </div>
      <div className="row2">
        <span className={`eng eng-${t.engine}`}>{engineLabel(t.engine)}</span>
        <span>{t.project}</span>
        <span>{t.model || "default model"}</span>
        <span>
          {t.state === "running" ? dur(t.started_at) : ago(t.finished_at || t.created_at)}
        </span>
        <span className="acts">
          {ACTIONS[t.state].map((a) => (
            <button
              key={a}
              type="button"
              className={
                a === "approve"
                  ? "act-approve"
                  : a === "cancel" && t.state === "awaiting_approval"
                    ? "act-cancel"
                    : undefined
              }
              aria-label={`${a} task ${t.id}`}
              onClick={(e) => {
                e.stopPropagation();
                onAct(t.id, a);
              }}
            >
              {ACTION_LABEL[a]}
            </button>
          ))}
        </span>
      </div>
    </div>
  );
  return (
    <>
      {active.length ? (
        active.map(row)
      ) : (
        <p className="muted">
          Nothing waiting. Press <b>+ Add task</b> to give {emptyEngine} something to do.
        </p>
      )}
      {done.length > 0 && <div className="sec">Finished</div>}
      {done.map(row)}
    </>
  );
}

export function queueSummary(q: EmberQueue | null) {
  const c = q?.counts ?? {};
  return `${c.running ?? 0} running · ${c.queued ?? 0} waiting · ${q?.tasks_today ?? 0}/${q?.daily_cap ?? "?"} today`;
}

const LOG_ICON: Record<string, string> = {
  tool: "▸ ",
  error: "✖ ",
  system: "◆ ",
  result: "■ ",
  output: "  ",
  text: "",
};

export function TaskDetail({
  task,
  log,
  engineLabel,
  onAct,
  onReport,
}: {
  task: EmberTask;
  log: LogEntry[];
  engineLabel: (e: string) => string;
  onAct: (act: string) => void;
  onReport: (path: string) => void;
}) {
  const t = task;
  const acts = ACTIONS[t.state].filter((a) => !["up", "down", "top"].includes(a));
  return (
    <>
      <div className="kv">
        <span>engine</span>
        <span>
          {engineLabel(t.engine)} · {t.model || "default model"}
        </span>
        <span>project</span>
        <span>{t.project}</span>
        <span>attempts</span>
        <span>
          {t.attempts} of {t.max_attempts}
        </span>
        <span>started</span>
        <span>
          {t.started_at
            ? `${new Date(t.started_at).toLocaleTimeString()} · ${dur(t.started_at, t.finished_at)}`
            : "not yet"}
        </span>
        {t.approval_reason && (
          <>
            <span>approval</span>
            <span>
              {t.approval_reason}
              {t.approved_by ? ` · approved by ${t.approved_by}` : ""}
            </span>
          </>
        )}
        {t.report_path && (
          <>
            <span>report</span>
            <span>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  onReport(t.report_path!);
                }}
              >
                {t.report_path}
              </a>
            </span>
          </>
        )}
      </div>
      <div className="acts">
        {acts.map((a) => (
          <button
            key={a}
            type="button"
            className={`btn small ${a === "approve" ? "act-approve" : a === "cancel" && t.state === "awaiting_approval" ? "act-cancel" : ""}`}
            onClick={() => onAct(a)}
          >
            {a}
          </button>
        ))}
      </div>
      <div className="sec">Request</div>
      <div className="box">
        <span className="txt">{t.prompt}</span>
        <CopyButton text={() => t.prompt} />
      </div>
      {t.result && (
        <>
          <div className="sec">Result</div>
          <div className="box result">
            <span className="txt">{t.result}</span>
            <CopyButton text={() => t.result ?? ""} />
          </div>
        </>
      )}
      {t.error && (
        <>
          <div className="sec">Problem</div>
          <div className="box error">
            <span className="txt">{t.error}</span>
            <CopyButton text={() => t.error ?? ""} />
          </div>
        </>
      )}
      <div className="sec">Live progress</div>
      <div className="log">
        {log.map((e) => (
          <div key={e.id} className={`k-${e.kind}`}>
            {(LOG_ICON[e.kind] ?? "") + e.text}
          </div>
        ))}
      </div>
    </>
  );
}
