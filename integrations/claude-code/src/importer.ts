import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import type { ImportDraftInput, ImportPayload, MemoryKind } from "@dragon-control/core";
import { home } from "./client";
import { isHomelab } from "./relevance";
import { readSession } from "./transcript";

/**
 * Reads existing notes and past sessions into import drafts for
 * Hearth. Nothing here writes to the sources; nothing becomes memory until
 * the owner accepts it in Hearth.
 *
 * Markdown is read by its structure, the way people write homelab notes:
 * - ledger headings  "### 2026-08-20 13:57 PDT | Agent | EVENT | subject"  -> journal
 * - dated headings   "### 2026-10-05 - Title", "## Title (added 2026-08-03)",
 *                    "## Progress log - X (2026-09-05)"                   -> journal
 * - decisions        "### D3 - Title"                                      -> journal
 * - open-work lists  "Open items", "Not yet decided", "Blockers", "Next"  -> one thread per item
 * - conventions      "Standing conventions", "Preferences", "Rules"       -> one preference per item
 * - infrastructure   "Infrastructure", "Hardware"                         -> hardware
 * - the overview     "Project overview", "Status"                         -> the project's summary
 * - other substantial sections                                            -> notes
 * Whole reference documents (one per service, say) become one note each.
 */

/** Files that are never read, whatever is asked. */
const NEVER =
  /sensitive|secret|credential|password|passwd|\.env\b|encrypted vault|private key|recovery[ _-]?key/i;

export interface ImportOptions {
  /** Project for everything from this file (else from the heading or folder). */
  project?: string;
  /** Who wrote these notes originally ("Claude Code", "Codex"). */
  author?: string;
  machine?: string;
  /** Maps words in ledger subjects to project names, e.g. {"plezy": "Plezy"}. */
  projectMap?: Record<string, string>;
  /** Only the ledger entries of a file (a shared log that also repeats other notes). */
  ledgerOnly?: boolean;
  /** Only what is about the homelab (session logs mixed with other work). */
  homelabOnly?: boolean;
  /** Your own machine, project, and service names, which count as homelab words. */
  names?: string[];
}

function projectFromTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const name = clean(title)
    .replace(/^STATE(\.md)?\s*([—–:-]+\s*|$)/i, "")
    .replace(/\s*[—–-]+\s*current state$/i, "")
    .replace(/\s+state$/i, "")
    .replace(/\s*\((working name|draft)\)$/i, "")
    .trim();
  return name || undefined;
}

const ref = (...parts: string[]) => createHash("sha1").update(parts.join("\u0000")).digest("hex");

/** Undoes UTF-8 read as Windows-1252 ("â€”" for an em dash), common in notes copied between tools. */
export function fixMojibake(text: string): string {
  if (!/[âÃÂ]/.test(text)) return text;
  const map: [string, string][] = [
    ["â€”", "—"],
    ["â€“", "–"],
    ["â€™", "’"],
    ["â€˜", "‘"],
    ["â€œ", "“"],
    ["â€\u009d", "”"],
    ["â€¦", "…"],
    ["â†’", "→"],
    ["â†", "←"],
    ["Â·", "·"],
    ["Â ", " "],
    ["Ã©", "é"],
    ["Ã¨", "è"],
    ["âœ“", "✓"],
    ["âœ…", "✅"],
    ["âš ", "⚠"],
    ["Â", ""],
  ];
  let out = text;
  for (const [bad, good] of map) out = out.split(bad).join(good);
  return out;
}

interface Section {
  level: number;
  heading: string;
  body: string;
}

function sections(text: string): { title?: string; sections: Section[] } {
  const lines = fixMojibake(text.trimStart()).split(/\r?\n/);
  const out: Section[] = [];
  let title: string | undefined;
  let current: Section | undefined;
  let fence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) {
      if (m[1]!.length === 1 && !title) {
        title = m[2]!;
        continue;
      }
      current = { level: m[1]!.length, heading: m[2]!, body: "" };
      out.push(current);
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  for (const s of out) s.body = s.body.trim();
  return { title, sections: out };
}

/** "2026-08-20 13:57 PDT" -> ISO; a bare date becomes midday UTC so it stays on that day everywhere. */
export function parseWhen(text: string): string | undefined {
  const m =
    /(\d{4}-\d{2}-\d{2})(?:\/\d{2})?(?:[ T](\d{1,2}:\d{2})(?::\d{2})?\s*([A-Z]{2,4}|[+-]\d{2}:?\d{2})?)?/.exec(
      text,
    );
  if (!m) return undefined;
  const zones: Record<string, string> = {
    PDT: "-07:00",
    PST: "-08:00",
    MDT: "-06:00",
    MST: "-07:00",
    CDT: "-05:00",
    CST: "-06:00",
    EDT: "-04:00",
    EST: "-05:00",
    UTC: "Z",
    GMT: "Z",
  };
  if (!m[2]) return `${m[1]}T12:00:00.000Z`;
  const zone = m[3]
    ? (zones[m[3]] ?? (m[3].startsWith("+") || m[3].startsWith("-") ? m[3] : "Z"))
    : "Z";
  const iso = new Date(`${m[1]}T${m[2].padStart(5, "0")}:00${zone}`);
  return Number.isNaN(iso.getTime()) ? `${m[1]}T12:00:00.000Z` : iso.toISOString();
}

const OPEN_WORK =
  /open items|open threads|not yet (decided|resolved)|still open|blockers|decisions still required|next action|to ?do|follow[- ]?ups?|outstanding/i;
const CONVENTIONS = /convention|preferences|rules|how .* works?|working agreements|standing/i;
const HARDWARE = /infrastructure|hardware|machines|known infrastructure/i;
const OVERVIEW = /^(project overview|overview|current status|status)\b/i;
const SKIP =
  /^(session )?protocol\b|workspace boundaries|completion checklist|changelog|related memory|^references?$/i;

const clean = (s: string) =>
  s
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
const firstSentence = (s: string, max = 160) => {
  const c = clean(s);
  const cut = c.search(/(?<=[.!?])\s/);
  const one = cut > 20 && cut < max ? c.slice(0, cut) : c;
  return one.length > max ? `${one.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : one;
};

/**
 * A list item's title: its first sentence, without strike-through. A bare
 * label ("Needs your decision:") takes the first thing listed under it.
 */
function itemTitle(item: string): string {
  const [first, ...rest] = item.split("\n");
  const label = firstSentence(first!.replace(/~~/g, ""));
  if (/:$/.test(label) && rest.length) {
    return firstSentence(`${label.slice(0, -1)}: ${rest[0]!.replace(/^([-*+]|\d+[.)])\s+/, "")}`);
  }
  return firstSentence(item.replace(/~~/g, ""));
}

/** Top-level list items, each with its nested lines. */
function items(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (/^\s{0,1}([-*+]|\d+[.)])\s+/.test(line))
      out.push(line.replace(/^\s{0,1}([-*+]|\d+[.)])\s+/, ""));
    else if (out.length && line.trim()) out[out.length - 1] += `\n${line.trim()}`;
  }
  return out.filter((i) => clean(i).length > 3);
}

function entry(
  file: string,
  anchor: string,
  e: Extract<ImportPayload, { kind: "entry" }>["entry"],
  note: string,
): ImportDraftInput {
  const body =
    e.body && e.body.length > 20_000
      ? `${e.body.slice(0, 19_900)}\n\n[Shortened on import; the full text is in the source file.]`
      : e.body;
  return {
    sourceRef: `md:${ref(path.resolve(file), anchor)}`,
    origin: path.resolve(file),
    anchor,
    payload: { kind: "entry", entry: { ...e, body } },
    note,
  };
}

/** A project's notes (a STATE.md, a ledger, any structured markdown). */
export function draftsFromNotes(file: string, opts: ImportOptions = {}): ImportDraftInput[] {
  const text = readFileSync(file, "utf8");
  const parsed = sections(text);
  const fileDate = statSync(file).mtime.toISOString();
  const project =
    opts.project ?? projectFromTitle(parsed.title) ?? path.basename(path.dirname(file));
  const base = { author: opts.author, machine: opts.machine };
  const drafts: ImportDraftInput[] = [];
  let overview: string | undefined;
  const mapProject = (subject: string) => {
    for (const [word, name] of Object.entries(opts.projectMap ?? {})) {
      if (subject.toLowerCase().includes(word.toLowerCase())) return name;
    }
    return undefined;
  };

  for (const s of parsed.sections) {
    const heading = clean(s.heading);
    if (SKIP.test(heading) || NEVER.test(heading) || /^YYYY/.test(heading)) continue;

    // Ledger: "2026-08-20 13:57 PDT | Codex | TAKEOVER | Romarr reverse proxy"
    const ledger = /^(\d{4}-\d{2}-\d{2}[^|]*)\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.+)$/.exec(
      heading,
    );
    if (ledger) {
      const [, when, agent, event, subject] = ledger;
      drafts.push(
        entry(
          file,
          heading,
          {
            kind: "journal",
            title: `${clean(subject!)} (${event!.toLowerCase().replace(/[_-]+/g, " ")})`,
            body: s.body,
            happenedAt: parseWhen(when!),
            basis: "documented",
            author: clean(agent!),
            projectName: mapProject(subject!) ?? opts.project,
            machine: opts.machine,
          },
          "ledger entry",
        ),
      );
      continue;
    }
    if (opts.ledgerOnly) continue;

    if (OVERVIEW.test(heading) && !overview) {
      overview = s.body;
      continue;
    }

    if (OPEN_WORK.test(heading)) {
      for (const item of items(s.body)) {
        const resolved = /~~|^\W*(done|resolved|closed)\b|\b(RESOLVED|DONE)\b/.test(item);
        const title = itemTitle(item);
        drafts.push(
          entry(
            file,
            `${heading} / ${firstSentence(item, 80)}`,
            {
              ...base,
              kind: "thread",
              title,
              body: clean(item) === title ? undefined : item,
              status: resolved ? "done" : "open",
              happenedAt: fileDate,
              basis: "documented",
              projectName: project,
            },
            resolved ? "item marked resolved in an open-work list" : "item in an open-work list",
          ),
        );
      }
      continue;
    }

    if (CONVENTIONS.test(heading) && s.level <= 2) {
      for (const item of items(s.body)) {
        drafts.push(
          entry(
            file,
            `${heading} / ${firstSentence(item, 80)}`,
            {
              ...base,
              kind: "preference",
              title: firstSentence(item),
              body: clean(item) === firstSentence(item) ? undefined : item,
              happenedAt: fileDate,
              basis: "documented",
              projectName: project,
            },
            "item in a conventions list",
          ),
        );
      }
      continue;
    }

    if (HARDWARE.test(heading) && s.body.length > 40) {
      drafts.push(
        entry(
          file,
          heading,
          {
            ...base,
            kind: "hardware",
            title: `${project}: ${heading}`,
            body: s.body,
            happenedAt: fileDate,
            basis: "documented",
            projectName: project,
          },
          "infrastructure section",
        ),
      );
      continue;
    }

    // Dated: "2026-10-05 - Title", "Title (added 2026-08-03)", "Progress log - X (2026-09-05)", "D3 - Title".
    const leading = /^(\d{4}-\d{2}-\d{2}(?:\/\d{2})?)\s*[—–-]+\s*(.+)$/.exec(heading);
    const trailing =
      /^(.*?)\s*\((?:added |done |as of )?(\d{4}-\d{2}-\d{2})(?:[^)]*)\)\s*(?:[—–-]+\s*(.*))?$/.exec(
        heading,
      );
    const decision = /^(?:D|ADR[- ]?)(\d+)\s*[—–-]+\s*(.+)$/i.exec(heading);
    if (leading || trailing || decision) {
      const title = leading
        ? leading[2]!
        : trailing
          ? [trailing[1], trailing[3]]
              .filter(Boolean)
              .join(": ")
              .replace(/^Progress log\s*[—–-]+\s*/i, "")
          : `Decision: ${decision![2]}`;
      const when = leading
        ? parseWhen(leading[1]!)
        : trailing
          ? parseWhen(trailing[2]!)
          : parseWhen(s.body);
      let named = clean(title);
      named = named.charAt(0).toUpperCase() + named.slice(1);
      if (OVERVIEW.test(named) || /^current .{0,20}state$/i.test(named))
        named = `${project}: ${named.toLowerCase()}`;
      drafts.push(
        entry(
          file,
          heading,
          {
            ...base,
            kind: "journal",
            title: named.slice(0, 200),
            body: s.body,
            happenedAt: when ?? fileDate,
            basis: "documented",
            projectName: project,
          },
          decision
            ? when
              ? "decision"
              : "decision (no date in the note; file date used)"
            : "dated section",
        ),
      );
      continue;
    }

    // Anything else substantial is kept as a note, so nothing useful is lost.
    if (s.body.length >= 300 && s.level <= 3) {
      drafts.push(
        entry(
          file,
          heading,
          {
            ...base,
            kind: "note",
            title: `${project}: ${heading}`.slice(0, 200),
            body: s.body,
            happenedAt: fileDate,
            basis: "documented",
            projectName: project,
          },
          "section",
        ),
      );
    }
  }

  if (!opts.ledgerOnly && project) {
    drafts.unshift({
      sourceRef: `md:${ref(path.resolve(file), "project")}`,
      origin: path.resolve(file),
      anchor: "project",
      payload: {
        kind: "project",
        project: { name: project, summary: overview ? clean(overview).slice(0, 4000) : undefined },
      },
      note: "project from the file's title",
    });
  }
  return drafts;
}

/** One note per document, for reference folders (one file per service, say). */
export function draftsFromReference(
  dir: string,
  opts: ImportOptions & { kind?: MemoryKind } = {},
): ImportDraftInput[] {
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".md") && !NEVER.test(f))
    .map((f) => {
      const file = path.join(dir, f);
      const text = fixMojibake(readFileSync(file, "utf8").trimStart());
      const title = /^#\s+(.+)$/m.exec(text)?.[1] ?? f.replace(/\.md$/i, "");
      return entry(
        file,
        "whole file",
        {
          kind: opts.kind ?? "note",
          title: clean(title).slice(0, 200),
          body: text,
          happenedAt: statSync(file).mtime.toISOString(),
          basis: "documented",
          projectName: opts.project,
          author: opts.author,
          machine: opts.machine,
        },
        "reference document",
      );
    });
}

/** Dated session-log folders: "2026-08-03 - Wizarr Setup/log.md" -> one journal entry. */
export function draftsFromSessionLogs(dir: string, opts: ImportOptions = {}): ImportDraftInput[] {
  const out: ImportDraftInput[] = [];
  for (const folder of readdirSync(dir)) {
    const full = path.join(dir, folder);
    if (!statSync(full).isDirectory() || NEVER.test(folder)) continue;
    const log = ["log.md", "LOG.md", "session.md"]
      .map((f) => path.join(full, f))
      .find((f) => existsSync(f));
    if (!log) continue;
    const date = parseWhen(folder);
    const body = fixMojibake(readFileSync(log, "utf8"));
    if (opts.homelabOnly && !isHomelab(`${folder}\n${body}`, opts.names)) continue;
    const title = folder.replace(/^\d{4}-\d{2}-\d{2}\s*[—–-]+\s*/, "");
    out.push(
      entry(
        log,
        "session log",
        {
          kind: "journal",
          title: `Session: ${title}`,
          body,
          happenedAt: date,
          basis: "documented",
          author: opts.author,
          machine: opts.machine,
          projectName: opts.project,
        },
        "session log",
      ),
    );
  }
  return out;
}

/** Past Claude Code sessions about the homelab, word for word (no tool output, no reasoning). */
export function draftsFromClaudeSessions(
  dir: string,
  opts: { machine?: string; skip?: string[]; names?: string[] } = {},
): ImportDraftInput[] {
  const out: ImportDraftInput[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
    const id = f.replace(/\.jsonl$/, "");
    if (opts.skip?.includes(id)) continue;
    // Sessions the companion already saves as they happen need no import.
    if (existsSync(path.join(home(), "sessions", `${id}.json`))) continue;
    const { messages, title } = readSession(path.join(dir, f));
    // About the homelab when enough of what you said was: one mention in a
    // long session about something else does not make it a homelab session.
    const yours = messages.filter((m) => m.role === "you");
    const about = yours.filter((m) => isHomelab(m.text, opts.names)).length;
    if (!about || about / yours.length < 0.15) continue;
    const said = yours.map((m) => m.text).join("\n");
    out.push({
      sourceRef: `session:claude-code:${id}`,
      origin: path.join(dir, f),
      anchor: "session",
      payload: {
        kind: "session",
        session: {
          client: "claude-code",
          title: (title ?? said.split("\n")[0] ?? "Homelab session")
            .replace(/\s+/g, " ")
            .slice(0, 200),
          machine: opts.machine ?? hostname(),
          sessionRef: id,
          startedAt: messages[0]?.at,
          messages,
        },
      },
      note: `past Claude Code session, ${messages.length} messages`,
    });
  }
  return out;
}

export { NEVER as NEVER_IMPORT };
