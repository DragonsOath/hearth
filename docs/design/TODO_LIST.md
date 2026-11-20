# Issues & ideas: the to-do list

The owner's direction (2026-10-09): Ember should be observant while it works, mention meaningful
secondary problems briefly without derailing the task, and keep a persistent list of issues,
tasks, and ideas with them, so they do not have to remember everything themselves.

## Model

`todo_items` + `todo_events` (migration 0030), `apps/server/src/todos/service.ts`.

- Category issue / task / idea; priority high / medium / low; status open, investigating, waiting
  for approval, deferred, resolved, dismissed, plus **suggested** (noticed by Ember, not on
  the list: `saved_at` is null).
- Each item: stable number (#12), title, description, affected services, project (memory
  project), evidence (same shape as Cave evidence), next action, the conversation it came from,
  linked jobs, source (you / Ember), created / saved / resolved times.
- Every change is an event (who, what, from and to status, conversation). Nothing is rewritten.
- Why a new table rather than `project_tasks`: project tasks are one project's checklist (project
  required, four statuses). Items here cross projects and systems; they link to projects instead
  and show on the project's Tasks tab.

## What Ember may do

Server-enforced (`cave/todo-words.ts` reads the owner's own message; the AI cannot grant itself
anything):

| Action | Allowed when |
| --- | --- |
| `note_finding` (suggest) | always, max two per answer, refused for duplicates and for things dismissed in the last 30 days |
| `save_todo` (onto the list) | the message asked: "add it to the list", "remind me later", "back burner", "track that"... |
| `update_todo` resolved | the message says it is done / fixed ("mark that done") |
| `update_todo` dismissed | the message says to drop it ("we can ignore that"); suggestions too |
| `update_todo` deferred | the message says later / back burner |
| `update_todo` investigating | the AI is actually working on it (not in chat or brainstorm mode) |
| priority | the message asked |
| notes, next action | always (they only add history) |

An explicit request saves at once, with no second confirmation. Saving an item never authorizes
work on it: plans still need the owner's exact approval, and all jurisdiction, credential, and
protected-infrastructure rules are unchanged.

## Conversation

- The system prompt asks it to notice meaningful secondary problems, record them with
  `note_finding`, and mention them in one sentence at the end without changing course.
- Each message's context includes the items raised or worked on in this conversation, in order
  (so "that", "the one you just mentioned", "the second one" resolve), the open list (not for
  small talk), deferred items when asked about the list, and the full item with its history when
  it is the subject (focus `todo`).
- "Let's work on #3 now" counts as a build request. The item is set investigating, its history
  and linked plans are picked up, and a plan proposed with `todoNumber` is linked to it. The item
  follows its plans: waiting for approval while one waits, investigating while one runs, back to
  open if one is declined or fails (noted in its history). A successful plan is noted, but the
  item is not closed.

## Is it still happening?

For issues tied to watched systems, `Todos.checks` compares what monitoring sees now with the item:
**still happening** (open incident, failing checks, failing in-app health, or incidents since it
was saved), **looks resolved** (every affected system has passed its checks since it was saved,
with no incidents; noted that intermittent problems may not show), or **not verified**. This is
shown and given to the AI; it never closes anything.

## Command center

- `/todo` (sidebar "To-do" with a badge; phones: More > To-do): kind tabs, filters for status,
  priority, project, and system kept in the address, "Noticed by Ember, not saved" with
  Add / Later / Ignore, rows with priority, systems, and current state, and a detail sheet with
  evidence, plans, the conversation, history, notes, priority, and status actions.
- Under Ember answers: what it noticed (Add to list / Later / Ignore) and items it saved.
- "Work on it with Ember" reopens the conversation the item came from, about the item.
- A project's Tasks tab lists its open to-do items.

## Reuse in other installations

Nothing is specific to one homelab: items refer to whatever services and projects the
installation has. The phrase reading is plain English rules in one file.
