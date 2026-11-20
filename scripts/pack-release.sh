#!/usr/bin/env bash
# Builds a Hearth release archive: the built server and web app, their runtime packages, and the
# installer, so a Linux machine with Node.js 24 installs it without building anything. Hearth has no
# native modules (the database is Node's built-in node:sqlite), so one archive serves any Linux.
#   scripts/pack-release.sh 0.1.0    writes hearth-0.1.0-linux.tar.gz and its .sha256 here
set -euo pipefail
version="${1:?usage: scripts/pack-release.sh <version, like 0.1.0>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
commit="$(git rev-parse --short HEAD)"
name="hearth-$version-linux"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
stage="$work/$name"

pnpm build
mkdir -p "$stage"
# What running and installing need, from the commit itself (no tests, no development tooling).
git archive HEAD package.json pnpm-lock.yaml pnpm-workspace.yaml README.md AI_README.md LICENSE \
  .env.example deploy docs packages integrations apps/server/package.json apps/server/drizzle \
  apps/server/voice-pack \
  apps/web/package.json |
  tar -x -C "$stage"
cp -r apps/server/dist "$stage/apps/server/dist"
# The elevated executor, installed root-owned only when the owner sets it up (install-elevation.sh).
cp -r apps/server/dist-elevated "$stage/apps/server/dist-elevated"
cp -r apps/web/dist "$stage/apps/web/dist"
# Runtime packages only, exactly as locked.
(cd "$stage" && CI=true pnpm install --prod --frozen-lockfile --ignore-scripts >/dev/null)
printf 'version=%s\ncommit=%s\nbuilt=%s\n' "$version" "$commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$stage/RELEASE"

tar -C "$work" -czf "$root/$name.tar.gz" "$name"
(cd "$root" && sha256sum "$name.tar.gz" > "$name.tar.gz.sha256")
echo "Wrote $name.tar.gz ($(du -h "$root/$name.tar.gz" | cut -f1)), commit $commit"
