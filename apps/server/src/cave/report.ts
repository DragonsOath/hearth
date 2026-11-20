import { inArray, eq } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { Imports } from "../memory/imports";

/**
 * Operational knowledge from an investigation or repair, as a draft for the
 * owner to review (Memory > Review), never straight into memory. The report
 * keeps three kinds of statement apart:
 *
 * - Verified: what Hearth itself recorded (checks it ran during the
 *   conversation, plan steps with their before/after values and results,
 *   job outcomes). Written from records, not from the AI's words.
 * - The AI's account: problem, root cause (marked verified or inference by
 *   the AI), relevant configuration, lessons. Labelled as such.
 * - Unapproved: the whole report stays a pending draft until accepted.
 */

export interface ReportInput {
  title: string;
  problem: string;
  rootCause: string;
  rootCauseBasis: "verified" | "inference";
  configuration?: string;
  lessons?: string[];
  jobIds?: string[];
  conversationId?: string;
}

const STEP_TEXT: Record<string, string> = {
  succeeded: "done",
  failed: "did not work",
  "rolled-back": "undone",
  skipped: "skipped",
  pending: "not run",
  running: "running",
  interrupted: "interrupted",
};

export async function draftReport(
  handle: DbHandle,
  imports: Imports,
  input: ReportInput,
  now = new Date(),
): Promise<{ draftId?: string; title: string }> {
  const { db } = handle;
  // Plans proposed in this conversation, plus any named.
  const fromConversation = input.conversationId
    ? (
        await db
          .select({ ref: t.conversationActivity.ref })
          .from(t.conversationActivity)
          .where(eq(t.conversationActivity.conversationId, input.conversationId))
      )
        .map((r) => r.ref)
        .filter((r): r is string => Boolean(r?.startsWith("job:")))
        .map((r) => r.slice(4))
    : [];
  const jobIds = [...new Set([...(input.jobIds ?? []), ...fromConversation])].slice(0, 10);
  const jobs = jobIds.length
    ? await db.select().from(t.jobs).where(inArray(t.jobs.id, jobIds))
    : [];
  const steps = jobIds.length
    ? await db.select().from(t.jobSteps).where(inArray(t.jobSteps.jobId, jobIds))
    : [];
  const checks = input.conversationId
    ? (
        await db
          .select()
          .from(t.conversationActivity)
          .where(eq(t.conversationActivity.conversationId, input.conversationId))
      ).filter((a) => a.kind === "tool" && a.status === "done")
    : [];

  const verified: string[] = [];
  for (const c of checks.slice(-15)) {
    verified.push(
      `- ${c.at.slice(0, 16).replace("T", " ")} UTC: ${c.label}${c.detail ? `: ${c.detail}` : ""}`,
    );
  }
  for (const j of jobs) {
    verified.push(`- Plan "${j.title}": ${j.status}${j.summary ? `. ${j.summary}` : ""}`);
    for (const s of steps.filter((x) => x.jobId === j.id).sort((a, b) => a.seq - b.seq)) {
      const change = s.change?.settings
        .map((c) => `${c.name}: ${c.before} to ${c.after}`)
        .join("; ");
      verified.push(
        `  - Step ${s.seq}, ${s.label}: ${STEP_TEXT[s.status] ?? s.status}${change ? ` (${change})` : ""}${s.result ? `. ${s.result}` : ""}`,
      );
    }
  }
  const changed = steps.filter((s) => s.change && s.status === "succeeded");
  const outcome = !jobs.length
    ? "No change was made through Hearth."
    : changed.length
      ? `${changed.length} approved ${changed.length === 1 ? "change was" : "changes were"} made and verified.`
      : "No approved change completed.";

  const body = [
    `Drafted by Ember on ${now.toISOString().slice(0, 10)}. Unreviewed: it becomes memory only if you accept it.`,
    "",
    "## Problem",
    input.problem.trim(),
    "",
    `## Root cause (${input.rootCauseBasis === "verified" ? "the AI says this was verified" : "inference by the AI, not confirmed"})`,
    input.rootCause.trim(),
    ...(input.configuration?.trim()
      ? ["", "## Relevant configuration (as the AI described it)", input.configuration.trim()]
      : []),
    "",
    "## What Hearth recorded (verified)",
    ...(verified.length ? verified : ["- Nothing was checked or changed through Hearth."]),
    "",
    "## Outcome (verified)",
    outcome,
    ...(input.lessons?.length
      ? ["", "## Lessons (the AI's suggestions)", ...input.lessons.map((l) => `- ${l.trim()}`)]
      : []),
  ].join("\n");

  const slug = input.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60);
  const sourceRef = `cave-report:${input.conversationId ?? "none"}:${slug}`;
  await imports.propose(`cave-${now.toISOString().slice(0, 10)}`, [
    {
      sourceRef,
      origin: "Ember report",
      anchor: input.title,
      note: "Drafted by Ember. Sections say what Hearth verified and what is the AI's account.",
      payload: {
        kind: "entry",
        entry: { kind: "note", title: input.title.trim().slice(0, 160), body, basis: "documented" },
      },
    },
  ]);
  const row = await db
    .select({ id: t.memoryImportDrafts.id })
    .from(t.memoryImportDrafts)
    .where(eq(t.memoryImportDrafts.sourceRef, sourceRef))
    .get();
  return { draftId: row?.id, title: input.title };
}
