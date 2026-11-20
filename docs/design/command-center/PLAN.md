# Command Center: how the spec fits what exists

Source: `DRAGONS_CAVE_COMMAND_CENTER_SPEC.md` and the two reference images in this folder (the owner,
2026-10-08). The images are the visual target; the spec is the functional one. Reference data
(versions, metrics, log lines) is illustrative and never copied into the product.

## Fit with the current architecture (no rewrites)

| Spec | Built on |
| ---- | -------- |
| Projects (broader than jobs) | The existing **memory projects** (already real: e.g. Hearth, Linux Migration, Home Assistant and Belle). Extended with a phase, an icon, related systems, and tasks. Jobs gain an optional project link; notes are memory entries already linked by project; history is the audit trail. No data migration beyond adding columns. |
| Main and project conversations | The existing **conversations** (Ember). One main conversation (a setting points at it); project conversations carry a project id. One store, scoped, never duplicated. |
| Hub, expanded chat, split screen | A shell-level "cave dock" around the existing Ask conversation code: collapsed (the circle on Home), expanded (overlay), or docked left beside a workspace. The open workspace lives in the URL (`?project=` / `?service=`), so refresh and back restore it. |
| Systems explorer and service workspace | Discovery, monitoring, lifecycle (paused, retired, stopped on purpose), incidents, actions, jobs, app integrations (Prowlarr). Container uptime, ports, CPU and memory come from read-only Docker reads; anything not available is labelled so. |
| Actions in the workspace | The existing ActionRunner, policy, approvals, and jobs. Buttons never add a second execution path. Start and stop (approved 2026-10-09) go through the same runner and jobs; see `docs/CAVE2_OPERATIONS_PROPOSAL.md`. |
| Terminal tab | Captured output only (logs Hearth read, job step results). No interactive shell: that needs its own security review. |
| Files tab | Not supported by the backend yet; shown as unavailable rather than faked. |
| Secure Vault | The existing vault (AES-256-GCM, automation and protected tiers, passkey/password unlock, audited use, never in prompts). Extended with categories, username, endpoint, notes, tags, verified time, and more kinds. |
| PIN unlock | **Tradeoff:** a short PIN is not added as a key or a password. Unlocking uses a passkey (on a phone that *is* the device PIN or fingerprint, backed by real cryptography) or the password, then the vault auto-locks after 5 minutes. This keeps the stronger controls the spec asks to preserve. |
| AI use of credentials | Unchanged rule: integrations use secrets server side (Prowlarr today); the model only sees results. |
| Context-aware chat | The open project or service is sent with each message as an explicit, removable focus, and included in the evidence pack. |

## Status (2026-10-09)

Built: steps 1 to 5 below, verified on Windows and Linux (see PROJECT_STATE verification log).
Second pass: live step-by-step progress in Ember (real events only), per-project ongoing
conversations, tablet split screen (768 px and up) with the sidebar as an icon rail.
Labelled unavailable rather than faked: Files tabs, interactive terminal. The emblem is the
dragon's-eye mark drawn as a vector; a full dragon illustration can replace `DragonEmblem` when
artwork exists.

## Build order

1. Projects backend (phase, icon, related systems, tasks, job and conversation links, main conversation, focus).
2. Shell: sidebar with groups and the Systems list, hub with surrounding project cards, cave dock (collapsed, expanded, docked), project and service workspaces.
3. Service workspace tabs with live/recorded labels; Docker read-only stats.
4. Vault: locked view, unlock, categories and fields.
5. Mobile and tablet states, accessibility, tests on Windows and Linux, deploy.
