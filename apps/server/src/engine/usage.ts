import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { cleanEnv, killTree } from "./runners";
import type { EngineStore } from "./store";

/**
 * How much of your Claude Code and Codex limits is left. Shows only readings an engine reported;
 * it never estimates.
 *
 * Claude Code: every stream-json run (War Room tasks) reports a `rate_limit_event` with the
 * five-hour and weekly windows. There is no free "read my usage" call, so between runs the
 * reading ages and turns stale; the refresh button makes one tiny Haiku call to get a new one.
 * Codex: `codex app-server` answers `account/rateLimits/read` without starting a model session.
 */

export interface UsageWindow {
  id: string;
  label: string;
  used_pct: number | null;
  resets_at: number | null;
  remaining_pct?: number | null;
  level?: "ok" | "low" | "critical" | "unknown";
  reset_passed?: boolean;
}

export interface UsageReading {
  observed_at: number | null;
  source: string;
  windows: UsageWindow[];
  plan?: string | null;
  reset_credits?: number | null;
}

const LOW = 25;
const CRITICAL = 10;
const STALE_S = 30 * 60;
const CODEX_POLL_S = 300;

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function window(id: string, label: string, used: unknown, resetsAt: unknown): UsageWindow | null {
  if (!num(used) || used < 0 || used > 100) return null;
  return {
    id,
    label,
    used_pct: Math.round(used * 10) / 10,
    resets_at: num(resetsAt) && resetsAt > 0 ? resetsAt : null,
  };
}

const label = (minutes: number) =>
  minutes === 300
    ? "5-hour"
    : minutes === 10080
      ? "Weekly"
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}-hour`
        : `${Math.floor(minutes / 1440)}-day`;

/** Claude Code's `rate_limit_info` (from a stream-json run) as a reading. */
export function claudeReading(info: unknown, observedAt = Date.now() / 1000): UsageReading | null {
  const w = ((info as Record<string, unknown> | null)?.unifiedWindows ?? {}) as Record<
    string,
    { utilization?: unknown; resetsAt?: unknown }
  >;
  const windows: UsageWindow[] = [];
  for (const [key, name] of [
    ["five_hour", "5-hour"],
    ["seven_day", "Weekly"],
  ] as const) {
    const x = w[key];
    if (x && num(x.utilization)) {
      const win = window(key, name, 100 * x.utilization, x.resetsAt);
      if (win) windows.push(win);
    }
  }
  return windows.length
    ? { observed_at: observedAt, source: "Claude Code rate-limit report", windows }
    : null;
}

/** `codex app-server` `account/rateLimits/read` result as a reading. */
export function codexReading(result: unknown, observedAt = Date.now() / 1000): UsageReading | null {
  const r = (result ?? {}) as Record<string, unknown>;
  const buckets = (r.rateLimitsByLimitId ?? {}) as Record<string, Record<string, unknown>>;
  const bucket = (buckets.codex ?? r.rateLimits ?? Object.values(buckets)[0]) as
    Record<string, unknown> | undefined;
  if (!bucket || typeof bucket !== "object") return null;
  const windows: UsageWindow[] = [];
  for (const lane of ["primary", "secondary"]) {
    const x = bucket[lane] as Record<string, unknown> | undefined;
    if (x && num(x.windowDurationMins)) {
      const win = window(lane, label(x.windowDurationMins), x.usedPercent, x.resetsAt);
      if (win) windows.push(win);
    }
  }
  if (!windows.length) return null;
  const credits = (r.rateLimitResetCredits as Record<string, unknown> | undefined)?.availableCount;
  return {
    observed_at: observedAt,
    source: "Codex limits check",
    windows,
    plan: typeof bucket.planType === "string" ? bucket.planType : null,
    reset_credits: num(credits) ? credits : null,
  };
}

/** Ask Codex for its limits (no model call). */
function readCodex(binary: string, timeoutMs = 15_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["app-server"], {
      env: cleanEnv(),
      cwd: homedir(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const done = (v: unknown, err?: Error) => {
      clearTimeout(t);
      if (child.pid) killTree(child.pid, true);
      if (err) reject(err);
      else resolve(v);
    };
    const t = setTimeout(() => done(null, new Error("Codex did not answer in time")), timeoutMs);
    child.on("error", (e) => done(null, e));
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const d = JSON.parse(line) as { id?: number; result?: unknown };
        if (d.id === 2) done(d.result);
      } catch {
        // Not JSON: ignore.
      }
    });
    const msgs = [
      {
        method: "initialize",
        id: 0,
        params: { clientInfo: { name: "hearth", title: "Hearth", version: "1" } },
      },
      { method: "initialized", params: {} },
      { method: "account/rateLimits/read", id: 2 },
    ];
    child.stdin.write(msgs.map((m) => JSON.stringify(m) + "\n").join(""));
  });
}

/** One tiny Haiku call, only to get Claude Code's rate-limit report. */
function readClaude(binary: string, timeoutMs = 90_000): Promise<unknown> {
  return new Promise((resolve) => {
    const child = spawn(
      binary,
      [
        "-p",
        "Reply with OK.",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "haiku",
        "--tools",
        "",
        "--no-session-persistence",
      ],
      { env: cleanEnv(), cwd: homedir(), windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    let info: unknown = null;
    const t = setTimeout(() => child.pid && killTree(child.pid, true), timeoutMs);
    child.on("error", () => resolve(null));
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const ev = JSON.parse(line) as { type?: string; rate_limit_info?: unknown };
        if (ev.type === "rate_limit_event") info = ev.rate_limit_info;
      } catch {
        // Not JSON: ignore.
      }
    });
    child.on("close", () => {
      clearTimeout(t);
      resolve(info);
    });
  });
}

export class Usage {
  private claude: UsageReading | null;
  private codex: UsageReading | null;
  private codexError: string | null = null;
  private codexBusy: Promise<void> | null = null;
  private lastCodexTry = 0;

  constructor(
    private readonly store: EngineStore,
    private readonly engines: Record<string, { label: string; binary: string | null }>,
    private readonly broadcast: (ev: Record<string, unknown>) => void,
    private readonly fake = false,
  ) {
    this.claude = store.setting<UsageReading | null>("usage.claude", null);
    this.codex = store.setting<UsageReading | null>("usage.codex", null);
    if (!this.claude) {
      // A report saved before the monitor existed: shown, but as stale (its time is unknown).
      const old = claudeReading(store.setting<unknown>("rate_limit", null));
      if (old) this.claude = { ...old, observed_at: null };
    }
  }

  /** Every War Room run reports its rate limits here. */
  onClaudeReport(info: unknown) {
    const r = claudeReading(info);
    if (!r) return;
    this.claude = r;
    this.store.setSetting("usage.claude", r);
    this.push();
  }

  async refresh(engine: string) {
    if (engine === "codex") await this.refreshCodex(true);
    else if (engine === "claude-code") {
      const bin = this.engines["claude-code"]?.binary;
      if (bin && !this.fake) this.onClaudeReport(await readClaude(bin));
    }
    return this.snapshot();
  }

  /** Codex is checked at most every five minutes, while someone has the War Room open. */
  refreshCodex(force = false): Promise<void> {
    const bin = this.engines.codex?.binary;
    if (!bin || this.fake) return Promise.resolve();
    if (!force && Date.now() / 1000 - this.lastCodexTry < CODEX_POLL_S) return Promise.resolve();
    this.codexBusy ??= (async () => {
      this.lastCodexTry = Date.now() / 1000;
      try {
        const r = codexReading(await readCodex(bin));
        if (r) {
          this.codex = r;
          this.codexError = null;
          this.store.setSetting("usage.codex", r);
        } else this.codexError = "Codex gave no limits reading.";
      } catch (e) {
        this.codexError = `Codex did not answer: ${(e as Error).message}`;
      }
      this.push();
    })().finally(() => (this.codexBusy = null));
    return this.codexBusy;
  }

  private push() {
    this.broadcast({ type: "usage", usage: this.snapshot() });
  }

  private engine(id: string, reading: UsageReading | null, error: string | null, empty: string) {
    const label = this.engines[id]?.label ?? id;
    const installed = Boolean(this.engines[id]?.binary);
    const out = {
      engine: id,
      label,
      installed,
      windows: [] as UsageWindow[],
      observed_at: null as number | null,
      source: null as string | null,
      status: "unavailable" as "live" | "stale" | "unavailable" | "not_installed",
      note: empty as string | undefined,
      plan: undefined as string | undefined,
      reset_credits: null as number | null,
    };
    if (!installed)
      return { ...out, status: "not_installed" as const, note: `${label} isn't installed here.` };
    if (!reading) return error ? { ...out, note: error } : out;
    const now = Date.now() / 1000;
    const age = reading.observed_at ? now - reading.observed_at : null;
    const stale = age == null || age > STALE_S;
    out.observed_at = reading.observed_at;
    out.source = reading.source;
    out.status = stale ? "stale" : "live";
    out.plan = reading.plan ?? undefined;
    out.reset_credits = reading.reset_credits ?? null;
    out.note = stale
      ? age == null
        ? "Reading time unknown."
        : `Last reading is ${Math.floor(age / 60)} min old.`
      : undefined;
    if (stale && error) out.note = `${out.note} ${error}`;
    out.windows = reading.windows.map((w) => {
      if (w.resets_at && w.resets_at <= now)
        // The window reset after this reading, so the old number no longer applies.
        return { ...w, used_pct: null, remaining_pct: null, level: "unknown", reset_passed: true };
      const rem = Math.round((100 - (w.used_pct ?? 0)) * 10) / 10;
      return {
        ...w,
        remaining_pct: rem,
        level: rem <= CRITICAL ? "critical" : rem <= LOW ? "low" : "ok",
        reset_passed: false,
      };
    });
    return out;
  }

  snapshot() {
    return {
      now: Date.now() / 1000,
      thresholds: { low: LOW, critical: CRITICAL, stale_minutes: STALE_S / 60 },
      engines: [
        this.engine(
          "claude-code",
          this.claude,
          null,
          "No reading yet. It appears after the next Claude Code task, or press check.",
        ),
        this.engine("codex", this.codex, this.codexError, "No reading yet."),
      ],
    };
  }
}
