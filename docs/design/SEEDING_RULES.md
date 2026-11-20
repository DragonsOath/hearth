# Seeding rules (proposal, 2026-11-11)

Status: design only. Nothing is built, and no automatic action runs until the owner approves this design and then each live rule.

The owner's brief: users write their own rules ("TrackerOne, 3 days seeding, then remove"). Nothing is tied to one tracker. The rules live in the existing qBittorrent panel, and they are safe by default.

## What exists already

- **Where each torrent came from** (built 11-11, commit 6c9cc631). The grabbing app's history (Sonarr, Radarr, Lidarr, Readarr, Chaptarr) links a torrent's hash to the indexer that grabbed it. Prowlarr's history covers manual grabs, matched by title. A private tracker's announce address is the last fallback.
- **qBittorrent's own numbers.** `seeding_time` is the time spent seeding while complete, and stopped time does not count. qBittorrent also reports ratio, `completion_on`, and per-torrent share limits. Hearth already reads all of these.
- **qBittorrent's own limits.** qBittorrent can stop or remove a torrent when its limit is hit. The home server runs 5.2.4, and 5.2 can set the action per torrent through the API. Parameter names still need checking on the real install (read only).
- **Sonarr and Radarr already do part of this.** Each indexer has "Seed Ratio" and "Seed Time" settings, which Prowlarr can sync. The app sends these limits to qBittorrent on grab, and "Remove Completed" removes the torrent once it is done seeding. Hearth should show this, not fight it.
- **Pieces to reuse:**
  - The watch engine (`watches/engine.ts`) runs a database-backed check every minute and survives restarts. It keeps history, sends to the bell and notifications, and handles snooze.
  - The approved torrent operations (`app-qbt-pause`, delete) and the approval path for standing permissions.

## Recommended design

A new watch kind, **seeding rule**, evaluated by Hearth. It uses the engine Hearth already has, not qBittorrent scripts.

### Where it lives (owner, 11-11)

A **Rules** button beside **Categories** at the top of the qBittorrent Torrents tab. It opens a list of the rules, each with its own on/off switch, and an **Add another rule** button at the bottom. One rule can cover several indexers: the indexer field is a set of toggles (TrackerOne, TrackerTwo, ...) rather than one pick.

### A rule

| Field | Default | Notes |
|---|---|---|
| Indexers or trackers | at least one | Toggles for each indexer in Prowlarr's list; several can be on in one rule. Trackers seen in qBittorrent are added, plus "Custom tracker address". |
| Days seeding | none | Counted with qBittorrent's `seeding_time`, not time since download. |
| Minimum ratio | off | Optional; the rule waits for both. |
| Action | **Notify me** | Then: Stop seeding (pause), Remove torrent (files kept), Delete torrent and files. |
| Mode | **Preview** | Preview shows what it would do and when. Live acts, but only after approval. |
| On / off | on | Per rule, plus one "Stop all seeding rules" switch. |

### How a torrent matches a rule

1. By indexer, using the grab history described above. This is the reliable path for anything the *arr apps or Prowlarr grabbed.
2. By tracker address, but only when the rule names one. An indexer's name and its announce domain are never treated as the same thing. The owner can pair them, or Hearth suggests a pairing from Prowlarr's indexer URLs for the owner to confirm.
3. **Unknown source: no automatic action, ever.** The torrent card says "Can't tell where this came from", and the owner can attach it to a rule by hand.

**One torrent, several rules.** The strictest requirement wins (most days, highest ratio), together with the least destructive action. The card names the rule that applies and why.

### What the torrent card shows

- The source badge, which exists already.
- The rule that applies.
- Seeding time done and left, for example "1 d 4 h of 3 d".
- The ratio.
- The next step, for example "Removes Thu 3:10 PM", or in Preview, "Would remove…".

### Safety

- **New rules start as Notify, in Preview.** Switching a rule to Live is an approval through the standing-permission path, and it names the rule and its action.
- **Delete torrent and files** has these protections:
  - It shows a separate warning with the plain difference: Remove keeps the files, Delete erases them.
  - It needs its own approval.
  - It refuses a torrent the media app has not imported yet. The grab history must show an import for that hash.
  - It refuses a torrent whose files sit inside a media library folder. That check uses the *arr root folders.
- **The timer is not the tracker.** Hearth counts qBittorrent's seeding time. A tracker can count differently (announces, hit-and-run rules) or have its own rules. The rule screen says so plainly. Hearth never calls a torrent "safe to remove", only "your rule's time is up".
- **Data that's missing or odd means wait.** Hearth waits, and tells the owner, when any of these is true:
  - qBittorrent can't be reached.
  - `seeding_time` is missing.
  - The torrent's tracker reports an error.
  - The torrent went back to downloading.
- **Hearth only changes what a rule acts on.** It never changes other qBittorrent settings: global limits, other torrents' limits, categories.
- **Every action is recorded.** The rule's history and Hearth's activity log both get an entry with the torrent, the rule, the numbers at the time, and the result. Undo is offered where it exists, for example resuming a paused torrent.

### Why Hearth decides instead of qBittorrent's own limit

qBittorrent 5.2's per-torrent action is simple and keeps working while Hearth is down. It can't do the following:

- Check that the media app imported the files.
- Notify the owner.
- Run in preview.
- Explain itself on the card.

So Hearth decides. As an optional extra, offered and never set silently, Hearth could also set qBittorrent's own **stop** limit on matched torrents as a non-destructive backstop.

## Open questions for the owner

1. Should a rule also be able to set the matching Prowlarr indexer's Seed Time, so Sonarr and Radarr follow it? That changes Prowlarr, so it is off unless the owner asks.
2. Notifications: the bell only, or also Discord?
3. Check the qBittorrent 5.2.4 share-limit-action parameters on the home server (read only) before relying on the backstop.

## Build plan (after approval)

1. **Rules and Preview only.** Store the rules, run the matching, show it on the cards, add the activity log. No actions.
2. **Notify and Stop seeding.** These can be undone.
3. **Remove torrent (files kept).**
4. **Delete torrent and files**, with its extra checks.

Each stage gets a preview for the owner before the next one starts.
