import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/**
 * The engine's records (ported from EMBER's store): tasks, their events and live log, each
 * project's conversation, and the engine's own settings. Every state change goes through
 * `transition`, which checks it against TRANSITIONS and records an event in the same transaction.
 * Nothing is deleted; "clear finished" only hides tasks from the queue view.
 *
 * It uses the database connection directly (synchronously): the engine writes a log line for
 * every step Claude takes, and these small statements must never wait behind Hearth's queue.
 */

export const STATES = [
  "queued",
  "awaiting_approval",
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
] as const;
export type TaskState = (typeof STATES)[number];
export const ACTIVE: TaskState[] = ["queued", "awaiting_approval", "running"];

const TRANSITIONS: Record<TaskState, TaskState[]> = {
  queued: ["running", "cancelled", "awaiting_approval"],
  awaiting_approval: ["queued", "cancelled"],
  running: ["succeeded", "failed", "interrupted", "cancelled"],
  failed: ["queued", "cancelled"],
  interrupted: ["queued", "cancelled"],
  cancelled: ["queued"],
  succeeded: [],
};

export interface Task {
  id: number;
  title: string;
  prompt: string;
  project: string;
  engine: string;
  model: string | null;
  state: TaskState;
  position: number;
  attempts: number;
  max_attempts: number;
  needs_approval: number;
  approval_reason: string | null;
  approved_by: string | null;
  approved_at: string | null;
  session_id: string | null;
  resume: number;
  result: string | null;
  error: string | null;
  exit_code: number | null;
  cost_usd: number | null;
  source: string | null;
  pid: number | null;
  conversation: number;
  attachments: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
}

export interface Message {
  id: number;
  project: string;
  at: string;
  role: "you" | "ember" | "sys" | "ask";
  text: string;
  meta: string | null;
  task_id: number | null;
}

export interface LogEntry {
  id: number;
  task_id: number;
  at: string;
  kind: string;
  text: string;
}

export interface ProjectRow {
  slug: string;
  name: string;
  description: string | null;
  path: string;
  created_at: string;
  archived: number;
  color: string | null;
}

export class TransitionError extends Error {}

export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

type Fields = Record<string, SQLInputValue>;

export class EngineStore {
  /** Called after a chat message is stored (the project's memory files are rewritten). */
  onMessage?: (project: string) => void;

  constructor(private readonly db: DatabaseSync) {}

  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }
  private one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as unknown as T | undefined;
  }
  private run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }
  private event(
    taskId: number,
    at: string,
    from: string | null,
    to: string | null,
    actor: string,
    detail: string,
  ) {
    this.run(
      "INSERT INTO engine_task_events (task_id, at, from_state, to_state, actor, detail) VALUES (?,?,?,?,?,?)",
      taskId,
      at,
      from,
      to,
      actor,
      detail,
    );
  }

  /* ---------- tasks ---------- */

  addTask(t: {
    title: string;
    prompt: string;
    project: string;
    engine: string;
    model: string | null;
    maxAttempts: number;
    needsApproval: boolean;
    approvalReason: string | null;
    source: string;
    actor: string;
    attachments?: string[];
    conversation?: boolean;
  }): Task {
    const at = now();
    const pos =
      (this.one<{ p: number }>("SELECT COALESCE(MAX(position), 0) AS p FROM engine_tasks")?.p ??
        0) + 1;
    const state: TaskState = t.needsApproval ? "awaiting_approval" : "queued";
    const r = this.run(
      `INSERT INTO engine_tasks (title, prompt, project, engine, model, state, position, max_attempts,
        needs_approval, approval_reason, source, created_at, updated_at, attachments, conversation)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      t.title,
      t.prompt,
      t.project,
      t.engine,
      t.model,
      state,
      pos,
      t.maxAttempts,
      t.needsApproval ? 1 : 0,
      t.approvalReason,
      t.source,
      at,
      at,
      t.attachments?.length ? JSON.stringify(t.attachments) : null,
      t.conversation ? 1 : 0,
    );
    const id = Number(r.lastInsertRowid);
    this.event(id, at, null, state, t.actor, t.approvalReason ?? "created");
    return this.get(id)!;
  }

  get(id: number): Task | undefined {
    return this.one<Task>("SELECT * FROM engine_tasks WHERE id=?", id);
  }

  /** Active tasks in run order, then the most recent finished ones. */
  list(limit = 60): Task[] {
    const q = ACTIVE.map(() => "?").join(",");
    const active = this.all<Task>(
      `SELECT * FROM engine_tasks WHERE state IN (${q})
        ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END, position`,
      ...ACTIVE,
    );
    const done = this.all<Task>(
      `SELECT * FROM engine_tasks WHERE state NOT IN (${q}) AND archived=0
        ORDER BY COALESCE(finished_at, updated_at) DESC LIMIT ?`,
      ...ACTIVE,
      limit,
    );
    return [...active, ...done];
  }

  nextQueued(busyProjects: Set<string>): Task | undefined {
    return this.all<Task>("SELECT * FROM engine_tasks WHERE state='queued' ORDER BY position").find(
      (t) => !busyProjects.has(t.project),
    );
  }

  byState(state: TaskState): Task[] {
    return this.all<Task>("SELECT * FROM engine_tasks WHERE state=?", state);
  }

  transition(
    id: number,
    to: TaskState,
    opts: { actor: string; detail?: string; fields?: Fields },
  ): Task {
    // A savepoint, not BEGIN: it also works if one of Hearth's own transactions is open.
    this.db.exec("SAVEPOINT engine_transition");
    try {
      const row = this.one<{ state: TaskState }>("SELECT state FROM engine_tasks WHERE id=?", id);
      if (!row) throw new TransitionError(`no task ${id}`);
      if (!TRANSITIONS[row.state].includes(to))
        throw new TransitionError(`task ${id}: ${row.state} -> ${to} not allowed`);
      const fields: Fields = { ...(opts.fields ?? {}), state: to, updated_at: now() };
      const keys = Object.keys(fields);
      this.run(
        `UPDATE engine_tasks SET ${keys.map((k) => `${k}=?`).join(", ")} WHERE id=?`,
        ...keys.map((k) => fields[k]!),
        id,
      );
      this.event(id, fields.updated_at as string, row.state, to, opts.actor, opts.detail ?? "");
      this.db.exec("RELEASE engine_transition");
    } catch (e) {
      this.db.exec("ROLLBACK TO engine_transition");
      this.db.exec("RELEASE engine_transition");
      throw e;
    }
    return this.get(id)!;
  }

  /** Fields other than the state (heartbeat, pid, session id). */
  update(id: number, fields: Fields) {
    const all: Fields = { ...fields, updated_at: now() };
    const keys = Object.keys(all);
    this.run(
      `UPDATE engine_tasks SET ${keys.map((k) => `${k}=?`).join(", ")} WHERE id=?`,
      ...keys.map((k) => all[k]!),
      id,
    );
  }

  note(id: number, actor: string, detail: string) {
    const st = this.get(id)?.state ?? null;
    this.event(id, now(), st, st, actor, detail);
  }

  /** Moves a waiting task up, down, or to the top. */
  move(id: number, direction: "up" | "down" | "top") {
    const rows = this.all<{ id: number; position: number }>(
      "SELECT id, position FROM engine_tasks WHERE state IN ('queued','awaiting_approval') ORDER BY position",
    );
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) throw new TransitionError("only waiting tasks can be reordered");
    if (direction === "top" && i > 0) this.update(id, { position: rows[0]!.position - 1 });
    else if (direction !== "top") {
      const j = direction === "up" ? i - 1 : i + 1;
      const other = rows[j];
      if (other) {
        this.update(id, { position: other.position });
        this.update(other.id, { position: rows[i]!.position });
      }
    }
    this.note(id, "owner", `moved ${direction}`);
  }

  clearFinished(actor: string): number {
    const q = ACTIVE.map(() => "?").join(",");
    const ids = this.all<{ id: number; state: string }>(
      `SELECT id, state FROM engine_tasks WHERE archived=0 AND state NOT IN (${q})`,
      ...ACTIVE,
    );
    const at = now();
    for (const r of ids) {
      this.run("UPDATE engine_tasks SET archived=1 WHERE id=?", r.id);
      this.event(r.id, at, r.state, r.state, actor, "cleared from the queue view");
    }
    return ids.length;
  }

  events(id: number) {
    return this.all<Record<string, unknown>>(
      "SELECT * FROM engine_task_events WHERE task_id=? ORDER BY id",
      id,
    );
  }

  counts(): Record<TaskState, number> {
    const out = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<TaskState, number>;
    for (const r of this.all<{ state: TaskState; n: number }>(
      "SELECT state, COUNT(*) AS n FROM engine_tasks GROUP BY state",
    ))
      out[r.state] = r.n;
    return out;
  }

  /* ---------- projects and conversations ---------- */

  addProject(p: { slug: string; name: string; description: string; path: string }): ProjectRow {
    this.run(
      "INSERT INTO engine_projects (slug, name, description, path, created_at) VALUES (?,?,?,?,?)",
      p.slug,
      p.name,
      p.description,
      p.path,
      now(),
    );
    return this.projectRow(p.slug)!;
  }

  projectRow(slug: string) {
    return this.one<ProjectRow>("SELECT * FROM engine_projects WHERE slug=?", slug);
  }

  projectRows(): ProjectRow[] {
    return this.all<ProjectRow>(
      "SELECT * FROM engine_projects WHERE archived=0 ORDER BY created_at",
    );
  }

  /** Tasks running right now in any project (an update would cut them off). */
  runningCount(): number {
    return (
      this.one<{ n: number }>("SELECT COUNT(*) AS n FROM engine_tasks WHERE state='running'")?.n ??
      0
    );
  }

  /** Active tasks (queued, waiting for approval, running) in a project. */
  activeIn(project: string): number {
    const q = ACTIVE.map(() => "?").join(",");
    return (
      this.one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM engine_tasks WHERE project=? AND state IN (${q})`,
        project,
        ...ACTIVE,
      )?.n ?? 0
    );
  }

  /** Everything Hearth keeps about a project: its row, conversation, tasks, and sessions. */
  deleteProject(slug: string) {
    this.db.exec("SAVEPOINT engine_delete_project");
    try {
      const tasks = "SELECT id FROM engine_tasks WHERE project=?";
      this.run(`DELETE FROM engine_task_log WHERE task_id IN (${tasks})`, slug);
      this.run(`DELETE FROM engine_task_events WHERE task_id IN (${tasks})`, slug);
      this.run("DELETE FROM engine_tasks WHERE project=?", slug);
      this.run("DELETE FROM engine_messages WHERE project=?", slug);
      this.run("DELETE FROM engine_settings WHERE key LIKE ?", `session:${slug}:%`);
      this.run("DELETE FROM engine_projects WHERE slug=?", slug);
      this.db.exec("RELEASE engine_delete_project");
    } catch (e) {
      this.db.exec("ROLLBACK TO engine_delete_project");
      this.db.exec("RELEASE engine_delete_project");
      throw e;
    }
  }

  setDescription(slug: string, description: string) {
    this.run("UPDATE engine_projects SET description=? WHERE slug=?", description, slug);
  }

  /** A project's folder moved (Settings, Projects folder). */
  setProjectPath(slug: string, dir: string) {
    this.run("UPDATE engine_projects SET path=? WHERE slug=?", dir, slug);
  }

  setName(slug: string, name: string) {
    this.run("UPDATE engine_projects SET name=? WHERE slug=?", name, slug);
  }

  /** Its color on Home, or null for the plain card. */
  setColor(slug: string, color: string | null) {
    this.run("UPDATE engine_projects SET color=? WHERE slug=?", color, slug);
  }

  addMessage(
    project: string,
    role: Message["role"],
    text: string,
    meta: string | null = null,
    taskId: number | null = null,
  ): Message {
    const at = now();
    const r = this.run(
      "INSERT INTO engine_messages (project, at, role, text, meta, task_id) VALUES (?,?,?,?,?,?)",
      project,
      at,
      role,
      text,
      meta,
      taskId,
    );
    this.onMessage?.(project);
    return { id: Number(r.lastInsertRowid), project, at, role, text, meta, task_id: taskId };
  }

  message(id: number): Message | undefined {
    return this.one<Message>("SELECT * FROM engine_messages WHERE id=?", id);
  }

  setMessageMeta(id: number, meta: string) {
    this.run("UPDATE engine_messages SET meta=? WHERE id=?", meta, id);
  }

  messages(project: string, limit = 200, before?: number): Message[] {
    return this.all<Message>(
      "SELECT * FROM engine_messages WHERE project=? AND id<? ORDER BY id DESC LIMIT ?",
      project,
      before ?? Number.MAX_SAFE_INTEGER,
      limit,
    ).reverse();
  }

  projectStats(): Record<string, { messages?: number; active?: number; last?: string }> {
    const out: Record<string, { messages?: number; active?: number; last?: string }> = {};
    for (const r of this.all<{ project: string; n: number; last: string }>(
      "SELECT project, COUNT(*) AS n, MAX(at) AS last FROM engine_messages GROUP BY project",
    ))
      out[r.project] = { messages: r.n, last: r.last };
    const q = ACTIVE.map(() => "?").join(",");
    for (const r of this.all<{ project: string; n: number }>(
      `SELECT project, COUNT(*) AS n FROM engine_tasks WHERE state IN (${q}) GROUP BY project`,
      ...ACTIVE,
    ))
      (out[r.project] ??= {}).active = r.n;
    for (const r of this.all<{ project: string; last: string }>(
      "SELECT project, MAX(updated_at) AS last FROM engine_tasks GROUP BY project",
    )) {
      const d = (out[r.project] ??= {});
      d.last = [d.last, r.last].filter(Boolean).sort().at(-1);
    }
    return out;
  }

  /* ---------- live log ---------- */

  log(taskId: number, kind: string, text: string): LogEntry {
    const at = now();
    const r = this.run(
      "INSERT INTO engine_task_log (task_id, at, kind, text) VALUES (?,?,?,?)",
      taskId,
      at,
      kind,
      text,
    );
    return { id: Number(r.lastInsertRowid), task_id: taskId, at, kind, text };
  }

  logs(taskId: number, after = 0, limit = 2000): LogEntry[] {
    return this.all<LogEntry>(
      "SELECT * FROM engine_task_log WHERE task_id=? AND id>? ORDER BY id LIMIT ?",
      taskId,
      after,
      limit,
    );
  }

  /* ---------- settings and daily counts ---------- */

  setting<T>(key: string, fallback: T): T {
    const r = this.one<{ value: string }>("SELECT value FROM engine_settings WHERE key=?", key);
    return r ? (JSON.parse(r.value) as T) : fallback;
  }

  setSetting(key: string, value: unknown) {
    if (value === undefined || value === null) {
      this.run("DELETE FROM engine_settings WHERE key=?", key);
      return;
    }
    this.run(
      "INSERT INTO engine_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  }

  bumpUsage(kind: string, n = 1): number {
    this.run(
      `INSERT INTO engine_usage (day, kind, count) VALUES (?,?,?)
        ON CONFLICT(day, kind) DO UPDATE SET count=count+?`,
      today(),
      kind,
      n,
      n,
    );
    return this.usage(kind);
  }

  usage(kind: string): number {
    return (
      this.one<{ count: number }>(
        "SELECT count FROM engine_usage WHERE day=? AND kind=?",
        today(),
        kind,
      )?.count ?? 0
    );
  }
}
