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

/** The Gluetun panel's read: state, server, exit address, what routes through it; no keys. */

const handles: DbHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
const fwd = (p: string) => p.replaceAll("\\", "/");

const SERVERS = {
  version: 1,
  servers: [
    {
      vpn: "wireguard",
      country: "Canada",
      city: "Toronto",
      server_name: "CA#12",
      hostname: "ca-12.protonvpn.net",
      wgpubkey: "PUBKEY-ca12",
      ips: ["10.9.9.12"],
      port_forward: true,
    },
    {
      vpn: "wireguard",
      country: "United States",
      city: "Los Angeles",
      server_name: "US-CA#149",
      hostname: "us-ca-149.protonvpn.net",
      wgpubkey: "PUBKEY-us149",
      ips: ["10.9.9.149"],
      stream: true,
    },
  ],
};

async function setup() {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  handles.push(handle);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dc-vpn-")));
  dirs.push(root);
  const compose = path.join(root, "docker", "compose", "gluetun", "compose.yaml");
  await fs.mkdir(path.dirname(compose), { recursive: true });
  await fs.writeFile(
    compose,
    "services:\n  gluetun:\n    image: qmcgaw/gluetun\n    environment:\n      - WIREGUARD_ENDPOINT_IP=10.9.9.12\n      - WIREGUARD_PRIVATE_KEY=never-read\n",
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
  await handle.db.insert(t.services).values({
    id: "gluetun",
    name: "Gluetun",
    category: "network",
    hostId: "h1",
    kind: "container",
    image: "qmcgaw/gluetun:latest",
    health: "healthy",
    autonomyArea: "network",
    checkTarget: "container:gluetun",
  });
  const exec: ContainerExec = {
    async putFile() {},
    async exec(_c, cmd) {
      if (cmd[0] === "cat") return { exitCode: 0, output: JSON.stringify(SERVERS) };
      if (cmd[0] === "wget") return { exitCode: 0, output: "203.0.113.7\n" };
      return { exitCode: 1, output: "" };
    },
  };
  const runner = {
    containerTools: {
      async mounts() {
        return [];
      },
    } as unknown as ContainerTools,
    async policyFor() {
      return { decision: { outcome: "allow", reason: "" } };
    },
  } as unknown as ActionRunner;
  const admin = createAdmin(handle, runner, {
    backupRoot: path.join(root, "backups"),
    rules: { secretRoots: [fwd(path.join(root, "dc-data"))] },
    exec,
    run: async (cmd, args) => {
      if (cmd !== "docker") return { code: 1, out: "" };
      if (args[0] === "ps") return { code: 0, out: "gluetun\nqbittorrent\nprowlarr\nplex\n" };
      if (
        args[0] === "inspect" &&
        args.includes('{{index .Config.Labels "com.docker.compose.project.config_files"}}')
      )
        return { code: 0, out: `${fwd(compose)}\n` };
      if (args[0] === "inspect" && args[2]?.startsWith("{{.Id}}"))
        return { code: 0, out: "abc123|running|healthy|2026-10-19T08:00:00Z|2\n" };
      if (args[0] === "inspect" && args[2]?.startsWith("{{.Name}}"))
        return {
          code: 0,
          out: "/gluetun|default\n/qbittorrent|container:abc123\n/prowlarr|container:abc123\n/plex|host\n",
        };
      return { code: 0, out: "" };
    },
  });
  return { handle, admin, root };
}

describe("the Gluetun panel", () => {
  it("shows the VPN's state, server, exit address, and the containers routed through it", async () => {
    const { admin } = await setup();
    await expect(admin.config.vpnPanel("gluetun")).rejects.toThrow(/switched off/);
    await admin.scopes.enable({ hostId: "h1", operations: ["investigate"] });
    const v = await admin.config.vpnPanel("gluetun");
    expect(v).toMatchObject({
      container: "gluetun",
      status: "running",
      health: "healthy",
      restarts: 2,
      exitAddress: "203.0.113.7",
      current: { ip: "10.9.9.12", name: "CA#12", city: "Toronto", country: "Canada" },
      routed: ["prowlarr", "qbittorrent"],
    });
    expect(v.servers).toEqual([
      { name: "CA#12", country: "Canada", city: "Toronto", portForward: true, streaming: false },
      {
        name: "US-CA#149",
        country: "United States",
        city: "Los Angeles",
        portForward: false,
        streaming: true,
      },
    ]);
    expect(JSON.stringify(v)).not.toMatch(/PUBKEY|never-read/);
  });
});
