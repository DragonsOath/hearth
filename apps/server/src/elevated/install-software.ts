/**
 * Installing Docker and Tailscale for a beginner's homelab plan (docs/design/BUILDER.md). Two fixed
 * operations of the elevated executor: no parameters come from the request (the account they are
 * for is the scope file's serviceUser, written by root at setup), and each runs one reviewed script
 * from its vendor's own package repository, never a downloaded script.
 *
 * Package managers write all over the system, so the script runs outside the executor's sandbox
 * through systemd-run (as the RAID operations' long jobs do), and reports back with a closing
 * "HEARTH-OK" line that the executor reads before saying it worked.
 *
 * Node built-ins only: the executor ships as one file.
 */

export interface InstallDeps {
  run(
    cmd: string,
    args: string[],
    opts?: { input?: string; timeoutMs?: number },
  ): Promise<{ code: number; out: string }>;
}

export class InstallRefused extends Error {}
export class InstallFailed extends Error {}

/** A Linux account name, as useradd allows it. */
const ACCOUNT = /^[a-z_][a-z0-9_-]{0,31}$/;

/** Which family of distribution, from /etc/os-release, and the release to ask the repository for. */
const DETECT = `
. /etc/os-release
like=" \${ID:-} \${ID_LIKE:-} "
family=""
case "$like" in
  *" ubuntu "*) family=ubuntu; codename="\${UBUNTU_CODENAME:-\${VERSION_CODENAME:-}}" ;;
  *" debian "*) family=debian; codename="\${DEBIAN_CODENAME:-\${VERSION_CODENAME:-}}" ;;
  *" fedora "*) family=fedora ;;
esac
[[ -n "$family" ]] || { echo "HEARTH-UNSUPPORTED \${PRETTY_NAME:-this system}"; exit 3; }
if [[ "$family" != fedora && -z "\${codename:-}" ]]; then echo "HEARTH-UNSUPPORTED \${PRETTY_NAME:-this system} (no release name)"; exit 3; fi
export DEBIAN_FRONTEND=noninteractive
`;

/**
 * Docker Engine and Compose from Docker's own repository (docs.docker.com/engine/install), then:
 * the service on at boot, the account in the docker group, and (because Hearth's service started
 * before that group was theirs) the account allowed on Docker's socket now and at every start.
 */
const DOCKER_SCRIPT = `set -euo pipefail
user="$1"
${DETECT}
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  echo "Docker and Compose were already installed."
elif [[ "$family" == fedora ]]; then
  dnf -y -q install dnf-plugins-core
  dnf config-manager addrepo --from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo 2>/dev/null \
    || dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
  dnf -y -q install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin acl
else
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl acl >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$family/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$family $codename stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
command -v setfacl >/dev/null || { if [[ "$family" == fedora ]]; then dnf -y -q install acl; else apt-get install -y -qq acl >/dev/null; fi; }
systemctl enable --now docker.socket docker.service >/dev/null
getent group docker >/dev/null || groupadd docker
usermod -aG docker "$user"
mkdir -p /etc/systemd/system/docker.socket.d
cat > /etc/systemd/system/docker.socket.d/hearth.conf <<CONF
# Written by Hearth's elevated executor: lets $user (Hearth's account) use Docker without signing out first.
[Socket]
ExecStartPost=/usr/bin/setfacl -m u:$user:rw /run/docker.sock
CONF
systemctl daemon-reload
setfacl -m "u:$user:rw" /run/docker.sock
server="$(docker version --format '{{.Server.Version}}')"
compose="$(docker compose version --short)"
echo "HEARTH-OK docker $server compose $compose"
`;

/**
 * Tailscale from its own repository (pkgs.tailscale.com), its service on at boot, and the account
 * made its operator, so Hearth (not root) asks it for the sign-in link and the owner signs in.
 */
const TAILSCALE_SCRIPT = `set -euo pipefail
user="$1"
${DETECT}
if command -v tailscale >/dev/null; then
  echo "Tailscale was already installed."
elif [[ "$family" == fedora ]]; then
  dnf -y -q install dnf-plugins-core
  dnf config-manager addrepo --from-repofile=https://pkgs.tailscale.com/stable/fedora/tailscale.repo 2>/dev/null \
    || dnf config-manager --add-repo https://pkgs.tailscale.com/stable/fedora/tailscale.repo
  dnf -y -q install tailscale
else
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl >/dev/null
  curl -fsSL "https://pkgs.tailscale.com/stable/$family/$codename.noarmor.gpg" -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  curl -fsSL "https://pkgs.tailscale.com/stable/$family/$codename.tailscale-keyring.list" -o /etc/apt/sources.list.d/tailscale.list
  apt-get update -qq
  apt-get install -y -qq tailscale >/dev/null
fi
systemctl enable --now tailscaled >/dev/null
for i in $(seq 1 20); do tailscale status >/dev/null 2>&1 && break; tailscale status 2>&1 | grep -Eqi "logged out|needslogin|stopped" && break; sleep 1; done
tailscale set --operator="$user"
echo "HEARTH-OK tailscale $(tailscale version | head -1)"
`;

async function runOutside(deps: InstallDeps, what: string, script: string, user: string) {
  const args = [
    "--wait",
    "--pipe",
    "--collect",
    "--quiet",
    `--description=Hearth: install ${what}`,
    "/bin/bash",
    "-c",
    script,
    "hearth-install",
    user,
  ];
  let r = await deps.run("systemd-run", args, { timeoutMs: 840_000 });
  // No systemd (tests): the script directly.
  if (r.code === 127) r = await deps.run("/bin/bash", ["-c", script, "hearth-install", user]);
  const out = r.out.trim();
  const unsupported = /^HEARTH-UNSUPPORTED (.*)$/m.exec(out);
  if (unsupported)
    throw new InstallRefused(
      `Hearth installs ${what} on Ubuntu, Debian and Fedora (and systems built on them, like Linux Mint, Pop!_OS and Zorin OS). This computer runs ${unsupported[1]}.`,
    );
  const ok = /^HEARTH-OK (.*)$/m.exec(out);
  if (r.code !== 0 || !ok)
    throw new InstallFailed(
      `Installing ${what} did not finish: ${out.slice(-600) || `exit ${r.code}`}`,
    );
  return { ok: ok[1]!, before: /already installed/i.test(out) };
}

function account(user: string | undefined): string {
  if (!user || !ACCOUNT.test(user) || user === "root")
    throw new InstallRefused(
      "The executor's scope does not name Hearth's account (serviceUser), so it cannot install for it. Set the executor up again with install-elevation.sh.",
    );
  return user;
}

export async function dockerInstall(
  params: Record<string, unknown>,
  deps: InstallDeps,
  serviceUser: string | undefined,
) {
  if (Object.keys(params).length) throw new InstallRefused("Installing Docker takes no settings.");
  const user = account(serviceUser);
  const r = await runOutside(deps, "Docker", DOCKER_SCRIPT, user);
  const [, server, , compose] = r.ok.split(" ");
  return {
    target: "docker",
    result: `${r.before ? "Docker was already installed" : "Installed Docker"} (Engine ${server}, Compose ${compose}), started it, and let ${user} use it.`,
    data: { server, compose },
  };
}

export async function tailscaleInstall(
  params: Record<string, unknown>,
  deps: InstallDeps,
  serviceUser: string | undefined,
) {
  if (Object.keys(params).length)
    throw new InstallRefused("Installing Tailscale takes no settings.");
  const user = account(serviceUser);
  const r = await runOutside(deps, "Tailscale", TAILSCALE_SCRIPT, user);
  return {
    target: "tailscale",
    result: `${r.before ? "Tailscale was already installed" : "Installed Tailscale"} (${r.ok.replace(/^tailscale /, "")}), started it, and made ${user} its operator so Hearth can ask for the sign-in link.`,
    data: { version: r.ok.replace(/^tailscale /, "") },
  };
}

/** For tests: the scripts as written. */
export const SCRIPTS = { docker: DOCKER_SCRIPT, tailscale: TAILSCALE_SCRIPT };
