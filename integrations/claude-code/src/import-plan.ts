import { readFileSync } from "node:fs";
import path from "node:path";
import type { ImportDraftInput } from "@dragon-control/core";
import type { Companion } from "./client";
import {
  NEVER_IMPORT,
  draftsFromClaudeSessions,
  draftsFromNotes,
  draftsFromReference,
  draftsFromSessionLogs,
  type ImportOptions,
} from "./importer";

/**
 * An import plan says what to read, kept as a file on the machine that has
 * the notes (it names personal paths, so it never belongs in the repository):
 *
 * {
 *   "batch": "Homelab notes, first import",
 *   "author": "Claude Code",
 *   "machine": "my-server",
 *   "projectMap": { "plex": "Media server" },
 *   "sources": [
 *     { "type": "notes", "path": "/notes/Media/STATE.md", "project": "Media server" },
 *     { "type": "reference", "path": "/notes/Reference", "project": "Homelab" },
 *     { "type": "logs", "path": "/notes/Sessions" },
 *     { "type": "claude-sessions", "path": "~/.claude/projects/notes", "skip": ["<session id>"] }
 *   ]
 * }
 */
export interface ImportPlan extends ImportOptions {
  /** Extra words that mean the homelab to you (added to the names Hearth taught the companion). */
  names?: string[];
  batch: string;
  sources: (ImportOptions & {
    type: "notes" | "reference" | "logs" | "claude-sessions";
    path: string;
    skip?: string[];
  })[];
}

export function draftsFromPlan(
  plan: ImportPlan,
  learned: string[] = [],
): { source: string; drafts: ImportDraftInput[] }[] {
  const names = [...learned, ...(plan.names ?? [])];
  return plan.sources.map((src) => {
    if (NEVER_IMPORT.test(src.path)) {
      throw new Error(`Refusing to read ${src.path}: it looks like it holds secrets.`);
    }
    const opts: ImportOptions = {
      author: src.author ?? plan.author,
      machine: src.machine ?? plan.machine,
      project: src.project,
      projectMap: { ...plan.projectMap, ...src.projectMap },
      ledgerOnly: src.ledgerOnly,
      homelabOnly: src.homelabOnly,
      names,
    };
    const drafts =
      src.type === "notes"
        ? draftsFromNotes(src.path, opts)
        : src.type === "reference"
          ? draftsFromReference(src.path, opts)
          : src.type === "logs"
            ? draftsFromSessionLogs(src.path, opts)
            : draftsFromClaudeSessions(src.path, { machine: opts.machine, skip: src.skip, names });
    return { source: src.path, drafts };
  });
}

/** Groups drafts so no request is too large for the server. */
export function chunk(drafts: ImportDraftInput[], maxBytes = 16 * 1024 * 1024, maxCount = 200) {
  const out: ImportDraftInput[][] = [];
  let current: ImportDraftInput[] = [];
  let size = 0;
  for (const d of drafts) {
    const bytes = Buffer.byteLength(JSON.stringify(d));
    if (current.length && (size + bytes > maxBytes || current.length >= maxCount)) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(d);
    size += bytes;
  }
  if (current.length) out.push(current);
  return out;
}

export async function runImport(
  planFile: string,
  io: {
    dryRun: boolean;
    out?: string;
    companion: Companion;
    write: (file: string, text: string) => void;
    log: (line: string) => void;
  },
) {
  const plan = JSON.parse(readFileSync(planFile, "utf8").trimStart()) as ImportPlan;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  for (const s of plan.sources) s.path = path.resolve(s.path.replace(/^~(?=[/\\])/, home));
  // Names the last briefing taught the companion: your machines, projects, and services.
  let learned: string[] = [];
  try {
    learned = JSON.parse(
      readFileSync(path.join(io.companion.dir, "cache", "names.json"), "utf8"),
    ) as string[];
  } catch {
    // No briefing yet: built-in homelab words only.
  }
  const results = draftsFromPlan(plan, learned);
  const all = results.flatMap((r) => r.drafts);

  for (const r of results) {
    const kinds = new Map<string, number>();
    for (const d of r.drafts) {
      const k = d.payload.kind === "entry" ? d.payload.entry.kind : d.payload.kind;
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    io.log(
      `${r.source}: ${r.drafts.length} drafts (${[...kinds].map(([k, n]) => `${n} ${k}`).join(", ") || "nothing found"})`,
    );
  }
  if (io.out) {
    io.write(io.out, JSON.stringify({ batch: plan.batch, drafts: all }, null, 2));
    io.log(`Drafts written to ${io.out}`);
  }
  if (io.dryRun) {
    io.log(`Dry run: ${all.length} drafts, nothing sent.`);
    return;
  }
  const totals = { added: 0, refreshed: 0, kept: 0, appended: 0 };
  for (const part of chunk(all)) {
    const r = await io.companion.proposeImport(plan.batch, part);
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += r[k];
  }
  io.log(
    `Sent for review: ${totals.added} new, ${totals.refreshed} refreshed, ${totals.kept} already decided, ${totals.appended} new messages added to accepted sessions. Review them in Hearth under Memory.`,
  );
}
