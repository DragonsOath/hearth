#!/usr/bin/env bash
# Hearth in one command, on Linux. Downloads the newest Hearth release, brings its own Node.js 24
# when this machine has none, runs Hearth as your own service (it starts with the machine), and
# opens its setup page. Run it again any time to update: your data and settings are kept.
#
#     curl -fsSL https://raw.githubusercontent.com/DragonsOath/hearth/main/deploy/get.sh | bash
#   Joining a Hearth you already have (the command from its "Add a PC" has this in it):
#     ... | HEARTH_JOIN='http://192.168.1.10:7600/join?code=...' bash
#   From a downloaded copy:
#     bash get.sh [--dry-run | --uninstall]
#
# Everything lives in one folder (HEARTH_HOME, default ~/hearth): the app in app/, your data,
# vault key and backups beside it, and install.json saying how it was installed (so Hearth can
# also remove itself, from any of your devices). Hearth runs as a systemd user service, as you,
# never as root. The only sudo it may ask for, once, lets that service run while nobody is
# signed in (loginctl enable-linger).
#
# Settings (all optional): HEARTH_HOME, HEARTH_VERSION (like 0.29.0; default the newest),
# HEARTH_NETWORK=yes|no (open it to other devices on your home network), HEARTH_PORT (7600),
# HEARTH_SERVICE (the service's name, default hearth), HEARTH_JOIN (a join link),
# HEARTH_HELPER=yes|no (set up the small admin helper that lets Hearth's AI install Docker and
# Tailscale for your homelab plan, each time you approve; asked when not set).
set -euo pipefail

REPO="DragonsOath/hearth"
dry_run=""
uninstall=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --uninstall) uninstall=1 ;;
    *) echo "Unknown option: $arg (options: --dry-run, --uninstall)"; exit 2 ;;
  esac
done

say() { printf '\n\033[1;33m== %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }
# Questions read from the terminal, so they work when this script is piped into bash.
ask() {
  local question="$1" default="$2" answer=""
  # No terminal (run over plain ssh, or by a script): the default answer, quietly.
  { read -r -p "$question " answer </dev/tty; } 2>/dev/null || true
  echo "${answer:-$default}"
}

[[ "$(uname -s)" == Linux ]] || fail "This installer is for Linux. On Windows, use deploy/get.ps1."
[[ "$(id -u)" != 0 ]] || fail "Run this as your everyday account, not root."
command -v systemctl >/dev/null || fail "Hearth needs systemd to run as a service, and this machine does not have it."

home="${HEARTH_HOME:-$HOME/hearth}"
app="$home/app"
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
service="${HEARTH_SERVICE:-}"
if [[ -z "$service" && -f "$home/install.json" ]]; then
  service="$(sed -n 's/.*"service": *"\([^"]*\)".*/\1/p' "$home/install.json")"
fi
service="${service:-hearth}"

# --- Removing it: the service, then (only if you say so) its folder ----------------------------
if [[ -n "$uninstall" ]]; then
  # The Crucible's request checkpoint is on: Seerr's requests wait on a Radarr profile that never
  # downloads until Hearth sorts them. Removing Hearth from here skips the clean exit.
  if [[ -f "${DC_DATA_DIR:-$home/data}/crucible-checkpoint.json" ]]; then
    echo ""
    echo "WARNING: Hearth's Crucible is holding Seerr's movie requests for you."
    echo "Removing Hearth from here leaves new requests on the Radarr profile"
    echo "\"Hearth · Waiting for the Crucible\", where nothing is ever downloaded for them."
    echo "Uninstall from inside Hearth instead (PCs > Uninstall): it hands them back first."
    echo "Or afterwards: in Seerr, turn \"Enable Automatic Search\" back on and pick your old"
    echo "profile; in Radarr, move any movies on that profile to another one and search them."
    echo ""
  fi
  [[ -d "$home" ]] || fail "Hearth is not installed in $home."
  say "Removing Hearth"
  systemctl --user disable --now "$service" 2>/dev/null || true
  rm -f "$units/$service.service"
  systemctl --user daemon-reload
  # Its app menu entry and desktop icon.
  data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
  rm -f "$data_home/applications/$service.desktop" "$data_home/icons/$service.png" \
    "$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")/$service.desktop"
  echo "Stopped Hearth and removed its service ($service) and its app icon."
  echo
  echo "Your Hearth folder is still here: $home (your settings, vault, backups, and the app)."
  case "$(ask "Delete it too? This cannot be undone. [y/N]" n)" in
    [yY]*) rm -rf "$home" && echo "Deleted $home." ;;
    *) echo "Kept $home. Running the installer again brings Hearth back with everything in it." ;;
  esac
  exit 0
fi

for tool in curl tar sha256sum; do
  command -v "$tool" >/dev/null || fail "Hearth's installer needs '$tool'. Install it (for example: sudo apt install $tool) and run this again."
done
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

say "Hearth installer"
echo "Hearth goes in:  $home"
update=""
if [[ -f "$app/RELEASE" ]]; then
  update=1
  echo "Already installed: $(sed -n 's/^version=//p' "$app/RELEASE"). This updates it, keeping your data and settings."
fi

# --- Node.js 24 ---------------------------------------------------------------------------------
node_ok() { command -v node >/dev/null && (($(node -p 'process.versions.node.split(".")[0]') >= 24)); }
own_node="$home/node"
[[ -x "$own_node/bin/node" ]] && export PATH="$own_node/bin:$PATH"
if ! node_ok; then
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "No Node.js 24 for this processor ($(uname -m)). Install Node.js 24 yourself, then run this again." ;;
  esac
  say "Getting Node.js 24 (just for Hearth, in $own_node)"
  base="https://nodejs.org/dist/latest-v24.x"
  curl -fsSL "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
  file="$(grep -o "node-v24[0-9.]*-linux-$arch.tar.xz" "$work/SHASUMS256.txt" | head -1)"
  [[ -n "$file" ]] || fail "Could not find Node.js 24 for linux-$arch on nodejs.org."
  curl -fsSL "$base/$file" -o "$work/$file"
  (cd "$work" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -) || fail "The Node.js download did not match its checksum; nothing was installed."
  if [[ -z "$dry_run" ]]; then
    mkdir -p "$own_node"
    tar -xJf "$work/$file" -C "$own_node" --strip-components=1
    export PATH="$own_node/bin:$PATH"
  else
    echo "(dry run: would unpack $file into $own_node)"
  fi
fi
node_ok || [[ -n "$dry_run" ]] || fail "Node.js 24 is still missing."
command -v node >/dev/null && echo "Node.js $(node -v)"

# --- The release ----------------------------------------------------------------------------------
say "Downloading Hearth"
version="${HEARTH_VERSION:-}"
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  if [[ -z "$version" ]]; then
    # The highest version (the list is in the order releases were made): Hearth releases only
    # (other releases, like the voices, have other names), never a draft.
    tag="$(gh release list -R "$REPO" --limit 100 --json tagName,isDraft -q '.[] | select((.isDraft | not) and (.tagName | test("^v[0-9]+[.][0-9]+[.][0-9]+$"))) | .tagName' | sort -V | tail -1)"
  else
    tag="v${version#v}"
  fi
  [[ -n "$tag" ]] || fail "No Hearth release found on GitHub yet."
  gh release download "$tag" -R "$REPO" -p 'hearth-*-linux.tar.gz*' -D "$work"
else
  # A public repository needs no sign-in.
  api="https://api.github.com/repos/$REPO/releases/${version:+tags/v${version#v}}"
  [[ -n "$version" ]] || api="${api}latest"
  urls="$(curl -fsSL "$api" 2>/dev/null | grep -o '"browser_download_url": *"[^"]*linux.tar.gz[^"]*"' | cut -d'"' -f4 || true)"
  [[ -n "$urls" ]] || fail "Could not download Hearth. Check this machine can reach github.com, then run this again."
  for u in $urls; do curl -fsSL "$u" -o "$work/$(basename "$u")"; done
fi
archive="$(ls "$work"/hearth-*-linux.tar.gz | head -1)"
(cd "$work" && sha256sum -c --quiet "$(basename "$archive").sha256") || fail "The download did not match its checksum; nothing was installed."
tar -xzf "$archive" -C "$work"
fresh="$(find "$work" -maxdepth 1 -type d -name 'hearth-*-linux' | head -1)"
echo "Hearth $(sed -n 's/^version=//p' "$fresh/RELEASE")"

# --- Settings: kept on an update; a new install asks one question --------------------------------
envfile="$home/hearth.env"
if [[ -z "$update" || ! -f "$envfile" ]]; then
  network="${HEARTH_NETWORK:-}"
  if [[ -z "$network" ]]; then
    if [[ -n "${HEARTH_JOIN:-}" ]]; then
      # A PC joining your Hearth dials out to it; nothing needs to reach this PC.
      network=no
    else
      say "One question"
      echo "Open Hearth to your other devices (phone, laptop) on your home network?"
      echo "No keeps it to this computer only. You can change it later."
      case "$(ask "Open to your home network? [Y/n]" y)" in [nN]*) network=no ;; *) network=yes ;; esac
    fi
  fi
  port="${HEARTH_PORT:-7600}"
  # Another program already on that port: take the next free one.
  while (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; do port=$((port + 1)); done
  host=127.0.0.1
  [[ "$network" == yes ]] && host=0.0.0.0
else
  port="$(sed -n 's/^DC_PORT=//p' "$envfile")"
fi

if [[ -n "$dry_run" ]]; then
  echo "(dry run: would put Hearth in $app, run it as the user service '$service' on port ${port:-?},"
  echo " keep its data in $home/data, and start it now and with the machine)"
  exit 0
fi

# --- Install ----------------------------------------------------------------------------------------
say "Installing"
mkdir -p "$home/data" "$home/keys" "$home/backups" "$units"
chmod 700 "$home/data" "$home/keys" "$home/backups"
systemctl --user stop "$service" 2>/dev/null || true
rm -rf "$home/app.previous"
[[ -d "$app" ]] && mv "$app" "$home/app.previous"
mv "$fresh" "$app"

if [[ -z "$update" || ! -f "$envfile" ]]; then
  claude_path="$(command -v claude || true)"
  [[ -z "$claude_path" && -x "$HOME/.local/bin/claude" ]] && claude_path="$HOME/.local/bin/claude"
  cat >"$envfile" <<ENV
NODE_ENV=production
DC_FIRST_START=empty
DC_HOST=$host
DC_PORT=$port
DC_DATA_DIR=$home/data
DC_KEY_DIR=$home/keys
DC_BACKUP_DIR=$home/backups
${claude_path:+DC_CLAUDE_PATH=$claude_path}
ENV
  chmod 600 "$envfile"
fi
cat >"$home/install.json" <<JSON
{ "kind": "linux-user-service", "home": "$home", "service": "$service" }
JSON
# A join link from your Hearth's "Add a PC": Hearth joins with it when it starts.
if [[ -n "${HEARTH_JOIN:-}" ]]; then
  printf '%s\n' "$HEARTH_JOIN" >"$home/data/join-link"
  chmod 600 "$home/data/join-link"
fi

node_bin="$(command -v node)"
cat >"$units/$service.service" <<UNIT
[Unit]
Description=Hearth ($service)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$app
EnvironmentFile=$envfile
Environment="PATH=$(dirname "$node_bin"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=$node_bin apps/server/dist/index.js
Restart=on-failure
RestartSec=5
# Stopping signals Hearth only, so an answer being written can finish (up to a minute).
KillMode=mixed
TimeoutStopSec=90

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable "$service" >/dev/null 2>&1
systemctl --user restart "$service"

# Keep running while nobody is signed in (a server, or after a restart): once per account.
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]]; then
  if ! loginctl enable-linger "$USER" 2>/dev/null; then
    echo "So Hearth also runs when nobody is signed in, it asks for your password once:"
    sudo loginctl enable-linger "$USER" || echo "Skipped: Hearth runs while you are signed in."
  fi
fi

say "Starting"
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$port/api/health" >/dev/null && break
  sleep 1
done
if ! curl -sf "http://127.0.0.1:$port/api/health" >/dev/null; then
  journalctl --user -u "$service" -n 30 --no-pager 2>/dev/null || true
  if [[ -d "$home/app.previous" ]]; then
    systemctl --user stop "$service" || true
    rm -rf "$app"
    mv "$home/app.previous" "$app"
    systemctl --user restart "$service" || true
    echo "Put the previous version back and started it."
  fi
  fail "Hearth did not start. The messages above say why."
fi
rm -rf "$home/app.previous"

# --- The admin helper: lets Ember install Docker and Tailscale for your plan, each time you approve.
# Hearth itself never runs as root; the helper does one approved, fixed task at a time
# (docs/ELEVATED_EXECUTOR.md). Asked once; run this installer again to be asked again.
helper_cfg=/etc/hearth/elevation.json
if [[ -z "$dry_run" && -z "${HEARTH_JOIN:-}" ]] && ! grep -qs '"docker.install"' "$helper_cfg"; then
  want="${HEARTH_HELPER:-}"
  if [[ -z "$want" ]]; then
    echo
    echo "Hearth's AI can install Docker and Tailscale for your homelab plan, asking you each time."
    echo "That needs a small admin helper, set up now with your password (once)."
    if { true </dev/tty; } 2>/dev/null; then want="$(ask "Set up the admin helper? [Y/n]" yes)"
    else want=skip; fi
  fi
  case "$want" in
    [Yy]*|"")
      if [[ -f "$helper_cfg" ]]; then helper_args=(--add-operation build)
      else helper_args=(--operations docker.install,tailscale.install); fi
      sudo bash "$app/deploy/linux/install-elevation.sh" --service "$service" --user-service "${helper_args[@]}"         || echo "The admin helper was not set up. Hearth works without it; its plan page shows how to add it later."
      ;;
    skip) echo "Skipped the admin helper (no terminal to ask in). Hearth's plan page shows how to add it." ;;
    *) echo "Skipped the admin helper. Hearth's plan page shows how to add it later." ;;
  esac
fi
if ! id -nG | grep -qw docker && command -v docker >/dev/null; then
  echo "Note: your account is not in the docker group, so Hearth can't see your containers yet."
  echo "To let it: sudo usermod -aG docker $USER, then sign out and back in, then: systemctl --user restart $service"
fi

# --- The Hearth app: its own window (no tabs or address bar), from the app menu and the desktop ----
# A joined PC opens your main Hearth, where its projects and systems are.
app_url="http://localhost:$port"
if [[ -n "${HEARTH_JOIN:-}" ]]; then
  app_url="$(printf '%s' "$HEARTH_JOIN" | sed -E 's#^(https?://[^/]+).*#\1#')"
elif [[ -f "$home/app-url" ]]; then
  app_url="$(cat "$home/app-url")"
fi
printf '%s\n' "$app_url" >"$home/app-url"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
mkdir -p "$data_home/applications" "$data_home/icons"
cp "$app/apps/web/dist/icon-512.png" "$data_home/icons/$service.png" 2>/dev/null || true
cat >"$home/open-hearth" <<'OPEN'
#!/usr/bin/env bash
# Opens Hearth in its own window, in the first Chromium-family browser found; else the default one.
# Its own browser profile makes it its own app: the taskbar shows Hearth's icon (it can be pinned)
# instead of filing the window under the browser. Signing in there is remembered there.
dir="$(dirname "$(readlink -f "$0")")"
url="$(cat "$dir/app-url")"
for b in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge microsoft-edge-stable brave-browser; do
  command -v "$b" >/dev/null && exec "$b" --user-data-dir="$dir/app-window" --no-first-run --no-default-browser-check --autoplay-policy=no-user-gesture-required --class=Hearth --app="$url"
done
exec xdg-open "$url"
OPEN
chmod +x "$home/open-hearth"
cat >"$data_home/applications/$service.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Hearth
Comment=Your homelab, with Ember
Exec=$home/open-hearth
Icon=$data_home/icons/$service.png
Terminal=false
Categories=System;Network;
StartupWMClass=Hearth
DESKTOP
desktop_dir="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
if [[ -d "$desktop_dir" ]]; then
  cp "$data_home/applications/$service.desktop" "$desktop_dir/$service.desktop"
  chmod +x "$desktop_dir/$service.desktop"
  gio set "$desktop_dir/$service.desktop" metadata::trusted true 2>/dev/null || true
fi
update-desktop-database "$data_home/applications" 2>/dev/null || true
echo "Hearth is in your app menu$([[ -d "$desktop_dir" ]] && echo " and on your desktop"): it opens in its own window."

# --- Done ---------------------------------------------------------------------------------------------
if [[ -n "${HEARTH_JOIN:-}" ]]; then
  for _ in $(seq 1 20); do
    [[ -f "$home/data/join-link" ]] || break
    sleep 1
  done
  say "Hearth is installed and joined your Hearth."
  echo "This PC now shows up there, under PCs and devices. Use Hearth from there, on any device."
elif [[ -f "$home/data/setup-code.txt" ]]; then
  link="http://localhost:$port/setup?code=$(cat "$home/data/setup-code.txt")"
  say "Hearth is running. Finish setting it up here:"
  printf '\n    %s\n\n' "$link"
  if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v xdg-open >/dev/null; then
    xdg-open "$link" >/dev/null 2>&1 || true
  fi
else
  say "Hearth is updated and running. Sign in as usual."
fi
echo "Remove it later with: bash $app/deploy/get.sh --uninstall"
