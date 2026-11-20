import type { AnalyzerCoverage, Finding } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { addEvent } from "../monitor/engine";
import { getSetting } from "../store/settings";
import type { Findings } from "./store";
import type { Analyzer } from "./analyzers/types";

/** An analyzer that takes longer than this is stopped for this round and reported. */
const RUN_TIMEOUT_MS = 60_000;

/**
 * Runs the analyzers on the monitoring timer (each at its own interval), one at a time so a
 * slow one never piles up, and keeps a record of what each could see. Findings it opens that
 * need the owner also go in the activity feed; quieter ones only show on the dashboard.
 */
export class FindingsEngine {
  /** Passes (and exclusive work) run strictly one after another. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Called with findings opened this round, for notifications and Ember. */
  onOpened: ((opened: Finding[]) => void) | undefined;
  /**
   * Called for each finding a repair fixed and a recheck confirmed: the last step of the
   * lifecycle (discover, investigate, plan, approve, run, verify, remember).
   */
  remember: ((fixed: Finding) => Promise<void>) | undefined;

  constructor(
    private readonly handle: DbHandle,
    readonly findings: Findings,
    readonly analyzers: Analyzer[],
  ) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** An analyzer that needs what is made after the engine (the issuer, the donation service). */
  add(analyzer: Analyzer) {
    if (!this.analyzers.some((a) => a.id === analyzer.id)) this.analyzers.push(analyzer);
  }

  /** Runs the analyzers that are due (or the ones named, now). */
  tick(opts: { now?: Date; only?: string[] } = {}): Promise<Finding[]> {
    return this.serial(() => this.pass({ ...opts, now: opts.now ?? new Date() }));
  }

  /**
   * Work that replaces what the analyzers look at (switching sample data): no pass runs during
   * it, so none can record the old homelab's findings into the new one.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.serial(fn);
  }

  private async pass({ now = new Date(), only }: { now?: Date; only?: string[] }) {
    const db = this.handle.db;
    const environment = await getSetting(db, "environment");
    const runs = new Map((await db.select().from(t.analyzerRuns)).map((r) => [r.analyzer, r]));
    const opened: Finding[] = [];
    for (const analyzer of this.analyzers) {
      const last = runs.get(analyzer.id);
      const due = only
        ? only.includes(analyzer.id)
        : !last || now.getTime() - Date.parse(last.checkedAt) >= analyzer.intervalMs;
      if (!due) continue;
      const started = Date.now();
      const at = now.toISOString();
      let status: AnalyzerCoverage["status"];
      let note: string | undefined;
      let memo: unknown = last?.memo ?? null;
      try {
        const result = await Promise.race([
          analyzer.run({ handle: this.handle, now, environment, memo }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`took longer than ${RUN_TIMEOUT_MS / 1000}s`)),
              RUN_TIMEOUT_MS,
            ).unref(),
          ),
        ]);
        status = result.status;
        note = result.note;
        if (result.memo !== undefined) memo = result.memo;
        const r = await this.findings.reconcile(analyzer, result, at);
        opened.push(...r.opened);
        for (const f of r.repairedFindings) await this.remember?.(f).catch(() => undefined);
        for (const c of result.changes ?? []) {
          await addEvent(db, at, c.tone, c.text, {
            ...(c.serviceId ? { serviceId: c.serviceId } : {}),
            ...(c.hostId ? { hostId: c.hostId } : {}),
          });
        }
        // New findings are not copied into the activity feed: they are on the dashboard already,
        // and the feed is for what changed and what was done.
      } catch (error) {
        status = "unavailable";
        // Plain words for the page; a database error's full query (and its values) stays out.
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[findings] ${analyzer.id} failed:`, message.slice(0, 500));
        note = `Could not run: ${/^Failed query/.test(message) ? "saving what it found failed." : message.slice(0, 200)}`;
      }
      const row = {
        analyzer: analyzer.id,
        status,
        note: note ?? null,
        checkedAt: at,
        durationMs: Date.now() - started,
        memo: memo as never,
      };
      await db
        .insert(t.analyzerRuns)
        .values(row)
        .onConflictDoUpdate({ target: t.analyzerRuns.analyzer, set: row });
    }
    if (opened.length) this.onOpened?.(opened);
    return opened;
  }

  /** What each analyzer could see at its last run. */
  async coverage(): Promise<AnalyzerCoverage[]> {
    const runs = new Map(
      (await this.handle.db.select().from(t.analyzerRuns)).map((r) => [r.analyzer, r]),
    );
    return this.analyzers.map((a) => {
      const r = runs.get(a.id);
      return {
        id: a.id,
        label: a.label,
        status: r?.status ?? "off",
        ...(r?.note ? { note: r.note } : r ? {} : { note: "Has not run yet." }),
        ...(r ? { checkedAt: r.checkedAt } : {}),
      };
    });
  }

  /** After a linked plan finishes: record it, and recheck at once so the result shows. */
  async jobFinished(jobId: string): Promise<void> {
    const { analyzers } = await this.findings.onJobFinished(jobId);
    const known = analyzers.filter((id) => this.analyzers.some((a) => a.id === id));
    if (known.length) await this.tick({ only: known });
  }
}
