# Importing existing notes

Most homelabs already have a history somewhere: markdown notes, a running
log, per-service reference docs, past AI sessions. The importer reads them
into **drafts**. Nothing becomes a memory until you accept it in
Hearth under **Memory → Review**, and the source files are only ever read.

## How it works

1. You write an import plan: a small JSON file on the machine that has the
   notes. It names your own paths, so keep it out of any repository (the
   companion folder, `~/.dragon-control/`, is a good place).
2. `companion.mjs import <plan.json> --dry-run --out drafts.json` reads
   everything and reports what it found, sending nothing.
3. Without `--dry-run`, the drafts are sent to Hearth with the
   companion's key. Keys with the Homelab memory scope may propose drafts;
   only you, signed in, can accept or reject them.
4. Review in Hearth: accept a whole file at once, or open a draft
   to correct its title, kind, project, date, or text first.

Re-running an import is safe. Each draft is keyed by its source file and
section, so drafts still waiting are refreshed, decided ones keep your
decision, and an accepted session gets any messages added since.

## The plan

```json
{
  "batch": "Homelab notes, first import",
  "author": "Claude Code",
  "machine": "my-server",
  "projectMap": { "plex": "Media server", "usenet": "Downloads" },
  "sources": [
    { "type": "notes", "path": "/notes/Media/STATE.md", "project": "Media server" },
    { "type": "notes", "path": "/notes/shared-log.md", "ledgerOnly": true },
    { "type": "reference", "path": "/notes/Reference", "project": "Homelab" },
    { "type": "logs", "path": "/notes/Sessions", "homelabOnly": true },
    { "type": "claude-sessions", "path": "~/.claude/projects/my-notes", "skip": ["<session id>"] }
  ]
}
```

| Source type | Reads | Becomes |
| --- | --- | --- |
| `notes` | One structured markdown file | A project, plus one draft per section (see below) |
| `reference` | Every `.md` in a folder | One note per document |
| `logs` | Dated folders (`2026-08-03 - Title/log.md`) | One journal entry per session log |
| `claude-sessions` | Claude Code session files (`*.jsonl`) | Whole sessions, word for word, when at least 15% of what you said was about the homelab |

`projectMap` assigns ledger entries to projects by words in their subject.
`ledgerOnly` keeps only ledger entries from a file that also repeats other
notes. `homelabOnly` skips session logs that are not about the homelab.
Sessions the companion already saves as they happen are skipped.

## How notes are read

| In the file | Draft |
| --- | --- |
| `# Title` | The project's name (`STATE`-style prefixes are dropped) |
| `## Project overview` / `## Status` | The project's summary |
| `### 2026-08-20 13:57 PDT \| Agent \| EVENT \| Subject` | Journal entry with that time and author |
| `### 2026-10-05 - Title`, `## Title (added 2026-08-03)` | Journal entry on that date |
| `### D3 - Title` | Journal entry, "Decision: Title" |
| Lists under `Open items`, `Not yet decided`, `Blockers`, `Next` | One thread per item; struck-through or RESOLVED items are kept as closed threads |
| Lists under `Conventions`, `Preferences`, `Rules` | One "how you work" entry per item |
| `## Infrastructure`, `## Hardware` | A hardware entry |
| Any other section of 300+ characters | A note, so nothing useful is lost |

Every draft records where it came from, and the accepted memory links back
to the file and section.

## Sorted for review

Hearth sorts waiting drafts so the straightforward ones can be kept in bulk and only the
questions need opening (`apps/server/src/memory/triage.ts`). It only suggests, and each draft
says why; nothing is kept or left out until you decide.

| Group | What lands there |
| --- | --- |
| **Ready to keep** | Dated history (journal entries, decisions, log entries: true when written, whatever changed since), items marked resolved, past sessions mostly about the homelab, projects, and notes about an app Hearth sees where nothing conflicts |
| **Worth a look**, by question | *Describes an earlier setup*: current-sounding notes that disagree with what Hearth sees now. *Open items that mention the earlier setup*: the problem may still be real. *Can't be checked*: about things Hearth doesn't watch. *Confirm they still apply*: open items, how you work, setup notes |
| **Probably leave out** | Copies of another draft with more detail, of a memory you already have, or of a session already saved; material mostly not about the homelab |

**Conflicts** are found by comparing the text with what Hearth observes on your real
systems (never sample data): which machine each app runs on and its operating system (Windows
paths or Docker Desktop for an app now on Linux), another machine named as its home, or a port it
no longer uses. Sentences about a change ("moved to", "was", "no longer") are history, not a
claim about now.

**History, not current setup:** keeping a draft that conflicts saves it as superseded: searchable
and readable, labelled History in Memory, and never shown to a companion as how things are now.
Open the draft and choose "Current" to keep it as current instead; later, any memory can be
switched either way ("No longer true" / "Still current"). Dated history is never marked
superseded, and open threads that mention an earlier setup are flagged, never closed for you.

**Bulk review:** each group has "Keep all" or "Leave out all" (with a confirmation), every row has
a checkbox for picking by hand, and the source filter narrows everything to one file or folder.

## Secrets

Files and folders whose names suggest secrets (`secret`, `credential`,
`password`, `.env`, `private key`, `recovery key`, `encrypted vault`) are
never read; naming one in a plan is refused. Everything that is read passes
through the same redaction as saved sessions before it is stored, including
passwords written in sentences ("the admin password is ...", "PIN `1234`").
Redaction errs on the side of hiding. Review still matters: if you spot
something sensitive in a draft, edit it out or leave the draft out.
