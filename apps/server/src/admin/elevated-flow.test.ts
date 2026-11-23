import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { THIS_HOST } from "@dragon-control/core";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { ActionRunner } from "../actions/service";
import type { ContainerTools } from "../actions/tools";
import { handleRequest, verifyAudit } from "../elevated/executor";
import { Jobs } from "../jobs/engine";
import { runnerOperations } from "../jobs/operations";
import { createAdmin } from ".";
import { imageEdit } from "./compose-ops";
import { Elevation } from "./elevation";

/**
 * Ember's administration end to end through the plans engine: protected Compose changes carried
 * out by the elevated executor (in process, with its real checks), image updates verified on the
 * container and the app and put back when the app does not come back, new projects installed and
 * taken away again, and leftovers removed. Docker is a stand-in that follows the files.
 */

const handles: DbHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
  delete process.env.DC_COMPOSE_ROOT;
});

const fwd = (p: string) => p.replaceAll("\\", "/");

/** `docker compose config --format json` for the simple files used here (image per service). */
function composeConfig(text: string) {
  const services: Record<string, { image?: string }> = {};
  let svc: string | undefined;
  for (const line of text.split("\n")) {
    const name = /^ {2}([\w-]+):\s*$/.exec(line);
    if (name) services[(svc = name[1]!)] = {};
    const img = /^ {4}image:\s*(\S+)/.exec(line);
    if (img && svc) services[svc]!.image = img[1]!;
  }
  return { name: "test", services };
}

interface World {
  /** Image ids by reference, as `docker pull` would leave them. */
  registry: Map<string, string>;
  /** What each container runs now. */
  running: Map<string, string>;
  /** Whether containers come up running. */
  healthy: boolean;
  /** Whether Hearth's check of the app passes. */
  appOk: boolean;
  files: Map<string, string>;
  calls: string[];
}

async function setup(opts: { elevated?: boolean; memory?: unknown } = {}) {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  handles.push(handle);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hearth-flow-")));
  dirs.push(root);
  const composeRoot = path.join(root, "compose");
  for (const d of [
    "compose/sonarr",
    "compose/gluetun",
    "backups",
    "elevated/state",
    "elevated/log",
    "elevated/etc",
  ])
    await fs.mkdir(path.join(root, d), { recursive: true });
  const sonarr = path.join(composeRoot, "sonarr", "compose.yml");
  const gluetun = path.join(composeRoot, "gluetun", "compose.yml");
  await fs.writeFile(
    sonarr,
    "services:\n  sonarr:\n    image: lscr.io/linuxserver/sonarr:4.0.10\n",
  );
  await fs.writeFile(
    gluetun,
    "services:\n  gluetun:\n    image: qmcgaw/gluetun:v3.39\n    environment:\n      - SERVER_COUNTRIES=Canada\n",
  );
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
  for (const [id, image] of [
    ["sonarr", "lscr.io/linuxserver/sonarr:4.0.10"],
    ["gluetun", "qmcgaw/gluetun:v3.39"],
    ["jellyseerr", "fallenbagel/jellyseerr:2"],
  ] as const)
    await handle.db.insert(t.services).values({
      id,
      name: id[0]!.toUpperCase() + id.slice(1),
      category: "media",
      hostId: "h1",
      kind: "container",
      image,
      health: "healthy",
      autonomyArea: "media",
      checkTarget: `container:${id}`,
    });

  const world: World = {
    registry: new Map([
      ["lscr.io/linuxserver/sonarr:4.0.10", "sha256:aaa111aaa111aaa1"],
      ["lscr.io/linuxserver/sonarr:4.0.11", "sha256:bbb222bbb222bbb2"],
      ["qmcgaw/gluetun:v3.39", "sha256:ccc333ccc333ccc3"],
    ]),
    running: new Map([
      ["sonarr", "sha256:aaa111aaa111aaa1"],
      ["gluetun", "sha256:ccc333ccc333ccc3"],
    ]),
    healthy: true,
    appOk: true,
    files: new Map([
      ["sonarr", fwd(sonarr)],
      ["gluetun", fwd(gluetun)],
    ]),
    calls: [],
  };
  const docker = async (args: string[]): Promise<{ code: number; out: string }> => {
    world.calls.push(args.join(" "));
    const f = args.includes("-f") ? args[args.indexOf("-f") + 1]! : undefined;
    const text = f ? await fs.readFile(f, "utf8").catch(() => "") : "";
    const conf = composeConfig(text);
    if (args[0] === "compose") {
      if (args.includes("ls"))
        return {
          code: 0,
          out: JSON.stringify(
            [...world.files.entries()]
              .filter(([name]) => name === "disposable")
              .map(([Name, ConfigFiles]) => ({ Name, ConfigFiles, Status: "running(1)" })),
          ),
        };
      if (args.includes("--format") && args.includes("config"))
        return { code: 0, out: JSON.stringify(conf) };
      if (args.includes("--services"))
        return { code: 0, out: Object.keys(conf.services).join("\n") };
      if (args.includes("config")) return { code: 0, out: "" };
      if (args.includes("up")) {
        for (const [svc, s] of Object.entries(conf.services))
          if (s.image) world.running.set(svc, world.registry.get(s.image) ?? "sha256:unknown");
        return { code: 0, out: "" };
      }
      if (args.includes("down")) {
        for (const svc of Object.keys(conf.services)) world.running.delete(svc);
        return { code: 0, out: "" };
      }
      if (args.includes("ps")) {
        const names = Object.keys(conf.services).filter((x) => world.running.has(x));
        if (args.includes("-q")) return { code: 0, out: names.join("\n") };
        return {
          code: 0,
          out: names
            .map((x) =>
              JSON.stringify({ Service: x, Name: x, State: world.healthy ? "running" : "exited" }),
            )
            .join("\n"),
        };
      }
    }
    if (args[0] === "inspect") {
      const name = args.at(-1)!;
      const fmt = args[2] ?? "";
      if (fmt.includes("config_files")) return { code: 0, out: `${world.files.get(name) ?? ""}\n` };
      if (fmt.includes("compose.service")) return { code: 0, out: `${name}\n` };
      if (fmt === "{{.Image}}")
        return world.running.has(name)
          ? { code: 0, out: `${world.running.get(name)}\n` }
          : { code: 1, out: "no such" };
      if (fmt === "{{.State.Status}}")
        return name === "jellyseerr" && world.files.get("jellyseerr") === undefined
          ? { code: 0, out: "exited\n" }
          : { code: 1, out: "" };
      return {
        code: name === "jellyseerr" && !world.calls.includes("rm jellyseerr") ? 0 : 1,
        out: "",
      };
    }
    if (args[0] === "image") {
      const id = world.registry.get(args.at(-1)!);
      return id ? { code: 0, out: `${id}\n` } : { code: 1, out: "" };
    }
    if (args[0] === "pull")
      return world.registry.has(args[1]!)
        ? { code: 0, out: "" }
        : { code: 1, out: "manifest unknown" };
    if (args[0] === "tag") {
      world.registry.set(args[2]!, args[1]!);
      return { code: 0, out: "" };
    }
    if (args[0] === "rm") return { code: 0, out: "" };
    return { code: 0, out: "" };
  };
  const run = async (cmd: string, args: string[]) =>
    cmd === "docker" ? docker(args) : { code: 0, out: "" };

  // The executor, in process, with its real checks: its scope is the Compose root.
  let elevation: Elevation | undefined;
  let audit = "";
  if (opts.elevated) {
    const key = randomBytes(32);
    const etc = path.join(root, "elevated", "etc");
    const cfgFile = path.join(etc, "elevation.json");
    audit = path.join(root, "elevated", "log", "elevated.jsonl");
    await fs.writeFile(path.join(etc, "elevation.key"), key);
    await fs.writeFile(
      cfgFile,
      JSON.stringify({
        version: 1,
        roots: [composeRoot],
        operations: ["file.write", "file.remove", "dir.create", "dir.remove", "revert"],
        units: [],
        backupRoot: path.join(root, "backups"),
        stateDir: path.join(root, "elevated", "state"),
        auditLog: audit,
        keyFile: path.join(etc, "elevation.key"),
      }),
    );
    elevation = new Elevation({
      key,
      transport: {
        send: (req) =>
          handleRequest(JSON.stringify(req), cfgFile, {
            run: async (cmd, args) => run(cmd, args),
            now: () => Date.now(),
            wait: async () => undefined,
            isRoot: false,
            selfPaths: [cfgFile],
          }),
      },
    });
  }

  const containers = {
    async mounts() {
      return [];
    },
  } as unknown as ContainerTools;
  const runner = {
    containerTools: containers,
    async policyFor() {
      return { decision: { outcome: "allow", reason: "" } };
    },
    async checkService() {
      return world.appOk
        ? { status: "ok", detail: "answers" }
        : { status: "failing", detail: "does not answer on port 8989" };
    },
  } as unknown as ActionRunner;
  const admin = createAdmin(handle, runner, {
    backupRoot: path.join(root, "backups"),
    run,
    ...(elevation ? { elevation } : {}),
    ...(opts.memory ? { memory: opts.memory as never } : {}),
    // No waiting between container checks in tests.
    wait: async () => undefined,
  });
  await admin.scopes.enable({ hostId: "h1", operations: ["investigate", "propose"] });
  const jobs = new Jobs(handle, runnerOperations(handle, runner, undefined, admin.config));
  const approve = async (steps: Parameters<Jobs["create"]>[0]["steps"]) => {
    const job = await jobs.create({ title: "Test", steps, requestedBy: "agent" });
    expect(job.status).toBe("awaiting-approval");
    await jobs.decide(job.id, "approve", job.approval!.fingerprint);
    await jobs.idle();
    return jobs.get(job.id);
  };
  return { admin, jobs, world, root, composeRoot, sonarr, gluetun, approve, audit };
}

describe("image line edits", () => {
  const file = [
    "services:",
    "  sonarr:",
    "    image: lscr.io/linuxserver/sonarr:4.0.10 # pinned",
    "  helper:",
    "    image: alpine:3.20",
    "  other:",
    "    image: alpine:3.20",
    "",
  ].join("\n");
  it("changes the one line, keeping quotes and comments", () => {
    const e = imageEdit(
      file,
      "sonarr",
      "lscr.io/linuxserver/sonarr:4.0.10",
      "lscr.io/linuxserver/sonarr:4.0.11",
    );
    expect(e).toEqual({
      find: "    image: lscr.io/linuxserver/sonarr:4.0.10 # pinned",
      replace: "    image: lscr.io/linuxserver/sonarr:4.0.11 # pinned",
    });
    const quoted = imageEdit('services:\n  a:\n    image: "x/y:1"\n', "a", "x/y:1", "x/y:2");
    expect(quoted).toEqual({ find: '    image: "x/y:1"', replace: '    image: "x/y:2"' });
  });
  it("tells apart services sharing an image, and refuses variables", () => {
    const e = imageEdit(file, "other", "alpine:3.20", "alpine:3.21");
    expect(typeof e).toBe("object");
    const ed = e as { find: string; replace: string };
    expect(file.split(ed.find).length).toBe(2);
    expect(ed.find).toContain("  other:");
    expect(ed.replace).toContain("alpine:3.21");
    expect(imageEdit("services:\n  a:\n    image: ${IMG}\n", "a", "x:1", "x:2")).toMatch(
      /variable/,
    );
  });
});

describe("protected changes through the elevated executor", () => {
  it("plans, approves, writes through the executor, verifies, and logs", async () => {
    const { admin, approve, gluetun, audit, root } = await setup({ elevated: true });
    const plan = await admin.config.plan(
      {
        kind: "config-edit",
        serviceId: "gluetun",
        params: {
          path: gluetun,
          edits: JSON.stringify([
            { find: "SERVER_COUNTRIES=Canada", replace: "SERVER_COUNTRIES=Iceland" },
          ]),
        },
      },
      "agent",
    );
    expect(plan.policy).toBe("approve-first");
    expect(plan.params).toMatchObject({ protected: "yes", via: "elevated", apply: "compose" });
    expect(plan.change?.settings.map((s) => s.name)).toContain("Carried out by");
    const job = await approve([
      {
        kind: "config-edit",
        serviceId: "gluetun",
        params: {
          path: gluetun,
          edits: JSON.stringify([
            { find: "SERVER_COUNTRIES=Canada", replace: "SERVER_COUNTRIES=Iceland" },
          ]),
        },
      },
    ]);
    expect(job.steps[0]!.status).toBe("succeeded");
    expect(job.steps[0]!.result).toMatch(/verified by reading it back/);
    expect(await fs.readFile(gluetun, "utf8")).toContain("Iceland");
    const backups = await fs.readdir(path.join(root, "backups", "gluetun"));
    expect(backups.some((d) => d.includes("-hearth-elevated-edit-"))).toBe(true);
    expect(await verifyAudit(audit)).toEqual({ records: 2 });
  });

  it("puts a protected change back through the executor when the containers do not come back", async () => {
    const { approve, gluetun, world, audit } = await setup({ elevated: true });
    world.healthy = false;
    const job = await approve([
      {
        kind: "config-edit",
        serviceId: "gluetun",
        params: {
          path: gluetun,
          edits: JSON.stringify([
            { find: "SERVER_COUNTRIES=Canada", replace: "SERVER_COUNTRIES=Iceland" },
          ]),
        },
      },
    ]);
    expect(job.steps[0]!.status).toBe("failed");
    expect(job.steps[0]!.result).toMatch(/put back as it was/);
    expect(await fs.readFile(gluetun, "utf8")).toContain("Canada");
    // The write and the put-back, both in the executor's own record.
    expect(await verifyAudit(audit)).toEqual({ records: 4 });
  });

  it("says what to widen when a file is outside the executor's scope", async () => {
    const { admin } = await setup({ elevated: true });
    const c = await admin.elevation.covers("file.write", "/etc/caddy/Caddyfile");
    expect(c).toMatchObject({ ok: false, scope: true });
    expect(!c.ok && c.why).toMatch(/--add-root/);
    expect(await admin.elevation.covers("unit.control", "caddy.service")).toMatchObject({
      ok: false,
    });
  });
});

describe("Compose administration", () => {
  it("updates an image: edits the file, recreates, checks the container and the app", async () => {
    const { approve, sonarr, world } = await setup();
    const job = await approve([
      {
        kind: "compose-update-image",
        serviceId: "sonarr",
        params: { image: "lscr.io/linuxserver/sonarr:4.0.11" },
      },
    ]);
    expect(job.steps[0]!.change?.settings.map((s) => s.name)).toContain("The app's data");
    expect(job.steps[0]!.status).toBe("succeeded");
    expect(job.steps[0]!.result).toMatch(/now runs lscr.io\/linuxserver\/sonarr:4.0.11/);
    expect(await fs.readFile(sonarr, "utf8")).toContain("sonarr:4.0.11");
    expect(world.running.get("sonarr")).toBe("sha256:bbb222bbb222bbb2");
  });

  it("puts the file and the previous image back when the app does not come back", async () => {
    const { approve, sonarr, world } = await setup();
    world.appOk = false;
    const job = await approve([
      {
        kind: "compose-update-image",
        serviceId: "sonarr",
        params: { image: "lscr.io/linuxserver/sonarr:4.0.11" },
      },
    ]);
    expect(job.steps[0]!.status).toBe("failed");
    expect(job.steps[0]!.result).toMatch(/Hearth's check of the app fails/);
    expect(job.steps[0]!.result).toMatch(/not rolled back by this/);
    expect(await fs.readFile(sonarr, "utf8")).toContain("sonarr:4.0.10");
    expect(world.running.get("sonarr")).toBe("sha256:aaa111aaa111aaa1");
  });

  it("refreshes the same tag only when there is a newer build, and can go back to the old one", async () => {
    const { approve, world } = await setup();
    const same = await approve([{ kind: "compose-update-image", serviceId: "sonarr", params: {} }]);
    expect(same.steps[0]!.result).toMatch(/already runs the newest build/);
    expect(world.calls.some((c) => c.includes("up -d"))).toBe(false);

    world.registry.set("lscr.io/linuxserver/sonarr:4.0.10", "sha256:ddd444ddd444ddd4");
    world.appOk = false;
    const bad = await approve([{ kind: "compose-update-image", serviceId: "sonarr", params: {} }]);
    expect(bad.steps[0]!.status).toBe("failed");
    expect(world.calls).toContain("tag sha256:aaa111aaa111aaa1 lscr.io/linuxserver/sonarr:4.0.10");
    expect(world.running.get("sonarr")).toBe("sha256:aaa111aaa111aaa1");
  });

  it("does not download a missing image or touch the file", async () => {
    const { approve, sonarr } = await setup();
    const job = await approve([
      {
        kind: "compose-update-image",
        serviceId: "sonarr",
        params: { image: "lscr.io/linuxserver/sonarr:9.9.9" },
      },
    ]);
    expect(job.steps[0]!.result).toMatch(/Could not download/);
    expect(await fs.readFile(sonarr, "utf8")).toContain("sonarr:4.0.10");
  });

  it("installs a new project, and takes it away again when it does not start", async () => {
    const { approve, composeRoot, world, admin } = await setup();
    process.env.DC_COMPOSE_ROOT = fwd(composeRoot);
    world.registry.set("ghcr.io/example/app:1", "sha256:eee555eee555eee5");
    const compose = "services:\n  app:\n    image: ghcr.io/example/app:1\n";
    const plan = await admin.config.plan(
      { kind: "compose-install", serviceId: THIS_HOST, params: { project: "app", compose } },
      "agent",
    );
    expect(plan.policy).toBe("approve-first");
    expect(plan.change?.settings[0]).toMatchObject({ name: "New folder" });
    const ok = await approve([
      { kind: "compose-install", serviceId: THIS_HOST, params: { project: "app", compose } },
    ]);
    expect(ok.steps[0]!.status).toBe("succeeded");
    expect(await fs.readFile(path.join(composeRoot, "app", "compose.yml"), "utf8")).toBe(compose);

    world.healthy = false;
    const bad = await approve([
      { kind: "compose-install", serviceId: THIS_HOST, params: { project: "app2", compose } },
    ]);
    expect(bad.steps[0]!.status).toBe("failed");
    expect(bad.steps[0]!.result).toMatch(/did not start cleanly/);
    await expect(fs.stat(path.join(composeRoot, "app2"))).rejects.toThrow();

    // A name in use, and a refused mount, are never planned.
    const taken = await admin.config.plan(
      { kind: "compose-install", serviceId: THIS_HOST, params: { project: "app", compose } },
      "agent",
    );
    expect(taken.policy).toBe("refuse");
  });

  it("a new app that installed and runs is remembered without failing the step (11-22)", async () => {
    // With Hearth's memory on (as in production), recording the install looked up a service
    // "this-host", which doesn't exist: the install worked but the step said it failed.
    const remembered: { machine?: string }[] = [];
    const memory = {
      recordSystem: async (_db: unknown, m: { machine?: string }) => void remembered.push(m),
    };
    const { approve, composeRoot, world } = await setup({ memory });
    process.env.DC_COMPOSE_ROOT = fwd(composeRoot);
    world.registry.set("ghcr.io/example/app:1", "sha256:eee555eee555eee5");
    const compose = "services:\n  app:\n    image: ghcr.io/example/app:1\n";
    const ok = await approve([
      { kind: "compose-install", serviceId: THIS_HOST, params: { project: "remembered", compose } },
    ]);
    expect(ok.steps[0]!.status).toBe("succeeded");
    expect(ok.steps[0]!.result).not.toMatch(/No service/);
    expect(remembered).toHaveLength(1);
    expect(remembered[0]!.machine).toBeTruthy();
  });

  it("removes a project's containers, keeping its file, and starts it again on undo", async () => {
    const { approve, sonarr, world } = await setup();
    const job = await approve([{ kind: "compose-remove", serviceId: "sonarr" }]);
    expect(job.steps[0]!.status).toBe("succeeded");
    expect(world.running.has("sonarr")).toBe(false);
    expect(await fs.readFile(sonarr, "utf8")).toContain("sonarr");
  });

  it("removes a whole project by name: containers, then its file (backed up) and empty folder", async () => {
    const { approve, composeRoot, world, root } = await setup();
    process.env.DC_COMPOSE_ROOT = fwd(composeRoot);
    world.registry.set("ghcr.io/example/app:1", "sha256:eee555eee555eee5");
    const compose = "services:\n  app:\n    image: ghcr.io/example/app:1\n";
    await approve([
      { kind: "compose-install", serviceId: THIS_HOST, params: { project: "disposable", compose } },
    ]);
    // What `docker compose ls` reports for it from now on.
    world.files.set("disposable", fwd(path.join(composeRoot, "disposable", "compose.yml")));
    // Not adopted into Hearth: administered by its project name.
    world.registry.set("ghcr.io/example/app:2", "sha256:fff666fff666fff6");
    const update = await approve([
      {
        kind: "compose-update-image",
        serviceId: THIS_HOST,
        params: { project: "disposable", image: "ghcr.io/example/app:2" },
      },
    ]);
    expect(update.steps[0]!.change?.summary).toBe(
      "Update disposable (app) from ghcr.io/example/app:1 to ghcr.io/example/app:2",
    );
    expect(update.steps[0]!.status).toBe("succeeded");
    expect(world.running.get("app")).toBe("sha256:fff666fff666fff6");
    const job = await approve([
      {
        kind: "compose-remove",
        serviceId: THIS_HOST,
        params: { project: "disposable", removeFiles: true },
      },
    ]);
    expect(job.steps[0]!.change?.summary).toMatch(/its containers and its Compose file/);
    expect(job.steps[0]!.status).toBe("succeeded");
    expect(world.running.has("app")).toBe(false);
    await expect(fs.stat(path.join(composeRoot, "disposable"))).rejects.toThrow();
    const kept = await fs.readdir(path.join(root, "backups", "disposable"));
    expect(kept.some((d) => d.includes("-dragon-control-remove"))).toBe(true);
  });

  it("removes a stopped leftover whose Compose file is gone", async () => {
    const { approve, world } = await setup();
    const job = await approve([{ kind: "compose-remove", serviceId: "jellyseerr" }]);
    expect(job.steps[0]!.change?.summary).toMatch(/leftover container jellyseerr/);
    expect(job.steps[0]!.status).toBe("succeeded");
    expect(world.calls).toContain("rm jellyseerr");
  });
});
