# Hearth licence service

Hearth's licence service (docs/design/PREMIUM.md "Licence service"), a Cloudflare Worker at
`licence.dragonsoath.com`, with a D1 database. It:

- **redeems codes** for any Hearth (`POST /v1/redeem`), signing a licence with its own key, which
  Hearth's releases trust (`PRODUCTION_KEYS`);
- **lists licences taken back** (`GET /v1/revoked`), which a Hearth checks only when someone enters a code there (never on a schedule: the Pledge);
- runs **the owner's code page** at `hearth.dragonsoath.com/codes` (a route on the main site;
  only `/codes` comes here), the only place codes are made.

## The code page (`hearth.dragonsoath.com/codes`)

Only the owner's GitHub account gets in: GitHub sign-in, then its numeric id must be
`OWNER_GITHUB_ID`, and every `/codes/api` request is checked on the server against a signed
cookie. Anyone else sees a sign-in button that leads nowhere. The sponsor claim page (below) is
the only public part.

- **Campaigns**: a name ("Around the Fire launch"), what it gives (Founder for good, or 1 to 12
  months), and an optional number of codes.
- **Give a code**: pick a campaign, type who it's for (their Discord name), Make code. The code and
  a message to paste are shown once; only the code's hash and first letters are kept.
- **Codes given**: who has which, waiting, redeemed, switched off or taken back. Switch off a code
  not used yet; take Premium back from one that was (that Hearth learns the next time a code is entered there), or give
  it back.
- **Your own Hearths**: a licence key for one of the owner's installations, for good, from its
  installation ID (Settings, Premium).
- **Founder offer** (launch day): Ember Bot puts posts with a screenshot in #around-the-fire in
  line (one per Discord account, accounts at least 7 days old), answers each with its place, and
  keeps "Founder spots claimed: 7 of 25" in the pinned post. Each waits here for Approve (Ember Bot
  DMs a one-use Founder code; never in a channel) or Reject (pick or type a reason; Ember sends
  it). No silent refusals: anyone turned away (account too new, already in line, a Founder already,
  the spots gone, the offer ended, or asking without a screenshot) gets a DM saying why, or a reply
  in their post asking them to open DMs when theirs are closed. For 7 days after the offer ends
  she still answers new entries, then goes quiet. Run it on #founder-test first (`TEST_FORUM_ID`). The two Workers reach each other only through
  service bindings (`EMBER` here, `LICENCE` in ember-bot), never over the internet. Ember Bot needs
  Message Content Intent on (Discord Developer Portal, Ember Bot, Bot) to see attachments.

## The sponsor claim page (`hearth.dragonsoath.com/codes/claim`)

The link to give sponsors. They sign in with GitHub (scope `read:user`, the only way GitHub shows
a person's own sponsorships); the service asks GitHub, as them, which sponsorships they have to
DragonsOath, uses that answer once and keeps nothing else, and shows a one-use code on the page:

- **Founder**: a one-time sponsorship of at least `FOUNDER_MIN_USD` (60 at launch; set 99 when the
  launch price ends). Once per GitHub account; claiming again shows the first code's letters.
- **Supporter**: an active monthly sponsorship ($5 or more). One month of Premium, and the next
  one 28 days after the last claim, for as long as they sponsor.

The codes land in two campaigns on the owner's page, "GitHub Sponsors: Founder" and "GitHub
Sponsors: Supporter", each noted with the GitHub account. Switching a campaign off pauses its
claims. It shares the owner page's GitHub sign-in app and callback.

## Send with Ember, and Premium Ember

After Make code, the page offers **Send with Ember**: the owner types a Discord name (username,
display name, server nickname, or user id) and Ember Bot DMs that person the code, how to redeem
it, and Premium Ember, the picture only code holders ever see. Founder approvals send the same
picture. Nothing is sent when the name matches nobody, matches more than one person, or their DMs
are closed: the page says which, and Copy message still works.

Premium Ember is kept secret: she is never in this repository, on the website, in the README or
in videos. She lives in this service's database (`private_assets`, name `premium-ember`) and is
shown only in those DMs and on the claim page once a code is shown. To upload or replace her, the
owner runs, from a folder holding the SQL file made from the picture (not committed anywhere):

```sh
npx wrangler d1 execute hearth-licence --remote -y --file premium-ember.sql
```

Without her, everything still works; the DMs and the claim page just have no picture.

## Set up (owner, once)

1. `npx wrangler login` if this computer isn't signed in to Cloudflare.
2. **The GitHub sign-in.** On GitHub, signed in as the owner: Settings, Developer settings, OAuth
   Apps, New OAuth App. Name `Hearth codes`, homepage `https://hearth.dragonsoath.com`, callback
   `https://hearth.dragonsoath.com/codes/callback`. Copy its Client ID into `GITHUB_CLIENT_ID` in
   `wrangler.toml`. Generate a client secret and put it straight into Cloudflare (it is never
   saved in a file): `npx wrangler secret put GITHUB_CLIENT_SECRET`.
3. From this folder: `node setup.mjs`. It makes or updates the tables, deploys, and makes the
   service's signing key and its sign-in cookie key (straight into Cloudflare secrets, never
   shown). Safe to run again.

## Keys

If the service's signing key is ever lost, make a new one (delete the secret, run
`node setup.mjs`), add its public half to `PRODUCTION_KEYS`, and release. Licences it already
signed stay valid while the old public key stays trusted.

## Rollback

`npx wrangler rollback` to the previous version. The added tables and columns are ignored by an
older version.

## Premium package delivery (11-22)

`POST /v1/package` hands the Premium package to a Hearth holding a licence in force (see
`docs/design/PREMIUM.md`, "Premium package delivery"). It reads the private
`DragonsOath/hearth-premium` releases with a fine-grained token: Resource owner DragonsOath,
repository hearth-premium only, permission Contents read-only, nothing else. Set it with
`npx wrangler secret put PACKAGE_TOKEN` (never in files). Without it the route answers 503 and
Hearth tries again at its next start. This service can't sign packages: Hearth only installs
ones signed with the package key, which never leaves the owner's workstation.
