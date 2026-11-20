# How requests work

Hearth runs alongside hundreds of homelab apps, and it's built by a very small team. We love
requests. Here's how we handle them so every one gets a fair shot.

## Every app gets a panel

Any app Hearth finds gets a basic panel: status, health, logs, start and stop, updates, and a link
to its own page. Ember can also reach most apps' own settings for you. Some apps also get a full
panel, built by hand.

## Want a full panel, or a feature on one?

Go to the [Panel requests board](https://github.com/DragonsOath/hearth/discussions/categories/panel-requests).
If someone already asked, add your vote instead of a new post. One request with 40 votes says far
more than 40 separate posts.

Inside Hearth, every basic panel has a **Request it** link, and every full panel has a **Request a
feature** link. Both open a new request already filled in for that app. On Discord, `/request-panel`
takes you there too.

## How we choose what to build

- How many people voted for it
- How many people run the app
- What the app itself allows other apps to do

We look at each panel's requests together, the next time that panel gets work, rather than one at
a time as they come in.

## What the labels mean

- **Planned:** we're going to build it.
- **PR welcome:** a good idea we can't get to soon. Anyone is welcome to build it.
- **Ember can do this:** it already works today. Ask Ember.
- **Not planned:** we've decided against it, and we'll say why.

A repeat of an earlier request is closed as **Duplicate**, with a link to the original, so its
votes count in one place.

## Something broken?

That's a bug, not a request.
[Report it on GitHub Issues](https://github.com/DragonsOath/hearth/issues/new/choose) and it gets
looked at, whatever the app.

## Know an app better than we do?

We don't run every app. If you live with one every day, your review or pull request is the fastest
way to make its panel great. [CONTRIBUTING.md](../CONTRIBUTING.md) says how to start.
