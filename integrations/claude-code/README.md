# Hearth for Claude Code (the homelab companion)

Puts Hearth's homelab memory into every Claude Code terminal on a machine. The first time
you mention anything homelab in a session, Claude switches into homelab mode and is handed a
briefing: what needs you, recent history, open threads, projects, how you like to work, hardware,
and the live state of your systems. It saves decisions, fixes, wins, and unfinished work as they
happen, and homelab sessions are saved word for word (secret-looking text hidden) so later
sessions can search the actual reasoning.

When Hearth cannot be reached, Claude works from a cached copy and says so, with its age;
saves are queued on the machine and sent automatically, once each, when it is back.

## What it adds to Claude Code

- **Hooks:** on each prompt (homelab detection and the briefing; about 0.1 s and no network for
  prompts that are not about the homelab), after each reply and at session end (save the
  session so far, send queued saves).
- **Tools** (MCP server `dragon-control`, run locally): `briefing`, `recall`, `read_session`,
  `remember`, `update_memory`, `list_memories`, `companion_status`.
- **Skill** `homelab`: how to behave in homelab mode (live vs cached, saving as you go, never
  saving secrets).

## Install on a machine

Needs Node.js 22 or newer and Claude Code.

1. **A key for this machine** (Homelab memory permission only: read and add, never delete). On the
   Hearth server:

   ```bash
   cd /srv/homelab/projects/dragon-control
   DC_DATA_DIR=$PWD/data node apps/server/dist/tools-cli.js companion-key \
     --name "Claude Code on <machine>" --url https://homeserver.tail1a2b3c.ts.net --out /tmp/companion.json
   ```

   Copy that file to `~/.dragon-control/companion.json` on the machine (on the server itself, use
   `--url http://127.0.0.1:7400`), then delete `/tmp/companion.json`. The key is never printed.
   Revoke it any time in Hearth under Settings > Access keys.

2. **The plugin.** Build once (`pnpm build` in the repo creates `plugin/companion/companion.mjs`),
   then:

   ```bash
   claude plugin marketplace add "<repo>/integrations/claude-code/plugin"
   claude plugin install dragon-control@dragon-control
   ```

3. **Check:** `node <repo>/integrations/claude-code/plugin/companion/companion.mjs briefing`
   prints a LIVE briefing.

Local state lives in `~/.dragon-control/`: `companion.json` (address and key), `cache/` (last
briefing and memories), `pending/` (saves waiting to sync), `sessions/` (which sessions are in
homelab mode and how much of each is saved), `rejected/` (saves Hearth refused, kept for a
look).
