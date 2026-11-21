#!/usr/bin/env bash
# Sets up Hearth's elevated executor (private/docs/HEARTH_COMPOSE_ACCESS_PROPOSAL.md): a small
# root-owned program that carries out approved plan steps Hearth's own account cannot, inside a scope
# you choose. Run it as root from Hearth's release or project folder. It never changes anything in
# your homelab itself; it only installs the executor, its scope, its key, and its log.
#
#   sudo bash deploy/linux/install-elevation.sh --service hearth \
#     --root /mnt/storage/docker/compose --root /mnt/storage/docker/config --dry-run
#
# Options:
#   --service NAME      the Hearth installation it serves (its systemd service; default hearth)
#   --root DIR          a folder the executor may act inside (repeat for several). Required on first
#                       install. Never "/", never a folder of the executor itself.
#   --unit NAME         a systemd unit it may start, stop, restart, reload, enable, or disable (repeat)
#   --user-service      the Hearth installed by get.sh (a systemd user service of the account
#                       running sudo), instead of a system service
#   --operations LIST   comma separated (default: file.write,file.restore,file.remove,
#                       file.permissions,dir.create,dir.remove,compose.apply,compose.down,revert;
#                       unit.control is added when --unit is given)
#   --backup-root DIR   where its backups go (default: the installation's DC_SERVICE_BACKUP_DIR)
#   --add-root DIR, --add-unit NAME, --remove-root DIR, --remove-unit NAME
#                       change the scope of an installed executor (the owner's step to widen or
#                       narrow what Ember can have done)
#   --add-operation NAME, --remove-operation NAME
#                       switch one operation on or off, keeping the rest (for example
#                       --add-operation smart.read, the read-only drive health report;
#                       --add-operation raid switches on every RAID / Arrays operation: mdadm
#                       (raid.*), ZFS (zfs.*), Btrfs (btrfs.*), SnapRAID (snapraid.run), and
#                       the root-only storage reads (storage.read)); --add-operation build
#                       switches on installing Docker and Tailscale for a homelab plan
#                       (docker.install, tailscale.install), which needs no --root
#   --dry-run           changes nothing: prints what it would write and run
#   --status            shows the executor, its scope, and checks its log
#   --verify            runs the post-install checks (see docs/ELEVATED_EXECUTOR.md)
#   --uninstall         removes the executor and its units; keeps its log, state, and backups
set -euo pipefail

service=hearth
mode=install
dry_run=""
roots=()
add_roots=()
remove_roots=()
units=()
add_units=()
remove_units=()
add_ops=()
remove_ops=()
operations=""
backup_root=""
user_service=""

while (($#)); do
  case "$1" in
    --service) service="$2"; shift ;;
    --root) roots+=("$2"); shift ;;
    --unit) units+=("$2"); shift ;;
    --operations) operations="$2"; shift ;;
    --user-service) user_service=1 ;;
    --backup-root) backup_root="$2"; shift ;;
    --add-root) add_roots+=("$2"); mode=scope; shift ;;
    --remove-root) remove_roots+=("$2"); mode=scope; shift ;;
    --add-unit) add_units+=("$2"); mode=scope; shift ;;
    --remove-unit) remove_units+=("$2"); mode=scope; shift ;;
    --add-operation)
      if [[ "$2" == build ]]; then add_ops+=(docker.install tailscale.install)
      elif [[ "$2" == raid ]]; then add_ops+=(raid.member raid.sync raid.speed raid.grow raid.create zfs.member zfs.scrub zfs.clear zfs.grow zfs.create btrfs.member btrfs.scrub btrfs.balance btrfs.clear btrfs.create snapraid.run storage.read)
      else add_ops+=("$2"); fi
      mode=scope; shift ;;
    --remove-operation)
      if [[ "$2" == raid ]]; then remove_ops+=(raid.member raid.sync raid.speed raid.grow raid.create zfs.member zfs.scrub zfs.clear zfs.grow zfs.create btrfs.member btrfs.scrub btrfs.balance btrfs.clear btrfs.create snapraid.run storage.read)
      else remove_ops+=("$2"); fi
      mode=scope; shift ;;
    --dry-run) dry_run=1 ;;
    --status) mode=status ;;
    --verify) mode=verify ;;
    --uninstall) mode=uninstall ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
  shift
done

say() { printf '\n== %s\n' "$*"; }
run() {
  if [[ -n "$dry_run" ]]; then printf '  would run: %s\n' "$*"; else "$@"; fi
}
write() { # write PATH OWNER:GROUP MODE  (content on stdin)
  local content
  content="$(cat)"
  if [[ -n "$dry_run" ]]; then
    printf '  would write %s (%s, %s):\n%s\n' "$1" "$2" "$3" "$(sed 's/^/    /' <<<"$content")"
  else
    local tmp
    tmp="$(mktemp "$(dirname "$1")/.hearth-install.XXXXXX")"
    printf '%s\n' "$content" >"$tmp"
    chown "$2" "$tmp"
    chmod "$3" "$tmp"
    mv -f "$tmp" "$1"
  fi
}

if [[ -z "$dry_run" && "$(id -u)" != 0 ]]; then
  echo "Run it as root (sudo bash deploy/linux/install-elevation.sh ...), or with --dry-run."
  exit 1
fi
if [[ ! "$service" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "--service must be a systemd service name like hearth, got '$service'."
  exit 2
fi

unit="/etc/systemd/system/$service.service"
prog_dir=/usr/local/libexec/hearth
prog="$prog_dir/hearth-elevated.mjs"
etc=/etc/hearth
cfg="$etc/elevation.json"
key="$etc/elevation.key"
state=/var/lib/hearth-elevated
logdir=/var/log/hearth
log="$logdir/elevated.jsonl"
sock_dir=/run/hearth
sock="$sock_dir/elevated.sock"
socket_unit=/etc/systemd/system/hearth-elevated.socket
service_unit=/etc/systemd/system/hearth-elevated@.service
dropin_dir="/etc/systemd/system/$service.service.d"
dropin="$dropin_dir/elevation.conf"

user_systemctl() { # the account's own systemd, for get.sh's user service
  run runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$(id -u "$user")" systemctl --user "$@"
}
field() { grep -m1 "^$2=" "$1" 2>/dev/null | cut -d= -f2-; }
env_of() { { grep -m1 -E "^Environment=\"?$2=" "$1" 2>/dev/null || true; } | sed -E "s/^Environment=\"?$2=//; s/\"$//"; }

# get.sh's installation: a systemd user service of the account that ran sudo.
if [[ -n "$user_service" ]]; then
  user="${SUDO_USER:-}"
  [[ -n "$user" && "$user" != root ]] || { echo "Run it with sudo from the account Hearth runs as."; exit 1; }
  user_home="$(getent passwd "$user" | cut -d: -f6)"
  unit="$user_home/.config/systemd/user/$service.service"
  dropin_dir="$user_home/.config/systemd/user/$service.service.d"
  dropin="$dropin_dir/elevation.conf"
fi
if [[ ! -f "$unit" ]]; then
  echo "No Hearth installation called '$service' ($unit). Give its name with --service (or --user-service for one installed with get.sh)."
  exit 1
fi
[[ -n "$user_service" ]] || user="$(field "$unit" User)"
app_dir="$(field "$unit" WorkingDirectory)"
node_bin="$(field "$unit" ExecStart | awk '{print $1}')"
[[ -x "$node_bin" ]] || node_bin="$(command -v node || true)"
if [[ -z "$user" || "$user" == root ]]; then
  echo "$service runs as '${user:-root}'; the executor serves a Hearth that runs as its own account."
  exit 1
fi
group="$(id -gn "$user")"
gid="$(id -g "$user")"
if [[ -z "$node_bin" ]] || (($("$node_bin" -p 'process.versions.node.split(".")[0]') < 24)); then
  echo "Node.js 24 or newer is needed (Hearth's own runtime)."
  exit 1
fi
# The executor runs every request with this program, as root: it and every folder above it must
# be root's alone, or whoever can change them would run code as root.
node_bin="$(realpath "$node_bin")"
# get.sh may bring its own Node.js in the account's folder: the executor gets a root-owned copy.
own_copy=""
d="$node_bin"
while :; do
  if [[ "$(stat -c %u "$d")" != 0 || -n "$(find "$d" -maxdepth 0 -perm /022)" ]]; then own_copy=1; break; fi
  [[ "$d" == / ]] && break
  d="$(dirname "$d")"
done
if [[ -n "$own_copy" && -n "$user_service" ]]; then
  echo "Node.js here belongs to $user: the executor gets its own root-owned copy ($prog_dir/node)."
  run install -d -o root -g root -m 0755 "$prog_dir"
  run install -o root -g root -m 0755 "$node_bin" "$prog_dir/node"
  [[ -n "$dry_run" ]] || node_bin="$prog_dir/node"
fi
d="$node_bin"
while :; do
  if [[ "$(stat -c %u "$d")" != 0 || -n "$(find "$d" -maxdepth 0 -perm /022)" ]]; then
    echo "$d can be changed by an account other than root, and the executor would run it as root."
    echo "Use a Node.js installed by the system (for example from NodeSource) for the executor."
    exit 1
  fi
  [[ "$d" == / ]] && break
  d="$(dirname "$d")"
done
# The socket and key are shared with the service account's group: no other account may be in it.
others="$(awk -F: -v g="$gid" -v u="$user" '$4 == g && $1 != u {print $1}' /etc/passwd)"
members="$(getent group "$group" | cut -d: -f4 | tr ',' '\n' | grep -vx "$user" | grep -v '^$' || true)"
if [[ -n "$others$members" ]]; then
  echo "Other accounts share the group $group ($(echo $others $members)); they could reach the executor."
  echo "Give $user a group of its own first."
  exit 1
fi
built="$app_dir/apps/server/dist-elevated/hearth-elevated.js"
[[ -f "$built" ]] || built="$(pwd)/apps/server/dist-elevated/hearth-elevated.js"

# JSON is read and written with Node, so folder names never need shell quoting.
json() { "$node_bin" -e "$1" "${@:2}"; }

current_scope() { [[ -f "$cfg" ]] && cat "$cfg" || echo '{}'; }

scope_json() { # roots units operations backup_root, from the arguments and the installed scope
  json '
    const [cur, roots, units, ops, backup, gid, add, rmR, addU, rmU, addO, rmO, user] = process.argv.slice(1);
    const c = JSON.parse(cur);
    const list = (s) => s.split("\n").filter(Boolean);
    let r = list(roots).length ? list(roots) : (c.roots ?? []);
    r = [...new Set([...r, ...list(add)])].filter((x) => !list(rmR).includes(x));
    let u = list(units).length ? list(units) : (c.units ?? []);
    u = [...new Set([...u, ...list(addU)])].filter((x) => !list(rmU).includes(x));
    let o = ops ? ops.split(",").map((x) => x.trim()).filter(Boolean)
      : (c.operations ?? ["file.write","file.restore","file.remove","dir.create","dir.remove","revert"]);
    o = [...new Set([...o, ...list(addO)])].filter((x) => !list(rmO).includes(x));
    if (u.length && !o.includes("unit.control")) o.push("unit.control");
    if (!u.length) o = o.filter((x) => x !== "unit.control");
    for (const x of r) if (!x.startsWith("/") || x === "/" || x.endsWith("/") || /["\\\n]/.test(x)) { console.error("Not a usable folder: " + x); process.exit(3); }
    for (const x of u) if (!/^[A-Za-z0-9@._-]+\.(service|socket|timer|target|path|mount)$/.test(x) || /^hearth/i.test(x)) { console.error("Not a usable unit: " + x); process.exit(3); }
    process.stdout.write(JSON.stringify({
      version: 1, roots: r, operations: o, units: u,
      backupRoot: backup || c.backupRoot, backupGid: Number(gid),
      stateDir: "/var/lib/hearth-elevated", auditLog: "/var/log/hearth/elevated.jsonl",
      keyFile: "/etc/hearth/elevation.key", serviceUser: user,
    }, null, 2));
  ' "$(current_scope)" "$(printf '%s\n' "${roots[@]}")" "$(printf '%s\n' "${units[@]}")" \
    "$operations" "$backup_root" "$gid" "$(printf '%s\n' "${add_roots[@]}")" \
    "$(printf '%s\n' "${remove_roots[@]}")" "$(printf '%s\n' "${add_units[@]}")" \
    "$(printf '%s\n' "${remove_units[@]}")" "$(printf '%s\n' "${add_ops[@]}")" \
    "$(printf '%s\n' "${remove_ops[@]}")" "$user"
}

# The writable folders as systemd reads them: each quoted, "%" doubled ("-": a missing one is skipped).
writable_of() {
  json 'const c = JSON.parse(process.argv[1]); console.log([...c.roots, c.backupRoot, ...process.argv.slice(2)].map((p) => `"-${p.replaceAll("%", "%%")}"`).join(" "))' "$1" "${@:2}"
}

service_unit_text() { # the per-request service, with the kernel holding it to the scope's folders
  local scope="$1" rw caps devices tunables families
  rw="$(writable_of "$scope" "$state" "$logdir")"
  caps="CAP_CHOWN CAP_FOWNER CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH"
  devices="PrivateDevices=yes"
  tunables="ProtectKernelTunables=yes"
  families="AF_UNIX"
  # smart.read (drive health) asks the drives themselves: read access to whole drives only, and
  # the two capabilities the kernel requires for SMART commands (ATA passthrough, NVMe logs).
  if json 'process.exit(JSON.parse(process.argv[1]).operations.includes("smart.read") ? 0 : 1)' "$scope"; then
    caps="$caps CAP_SYS_RAWIO CAP_SYS_ADMIN"
    devices="DevicePolicy=closed
DeviceAllow=block-sd r
DeviceAllow=block-blkext r
DeviceAllow=char-nvme r"
  fi
  # RAID operations (mdadm, ZFS, Btrfs, SnapRAID) write to the drives they were approved for, to
  # the kernel's md files under /sys, to ZFS's pool cache and Btrfs's scrub records, and wait for
  # udev over netlink. Each operation checks the drive itself (never the system, never mounted,
  # serial as approved) before it writes. Long jobs (a SnapRAID sync, removing a Btrfs drive,
  # creating a ZFS pool, which mounts it) run outside this sandbox through systemd-run.
  if json 'process.exit(JSON.parse(process.argv[1]).operations.some((o) => /^(raid|zfs|btrfs|snapraid)\./.test(o)) ? 0 : 1)' "$scope"; then
    caps="$caps CAP_SYS_RAWIO CAP_SYS_ADMIN CAP_MKNOD"
    devices="DevicePolicy=auto"
    tunables="ProtectKernelTunables=no"
    families="AF_UNIX AF_NETLINK"
    rw="$rw \"-/run/mdadm\" \"-/etc/zfs\" \"-/var/lib/btrfs\""
  fi
  cat <<UNIT
[Unit]
Description=Hearth elevated executor (one approved request)
Documentation=file://$app_dir/docs/ELEVATED_EXECUTOR.md

[Service]
User=root
ExecStart=$node_bin $prog --config $cfg
StandardInput=socket
StandardOutput=socket
StandardError=journal
# Writable: only the scope's folders, its backups, its own state and log. Everything else is
# read-only to it, whatever a request says.
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$rw
PrivateTmp=yes
NoNewPrivileges=yes
# Only what changing files and their owners needs (and reading SMART, when that is on);
# never set-user-ID programs.
CapabilityBoundingSet=$caps
RestrictSUIDSGID=yes
RestrictAddressFamilies=$families
RestrictNamespaces=yes
$devices
$tunables
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
LockPersonality=yes
SystemCallArchitectures=native
UMask=0077
RuntimeMaxSec=900
UNIT
}

socket_unit_text() {
  cat <<UNIT
[Unit]
Description=Hearth elevated executor (socket for $service)

[Socket]
ListenStream=$sock
SocketUser=root
SocketGroup=$group
SocketMode=0660
DirectoryMode=0755
Accept=yes
MaxConnections=4
RemoveOnStop=yes

[Install]
WantedBy=sockets.target
UNIT
}

dropin_text() {
  cat <<UNIT
# Written by install-elevation.sh: lets $service ask the elevated executor (only for approved steps).
[Service]
Environment=DC_ELEVATION=1
Environment=DC_ELEVATION_SOCKET=$sock
Environment=DC_ELEVATION_KEY=$key
UNIT
}

status() {
  say "Elevated executor for $service"
  echo "program:  $prog $([[ -f "$prog" ]] && echo "(installed)" || echo "(not installed)")"
  echo "socket:   $(systemctl is-active hearth-elevated.socket 2>/dev/null || true), $sock"
  echo "serves:   $service (account $user, group $group)"
  if [[ -f "$cfg" && -f "$prog" ]]; then
    "$node_bin" "$prog" --config "$cfg" --status
    echo "log:      $("$node_bin" "$prog" --config "$cfg" --verify-log)"
  fi
}

case "$mode" in
  status) status; exit 0 ;;
  verify)
    say "Checks"
    fail=0
    # check WANT DESCRIPTION COMMAND...: WANT is pass (the command succeeds) or fail (it must not).
    check() {
      local want="$1" desc="$2" got=fail
      shift 2
      "$@" >/dev/null 2>&1 && got=pass
      if [[ "$got" == "$want" ]]; then echo "  ok    $desc"; else echo "  FAIL  $desc"; fail=1; fi
    }
    # Asks the executor for one operation. Exits 0 when it answered ok, 3 when it answered with a
    # refusal, 1 with no readable answer, 2 when it could not connect.
    ask='const s=require("net").connect(process.argv[1]);let o="";s.on("connect",()=>s.write(JSON.stringify({v:1,op:process.argv[2]})+"\n"));s.on("data",d=>o+=d);s.on("close",()=>{let r;try{r=JSON.parse(o)}catch{process.exit(1)}process.exit(r.ok?0:r.outcome==="refused"?3:1)});s.on("error",()=>process.exit(2))'
    exits() { local want="$1"; shift; "$@" >/dev/null 2>&1; [[ "$?" == "$want" ]]; }
    no_problems() { "$node_bin" "$prog" --config "$cfg" --status | grep -q '"problems": \[\]'; }
    check pass "its own setup has no problems" no_problems
    check pass "its log chain is intact" "$node_bin" "$prog" --config "$cfg" --verify-log
    check pass "$user can ask it for its status" sudo -u "$user" "$node_bin" -e "$ask" "$sock" status
    check pass "another account cannot reach it" exits 2 sudo -u nobody "$node_bin" -e "$ask" "$sock" status
    check pass "it answers a change without an authorization with a refusal" \
      exits 3 sudo -u "$user" "$node_bin" -e "$ask" "$sock" revert
    check fail "$user cannot change its scope" sudo -u "$user" test -w "$cfg"
    check fail "$user cannot change its key" sudo -u "$user" test -w "$key"
    check fail "$user cannot change its program" sudo -u "$user" test -w "$prog"
    check pass "$service is told where it is" grep -q DC_ELEVATION=1 "$dropin"
    exit "$fail"
    ;;
  uninstall)
    say "Removing the elevated executor (its log, state, and backups are kept)"
    run systemctl disable --now hearth-elevated.socket
    run systemctl stop 'hearth-elevated@*.service'
    run rm -f "$socket_unit" "$service_unit" "$dropin" "$prog" "$cfg" "$key"
    run rmdir --ignore-fail-on-non-empty "$dropin_dir" "$prog_dir" "$etc"
    run systemctl daemon-reload
    if [[ -n "$user_service" ]]; then user_systemctl daemon-reload; user_systemctl restart "$service"
    else run systemctl restart "$service"; fi
    echo "Kept: $log, $state, and its backups."
    exit 0
    ;;
esac

# install, or a scope change
# Folders are needed for the file operations; installing software for a plan needs none.
only_build=""
if [[ -n "$operations" || ${#add_ops[@]} -gt 0 ]]; then
  only_build=1
  for o in ${operations//,/ } "${add_ops[@]}"; do
    [[ "$o" == docker.install || "$o" == tailscale.install ]] || only_build=""
  done
fi
if [[ "$mode" == install && ! -f "$cfg" && ${#roots[@]} -eq 0 && -z "$only_build" ]]; then
  echo "Give at least one folder with --root on the first install."
  exit 2
fi
if [[ "$mode" == scope && ! -f "$cfg" ]]; then
  echo "The executor is not installed yet; install it first (with --root)."
  exit 1
fi
if [[ -z "$backup_root" && ! -f "$cfg" && -n "$user_service" ]]; then
  envfile="$(field "$unit" EnvironmentFile)"
  backup_root="$(grep -m1 '^DC_BACKUP_DIR=' "$envfile" 2>/dev/null | cut -d= -f2-)"
fi
if [[ -z "$backup_root" && ! -f "$cfg" ]]; then
  backup_root="$(env_of "$unit" DC_SERVICE_BACKUP_DIR)"
  [[ -z "$backup_root" ]] && backup_root="$(dirname "$(env_of "$unit" DC_BACKUP_DIR)")"
fi
[[ -n "$backup_root" ]] && backup_root="$(realpath -m "$backup_root")"
if [[ -z "$backup_root" && ! -f "$cfg" ]]; then
  echo "Say where its backups go with --backup-root (the installation has no DC_SERVICE_BACKUP_DIR)."
  exit 2
fi
scope="$(scope_json)"
while IFS= read -r p; do
  [[ -n "$p" ]] || continue
  [[ -d "$p" ]] || { echo "The folder $p does not exist."; exit 1; }
  [[ "$(realpath "$p")" == "$p" ]] || { echo "$p goes through a link; give its real path: $(realpath "$p")"; exit 1; }
done < <(json 'console.log(JSON.parse(process.argv[1]).roots.join("\n"))' "$scope")
if [[ "$mode" == install && ! -f "$built" ]]; then
  echo "The built executor is missing ($built); run it from a Hearth release or build first."
  [[ -z "$dry_run" ]] && exit 1
fi

if [[ "$mode" == install ]]; then
  say "Program"
  run install -d -o root -g root -m 0755 "$prog_dir"
  run install -o root -g root -m 0755 "$built" "$prog"
  say "Key (shared by root and $user only; the AI never sees it)"
  run install -d -o root -g root -m 0755 "$etc"
  if [[ -f "$key" ]]; then echo "  keeping the existing key"; else
    run bash -c "umask 077; head -c 32 /dev/urandom > '$key'"
  fi
  run chown "root:$group" "$key"
  run chmod 0640 "$key"
  say "State and log"
  run install -d -o root -g root -m 0700 "$state"
  run install -d -o root -g root -m 0755 "$logdir"
  [[ -f "$log" ]] || run install -o root -g "$group" -m 0640 /dev/null "$log"
  run bash -c "chattr +a '$log' 2>/dev/null || echo '  (this filesystem cannot make the log append-only; its records are still chained)'"
fi
say "Scope"
write "$cfg" root:root 0644 <<<"$scope"
say "Units"
write "$service_unit" root:root 0644 <<<"$(service_unit_text "$scope")"
write "$socket_unit" root:root 0644 <<<"$(socket_unit_text)"
if [[ -n "$user_service" ]]; then
  run install -d -o "$user" -g "$group" -m 0755 "$dropin_dir"
else
  run install -d -o root -g root -m 0755 "$dropin_dir"
fi
write "$dropin" root:root 0644 <<<"$(dropin_text)"
run systemctl daemon-reload
run systemctl enable --now hearth-elevated.socket
if [[ "$mode" == install ]]; then
  say "Restarting $service so it knows about the executor"
  if [[ -n "$user_service" ]]; then user_systemctl daemon-reload; user_systemctl restart "$service"
  else run systemctl restart "$service"; fi
fi
if [[ -z "$dry_run" ]]; then
  status
  echo
  echo "Next: sudo bash deploy/linux/install-elevation.sh --service $service --verify"
fi
