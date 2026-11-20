# Hearth Premium: entitlements, grants and codes

Status: built and tested locally (branch `premium`, 2026-11-05). Not merged, not released, not
deployed, not owner-verified. Spec: the owner's HEARTH_PREMIUM_ENTITLEMENTS_DC_SPEC (11-05). Earlier
decisions: private/docs/FEATURE_CHECKLIST.md 43.2 (free vs paid boundary) and 45.7.

## Policy

Hearth is free for ordinary homelab use. Three capabilities are premium
(`packages/core/src/premium.ts`, the only place they are named). Hearth Transfer was premium from
2026-11-07 until the owner removed it from Hearth on 2026-11-11, and Curator For You from
2026-11-13 until the owner made it free on 2026-11-14 (free apps already do personal
recommendations). A licence that still names `hearth_transfer` or `curator_for_you` is accepted
and that entry ignored (`RETIRED_PREMIUM_FEATURES`).

| Feature id | Name | What it is |
|---|---|---|
| `hearth_interconnectivity` | Hearth Connected | Linking two or more Hearth installations and working on one through another |
| `ember_show_and_tell` | Ember Show & Tell | Ember opening and pointing at what she works on, on screen (Show me, Teach me) |
| `panel_builder` | Panel Builder | Ember building or refining a custom panel for an app, and sharing it (Donate) (added 2026-11-14) |

`premium_all` grants every feature. A licence issued as all of Premium before Panel Builder existed
names the first two; naming both counts as all of Premium, so it covers Panel Builder too
(`licenceCovers`). Anything custom is Panel Builder (the owner, 11-14): building, loading a shared
panel file, installing, sharing, and skins. Without it a custom panel made earlier is kept and the
basic panel shows. Panel Builder has no free route: the earlier "contribute your panel to unlock
it" path was removed on 2026-11-14 (it never ran on a real install: no submission service key
had shipped). No other paid feature exists; the catalog refuses unknown ids.

## Gating matrix

| Action | Free | Premium | Enforced at |
|---|---|---|---|
| Every panel, widget, dashboard, Docker, media, Home Assistant, storage, NAS | yes | | |
| Ember chat, diagnosis, recommendations, approved actions, verification, memory | yes | | |
| Ember's Browser (Ember doing work on sites without an API) | yes | | |
| Apps, Docker hosts, NAS, Home Assistant on other machines | yes | | |
| Phones, tablets, home tablets signed in to one Hearth (`/api/devices/codes`) | yes | | |
| Seeing linked PCs, renaming, unlinking, uninstalling one (`/api/pcs`, `DELETE`) | yes | | |
| Making a join link for another PC (`POST /api/pcs/codes`) | | Connected | package `connected.ts` |
| A PC linking with the Hearth API key (`POST /api/pcs/link`) | | Connected | package `connected.ts` |
| A PC joining with a link (`POST /api/pcs/join`) | | Connected | package `connected.ts` |
| Working on a linked PC (`/api/on/:pc/*`, its sockets, `/on/:pc/engine-preview/*`) | | Connected | package `connected.ts` forward, upgrade |
| Passing the Ollama setup to linked PCs | | Connected | package `connected.ts` shareOllama |
| Switching Show & Tell on (`PUT /api/show/settings` mode show or teach) | | Show & Tell | package `show.ts` |
| Ember's `show` and `tidy_screen` tools | | Show & Tell | package `show.ts` (absent without it; Ember explains in words) |
| All of Curator: Discover, For You, Seen it, Both | yes | | |
| Hearth's own panel for every app; basic panels; Request it; Back to basic | yes | | |
| Ember drafting or refining a custom panel, loading a panel file (`panel_builder` draft) | | Panel Builder | `panels/service.ts` draft |
| Installing or restoring a custom panel | | Panel Builder | `panels/service.ts` install, restore |
| Sharing a custom panel with everyone (Donate, `POST .../custom-panel/submit`) | | Panel Builder | `panels/service.ts` submit; the donation service checks the licence too |
| Using a panel skin (Panel style, `POST /api/addons/hearth-premium/skins/use`) | | Panel Builder | package `skins.ts` |
| Hearth's own nightly backup, undo, restoring Hearth itself | yes | | |
| Ember helping by hand to move a container or copy a config | yes | | |

A refusal is HTTP 402 `PremiumRequired` with a plain message ("... is part of Hearth Connected,
which this Hearth doesn't have. Everything you already set up is kept."). 402, not 403, so the page
never mistakes it for "confirm it's you". The page shows the same state (Link another Hearth says so first;
Show & Tell shows a locked note), but the server is what refuses.

## The Premium package (11-14)

The Premium features' code is not in this repository. It is an add-on, `hearth-premium`, from
the private DragonsOath/hearth-premium repository, installed into `<data>/addons`
(`apps/server/src/addons`). Without it a Hearth is complete and free: the routes above that say
"package" do not exist (404), their screens show the feature's Premium card (`PremiumCard`), and
Ember has no tools or instructions for them and says so in one line. With it, each feature still
needs the licence: the package checks it through the host (`host.require`), so a package alone
unlocks nothing. The core keeps the shared pieces the package uses: the PC store and its live
links (`ConnectedKit`), Show & Tell's hooks into Ember's turn (`show/hooks.ts`), the panel store
and its Premium gate, and the screen modules it imports (`lib/addons.ts`, `ADDON_MODULES`). The
package's screens fill named slots (`app.presenter`, `settings.showAndTell`, `devices.addPc`,
`panel.improve`, `panel.body`) and bring their own style sheet for classes the core doesn't have.
The core's tests run without it and, with `DC_TEST_ADDONS_DIR` / `DC_E2E_ADDONS_DIR`, with it.

## Donations and skins (11-14, built locally, nothing deployed)

- **Donate your panel** (Premium): the donor sees the exact file, accepts the contributor agreement
  (the CLA box) and may give a name and a GitHub user name for credit. The screen says, word for
  word: "Donating doesn't mean your panel will be added. The owner reviews every panel. If it's
  added, you get credit."
- **The donation service** (`services/panel-intake`, one Cloudflare Worker on the free tier): it
  checks the Hearth's licence (signed by a trusted key, in force, not revoked, includes Panel
  Builder), rate-limits per licence, per address and in all, rebuilds and checks the panel, and
  answers with a signed receipt. Its scheduled job opens a pull request on the private
  `DragonsOath/hearth-premium` repository as the `dragonsoath-dev` machine account (a fine-grained
  token: Contents and Pull requests on that repository only), adding `donations/<app>/<name>.json`
  with the credit; a donor's GitHub account is the commit's co-author. Labels: `donation`, `skin`.
- **The owner merges**: as it is (`skin`) it ships in the next Premium package as a skin; with
  `core-default` it goes into the core for everyone with the donor credited on the public commit
  (by hand for now: `donations/README.md` in the Premium repository).
- **Skins**: the package build copies `donations/` into its `skins/`. A skin is offered for the
  matching app (same image, same app, or a hand-added app whose name says it) as **Panel style:
  Hearth's own / Skin by @name**, installed like any custom panel, and shows **Made by @name**.
  Settings, About lists the credits (slot `about.credits`); the website's credits page waits for
  the owner.
- **Token expiry**: GitHub reports the token's expiry with every answer; the service keeps it
  (`GET /v1/status`, checked at least twice a day). On the owner's issuing Hearth, "Needs you"
  warns 14 days before it expires, with the steps to replace it (`findings/analyzers/donations.ts`).
- **Waiting for the owner**: the `dragonsoath-dev` token, creating the private repository, the
  Worker deploy (KV namespace, receipt key, `LICENCE_KEYS` once the signing key exists).

## When a licence ends or is taken back

New premium actions stop. Nothing else changes: links stay recorded and their live connection
stays up (only requests through them are refused), Show & Tell's saved choice stays (it reads as
off), and every Hearth keeps working on its own. Nothing is deleted. Unlinking stays free.

## Entitlement model

- **Bound to the installation** (`app_meta.install_id`, made at first start). It is in the
  database, so a restore from a backup keeps it; a fresh reinstall gets a new id and needs its
  licence reissued (the owner revokes the old grant and grants the new id). No account or cloud
  sign-in is needed for Hearth itself.
- **Licence**: `HEARTHL1.<payload>.<signature>`, Ed25519 over the payload: licence id,
  installation id, features, kind (complimentary, paid, trial), start, optional end, issued, an
  optional label for the recipient, and the signing key's id. Checked offline against the public
  keys Hearth trusts (`premium/license.ts` `PRODUCTION_KEYS`, empty until the owner's key exists).
  Changing any letter breaks the signature.
- **States** per feature: free, active, scheduled, expired, revoked, pending. Pending: the clock is
  more than 36 hours behind the latest time this Hearth has seen, so a dated licence can't be
  trusted until the clock is right. Lifetime licences don't depend on the clock.
- **Revocation**: the issuer's list. On the issuing Hearth it counts at once. Other installations
  learn of it when the licence service exists (see below); until then a revoked licence keeps
  working offline until its end date, which is why codes and grants for others should be dated.
- **Storage**: settings key `premium` (licence keys, known revocations, clock high-water mark).
  Licence keys are not secrets (they are bound to one installation) but are never logged.

## Who can issue

Only a Hearth holding the owner's signing key, and only when that key is one Hearth's releases
trust. The private key is a protected Secure Vault entry ("Hearth licence signing key"): every
signature needs the owner signed in with the vault unlocked, and every issuer action needs a fresh
"it's you". A local administrator on any other installation can make a key, but no release trusts
it, so nothing it signs is accepted. The key never appears in the code, the web page, logs or an
AI's context.

Browser tests (`DC_FAKE_APPS=1`, never set in a real install) trust the test server's own key;
unit tests pass their own test key (`buildApp({ premiumKeys })`).

## The owner's grant workflow (Settings, Premium, Issue Premium)

The section shows on the issuing Hearth (or with `?issuer` in the address, to make the key).

1. **Make the signing key** (once). Its public half is shown; it becomes trusted when added to
   `PRODUCTION_KEYS` in a release. **Use a key you saved** puts the owner's offline copy back
   (`POST /api/premium/issuer/restore`, owner confirmed recently): on a Hearth with no key, or one
   whose vault lost it (the view says so, `keyMissing`), where only that same key id is taken. It
   goes into the vault as protected, the same as a made key; nothing needs a release.
2. **Grant Premium**: who it is for, audience (me, family, friend, creator, tester, partner,
   other), which features, how many days (or for good), their installation ID (from their
   Settings, Premium), a private note. For this Hearth it applies at once; for someone else it
   returns a licence key, shown once, to send them. $0, no card, never renews.
3. **Make a promo code**: features, campaign, how many can use it, days each grant lasts, a
   redeem-by date. The code (`HRTH-XXXXX-XXXXX-XXXXX-XXXXX`, 100 random bits, Crockford letters)
   is shown once; only a hash is kept and lists show its first letters.
4. **Revoke** a grant (with a confirmation) or **Reinstate** it. **Switch a code off** to stop new
   redemptions; grants already made from it stay until revoked. The two are separate on purpose.

Redeeming: once per installation, never past the code's uses (claimed inside one serialized
transaction; ten simultaneous redemptions of a three-use code give exactly three), five tries a
minute and twenty an hour per installation. Codes and licence keys never go into the audit log
(only a code's first letters).

## Selling Premium: GitHub Sponsors (decided 2026-11-13, not built yet)

Premium starts through GitHub Sponsors on the DragonsOath organisation, so sponsors see Dragon's
Oath and never a person's name. No store or merchant of record for now; an LLC, a proper store and
a reviewed CLA come later, once Hearth earns enough to justify them.

Tiers (Flint and the owner, 2026-11-13):

| Tier | Price | Gives |
|---|---|---|
| Supporter | $5 a month | Premium while the sponsorship is active, a Supporter role in Discord |
| Launch Founder | $60 once, for the first 7 months after launch | Founder (below). Labelled "Launch price, $99 after [date]" (launch + 7 months) |
| Founder | $99 once, the regular price, never raised | Premium for life (every Premium feature, present and future), a Founder role in Discord |

When the launch price ends: retire the $60 tier and open the $99 one (GitHub keeps existing
sponsors on a retired tier; Launch Founders are Founders like any other). GitHub Sponsors has no
discount codes, so percentage-off codes wait for a proper store later.

### The promise to Founders

Word for word (`FOUNDER_PROMISE` in `packages/core/src/premium.ts`), on the Sponsors page
(`docs/SPONSORS.md`), the claim page, the manual's Premium section and the Hearth Pledge:

1. **Premium for life.** Whatever a paying monthly Premium member gets, now or in the future, a
   Founder gets too, at no extra charge, even if Premium later becomes monthly billing only.
2. **The regular Founder price, $99, is never raised.** Founder may be retired at any time, with
   at least 30 days' public notice.
3. **Founders stay Founders.** Everyone who became a Founder before it closes keeps it, forever.

In practice: a Founder's grant has no end date and covers every Premium feature, present and
future (`premium_all`, and `licenceCovers` for licences named before a feature existed). Retiring
Founder means only that the tier stops taking new sponsors; nothing issued is ever revoked for it.

How a sponsor gets a key (built on the licence service, `services/hearth-licence`, branch
`licence-service`, not deployed):

1. The tier's welcome message (GitHub shows it after sponsoring) links to **Claim your Premium
   key**, a page the licence service serves at `licence.dragonsoath.com`.
2. The sponsor signs in with GitHub (an OAuth app owned by the maintainer account, read-only
   profile scope). The service asks GitHub whether that account sponsors DragonsOath, on which tier,
   and whether it is active; the GitHub token is used for that one question and never kept.
3. The page shows a one-use code (`HRTH-...`) that redeems on any Hearth: Settings, Premium,
   Redeem a code. Founder: a grant with no end date. Supporter: a grant for 35 days that the
   sponsor's Hearth renews from the licence service while the sponsorship stays active (GitHub's
   sponsorship webhook tells the service when one is cancelled; then it is not renewed and Premium
   ends with the paid period). A GitHub account claims a key for up to 3 installations.
4. The service keeps only the GitHub login, the tier and the licence ids. Payout and tax details
   stay with GitHub; they are never public.
5. Ending Premium never touches free features or the owner's data (see "When a licence ends").

### Gift codes (owner only)

A page on the licence service, `licence.dragonsoath.com/gifts`, signed in with GitHub as the
DragonsOath maintainer account (the only account it lets in), to give Premium without payment:

- **Make a gift code**: what it gives (**Founder**, or **Premium for N months**), a private note
  (who it is for; only on this page), and an optional redeem-by date. The code is one-use and
  shown once.
- **The list**: every gift code with its note, what it gives, made and redeem-by dates, and its
  status: waiting, redeemed (when, on which installation ID), expired or revoked. **Revoke** takes
  back a code, or the Premium it gave once redeemed (the revocation list every Hearth reads).
- **Logged**: making, revoking and redeeming each write a line (who, when, which code by its first
  letters) in the service's log; full codes are never logged.
- **When a gifted code is redeemed**, Hearth shows: "Premium was gifted to you. If you share or
  review Hearth, please mention you received Premium free." The same line is on the page next to
  the new code, ready to send with it.
- **Ember can never create or see codes**: they live only in the licence service, which Ember has
  no way to reach, and Hearth refuses Ember every Premium route except the plain status
  (`/api/premium/...` is on hearth-api.ts's NEVER list, 2026-11-13).

Still to do before it is switched on: Sponsors enabled on DragonsOath with its payout and tax form
(the maintainer account), the licence service deployed at `licence.dragonsoath.com` (the same
Cloudflare change as the bots), its public key in `PRODUCTION_KEYS`, the claim page, renewal and
webhook built, and the owner's installations holding lifetime licences before `PREMIUM_ENFORCED`.

Already in the licence format: `kind: "paid" | "trial"`. **Buy Premium** in Settings becomes
**Sponsor on GitHub** (the DragonsOath Sponsors page) once the tiers exist.

## Launch (the owner's decisions, 2026-11-07)

The owner approved the recommendations: the signing key on the home server's Hearth with an offline copy,
the licence service on Cloudflare next to the bot relay, licences bound to the installation,
Ember's Browser free, and the owner's own lifetime grants before the locks turn on.

Premium launches in three releases, so no installation of the owner's is ever locked:

1. **Premium ships open.** `PREMIUM_ENFORCED` is false and no key is trusted, so every premium
   feature is open (Settings, Premium says so). The owner makes the signing key on the home server (Settings,
   Premium, open with `?issuer`); its public half is shown.
2. **The key is trusted, still open.** Its public half goes into `PRODUCTION_KEYS`. The home server can now
   issue: the owner grants the home server for good (applies at once) and makes a licence key for each of their
   other installations, pasted into their Settings, Premium.
3. **The locks turn on.** `PREMIUM_ENFORCED` becomes true.

Tests always enforce (`DC_FAKE_APPS`, or `premiumKeys` passed), so the locks stay tested.

## Licence service

`services/hearth-licence`, a Cloudflare Worker with a D1 database (setup: its README).

- **Redeem** (`POST /v1/redeem`, code and installation id): checks the code by its hash, claims a
  use in one statement (never past the limit), once per installation, five tries a minute and
  twenty an hour, and returns a licence signed with the service's own key. Hearth installs it like
  any licence key.
- **Taken back** (`GET /v1/revoked`): every Hearth checks a minute after starting and every six
  hours; only licences installed there count, and a licence given back counts again.
- **The owner's changes** (`POST /v1/owner`), signed with the owner's licence key over the exact
  body, fresh (five minutes) and once (nonce): add a code, switch one on or off, revoke or
  reinstate a licence, take back every licence from a code. The owner's Hearth sends these as
  part of the same actions in Settings, Premium: a code is made only if the service accepted it.
- **Uses** (`GET /v1/codes/:id`): the owner's list shows the service's count.
- Hearth's address for it is `DEFAULT_LICENCE_SERVICE` (`DC_LICENCE_SERVICE` overrides, `off` for
  none). Tests never reach it.

## Remaining work (needs the owner)

1. **The signing key**: make it on the issuing Hearth (recommended: the home server's Hearth), keep an
   offline copy, add its public half to `PRODUCTION_KEYS`. A new credential: the owner's approval.
2. **The licence service** for redeeming codes and revocation from other installations: a public
   endpoint (recommended: next to the Hearth bot relay on Cloudflare). Redemption there needs to
   sign without the owner present, so the service needs its own signing key (an automation-tier or
   separate key the releases also trust). Networking and a new credential: the owner's approval. Until
   then: direct grants as licence keys work for anyone; codes redeem only on the issuing Hearth.
3. **The owner's own installations** need their lifetime grant before a release with these gates goes
   out, or the owner's own links and Show & Tell stop.
4. Payment provider, checkout, webhooks, refunds, chargebacks: not built.

## Rollback

Migration 0067 only adds three tables (`premium_grants`, `premium_codes`, `premium_redemptions`)
on the issuer; an older Hearth ignores them. Back up the database before updating, as for any
release. Rolling back the code removes the gates; the tables and the `premium` setting stay,
unused.
