import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeProxmox } from "./fake-proxmox";
import { forgetPins, isLocalHost, localTlsFetch } from "./local-tls";
import { ProxmoxClient, proxmoxDashboard, readProxmox, toTask } from "./proxmox";
import { ProxmoxOperations } from "./proxmox-control";

/**
 * Proxmox VE against the stand-in, which answers as Proxmox's own API code describes (no real
 * Proxmox can run here: it needs a machine of its own): the panel's reads, every change as a plan
 * read back, and the pinned connection to a self-signed certificate.
 */

const BASE = "https://10.0.0.9:8006";
const TOKEN = "root@pam!e2e=00000000-0000-0000-0000-000000000000";
const service = { id: "px", name: "Proxmox", localUrl: BASE };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

function setup() {
  const px = fakeProxmox();
  const broker = {
    use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: TOKEN }),
  } as unknown as CredentialBroker;
  const ops = new ProxmoxOperations(handle, broker, px.fetch, async () => undefined);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-proxmox-control" as const,
    serviceId: "px",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    return { planned, outcome: await ops.run(step(planned.params), service) };
  };
  const client = new ProxmoxClient(BASE, TOKEN, px.fetch);
  return { px, ops, go, step, client };
}

describe("reading Proxmox", () => {
  it("reads nodes, guests with their last backup, storage, jobs, and tasks in plain words", async () => {
    const { client } = setup();
    const d = await proxmoxDashboard(client);
    expect(d.version).toBe("9.1.1");
    expect(d.nodes[0]).toMatchObject({
      name: "pve",
      online: true,
      cpuPct: 18.4,
      cpus: 16,
      updates: 2,
    });
    expect(d.guests.map((g) => [g.id, g.kind, g.status])).toEqual([
      ["qemu/100", "vm", "running"],
      ["qemu/101", "vm", "stopped"],
      ["lxc/200", "container", "running"],
      ["qemu/9000", "vm", "stopped"],
    ]);
    expect(d.guests[0]).toMatchObject({ tags: ["home", "critical"], cpuPct: 5 });
    expect(d.guests[0]!.lastBackup).toBeTruthy();
    expect(d.guests[1]!.lastBackup).toBeUndefined();
    expect(d.guests[3]!.template).toBe(true);
    expect(d.storage.map((s) => s.id)).toEqual(["local", "local-lvm"]);
    expect(d.backupJobs[0]).toMatchObject({ guests: "all", schedule: "02:00" });
    expect(d.backups).toHaveLength(2);
    expect(d.tasks[0]).toMatchObject({ what: "Backup", ok: false, error: "job errors" });
    expect(
      toTask({
        upid: "u",
        node: "pve",
        type: "qmstart",
        id: "100",
        user: "root@pam",
        starttime: 1,
      }),
    ).toEqual({
      upid: "u",
      node: "pve",
      what: "Start",
      vmid: 100,
      user: "root@pam",
      started: new Date(1000).toISOString(),
    });
  });

  it("reports a failed backup and nearly full storage, and refuses a token that is not one", async () => {
    const { px } = setup();
    const r = await readProxmox(BASE, TOKEN, px.fetch);
    expect(r.facts).toEqual([
      { label: "Nodes", value: "1 of 1 online" },
      { label: "Running", value: "2 of 3 VMs and containers" },
      { label: "Failed tasks, 24 hours", value: "1" },
    ]);
    expect(r.issues.map((i) => i.key)).toEqual(["backup-failed", "storage-full"]);
    await expect(readProxmox(BASE, "just-a-password", px.fetch)).rejects.toThrow(
      /user@realm!tokenid=secret/,
    );
    await expect(readProxmox(BASE, "root@pam!other=x", px.fetch)).rejects.toThrow(
      /refused the API token/,
    );
  });
});

describe("changing Proxmox, each a plan read back", () => {
  it("starts, shuts down, restarts and force-stops, refusing what would change nothing", async () => {
    const { go, ops, px, step } = setup();
    const s = await go({ op: "start", guest: "qemu/101" });
    expect(s.planned.label).toBe("Start VM 101 (windows) on pve");
    expect(s.outcome).toMatchObject({
      ok: true,
      verified: true,
      result: "VM 101 (windows) is running.",
    });
    await expect(ops.plan(service, { op: "start", guest: "qemu/101" }, base)).rejects.toThrow(
      /already running/,
    );
    const off = await go({ op: "shutdown", guest: "lxc/200" });
    expect(off.outcome).toMatchObject({ ok: true, verified: true });
    expect(px.guests().find((g) => g.id === "lxc/200")!.status).toBe("stopped");
    expect(await ops.undo(step(off.planned.params), service)).toMatchObject({ ok: true });
    expect(px.guests().find((g) => g.id === "lxc/200")!.status).toBe("running");
    expect((await go({ op: "reboot", guest: "qemu/100" })).outcome).toMatchObject({
      ok: true,
      verified: true,
    });
    const stop = await go({ op: "stop", guest: "qemu/100" });
    expect(stop.planned.label).toMatch(
      /Force-stop VM 100 \(home-assistant\) \(like pulling the plug/,
    );
    await expect(ops.plan(service, { op: "start", guest: "qemu/9000" }, base)).rejects.toThrow(
      /template/,
    );
    await expect(ops.plan(service, { op: "start", guest: "100" }, base)).rejects.toThrow(
      /qemu\/100/,
    );
    // Run again (a second submission): nothing changes.
    expect(await ops.run(step(stop.planned.params), service)).toMatchObject({
      ok: false,
      stale: true,
    });
  });

  it("backs up now and takes a snapshot, read back", async () => {
    const { go, ops } = setup();
    const b = await go({ op: "backup", guest: "qemu/101" });
    expect(b.planned.label).toBe("Back up VM 101 (windows) to local now");
    expect(b.outcome).toMatchObject({ ok: true, verified: true });
    await expect(
      ops.plan(service, { op: "backup", guest: "qemu/101", storage: "local-lvm" }, base),
    ).rejects.toThrow(/does not hold backups/);
    const snap = await go({ op: "snapshot", guest: "qemu/100", name: "before-upgrade" });
    expect(snap.outcome).toMatchObject({ ok: true, verified: true });
    await expect(
      ops.plan(service, { op: "snapshot", guest: "qemu/100", name: "before-update" }, base),
    ).rejects.toThrow(/already has a snapshot/);
    await expect(
      ops.plan(service, { op: "snapshot", guest: "qemu/100", name: "1 bad" }, base),
    ).rejects.toThrow(/starts with a letter/);
  });
});

describe("a self-signed certificate on the local network", () => {
  afterEach(() => forgetPins());
  it("tells local addresses from public ones", () => {
    for (const h of [
      "192.168.1.5",
      "10.0.0.2",
      "172.20.1.1",
      "pve",
      "pve.lan",
      "nas.local",
      "127.0.0.1",
    ])
      expect(isLocalHost(h), h).toBe(true);
    for (const h of ["8.8.8.8", "172.32.0.1", "proxmox.example.com"])
      expect(isLocalHost(h), h).toBe(false);
  });

  let openssl = true;
  try {
    execFileSync("openssl", ["version"]);
  } catch {
    openssl = false;
  }
  it.skipIf(!openssl)(
    "is accepted and pinned, and a different one later is refused before anything is sent",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "hearth-tls-"));
      const cert = (n: string) => {
        execFileSync(
          "openssl",
          [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=pve",
            "-keyout",
            join(dir, `${n}.key`),
            "-out",
            join(dir, `${n}.crt`),
          ],
          { stdio: "ignore" },
        );
        return {
          key: readFileSync(join(dir, `${n}.key`)),
          cert: readFileSync(join(dir, `${n}.crt`)),
        };
      };
      const seen: string[] = [];
      const serve = (tls: { key: Buffer; cert: Buffer }, port = 0) =>
        new Promise<https.Server>((resolve) => {
          const s = https.createServer(tls, (req, res) => {
            seen.push(String(req.headers.authorization ?? ""));
            res.end(JSON.stringify({ data: { version: "9.1.1" } }));
          });
          s.listen(port, "127.0.0.1", () => resolve(s));
        });
      const first = await serve(cert("a"));
      const port = (first.address() as AddressInfo).port;
      const ask = () =>
        localTlsFetch(`https://127.0.0.1:${port}/api2/json/version`, {
          headers: { Authorization: "PVEAPIToken=secret" },
          signal: AbortSignal.timeout(5000),
        });
      expect(await (await ask()).json()).toEqual({ data: { version: "9.1.1" } });
      expect(await (await ask()).json()).toEqual({ data: { version: "9.1.1" } });
      await new Promise((r) => first.close(r));
      const second = await serve(cert("b"), port);
      await expect(ask()).rejects.toThrow(/certificate .* changed since Hearth first saw it/);
      await new Promise((r) => second.close(r));
      // The swapped server never got the token.
      expect(seen).toEqual(["PVEAPIToken=secret", "PVEAPIToken=secret"]);
    },
  );
});
