import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  FINDING_ACTIVE,
  findingPriority,
  type Finding,
  type FindingDetail,
  type FindingEvent,
  type FindingEventKind,
  type FindingEvidence,
  type FindingKind,
  type FindingNature,
  type FindingPattern,
  type FindingResource,
  type FindingSeverity,
  type FindingSource,
  type FindingStatus,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withTransaction } from "../db/tx";
import { redactTranscript } from "../memory/redact";
import { ForbiddenError, InvalidRequestError, NotFoundError } from "../store/errors";
import { clock } from "./analyzers/types";

/**
 * The findings store. Analyzers report what they see (drafts) and what they were able to look
 * at (coverage); reconcile() turns that into findings that are opened once, updated as evidence
 * changes, and resolved only when the analyzer looked again and the condition was gone. A
 * condition that comes back within a day reopens the same finding instead of making a new one,
 * so a flapping problem is one finding with a count, not a stream of alerts.
 *
 * Context it keeps, so Hearth does not overstate or repeat itself: what kind of trouble it is
 * (nature), how it has behaved (new, ongoing, recurring, back after a repair), and what the
 * owner accepted (an acceptance holds while the condition keeps the same signature and is no
 * more serious; anything new about it is raised again).
 */

type Row = typeof t.findings.$inferSelect;
type Db = DbHandle["db"];
export type Actor = FindingEvent["actor"];

export interface FindingDraft {
  key: string;
  kind: FindingKind;
  severity: FindingSeverity;
  title: string;
  summary: string;
  why: string;
  nextSteps: string[];
  evidence: FindingEvidence[];
  resources: FindingResource[];
  serviceId?: string;
  hostId?: string;
  incidentId?: string;
  /** Sightings in a row before it is shown (default 1: at once). */
  confirmAfter?: number;
  /** What kind of trouble (default from the kind: problems fail, the rest is upkeep or state). */
  nature?: FindingNature;
  /**
   * What makes it the same condition, for acceptances (default: kind and severity). Analyzers
   * set it to what matters: which containers are stopped, which apps share a setting.
   */
  signature?: string;
}

/** A change worth showing in the activity feed (an update, a new container). */
export interface AnalyzerChange {
  tone: "good" | "neutral" | "attention";
  text: string;
  serviceId?: string;
  hostId?: string;
}

export interface AnalyzerResult {
  /** ok: it saw everything it covers. partial: some of it. unavailable: nothing. */
  status: "ok" | "partial" | "unavailable" | "off";
  note?: string;
  drafts: FindingDraft[];
  /** Whether it looked at this key's subject this run (so its absence means it is gone). */
  covered: (key: string) => boolean;
  changes?: AnalyzerChange[];
  /** What to say when it resolves one of its findings, when it knows better than the default. */
  resolution?: (finding: { key: string; title: string }) => string | undefined;
  /** Whether a finding it resolves was fixed by a repair (not on its own), when it knows. */
  repaired?: (finding: { key: string }) => boolean;
  /** State to keep for the next run. */
  memo?: unknown;
}

/** A condition that comes back within this long reopens the same finding. */
export const REOPEN_WINDOW_MS = 24 * 3_600_000;
/** After a repair, longer: a fix that fails within a week did not hold. */
export const REPAIR_HOLD_MS = 7 * 24 * 3_600_000;
/** First seen less than this long ago: new. */
const NEW_MS = 3_600_000;

const defaultNature = (kind: FindingKind): FindingNature =>
  kind === "problem" || kind === "suspected"
    ? "failure"
    : kind === "recommendation"
      ? "maintenance"
      : "state";

const signatureOf = (d: Pick<FindingDraft, "signature" | "kind" | "severity">) =>
  d.signature ?? `${d.kind}|${d.severity}`;

export function patternOf(
  row: Pick<Row, "returnedAfterRepair" | "occurrences" | "firstSeenAt" | "lastSeenAt">,
): FindingPattern {
  if (row.returnedAfterRepair) return "returned-after-repair";
  if (row.occurrences > 1) return "recurring";
  return Date.parse(row.lastSeenAt) - Date.parse(row.firstSeenAt) >= NEW_MS ? "ongoing" : "new";
}
const MAX_EVIDENCE = 12;

const ACTIVE_OR_CANDIDATE: FindingStatus[] = [...FINDING_ACTIVE, "candidate"];

const newId = () => `fnd-${randomBytes(4).toString("hex")}`;

function rowToFinding(row: Row, awaitingApproval = false, acceptedNote?: string): Finding {
  const plannable = row.kind === "problem" || row.kind === "suspected";
  const pattern = patternOf(row);
  return {
    id: row.id,
    number: row.number,
    key: row.key,
    source: row.source as FindingSource,
    analyzer: row.analyzer,
    kind: row.kind,
    severity: row.severity,
    nature: row.nature,
    status: row.status,
    pattern,
    title: row.title,
    summary: row.summary,
    why: row.why,
    nextSteps: row.nextSteps,
    evidence: row.evidence,
    resources: row.resources as FindingResource[],
    ...(row.serviceId ? { serviceId: row.serviceId } : {}),
    ...(row.hostId ? { hostId: row.hostId } : {}),
    ...(row.incidentId ? { incidentId: row.incidentId } : {}),
    ...(row.jobId ? { jobId: row.jobId } : {}),
    ...(row.todoId ? { todoId: row.todoId } : {}),
    ...(row.conversationId ? { conversationId: row.conversationId } : {}),
    createdBy: row.createdBy,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    checkedAt: row.checkedAt,
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {}),
    ...(row.resolution ? { resolution: row.resolution } : {}),
    occurrences: row.occurrences,
    ...(row.snoozedUntil ? { snoozedUntil: row.snoozedUntil } : {}),
    ...(acceptedNote ? { acceptedNote } : {}),
    priority: findingPriority({ ...row, awaitingApproval, pattern }),
    plannable,
  };
}

const SEVERITY_ORDER: FindingSeverity[] = ["info", "low", "medium", "high", "critical"];

export async function addFindingEvent(
  db: Db,
  findingId: string,
  at: string,
  kind: FindingEventKind,
  actor: Actor,
  text: string,
) {
  await db.insert(t.findingEvents).values({ findingId, at, kind, actor, text });
}

export class Findings {
  constructor(private readonly handle: DbHandle) {}

  private get db() {
    return this.handle.db;
  }

  /** Jobs still waiting for the owner, among those linked to these findings. */
  private async awaiting(rows: Row[]): Promise<Set<string>> {
    const ids = rows.map((r) => r.jobId).filter((x): x is string => Boolean(x));
    if (!ids.length) return new Set();
    const jobs = await this.db
      .select({ id: t.jobs.id })
      .from(t.jobs)
      .where(and(inArray(t.jobs.id, ids), eq(t.jobs.status, "awaiting-approval")));
    return new Set(jobs.map((j) => j.id));
  }

  private async toFindings(rows: Row[]): Promise<Finding[]> {
    const waiting = await this.awaiting(rows);
    const accepted = rows.filter((r) => r.status === "accepted").map((r) => r.key);
    const notes = new Map(
      accepted.length
        ? (
            await this.db
              .select()
              .from(t.findingAcceptances)
              .where(inArray(t.findingAcceptances.key, accepted))
          ).map((a) => [a.key, a.note ?? ""])
        : [],
    );
    return rows.map((r) =>
      rowToFinding(r, Boolean(r.jobId && waiting.has(r.jobId)), notes.get(r.key) || undefined),
    );
  }

  async list(
    opts: {
      status?: "active" | "resolved" | "dismissed" | "accepted" | "all";
      serviceId?: string;
      limit?: number;
      /** Leave out findings the owner snoozed until later. */
      hideSnoozed?: boolean;
      now?: Date;
    } = {},
  ): Promise<Finding[]> {
    const status = opts.status ?? "active";
    const wanted: FindingStatus[] =
      status === "active"
        ? [...FINDING_ACTIVE]
        : status === "resolved"
          ? ["resolved"]
          : status === "dismissed"
            ? ["dismissed"]
            : status === "accepted"
              ? ["accepted"]
              : [...FINDING_ACTIVE, "resolved", "dismissed", "accepted"];
    const rows = await this.db
      .select()
      .from(t.findings)
      .where(
        and(
          inArray(t.findings.status, wanted),
          opts.serviceId ? eq(t.findings.serviceId, opts.serviceId) : undefined,
        ),
      )
      .orderBy(desc(t.findings.lastSeenAt))
      .limit(Math.min(opts.limit ?? 200, 500));
    const now = (opts.now ?? new Date()).toISOString();
    const visible = opts.hideSnoozed
      ? rows.filter((r) => !r.snoozedUntil || r.snoozedUntil <= now)
      : rows;
    const list = await this.toFindings(visible);
    return status === "active"
      ? list.sort((a, b) => b.priority - a.priority || b.lastSeenAt.localeCompare(a.lastSeenAt))
      : list;
  }

  private async row(idOrNumber: string): Promise<Row> {
    const n = /^(?:F-?)?(\d+)$/i.exec(idOrNumber.trim());
    const row = await this.db
      .select()
      .from(t.findings)
      .where(n ? eq(t.findings.number, Number(n[1])) : eq(t.findings.id, idOrNumber))
      .get();
    if (!row || row.status === "candidate") throw new NotFoundError("No such finding.");
    return row;
  }

  async get(idOrNumber: string): Promise<FindingDetail> {
    const row = await this.row(idOrNumber);
    const events = await this.db
      .select()
      .from(t.findingEvents)
      .where(eq(t.findingEvents.findingId, row.id))
      .orderBy(t.findingEvents.id);
    const [finding] = await this.toFindings([row]);
    return {
      ...finding!,
      events: events.map((e) => ({
        at: e.at,
        kind: e.kind as FindingEventKind,
        actor: e.actor,
        text: e.text,
      })),
    };
  }

  /** Findings that changed state since a time (opened or resolved), for "what's changed". */
  async changedSince(since: string): Promise<{ opened: Finding[]; resolved: Finding[] }> {
    const opened = await this.db
      .select()
      .from(t.findings)
      .where(
        and(
          sql`${t.findings.firstSeenAt} > ${since}`,
          inArray(t.findings.status, [...FINDING_ACTIVE]),
        ),
      )
      .orderBy(desc(t.findings.firstSeenAt))
      .limit(50);
    const resolved = await this.db
      .select()
      .from(t.findings)
      .where(and(eq(t.findings.status, "resolved"), sql`${t.findings.resolvedAt} > ${since}`))
      .orderBy(desc(t.findings.resolvedAt))
      .limit(50);
    return { opened: await this.toFindings(opened), resolved: await this.toFindings(resolved) };
  }

  private async nextNumber(): Promise<number> {
    const r = await this.db
      .select({ n: sql<number>`coalesce(max(${t.findings.number}), 0)` })
      .from(t.findings)
      .get();
    return (r?.n ?? 0) + 1;
  }

  /**
   * Applies one analyzer run. Returns the findings it opened (shown for the first time) and
   * how many it resolved. Runs in one transaction so the dashboard never sees half a run.
   */
  async reconcile(
    analyzer: { id: string; source: FindingSource },
    result: AnalyzerResult,
    at: string,
  ): Promise<{
    opened: Finding[];
    resolved: number;
    resolvedFindings: Finding[];
    /** Resolved by a repair (a plan whose checks passed, or Hearth's own fix). */
    repairedFindings: Finding[];
  }> {
    const db = this.db;
    const opened: Row[] = [];
    const resolvedRows: Row[] = [];
    let resolved = 0;
    await withTransaction(this.handle, async () => {
      const current = await db
        .select()
        .from(t.findings)
        .where(
          and(
            eq(t.findings.analyzer, analyzer.id),
            inArray(t.findings.status, [...ACTIVE_OR_CANDIDATE, "dismissed", "accepted"]),
          ),
        );
      const byKey = new Map(current.map((r) => [r.key, r]));
      const seen = new Set<string>();
      const acceptances = new Map(
        (await db.select().from(t.findingAcceptances)).map((a) => [a.key, a]),
      );
      /** The owner's acceptance still holds: same signature, and no more serious than then. */
      const holds = (d: FindingDraft) => {
        const a = acceptances.get(d.key);
        return Boolean(
          a &&
          a.signature === signatureOf(d) &&
          SEVERITY_ORDER.indexOf(d.severity) <=
            SEVERITY_ORDER.indexOf(a.severity as FindingSeverity),
        );
      };

      for (const d of result.drafts) {
        if (seen.has(d.key)) continue;
        seen.add(d.key);
        const evidence = d.evidence.slice(0, MAX_EVIDENCE);
        const nature = d.nature ?? defaultNature(d.kind);
        const signature = signatureOf(d);
        const existing = byKey.get(d.key);
        const accepted = holds(d);
        if (existing) {
          // Accepted, and something about it changed: the owner decides again.
          const changed = existing.status === "accepted" && !accepted;
          const sightings = existing.sightings + 1;
          const confirmAfter = d.confirmAfter ?? 1;
          const becomesVisible = existing.status === "candidate" && sightings >= confirmAfter;
          await db
            .update(t.findings)
            .set({
              kind: d.kind,
              severity: d.severity,
              title: d.title,
              summary: d.summary,
              why: d.why,
              nextSteps: d.nextSteps,
              evidence,
              resources: d.resources,
              serviceId: d.serviceId ?? existing.serviceId,
              hostId: d.hostId ?? existing.hostId,
              incidentId: d.incidentId ?? existing.incidentId,
              nature,
              signature,
              sightings,
              lastSeenAt: at,
              checkedAt: at,
              ...(becomesVisible
                ? { status: accepted ? ("accepted" as const) : ("open" as const), firstSeenAt: at }
                : changed
                  ? { status: "open" as const }
                  : {}),
            })
            .where(eq(t.findings.id, existing.id));
          if (changed) {
            const a = acceptances.get(d.key)!;
            await addFindingEvent(
              db,
              existing.id,
              at,
              "changed",
              "hearth",
              `It changed since you accepted it ("${a.title}", ${a.severity}): now "${d.title}", ${d.severity}. Raised again for you to decide.`,
            );
          }
          if (becomesVisible && !accepted) {
            await addFindingEvent(db, existing.id, at, "opened", "hearth", d.summary);
            opened.push({ ...existing, ...d, evidence, status: "open", firstSeenAt: at });
          } else if (
            existing.status !== "candidate" &&
            existing.status !== "dismissed" &&
            existing.status !== "accepted"
          ) {
            await this.noteChange(existing, d, at);
          }
          continue;
        }
        // Back within a day: the same finding again, with its history.
        const recent = await db
          .select()
          .from(t.findings)
          .where(
            and(
              eq(t.findings.key, d.key),
              eq(t.findings.analyzer, analyzer.id),
              eq(t.findings.status, "resolved"),
            ),
          )
          .orderBy(desc(t.findings.resolvedAt))
          .get();
        const window = recent?.repaired ? REPAIR_HOLD_MS : REOPEN_WINDOW_MS;
        if (recent?.resolvedAt && Date.parse(at) - Date.parse(recent.resolvedAt) < window) {
          // A repair that did not hold is worth saying, and changes what to do next.
          const failedRepair = recent.repaired;
          await db
            .update(t.findings)
            .set({
              status: accepted ? "accepted" : "open",
              nature,
              signature,
              returnedAfterRepair: failedRepair || recent.returnedAfterRepair,
              repaired: false,
              kind: d.kind,
              severity: d.severity,
              title: d.title,
              summary: d.summary,
              why: d.why,
              nextSteps: failedRepair
                ? [
                    "The earlier fix did not hold. Ask Ember to look for the underlying cause before repeating it.",
                    ...d.nextSteps,
                  ].slice(0, 4)
                : d.nextSteps,
              evidence,
              resources: d.resources,
              // What it is linked to now (a new incident for the same service, for example).
              serviceId: d.serviceId ?? recent.serviceId,
              hostId: d.hostId ?? recent.hostId,
              incidentId: d.incidentId ?? recent.incidentId,
              occurrences: recent.occurrences + 1,
              sightings: 1,
              lastSeenAt: at,
              checkedAt: at,
              resolvedAt: null,
              resolution: null,
              snoozedUntil: null,
            })
            .where(eq(t.findings.id, recent.id));
          await addFindingEvent(
            db,
            recent.id,
            at,
            "reopened",
            "hearth",
            `It came back ${Math.max(1, Math.round((Date.parse(at) - Date.parse(recent.resolvedAt)) / 60_000))} min after it was resolved${failedRepair ? ` by a repair (${recent.resolution ?? "a fix"}): the fix did not hold` : ""}.${accepted ? " It matches what you accepted, so it stays accepted." : ""} ${d.summary}`,
          );
          continue;
        }
        const confirmAfter = d.confirmAfter ?? 1;
        const row = {
          id: newId(),
          number: await this.nextNumber(),
          key: d.key,
          source: analyzer.source,
          analyzer: analyzer.id,
          kind: d.kind,
          severity: d.severity,
          nature,
          signature,
          repaired: false,
          returnedAfterRepair: false,
          status: (confirmAfter > 1
            ? "candidate"
            : accepted
              ? "accepted"
              : "open") as FindingStatus,
          title: d.title,
          summary: d.summary,
          why: d.why,
          nextSteps: d.nextSteps,
          evidence,
          resources: d.resources,
          serviceId: d.serviceId ?? null,
          hostId: d.hostId ?? null,
          incidentId: d.incidentId ?? null,
          jobId: null,
          todoId: null,
          conversationId: null,
          createdBy: "hearth" as const,
          sightings: 1,
          occurrences: 1,
          firstSeenAt: at,
          lastSeenAt: at,
          checkedAt: at,
          resolvedAt: null,
          resolution: null,
          snoozedUntil: null,
        };
        await db.insert(t.findings).values(row);
        if (row.status === "open") {
          await addFindingEvent(db, row.id, at, "opened", "hearth", d.summary);
          opened.push(row);
        } else if (row.status === "accepted") {
          await addFindingEvent(
            db,
            row.id,
            at,
            "accepted",
            "hearth",
            `Seen again, the same as you accepted it, so it stays accepted. ${d.summary}`,
          );
        }
      }

      // Everything it looked at and no longer sees is gone: resolve it (a candidate that never
      // showed is simply dropped). What it could not look at is left exactly as it was.
      for (const r of current) {
        if (seen.has(r.key) || !result.covered(r.key)) continue;
        if (r.status === "candidate") {
          await db.delete(t.findings).where(eq(t.findings.id, r.id));
          continue;
        }
        // Fixed by the linked plan (it ran and its checks passed), or by a repair the analyzer
        // knows of: remembered, so a return says the fix did not hold.
        const job = r.jobId
          ? await db
              .select({ status: t.jobs.status, title: t.jobs.title })
              .from(t.jobs)
              .where(eq(t.jobs.id, r.jobId))
              .get()
          : undefined;
        const byPlan = job?.status === "succeeded";
        const repaired = byPlan || (result.repaired?.(r) ?? false);
        const text = byPlan
          ? `Fixed: the plan "${job!.title}" ran, and Hearth checked again: the condition is gone.`
          : (result.resolution?.(r) ?? "Hearth checked again and the condition is gone.");
        await db
          .update(t.findings)
          .set({ status: "resolved", resolvedAt: at, resolution: text, checkedAt: at, repaired })
          .where(eq(t.findings.id, r.id));
        await addFindingEvent(db, r.id, at, "resolved", "hearth", text);
        if (r.status !== "dismissed" && r.status !== "accepted") {
          resolved++;
          resolvedRows.push({
            ...r,
            status: "resolved",
            resolvedAt: at,
            resolution: text,
            repaired,
          });
        }
      }
      // Findings it looked at and still sees were updated above; the rest only record the look.
      const looked = current.filter((r) => seen.has(r.key) || result.covered(r.key));
      if (looked.length) {
        await db
          .update(t.findings)
          .set({ checkedAt: at })
          .where(
            and(
              inArray(
                t.findings.id,
                looked.map((r) => r.id),
              ),
              ne(t.findings.status, "resolved"),
            ),
          );
      }
    });
    return {
      opened: await this.toFindings(opened as Row[]),
      resolved,
      resolvedFindings: await this.toFindings(resolvedRows),
      repairedFindings: await this.toFindings(resolvedRows.filter((r) => r.repaired)),
    };
  }

  /** History for a meaningful change in an open finding: severity, or confirmed. */
  private async noteChange(existing: Row, d: FindingDraft, at: string) {
    const db = this.db;
    if (existing.kind === "suspected" && d.kind === "problem") {
      await addFindingEvent(db, existing.id, at, "confirmed", "hearth", `Confirmed: ${d.summary}`);
    } else if (existing.severity !== d.severity) {
      const up = SEVERITY_ORDER.indexOf(d.severity) > SEVERITY_ORDER.indexOf(existing.severity);
      await addFindingEvent(
        db,
        existing.id,
        at,
        up ? "escalated" : "eased",
        "hearth",
        `${up ? "More serious" : "Less serious"} now (${d.severity}): ${d.summary}`,
      );
    } else if (existing.summary !== d.summary) {
      await addFindingEvent(db, existing.id, at, "evidence", "hearth", d.summary);
    }
  }

  /* ---------- Changes by people and by Ember ---------- */

  /**
   * The owner's decisions (seen, snooze, dismiss, reopen) and Ember's progress
   * (investigating, notes). Who may do what is decided here, not by the caller: Ember never
   * dismisses or snoozes (those are the owner's calls) and never resolves what an analyzer
   * rechecks (only the recheck can say it is gone).
   */
  async act(
    idOrNumber: string,
    action:
      | { type: "acknowledge" }
      | { type: "snooze"; until: string }
      | { type: "dismiss"; reason?: string }
      | { type: "reopen" }
      | { type: "accept"; note?: string }
      | { type: "unaccept" }
      | { type: "investigating"; conversationId?: string }
      | { type: "note"; text: string }
      | { type: "resolve"; verification: string },
    actor: Actor,
    now = new Date(),
  ): Promise<FindingDetail> {
    const row = await this.row(idOrNumber);
    const at = now.toISOString();
    const db = this.db;
    const active = FINDING_ACTIVE.includes(row.status);
    const ownerOnly = ["acknowledge", "snooze", "dismiss", "reopen", "accept", "unaccept"];
    if (actor !== "you" && ownerOnly.includes(action.type)) {
      throw new ForbiddenError("Only the owner can do that with a finding.");
    }
    switch (action.type) {
      case "acknowledge":
        if (!active) throw new InvalidRequestError("That finding is not open.");
        if (row.status === "open")
          await db
            .update(t.findings)
            .set({ status: "acknowledged" })
            .where(eq(t.findings.id, row.id));
        await addFindingEvent(db, row.id, at, "acknowledged", actor, "You have seen it.");
        break;
      case "snooze": {
        if (!active) throw new InvalidRequestError("That finding is not open.");
        const until = new Date(action.until);
        if (Number.isNaN(until.getTime()) || until <= now)
          throw new InvalidRequestError("Snooze until a time in the future.");
        await db
          .update(t.findings)
          .set({ snoozedUntil: until.toISOString() })
          .where(eq(t.findings.id, row.id));
        await addFindingEvent(
          db,
          row.id,
          at,
          "snoozed",
          actor,
          `Hidden from the dashboard until ${clock(until)}. Hearth keeps checking it.`,
        );
        break;
      }
      case "dismiss":
        if (!active) throw new InvalidRequestError("That finding is not open.");
        await db.update(t.findings).set({ status: "dismissed" }).where(eq(t.findings.id, row.id));
        await addFindingEvent(
          db,
          row.id,
          at,
          "dismissed",
          actor,
          `Dismissed${action.reason ? `: ${clean(action.reason, 300)}` : ""}. Hearth keeps checking quietly and closes it when the condition is gone.`,
        );
        break;
      case "accept": {
        if (!active && row.status !== "dismissed")
          throw new InvalidRequestError("Only an open finding can be accepted.");
        const note = action.note ? clean(action.note, 300) : null;
        const acceptance = {
          key: row.key,
          signature: row.signature || `${row.kind}|${row.severity}`,
          severity: row.severity,
          title: row.title,
          note,
          acceptedAt: at,
        };
        await withTransaction(this.handle, async () => {
          await db
            .insert(t.findingAcceptances)
            .values(acceptance)
            .onConflictDoUpdate({ target: t.findingAcceptances.key, set: acceptance });
          await db.update(t.findings).set({ status: "accepted" }).where(eq(t.findings.id, row.id));
          await addFindingEvent(
            db,
            row.id,
            at,
            "accepted",
            actor,
            `Accepted as it is${note ? `: ${note}` : ""}. Hearth keeps checking; it stays accepted while it looks the same, and is raised again if it changes or gets worse.`,
          );
        });
        break;
      }
      case "unaccept":
        await withTransaction(this.handle, async () => {
          await db.delete(t.findingAcceptances).where(eq(t.findingAcceptances.key, row.key));
          if (row.status === "accepted")
            await db.update(t.findings).set({ status: "open" }).where(eq(t.findings.id, row.id));
          await addFindingEvent(db, row.id, at, "reopened", actor, "No longer accepted.");
        });
        break;
      case "reopen":
        if (active) throw new InvalidRequestError("That finding is already open.");
        await db
          .update(t.findings)
          .set({ status: "open", resolvedAt: null, resolution: null, snoozedUntil: null })
          .where(eq(t.findings.id, row.id));
        await addFindingEvent(db, row.id, at, "reopened", actor, "Reopened by you.");
        break;
      case "investigating":
        if (!active) throw new InvalidRequestError("That finding is not open.");
        await db
          .update(t.findings)
          .set({
            ...(row.status === "planned" ? {} : { status: "investigating" as const }),
            ...(action.conversationId ? { conversationId: action.conversationId } : {}),
          })
          .where(eq(t.findings.id, row.id));
        await addFindingEvent(
          db,
          row.id,
          at,
          "investigating",
          actor,
          actor === "ember" ? "Ember is investigating." : "You asked Ember to investigate.",
        );
        break;
      case "note":
        await addFindingEvent(db, row.id, at, "note", actor, clean(action.text, 1000));
        break;
      case "resolve": {
        if (!active) throw new InvalidRequestError("That finding is not open.");
        if (row.createdBy !== "ember")
          throw new ForbiddenError(
            "Hearth resolves this finding itself when its recheck shows the condition is gone.",
          );
        const verification = clean(action.verification, 600);
        if (verification.length < 10)
          throw new InvalidRequestError("Say how it was verified (what was checked, and when).");
        const text = `Resolved by ${actor === "you" ? "you" : "Ember"}: ${verification}`;
        await db
          .update(t.findings)
          .set({ status: "resolved", resolvedAt: at, resolution: text, checkedAt: at })
          .where(eq(t.findings.id, row.id));
        await addFindingEvent(db, row.id, at, "resolved", actor, text);
        break;
      }
    }
    return this.get(row.id);
  }

  /**
   * Ember's own finding from an investigation: a new one, or new evidence on one it (or Hearth)
   * already has for the same thing (same key, or same title on the same service).
   */
  async record(
    input: {
      key?: string;
      kind: FindingKind;
      severity: FindingSeverity;
      nature?: FindingNature;
      title: string;
      summary: string;
      why: string;
      nextSteps: string[];
      evidence: FindingEvidence[];
      resources: FindingResource[];
      serviceId?: string;
      hostId?: string;
      conversationId?: string;
    },
    now = new Date(),
  ): Promise<{ finding: FindingDetail; created: boolean }> {
    const at = now.toISOString();
    const db = this.db;
    const title = clean(input.title, 140);
    const key = input.key
      ? `ember:${input.key.toLowerCase().replace(/[^a-z0-9:._-]+/g, "-")}`.slice(0, 120)
      : `ember:${(input.serviceId ?? "general").toLowerCase()}:${title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .slice(0, 60)}`;
    const evidence = input.evidence
      .slice(0, MAX_EVIDENCE)
      .map((e) => ({ ...e, label: clean(e.label, 80), value: clean(e.value, 400) }));
    const existing = await db
      .select()
      .from(t.findings)
      .where(and(eq(t.findings.key, key), inArray(t.findings.status, [...FINDING_ACTIVE])))
      .get();
    const fields = {
      kind: input.kind,
      severity: input.severity,
      nature: input.nature ?? defaultNature(input.kind),
      title,
      summary: clean(input.summary, 1200),
      why: clean(input.why, 600),
      nextSteps: input.nextSteps.slice(0, 6).map((s) => clean(s, 300)),
      evidence,
      resources: input.resources.slice(0, 12),
      serviceId: input.serviceId ?? null,
      hostId: input.hostId ?? null,
    };
    if (existing) {
      await withTransaction(this.handle, async () => {
        await db
          .update(t.findings)
          .set({
            ...fields,
            lastSeenAt: at,
            checkedAt: at,
            ...(input.conversationId ? { conversationId: input.conversationId } : {}),
          })
          .where(eq(t.findings.id, existing.id));
        await addFindingEvent(db, existing.id, at, "evidence", "ember", fields.summary);
      });
      return { finding: await this.get(existing.id), created: false };
    }
    const id = newId();
    await withTransaction(this.handle, async () => {
      await db.insert(t.findings).values({
        id,
        number: await this.nextNumber(),
        key,
        source: "ember",
        analyzer: "ember",
        status: "open",
        ...fields,
        incidentId: null,
        jobId: null,
        todoId: null,
        conversationId: input.conversationId ?? null,
        createdBy: "ember",
        sightings: 1,
        occurrences: 1,
        firstSeenAt: at,
        lastSeenAt: at,
        checkedAt: at,
        resolvedAt: null,
        resolution: null,
        snoozedUntil: null,
      });
      await addFindingEvent(db, id, at, "opened", "ember", fields.summary);
    });
    return { finding: await this.get(id), created: true };
  }

  /** A plan proposed for a finding: linked, and the finding shows it is planned. */
  async linkJob(idOrNumber: string, jobId: string, title: string, actor: Actor): Promise<void> {
    const row = await this.row(idOrNumber);
    if (!FINDING_ACTIVE.includes(row.status))
      throw new InvalidRequestError("That finding is not open.");
    if (row.kind !== "problem" && row.kind !== "suspected")
      throw new InvalidRequestError(
        "Plans are for problems. This finding is an observation or recommendation.",
      );
    const at = new Date().toISOString();
    await withTransaction(this.handle, async () => {
      await this.db
        .update(t.findings)
        .set({ jobId, status: "planned" })
        .where(eq(t.findings.id, row.id));
      await addFindingEvent(this.db, row.id, at, "planned", actor, `Plan proposed: ${title}.`);
    });
  }

  /** The owner put a finding on their own list. */
  async linkTodo(idOrNumber: string, todoId: string): Promise<void> {
    const row = await this.row(idOrNumber);
    await this.db.update(t.findings).set({ todoId }).where(eq(t.findings.id, row.id));
    await addFindingEvent(
      this.db,
      row.id,
      new Date().toISOString(),
      "note",
      "you",
      "Added to your list.",
    );
  }

  /**
   * A linked plan ended. Its result goes in the finding's history; whether the condition is
   * gone is still decided by the recheck (the caller reruns the analyzer). A finding only Ember
   * can verify is resolved when the plan's own verification passed. A plan that did not work
   * puts the finding back to open.
   */
  async onJobFinished(jobId: string): Promise<{ analyzers: string[] }> {
    const job = await this.db.select().from(t.jobs).where(eq(t.jobs.id, jobId)).get();
    if (!job) return { analyzers: [] };
    const rows = await this.db
      .select()
      .from(t.findings)
      .where(and(eq(t.findings.jobId, jobId), inArray(t.findings.status, [...FINDING_ACTIVE])));
    const at = new Date().toISOString();
    const ok = job.status === "succeeded";
    for (const r of rows) {
      await withTransaction(this.handle, async () => {
        const text = ok
          ? `The plan "${job.title}" finished and its checks passed.`
          : `The plan "${job.title}" ended: ${job.status.replace("-", " ")}.`;
        await addFindingEvent(this.db, r.id, at, "plan-result", "hearth", text);
        if (ok && r.createdBy === "ember") {
          const resolution = `Fixed by the plan "${job.title}", whose verification passed.`;
          await this.db
            .update(t.findings)
            .set({ status: "resolved", resolvedAt: at, resolution, checkedAt: at })
            .where(eq(t.findings.id, r.id));
          await addFindingEvent(this.db, r.id, at, "resolved", "hearth", resolution);
        } else if (!ok) {
          await this.db.update(t.findings).set({ status: "open" }).where(eq(t.findings.id, r.id));
        }
      });
    }
    return { analyzers: ok ? [...new Set(rows.map((r) => r.analyzer))] : [] };
  }
}

const clean = (s: string, max: number) => redactTranscript(s.trim()).slice(0, max);
