import { desc, eq, gte } from "drizzle-orm";
import {
  aiUseLevel,
  type AiBudget,
  type AiRunRecord,
  type AiUsageReport,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { getSetting, setSetting, deleteSetting } from "../store/settings";

/**
 * How much of your own AI Ember uses, and the limits you set. Every run is recorded with its
 * tokens (and the cost the AI program reports, kept for the per-run cap only: Hearth never shows
 * money, it never charges for AI). A daily limit, in runs, is checked before a run starts. Days
 * follow the server's local time.
 */

export const BUDGET_DEFAULTS: AiBudget = {
  perRunUsd: 0.5,
  warnAt: 0.8,
  // The agent's own default (the model the owner's Claude Code uses), unless they choose one.
  questionModel: "default",
  incidentModel: "default",
};

/** Local calendar day, YYYY-MM-DD. */
export function localDay(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

export interface RunUsage {
  kind: "question" | "incident";
  provider: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
  turns?: number;
  durationMs: number;
  outcome: AiRunRecord["outcome"];
  conversationId?: string;
  incidentId?: string;
}

export interface BudgetCheck {
  allowed: boolean;
  /** Why not, in plain words. */
  reason?: string;
  /** The most this run may spend (the per-run cap, or what is left today). */
  maxUsd: number;
  /** What is left of a daily dollar limit, when one is set (Full access runs only stop there). */
  dailyLeftUsd?: number;
}

export class AiUsage {
  constructor(
    private readonly handle: DbHandle,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private get db() {
    return this.handle.db;
  }

  async budget(): Promise<AiBudget> {
    const b = await getSetting(this.db, "ai_budget");
    return { ...BUDGET_DEFAULTS, ...(b ?? {}) };
  }

  async setBudget(
    patch: Partial<Omit<AiBudget, "dailyUsd" | "dailyTokens" | "dailyRuns">> & {
      dailyUsd?: number | null;
      dailyTokens?: number | null;
      dailyRuns?: number | null;
    },
  ) {
    const current = await this.budget();
    const next: AiBudget = { ...current };
    // Saving a run limit (or clearing it) replaces the older dollar and token limits.
    if (patch.dailyRuns !== undefined) {
      delete next.dailyUsd;
      delete next.dailyTokens;
    }
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete (next as unknown as Record<string, unknown>)[k];
      else if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
    }
    await setSetting(this.db, "ai_budget", next);
    return next;
  }

  async record(run: RunUsage): Promise<void> {
    const at = this.clock();
    await this.db.insert(t.aiUsage).values({
      at: at.toISOString(),
      day: localDay(at),
      kind: run.kind,
      provider: run.provider,
      model: run.model ?? null,
      inputTokens: run.inputTokens ?? 0,
      outputTokens: run.outputTokens ?? 0,
      cachedTokens: run.cachedTokens ?? 0,
      costUsd: run.costUsd ?? null,
      turns: run.turns ?? null,
      durationMs: run.durationMs,
      outcome: run.outcome,
      conversationId: run.conversationId ?? null,
      incidentId: run.incidentId ?? null,
    });
  }

  private async today() {
    const rows = await this.db
      .select()
      .from(t.aiUsage)
      .where(eq(t.aiUsage.day, localDay(this.clock())));
    return {
      costUsd: rows.reduce((s, r) => s + (r.costUsd ?? 0), 0),
      tokens: rows.reduce((s, r) => s + r.inputTokens + r.outputTokens + r.cachedTokens, 0),
      runs: rows.length,
      questions: rows.filter((r) => r.kind === "question").length,
      incidents: rows.filter((r) => r.kind === "incident").length,
    };
  }

  private share(
    b: AiBudget,
    today: { costUsd: number; tokens: number; runs: number },
  ): number | undefined {
    const shares = [
      b.dailyRuns ? today.runs / b.dailyRuns : undefined,
      b.dailyUsd ? today.costUsd / b.dailyUsd : undefined,
      b.dailyTokens ? today.tokens / b.dailyTokens : undefined,
    ].filter((x): x is number => x !== undefined);
    return shares.length ? Math.max(...shares) : undefined;
  }

  /** May an AI run start now, and how much may it spend? */
  async check(): Promise<BudgetCheck> {
    const b = await this.budget();
    const today = await this.today();
    const share = this.share(b, today);
    if (share !== undefined && share >= 1) {
      return {
        allowed: false,
        reason: b.dailyRuns
          ? `Today's AI limit is reached (${today.runs} of ${b.dailyRuns} runs). It resets at midnight.`
          : "Today's AI limit is reached. It resets at midnight.",
        maxUsd: 0,
      };
    }
    const left = b.dailyUsd ? Math.max(0, b.dailyUsd - today.costUsd) : Infinity;
    return {
      allowed: true,
      maxUsd: Math.max(0.01, Math.min(b.perRunUsd, left)),
      ...(b.dailyUsd ? { dailyLeftUsd: Math.max(0.01, left) } : {}),
    };
  }

  /** Once a day: true the first time today's use passes the warning level. */
  async crossedWarning(): Promise<boolean> {
    const b = await this.budget();
    const share = this.share(b, await this.today());
    const day = localDay(this.clock());
    if (share === undefined || share < b.warnAt) return false;
    if ((await getSetting(this.db, "ai_warned_on")) === day) return false;
    await setSetting(this.db, "ai_warned_on", day);
    return true;
  }

  async report(): Promise<AiUsageReport> {
    const b = await this.budget();
    const today = await this.today();
    const share = this.share(b, today);
    const since = localDay(new Date(this.clock().getTime() - 13 * 86_400_000));
    const rows = await this.db
      .select()
      .from(t.aiUsage)
      .where(gte(t.aiUsage.day, since))
      .orderBy(desc(t.aiUsage.id));
    const byDay = new Map<string, { day: string; costUsd: number; tokens: number; runs: number }>();
    for (const r of rows) {
      const d = byDay.get(r.day) ?? { day: r.day, costUsd: 0, tokens: 0, runs: 0 };
      d.costUsd += r.costUsd ?? 0;
      d.tokens += r.inputTokens + r.outputTokens + r.cachedTokens;
      d.runs++;
      byDay.set(r.day, d);
    }
    const week = { runs: 0, questions: 0 };
    const weekSince = localDay(new Date(this.clock().getTime() - 6 * 86_400_000));
    const perProvider = new Map<string, { id: string; today: number; week: number }>();
    const day = localDay(this.clock());
    for (const r of rows) {
      if (r.day < weekSince) continue;
      week.runs++;
      if (r.kind === "question") week.questions++;
      const one = perProvider.get(r.provider) ?? { id: r.provider, today: 0, week: 0 };
      one.week++;
      if (r.day === day) one.today++;
      perProvider.set(r.provider, one);
    }
    return {
      budget: b,
      today,
      week,
      providers: [...perProvider.values()].sort((a, b2) => b2.week - a.week),
      level: aiUseLevel(today.runs),
      usedShare: share,
      state:
        share === undefined ? "ok" : share >= 1 ? "reached" : share >= b.warnAt ? "warning" : "ok",
      days: [...byDay.values()].sort((a, b2) => b2.day.localeCompare(a.day)),
      recent: rows.slice(0, 20).map((r) => ({
        at: r.at,
        kind: r.kind,
        provider: r.provider,
        model: r.model ?? undefined,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cachedTokens: r.cachedTokens,
        costUsd: r.costUsd ?? undefined,
        turns: r.turns ?? undefined,
        durationMs: r.durationMs,
        outcome: r.outcome,
      })),
    };
  }

  /** Forget the once-a-day warning (tests). */
  async resetWarning() {
    await deleteSetting(this.db, "ai_warned_on");
  }
}
