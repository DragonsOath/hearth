#!/usr/bin/env bash
# Builds and tests a fresh clone of the committed HEAD, so files that exist
# only in the working tree (untracked, or wrongly ignored) are caught.
set -euo pipefail
repo="$(git rev-parse --show-toplevel)"
dir="$(mktemp -d "${TMPDIR:-/tmp}/dc-clean-XXXXXX")"
trap 'rm -rf "$dir"' EXIT

git clone --quiet "$repo" "$dir/repo"
cd "$dir/repo"
pnpm install --frozen-lockfile --reporter=silent
pnpm typecheck
pnpm test
pnpm build
echo "Clean clone of $(git rev-parse --short HEAD): build and tests pass."
