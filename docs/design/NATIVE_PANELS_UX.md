# Native app panels: full capability without full complexity

A standing design rule from the owner (2026-11-01) for every native app panel (Radarr, Sonarr,
and every integration that follows) and for new integrations in general.

People should be able to do virtually anything the original app allows without leaving Hearth.
That does not mean every feature, setting and advanced control is on screen all the time. The goal
is not the fewest buttons or the tidiest menus: it is the least friction between what someone wants
to do and getting it done. Hearth should make powerful apps easier to use without making them less
capable.

## The rules

1. **Everyday first.** Common tasks, useful information and anything that needs attention are
   immediately in reach: on the Overview, at the top of a tab, on the item's own page.
2. **Advanced stays discoverable.** Settings people rarely change live in a sensible place, one
   obvious step away, never several layers down.
3. **Don't compartmentalize for its own sake.** Another tab, menu or category is not automatically
   better. Keep related controls together when that serves the task (a series page holds its
   settings, seasons and episodes; a quality profile holds its qualities and format scores).
4. **Familiar to the app's users.** Someone who knows Radarr or Sonarr should find things where they
   expect them (Library, Activity, Wanted, Settings, System), even though Hearth has its own look.
5. **Use context.** When Hearth knows about a problem, link straight to the control that fixes it
   (a health warning to its setting, a stuck download to its fix, a missing episode to its series),
   instead of making people navigate there.
6. **Never trade capability for cleanliness.** A clean screen must not cost a useful function or
   push someone back to the original app. If something has no place yet, it gets one; the original
   app is a documented fallback only where the app's API cannot do it.
7. **Ember complements, never compensates.** Everything must be findable and usable by hand. Ember
   is the faster, conversational way to the same controls (the same plan steps), not a workaround
   for navigation that is hard to use.

## Checking a new screen

- What are the three things people do here most? Are they visible without scrolling or a click?
- Is every rarely used setting reachable in one obvious step from where someone would look?
- Could two tabs or sections be one without getting crowded? Would splitting one help a real task?
- Would a Radarr/Sonarr user look for this here?
- Where Hearth shows a problem, is there a direct link to its fix?
- Is anything the app can do through its API missing, and if so, is it tracked?
- Could someone do this without Ember?

How panels are built (tabs, sizes, targets, the capability registry): `APP_PANELS.md` and the
native panels architecture plan.
