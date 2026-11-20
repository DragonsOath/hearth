#!/usr/bin/env bash
# Backs up this repository's complete history to places you own. Nothing here is
# specific to one installation: the destinations come from your own setup.
#
#   1. Pushes every branch and tag to the git remote named "backup" (for example a
#      bare repository on another of your machines, created with `git init --bare`
#      and receive.denyNonFastForwards / receive.denyDeletes set so history there
#      can only grow). Skipped if there is no such remote.
#   2. Writes a single-file bundle (full history) to $DC_SOURCE_BUNDLE_DIR, checks it
#      with `git bundle verify`, and keeps the newest $DC_SOURCE_BUNDLE_KEEP (default 10).
#      Skipped if the variable is unset.
#
# Usage (from anywhere inside the repository):
#   scripts/backup-source.sh            back up now (for example from a post-commit hook)
#   scripts/backup-source.sh --check    daily reconciliation: every branch and tag matches
#                                       the remote (a missed push is pushed), the remote
#                                       passes `git fsck`, and the newest bundle verifies
#                                       and holds the current commit (else a new one is made)
#   --log                               also append the result to $DC_SOURCE_BUNDLE_DIR/backup.log
#   --bundle-dir=PATH                   instead of $DC_SOURCE_BUNDLE_DIR (handy for schedulers)
# Exit status 0 = everything backed up and checked; 1 = a problem (see the output).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

check=0
log=0
for arg in "$@"; do
  case "$arg" in
    --check) check=1 ;;
    --log) log=1 ;;
    --bundle-dir=*) DC_SOURCE_BUNDLE_DIR="${arg#--bundle-dir=}" ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

problems=()
notes=()
say() { notes+=("$*"); }
fail() { problems+=("$*"); }

bundle_dir="${DC_SOURCE_BUNDLE_DIR:-}"
head=$(git rev-parse HEAD)
branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo detached)

# 1. The remote.
if git remote get-url backup >/dev/null 2>&1; then
  # Branches go under v2/ on the mirror: the history was restarted for GitHub (2026-10-13) and
  # the mirror never rewrites or deletes, so the original history stays there as main.
  if git push --quiet backup 'refs/heads/*:refs/heads/v2/*' 2>/tmp/backup-source-push.$$ && git push --quiet backup --tags 2>>/tmp/backup-source-push.$$; then
    # Every local branch and tag must now be on the remote at the same commit.
    remote_refs=$(git ls-remote backup 'refs/heads/*' 'refs/tags/*' 2>/dev/null)
    missing=0
    while read -r sha ref; do
      rref=$ref
      case $ref in refs/heads/*) rref="refs/heads/v2/${ref#refs/heads/}" ;; esac
      grep -q "^$sha	$rref\$" <<<"$remote_refs" || { missing=$((missing + 1)); fail "remote 'backup' does not hold $rref at ${sha:0:7}"; }
    done < <(git for-each-ref --format='%(objectname) %(refname)' refs/heads refs/tags)
    [ "$missing" = 0 ] && say "remote 'backup' holds every branch and tag ($branch at ${head:0:7})"
  else
    fail "push to remote 'backup' failed: $(tr '\n' ' ' </tmp/backup-source-push.$$ | cut -c1-200)"
  fi
  rm -f /tmp/backup-source-push.$$

  if [ "$check" = 1 ]; then
    # Integrity of the remote copy itself (ssh://user@host/path or a local path).
    url=$(git remote get-url backup)
    if [[ "$url" =~ ^ssh://([^/]+)(/.*)$ ]]; then
      out=$(ssh -o BatchMode=yes "${BASH_REMATCH[1]}" "git -C '${BASH_REMATCH[2]}' fsck --no-dangling 2>&1" 2>&1) || true
    else
      out=$(git -C "$url" fsck --no-dangling 2>&1) || true
    fi
    if grep -qiE "error|fatal|missing|broken|corrupt" <<<"$out"; then
      fail "remote fsck reported: $(head -c 200 <<<"$out" | tr '\n' ' ')"
    else
      say "remote passes git fsck"
    fi
  fi
else
  say "no git remote named 'backup' (push skipped)"
fi

# 2. The bundle.
if [ -n "$bundle_dir" ]; then
  mkdir -p "$bundle_dir"
  newest=$(ls -1 "$bundle_dir"/dragon-control-*.bundle 2>/dev/null | sort | tail -1)
  need=1
  if [ "$check" = 1 ] && [ -n "$newest" ]; then
    name=$(basename "$newest")
    if ! (cd "$bundle_dir" && sha256sum --quiet -c "$name.sha256" </dev/null >/dev/null 2>&1); then
      fail "newest bundle $name does not match its .sha256"
    elif ! git bundle verify --quiet "$newest" >/dev/null 2>&1; then
      fail "newest bundle $name does not verify"
    elif git bundle list-heads "$newest" | grep -q "^$head "; then
      need=0
      say "newest bundle $name verifies and holds ${head:0:7}"
    fi
  fi
  if [ "$need" = 1 ]; then
    name="dragon-control-$(date +%Y%m%d-%H%M%S).bundle"
    tmp="$bundle_dir/.$name.tmp"
    if git bundle create --quiet "$tmp" --all && git bundle verify --quiet "$tmp" >/dev/null 2>&1; then
      mv "$tmp" "$bundle_dir/$name"
      if (cd "$bundle_dir" && sha256sum "$name" </dev/null >".$name.sha256.tmp" && [ -s ".$name.sha256.tmp" ] &&
        mv ".$name.sha256.tmp" "$name.sha256"); then
        say "bundle $name written and verified"
      else
        rm -f "$bundle_dir/.$name.sha256.tmp"
        fail "bundle $name written but its checksum file could not be made"
      fi
      keep=${DC_SOURCE_BUNDLE_KEEP:-10}
      # Oldest first; only this script's own bundles are ever removed.
      ls -1 "$bundle_dir"/dragon-control-*.bundle 2>/dev/null | sort | head -n -"$keep" |
        while read -r old; do rm -f "$old" "$old.sha256"; done
    else
      rm -f "$tmp"
      fail "could not write a verified bundle in $bundle_dir"
    fi
  fi
fi

if [ ${#notes[@]} = 0 ] && [ ${#problems[@]} = 0 ]; then
  fail "nothing was backed up: add a 'backup' remote or set DC_SOURCE_BUNDLE_DIR"
fi
[ -n "$(git status --porcelain)" ] && say "uncommitted changes are not part of any backup"

mode=$([ "$check" = 1 ] && echo check || echo backup)
if [ ${#problems[@]} = 0 ]; then
  line="$(date '+%Y-%m-%d %H:%M:%S')  OK ($mode): $(IFS=';'; echo "${notes[*]}" | sed 's/;/; /g')."
  status=0
else
  line="$(date '+%Y-%m-%d %H:%M:%S')  PROBLEM ($mode): $(IFS=';'; echo "${problems[*]}" | sed 's/;/; /g')."
  status=1
fi
echo "$line"
if [ "$log" = 1 ] && [ -n "$bundle_dir" ]; then echo "$line" >>"$bundle_dir/backup.log"; fi
exit "$status"
