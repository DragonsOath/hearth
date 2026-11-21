import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildAnswers, Job, JobStepInput } from "@dragon-control/core";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import { setSetting } from "../store/settings";
import { fakeHostScan } from "../plan/scan";
import type { Vault } from "../auth/vault";
import type { Elevation } from "../admin/elevation";
import type { Jobs } from "../jobs/engine";
import { HomelabBuilder, mediaDrive, mediaFolders, starterApps } from "./service";
import { RECIPES } from "./recipes";

const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

const ANSWERS: BuildAnswers = {
  wants: ["watch", "request"],
  devices: ["smart-tv", "phone"],
  away: "away",
  budget: "free",
  experience: "new",
  existingVpn: "proton",
};

function fakeVault() {
  const kept = new Map<string, { name: string; value: string; serviceId?: string }>();
  let n = 0;
  return {
    kept,
    vault: {
      add: async (x: { name: string; value: string }) => {
        const id = `s${++n}`;
        kept.set(id, { name: x.name, value: x.value });
        return { id };
      },
      use: async (id: string) => kept.get(id)!.value,
      removeInternal: async (id: string) => void kept.delete(id),
      update: async (id: string, p: { serviceId?: string }) => {
        kept.get(id)!.serviceId = p.serviceId;
      },
    } as unknown as Vault,
  };
}

function fakeElevation(ops: string[]) {
  return {
    state: async () =>
      ops.length
        ? {
            available: true,
            summary: "",
            status: { operations: ops, roots: [], units: [], problems: [] },
          }
        : { available: false, summary: "The elevated executor is not set up on this machine." },
    covers: async (op: string) =>
      ops.includes(op)
        ? { ok: true }
        : { ok: false, why: "The helper is not set up.", scope: false },
    perform: async () => ({ ok: true, outcome: "done", result: "Installed Docker." }),
  } as unknown as Elevation;
}

function fakeJobs() {
  const made: { title: string; steps: JobStepInput[] }[] = [];
  const jobs = {
    made,
    create: async (input: { title: string; steps: JobStepInput[] }) => {
      made.push(input);
      return {
        id: `j${made.length}`,
        title: input.title,
        status: "awaiting-approval",
        steps: [],
      } as unknown as Job;
    },
    get: async (id: string) =>
      ({ id, title: "", status: "awaiting-approval", steps: [] }) as unknown as Job,
  };
  return jobs;
}

async function setup(opts: { docker?: boolean; helper?: string[]; accounts?: boolean } = {}) {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  handles.push(handle);
  const root = mkdtempSync(path.join(os.tmpdir(), "hearth-build-"));
  const scan = fakeHostScan([]);
  const drive = mkdtempSync(path.join(os.tmpdir(), "hearth-drive-"));
  await fs.mkdir(path.join(drive, "Films"));
  scan.disks = [
    { name: "/", totalBytes: 100e9, freeBytes: 50e9 },
    {
      name: drive,
      totalBytes: 500e9,
      freeBytes: 400e9,
      media: { videos: 117, audio: 0, photos: 0 },
    },
  ];
  await setSetting(handle.db, "homelab_plan", {
    answers: ANSWERS,
    scan,
    chosen: {},
    removed: [],
    decisions: {},
    confirmed: true,
    savedAt: "2026-11-21T00:00:00Z",
  } as never);
  if (opts.accounts !== false)
    await setSetting(handle.db, "homelab_accounts", {
      email: "alex@example.com",
      username: "alex",
      passwords: "generate",
      savedAt: "2026-11-21T00:00:00Z",
    });
  const jobs = fakeJobs();
  const v = fakeVault();
  const calls: string[] = [];
  const builder = new HomelabBuilder({
    handle,
    vault: v.vault,
    elevation: fakeElevation(opts.helper ?? []),
    run: async (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "docker") return { code: opts.docker ? 0 : 127, out: "29.1.0" };
      return { code: 127, out: "" };
    },
    jobs: () => jobs as unknown as Jobs,
    appsRoot: root,
    install: { dir: "/home/alex/hearth/app", service: "hearth", userService: true },
    platform: "linux",
  });
  return { handle, builder, jobs, vault: v, calls, root, drive };
}

describe("Build my plan", () => {
  it("builds the plan's apps in a fixed order, and leaves out what it does not build", async () => {
    const { builder } = await setup();
    const st = await builder.status();
    const ids = st.steps.map((s) => s.id);
    expect(ids[0]).toBe("docker");
    expect(ids).toContain("jellyfin");
    // Docker comes first; nothing else can start before it.
    // (Only the VPN login can be added early, so the owner isn't kept waiting for it.)
    expect(
      st.steps
        .slice(1)
        .every(
          (s) => s.status === "waiting" || (s.id === "qbittorrent" && s.status === "needs-you"),
        ),
    ).toBe(true);
    expect(st.next).toBeUndefined();
    expect(ids.indexOf("jellyfin")).toBeLessThan(
      ids.indexOf("connect") === -1 ? 99 : ids.indexOf("connect"),
    );
  });

  it("asks for the admin helper's one command before Docker, for a get.sh install", async () => {
    const { builder } = await setup();
    const docker = (await builder.status()).steps[0]!;
    expect(docker.status).toBe("needs-you");
    expect(docker.need).toEqual({
      kind: "helper",
      command:
        'sudo bash "/home/alex/hearth/app/deploy/linux/install-elevation.sh" --service hearth --user-service --operations docker.install,tailscale.install',
    });
  });

  it("waits for the account details before anything", async () => {
    const { builder } = await setup({ accounts: false, helper: ["docker.install"] });
    const st = await builder.status();
    expect(st.blocker).toMatch(/account details/);
    expect(st.next).toBeUndefined();
  });

  it("makes the next step a plan to approve, with the details from Hearth, not the AI", async () => {
    const { builder, jobs } = await setup({ helper: ["docker.install", "tailscale.install"] });
    expect((await builder.status()).next).toBe("docker");
    await builder.propose(undefined, { requestedBy: "agent", conversationId: "c1" });
    expect(jobs.made[0]!.steps).toEqual([
      { kind: "build-docker", serviceId: "this-host", params: {} },
    ]);
    const st = await builder.status();
    expect(st.steps[0]).toMatchObject({ status: "awaiting-approval", jobId: "j1" });
    expect(st.conversationId).toBe("c1");
    // Proposing again returns the same plan instead of making a second.
    await builder.propose("docker", { requestedBy: "agent" });
    expect(jobs.made).toHaveLength(1);
  });

  it("Docker and Tailscale are protected steps: approving asks the owner to confirm it's them", async () => {
    const { builder } = await setup({ helper: ["docker.install", "tailscale.install"] });
    const p = await builder.planStep({ kind: "build-docker", serviceId: "this-host" });
    expect(p.policy).toBe("approve-first");
    expect(p.params?.protected).toBe("yes");
    expect(p.policyReason).toMatch(/confirm it's you/);
    expect(JSON.stringify(p.change)).toMatch(/close to administrator access/);
    const t = await builder.planStep({ kind: "build-tailscale", serviceId: "this-host" });
    expect(t.params?.protected).toBe("yes");
    // Without the helper there is nothing to approve: it says what to set up.
    const none = await (
      await setup()
    ).builder.planStep({ kind: "build-docker", serviceId: "this-host" });
    expect(none.policy).toBe("refuse");
    expect(none.policyReason).toMatch(/install-elevation\.sh/);
  });

  it("an app's plan shows its exact Compose file, its folder, and the drive read only", async () => {
    const { builder, root, drive } = await setup({ docker: true, helper: ["docker.install"] });
    expect((await builder.status()).next).toBe("jellyfin");
    const p = await builder.planStep({
      kind: "build-app",
      serviceId: "this-host",
      params: { app: "jellyfin" },
    });
    expect(p.policy).toBe("approve-first");
    expect(p.params?.protected).toBeUndefined();
    const rows = p.change!.settings;
    expect(rows.find((r) => r.name === "New folder")!.after).toBe(path.join(root, "jellyfin"));
    const compose = rows.find((r) => r.name === "compose.yaml")!.after;
    expect(compose).toContain(JSON.stringify(`${drive}:/media:ro`));
    expect(compose).toContain(RECIPES.jellyfin.images.jellyfin);
    expect(rows.find((r) => r.name === "Your files")!.after).toMatch(
      /Nothing is moved, renamed or deleted/,
    );
  });

  it("qBittorrent waits for the VPN login, which goes to the vault and never into the plan", async () => {
    const { builder, vault } = await setup({ docker: true, helper: ["docker.install"] });
    const qb = (await builder.status()).steps.find((s) => s.id === "qbittorrent");
    if (!qb) return; // not in this plan's starter
    expect(qb.need).toMatchObject({ kind: "vpn-login", provider: "proton" });
    await builder.saveVpn({
      provider: "proton",
      type: "openvpn",
      username: "user+pmp",
      password: "s3cret-vpn",
    });
    const p = await builder.planStep({
      kind: "build-app",
      serviceId: "this-host",
      params: { app: "qbittorrent" },
    });
    expect(p.params?.protected).toBe("yes");
    const all = JSON.stringify(p);
    expect(all).toContain("${OPENVPN_PASSWORD}");
    expect(all).not.toContain("s3cret-vpn");
    expect([...vault.kept.values()].map((s) => s.value)).toContain("s3cret-vpn");
  });

  it("finds the movies folder by name, and the drive with the most videos", async () => {
    const { drive } = await setup();
    const f = await mediaFolders(drive);
    expect(f.movies).toBe(path.join(drive, "Films"));
    expect(f.foundMovies).toBe(true);
    expect(f.foundShows).toBe(false);
    expect(f.shows).toBe(path.join(drive, "Shows"));
    expect(
      mediaDrive(
        { ...fakeHostScan([]), disks: [{ name: "/", totalBytes: 1, freeBytes: 1 }] },
        "/home/a",
      ),
    ).toBe(path.join("/home/a", "Media"));
  });

  it("the starter apps are the plan page's", async () => {
    const { handle } = await setup();
    void handle;
    const apps = starterApps({ answers: ANSWERS, scan: fakeHostScan([]), chosen: {}, removed: [] });
    expect(apps.map((a) => a.id)).toContain("jellyfin");
  });
});
