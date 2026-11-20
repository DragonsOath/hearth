# Blockers, resolved where they happen

Added 2026-10-20, from the owner's Caddy test on the home server: the panel said "switched off, go to Settings > Ember > Administration". A known prerequisite should be offered where the owner already is.

## The rule

When a panel or workflow hits a known, actionable blocker, it shows the fix in that panel whenever that is technically and safely possible. It never routes around the existing controls: the fix is the same owner action, with the same confirmation, as anywhere else.

1. **Observe stays visible.** Read what can be read through the narrowest capability first. A panel shows its information read only and names what Manage still needs. It does not refuse the whole panel because changes are not allowed yet.
2. **Manage stays disabled** until its own prerequisites are met. Each one is reported separately and accurately.
3. **Delegate** (asking Ember) is offered for what Hearth must not change by itself. Ember gets a precise prompt that says "change nothing until I approve it".
4. **Never silently elevate.** Every resolution is an explicit owner action. Host-wide permissions say they are host-wide.

## The pieces

- `Blocker` (packages/core/src/blockers.ts): `kind`, `title`, `detail`, plus what the fix needs (host and operations, service and where its key is made, file, account, and read or write).
- `GapError(message, gap, blocker?)` (admin/scope.ts): a refusal can carry its blocker. `HostScopes.require` attaches a `host-admin` blocker. `HostScopes.blocker(op)` asks without throwing.
- Routes return `{ error: { message, blocker? } }` (`panelError` in app.ts) for the admin-backed panels (VPN, Recyclarr, Caddy, the Caddy form).
- `BlockerCard` (apps/web/src/components/blockers) renders a blocker. By kind:
  - **host-admin:** an inline switch. It states this is a permission for the whole machine, not only this app. It needs an explicit "I understand" tick and a fresh "it's you": the server refuses `POST /api/admin/scopes` without one, wherever it is asked from, including Settings. Switching off never asks. Once allowed, every dashboard query reads again by itself.
  - **app-key:** the paste-a-key form (PasteKey), straight into Secure Vault.
  - **file-access, capability, missing-config, service-down:** the exact gap, plus "Ask Ember for the next step". Hearth does not change file permissions, service accounts, or protected configuration from a blocker card.

## Caddy (the first full use)

- **Observe:**
  - **Sites:** read with a GET to Caddy's admin API on this machine (127.0.0.1:2019), when Caddy shares the host's network, as it does on the home server. This needs no host administration and runs nothing in the container.
  - **Certificate expiry:** read from the live HTTPS check, so it is the certificate visitors actually get. No certificate files are read.
  - **Errors:** from Docker's log, read the same way as every other panel's log.
  - **Fallback:** only when the admin API is not reachable from the host (bridge network) does the read need host administration, and it says so.
- **Distinct messages:**
  - **Not running:** `service-down`.
  - **Admin API off:** `missing-config`.
  - **No narrow way in:** `host-admin`, with the reason.
- **Manage** (the add and edit form) reports its first missing prerequisite, in order:
  1. Host administration with proposals (`host-admin`).
  2. A Caddyfile mounted from this machine (`missing-config`).
  3. Hearth's own account able to read it (`file-access`, read).
  4. Someone to write it (`capability`, write): the elevated executor, or a file Hearth's account may write.

  The form's server route checks the same thing, so it never gets further than the panel says.

## Applied so far, and next

- **Done:** Caddy, Gluetun, Recyclarr (host-admin blockers inline), Settings (the fresh "it's you" on switching on), and the Overseerr "Connect" (the key plan is confirmed in the panel instead of opening the Jobs page). App-key panels (Jellyfin, Immich, Kavita, Audiobookshelf, Wizarr, Plex, the *arrs via NeedsCredential) already resolve inline.
- **Next, as panels are touched:**
  - **Voice not set up:** the chat links to Settings for this; set it up inline instead.
  - **Resource history off:** the service tab links to Settings for this; switch it on inline.
  - **Approval plans:** some panels still open the Jobs page to approve a plan (the *arr and qBittorrent repairs). These are approvals rather than blockers, but they could use the in-panel confirmation (ConfirmedChange) the newer panels use.
