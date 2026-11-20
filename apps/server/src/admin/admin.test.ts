import { mkdtempSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { ActionRunner } from "../actions/service";
import type { ContainerTools } from "../actions/tools";
import { Jobs } from "../jobs/engine";
import { runnerOperations } from "../jobs/operations";
import { listAudit } from "../store/audit";
import { createAdmin } from ".";
import { tarOne, type ContainerExec } from "./docker-exec";
import { maskSecrets } from "./files";
import { classify, GapError, isProtectedContainer } from "./scope";

/**
 * Host administration (feature request 21) end to end on a temporary folder: the scope switch,
 * read-only investigation with its classes and masking, and a Recyclarr configuration edit
 * planned, approved, backed up, written, verified, and synced through the plans engine, with a
 * stand-in Recyclarr container whose preview follows the file.
 */

const handles: DbHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

const fwd = (p: string) => p.replaceAll("\\", "/");

const CONFIG = `radarr:
  movies:
    base_url: http://radarr:7878
    api_key: !env_var RADARR_API_KEY
    quality_profiles:
      - trash_id: d1d67249d3890e49bc12e275d989a7e9 # HD Bluray + WEB
        reset_unmatched_scores:
          enabled: true
sonarr:
  series:
    api_key: abcdef0123456789
`;

/**
 * What `docker compose config --format json` prints for the small Compose files in these tests
 * (services with image, ports, volumes as host:container, privileged, devices), or its error.
 */
function fakeComposeConfig(text: string): { code: number; out: string } {
  if (text.includes("BROKEN")) return { code: 15, out: "yaml: line 3: did not find expected key" };
  const services: Record<string, Record<string, unknown>> = {};
  let svc: Record<string, unknown> | undefined;
  let list: string | undefined;
  for (const line of text.split("\n")) {
    const name = /^ {2}([\w-]+):\s*$/.exec(line);
    if (name) {
      svc = services[name[1]!] = {};
      list = undefined;
      continue;
    }
    const key = /^ {4}([\w_]+):\s*(.*)$/.exec(line);
    if (key && svc) {
      list = key[2] ? undefined : key[1];
      if (key[2]) svc[key[1]!] = key[2] === "true" ? true : key[2];
      continue;
    }
    const item = /^ {6}- (.+)$/.exec(line);
    if (item && svc && list) {
      const v = item[1]!;
      const arr = ((svc[list] as unknown[]) ??= []);
      if (list === "volumes") {
        const [source, target, mode] = v.split(":");
        arr.push({ type: "bind", source, target, read_only: mode === "ro" });
      } else if (list === "ports") {
        const [published, target] = v.split(":");
        arr.push({ published, target: Number(target), protocol: "tcp" });
      } else arr.push(v);
    }
  }
  return { code: 0, out: JSON.stringify({ name: "test", services }) };
}

async function setup() {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  handles.push(handle);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dc-admin-")));
  dirs.push(root);
  const config = path.join(root, "config");
  const logs = path.join(config, "logs", "cli");
  await fs.mkdir(logs, { recursive: true });
  const file = path.join(config, "recyclarr.yml");
  await fs.writeFile(file, CONFIG);
  const backups = path.join(root, "backups");
  await handle.db.insert(t.hosts).values({
    id: "h1",
    name: "Homeserver",
    role: "server",
    os: "Linux",
    address: "127.0.0.1",
    cpuModel: "x",
    cpuCores: 8,
    cpuUsagePct: 0,
    memTotalGb: 32,
    memUsedGb: 8,
    uptimeHours: 1,
    connection: "this-machine",
    docker: true,
    health: "healthy",
    lastSeenAt: "2026-10-10T00:00:00Z",
  });
  await handle.db.insert(t.services).values({
    id: "recyclarr",
    name: "Recyclarr",
    category: "media",
    hostId: "h1",
    kind: "container",
    image: "ghcr.io/recyclarr/recyclarr:8",
    health: "healthy",
    autonomyArea: "media",
    checkTarget: "container:recyclarr",
  });

  // Stand-in Recyclarr: Radarr's profile currently has upgrades off; a sync sets what the file says.
  const state = { radarrUpgrades: "False" };
  const configs = new Map<string, string>();
  const wants = (cfg: string) => (/upgrade:\s*\n\s*allowed: false/.test(cfg) ? "False" : "True");
  let n = 0;
  const writeLog = async (lines: string[]) => {
    await fs.writeFile(
      path.join(logs, `recyclarr.${Date.now()}.${n++}.debug.log`),
      lines.join("\n"),
    );
  };
  const exec: ContainerExec = {
    async putFile(_c, dir, name, content) {
      configs.set(`${dir}/${name}`, content.toString("utf8"));
    },
    async exec(_c, cmd) {
      if (cmd[0] === "rm") {
        configs.delete(cmd[2]!);
        return { exitCode: 0, output: "" };
      }
      if (cmd[0] !== "recyclarr") return { exitCode: 0, output: "" };
      const preview = cmd.includes("--preview");
      const cfgPath = cmd.includes("--config") ? cmd[cmd.indexOf("--config") + 1]! : undefined;
      const cfg = cfgPath ? configs.get(cfgPath)! : await fs.readFile(file, "utf8");
      const to = wants(cfg);
      await writeLog([
        "[2026-10-10 12:00:00 WRN] Failed to fetch reference v8, using cached copy",
        `[2026-10-10 12:00:01 INF] hd-bluray-web: Upgrade Allowed: ${state.radarrUpgrades} -> ${to}`,
      ]);
      if (!preview) state.radarrUpgrades = to;
      return { exitCode: 0, output: "done" };
    },
  };
  const containers = {
    async mounts(name: string) {
      return name === "recyclarr" ? [{ source: fwd(config), destination: "/config" }] : [];
    },
  } as unknown as ContainerTools;
  const runner = {
    containerTools: containers,
    async policyFor() {
      return { decision: { outcome: "allow", reason: "" } };
    },
  } as unknown as ActionRunner;
  const ran: string[][] = [];
  const admin = createAdmin(handle, runner, {
    backupRoot: backups,
    rules: { secretRoots: [fwd(path.join(root, "dc-data"))] },
    exec,
    run: async (cmd, args) => {
      ran.push([cmd, ...args]);
      if (cmd === "missing-tool") throw Object.assign(new Error("nope"), { code: "ENOENT" });
      if (cmd === "docker" && args[0] === "compose" && args.includes("--format"))
        return fakeComposeConfig(await fs.readFile(args[args.indexOf("-f") + 1]!, "utf8"));
      if (cmd === "docker" && args[0] === "inspect")
        return {
          code: 0,
          out: JSON.stringify([{ Name: "/x", Config: { Env: ["TOKEN=supersecret", "TZ=UTC"] } }]),
        };
      return { code: 0, out: `ran ${cmd}` };
    },
  });
  const jobs = new Jobs(handle, runnerOperations(handle, runner, undefined, admin.config));
  return { handle, admin, jobs, root, config, file, backups, state, ran, configs };
}

describe("host scope classes", () => {
  const rules = {
    secretRoots: ["/var/lib/dc"],
    // Its own code, and the backup ledger (index.ts passes both).
    protectedRoots: ["/srv/homelab/projects/dragon-control", "/srv/homelab/backups"],
  };
  it.each([
    ["/srv/homelab/docker/config/radarr/config.xml", "ordinary"],
    ["/srv/homelab/docker/config/recyclarr/recyclarr.yml", "ordinary"],
    ["/mnt/d/Shows/Colony/S01E01.mkv", "ordinary"],
    ["/etc/ssh/sshd_config", "protected"],
    ["/etc/fstab", "protected"],
    ["/srv/homelab/docker/compose/caddy/Caddyfile", "protected"],
    ["/srv/homelab/docker/config/gluetun/servers.json", "protected"],
    ["/srv/homelab/backups/radarr/x/config.xml", "protected"],
    ["/srv/homelab/projects/dragon-control/apps/server/src/app.ts", "protected"],
    ["/home/j/.ssh/authorized_keys", "protected"],
    ["/home/j/.ssh/id_ed25519", "secret"],
    ["/home/j/.gnupg/pubring.kbx", "secret"],
    ["/srv/homelab/secrets/homeserver-backup/passphrase", "secret"],
    ["/var/lib/dc/dragon-control.db", "secret"],
    ["/proc/1/environ", "secret"],
    ["/dev/sda", "secret"],
    ["/etc/ssl/private/server.key", "secret"],
  ])("%s is %s", (p, want) => {
    expect(classify(p, rules, { protected: [], secret: [], containers: [] }).class).toBe(want);
  });

  it("extra rules from the root-owned file can only add", () => {
    const extra = {
      protected: ["/mnt/d/Important"],
      secret: ["/mnt/e/Private"],
      containers: ["homeassistant"],
    };
    expect(classify("/mnt/d/Important/a.txt", rules, extra).class).toBe("protected");
    expect(classify("/mnt/e/Private/a.txt", rules, extra).class).toBe("secret");
    expect(isProtectedContainer("homeassistant", "", extra)).toBe(true);
    expect(isProtectedContainer("gluetun", "qmcgaw/gluetun:latest", extra)).toBe(true);
    expect(isProtectedContainer("radarr", "lscr.io/linuxserver/radarr", extra)).toBe(false);
  });

  it("masks secret values, keeps references", () => {
    const out = maskSecrets(CONFIG, "yaml");
    expect(out).toContain("base_url: http://radarr:7878");
    expect(out).toContain("api_key: !env_var RADARR_API_KEY");
    const ids = maskSecrets(
      [
        "      custom_formats:",
        "        - trash_ids:",
        "            - 9b64dff695c2115facf1b6ea59c9bd07  # x265",
        "          assign_scores_to:",
        "            - name: HD",
        "        - trash_id: 9b64dff695c2115facf1b6ea59c9bd08  # Golden Rule",
        "          select:",
        "            - 9b64dff695c2115facf1b6ea59c9bd09  # x265 (no HDR/DV) -- smaller",
        "    api_key: 0123456789abcdef0123456789abcdef",
      ].join("\n"),
      "yaml",
    );
    expect(ids).toContain("- 9b64dff695c2115facf1b6ea59c9bd07  # x265");
    expect(ids).toContain("trash_id: 9b64dff695c2115facf1b6ea59c9bd08");
    expect(ids).toContain("- 9b64dff695c2115facf1b6ea59c9bd09  # x265");
    expect(ids).not.toContain("0123456789abcdef0123456789abcdef");
    expect(out).not.toContain("abcdef0123456789");
    expect(maskSecrets("A=1\nexport WG_KEY=xyz\n", "env")).toBe(
      "A=<masked>\nexport WG_KEY=<masked>\n",
    );
    expect(maskSecrets("  - WIREGUARD_PRIVATE_KEY=abc", "yaml")).not.toContain("abc");
  });
});

describe("copies into a container", () => {
  it("belong to the user the container runs as, readable only by it", () => {
    const tar = tarOne("check.yml", Buffer.from("a: 1"), { uid: 1000, gid: 1000 });
    const field = (off: number, len: number) =>
      tar
        .subarray(off, off + len)
        .toString("ascii")
        .replaceAll(String.fromCharCode(0), "");
    expect(field(100, 8)).toBe("0000600");
    expect(field(108, 8)).toBe("0001750");
    expect(field(116, 8)).toBe("0001750");
    // A valid ustar checksum, so Docker accepts it.
    const header = Buffer.from(tar.subarray(0, 512));
    const stored = parseInt(field(148, 6), 8);
    header.fill(0x20, 148, 156);
    expect(header.reduce((a, b) => a + b, 0)).toBe(stored);
  });
});

describe("host administration", () => {
  it("is off until you switch it on, and says precisely why", async () => {
    const { admin, root } = await setup();
    await expect(admin.host.list(root)).rejects.toMatchObject({ gap: "missing-permission" });
    const s = await admin.scopes.enable({ hostId: "h1", operations: ["investigate"] });
    expect(s.operations).toEqual(["investigate"]);
    const listed = await admin.host.list(root);
    expect(listed.entries.map((e) => e.name)).toContain("config");
    await admin.scopes.revoke(s.id);
    await expect(admin.host.stat(root)).rejects.toBeInstanceOf(GapError);
  });

  it("reads files masked, withholds secret files, pages large ones, and audits what it looked at", async () => {
    const { admin, handle, root, file } = await setup();
    await admin.scopes.enable({ hostId: "h1", operations: ["investigate"] });
    type Page = { content: string; nextOffset?: number };
    const r = (await admin.host.read(file)) as Page;
    expect(r.content).toContain("trash_id: d1d67249d3890e49bc12e275d989a7e9");
    expect(r.content).not.toContain("abcdef0123456789");
    const key = path.join(root, "id_ed25519");
    await fs.writeFile(key, "-----BEGIN OPENSSH PRIVATE KEY-----\nxyz\n");
    await expect(admin.host.read(key)).rejects.toMatchObject({ gap: "secret" });
    const big = path.join(root, "big.log");
    await fs.writeFile(big, `${"line of text\n".repeat(30_000)}`);
    const p1 = (await admin.host.read(big)) as Page;
    expect(p1.nextOffset).toBeGreaterThan(0);
    expect(p1.content!.endsWith("\n")).toBe(true);
    const p2 = (await admin.host.read(big, { offset: p1.nextOffset })) as Page;
    expect(p2.content!.startsWith("line of text")).toBe(true);
    const found = await admin.host.search(root, "recyclarr*.yml");
    expect(found.results.map((x) => x.name)).toEqual(["recyclarr.yml"]);
    const audit = (await listAudit(handle.db, 20)).map((a) => a.action);
    expect(audit.some((a) => a.startsWith("Read ") && a.includes("recyclarr.yml"))).toBe(true);
    expect(audit.join("\n")).not.toContain("abcdef");
  });

  it("runs only fixed diagnostics, strips container environment values, and reports missing tools as gaps", async () => {
    const { admin, ran } = await setup();
    await admin.scopes.enable({ hostId: "h1", operations: ["investigate"] });
    await expect(admin.host.diagnose("rm -rf /")).rejects.toMatchObject({
      gap: "missing-capability",
    });
    await expect(admin.host.diagnose("journal", "x; reboot")).rejects.toMatchObject({
      gap: "unsupported",
    });
    const out = await admin.host.diagnose("container", "radarr");
    expect(out.output).toContain("TZ=<masked>");
    expect(out.output).not.toContain("supersecret");
    expect(ran.at(-1)).toEqual(["docker", "inspect", "--", "radarr"]);
  });

  it("Recyclarr: a planned edit waits for approval, then is backed up, written, verified, and synced", async () => {
    const { admin, jobs, file, backups, state, configs } = await setup();
    await admin.scopes.enable({ hostId: "h1", operations: ["investigate"] });
    const edits = JSON.stringify([
      {
        find: "        reset_unmatched_scores:\n          enabled: true\n",
        replace:
          "        reset_unmatched_scores:\n          enabled: true\n        upgrade:\n          allowed: false\n",
      },
    ]);
    const step = {
      kind: "config-edit" as const,
      serviceId: "recyclarr",
      params: { path: fwd(file), edits },
    };
    // Investigating is not proposing.
    const refused = await jobs.create({
      title: "Keep upgrades off",
      steps: [step],
      requestedBy: "agent",
    });
    expect(refused.status).toBe("refused");
    expect(refused.steps[0]!.policyReason).toContain("not propose");

    await admin.scopes.enable({ hostId: "h1", operations: ["investigate", "propose"] });
    const job = await jobs.create({
      title: "Keep upgrades off",
      steps: [step],
      requestedBy: "agent",
    });
    expect(job.status).toBe("awaiting-approval");
    const settings = job.steps[0]!.change!.settings;
    expect(
      settings.some(
        (s) =>
          s.name.startsWith("Next sync, hd-bluray-web: Upgrade Allowed") &&
          s.after === "With it: False",
      ),
    ).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe(CONFIG);
    // The checks ran on copies in the container's /tmp, all removed again.
    expect(configs.size).toBe(0);

    await jobs.decide(job.id, "approve", job.approval!.fingerprint);
    await jobs.idle();
    const done = await jobs.get(job.id);
    expect(done.status).toBe("succeeded");
    expect(done.steps[0]!.result).toContain("verified by reading it back");
    expect(await fs.readFile(file, "utf8")).toContain("upgrade:\n          allowed: false");
    const dirsMade = await fs.readdir(path.join(backups, "recyclarr"));
    expect(dirsMade).toHaveLength(1);
    expect(dirsMade[0]).toMatch(/^\d{8}-\d{6}-dragon-control-edit$/);
    expect(
      await fs.readFile(path.join(backups, "recyclarr", dirsMade[0]!, "recyclarr.yml"), "utf8"),
    ).toBe(CONFIG);

    // The sync applies it; Recyclarr's own preview right after shows nothing left to change.
    state.radarrUpgrades = "True"; // as the nightly sync had left it
    const sync = await jobs.create({
      title: "Apply it now",
      steps: [{ kind: "app-recyclarr-sync", serviceId: "recyclarr" }],
      requestedBy: "agent",
    });
    await jobs.decide(sync.id, "approve", sync.approval!.fingerprint);
    await jobs.idle();
    const synced = await jobs.get(sync.id);
    expect(synced.steps[0]!.result).toContain("Verified");
    expect(state.radarrUpgrades).toBe("False");
  });

  it("refuses when the file changed after approval; protected targets become protected changes", async () => {
    const { admin, jobs, file, root } = await setup();
    await admin.scopes.enable({ hostId: "h1", operations: ["investigate", "propose"] });
    const edits = JSON.stringify([{ find: "enabled: true", replace: "enabled: false" }]);
    const job = await jobs.create({
      title: "Edit",
      steps: [{ kind: "config-edit", serviceId: "recyclarr", params: { path: fwd(file), edits } }],
      requestedBy: "agent",
    });
    await fs.appendFile(file, "# someone else\n");
    await jobs.decide(job.id, "approve", job.approval!.fingerprint);
    await jobs.idle();
    const after = await jobs.get(job.id);
    expect(after.steps[0]!.result).toContain("changed since this plan was approved");
    expect(await fs.readFile(file, "utf8")).toContain("enabled: true");

    const gl = path.join(root, "gluetun");
    await fs.mkdir(gl);
    await fs.writeFile(path.join(gl, "config.yml"), "server_countries: Canada\n");
    const p = await admin.config.plan(
      {
        kind: "config-edit",
        serviceId: "recyclarr",
        params: {
          path: fwd(path.join(gl, "config.yml")),
          edits: JSON.stringify([
            { find: "server_countries: Canada", replace: "server_countries: Iceland" },
          ]),
        },
      },
      "agent",
    );
    // A protected file: planned, marked protected, approved with "it's you".
    expect(p.policy).toBe("approve-first");
    expect(p.params?.protected).toBe("yes");
    expect(p.policyReason).toContain("protected");

    const compose = path.join(root, "compose.yml");
    await fs.writeFile(compose, "services:\n  radarr:\n    ports:\n      - 7878:7878\n");
    const c = await admin.config.plan(
      {
        kind: "config-edit",
        serviceId: "recyclarr",
        params: {
          path: fwd(compose),
          edits: JSON.stringify([{ find: "- 7878:7878", replace: "- 7879:7878" }]),
        },
      },
      "agent",
    );
    expect(c.policy).toBe("approve-first");
    expect(c.params).toMatchObject({ protected: "yes", apply: "compose" });
    expect(c.policyReason).toContain("networking");
    expect(c.change?.settings.at(-1)?.after).toContain("Recreate");
  });

  it("guards Compose changes: what a container may newly reach is refused or needs you", async () => {
    const { admin, root } = await setup();
    await admin.scopes.enable({ hostId: "h1", operations: ["investigate", "propose"] });
    const compose = path.join(root, "media", "compose.yml");
    await fs.mkdir(path.dirname(compose), { recursive: true });
    await fs.writeFile(
      compose,
      "services:\n  sonarr:\n    image: lscr.io/linuxserver/sonarr:4.0.10\n    volumes:\n      - /srv/media/tv:/tv\n",
    );
    const plan = (find: string, replace: string) =>
      admin.config.plan(
        {
          kind: "config-edit",
          serviceId: "recyclarr",
          params: { path: fwd(compose), edits: JSON.stringify([{ find, replace }]) },
        },
        "agent",
      );
    process.env.DC_HOMELAB_ROOTS = "/srv/media";
    try {
      // An image update: Compose's own view of the change, nothing for the guard.
      const update = await plan("sonarr:4.0.10", "sonarr:4.0.11");
      expect(update.params?.protected).toBeUndefined();
      // Not protected, but still recreated, checked, and put back if it does not come up.
      expect(update.params?.apply).toBe("compose");
      expect(update.change?.settings.map((x) => x.after)).toContain(
        "Image: lscr.io/linuxserver/sonarr:4.0.10 to lscr.io/linuxserver/sonarr:4.0.11",
      );
      expect(update.change?.summary).toContain("Compose accepts the changed file");

      // A new folder inside the homelab: fine. Outside it: needs you.
      const inside = await plan(
        "      - /srv/media/tv:/tv",
        "      - /srv/media/tv:/tv\n      - /srv/media/anime:/anime",
      );
      expect(inside.params?.protected).toBeUndefined();
      const outside = await plan(
        "      - /srv/media/tv:/tv",
        "      - /srv/media/tv:/tv\n      - /opt/other:/other",
      );
      expect(outside.params?.protected).toBe("yes");
      expect(outside.change?.settings.map((x) => x.after).join(" ")).toMatch(
        /\/opt\/other mounted at \/other: outside your homelab folders/,
      );

      // Secrets, the whole machine: refused outright, with the reason.
      const secret = await plan(
        "      - /srv/media/tv:/tv",
        "      - /srv/media/tv:/tv\n      - /srv/media/secrets.env:/steal",
      );
      expect(secret.policy).toBe("refuse");
      expect(secret.policyReason).toMatch(
        /Refused: sonarr would get .* Hearth never gives a container that/,
      );
      const whole = await plan("      - /srv/media/tv:/tv", "      - /:/host");
      expect(whole.policy).toBe("refuse");
      expect(whole.policyReason).toMatch(/whole machine/);

      // Full host access needs you; a file Compose rejects is never planned.
      const priv = await plan("    image:", "    privileged: true\n    image:");
      expect(priv.params?.protected).toBe("yes");
      const broken = await plan("services:", "BROKEN services:");
      expect(broken.policy).toBe("refuse");
      expect(broken.policyReason).toMatch(/Compose rejects/);

      // The same view, read only, for Ember.
      const seen = await admin.config.composeInspect(fwd(compose));
      expect(seen).toMatchObject({ valid: true, homelabFolders: ["/srv/media"] });
    } finally {
      delete process.env.DC_HOMELAB_ROOTS;
    }
  });

  it("records a missing capability with its task, and finds utilities on the PATH", async () => {
    const { admin } = await setup();
    const gap = await admin.capabilities.recordGap({
      name: "mediainfo",
      kind: "utility",
      gap: "missing-capability",
      task: "Compare duplicate episode files for Colony",
      conversationId: "c1",
    });
    expect(gap).toMatchObject({
      status: "missing",
      gap: "missing-capability",
      conversationId: "c1",
    });
    const list = await admin.capabilities.detect("h1");
    expect(list.find((c) => c.name === "mediainfo")?.task).toBe(
      "Compare duplicate episode files for Colony",
    );
    expect(list.some((c) => c.name === "ffprobe")).toBe(true);
  });
});

describe("the Recyclarr panel", () => {
  it("reads the last run from Recyclarr's log, and previews a sync without changing anything", async () => {
    const { admin, state } = await setup();
    await expect(admin.config.recyclarrPanel("recyclarr", false)).rejects.toThrow(/switched off/);
    await admin.scopes.enable({ hostId: "h1", operations: ["investigate"] });
    expect((await admin.config.recyclarrPanel("recyclarr", false)).lastRun).toBeNull();
    const p = await admin.config.recyclarrPanel("recyclarr", true);
    expect(p.preview).toMatchObject({
      ok: true,
      changes: [
        { instance: "hd-bluray-web", setting: "Upgrade Allowed", from: "False", to: "True" },
      ],
    });
    // A preview changes nothing in Radarr.
    expect(state.radarrUpgrades).toBe("False");
    const again = await admin.config.recyclarrPanel("recyclarr", false);
    expect(again.lastRun?.set[0]).toMatchObject({ instance: "hd-bluray-web", to: "True" });
    expect(JSON.stringify(again)).not.toMatch(/abcdef0123456789/);
  });
});
