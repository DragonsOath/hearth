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
import { createAdmin } from ".";
import type { ContainerExec } from "./docker-exec";

/**
 * The Caddy panel's Observe and Manage, apart: its sites read without host administration when
 * Caddy's admin API is reachable from this machine, and the form's blockers named precisely
 * (host administration, a missing Caddyfile, a file Hearth's account cannot read).
 */

const handles: DbHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

const CONFIG = {
  apps: {
    http: {
      servers: {
        srv0: {
          listen: [":443"],
          routes: [
            {
              match: [{ host: ["photos.example.com"] }],
              handle: [
                {
                  handler: "subroute",
                  routes: [
                    {
                      handle: [
                        { handler: "reverse_proxy", upstreams: [{ dial: "10.0.0.5:2283" }] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  },
};

async function setup(opts: {
  networkMode?: string;
  running?: boolean;
  mount?: "readable" | "missing" | "unreadable";
}) {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  handles.push(handle);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dc-caddy-")));
  dirs.push(root);
  const caddyfile = path.join(root, "caddy", "Caddyfile");
  await fs.mkdir(path.dirname(caddyfile), { recursive: true });
  await fs.writeFile(caddyfile, "photos.example.com {\n\treverse_proxy 10.0.0.5:2283\n}\n");
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
    id: "caddy",
    name: "Caddy",
    category: "network",
    hostId: "h1",
    kind: "container",
    image: "caddy:2",
    health: "healthy",
    autonomyArea: "network",
    checkTarget: "container:caddy",
  });
  const execCalls: string[][] = [];
  const exec: ContainerExec = {
    async putFile() {},
    async exec(_c, cmd) {
      execCalls.push(cmd);
      if (cmd[0] === "wget") return { exitCode: 0, output: JSON.stringify(CONFIG) };
      return { exitCode: 1, output: "" };
    },
  };
  const source = opts.mount === "unreadable" ? path.join(root, "nowhere", "Caddyfile") : caddyfile;
  const runner = {
    containerTools: {
      async runtime() {
        return { running: opts.running ?? true, restartCount: 0 };
      },
      async config() {
        return { networks: [], networkMode: opts.networkMode ?? "host" };
      },
      async mounts() {
        return opts.mount === "missing" ? [] : [{ source, destination: "/etc/caddy/Caddyfile" }];
      },
      async logs() {
        return [
          `2026-10-20T08:00:00Z {"level":"error","ts":1760947200,"msg":"dial tcp: connection refused","request":{"host":"photos.example.com"}}`,
        ];
      },
    } as unknown as ContainerTools,
    async policyFor() {
      return { decision: { outcome: "allow", reason: "" } };
    },
  } as unknown as ActionRunner;
  const admin = createAdmin(handle, runner, {
    backupRoot: path.join(root, "backups"),
    rules: { secretRoots: [path.join(root, "dc-data").replaceAll("\\", "/")] },
    exec,
    run: async () => ({ code: 0, out: "" }),
  });
  let apiCalls = 0;
  admin.config.caddyApi = async () => {
    apiCalls += 1;
    return CONFIG;
  };
  admin.config.probes = {
    local: async () => true,
    through: async () => ({ ok: true, certExpires: "2026-12-01T00:00:00.000Z" }),
  };
  return { admin, execCalls, apiCalls: () => apiCalls, caddyfile };
}

describe("the Caddy panel, Observe", () => {
  it("shows every site with host administration off, from Caddy's own API, running nothing in the container", async () => {
    const { admin, execCalls, apiCalls } = await setup({});
    const p = await admin.config.caddyPanel("caddy");
    expect(p.readVia).toBe("caddy-api");
    expect(apiCalls()).toBe(1);
    expect(execCalls).toEqual([]);
    expect(p.sites).toMatchObject([
      {
        hosts: ["photos.example.com"],
        upstreams: ["10.0.0.5:2283"],
        works: true,
        localUp: true,
        certExpires: "2026-12-01T00:00:00.000Z",
      },
    ]);
    expect(p.certificates).toBe(1);
    expect(p.errors[0]!.text).toMatch(/photos\.example\.com: dial tcp/);
    // Manage is reported apart: host administration, offered as the host-wide permission it is.
    expect(p.manage).toMatchObject({
      ok: false,
      blocker: {
        kind: "host-admin",
        host: { id: "h1", name: "Homeserver" },
        operations: ["investigate", "propose"],
      },
    });
    if (!p.manage.ok)
      expect(p.manage.blocker.detail).toMatch(/whole of Homeserver, not only this app/);
  });

  it("asks for host administration only when there is no narrower way in", async () => {
    const { admin, execCalls } = await setup({ networkMode: "bridge" });
    const err = await admin.config.caddyPanel("caddy").catch((e: unknown) => e);
    expect(err).toMatchObject({
      message: expect.stringMatching(/inside its own network/),
      blocker: { kind: "host-admin", operations: ["investigate"] },
    });
    expect(execCalls).toEqual([]);
    await admin.scopes.enable({ hostId: "h1", operations: ["investigate"] });
    const p = await admin.config.caddyPanel("caddy");
    expect(p.readVia).toBe("container");
    expect(p.sites).toHaveLength(1);
  });

  it("says Caddy is not running, not that it cannot be read", async () => {
    const { admin } = await setup({ running: false });
    await expect(admin.config.caddyPanel("caddy")).rejects.toMatchObject({
      message: expect.stringMatching(/not running/),
      blocker: { kind: "service-down" },
    });
  });
});

describe("the Caddy panel, Manage", () => {
  it("names a missing Caddyfile and a file Hearth's account cannot read, apart from permissions", async () => {
    const missing = await setup({ mount: "missing" });
    await missing.admin.scopes.enable({ hostId: "h1", operations: ["investigate", "propose"] });
    expect((await missing.admin.config.caddyPanel("caddy")).manage).toMatchObject({
      ok: false,
      blocker: { kind: "missing-config" },
    });

    const unreadable = await setup({ mount: "unreadable" });
    await unreadable.admin.scopes.enable({ hostId: "h1", operations: ["investigate", "propose"] });
    const p = await unreadable.admin.config.caddyPanel("caddy");
    expect(p.sites).toHaveLength(1);
    expect(p.manage).toMatchObject({
      ok: false,
      blocker: { kind: "file-access", access: "read", account: os.userInfo().username },
    });
    await expect(
      unreadable.admin.config.caddySiteEdits("caddy", {
        op: "add",
        site: "books.example.com",
        upstream: "10.0.0.6:13378",
      }),
    ).rejects.toMatchObject({ blocker: { kind: "file-access" } });
  });

  it("is ready when allowed and the file is reachable", async () => {
    const { admin, caddyfile } = await setup({});
    await admin.scopes.enable({ hostId: "h1", operations: ["investigate", "propose"] });
    const p = await admin.config.caddyPanel("caddy");
    expect(p.manage).toMatchObject({ ok: true, path: caddyfile });
    const edits = await admin.config.caddySiteEdits("caddy", {
      op: "add",
      site: "books.example.com",
      upstream: "10.0.0.6:13378",
    });
    expect(edits.path).toBe(caddyfile);
    expect(edits.edits).toMatch(/books\.example\.com/);
  });
});
