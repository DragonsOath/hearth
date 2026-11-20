# Working on Hearth

Guidance for Claude Code sessions (local or cloud) working in this repository.

## Layout

- `apps/server`: Fastify API, monitors, the AI tools (MCP), jobs and approvals. Serves the UI.
- `apps/web`: React 19 + Vite + Tailwind 4 single-page app.
- `packages/core`: shared types and policy (`policy.ts` decides what may run; the server enforces it).
- `tests/e2e`: Playwright, desktop and mobile, against the built app.
- `docs/design`: design notes. `deploy/linux/install.sh`: the service installer.

## Commands

```sh
pnpm install
pnpm typecheck                # or: pnpm exec tsc -p apps/server --noEmit / -p apps/web
pnpm lint
pnpm format:check             # Prettier; run `pnpm format` to fix
pnpm test                     # Vitest (server and web unit tests)
pnpm build
pnpm exec playwright install chromium   # once
pnpm test:e2e                 # about 9 minutes; run it before a change is called done
```

## Rules

- **Approvals are never bypassed.** Anything that changes a system is a plan step the owner
  approves (`apps/server/src/jobs`). An AI never decides its own permissions.
- **The AI never sees secrets.** Credentials go through the broker (`apps/server/src/credentials`);
  never return, log, or show a secret value, and never read one into a prompt.
- **Protected systems** (VPN, reverse proxy, firewall, networking) change only through plans
  marked protected, which ask the owner to confirm it is them. Hearth never runs as root.
- **No fixed menus.** Ember is not limited to the operations Hearth has built: `app_api`
  (`apps/server/src/apps/app-api.ts`) reaches any connected app's own API with its vault key.
  Changes are an `app-api-call` plan, or direct while the owner's Full access is on. When an
  app gains a typed operation, keep `app_api` working for everything else.
- **Approval, not incapability.** Ember should be able to do what a competent administrator would,
  inside the scope the owner authorized. Sensitive work needs approval; do not design permanent
  "cannot" dead ends. Root work goes only through the elevated executor's typed catalog
  (`apps/server/src/elevated`, docs/ELEVATED_EXECUTOR.md), never a general command or shell.
- **Full capability without full complexity** (native app panels and integrations): everything
  the app can do, reachable in Hearth; everyday things up front, advanced one obvious step away, no
  needless tabs, context links to the fixing control, Ember complements rather than compensates.
  See `docs/design/NATIVE_PANELS_UX.md` before adding or reshaping a panel.
- **Plain English in the interface.** Short, concrete, no jargon. Never use em-dashes in UI copy,
  docs, or comments; use a period, comma, or colon.
- Match the surrounding code: comments explain why, in full sentences. Files use LF line endings.
- Every feature gets tests: unit tests next to the code, and an e2e test for anything visible.
- **Keep `docs/HEARTH_FOR_AI.md` current.** It is the guide the AI inside Hearth (War Room and
  Lair) reads to answer "where is", "what does this do" and "why is memory high". When you add,
  rename, move or remove a visible feature, update it in the same change. Keep it under 12,000
  characters (a test checks): it goes with every message.
- **Keep `docs/HEARTH_MANUAL.md` current too.** It is the full manual (every page, panel, button
  and setting) that the AI reads on demand for how-to questions; its first section is the
  "What can Hearth do?" list. Update it in the same change as any visible feature.
- **Keep the feature list current** (`packages/core/src/features.ts`): what the AI's `hearth_help`
  tool answers from. A new or changed feature updates its entry (where it is, exact on-screen
  names, status, the test that proves it, what it needs, what the AI can do) and its
  `<!-- feature: id -->` tag in the manual. `features.check.test.ts` fails when a page, label,
  test or tool it names does not exist. The list describes; it never grants a permission.
  "working" needs a test as evidence, not just a page or button.
- Status colors (green, amber, red) keep their meaning in every theme.
- **Agent parity.** Every AI agent (Claude Code, Codex, Ollama, and any added later) gets the
  same access in the War Room (`engine/runners.ts`) and the Lair (`agent/providers.ts`). When one
  gains a tool, permission, prompt or fix, check and apply it to all of them in the same change.
  Ollama runs through the Claude Code harness, so Claude Code changes reach it; Codex differs.

## Pull requests

Work on a branch and open a pull request with what changed and how it was tested. CI runs the
type checks, lint, formatting, unit tests, and build. Deploying to a real server is done by the
owner from their own network, not from a cloud session.
