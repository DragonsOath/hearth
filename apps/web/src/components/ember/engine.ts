import type { ProjectColor } from "@dragon-control/core";
/**
 * The War Room's engine: the real Claude Code and Codex, built into Hearth and working on the
 * machine Hearth runs on (apps/server/src/engine).
 */

export interface EmberEngine {
  label: string;
  enabled: boolean;
  installed?: boolean;
  version?: string;
  note?: string;
  models?: string[];
}

export interface EmberProject {
  slug: string;
  /** Hearth's old Homelab project. */
  homelab?: boolean;
  /** Kept to read its conversation; no longer a tab (the Lair tab is the homelab zone). */
  archived?: boolean;
  name?: string;
  description?: string;
  /** Its card's glow on Home. */
  color?: ProjectColor;
  path?: string;
  engine?: string;
  model?: string;
  last?: string;
}

export interface EmberVoiceChoice {
  id: string;
  label: string;
  group?: string;
}

export interface EmberConfig {
  machine?: string;
  projects: Record<string, EmberProject>;
  engines: Record<string, EmberEngine>;
  routing: { default?: string; quick_model?: string };
  voice: { speak_replies?: boolean; tts_voice?: string; choices?: EmberVoiceChoice[] };
  /** What the engine can do yet (absent: everything). */
  capabilities?: Partial<Record<"terminal" | "remote" | "github" | "usage" | "voice", boolean>>;
}

export type TaskState =
  "queued" | "awaiting_approval" | "running" | "succeeded" | "failed" | "interrupted" | "cancelled";

export interface EmberTask {
  id: number;
  title: string;
  state: TaskState;
  project: string;
  engine: string;
  model?: string | null;
  position: number;
  conversation?: boolean;
  prompt: string;
  result?: string | null;
  error?: string | null;
  attempts: number;
  max_attempts: number;
  approval_reason?: string | null;
  approved_by?: string | null;
  cost_usd?: number | null;
  report_path?: string | null;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface EmberQueue {
  paused: boolean;
  pause_reason?: string | null;
  counts: Partial<Record<TaskState, number>>;
  tasks_today: number;
  daily_cap: number;
  /** The owner's Full access switch. */
  full_access?: boolean;
  /** What the AI asks before acting: every change, risky steps, or only serious ones. */
  ask_level?: "strict" | "moderate" | "free";
}

export interface EmberSkill {
  id: string;
  name: string;
  icon?: string;
  kind?: string;
  input?: string;
  description?: string;
}

export interface EmberRemote {
  project: string;
  url?: string;
}

export interface UsageWindow {
  id: string;
  label: string;
  level: "ok" | "low" | "critical" | "unknown";
  remaining_pct: number | null;
  used_pct: number;
  resets_at?: number | null;
  reset_passed?: boolean;
}

export interface UsageEngine {
  engine: string;
  label: string;
  status: "live" | "stale" | "unavailable" | "not_installed";
  installed?: boolean;
  observed_at?: number | null;
  windows: UsageWindow[];
  note?: string;
  plan?: string;
  reset_credits?: number | null;
}

export interface EmberUsage {
  engines: UsageEngine[];
}

export interface EmberState {
  config: EmberConfig;
  tasks: EmberTask[];
  queue: EmberQueue;
  skills: EmberSkill[];
  remote?: EmberRemote[];
  usage?: EmberUsage;
}

export interface EmberMessage {
  id: number;
  project: string;
  role: "you" | "ember" | "sys" | "ask";
  text: string;
  meta?: string | null;
  task_id?: number | null;
}

export interface LogEntry {
  id: number;
  task_id: number;
  kind: "tool" | "error" | "system" | "result" | "output" | "text";
  text: string;
}

export interface Tile {
  label: string;
  value: string;
  detail?: string;
  ok?: boolean | null;
  pct?: number | null;
  type?: string;
}

export interface ProjectFile {
  path: string;
  size: number;
  mtime: number;
  kind: string;
}

export class EmberError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Body = Blob | ArrayBuffer | ArrayBufferView | object | undefined;

/**
 * Which PC's engine the War Room talks to: null is this Hearth, otherwise a PC that joined it,
 * reached through this Hearth (docs/design/ONE_ACCOUNT.md).
 */
let target: string | null = null;
export const setEngineTarget = (pc: string | null) => {
  target = pc;
};
export const engineTarget = () => target;
const apiBase = (on: string | null) => (on ? `/api/on/${on}/engine/` : "/api/engine/");

/** One call to EMBER through Hearth. JSON in and out unless `raw` (audio, notes, files). */
export async function emberFetch(
  path: string,
  opts: {
    body?: Body;
    method?: string;
    headers?: Record<string, string>;
    /** Another PC than the one the War Room is on (null: this Hearth). */
    on?: string | null;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "X-Ember-Client": "hearth", ...(opts.headers ?? {}) };
  let body: BodyInit | undefined;
  const b = opts.body;
  if (b instanceof Blob || b instanceof ArrayBuffer || ArrayBuffer.isView(b)) body = b as BodyInit;
  else if (b !== undefined) {
    body = JSON.stringify(b);
    headers["Content-Type"] = "application/json";
  }
  return fetch(`${apiBase(opts.on === undefined ? target : opts.on)}${path.replace(/^\//, "")}`, {
    method: opts.method ?? (body !== undefined ? "POST" : "GET"),
    headers,
    body,
    credentials: "same-origin",
  });
}

export async function ember<T = unknown>(
  path: string,
  opts: {
    body?: Body;
    method?: string;
    headers?: Record<string, string>;
    on?: string | null;
  } = {},
): Promise<T> {
  const r = await emberFetch(path, opts);
  const data = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!r.ok) throw new EmberError(data.message || data.error || r.statusText, r.status);
  return data as T;
}

/** The address of one of EMBER's live connections (events, or a terminal). */
export function emberSocketUrl(which: "ws" | "ws/term", query?: Record<string, string>): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = query ? `?${new URLSearchParams(query)}` : "";
  const path = target ? `/api/on/${target}/api/engine/${which}` : `/api/engine/${which}`;
  return `${proto}://${location.host}${path}${q}`;
}

/** The engine's preview address for a project's files (sandboxed; the key is the permission). */
/** A preview's address: through this PC's link, or another's (`on`; null for this Hearth). */
export const previewBase = (base: string, on?: string | null) => {
  const pc = on === undefined ? target : on;
  return pc ? `/on/${pc}${base}` : base;
};

/* ---------- formatting ---------- */

export const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

/**
 * Small, safe markdown for agent replies: the text is escaped first; only these become HTML.
 * `hearth` turns the AI's [Open X](hearth:feature) links into Hearth pages (checklist 42.2); they
 * open in a new tab so the conversation stays as it is. Without it, or for a feature with nowhere
 * to open, the words stay and the link goes.
 */
export function md(src: string, hearth?: (id: string) => string | undefined): string {
  const lines = esc(src).split("\n");
  const out: string[] = [];
  let code = false;
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  const inline = (t: string) =>
    t
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(
        /\[([^\]\n]{1,80})\]\(hearth:([a-z0-9-]{1,60})\)/g,
        (_, label: string, id: string) => {
          const href = hearth?.(id);
          return href
            ? `<a href="${esc(href)}" target="_blank" rel="noopener" data-testid="answer-open-link">${label}</a>`
            : label;
        },
      )
      .replace(
        /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
      );
  const flush = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  // Tables: a header row, a |---| line under it, then rows (they printed as raw pipes before).
  const cells = (row: string) =>
    row
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => inline(c.trim()));
  const isRule = (row?: string) =>
    /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(row ?? "");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!code && l.includes("|") && isRule(lines[i + 1])) {
      flush();
      const head = cells(l);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim())
        rows.push(cells(lines[i++]!));
      i--;
      out.push(
        `<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, k) => `<td>${r[k] ?? ""}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    if (l.trim().startsWith("```")) {
      flush();
      out.push(code ? "</code></pre>" : "<pre><code>");
      code = !code;
      continue;
    }
    if (code) {
      out.push(l + "\n");
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) {
      flush();
      out.push(`<h4>${inline(m[2] ?? "")}</h4>`);
    } else if ((m = l.match(/^\s*[-*•]\s+(.*)/)) || (m = l.match(/^\s*\d+[.)]\s+(.*)/))) {
      const tag = /^\s*\d+[.)]/.test(l) ? "ol" : "ul";
      if (para.length) {
        out.push(`<p>${inline(para.join(" "))}</p>`);
        para = [];
      }
      if (list !== tag) {
        if (list) out.push(`</${list}>`);
        out.push(`<${tag}>`);
        list = tag;
      }
      out.push(`<li>${inline(m[1] ?? "")}</li>`);
    } else if (!l.trim()) flush();
    else para.push(l);
  }
  flush();
  if (code) out.push("</code></pre>");
  return out.join("");
}

/** Only who answered ("Claude Code · sonnet"); routing and debug labels are noise. */
export const cleanMeta = (meta?: string | null) =>
  meta && /^(Claude Code|Codex)\b/.test(meta) ? meta : "";

export function ago(iso?: string | null) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  return s < 60
    ? `${Math.max(0, s | 0)}s ago`
    : s < 3600
      ? `${(s / 60) | 0}m ago`
      : s < 86400
        ? `${(s / 3600) | 0}h ago`
        : `${(s / 86400) | 0}d ago`;
}

export function dur(a?: string | null, b?: string | null) {
  if (!a) return "";
  const s = ((b ? new Date(b) : new Date()).getTime() - new Date(a).getTime()) / 1000;
  return s < 60 ? `${s | 0}s` : `${(s / 60) | 0}m ${(s % 60) | 0}s`;
}

export function updatedText(obs?: number | null) {
  if (!obs) return "updated: unknown";
  const s = Date.now() / 1000 - obs;
  return (
    "updated " +
    (s < 60
      ? "just now"
      : s < 3600
        ? `${(s / 60) | 0} min ago`
        : s < 86400
          ? `${(s / 3600) | 0} h ago`
          : `${(s / 86400) | 0} d ago`)
  );
}

export function resetText(ts?: number | null) {
  if (!ts) return "reset time not reported";
  const d = new Date(ts * 1000);
  const now = new Date();
  const hrs = (d.getTime() - now.getTime()) / 36e5;
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const when =
    hrs < 20 && d.getDate() === now.getDate()
      ? time
      : d.toLocaleDateString([], { weekday: "short" }) + " " + time;
  const left =
    hrs < 1
      ? `${Math.max(1, Math.round(hrs * 60))} min`
      : hrs < 48
        ? `${Math.floor(hrs)} h ${Math.round((hrs % 1) * 60)} min`
        : `${Math.round(hrs / 24)} days`;
  return `resets ${when} (in ${left})`;
}

export const levelWord = (l: string) =>
  ({ ok: "OK", low: "Running low", critical: "Critical", unknown: "Unknown" })[l] ?? "";

export const ACTIVE: TaskState[] = ["running", "queued", "awaiting_approval"];

export const ACTIONS: Record<TaskState, string[]> = {
  queued: ["top", "up", "down", "cancel"],
  awaiting_approval: ["approve", "cancel"],
  running: ["cancel"],
  failed: ["retry", "cancel"],
  interrupted: ["retry", "resume", "cancel"],
  cancelled: ["retry"],
  succeeded: [],
};

export const ACTION_LABEL: Record<string, string> = {
  top: "⇈",
  up: "↑",
  down: "↓",
  cancel: "cancel",
  approve: "approve",
  retry: "retry",
  resume: "resume",
};

/** A newer copy of a task never loses to an older one (a socket update can beat the reply). */
const STAGE: Record<TaskState, number> = {
  awaiting_approval: 0,
  queued: 0,
  running: 1,
  succeeded: 2,
  failed: 2,
  interrupted: 2,
  cancelled: 2,
};
export function newer(a: EmberTask, b?: EmberTask) {
  return (
    !b ||
    a.updated_at > b.updated_at ||
    (a.updated_at === b.updated_at && STAGE[a.state] >= STAGE[b.state])
  );
}

export const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode: remembered for this visit only */
    }
  },
};
