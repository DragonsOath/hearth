# Panel donations

Hearth's panel donation service (Premium: **Donate your panel**). A Hearth with Hearth Premium
(Panel Builder) sends a custom panel here; it becomes a pull request on the private Premium
repository, where the owner reviews it. Nobody needs a GitHub account.

**Not deployed.** No workflow deploys it. Deploying waits on the owner's approval, the
`dragonsoath-dev` token, the private repository, and the licence signing key (its public half goes
into `LICENCE_KEYS`).

## How it works

1. **Accept** (`POST /v1/panels`): the body is `{ panel, licence, credit? }`, at most 64 KB.
   - **Premium only.** `licence` is the Hearth's licence key. It is checked here, offline: signed
     by a key in `LICENCE_KEYS` (the same public keys as Hearth's `PRODUCTION_KEYS`), unchanged,
     started and not ended, not taken back (a `revoked:<licence id>` entry in the store, put by the
     owner), and it must include Panel Builder. Otherwise 403 with a plain reason.
   - **Credit** (optional): a short name (letters, numbers, spaces) and a GitHub user name. Both
     are checked; nothing else about the donor is kept.
   - Nothing sent is trusted: the published file is rebuilt from the panel spec alone with the same
     code Hearth's preview uses (`contributionFile`). The description is regenerated; the app name
     is the panel id's own; a container image loses any registry host and tag. Every other field
     is dropped.
   - It must pass Hearth's validator (`validatePanelSpec`) and the privacy checks
     (`contributionProblems`), and carry the contribution agreement.
   - Limits: per licence per day (3), per network address per day (5, a salted hash kept a day)
     and a daily total (50). All are checked before any is counted.
   - The same panel again gets the same receipt and no second pull request.
   - It is stored durably (Workers KV) and answered at once with a **signed receipt** (Ed25519),
     bound to the exact published spec by its hash.
2. **File** (scheduled, every 10 minutes): up to `PER_RUN` queued donations become pull requests
   on `REPO` (`DragonsOath/hearth-premium`). Each creates a `donation/` branch, adds one file,
   `donations/<app>/<name>.json` (the rebuilt panel, the credit and the receipt), opens a pull
   request labelled `donation` and `skin`, and records its link. When the donor gave a GitHub user
   name that exists, the commit has a `Co-authored-by:` line with their public noreply address. A
   GitHub failure leaves it queued; after 10 failures it is held for a maintainer, still stored.
3. **Status** (`GET /v1/panels/<id>`): queued, filed (with the pull request link) or held.
4. **The token's expiry** (`GET /v1/status`): GitHub reports it with every answer; the service
   keeps it and looks at least twice a day even with nothing to file. Hearth, on the owner's
   issuing Hearth, warns in "Needs you" 14 days before it expires, with the steps below.

## Deploy (owner, once approved)

1. **Receipt key.** Make an Ed25519 key pair on a trusted machine. The private half (PKCS#8,
   base64) becomes the `RECEIPT_KEY` secret. Its public half (raw, base64url) and id (its first 12
   letters) go into `PANEL_INTAKE_KEYS` in `apps/server/src/panels/receipt.ts` in a release, and
   the id into `RECEIPT_KEY_ID` in `wrangler.toml`.
2. **Licence keys.** `LICENCE_KEYS` in `wrangler.toml`: the public half of the licence signing key,
   as `{"<key id>": "<public key>"}` (not secret).
3. **GitHub token.** Signed in as the `dragonsoath-dev` machine account: a fine-grained token, owner
   DragonsOath, repository `hearth-premium` only, **Contents** and **Pull requests** read and
   write, nothing else. Protect `main` on that repository so it only changes through reviewed pull
   requests.
4. **Cloudflare.** Create a KV namespace and put its id in `wrangler.toml` (`STORE`). From this
   folder: `npx wrangler deploy`, then `npx wrangler secret put RECEIPT_KEY` and
   `npx wrangler secret put GITHUB_TOKEN` (paste them there only: never into a chat, a file or a
   screenshot).
5. **Hearth.** Ship the release with the receipt public key, and the service address as the
   default (or `DC_PANEL_INTAKE_URL`).

## Replacing the token (Hearth warns 14 days ahead)

1. On GitHub as `dragonsoath-dev`: Settings, Developer settings, Fine-grained tokens, Generate new
   token, with the same scope as above.
2. Here: `npx wrangler secret put GITHUB_TOKEN`, and paste it there only.
3. Delete the old token on GitHub. Hearth picks up the new expiry within a day.

Donations keep arriving and are kept while the token is expired; only their pull requests wait.

## Free tier

Workers' free plan allows 100,000 requests a day and 10 ms of CPU per request; KV's free plan
1,000 writes a day. A donation is a handful of KV writes; the limits above keep well inside both.
