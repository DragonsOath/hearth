import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  MEMORY_BASIS_LABELS,
  MEMORY_KIND_LABELS,
  type MemoryEntry,
  type MemoryKind,
  type MemoryProject,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import { slug } from "../discovery/scan";
import type { Memory } from "./service";

/**
 * The memory as plain Markdown files, rewritten with every backup, so it
 * is never trapped in a database: readable in any editor, searchable with
 * any tool, and usable if Hearth itself is down.
 */

const day = (iso: string) => iso.slice(0, 10);

function entryBlock(e: MemoryEntry, projects: Map<string, MemoryProject>): string {
  const facts = [
    day(e.happenedAt),
    MEMORY_KIND_LABELS[e.kind] + (e.kind === "thread" ? ` (${e.status ?? "open"})` : ""),
    MEMORY_BASIS_LABELS[e.basis],
    e.projectId ? (projects.get(e.projectId)?.name ?? e.projectId) : undefined,
    e.machine ? `on ${e.machine}` : undefined,
    `by ${e.author ?? e.source}`,
  ].filter(Boolean);
  const lines = [`### ${e.title}`, "", `_${facts.join(" · ")}_`, ""];
  if (e.body) lines.push(e.body, "");
  if (e.verification) {
    lines.push(
      `Verified ${e.verification.at}: \`${e.verification.check}\` returned: ${e.verification.result}`,
      "",
    );
  }
  if (e.links.length) {
    lines.push(...e.links.map((l) => `- ${l.label}: \`${l.ref}\``), "");
  }
  lines.push(`<!-- memory ${e.id} -->`, "");
  return lines.join("\n");
}

const sections: { kind: MemoryKind; file: string; title: string }[] = [
  { kind: "thread", file: "threads.md", title: "Open threads" },
  { kind: "win", file: "wins.md", title: "Wins" },
  { kind: "preference", file: "how-you-work.md", title: "How you work" },
  { kind: "hardware", file: "hardware.md", title: "Hardware" },
  { kind: "note", file: "notes.md", title: "Notes" },
];

export async function exportMemory(
  handle: DbHandle,
  memory: Memory,
  target: string,
  now: Date,
): Promise<{ files: number }> {
  const work = `${target}.partial`;
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true, mode: 0o700 });
  let files = 0;
  const write = (rel: string, text: string) => {
    const file = path.join(work, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
    files++;
  };

  const projects = await memory.projects();
  const byId = new Map(projects.map((p) => [p.id, p]));
  const entries = await memory.list({ limit: 1_000_000 });

  // Journal by month.
  const journal = entries.filter((e) => e.kind === "journal");
  const months = [...new Set(journal.map((e) => e.happenedAt.slice(0, 7)))].sort().reverse();
  for (const m of months) {
    write(
      `journal/${m}.md`,
      [
        `# Journal, ${m}`,
        "",
        ...journal.filter((e) => e.happenedAt.startsWith(m)).map((e) => entryBlock(e, byId)),
      ].join("\n"),
    );
  }

  for (const s of sections) {
    const list = entries
      .filter((e) => e.kind === s.kind)
      .sort((a, b) => (a.status === "open" ? -1 : 0) - (b.status === "open" ? -1 : 0));
    write(
      s.file,
      [
        `# ${s.title}`,
        "",
        ...(list.length ? list.map((e) => entryBlock(e, byId)) : ["Nothing yet."]),
      ].join("\n"),
    );
  }

  for (const p of projects) {
    const list = entries.filter((e) => e.projectId === p.id);
    write(
      `projects/${p.id}.md`,
      [
        `# ${p.name}`,
        "",
        `_Status: ${p.status} · ${list.length} entries · ${p.openThreads} open threads_`,
        "",
        p.summary,
        "",
        ...list.map((e) => entryBlock(e, byId)),
      ].join("\n"),
    );
  }

  // Transcripts and conversations, word for word.
  const transcripts = await memory.transcripts(1_000_000);
  for (const tr of transcripts) {
    const { messages } = await memory.transcript(tr.id);
    write(
      `transcripts/${day(tr.startedAt)}-${tr.client}-${slug(tr.title).slice(0, 40)}-${tr.id.slice(0, 8)}.md`,
      [
        `# ${tr.title}`,
        "",
        `_${tr.client}${tr.machine ? ` on ${tr.machine}` : ""} · started ${tr.startedAt}${tr.endedAt ? ` · ended ${tr.endedAt}` : ""} · ${messages.length} messages_`,
        "",
        ...messages.map((m) => `**${m.role}** (${m.at}, #${m.seq})\n\n${m.text}\n`),
      ].join("\n"),
    );
  }
  const conversations = handle.sqlite
    .prepare("SELECT id, source, title, created_at FROM conversations ORDER BY created_at")
    .all() as { id: string; source: string; title: string; created_at: string }[];
  for (const c of conversations) {
    const messages = handle.sqlite
      .prepare(
        "SELECT role, text, at FROM conversation_messages WHERE conversation_id = ? ORDER BY id",
      )
      .all(c.id) as { role: string; text: string; at: string }[];
    write(
      `transcripts/${day(c.created_at)}-${c.source}-${slug(c.title).slice(0, 40)}-${c.id.slice(0, 8)}.md`,
      [
        `# ${c.title}`,
        "",
        `_Conversation in Hearth (${c.source}) · started ${c.created_at}_`,
        "",
        ...messages.map((m) => `**${m.role}** (${m.at})\n\n${m.text}\n`),
      ].join("\n"),
    );
  }

  const open = entries.filter((e) => e.kind === "thread" && e.status === "open").length;
  write(
    "README.md",
    [
      "# Homelab memory",
      "",
      `Exported by Hearth on ${now.toISOString()}. This folder is rewritten with every backup; the database is the original.`,
      "",
      `- ${entries.length} memories, ${open} open threads, ${projects.length} projects`,
      `- ${transcripts.length + conversations.length} transcripts and conversations`,
      "",
      "## Files",
      "",
      "- `threads.md`, `wins.md`, `how-you-work.md`, `hardware.md`, `notes.md`",
      "- `journal/` by month, `projects/` one file each, `transcripts/` word for word",
      "",
      "Secrets are never part of the memory. Their values stay in Hearth's vault.",
    ].join("\n"),
  );

  rmSync(target, { recursive: true, force: true });
  renameSync(work, target);
  return { files };
}
