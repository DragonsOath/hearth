#!/usr/bin/env bash
# Installs Hearth as a systemd service on Linux (tested on Ubuntu
# 24.04 / the home server OS 18). Run it from the project folder. By default the service
# runs as the user who runs this (that user's Docker access and Claude Code login
# are what Hearth uses), and it asks for sudo only to write the service file.
#
#   DC_DATA_DIR=/srv/dragon-control/data DC_KEY_DIR=/srv/secrets/dragon-control \
#   DC_BACKUP_DIR=/srv/backups/dragon-control [DC_BACKUP_COPY_DIR=/other/drive/dragon-control] \
#     bash deploy/linux/install.sh
#
# Other settings it carries into the service: DC_PORT, DC_HOST (127.0.0.1, this machine only, by
# default; 0.0.0.0 for the whole home network), DC_VOICE_HOST, DC_OFFSITE_NAME, DC_BACKUP_KEEP,
# DC_CADDYFILE, DC_SERVICE_BACKUP_DIR, DC_HOST_DOCS, DC_HOMELAB_ROOTS, DC_COMPOSE_ROOT. .env.example
# says what each one does. The elevated executor is set up separately (install-elevation.sh).
#
# More than one installation on one machine (docs/MULTIPLE_INSTALLS.md): each one is its own
# project folder and its own systemd service.
#   DC_SERVICE_NAME  the service's name (default dragon-control). Running it again from the same
#                    folder finds the name by itself; it never manages a service that belongs to
#                    another folder.
#   DC_SERVICE_USER  the account the service runs as (default: you). For a dedicated account with
#                    no sudo, an administrator runs this and the build runs as that account.
#   DC_AUTOSTART     yes (default) starts it when the machine starts; no leaves it off until you
#                    start it (sudo systemctl start <name>), for a temporary or trial installation.
#   DC_MEMORY_MAX, DC_MEMORY_HIGH, DC_MEMORY_SWAP_MAX, DC_CPU_QUOTA
#                    limits for the service, in systemd's own words (1G, 768M, 0 = no swap,
#                    100% = one core).
#                    Off by default. Running it again keeps them; "none" removes one.
#   DC_RESTART_LIMIT  stop restarting after this many failed starts in this many seconds, like
#                    5/600 (systemd StartLimitBurst and StartLimitIntervalSec). Off by default:
#                    then it keeps restarting after a failure, as before. "none" removes it.
#
# Options:
#   --dry-run    changes nothing: checks this machine, then prints the installation it would
#                manage, every command it would run, and the service file it would write.
#   --status     shows this installation only: its service, account, folders, commit, and state.
#   --uninstall  stops and removes this installation's service only. Its data, keys, backups,
#                and project folder are kept; it says where they are.
# --dry-run works with --uninstall too (or DC_INSTALL_DRY_RUN=1).
#
# Safe to run again after pulling a new version: it rebuilds and restarts,
# and the database is upgraded in place on start.
set -euo pipefail

dry_run="${DC_INSTALL_DRY_RUN:-}"
mode=install
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --status) mode=status ;;
    --uninstall) mode=uninstall ;;
    *) echo "Unknown option: $arg (options: --dry-run, --status, --uninstall)"; exit 2 ;;
  esac
done

say() { printf '\n== %s\n' "$*"; }
app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
current_user="$(id -un)"

# Where service files live; tests point this somewhere harmless. DC_INSTALL_UNIT (an exact file)
# is still accepted, for older scripts.
if [[ -n "${DC_INSTALL_UNIT:-}" ]]; then
  unit_dir="$(dirname "$DC_INSTALL_UNIT")"
else
  unit_dir="${DC_INSTALL_UNIT_DIR:-/etc/systemd/system}"
fi

# A value from a service file: an Environment= setting, or a [Service] field like User=.
env_of() { sed -n "s/^Environment=\"\{0,1\}$2=\(.*\)$/\1/p" "$1" 2>/dev/null | sed 's/"$//' | tail -1; }
field_of() { sed -n "s/^$2=\(.*\)$/\1/p" "$1" 2>/dev/null | tail -1; }
# Every Hearth installation on this machine: service files that start its server.
installations() {
  local f
  for f in "$unit_dir"/*.service; do
    [[ -f "$f" ]] && grep -q 'apps/server/dist/index.js' "$f" 2>/dev/null && echo "$f"
  done
  return 0
}

# Which installation this is. Given a name, that one; otherwise the one installed from this
# folder; otherwise the default name, for a first install.
service="${DC_SERVICE_NAME:-}"
if [[ -z "$service" ]]; then
  while IFS= read -r f; do
    [[ -n "$f" && "$(field_of "$f" WorkingDirectory)" == "$app_dir" ]] && service="$(basename "$f" .service)"
  done < <(installations)
fi
service="${service:-dragon-control}"
if [[ ! "$service" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; then
  echo "DC_SERVICE_NAME must be lowercase letters, digits, and dashes (like hearth-preview), got '$service'."
  exit 2
fi
if [[ -n "${DC_INSTALL_UNIT:-}" && -z "${DC_SERVICE_NAME:-}" ]]; then
  unit="$DC_INSTALL_UNIT"
  service="$(basename "$unit" .service)"
else
  unit="$unit_dir/$service.service"
fi

# Running it again keeps the installed settings: a setting not given now is
# taken from the existing service file, never silently reset to the default
# (that would move keys, backups, or the off-machine copy).
# Prints nothing (and still succeeds) on a first install, so "set -e" does not stop the script.
installed() {
  [[ -f "$unit" ]] || return 0
  env_of "$unit" "$1"
}
# --status and --uninstall describe what is installed, whatever is set now.
setting() {
  local v="${!1:-}"
  if [[ "$mode" != install && -f "$unit" ]]; then installed "$1"; return; fi
  [[ -n "$v" ]] && { echo "$v"; return; }
  installed "$1"
}
data_dir="$(setting DC_DATA_DIR)"; data_dir="${data_dir:-$app_dir/data}"
key_dir="$(setting DC_KEY_DIR)"; key_dir="${key_dir:-$data_dir}"
backup_dir="$(setting DC_BACKUP_DIR)"; backup_dir="${backup_dir:-$data_dir/backups}"
backup_copy_dir="$(setting DC_BACKUP_COPY_DIR)"
offsite_name="$(setting DC_OFFSITE_NAME)"
voice_host="$(setting DC_VOICE_HOST)"
backup_keep="$(setting DC_BACKUP_KEEP)"
caddyfile="$(setting DC_CADDYFILE)"
service_backup_dir="$(setting DC_SERVICE_BACKUP_DIR)"
host_docs="$(setting DC_HOST_DOCS)"
homelab_roots="$(setting DC_HOMELAB_ROOTS)"
compose_root="$(setting DC_COMPOSE_ROOT)"
port="$(setting DC_PORT)"; port="${port:-7400}"
host="$(setting DC_HOST)"; host="${host:-127.0.0.1}"
installed_user="$( [[ -f "$unit" ]] && field_of "$unit" User || true)"
# A [Service] limit: given now (or "none" to remove it), else the installed one.
limit() {
  local v="${!1:-}"
  if [[ "$mode" != install && -f "$unit" ]]; then field_of "$unit" "$2"; return; fi
  if [[ "$v" == none ]]; then echo ""; elif [[ -n "$v" ]]; then echo "$v"; elif [[ -f "$unit" ]]; then field_of "$unit" "$2"; fi
}
memory_max="$(limit DC_MEMORY_MAX MemoryMax)"
memory_high="$(limit DC_MEMORY_HIGH MemoryHigh)"
memory_swap_max="$(limit DC_MEMORY_SWAP_MAX MemorySwapMax)"
cpu_quota="$(limit DC_CPU_QUOTA CPUQuota)"
# The restart limit is stored as two [Unit] fields; read back as "burst/seconds".
restart_limit="${DC_RESTART_LIMIT:-}"
if [[ "$mode" != install && -f "$unit" ]] || [[ -z "$restart_limit" && -f "$unit" ]]; then
  burst="$(field_of "$unit" StartLimitBurst)"; interval="$(field_of "$unit" StartLimitIntervalSec)"
  restart_limit="${burst:+$burst/$interval}"
fi
[[ "$restart_limit" == none ]] && restart_limit=""
autostart="$(setting DC_AUTOSTART)"; autostart="${autostart:-yes}"
user="${DC_SERVICE_USER:-${installed_user:-$current_user}}"
installed_dir="$( [[ -f "$unit" ]] && field_of "$unit" WorkingDirectory || true)"
# Read only. safe.directory lets an administrator read the commit of a folder a dedicated account owns
# (git refuses another user's repository otherwise).
commit="$(command -v git >/dev/null && git -c safe.directory="$app_dir" -C "$app_dir" rev-parse --short HEAD 2>/dev/null || true)"
commit="${commit:-unknown (not a git checkout)}"
# A release archive (scripts/pack-release.sh) is already built and carries its own runtime packages;
# its RELEASE file says which version and commit it is. Nothing is built from it.
release=""
if [[ -f "$app_dir/RELEASE" ]]; then
  release="$(sed -n 's/^version=//p' "$app_dir/RELEASE")"
  commit="$(sed -n 's/^commit=//p' "$app_dir/RELEASE") (release ${release:-unknown})"
fi

# The other installations on this machine, which this run must leave alone.
others=()
while IFS= read -r f; do
  [[ -n "$f" && "$f" != "$unit" ]] && others+=("$f")
done < <(installations)
# With more than one installation on this machine, which one to manage is never inferred from the
# folder: a run from the wrong folder must stop, not rebuild or remove something else.
if [[ "$mode" != status && -z "${DC_SERVICE_NAME:-}" && -z "${DC_INSTALL_UNIT:-}" ]] && (( ${#others[@]} )); then
  echo "Stopped: this machine has more than one Hearth installation, so name the one to manage:"
  for f in "$unit" "${others[@]}"; do
    [[ -f "$f" ]] && echo "  DC_SERVICE_NAME=$(basename "$f" .service)   (folder $(field_of "$f" WorkingDirectory))"
  done
  echo "  For example: DC_SERVICE_NAME=$service bash deploy/linux/install.sh --dry-run"
  exit 1
fi
describe() {
  local f="$1"
  echo "$(basename "$f" .service) (folder $(field_of "$f" WorkingDirectory), port $(env_of "$f" DC_PORT), runs as $(field_of "$f" User))"
}

problems=0
# A problem stops a real run at once; a dry run lists every problem, then ends with "Not ready".
problem() { [[ -n "$dry_run" || "$mode" == status ]] || exit 1; problems=1; }

# This service must belong to this folder. A service installed from another folder is another
# installation: managing it from here would rebuild or remove the wrong one.
if [[ -n "$installed_dir" && "$installed_dir" != "$app_dir" ]]; then
  echo "Stopped: the service '$service' belongs to the installation in $installed_dir, not this folder ($app_dir)."
  echo "  To manage that installation, run this from $installed_dir."
  echo "  For a separate installation, give it its own name, for example: DC_SERVICE_NAME=hearth-preview"
  # Everything after this would describe the other installation, so stop here, dry run or not.
  exit 1
fi

if [[ "$mode" == install ]]; then
  for name in DC_DATA_DIR DC_KEY_DIR DC_BACKUP_DIR DC_BACKUP_COPY_DIR DC_OFFSITE_NAME DC_VOICE_HOST \
    DC_BACKUP_KEEP DC_CADDYFILE DC_SERVICE_BACKUP_DIR DC_HOST_DOCS DC_HOMELAB_ROOTS DC_COMPOSE_ROOT \
    DC_PORT DC_HOST; do
    before="$(installed "$name")"
    if [[ -n "${!name:-}" && -n "$before" && "${!name}" != "$before" ]]; then
      echo "Note: $name changes from '$before' to '${!name}'."
    fi
  done
  if [[ -n "$installed_user" && "$user" != "$installed_user" ]]; then
    echo "Note: the account it runs as changes from '$installed_user' to '$user'."
  fi

  # Two installations never share a folder, a port, or their records.
  for f in ${others[@]+"${others[@]}"}; do
    other="$(basename "$f" .service)"
    if [[ "$(field_of "$f" WorkingDirectory)" == "$app_dir" ]]; then
      echo "Stopped: this folder is already installed as '$other'. One folder is one installation;"
      echo "  for another installation, use another copy of the project in its own folder."
      problem
    fi
    if [[ "$(env_of "$f" DC_PORT)" == "$port" ]]; then
      echo "Stopped: port $port is used by the installation '$other'. Choose another, for example: DC_PORT=7500"
      problem
    fi
    # Nested folders count as shared: one inside another installation's (or around it).
    for theirs in "$(field_of "$f" WorkingDirectory)" "$(env_of "$f" DC_DATA_DIR)" "$(env_of "$f" DC_KEY_DIR)" "$(env_of "$f" DC_BACKUP_DIR)"; do
      [[ -z "$theirs" ]] && continue
      seen=" "
      for mine in "$data_dir" "$key_dir" "$backup_dir"; do
        [[ "$seen" == *" $mine "* ]] && continue
        seen+="$mine "
        if [[ "$mine" == "$theirs"/* || "$theirs" == "$mine"/* ]]; then
          echo "Stopped: $mine and the installation '$other''s $theirs are inside one another. Each installation needs folders of its own."
          problem
        fi
      done
    done
    for kind in DC_DATA_DIR DC_KEY_DIR DC_BACKUP_DIR; do
      theirs="$(env_of "$f" "$kind")"
      case "$kind" in
        DC_DATA_DIR) mine="$data_dir" ;;
        DC_KEY_DIR) mine="$key_dir" ;;
        DC_BACKUP_DIR) mine="$backup_dir" ;;
      esac
      if [[ -n "$theirs" && "$theirs" == "$mine" ]]; then
        echo "Stopped: $mine is the installation '$other''s $kind. Each installation needs its own."
        problem
      fi
    done
  done
fi

if [[ "$mode" == install ]]; then
  case "$autostart" in yes | no) ;; *) echo "DC_AUTOSTART must be yes or no, got '$autostart'."; problem ;; esac
  for pair in "DC_MEMORY_MAX:$memory_max" "DC_MEMORY_HIGH:$memory_high" "DC_MEMORY_SWAP_MAX:$memory_swap_max"; do
    v="${pair#*:}"
    [[ -z "$v" || "$v" =~ ^[0-9]+[KMG]?$ ]] || { echo "${pair%%:*} must be a size like 768M or 1G, got '$v'."; problem; }
  done
  [[ -z "$cpu_quota" || "$cpu_quota" =~ ^[0-9]+%$ ]] || { echo "DC_CPU_QUOTA must be a percentage like 100% (one core), got '$cpu_quota'."; problem; }
  [[ -z "$restart_limit" || "$restart_limit" =~ ^[1-9][0-9]*/[1-9][0-9]*$ ]] || { echo "DC_RESTART_LIMIT must be failed starts / seconds, like 5/600, got '$restart_limit'."; problem; }
fi

# The service runs as whoever runs this, or the account given, and Hearth never runs as root.
if [[ "$(id -u)" == "0" ]]; then
  echo "Run this as your everyday user, not root: Hearth never runs as root."
  problem
fi
user_home="$HOME"
if [[ "$user" != "$current_user" ]]; then
  if [[ "$user" == "root" ]]; then
    echo "DC_SERVICE_USER cannot be root: Hearth never runs as root."
    problem
  fi
  entry="$(getent passwd "$user" || true)"
  if [[ -z "$entry" ]]; then
    echo "The account '$user' does not exist. Create it first (docs/MULTIPLE_INSTALLS.md shows how)."
    [[ "$mode" == install ]] && problem
  else
    user_home="$(echo "$entry" | cut -d: -f6)"
    [[ "$(echo "$entry" | cut -d: -f3)" == "0" ]] && { echo "DC_SERVICE_USER cannot be a root account."; problem; }
  fi
  # The build runs as that account, so it must own the project folder.
  if [[ "$mode" == install && -n "$entry" && "$(stat -c %U "$app_dir")" != "$user" ]]; then
    echo "The project folder must belong to '$user', who builds and runs it. Either clone it as that account:"
    echo "  sudo -u $user git clone <repository> <folder>"
    echo "or hand this copy over: sudo chown -R $user: $app_dir"
    problem
  fi
fi
# A dedicated account's folders are created with "install -d -o <account>", which would also hand
# over a folder that already exists (a typo like /srv/backups would lock its owner out). So an
# existing folder must already belong to that account.
if [[ "$mode" == install && "$user" != "$current_user" && -n "${entry:-}" ]]; then
  for d in "$data_dir" "$key_dir" "$backup_dir"; do
    if [[ -e "$d" && "$(stat -c %U "$d")" != "$user" ]]; then
      echo "Stopped: $d already exists and belongs to $(stat -c %U "$d"), not $user. Choose a new folder for this installation;"
      echo "  the installer never takes over a folder that is already there."
      problem
    fi
  done
fi
# Runs a step as the service's account: directly when that is you, otherwise through sudo.
as_user() {
  if [[ "$user" == "$current_user" ]]; then "$@"; else sudo -u "$user" -H "$@"; fi
}

# --status: this installation only. Reads, never changes anything.
if [[ "$mode" == status ]]; then
  say "Installation '$service'"
  echo "service file: $unit$([[ -f "$unit" ]] || echo " (not installed)")"
  echo "folder:       $app_dir"
  echo "commit:       $commit"
  if [[ -f "$unit" ]]; then
    echo "runs as:      $installed_user"
    echo "data:         $data_dir"
    echo "key:          $key_dir"
    echo "backups:      $backup_dir"
    echo "address:      http://$host:$port"
    echo "state:        $(systemctl is-active "$service" 2>/dev/null || true)"
    echo "starts:       $([[ "$autostart" == yes ]] && echo "with the machine" || echo "only when started by hand")"
    echo "limits:       memory ${memory_max:-no limit}${memory_high:+ (slows down above $memory_high)}${memory_swap_max:+, swap $memory_swap_max}, processor ${cpu_quota:-no limit}${restart_limit:+, restarts stop after ${restart_limit%/*} failures in ${restart_limit#*/} s}"
  fi
  if (( ${#others[@]} )); then
    say "Other installations on this machine (not touched)"
    for f in "${others[@]}"; do describe "$f"; done
  fi
  exit 0
fi

# --uninstall: removes this installation's service, and nothing else.
if [[ "$mode" == uninstall ]]; then
  if [[ ! -f "$unit" ]]; then
    echo "There is no installed service '$service' ($unit), so there is nothing to remove."
    exit 0
  fi
  (( problems )) && exit 1
  # The Crucible's request checkpoint is on: Seerr's requests wait on a Radarr profile that never
  # downloads until Hearth sorts them. Removing Hearth from here skips the clean exit.
  if [[ -f "$data_dir/crucible-checkpoint.json" ]]; then
    echo ""
    echo "WARNING: Hearth's Crucible is holding Seerr's movie requests for you."
    echo "Removing Hearth from here leaves new requests on the Radarr profile"
    echo "\"Hearth · Waiting for the Crucible\", where nothing is ever downloaded for them."
    echo "Uninstall from inside Hearth instead (PCs > Uninstall): it hands them back first."
    echo "Or afterwards: in Seerr, turn \"Enable Automatic Search\" back on and pick your old"
    echo "profile; in Radarr, move any movies on that profile to another one and search them."
    echo ""
  fi
  say "${dry_run:+Dry run: }Removing the service '$service' only"
  echo "sudo systemctl stop $service"
  echo "sudo systemctl disable $service"
  echo "sudo rm $unit"
  echo "sudo systemctl daemon-reload"
  say "Kept (delete them yourself only if you are sure)"
  echo "data:    $data_dir"
  echo "key:     $key_dir   (without it, its backups cannot be opened)"
  echo "backups: $backup_dir"
  echo "project: $app_dir"
  if (( ${#others[@]} )); then
    say "Other installations on this machine (not touched)"
    for f in "${others[@]}"; do describe "$f"; done
  fi
  [[ -n "$dry_run" ]] && exit 0
  sudo systemctl stop "$service"
  sudo systemctl disable "$service" >/dev/null 2>&1 || true
  sudo rm -f "$unit"
  sudo systemctl daemon-reload
  echo
  echo "Removed the service '$service'. Running this installer again from $app_dir installs it again."
  exit 0
fi

# Running it again must not point an existing installation at an empty folder: with a new data
# folder it would start as a brand-new, unclaimed installation, and with a new key folder it could
# no longer open its vault. Moving is done by copying the folder first, which this then accepts.
moved_away() {
  local name="$1" file="$2" before
  before="$(installed "$name")"
  [[ -n "${!name:-}" && -n "$before" && "${!name}" != "$before" ]] || return 1
  [[ -e "$before/$file" && ! -e "${!name}/$file" ]]
}
if moved_away DC_DATA_DIR dragon-control.db; then
  echo "Stopped: this would move Hearth to an empty data folder, where it would start over as a new installation."
  echo "  To move it, stop the service, copy $(installed DC_DATA_DIR) to $DC_DATA_DIR, then run this again."
  echo "  To keep the current folder, leave DC_DATA_DIR out: running it again keeps the installed settings."
  problem
fi
if moved_away DC_KEY_DIR vault.key; then
  echo "Stopped: the new key folder has no vault key, so Hearth could not open its vault or backups."
  echo "  To move it, stop the service, copy $(installed DC_KEY_DIR) to $DC_KEY_DIR, then run this again."
  echo "  To keep the current folder, leave DC_KEY_DIR out."
  problem
fi
node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]] || (( $(node -p 'process.versions.node.split(".")[0]') < 24 )); then
  echo "Hearth needs Node.js 24 or newer. On Ubuntu or Homeserver:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs"
  problem
fi
# pnpm comes from Corepack, which Node.js 24 includes and Node.js 25 and newer leave out.
if [[ -z "$release" && -n "$node_bin" ]] && ! command -v pnpm >/dev/null && ! command -v corepack >/dev/null; then
  echo "pnpm is missing, and this Node.js has no Corepack to provide it. Install it with:"
  echo "  npm install -g pnpm@11"
  problem
fi
# The service is a systemd unit, and the check that it started uses curl.
if ! command -v systemctl >/dev/null; then
  echo "This machine has no systemd, so Hearth cannot be installed as a service here."
  echo "  To try it out instead: pnpm install && pnpm build && pnpm start"
  problem
fi
if ! command -v curl >/dev/null; then
  echo "curl is missing (it checks that Hearth started). Install it with:"
  echo "  sudo apt-get install -y curl"
  problem
fi
# A port already taken would make Hearth fail to start. Taken by this same installation is
# fine (this is an update); taken by anything else, another installation included, is not.
if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
  if [[ -f "$unit" && "$(installed DC_PORT)" == "$port" ]]; then
    echo "Note: '$service' is already installed on port $port; this updates it."
  else
    echo "Port $port is already used by another program. Choose another, for example: DC_PORT=7500"
    problem
  fi
fi
if ! id -nG "$user" | grep -qw docker; then
  echo "Note: $user is not in the docker group, so Hearth will not see containers."
  [[ "$user" == "$current_user" ]] && echo "      sudo usermod -aG docker $user   (then log out and in)"
fi
claude_bin=""
claude_private=""
if [[ "$user" == "$current_user" ]]; then
  claude_bin="$(command -v claude || true)"
  [[ -z "$claude_bin" && -x "$user_home/.local/bin/claude" ]] && claude_bin="$user_home/.local/bin/claude"
elif [[ -x "$user_home/.local/bin/claude" ]]; then
  claude_bin="$user_home/.local/bin/claude"
elif [[ -d "$user_home" && ! -x "$user_home" ]]; then
  # Its home folder is private to it, so only that account can look inside. The real install asks as
  # that account (it uses sudo anyway); a dry run never runs sudo, so it says it could not check.
  if [[ -z "$dry_run" ]] && sudo -n -u "$user" test -x "$user_home/.local/bin/claude" 2>/dev/null; then
    claude_bin="$user_home/.local/bin/claude"
  else
    claude_private=1
  fi
fi
if [[ -n "$claude_private" ]]; then
  echo "Note: $user's home folder is private, so this could not check for Claude Code there. Hearth looks for it in $user_home/.local/bin; the AI Agent page says whether it is installed and signed in."
elif [[ -z "$claude_bin" ]]; then
  echo "Note: the Claude Code CLI is not installed for $user, so Ember (the AI administrator) cannot work yet. Install it for $user and sign in as $user (see the AI Agent page for the commands)."
fi

# Optional settings, each quoted for systemd (values may hold spaces or apostrophes).
optional_env=""
add_env() { [[ -n "$2" ]] && optional_env+="Environment=\"$1=$2\""$'\n'; return 0; }
add_env DC_BACKUP_COPY_DIR "$backup_copy_dir"
add_env DC_OFFSITE_NAME "$offsite_name"
add_env DC_VOICE_HOST "$voice_host"
add_env DC_BACKUP_KEEP "$backup_keep"
add_env DC_CADDYFILE "$caddyfile"
add_env DC_SERVICE_BACKUP_DIR "$service_backup_dir"
add_env DC_HOST_DOCS "$host_docs"
add_env DC_HOMELAB_ROOTS "$homelab_roots"
add_env DC_COMPOSE_ROOT "$compose_root"
add_env DC_CLAUDE_PATH "$claude_bin"
[[ "$autostart" == no ]] && add_env DC_AUTOSTART no
limits=""
[[ -n "$memory_high" ]] && limits+="MemoryHigh=$memory_high"$'\n'
[[ -n "$memory_max" ]] && limits+="MemoryMax=$memory_max"$'\n'
[[ -n "$memory_swap_max" ]] && limits+="MemorySwapMax=$memory_swap_max"$'\n'
[[ -n "$cpu_quota" ]] && limits+="CPUQuota=$cpu_quota"$'\n'
# The address to check it answers on: the one it listens on, or this machine when it listens on all.
case "$host" in
  0.0.0.0 | :: | localhost | "") check_host=127.0.0.1 ;;
  *:*) check_host="[$host]" ;;
  *) check_host="$host" ;;
esac
description="Hearth"
[[ "$service" != "dragon-control" && "$service" != "hearth" ]] && description="Hearth ($service)"
start_limit=""
if [[ -n "$restart_limit" ]]; then
  # After this many failed starts in this window, systemd stops trying and leaves it stopped.
  start_limit="StartLimitIntervalSec=${restart_limit#*/}"$'\n'"StartLimitBurst=${restart_limit%/*}"$'\n'
fi
unit_file() {
  cat <<UNIT
[Unit]
Description=$description
Wants=network-online.target docker.service
After=network-online.target docker.service
${start_limit}
[Service]
Type=simple
User=$user
WorkingDirectory=$app_dir
Environment=NODE_ENV=production
Environment=DC_FIRST_START=empty
Environment=DC_PORT=$port
Environment=DC_HOST=$host
Environment="DC_DATA_DIR=$data_dir"
Environment="DC_KEY_DIR=$key_dir"
Environment="DC_BACKUP_DIR=$backup_dir"
$optional_env
Environment="PATH=$(dirname "${node_bin:-/usr/bin/node}"):$user_home/.local/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=${node_bin:-node} apps/server/dist/index.js
Restart=on-failure
RestartSec=5
# Stopping signals Hearth only, so an AI answer being written can finish (it waits up to a
# minute); anything left is stopped when Hearth exits.
KillMode=mixed
TimeoutStopSec=90
NoNewPrivileges=yes
ProtectSystem=full
PrivateTmp=yes
UMask=0077
${limits}
[Install]
WantedBy=multi-user.target
UNIT
}
run_as_text=""
[[ "$user" != "$current_user" ]] && run_as_text="sudo -u $user -H "
# The build runs at low priority, so the apps already on this machine stay responsive.
low=(nice -n 10)
command -v ionice >/dev/null && low+=(ionice -c 3)
nice_text="${low[*]} "

if [[ -n "$dry_run" ]]; then
  say "Dry run: nothing is changed"
  echo "installation: $service$([[ -f "$unit" ]] && echo " (installed: this updates it)" || echo " (new)")"
  echo "service file: $unit"
  echo "runs as:      $user"
  echo "app:          $app_dir"
  echo "commit:       $commit"
  echo "data:         $data_dir"
  echo "key:          $key_dir"
  echo "backups:      $backup_dir${backup_copy_dir:+ (second copy: $backup_copy_dir)}${offsite_name:+ (encrypted copies fetched by $offsite_name)}"
  echo "address:      http://$host:$port${voice_host:+ (voice servers: $voice_host)}"
  echo "starts:       $([[ "$autostart" == yes ]] && echo "when the machine starts" || echo "only when you start it (sudo systemctl start $service)")"
  echo "limits:       memory ${memory_max:-no limit}${memory_high:+ (slows down above $memory_high)}${memory_swap_max:+, swap $memory_swap_max}, processor ${cpu_quota:-no limit}${restart_limit:+, restarts stop after ${restart_limit%/*} failures in ${restart_limit#*/} s}"
  if (( ${#others[@]} )); then
    say "Other installations on this machine (not touched)"
    for f in "${others[@]}"; do describe "$f"; done
  fi
  say "It would run"
  if [[ -n "$release" ]]; then
    echo "nothing to build: release $release is already built (no pnpm needed)"
  else
    command -v corepack >/dev/null && echo "corepack enable                      (with sudo if needed)"
    echo "${run_as_text}${nice_text}pnpm install --frozen-lockfile"
    echo "${run_as_text}${nice_text}pnpm build"
  fi
  if [[ "$user" == "$current_user" ]]; then
    echo "mkdir -p and chmod 700: $data_dir $key_dir $backup_dir"
  else
    echo "sudo install -d -m 700 -o $user: $data_dir $key_dir $backup_dir"
  fi
  echo "sudo tee $unit"
  echo "sudo systemctl daemon-reload"
  if [[ "$autostart" == yes ]]; then echo "sudo systemctl enable $service"; else echo "sudo systemctl disable $service   (it does not start with the machine)"; fi
  echo "sudo systemctl restart $service   (once, to check it starts)"
  echo "then check http://$check_host:$port/api/health"
  say "Service file it would write"
  unit_file
  if (( problems )); then
    echo
    echo "Not ready: fix the problem above first."
    exit 1
  fi
  exit 0
fi

# If a step fails, say which one in plain words. Every step is safe to repeat, so the fix is to
# solve the problem shown and run this again.
step="starting"
trap 'echo; echo "Stopped while $step. Fix the problem above, then run this again: it is safe to repeat."' ERR
# Build output is kept out of the way, and shown only if that step fails.
log="$(mktemp)"
quiet() { "$@" >"$log" 2>&1 || { tail -n 40 "$log"; return 1; }; }

cd "$app_dir"
if [[ -n "$release" ]]; then
  say "Installing '$service' from release $release in $app_dir (commit $commit): already built"
  step="checking the release"
  [[ -f apps/server/dist/index.js && -f apps/web/dist/index.html && -d node_modules ]] || {
    echo "This release folder is incomplete (apps/server/dist, apps/web/dist, or node_modules is missing). Unpack the archive again."
    exit 1
  }
else
  say "Building '$service' in $app_dir (commit $commit)"
  step="turning on pnpm (corepack enable)"
  if command -v corepack >/dev/null; then corepack enable >/dev/null 2>&1 || sudo corepack enable; fi
  step="installing dependencies (pnpm install)"
  quiet as_user "${low[@]}" env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile
  step="building (pnpm build)"
  quiet as_user "${low[@]}" pnpm build
fi

say "Folders (owner only)"
step="creating the folders"
if [[ "$user" == "$current_user" ]]; then
  mkdir -p "$data_dir" "$key_dir" "$backup_dir"
  chmod 700 "$data_dir" "$key_dir" "$backup_dir"
else
  sudo install -d -m 700 -o "$user" -g "$(id -gn "$user")" "$data_dir" "$key_dir" "$backup_dir"
  # A folder the account cannot reach (a parent folder only its owner can open) would stop the
  # service on start; find that now.
  for d in "$data_dir" "$key_dir" "$backup_dir"; do
    if ! sudo -u "$user" test -w "$d"; then
      echo "$user cannot use $d: a folder above it does not let $user in. Choose a folder $user can reach."
      exit 1
    fi
  done
fi
echo "data:    $data_dir"
echo "key:     $key_dir"
echo "backups: $backup_dir${backup_copy_dir:+ (second copy: $backup_copy_dir)}${offsite_name:+ (encrypted copies fetched by $offsite_name)}"

say "Writing $unit"
step="writing and starting the service"
unit_file | sudo tee "$unit" >/dev/null
sudo systemctl daemon-reload
if [[ "$autostart" == yes ]]; then
  sudo systemctl enable "$service" >/dev/null 2>&1
else
  sudo systemctl disable "$service" >/dev/null 2>&1 || true
fi
sudo systemctl restart "$service"

say "Starting"
for _ in $(seq 1 60); do
  curl -sf "http://$check_host:$port/api/health" >/dev/null && break
  sleep 1
done
if ! curl -sf "http://$check_host:$port/api/health" >/dev/null; then
  echo "Hearth did not start. See why with: journalctl -u $service -n 50"
  echo "The service is installed; once the problem is fixed, run this again or: sudo systemctl restart $service"
  exit 1
fi
if [[ "$host" == "127.0.0.1" || "$host" == "localhost" ]]; then
  echo "Running '$service' on http://127.0.0.1:$port (this machine only), commit $commit."
else
  echo "Running '$service' on port $port for your home network (open http://<this machine's address>:$port), commit $commit."
fi
if [[ -f "$data_dir/setup-code.txt" ]] || as_user test -f "$data_dir/setup-code.txt" 2>/dev/null; then
  echo "Not claimed yet. Open: http://${check_host/127.0.0.1/localhost}:$port/setup?code=$(as_user cat "$data_dir/setup-code.txt")"
  echo "(Through Tailscale, use your https://<machine>.<tailnet>.ts.net address with the same ?code=.)"
fi
if [[ "$autostart" == no ]]; then
  echo "It does not start with the machine. Stop it when you are done: sudo systemctl stop $service"
  echo "Start it again later:                                      sudo systemctl start $service"
fi
if (( ${#others[@]} )); then
  # "tailscale serve --bg PORT" replaces what this machine already serves; another installation
  # may be using it.
  echo "Another installation is on this machine. Check 'tailscale serve status' before serving this one,"
  echo "and give it its own https port: sudo tailscale serve --bg --https=8443 $port"
else
  echo "To reach it from your phone over Tailscale: sudo tailscale serve --bg $port"
fi
rm -f "$log"
