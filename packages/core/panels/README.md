# Panels as files

Custom panels made with Ember Panel Builder are checked descriptions, never code: Hearth draws them
with its own blocks (`packages/core/src/panel-spec.ts`).

- `community/<app>/<name>.json`: donated panels the owner chose to put in Hearth for everyone
  (`core-default`), each crediting its donor on the commit. Donations themselves arrive as pull
  requests on the private Premium repository from the panel donation service
  (`services/panel-intake`); those merged as they are become Premium skins there.

A pull request from an `ember-panel/` branch may only add files under `packages/core/panels/`
(checked by `.github/workflows/ember-panels.yml`). Anything else a panel needs is a separate
request.
