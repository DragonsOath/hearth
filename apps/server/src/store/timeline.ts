import { and, eq, gte, inArray, like, or } from "drizzle-orm";
import { ACTIONS, type ActionKind, type TimelineEvent } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { describeEvent, type RestartLog } from "../monitor/restarts";

/**
 * Everything recorded about one service, newest first, for its History tab
 * (feature request 4.9): incidents opened and resolved, actions and plans,
 * changes made through operations (audit), container starts and stops
 * (restart history), Ember investigations that looked at it, and
 * journal entries linked to it. Only records Hearth already keeps;
 * nothing is read live here.
 */

const MAX_EVENTS = 400;

const BY: Record<string, string> = {
  you: "you",
  agent: "the AI",
  "dragon-control": "Hearth",
};

export async function serviceTimeline(
  handle: DbHandle,
  serviceId: string,
  days: number,
  restarts?: RestartLog,
): Promise<TimelineEvent[]> {
  const { db } = handle;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const service = await db.select().from(t.services).where(eq(t.services.id, serviceId)).get();
  if (!service) return [];
  const events: TimelineEvent[] = [];

  const incidents = await db
    .select()
    .from(t.incidents)
    .where(and(eq(t.incidents.serviceId, serviceId), gte(t.incidents.openedAt, since)));
  for (const i of incidents) {
    events.push({
      at: i.openedAt,
      kind: "incident",
      title: `Incident: ${i.title}`,
      detail: i.summary,
      tone: "attention",
      link: `/incidents/${i.id}`,
    });
    if (i.resolvedAt) {
      events.push({
        at: i.resolvedAt,
        kind: "resolved",
        title: `Resolved: ${i.title}`,
        ...(i.resolution ? { detail: i.resolution } : {}),
        tone: "good",
        link: `/incidents/${i.id}`,
      });
    }
  }

  const actions = await db
    .select()
    .from(t.actions)
    .where(
      and(
        eq(t.actions.targetType, "service"),
        eq(t.actions.targetId, serviceId),
        gte(t.actions.requestedAt, since),
      ),
    );
  for (const a of actions) {
    const def = ACTIONS[a.kind as ActionKind];
    events.push({
      at: a.completedAt ?? a.requestedAt,
      kind: "action",
      title: `${def ? def.describe(service.name) : a.kind}: ${a.status}`,
      ...(a.result ? { detail: a.result } : {}),
      tone: a.status === "succeeded" ? "good" : a.status === "failed" ? "attention" : "neutral",
      by: BY[a.requestedBy] ?? a.requestedBy,
    });
  }

  const stepJobs = await db
    .select({ jobId: t.jobSteps.jobId })
    .from(t.jobSteps)
    .where(eq(t.jobSteps.serviceId, serviceId));
  const jobIds = [...new Set(stepJobs.map((s) => s.jobId))];
  if (jobIds.length) {
    const jobs = await db
      .select()
      .from(t.jobs)
      .where(and(inArray(t.jobs.id, jobIds), gte(t.jobs.createdAt, since)));
    for (const j of jobs) {
      events.push({
        at: j.createdAt,
        kind: "job",
        title: `Plan: ${j.title} (${j.status})`,
        ...(j.summary ? { detail: j.summary } : {}),
        tone:
          j.status === "succeeded"
            ? "good"
            : j.status === "failed" || j.status === "rolled-back" || j.status === "partial"
              ? "attention"
              : "neutral",
        link: `/jobs/${j.id}`,
        by: BY[j.requestedBy] ?? j.requestedBy,
      });
    }
  }

  // Changes recorded in the audit log (operations inside apps, lifecycle). Container
  // actions are already listed from their own records above.
  const audit = await db
    .select()
    .from(t.auditLog)
    .where(and(eq(t.auditLog.target, `service:${serviceId}`), gte(t.auditLog.at, since)));
  for (const a of audit) {
    if (/ the .* container$/.test(a.action)) continue;
    events.push({
      at: a.at,
      kind: "change",
      title: a.action,
      tone: "neutral",
      by: BY[a.actor] ?? a.actor,
    });
  }

  for (const e of (await restarts?.list(serviceId, 300)) ?? []) {
    if (e.at < since) continue;
    events.push({
      at: e.at,
      kind: e.kind === "start" ? "restart" : "stop",
      title: describeEvent(e),
      tone:
        e.kind === "stop" &&
        (e.oomKilled || (e.exitCode !== undefined && ![0, 143].includes(e.exitCode)))
          ? "attention"
          : "neutral",
      by: e.cause === "docker" ? "Docker" : e.cause === "dragon-control" ? "Hearth" : undefined,
    });
  }

  // Ember investigations: answers that read this service (a tool on it, or evidence about it).
  const ref = `service:${serviceId}`;
  const activity = await db
    .select({
      conversationId: t.conversationActivity.conversationId,
      messageId: t.conversationActivity.messageId,
      at: t.conversationActivity.at,
    })
    .from(t.conversationActivity)
    .where(and(eq(t.conversationActivity.ref, ref), gte(t.conversationActivity.at, since)));
  const answered = await db
    .select({
      id: t.conversationMessages.id,
      conversationId: t.conversationMessages.conversationId,
      at: t.conversationMessages.at,
    })
    .from(t.conversationMessages)
    .where(
      and(
        eq(t.conversationMessages.role, "agent"),
        gte(t.conversationMessages.at, since),
        or(like(t.conversationMessages.evidence, `%"${ref}"%`)),
      ),
    );
  const asked = new Map<string, { conversationId: string; at: string; messageId?: number }>();
  for (const a of activity)
    asked.set(`${a.conversationId}:${a.messageId}`, {
      conversationId: a.conversationId,
      at: a.at,
      messageId: a.messageId,
    });
  for (const m of answered) {
    // The owner's question is the message just before the answer.
    const q = handle.sqlite
      .prepare(
        "SELECT id FROM conversation_messages WHERE conversation_id = ? AND role = 'you' AND id < ? ORDER BY id DESC LIMIT 1",
      )
      .get(m.conversationId, m.id) as { id: number } | undefined;
    const key = `${m.conversationId}:${q?.id ?? m.id}`;
    if (!asked.has(key))
      asked.set(key, { conversationId: m.conversationId, at: m.at, messageId: q?.id });
  }
  for (const a of asked.values()) {
    const question = a.messageId
      ? (handle.sqlite
          .prepare("SELECT text FROM conversation_messages WHERE id = ? AND role = 'you'")
          .get(a.messageId) as { text: string } | undefined)
      : undefined;
    events.push({
      at: a.at,
      kind: "investigation",
      title: question
        ? `Ember looked into: "${question.text.replace(/\s+/g, " ").slice(0, 140)}"`
        : "Ember looked into it",
      tone: "neutral",
      link: `/ask/${a.conversationId}`,
      by: "the AI",
    });
  }

  const memories = await db
    .select()
    .from(t.memoryEntries)
    .where(and(like(t.memoryEntries.links, `%"${ref}"%`), gte(t.memoryEntries.happenedAt, since)));
  for (const m of memories) {
    events.push({
      at: m.happenedAt,
      kind: "memory",
      title: m.title,
      ...(m.body ? { detail: m.body.slice(0, 300) } : {}),
      tone: "neutral",
      link: "/memory",
    });
  }

  return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_EVENTS);
}
