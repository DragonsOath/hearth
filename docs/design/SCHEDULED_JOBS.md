# Scheduled jobs visibility: proposed security boundary (2026-10-09, not built, needs the owner's OK)

The owner approved visibility into cron jobs and systemd timers, read only, with "no arbitrary command
execution for the AI" and the boundary explained before any new host-level access is enabled.
This is that explanation. Nothing below exists yet.

## What is on the home server today (checked read-only 2026-10-09)

- **Hearth's own user (homelab):** 1 crontab line (the 05:30 nightly encrypted backup).
  One systemd user timer (launchpadlib cache clean).
- **System:** 17 systemd timers (apt, logrotate, sysstat, fstrim, e2scrub, man-db, and others),
  readable without privileges, systemd 255. `/etc/crontab` and `/etc/cron.d/*` are world-readable.
- **Not readable without root:** root's crontab (`/var/spool/cron/crontabs/root`) and other users'
  crontabs. Under this proposal they stay invisible, and Hearth says so instead of implying
  there are none.

## The boundary

1. **Same user, no new privileges.** Runs as the Hearth service user: no sudo, no group
   changes, no setuid. Whatever that user cannot read stays unread.
2. **A fixed list, decided in code, never by the AI or a request:**
   - `systemctl list-timers --all --output=json` (system timers)
   - `systemctl --user list-timers --all --output=json` (the service user's timers)
   - `crontab -l` (the service user's own crontab only, no `-u`)
   - `systemctl show <unit> --property=Result,ExecMainStatus,ExecMainExitTimestamp,ActiveState`,
     where `<unit>` must be a name returned by the timer list a moment earlier and match
     `^[A-Za-z0-9@._-]+\.service$`
   - Reading the files `/etc/crontab` and `/etc/cron.d/*` (plain file reads, not commands).
3. **No shell.** Each command runs with `execFile` (program and argument list, no shell, so no
   pipes, globbing, or `;`), with a 5-second timeout, a 256 KB output cap, and an environment
   reduced to `PATH` and `LANG`.
4. **The AI chooses nothing that reaches a command line.** Its tool, `scheduled_jobs`, takes only
   a text filter applied afterwards to the parsed results. There is no parameter that becomes a
   command argument. The unit names passed to `systemctl show` come from systemd's own list.
5. **Secrets hidden.** Cron command lines can carry tokens (`curl -H "Authorization: ..."`).
   Each line passes through the same redaction as logs, and is shown as the schedule, the user,
   and the command with secrets hidden.
6. **Off until switched on.** A Settings switch, "Show scheduled jobs on this machine", is off by
   default. Switching it on or off is audited. It covers this machine only. Home Vault and
   ai-box would need the host agents planned for Cave 3.
7. **Read only, structurally.** The module has no code path that runs `systemctl start/stop/
   enable`, `crontab -e`, or writes a file. Any change to a schedule stays a manual step or a
   future, separately approved plan.

## What the AI would see

Per job: where it comes from (system timer, user timer, user crontab, `/etc/crontab`,
`/etc/cron.d/<file>`), the schedule in words, the next and last run, the last result (success,
exit code, failed) for timers, and the command with secrets hidden for cron. That is enough for:
"did the nightly backup run?", "what runs at 3 a.m. when the disk gets busy?", and "is
logrotate failing?".

## Why this needs the owner's decision

Today Hearth reads the host only through files (`/proc`) and Docker's API. This adds
running programs on the host, a new class of mechanism even though the list is fixed and nothing
is elevated. The alternative with no new mechanism is reading the timer unit files and cron files
directly. That gives schedules but not the last result or next run, which are the useful part.

**Recommendation:** approve the fixed list above, built off by default. the owner switches it on after
reviewing it.
