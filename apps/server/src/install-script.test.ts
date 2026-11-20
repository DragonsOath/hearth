import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "./config";

/**
 * deploy/linux/install.sh, driven the way an AI agent drives it: a dry run first, which must
 * change nothing and show exactly what would happen. The machine is faked with small stand-in
 * programs on PATH (node, id, and ones that record if anything tried to install or use sudo).
 */

const SCRIPT = path.join(SERVER_ROOT, "../../deploy/linux/install.sh");
const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function machine(
  opts: {
    node?: number;
    uid?: number;
    docker?: boolean;
    claude?: boolean;
    /** No pnpm and no Corepack (Node.js 25 and newer leave Corepack out). */
    noPnpm?: boolean;
    /** pnpm fails at this command ("build"), printing an error. */
    pnpmFails?: string;
    /** Who owns the project folder (stat -c %U). */
    owner?: string;
  } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "dc-install-"));
  cleanup.push(root);
  const bin = path.join(root, "bin");
  const ran = path.join(root, "ran.log");
  const stub = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  mkdirSync(bin);
  stub("node", `echo ${opts.node ?? 24}`);
  stub(
    "id",
    `case "$1" in -un) echo alex ;; -u) echo ${opts.uid ?? 1000} ;; -gn) echo "\${2:-alex}" ;; -nG) if [[ -n "$2" && "$2" != alex ]]; then echo "$2"; else echo "alex${opts.docker === false ? "" : " docker"}"; fi ;; esac`,
  );
  // Accounts on this pretend machine: alex (you), hearth (a dedicated account), and root.
  stub(
    "getent",
    `case "$2" in alex) echo "alex:x:1000:1000::/home/alex:/bin/bash" ;; hearth) echo "hearth:x:1001:1001::/home/hearth:/bin/bash" ;; svc) echo "svc:x:1002:1002::${root}/home/svc:/usr/sbin/nologin" ;; root) echo "root:x:0:0::/root:/bin/bash" ;; *) exit 2 ;; esac`,
  );
  stub(
    "stat",
    `if [[ -n "$FOREIGN" && "$3" == "$FOREIGN" ]]; then echo homeuser; else echo ${opts.owner ?? "alex"}; fi`,
  );
  if (opts.claude !== false) stub("claude", "echo 2.0.0");
  // Anything that would change the machine records itself instead.
  for (const name of ["sudo", "systemctl", "curl", ...(opts.noPnpm ? [] : ["pnpm", "corepack"])])
    stub(name, `echo "${name} $*" >> "${ran}"`);
  // sudo tee takes the service file it is given, as the real one would (keeping it for the test).
  stub(
    "sudo",
    `echo "sudo $*" >> "${ran}"; [[ "$1" == "tee" ]] && cat > "${root}/written.service"; true`,
  );
  if (opts.pnpmFails)
    stub(
      "pnpm",
      `echo "pnpm $*" >> "${ran}"; [[ "$1" == "${opts.pnpmFails}" ]] && { echo "error: it broke"; exit 1; }; true`,
    );
  // Only the everyday tools the script uses, so a pnpm elsewhere on this computer is not found.
  const sys = path.join(root, "sys");
  mkdirSync(sys);
  for (const tool of [
    "bash",
    "mkdir",
    "chmod",
    "rm",
    "sed",
    "tail",
    "grep",
    "dirname",
    "mktemp",
    "seq",
    "cat",
    "env",
    "sleep",
    "nice",
    "basename",
    "cut",
  ]) {
    const found = ["/usr/bin", "/bin"].map((d) => path.join(d, tool)).find((f) => existsSync(f));
    if (found) symlinkSync(found, path.join(sys, tool));
  }
  return { root, bin, sys, ran };
}

/** A port nothing on this computer listens on, so the script's "port in use" check stays quiet. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** The project folder the script installs from (it works it out from its own location). */
const APP_DIR = path.resolve(SERVER_ROOT, "../..");

/** A service file as the installer writes it, for an installation already on the machine. */
function unitText(o: {
  dir: string;
  port: string;
  data: string;
  user?: string;
  extra?: string[];
}): string {
  return [
    "[Unit]",
    "Description=Hearth",
    "[Service]",
    `User=${o.user ?? "alex"}`,
    `WorkingDirectory=${o.dir}`,
    `Environment=DC_PORT=${o.port}`,
    `Environment="DC_DATA_DIR=${o.data}"`,
    `Environment="DC_KEY_DIR=${o.data}"`,
    `Environment="DC_BACKUP_DIR=${o.data}/backups"`,
    ...(o.extra ?? []),
    "ExecStart=/usr/bin/node apps/server/dist/index.js",
  ].join("\n");
}

/** Production, as it is on the owner's server: installed from another folder, on port 7400. */
function production(m: ReturnType<typeof machine>): { file: string; text: string } {
  const file = path.join(m.root, "dragon-control.service");
  const text = unitText({ dir: "/srv/prod/dragon-control", port: "7400", data: "/srv/prod/data" });
  writeFileSync(file, text);
  return { file, text };
}

const PREVIEW = {
  DC_SERVICE_NAME: "hearth-preview",
  DC_SERVICE_USER: "hearth",
  DC_AUTOSTART: "no",
  DC_MEMORY_MAX: "1G",
  DC_MEMORY_HIGH: "768M",
  DC_MEMORY_SWAP_MAX: "0",
  DC_CPU_QUOTA: "100%",
};

async function run(
  m: ReturnType<typeof machine>,
  env: Record<string, string> = {},
  args = ["--dry-run"],
  script = SCRIPT,
): Promise<{ code: number; out: string; port: string }> {
  const port = env.DC_PORT ?? String(await freePort());
  return new Promise((resolve) => {
    execFile(
      "bash",
      [script, ...args],
      {
        env: {
          PATH: `${m.bin}:${m.sys}`,
          HOME: m.root,
          DC_INSTALL_UNIT_DIR: m.root,
          DC_DATA_DIR: path.join(m.root, "data"),
          ...env,
          DC_PORT: port,
        },
      },
      (error, stdout, stderr) =>
        resolve({ code: error ? Number(error.code ?? 1) : 0, out: stdout + stderr, port }),
    );
  });
}

// A Linux installer: it is not run on Windows, where the project is sometimes developed.
describe.skipIf(process.platform === "win32")("install.sh", () => {
  it("shows the settings, every command, and the service file, and changes nothing", async () => {
    const m = machine();
    const { code, out, port } = await run(m, {
      DC_KEY_DIR: path.join(m.root, "keys"),
      DC_BACKUP_DIR: path.join(m.root, "backups"),
      DC_VOICE_HOST: "192.168.1.50",
      DC_BACKUP_KEEP: "30",
      DC_CADDYFILE: "/srv/homelab/docker/compose/caddy/Caddyfile",
    });
    expect(code, out).toBe(0);
    expect(out).toContain("Dry run: nothing is changed");
    expect(out).toContain(`data:         ${path.join(m.root, "data")}`);
    expect(out).toContain(`address:      http://127.0.0.1:${port} (voice servers: 192.168.1.50)`);
    expect(out).toContain('Environment="DC_BACKUP_KEEP=30"');
    expect(out).toContain('Environment="DC_CADDYFILE=/srv/homelab/docker/compose/caddy/Caddyfile"');
    for (const step of ["pnpm build", "sudo systemctl restart dragon-control", "/api/health"])
      expect(out).toContain(step);
    expect(out).toContain("Environment=DC_HOST=127.0.0.1");
    expect(out).toContain('Environment="DC_VOICE_HOST=192.168.1.50"');
    expect(out).toMatch(/Environment="DC_CLAUDE_PATH=.*claude"/);
    // Nothing ran, nothing was written.
    expect(existsSync(m.ran)).toBe(false);
    expect(existsSync(path.join(m.root, "data"))).toBe(false);
    expect(existsSync(path.join(m.root, "dragon-control.service"))).toBe(false);
  });

  it("can serve the whole home network when the person chooses it", async () => {
    const m = machine();
    const port = String(await freePort());
    const { code, out } = await run(m, { DC_HOST: "0.0.0.0", DC_PORT: port });
    expect(code, out).toBe(0);
    expect(out).toContain("Environment=DC_HOST=0.0.0.0");
    expect(out).toContain(`Environment=DC_PORT=${port}`);
  });

  it("keeps the settings of an earlier install and says what would change", async () => {
    const m = machine();
    writeFileSync(
      path.join(m.root, "dragon-control.service"),
      [
        "[Service]",
        "Environment=DC_PORT=7400",
        'Environment="DC_BACKUP_DIR=/srv/homelab/backups/dragon-control"',
        'Environment="DC_VOICE_HOST=voice.example.com"',
        'Environment="DC_CADDYFILE=/srv/homelab/docker/compose/caddy/Caddyfile"',
      ].join("\n"),
    );
    const port = String(await freePort());
    const { code, out } = await run(m, { DC_PORT: port });
    expect(code, out).toBe(0);
    expect(out).toContain(`Note: DC_PORT changes from '7400' to '${port}'.`);
    expect(out).toContain('Environment="DC_BACKUP_DIR=/srv/homelab/backups/dragon-control"');
    expect(out).toContain('Environment="DC_VOICE_HOST=voice.example.com"');
    expect(out).toContain('Environment="DC_CADDYFILE=/srv/homelab/docker/compose/caddy/Caddyfile"');
  });

  it("says plainly what is missing, and is not ready without Node.js 24", async () => {
    const m = machine({ node: 22, docker: false, claude: false });
    const { code, out } = await run(m);
    expect(code).toBe(1);
    expect(out).toContain("Hearth needs Node.js 24 or newer");
    expect(out).toContain("alex is not in the docker group");
    expect(out).toContain("the Claude Code CLI is not installed for alex");
    expect(out).toContain("Not ready: fix the problem above first.");
    expect(existsSync(m.ran)).toBe(false);
  });

  it("refuses to install for root, even as a dry run", async () => {
    const m = machine({ uid: 0 });
    const { code, out } = await run(m);
    expect(code).toBe(1);
    expect(out).toContain("not root");
  });

  it("stops on a real install when Node.js is too old, before touching anything", async () => {
    const m = machine({ node: 20 });
    const { code, out } = await run(m, {}, []);
    expect(code).toBe(1);
    expect(out).toContain("needs Node.js 24");
    expect(existsSync(m.ran)).toBe(false);
  });

  it("does not point an existing installation at an empty data or key folder", async () => {
    const m = machine();
    const old = path.join(m.root, "old");
    mkdirSync(old);
    writeFileSync(path.join(old, "dragon-control.db"), "");
    writeFileSync(path.join(old, "vault.key"), "");
    writeFileSync(
      path.join(m.root, "dragon-control.service"),
      ["[Service]", `Environment="DC_DATA_DIR=${old}"`, `Environment="DC_KEY_DIR=${old}"`].join(
        "\n",
      ),
    );
    const fresh = path.join(m.root, "new");
    const dry = await run(m, { DC_DATA_DIR: fresh, DC_KEY_DIR: fresh });
    expect(dry.code).toBe(1);
    expect(dry.out).toContain("would move Hearth to an empty data folder");
    expect(dry.out).toContain("the new key folder has no vault key");
    expect(dry.out).toContain("Not ready");
    const real = await run(m, { DC_DATA_DIR: fresh, DC_KEY_DIR: fresh }, []);
    expect(real.code).toBe(1);
    expect(existsSync(m.ran)).toBe(false);
    // Once the folder has been copied over, moving is fine.
    mkdirSync(fresh);
    writeFileSync(path.join(fresh, "dragon-control.db"), "");
    writeFileSync(path.join(fresh, "vault.key"), "");
    const moved = await run(m, { DC_DATA_DIR: fresh, DC_KEY_DIR: fresh });
    expect(moved.code, moved.out).toBe(0);
    expect(moved.out).toContain(`Note: DC_DATA_DIR changes from '${old}' to '${fresh}'.`);
    // Left out, the installed folders are kept.
    const kept = await run(m, { DC_DATA_DIR: "" });
    expect(kept.code, kept.out).toBe(0);
    expect(kept.out).toContain(`data:         ${old}`);
  });

  it("finds a missing pnpm before installing (Node.js 25 and newer have no Corepack)", async () => {
    const m = machine({ node: 26, noPnpm: true });
    const { code, out } = await run(m);
    expect(code).toBe(1);
    expect(out).toContain("npm install -g pnpm@11");
    expect(out).toContain("Not ready");
  });

  it("installs a release archive without building it, and without pnpm", async () => {
    const m = machine({ noPnpm: true });
    // An unpacked release: the installer, the built app, its packages, and RELEASE.
    const rel = path.join(m.root, "hearth-0.1.0-linux");
    for (const d of ["deploy/linux", "apps/server/dist", "apps/web/dist", "node_modules"])
      mkdirSync(path.join(rel, d), { recursive: true });
    copyFileSync(SCRIPT, path.join(rel, "deploy/linux/install.sh"));
    writeFileSync(path.join(rel, "apps/server/dist/index.js"), "");
    writeFileSync(path.join(rel, "apps/web/dist/index.html"), "");
    writeFileSync(
      path.join(rel, "RELEASE"),
      ["version=0.1.0", "commit=abc1234", "built=2026-10-18T00:00:00Z", ""].join("\n"),
    );
    const script = path.join(rel, "deploy/linux/install.sh");
    const dry = await run(m, {}, ["--dry-run"], script);
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toContain("abc1234 (release 0.1.0)");
    expect(dry.out).toContain("nothing to build: release 0.1.0 is already built");
    expect(dry.out).not.toContain("pnpm build");
    const real = await run(m, {}, [], script);
    expect(real.code, real.out).toBe(0);
    expect(real.out).toContain("from release 0.1.0");
    const ran = readFileSync(m.ran, "utf8");
    expect(ran).not.toMatch(/pnpm|corepack/);
    expect(ran).toContain("sudo tee");
  });

  it("an account with a private home: the dry run says it could not check; the install asks as that account", async () => {
    const m = machine({ owner: "svc" });
    // A dedicated account whose home only it can open (mode 700 on a real machine).
    const home = path.join(m.root, "home", "svc");
    mkdirSync(home, { recursive: true });
    chmodSync(home, 0o600);
    const env = { DC_SERVICE_USER: "svc", DC_SERVICE_NAME: "hearth" };
    const dry = await run(m, env);
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toContain(
      "svc's home folder is private, so this could not check for Claude Code",
    );
    expect(dry.out).not.toContain("Claude Code CLI is not installed for svc");
    expect(dry.out).toContain("Description=Hearth\n");
    const real = await run(m, env, []);
    chmodSync(home, 0o700);
    expect(real.code, real.out).toBe(0);
    // sudo -u svc test -x ... succeeds, so the service is told where Claude Code is.
    expect(readFileSync(m.ran, "utf8")).toContain(
      `sudo -n -u svc test -x ${home}/.local/bin/claude`,
    );
    expect(readFileSync(path.join(m.root, "written.service"), "utf8")).toContain(
      `Environment="DC_CLAUDE_PATH=${home}/.local/bin/claude"`,
    );
  });

  it("installs for real: builds, writes the service with sudo, and checks it answers", async () => {
    const m = machine();
    const { code, out, port } = await run(m, { DC_HOST: "192.168.1.20" }, []);
    expect(code, out).toBe(0);
    const ran = readFileSync(m.ran, "utf8").trim().split("\n");
    expect(ran.map((l) => l.split(" ").slice(0, 2).join(" "))).toEqual([
      "corepack enable",
      "pnpm install",
      "pnpm build",
      "sudo tee",
      "sudo systemctl",
      "sudo systemctl",
      "sudo systemctl",
      "curl -sf",
      "curl -sf",
    ]);
    expect(readFileSync(path.join(m.root, "written.service"), "utf8")).toContain(
      "Environment=DC_HOST=192.168.1.20",
    );
    // It checks the address the service listens on.
    expect(ran.at(-1)).toContain(`http://192.168.1.20:${port}/api/health`);
    expect(out).toContain(`Running 'dragon-control' on port ${port} for your home network`);
  });

  it("says which step failed and that running it again is safe, before using sudo", async () => {
    const m = machine({ pnpmFails: "build" });
    const { code, out } = await run(m, {}, []);
    expect(code).not.toBe(0);
    expect(out).toContain("error: it broke");
    expect(out).toContain("Stopped while building (pnpm build)");
    expect(out).toContain("it is safe to repeat");
    expect(readFileSync(m.ran, "utf8")).not.toContain("sudo");
  });

  it("finds a port taken by another program, and lets an update reuse its own", async () => {
    const other = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => other.once("listening", r));
    const port = String((other.address() as AddressInfo).port);
    try {
      const taken = await run(machine(), { DC_PORT: port });
      expect(taken.code).toBe(1);
      expect(taken.out).toContain(`Port ${port} is already used by another program`);
      // Another Hearth answering there is another installation, not this one: refused.
      const elsewhere = machine();
      writeFileSync(
        path.join(elsewhere.bin, "curl"),
        `#!/usr/bin/env bash\necho '{"status":"ok","app":"Hearth"}'\n`,
      );
      const other2 = await run(elsewhere, { DC_PORT: port });
      expect(other2.code).toBe(1);
      expect(other2.out).toContain(`Port ${port} is already used by another program`);
      // This installation, installed from this folder on that port, is an update.
      const m = machine();
      writeFileSync(
        path.join(m.root, "dragon-control.service"),
        unitText({ dir: APP_DIR, port, data: path.join(m.root, "data") }),
      );
      const update = await run(m, { DC_PORT: port });
      expect(update.code, update.out).toBe(0);
      expect(update.out).toContain(`'dragon-control' is already installed on port ${port}`);
    } finally {
      other.close();
    }
  });

  it("needs systemd and curl", async () => {
    const m = machine();
    rmSync(path.join(m.bin, "systemctl"));
    rmSync(path.join(m.bin, "curl"));
    const { code, out } = await run(m);
    expect(code).toBe(1);
    expect(out).toContain("no systemd");
    expect(out).toContain("pnpm start");
    expect(out).toContain("curl is missing");
  });

  it("rejects options it does not know", async () => {
    const { code, out } = await run(machine(), {}, ["--yes"]);
    expect(code).toBe(2);
    expect(out).toContain("options: --dry-run, --status, --uninstall");
  });
});

// More than one installation on one machine (docs/MULTIPLE_INSTALLS.md): managing one must never
// touch another, whatever is run.
describe.skipIf(process.platform === "win32")("install.sh, several installations", () => {
  it("a dry run of a second installation names everything it would touch, and leaves the first alone", async () => {
    const m = machine({ owner: "hearth" });
    const prod = production(m);
    const { code, out } = await run(m, PREVIEW);
    expect(code, out).toBe(0);
    expect(out).toContain("installation: hearth-preview (new)");
    expect(out).toContain(`service file: ${path.join(m.root, "hearth-preview.service")}`);
    expect(out).toContain("runs as:      hearth");
    expect(out).toContain(
      "starts:       only when you start it (sudo systemctl start hearth-preview)",
    );
    expect(out).toContain(
      "limits:       memory 1G (slows down above 768M), swap 0, processor 100%",
    );
    expect(out).toContain(
      "dragon-control (folder /srv/prod/dragon-control, port 7400, runs as alex)",
    );
    expect(out).toContain("sudo -u hearth -H nice -n 10 pnpm build");
    expect(out).toContain("sudo install -d -m 700 -o hearth:");
    expect(out).toContain("sudo systemctl disable hearth-preview");
    expect(out).toContain("sudo systemctl restart hearth-preview");
    expect(out).not.toMatch(/systemctl \w+ dragon-control/);
    // The service file it would write: its own name, account, limits, and no start with the machine.
    expect(out).toContain("Description=Hearth (hearth-preview)");
    expect(out).toContain("User=hearth");
    expect(out).toContain("MemoryMax=1G");
    expect(out).toContain("MemoryHigh=768M");
    expect(out).toContain("CPUQuota=100%");
    expect(out).toContain("MemorySwapMax=0");
    expect(out).toContain('Environment="DC_AUTOSTART=no"');
    expect(out).toContain(":/home/hearth/.local/bin:");
    expect(existsSync(m.ran)).toBe(false);
    expect(readFileSync(prod.file, "utf8")).toBe(prod.text);
  });

  it("a real install of a second installation never runs anything against the first", async () => {
    const m = machine({ owner: "hearth" });
    const prod = production(m);
    const { code, out } = await run(m, PREVIEW, []);
    expect(code, out).toBe(0);
    const ran = readFileSync(m.ran, "utf8").trim().split("\n");
    expect(ran.filter((l) => l.includes("dragon-control"))).toEqual([]);
    expect(ran.filter((l) => l.startsWith("sudo systemctl"))).toEqual([
      "sudo systemctl daemon-reload",
      "sudo systemctl disable hearth-preview",
      "sudo systemctl restart hearth-preview",
    ]);
    // Built by the dedicated account, at low priority; its folders are its own.
    expect(
      ran.some(
        (l) => l.startsWith("sudo -u hearth -H nice -n 10 env") && l.includes("pnpm install"),
      ),
    ).toBe(true);
    expect(ran.some((l) => l.startsWith("sudo -u hearth -H nice -n 10 pnpm build"))).toBe(true);
    expect(ran.some((l) => l.startsWith("sudo install -d -m 700 -o hearth -g hearth"))).toBe(true);
    const written = readFileSync(path.join(m.root, "written.service"), "utf8");
    expect(written).toContain("User=hearth");
    expect(written).toContain("MemoryMax=1G");
    expect(out).toContain("Stop it when you are done: sudo systemctl stop hearth-preview");
    expect(out).toContain("sudo tailscale serve --bg --https=8443");
    expect(readFileSync(prod.file, "utf8")).toBe(prod.text);
  });

  it("will not manage a service that belongs to another folder, even by default", async () => {
    const m = machine();
    const prod = production(m);
    // Run from a copy without a name: the default name is production's, installed elsewhere.
    for (const args of [["--dry-run"], [], ["--uninstall"]]) {
      const r = await run(m, {}, args);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain(
        "the service 'dragon-control' belongs to the installation in /srv/prod/dragon-control",
      );
      expect(r.out).toContain("DC_SERVICE_NAME=hearth-preview");
    }
    expect(existsSync(m.ran)).toBe(false);
    expect(readFileSync(prod.file, "utf8")).toBe(prod.text);
  });

  it("run again from the same folder, it finds its own installation and keeps its settings", async () => {
    const m = machine({ owner: "hearth" });
    production(m);
    const port = String(await freePort());
    writeFileSync(
      path.join(m.root, "hearth-preview.service"),
      unitText({
        dir: APP_DIR,
        port,
        data: path.join(m.root, "data"),
        user: "hearth",
        extra: ['Environment="DC_AUTOSTART=no"', "MemoryMax=1G", "CPUQuota=100%"],
      }),
    );
    // With two installations on the machine, the name is required: never guessed from the folder.
    const unnamed = await run(m, { DC_PORT: port }, []);
    expect(unnamed.code).toBe(1);
    expect(unnamed.out).toContain("more than one Hearth installation, so name the one");
    expect(unnamed.out).toContain(
      "DC_SERVICE_NAME=dragon-control   (folder /srv/prod/dragon-control)",
    );
    expect(existsSync(m.ran)).toBe(false);
    const { code, out } = await run(m, { DC_PORT: port, DC_SERVICE_NAME: "hearth-preview" });
    expect(code, out).toBe(0);
    expect(out).toContain("installation: hearth-preview (installed: this updates it)");
    expect(out).toContain("runs as:      hearth");
    expect(out).toContain("MemoryMax=1G");
    expect(out).toContain("CPUQuota=100%");
    expect(out).toContain('Environment="DC_AUTOSTART=no"');
    expect(out).toContain("sudo systemctl restart hearth-preview");
    // A limit can be taken off again.
    const lifted = await run(m, {
      DC_PORT: port,
      DC_SERVICE_NAME: "hearth-preview",
      DC_CPU_QUOTA: "none",
    });
    expect(lifted.out).not.toContain("CPUQuota=");
    expect(lifted.out).toContain("MemoryMax=1G");
  });

  it("refuses to share a folder, a port, or records with another installation", async () => {
    const m = machine({ owner: "hearth" });
    production(m);
    const { code, out } = await run(m, {
      ...PREVIEW,
      DC_PORT: "7400",
      DC_DATA_DIR: "/srv/prod/data",
      DC_KEY_DIR: "/srv/prod/data",
    });
    expect(code).toBe(1);
    expect(out).toContain("port 7400 is used by the installation 'dragon-control'");
    expect(out).toContain("/srv/prod/data is the installation 'dragon-control''s DC_DATA_DIR");
    expect(out).toContain("/srv/prod/data is the installation 'dragon-control''s DC_KEY_DIR");
    expect(out).toContain("Not ready");
    // The same folder cannot be installed twice under two names.
    writeFileSync(
      path.join(m.root, "dragon-control.service"),
      unitText({ dir: APP_DIR, port: "7400", data: "/srv/prod/data" }),
    );
    const twice = await run(m, PREVIEW);
    expect(twice.code).toBe(1);
    expect(twice.out).toContain("this folder is already installed as 'dragon-control'");
  });

  it("--status shows this installation and the others, and changes nothing", async () => {
    const m = machine({ owner: "hearth" });
    const prod = production(m);
    writeFileSync(
      path.join(m.root, "hearth-preview.service"),
      unitText({
        dir: APP_DIR,
        port: "7500",
        data: "/srv/preview/data",
        user: "hearth",
        extra: ["MemoryMax=1G"],
      }),
    );
    const { code, out } = await run(m, { DC_PORT: "7500" }, ["--status"]);
    expect(code, out).toBe(0);
    expect(out).toContain("Installation 'hearth-preview'");
    expect(out).toContain("runs as:      hearth");
    expect(out).toContain("limits:       memory 1G");
    expect(out).toContain(
      "dragon-control (folder /srv/prod/dragon-control, port 7400, runs as alex)",
    );
    expect(readFileSync(m.ran, "utf8").trim()).toBe("systemctl is-active hearth-preview");
    expect(readFileSync(prod.file, "utf8")).toBe(prod.text);
  });

  it("--uninstall removes only this installation's service, and keeps its data", async () => {
    const m = machine({ owner: "hearth" });
    const prod = production(m);
    const unit = path.join(m.root, "hearth-preview.service");
    writeFileSync(
      unit,
      unitText({ dir: APP_DIR, port: "7500", data: "/srv/preview/data", user: "hearth" }),
    );
    // Unnamed, with two installations: refused, nothing run.
    const unnamed = await run(m, { DC_PORT: "7500" }, ["--uninstall"]);
    expect(unnamed.code).toBe(1);
    expect(existsSync(m.ran)).toBe(false);
    const named = { DC_PORT: "7500", DC_SERVICE_NAME: "hearth-preview" };
    const dry = await run(m, named, ["--uninstall", "--dry-run"]);
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toContain("Dry run: Removing the service 'hearth-preview' only");
    expect(dry.out).toContain("data:    /srv/preview/data");
    expect(existsSync(m.ran)).toBe(false);
    const real = await run(m, named, ["--uninstall"]);
    expect(real.code, real.out).toBe(0);
    expect(readFileSync(m.ran, "utf8").trim().split("\n")).toEqual([
      "sudo systemctl stop hearth-preview",
      "sudo systemctl disable hearth-preview",
      `sudo rm -f ${unit}`,
      "sudo systemctl daemon-reload",
    ]);
    expect(readFileSync(prod.file, "utf8")).toBe(prod.text);
  });

  it("checks names, accounts, limits, and who owns the folder", async () => {
    const bad = await run(machine(), { DC_SERVICE_NAME: "Bad Name" });
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("DC_SERVICE_NAME must be lowercase letters");
    const limits = await run(machine({ owner: "hearth" }), {
      ...PREVIEW,
      DC_MEMORY_MAX: "lots",
      DC_CPU_QUOTA: "2",
      DC_AUTOSTART: "maybe",
    });
    expect(limits.code).toBe(1);
    expect(limits.out).toContain("DC_MEMORY_MAX must be a size like 768M or 1G");
    expect(limits.out).toContain("DC_CPU_QUOTA must be a percentage");
    expect(limits.out).toContain("DC_AUTOSTART must be yes or no");
    const rootUser = await run(machine(), { ...PREVIEW, DC_SERVICE_USER: "root" });
    expect(rootUser.code).toBe(1);
    expect(rootUser.out).toContain("cannot be root");
    const missing = await run(machine(), { ...PREVIEW, DC_SERVICE_USER: "nobody-here" });
    expect(missing.out).toContain("The account 'nobody-here' does not exist");
    const owner = await run(machine({ owner: "alex" }), PREVIEW);
    expect(owner.code).toBe(1);
    expect(owner.out).toContain("The project folder must belong to 'hearth'");
  });

  it("still accepts DC_INSTALL_UNIT, an exact service file, as before", async () => {
    const m = machine();
    const { code, out } = await run(m, { DC_INSTALL_UNIT: path.join(m.root, "legacy.service") });
    expect(code, out).toBe(0);
    expect(out).toContain(`service file: ${path.join(m.root, "legacy.service")}`);
    expect(out).toContain("sudo systemctl restart legacy");
  });
  it("alone on a machine, running it again from its folder finds the installation by itself", async () => {
    const m = machine({ owner: "hearth" });
    const port = String(await freePort());
    writeFileSync(
      path.join(m.root, "hearth-preview.service"),
      unitText({ dir: APP_DIR, port, data: path.join(m.root, "data"), user: "hearth" }),
    );
    const { code, out } = await run(m, { DC_PORT: port });
    expect(code, out).toBe(0);
    expect(out).toContain("installation: hearth-preview (installed: this updates it)");
  });

  it("never takes over an existing folder, or one inside another installation's", async () => {
    const m = machine({ owner: "hearth" });
    const prod = production(m);
    // A typo pointing at a shared folder that exists and belongs to someone else.
    const shared = path.join(m.root, "shared-backups");
    mkdirSync(shared);
    const takeover = await run(m, { ...PREVIEW, DC_BACKUP_DIR: shared, FOREIGN: shared }, []);
    expect(takeover.code).toBe(1);
    expect(takeover.out).toContain(`${shared} already exists and belongs to homeuser, not hearth`);
    expect(existsSync(m.ran)).toBe(false);
    // Inside production's data folder.
    const nested = await run(m, { ...PREVIEW, DC_BACKUP_DIR: "/srv/prod/data/preview-backups" });
    expect(nested.code).toBe(1);
    expect(nested.out).toContain("are inside one another");
    expect(readFileSync(prod.file, "utf8")).toBe(prod.text);
  });
});

// The optional restart limit (DC_RESTART_LIMIT): off by default, so an installation keeps
// restarting after failures exactly as before.
describe.skipIf(process.platform === "win32")("install.sh restart limit", () => {
  it("is off by default, written as StartLimit fields when asked, kept, and removable", async () => {
    const m = machine();
    const plain = await run(m);
    expect(plain.code, plain.out).toBe(0);
    expect(plain.out).not.toContain("StartLimit");
    expect(plain.out).not.toContain("restarts stop after");

    const limited = await run(m, { DC_RESTART_LIMIT: "5/600" });
    expect(limited.code, limited.out).toBe(0);
    expect(limited.out).toContain("restarts stop after 5 failures in 600 s");
    // In [Unit], where systemd reads them.
    expect(limited.out).toMatch(
      /After=network-online\.target docker\.service\nStartLimitIntervalSec=600\nStartLimitBurst=5\n\n\[Service\]/,
    );

    // Run again without it: the installed limit is kept; "none" takes it off.
    const port = String(await freePort());
    writeFileSync(
      path.join(m.root, "dragon-control.service"),
      [
        "[Unit]",
        "StartLimitIntervalSec=600",
        "StartLimitBurst=5",
        unitText({ dir: APP_DIR, port, data: path.join(m.root, "data") }),
      ].join("\n"),
    );
    const kept = await run(m, { DC_PORT: port });
    expect(kept.out).toContain("StartLimitBurst=5");
    const removed = await run(m, { DC_PORT: port, DC_RESTART_LIMIT: "none" });
    expect(removed.code, removed.out).toBe(0);
    expect(removed.out).not.toContain("StartLimit");
  });

  it("rejects a limit it cannot read", async () => {
    for (const bad of ["five", "5", "0/600", "5/0", "5/10m"]) {
      const r = await run(machine(), { DC_RESTART_LIMIT: bad });
      expect(r.code, bad).toBe(1);
      expect(r.out).toContain("DC_RESTART_LIMIT must be failed starts / seconds");
    }
  });
});

/** Real systemd and passwordless sudo: only on CI's Linux machines, never a developer's computer. */
function realSystemd(): boolean {
  if (process.env.CI !== "true" || process.platform !== "linux") return false;
  if (!existsSync("/run/systemd/system")) return false;
  try {
    execFileSync("sudo", ["-n", "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// The service file the installer writes, run by the real systemd with a program that always fails:
// with the limit it stops after 5 failed starts; without it, it keeps restarting (systemd's own
// default, 5 starts in 10 s, is never reached with the installer's 5 s between restarts).
describe.skipIf(!realSystemd())("install.sh restart limit, under real systemd (CI only)", () => {
  const sh = (args: string[]) => execFileSync("sudo", args, { encoding: "utf8" });
  const show = (name: string): Record<string, string> =>
    Object.fromEntries(
      sh([
        "systemctl",
        "show",
        name,
        "-p",
        "Result",
        "-p",
        "NRestarts",
        "-p",
        "ActiveState",
        "-p",
        "SubState",
        "-p",
        "StartLimitBurst",
        "-p",
        "StartLimitIntervalUSec",
      ])
        .trim()
        .split("\n")
        .map((l) => l.split("=") as [string, string]),
    );

  async function failingService(env: Record<string, string>): Promise<string> {
    const { out } = await run(machine(), env);
    const text = out.split("== Service file it would write\n")[1]!;
    return text
      .replace(/^ExecStart=.*$/m, "ExecStart=/bin/false")
      .replace(/^User=.*$/m, "User=nobody")
      .replace(/^WorkingDirectory=.*$/m, "WorkingDirectory=/");
  }

  async function watch(name: string, text: string, seconds: number) {
    const file = `/run/systemd/system/${name}.service`;
    execFileSync("sudo", ["tee", file], { input: text, stdio: ["pipe", "ignore", "inherit"] });
    try {
      sh(["systemctl", "daemon-reload"]);
      sh(["systemctl", "start", name]);
      const until = Date.now() + seconds * 1000;
      let state = show(name);
      while (
        Date.now() < until &&
        !(state.ActiveState === "failed" && state.SubState === "failed")
      ) {
        await new Promise((r) => setTimeout(r, 500));
        state = show(name);
      }
      // What systemd saw, shown if an expectation fails (no secrets: a unit running /bin/false).
      const journal = sh(["journalctl", "-u", name, "--no-pager", "-o", "cat", "-n", "40"]);
      return { ...state, journal } as Record<string, string>;
    } finally {
      for (const args of [
        ["systemctl", "stop", name],
        ["rm", "-f", file],
        ["systemctl", "daemon-reload"],
        ["systemctl", "reset-failed", name],
      ])
        try {
          sh(args);
        } catch {
          // Already gone.
        }
    }
  }

  it("stops after 5 failed starts with DC_RESTART_LIMIT=5/600, and keeps restarting without it", async () => {
    const id = Date.now().toString(36);
    const [limited, plain] = await Promise.all([
      failingService({ DC_RESTART_LIMIT: "5/600" }).then((t) => watch(`dc-limit-${id}`, t, 45)),
      failingService({}).then((t) => watch(`dc-plain-${id}`, t, 32)),
    ]);
    const why = JSON.stringify(limited, null, 1);
    // systemd gave up: stopped for good, not waiting to restart, and it says why. (Result keeps the
    // failure that caused it, "exit-code", on systemd 255.)
    expect(limited.ActiveState, why).toBe("failed");
    expect(limited.SubState, why).toBe("failed");
    expect(limited.journal, why).toContain("Start request repeated too quickly");
    expect(limited.StartLimitBurst).toBe("5");
    expect(limited.StartLimitIntervalUSec).toBe("10min");
    // 5 failed starts: the first and 4 restarts (systemd may count the refused sixth as well).
    expect(Number(limited.NRestarts), why).toBeGreaterThanOrEqual(4);
    expect(Number(limited.NRestarts), why).toBeLessThanOrEqual(5);
    // Without the limit: still trying after 32 seconds, as installations always have.
    const plainWhy = JSON.stringify(plain, null, 1);
    expect(plain.journal, plainWhy).not.toContain("Start request repeated too quickly");
    expect(plain.SubState, plainWhy).not.toBe("failed");
    expect(Number(plain.NRestarts), plainWhy).toBeGreaterThanOrEqual(5);
  }, 90_000);
});
