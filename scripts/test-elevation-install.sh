#!/usr/bin/env bash
# CI only (a throwaway Linux machine, as root): installs the elevated executor for a stand-in
# Hearth service, then proves the real mechanism end to end: systemd socket activation, the
# kernel-enforced scope, the socket's permissions, a signed single-use write the service account
# could not make itself, replay refusal, revert, the chained log, --verify, and --uninstall.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
user_node="$(command -v node)"
# The executor runs as root, so it needs a Node.js only root can change: a root-owned copy here.
install -d -o root -g root -m 0755 /usr/lib/hearth-ci-node
install -o root -g root -m 0755 "$user_node" /usr/lib/hearth-ci-node/node
node_bin=/usr/lib/hearth-ci-node/node
svc=hearth-ci
user=hearth-ci-svc
base=/srv/hearth-ci
file="$base/compose/app/compose.yml"
pass() { echo "ok    $*"; }
fail() {
  echo "FAIL  $*"
  echo "== the executor's own messages"
  journalctl --no-pager -n 80 -u 'hearth-elevated@*' -u hearth-elevated.socket || true
  exit 1
}

id "$user" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$user"
mkdir -p "$base/compose/app" "$base/backups"
printf 'services:\n  app:\n    image: nginx:1.27\n' >"$file"
chown -R root:root "$base"
chmod 0644 "$file"
# The service account must be able to reach the repository (it runs the client from it).
d="$repo"
while [[ "$d" != / ]]; do chmod o+x "$d"; d="$(dirname "$d")"; done
chmod -R o+rX "$repo/scripts" "$repo/apps/server/src/elevated"

unit_with() {
  cat >/etc/systemd/system/$svc.service <<UNIT
[Service]
User=$user
WorkingDirectory=$repo
Environment="DC_SERVICE_BACKUP_DIR=$base/backups"
ExecStart=$1 -e "setInterval(() => {}, 1e9)"
UNIT
  systemctl daemon-reload
}

echo "== a Node.js another account can change is refused"
unit_with "$user_node"
if bash "$repo/deploy/linux/install-elevation.sh" --service "$svc" --root "$base/compose" >/tmp/refused.txt 2>&1; then
  fail "installed with a Node.js the runner account can change"
fi
grep -q "other than root" /tmp/refused.txt || fail "unexpected refusal: $(cat /tmp/refused.txt)"
pass "user-owned Node.js refused"

unit_with "$node_bin"
systemctl start "$svc"

echo "== dry run changes nothing"
bash "$repo/deploy/linux/install-elevation.sh" --service "$svc" --root "$base/compose" --dry-run >/tmp/dry.txt 2>&1 || { cat /tmp/dry.txt; fail "dry run"; }
grep -q "would write /etc/hearth/elevation.json" /tmp/dry.txt || fail "dry run did not describe the scope"
[[ ! -e /etc/hearth/elevation.json ]] || fail "dry run wrote the scope"
pass "dry run"

echo "== install"
bash "$repo/deploy/linux/install-elevation.sh" --service "$svc" --root "$base/compose"
bash "$repo/deploy/linux/install-elevation.sh" --service "$svc" --verify || fail "verify"
pass "installed and verified"

client() { sudo -u "$user" "$node_bin" "$repo/scripts/elevation-ci-client.ts" /run/hearth/elevated.sock /etc/hearth/elevation.key "$@"; }

echo "== the service account cannot write the file itself"
if sudo -u "$user" bash -c "echo x >> '$file'" 2>/dev/null; then fail "it could write directly"; fi
pass "direct write refused by the system"

echo "== an approved write through the executor"
new=$'services:\n  app:\n    image: nginx:1.28\n'
out="$(client write "$file" app "$new")" || fail "write: $out"
echo "$out"
printf '%s' "$new" | cmp -s - "$file" || fail "content not written as approved"
[[ "$(stat -c %U:%a "$file")" == "root:644" ]] || fail "owner or mode changed: $(stat -c %U:%a "$file")"
backup="$(echo "$out" | "$node_bin" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).backup))')"
receipt="$(echo "$out" | "$node_bin" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).receipt))')"
[[ "$(stat -c %U "$base/backups/$backup")" == root ]] || fail "backup not root-owned"
pass "written, verified, backed up ($backup)"

echo "== replaying the same authorization is refused"
if out="$(client replay)"; then fail "replay ran: $out"; fi
echo "$out" | grep -q "already used" || fail "unexpected replay answer: $out"
pass "replay refused"

echo "== outside the scope is refused"
if out="$(client write /etc/hostname x "x")"; then fail "wrote outside the scope: $out"; fi
pass "outside scope refused: $out"

echo "== revert puts it back"
client revert "$receipt" || fail "revert"
grep -q "nginx:1.27" "$file" || fail "not put back"
pass "reverted"

echo "== the log"
"$node_bin" /usr/local/libexec/hearth/hearth-elevated.mjs --config /etc/hearth/elevation.json --verify-log | grep -q '"records"' || fail "log"
lsattr /var/log/hearth/elevated.jsonl 2>/dev/null || true
pass "log chain intact"

echo "== widening the scope"
mkdir -p "$base/other"
bash "$repo/deploy/linux/install-elevation.sh" --service "$svc" --add-root "$base/other" >/dev/null
grep -q "$base/other" /etc/hearth/elevation.json || fail "scope not widened"
grep -q "$base/other" /etc/systemd/system/hearth-elevated@.service || fail "unit not widened"
pass "scope widened"

echo "== RAID operations: switched on together, and only then may the unit write to drives"
grep -q "DevicePolicy=auto" /etc/systemd/system/hearth-elevated@.service && fail "drive access before RAID was on"
bash "$repo/deploy/linux/install-elevation.sh" --service "$svc" --add-operation raid >/dev/null
for op in raid.member raid.sync raid.speed raid.grow raid.create zfs.member zfs.create btrfs.member btrfs.balance snapraid.run storage.read; do
  grep -q "\"$op\"" /etc/hearth/elevation.json || fail "$op not switched on"
done
grep -q "DevicePolicy=auto" /etc/systemd/system/hearth-elevated@.service || fail "RAID unit has no drive access"
grep -q "ProtectKernelTunables=no" /etc/systemd/system/hearth-elevated@.service || fail "RAID unit cannot write md files"
grep -q -- "-/etc/zfs" /etc/systemd/system/hearth-elevated@.service || fail "RAID unit cannot update the ZFS pool cache"
pass "RAID operations on"

echo "== uninstall"
bash "$repo/deploy/linux/install-elevation.sh" --service "$svc" --uninstall
[[ ! -e /run/hearth/elevated.sock ]] || fail "socket still there"
[[ -f /var/log/hearth/elevated.jsonl ]] || fail "log not kept"
pass "uninstalled, log kept"
