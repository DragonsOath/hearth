import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import type { ContainerTools } from "../actions/tools";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { PlannedStep } from "../jobs/operations";
import type { Fetch } from "./http";
import { parseUsers, TinyauthUsers, usersText } from "./tinyauth-users";

/**
 * Tinyauth's users: a real users file in a temporary folder, a stand-in container that reads the
 * file only when it restarts (as Tinyauth does), and its sign-in checked against what it read.
 */

const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

async function setup(opts: { brokenAfterRestart?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "ta-users-"));
  const data = path.join(dir, "data");
  const backups = path.join(dir, "backups");
  await import("node:fs/promises").then((f) => f.mkdir(data));
  const file = path.join(data, "users");
  await writeFile(
    file,
    `owner:${await bcrypt.hash("old password", 4)}\nfamily:${await bcrypt.hash("family pw", 4)}:TOTPSECRET\n`,
    { mode: 0o600 },
  );
  const handle: DbHandle = openDatabase(":memory:");
  await runMigrations(handle, path.join(import.meta.dirname, "..", "..", "drizzle"));
  await handle.db.insert(t.hosts).values({
    id: "h",
    name: "This PC",
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
    id: "ta",
    name: "Tinyauth",
    category: "network",
    hostId: "h",
    kind: "container",
    image: "ghcr.io/tinyauthapp/tinyauth:v5.2.0",
    health: "healthy",
    autonomyArea: "network",
    checkTarget: "container:tinyauth",
    localUrl: "http://10.0.0.9:3000",
  });
  // What the running Tinyauth knows: read from the file at each restart.
  let known = parseUsers(await readFile(file, "utf8"));
  let restarts = 0;
  const containers = {
    config: async () => ({
      environmentNames: ["TINYAUTH_AUTH_USERSFILE"],
      pathSettings: { TINYAUTH_AUTH_USERSFILE: "/data/users" },
      mounts: [{ source: data, destination: "/data", readOnly: false }],
    }),
    restart: async () => {
      restarts += 1;
      known = parseUsers(await readFile(file, "utf8"));
    },
    runtime: async () => ({ running: !(opts.brokenAfterRestart && restarts === 1), ports: [] }),
  } as unknown as ContainerTools;
  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/api/healthz") return { ok: true, status: 200, json: async () => ({}) };
    if (u.pathname === "/api/user/login") {
      const { username, password } = JSON.parse(String(init.body)) as Record<string, string>;
      const user = known.find((k) => k.username === username);
      const ok = Boolean(user && (await bcrypt.compare(password!, user.hash)));
      return { ok, status: ok ? 200 : 401, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const users = new TinyauthUsers(
    handle,
    () => containers,
    backups,
    fetchImpl,
    async () => {},
  );
  const svc = { id: "ta", name: "Tinyauth", localUrl: "http://10.0.0.9:3000" };
  const step = (planned: PlannedStep) => ({
    kind: "tinyauth-users" as const,
    serviceId: "ta",
    requestedBy: "you" as const,
    params: planned.params,
  });
  return { file, backups, users, svc, step, restarts: () => restarts };
}

describe("Tinyauth's users", () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
  });

  it("lists usernames and sign-in codes, never a scramble", async () => {
    const view = await env.users.list("ta");
    expect(view).toEqual({
      source: "file",
      editable: true,
      users: [
        { username: "owner", twoStep: false },
        { username: "family", twoStep: true },
      ],
    });
    expect(JSON.stringify(view)).not.toContain("$2");
  });

  it("changes a password: backed up, restarted, proved by signing in; the plan never holds it", async () => {
    const { ref } = await env.users.prepare("ta", "owner", "a brand new password");
    const planned = await env.users.plan(
      env.svc,
      { op: "password", username: "owner", secretRef: ref },
      base,
    );
    expect(planned.label).toBe("Change owner's password in Tinyauth");
    expect(planned.params?.protected).toBe("yes");
    expect(JSON.stringify(planned)).not.toContain("a brand new password");
    const done = await env.users.run(env.step(planned), env.svc);
    expect(done).toMatchObject({
      ok: true,
      result: expect.stringContaining("sign-in with the new password worked"),
    });
    const after = parseUsers(await readFile(env.file, "utf8"));
    expect(await bcrypt.compare("a brand new password", after[0]!.hash)).toBe(true);
    // The other user and its sign-in code are kept.
    expect(after[1]).toMatchObject({ username: "family", totp: "TOTPSECRET" });
    const kept = await readdir(path.join(env.backups, "tinyauth"));
    expect(kept[0]).toMatch(/users-password-[0-9a-f]{4}$/);
    // The typed password is gone: the same plan cannot run twice.
    expect(await env.users.run(env.step(planned), env.svc)).toMatchObject({ ok: false });
  });

  it("adds, renames and removes a user; never the last one", async () => {
    const { ref } = await env.users.prepare("ta", "guest", "guest password 1");
    const add = await env.users.plan(
      env.svc,
      { op: "add", username: "guest", secretRef: ref },
      base,
    );
    expect((await env.users.run(env.step(add), env.svc)).ok).toBe(true);
    const rename = await env.users.plan(
      env.svc,
      { op: "rename", username: "guest", newName: "visitor" },
      base,
    );
    expect((await env.users.run(env.step(rename), env.svc)).ok).toBe(true);
    const remove = await env.users.plan(env.svc, { op: "remove", username: "visitor" }, base);
    expect((await env.users.run(env.step(remove), env.svc)).ok).toBe(true);
    expect((await env.users.list("ta")).users.map((u) => u.username)).toEqual(["owner", "family"]);
    const one = await env.users.plan(env.svc, { op: "remove", username: "family" }, base);
    expect((await env.users.run(env.step(one), env.svc)).ok).toBe(true);
    await expect(
      env.users.plan(env.svc, { op: "remove", username: "owner" }, base),
    ).rejects.toThrow(/only user/);
  });

  it("refuses a file changed since planning, and a password not typed for this plan", async () => {
    const remove = await env.users.plan(env.svc, { op: "remove", username: "family" }, base);
    await writeFile(env.file, usersText(parseUsers(await readFile(env.file, "utf8")).slice(0, 1)));
    expect(await env.users.run(env.step(remove), env.svc)).toMatchObject({
      ok: false,
      stale: true,
    });
    await expect(
      env.users.plan(env.svc, { op: "password", username: "owner", secretRef: "pw-nothing" }, base),
    ).rejects.toThrow(/Type the new password again/);
    await expect(env.users.prepare("ta", "owner", "short")).rejects.toThrow(/8 characters/);
    await expect(env.users.prepare("ta", "bad:name", "long enough pw")).rejects.toThrow(/username/);
  });

  it("puts the old file back when Tinyauth does not come back", async () => {
    const broken = await setup({ brokenAfterRestart: true });
    const before = await readFile(broken.file, "utf8");
    const { ref } = await broken.users.prepare("ta", "owner", "another new password");
    const planned = await broken.users.plan(
      broken.svc,
      { op: "password", username: "owner", secretRef: ref },
      base,
    );
    const done = await broken.users.run(broken.step(planned), broken.svc);
    expect(done).toMatchObject({
      ok: false,
      result: expect.stringContaining("old users file was put back"),
    });
    expect(await readFile(broken.file, "utf8")).toBe(before);
    expect(broken.restarts()).toBe(2);
  });
});
