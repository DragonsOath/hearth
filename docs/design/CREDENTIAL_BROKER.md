# Secure Vault as a credential broker

The owner's direction (2026-10-09): the vault exists to let Ember investigate, manage, and
repair systems with the right credentials, without the owner re-entering them, pasting them into
chat, or telling it where they are. Reusable for any installation.

## How it works

- **The AI asks for operations, never secrets.** Its tools are fixed (read an app's health, run a
  check, propose a plan). None returns a credential, and there is no tool for authenticated
  requests to arbitrary addresses or for reading the vault.
- **The broker picks and uses the credential** (`apps/server/src/credentials/broker.ts`). For
  each service Hearth understands (the app catalogue in `packages/core/src/apps.ts`
  says what each needs: an API key or a Web UI login, and where to find it), the broker finds the
  vault entry linked to that service, automation tier, and hands the value to the calling code
  for one request.
- **Destination control.** A credential is only ever sent to its service's own address (the
  service's recorded address, or the address recorded on the credential). Anything else is
  refused, whatever asked for it.
- **Use is not permission.** Each credential has a scope: "Diagnostics only (read)" or
  "Diagnostics, and changes you approve" (default). A change needs both the scope and the plan
  approval of the exact before and after; the scope never replaces the approval.
- **Never in the open.** Values are not put in prompts, conversations, progress, tool results,
  audit entries, logs, or errors. Errors from a use are scrubbed of the value (and its
  URL-encoded form) before they are stored or shown.
- **Track record.** Each use updates last used, last worked, and the last failure (scrubbed), so
  the vault shows which services work and which need attention.

## What Ember can see and do (2026-10-09)

Before this, the broker worked but the AI had no view of it: `app_health` only returned the last
background read and told it "needs-key means the owner has not added its credential", so it
answered "I can't see the vault contents" and asked the owner to check things it could have
checked. Now:

- `vault_status`: per service, whether a credential is stored and linked, its kind, whether its last
  use worked, the kind of the last failure, what it may be used for (scope), which operations
  that enables, and whether an import is offered. Never values or usernames.
- `app_health` with `live: true`: a read now through the broker (the Diagnostics panel's live
  read, rate-limited, read only). The broker picks and uses the linked credential.
- The instructions say the vault is connected through the broker, to check `vault_status` instead
  of guessing, never to ask for a secret in the conversation, and that reading never permits a
  change.
- **Audit (2026-10-09):** every use the AI asks for (a live `app_health` read, any
  `home_assistant` read) is audited when it happens: "Ember used <service>'s Secure Vault
  credential to <purpose> (read only): worked/failed", with the purpose and, on failure, the
  scrubbed reason. Never the value. Hearth's own background reads (every few minutes) and
  the Diagnostics panel's refreshes are not audited one by one; they show as the credential's
  last-worked time.
- **Home Assistant (2026-10-09):** a long-lived token (kind API key), sent only as a Bearer header
  to Home Assistant's own address; the reader can only make a fixed list of read requests.

## Failure kinds

Each failed use records `last_failure_kind` (migration 0031): `rejected` (the app says the
credential is wrong: the only kind that means "replace it"), `unreachable`, `blocked` (the app
is temporarily refusing sign-ins), `incompatible` (Hearth could not complete the sign-in:
its bug or an app setting, not the credential), `internal`. The vault page and the AI both show
it. Found through qBittorrent 5, which names its session cookie `QBT_SID_<port>`: qBittorrent
logged every Hearth sign-in as successful while Hearth reported "refused the
username or password".

## Adding a credential

- From a service's Diagnostics tab, from a card under a Ember answer that involved the
  service, or from Secure Vault > "What Hearth can use": **Add** opens a form (the value
  is a password field, sent straight to the vault, never into a conversation), saves it linked
  to the service, and tries it at once.
- **Import, when you ask.** If the app keeps its key in its own settings file on this machine
  (Prowlarr, Radarr, Sonarr: `config.xml`; SABnzbd: `sabnzbd.ini`, found through the
  container's `/config` mount), the form offers to import it. Detection only checks that the file
  exists. Importing needs you to have just confirmed it is you, reads that one value into the
  vault, is audited without the value, and never returns it. qBittorrent keeps its password
  hashed, so it cannot be imported.
- **Generated credentials.** When an authorized workflow creates a credential, `storeGenerated`
  stores it linked to the service, automation tier, with its source, audited without the value.

## For other installations

Nothing is specific to one homelab: needs come from the app catalogue, sources from each app's
standard settings file and its container mounts, destinations from the services discovery found.
Adding an app: its catalogue entry (credential kind, where to find it, topics), its reader, and,
if it keeps its key in a known settings file, a source definition.
