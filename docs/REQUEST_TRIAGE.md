# Request triage (for maintainers)

The public side is [How requests work](HOW_REQUESTS_WORK.md). This page is how we keep the
[Panel requests board](https://github.com/DragonsOath/hearth/discussions/categories/panel-requests)
tidy as it grows. Requests are reviewed a panel at a time, never one by one as they arrive. Votes
inform the owner; they never commit Hearth to building anything.

## How a request moves

Nothing needs answering the day it arrives, except bugs.

1. **Someone asks.** From a panel's Request link, Discord's `/request-panel`, or the board
   directly. The form asks for the app, what they want, why, and whether they tried Ember.
2. **Duplicates merge.** Anyone (the owner, a maintainer, a trusted member) closes a repeat with
   the Duplicate reply below and a link to the original.
3. **Votes collect.** No action is needed while they do.
4. **Panel pass.** When a panel is next worked on, read all of its requests at once, sorted by
   votes, and pick the top few.
5. **Label everything.** Every request for that panel gets exactly one of Planned, PR welcome,
   Ember can do this or Not planned during the pass, including the ones not picked. A request left
   open with no label is the outcome to avoid.
6. **Bugs skip the line.** A broken panel is an issue, not a request, and is triaged on its own
   track.

To find a panel's requests for a pass, search the board for the app's name (requests are titled
`Panel: <app>` or `Feature: <app> panel`), sorted by top votes.

## Labels

The labels live in [`.github/labels.json`](../.github/labels.json); the Labels workflow makes them
on the repository when that file changes. Change the file, never the labels by hand.

| Label | Means | Reply includes |
| --- | --- | --- |
| Planned | The owner will build it | Nothing promised about dates |
| PR welcome | Good idea, not a priority | Where in the code to start, if known |
| Ember can do this | Already possible through Ember (it reaches the app's own API) | The question to ask Ember |
| Not planned | Decided against | One kind sentence on why |
| Duplicate | Already requested (a closing action, not a fifth outcome) | A link to the original |

## Reply snippets

Short, warm, and the same every time, so no one has to write a fresh answer to the hundredth
request. Fill in the braces.

| Case | Reply |
| --- | --- |
| Duplicate | Thanks! This one's already on the board here: {link}. Add your vote there so it counts. |
| Planned | Great idea, and it's planned. No date yet, but it's coming. |
| PR welcome | Love this idea. We can't get to it soon, so it's open for anyone to build. Happy to point the way. |
| Ember can do this | Good news: this works today. Ask Ember "{question}" and she'll handle it. |
| Not planned | Thanks for asking. We've decided not to add this because {reason}. |
| "Why does Plex get more?" | Panels get built by request votes, how many people run the app, and what the app lets other apps do. Here's how it works: {link}. Add your vote for {app} and it moves up. |
| "No support for X, do better" | Fair! X has a basic panel today, and you can vote for a full one here: {link}. If you run X every day, your help would make it great. |
