# Long work: reporting progress from your machines

Part of Phase 0 in [AGENT_NEEDS_PLAN.md](AGENT_NEEDS_PLAN.md). Anything that runs for more than a
minute outside a plan (voice training on the GPU machine, a big copy, a migration script) can tell
Hearth how it is going. When it stops reporting, Hearth marks it stalled and tells
you once, instead of you finding out an hour later.

## Set up a key

Settings > Access keys > New key, with only the **Long work** scope. The key can start long work
and report on it, nothing else: it cannot read your systems, talk to the AI, or change anything.
Store it where the script can read it (an environment variable), never in the script itself.

## Report from a script

Start tracking (returns the work's `id`):

```sh
curl -s -X POST "$DC_URL/api/work" \
  -H "Authorization: Bearer $DC_WORK_KEY" -H "Content-Type: application/json" \
  -d '{"title": "Voice training", "machine": "Gaming-PC", "stopBy": "2026-10-14T18:00:00-07:00", "stallMinutes": 15}'
```

Then report as it goes. Any report is a heartbeat:

```sh
curl -s -X POST "$DC_URL/api/work/$ID" \
  -H "Authorization: Bearer $DC_WORK_KEY" -H "Content-Type: application/json" \
  -d '{"progress": 42, "detail": "operator: 420 of 1012 lines"}'
```

Finish with `"status": "done"`, `"failed"`, or `"stopped"`. "Stalled" is never reported;
Hearth decides it from the heartbeat.

| Field          | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `title`        | What it is, in plain words.                                             |
| `machine`      | Where it runs.                                                          |
| `stopBy`       | Optional. It must be finished by then (for example before a reservation). |
| `stallMinutes` | Optional, default 10. No report for this long means stalled.            |
| `progress`     | Optional, 0 to 100.                                                     |
| `detail`       | Optional. The latest line worth showing.                                |

## What happens

- Jobs shows a **Long work** section with each one's progress and last report.
- Every minute Hearth checks the heartbeats. Stalled, failed, and past-its-stop-time are
  sent at any hour through the **Long work** notification route; "finished" waits for quiet hours
  to end. Each is sent once; a stalled job that reports again is running again.
- The AI sees running and stalled work in every conversation, and its `long_work` tool lists it,
  so it can check before suggesting heavy work on a busy machine.
