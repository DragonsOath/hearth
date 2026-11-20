import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleRequest, verifyAudit, type ExecutorConfig, type ExecutorDeps } from "./executor";
import {
  PROTOCOL_VERSION,
  fingerprint,
  sha256hex,
  signAuthorization,
  type ElevatedResponse,
  type OperationName,
  type Params,
} from "./protocol";

const win = process.platform === "win32";

let base: string;
let root: string;
let cfgFile: string;
let cfg: ExecutorConfig;
let key: Buffer;
let calls: { cmd: string; args: string[] }[];
let script: (cmd: string, args: string[]) => { code: number; out: string } | undefined;
let clock: number;

const deps = (): ExecutorDeps => ({
  run: async (cmd, args) => {
    calls.push({ cmd, args });
    return script(cmd, args) ?? { code: 0, out: "" };
  },
  now: () => clock,
  wait: async () => undefined,
  isRoot: false,
  selfPaths: [path.join(base, "bin", "hearth-elevated.js"), cfgFile],
});

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "hearth-elevated-")));
  root = path.join(base, "compose");
  for (const d of ["compose/app", "backups", "state", "log", "etc", "bin", "outside"])
    await fs.mkdir(path.join(base, d), { recursive: true });
  key = randomBytes(32);
  cfgFile = path.join(base, "etc", "elevation.json");
  cfg = {
    version: 1,
    roots: [root],
    operations: [
      "file.write",
      "file.restore",
      "file.permissions",
      "dir.create",
      "compose.apply",
      "compose.down",
      "unit.control",
      "revert",
    ],
    units: ["nginx.service"],
    backupRoot: path.join(base, "backups"),
    stateDir: path.join(base, "state"),
    auditLog: path.join(base, "log", "elevated.jsonl"),
    keyFile: path.join(base, "etc", "elevation.key"),
  };
  await fs.writeFile(cfg.keyFile, key);
  await fs.writeFile(cfgFile, JSON.stringify(cfg));
  calls = [];
  script = () => undefined;
  clock = Date.parse("2026-10-19T12:00:00Z");
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

let n = 0;
function auth(op: OperationName, params: Params, over: Record<string, unknown> = {}, k = key) {
  const id = randomBytes(16).toString("hex");
  return signAuthorization(k, {
    id,
    op,
    fingerprint: fingerprint(op, params),
    jobId: "job-1",
    step: ++n,
    approvedBy: "you",
    issuedAt: new Date(clock).toISOString(),
    expiresAt: new Date(clock + 10 * 60_000).toISOString(),
    ...over,
  });
}

async function call(op: OperationName, params: Params, a = auth(op, params)) {
  return handleRequest(
    JSON.stringify({ v: PROTOCOL_VERSION, op, params, auth: a }),
    cfgFile,
    deps(),
  );
}

const file = () => path.join(root, "app", "compose.yml");
const OLD = "services:\n  app:\n    image: nginx:1.27\n";
const NEW = "services:\n  app:\n    image: nginx:1.28\n";
const writeParams = (from = OLD, to = NEW): Params => ({
  path: file(),
  key: "app",
  beforeHash: sha256hex(from),
  afterHash: sha256hex(to),
  content: Buffer.from(to).toString("base64"),
});

describe("the elevated executor", () => {
  it("reports its status without an authorization", async () => {
    const r = await handleRequest(JSON.stringify({ v: 1, op: "status" }), cfgFile, deps());
    expect(r.ok).toBe(true);
    expect(r.status?.roots).toEqual([root]);
    expect(r.status?.operations).toContain("file.write");
    expect(r.status?.problems).toEqual([]);
  });

  it("writes exactly the approved file, backs it up, verifies, and logs it", async () => {
    await fs.writeFile(file(), OLD);
    const r = await call("file.write", writeParams());
    expect(r).toMatchObject({ ok: true, outcome: "done" });
    expect(await fs.readFile(file(), "utf8")).toBe(NEW);
    expect(r.backup).toMatch(/^app\/\d{8}-\d{6}-hearth-elevated-edit-[0-9a-f]{6}$/);
    const dir = path.join(cfg.backupRoot, ...r.backup!.split("/"));
    expect(await fs.readFile(path.join(dir, "compose.yml"), "utf8")).toBe(OLD);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      file: file(),
      beforeHash: sha256hex(OLD),
      afterHash: sha256hex(NEW),
    });
    const log = await verifyAudit(cfg.auditLog);
    expect(log).toEqual({ records: 2 });
  });

  it("refuses a replayed, altered, expired, or forged authorization", async () => {
    await fs.writeFile(file(), OLD);
    const p = writeParams();
    const a = auth("file.write", p);
    expect((await call("file.write", p, a)).ok).toBe(true);
    // Replay of the same authorization (even against a file put back as it was).
    await fs.writeFile(file(), OLD);
    const again = await call("file.write", p, a);
    expect(again).toMatchObject({ ok: false, outcome: "refused" });
    expect(again.result).toMatch(/already used/);
    // Altered request: different content than authorized.
    const other = writeParams(OLD, "services: {}\n");
    expect((await call("file.write", other, auth("file.write", p))).result).toMatch(/fingerprint/);
    // Expired.
    const old = auth("file.write", p, {
      issuedAt: new Date(clock - 20 * 60_000).toISOString(),
      expiresAt: new Date(clock - 6 * 60_000).toISOString(),
    });
    expect((await call("file.write", p, old)).result).toMatch(/expired/);
    // Too long-lived.
    const long = auth("file.write", p, { expiresAt: new Date(clock + 60 * 60_000).toISOString() });
    expect((await call("file.write", p, long)).result).toMatch(/too long/);
    // Signed with another key.
    expect(
      (await call("file.write", p, auth("file.write", p, {}, randomBytes(32)))).result,
    ).toMatch(/signature/);
    // An authorization for another operation.
    const wrongOp = { ...auth("file.write", p), op: "dir.create" as const };
    expect((await call("file.write", p, wrongOp)).ok).toBe(false);
    expect(await fs.readFile(file(), "utf8")).toBe(OLD);
  });

  it("does nothing when the target changed since approval", async () => {
    await fs.writeFile(file(), "services: {}\n");
    const r = await call("file.write", writeParams());
    expect(r).toMatchObject({ ok: false, outcome: "stale" });
    expect(await fs.readFile(file(), "utf8")).toBe("services: {}\n");
  });

  it("refuses paths outside the scope, in non-plain form, denied, or through a link", async () => {
    const bad = async (p: string) => {
      const params = { ...writeParams(), path: p, beforeHash: null };
      return call("file.write", params);
    };
    expect((await bad(path.join(base, "outside", "x.yml"))).result).toMatch(
      /outside the executor's scope/,
    );
    expect(
      (
        await bad(
          `${root}${path.sep}app${path.sep}..${path.sep}..${path.sep}outside${path.sep}x.yml`,
        )
      ).result,
    ).toMatch(/plain form/);
    expect((await bad("relative/compose.yml")).result).toMatch(/absolute/);
    expect((await bad(root)).result).toMatch(/outside the executor's scope/);
    expect((await bad(path.join(root, "app", "authorized_keys"))).result).toMatch(/log in/);
    await fs.mkdir(path.join(root, "app", "20261019-120000-hearth-elevated-edit-abcdef"));
    expect(
      (await bad(path.join(root, "app", "20261019-120000-hearth-elevated-edit-abcdef", "f")))
        .result,
    ).toMatch(/executor's own backups/);
    let linked = true;
    try {
      await fs.symlink(path.join(base, "outside"), path.join(root, "link"), "junction");
    } catch {
      linked = false;
    }
    if (linked) {
      const r = await bad(path.join(root, "link", "x.yml"));
      expect(r.result).toMatch(/symbolic link|resolve to itself/);
      expect(await fs.readdir(path.join(base, "outside"))).toEqual([]);
    }
  });

  it("refuses operations that are not switched on", async () => {
    await fs.writeFile(cfgFile, JSON.stringify({ ...cfg, operations: ["file.write"] }));
    const r = await call("dir.create", { path: path.join(root, "new") });
    expect(r.result).toMatch(/not switched on/);
  });

  it("creates a new file and undoes it; undo refuses once the file changed again", async () => {
    const p: Params = {
      path: path.join(root, "app", ".env"),
      key: "app",
      beforeHash: null,
      afterHash: sha256hex("A=1\n"),
      content: Buffer.from("A=1\n").toString("base64"),
      create: { mode: 0o640 },
    };
    const r = await call("file.write", p);
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(root, "app", ".env"), "utf8")).toBe("A=1\n");
    const undo = await call("revert", { receipt: r.receipt! });
    expect(undo.ok).toBe(true);
    await expect(fs.stat(path.join(root, "app", ".env"))).rejects.toThrow();
    expect((await call("revert", { receipt: r.receipt! })).result).toMatch(/already undone/);

    await fs.writeFile(file(), OLD);
    const w = await call("file.write", writeParams());
    await fs.writeFile(file(), "someone else's edit\n");
    const late = await call("revert", { receipt: w.receipt! });
    expect(late).toMatchObject({ ok: false, outcome: "stale" });
    expect(await fs.readFile(file(), "utf8")).toBe("someone else's edit\n");
  });

  it("puts a change back from its receipt", async () => {
    await fs.writeFile(file(), OLD);
    const w = await call("file.write", writeParams());
    const r = await call("revert", { receipt: w.receipt! });
    expect(r.ok).toBe(true);
    expect(await fs.readFile(file(), "utf8")).toBe(OLD);
  });

  it("restores only from intact backups of exactly that file", async () => {
    await fs.writeFile(file(), OLD);
    const w = await call("file.write", writeParams());
    const restore = (over: Params = {}) =>
      call("file.restore", {
        path: file(),
        key: "app",
        backup: w.backup!,
        beforeHash: sha256hex(NEW),
        backupHash: sha256hex(OLD),
        ...over,
      });
    expect((await restore({ backup: "../../outside" })).result).toMatch(
      /not one of the executor's backups/,
    );
    expect((await restore({ path: path.join(root, "app", "other.yml") })).ok).toBe(false);
    const dir = path.join(cfg.backupRoot, ...w.backup!.split("/"));
    await fs.writeFile(path.join(dir, "compose.yml"), "tampered\n");
    expect((await restore()).result).toMatch(/does not match its own record/);
    await fs.writeFile(path.join(dir, "compose.yml"), OLD);
    const ok = await restore();
    expect(ok.ok).toBe(true);
    expect(await fs.readFile(file(), "utf8")).toBe(OLD);
  });

  it.skipIf(win)(
    "changes permissions from the approved state only, and never through a hard link",
    async () => {
      const f = path.join(root, "app", "secret.env");
      await fs.writeFile(f, "X=1\n", { mode: 0o644 });
      await fs.chmod(f, 0o644);
      const st = await fs.stat(f);
      const before = { mode: 0o644, uid: st.uid, gid: st.gid };
      const r = await call("file.permissions", { path: f, before, after: { mode: 0o600 } });
      expect(r.ok).toBe(true);
      expect((await fs.stat(f)).mode & 0o777).toBe(0o600);
      expect(
        (await call("file.permissions", { path: f, before, after: { mode: 0o600 } })).outcome,
      ).toBe("stale");
      expect((await call("revert", { receipt: r.receipt! })).ok).toBe(true);
      expect((await fs.stat(f)).mode & 0o777).toBe(0o644);
      await fs.link(f, path.join(root, "app", "hardlink"));
      const h = await call("file.permissions", { path: f, before, after: { mode: 0o600 } });
      expect(h.result).toMatch(/hard links/);
    },
  );

  it("creates a folder and removes it again only while empty", async () => {
    const d = path.join(root, "newapp");
    const r = await call("dir.create", { path: d, mode: 0o755 });
    expect(r.ok).toBe(true);
    expect((await fs.stat(d)).isDirectory()).toBe(true);
    await fs.writeFile(path.join(d, "x"), "");
    expect((await call("revert", { receipt: r.receipt! })).outcome).toBe("stale");
    await fs.rm(path.join(d, "x"));
    expect((await call("revert", { receipt: r.receipt! })).ok).toBe(true);
  });

  it("applies a Compose project and verifies every service runs", async () => {
    await fs.writeFile(file(), OLD);
    script = (cmd, args) => {
      if (args.includes("--services")) return { code: 0, out: "app\n" };
      if (args.includes("ps")) return { code: 0, out: '{"Service":"app","State":"running"}\n' };
      return undefined;
    };
    const ok = await call("compose.apply", { file: file(), fileHash: sha256hex(OLD) });
    expect(ok).toMatchObject({ ok: true });
    expect(calls.some((c) => c.args.join(" ").includes("up -d --force-recreate"))).toBe(true);
    script = (cmd, args) => {
      if (args.includes("--services")) return { code: 0, out: "app\n" };
      if (args.includes("ps")) return { code: 0, out: '{"Service":"app","State":"exited"}\n' };
      return undefined;
    };
    const bad = await call("compose.apply", { file: file(), fileHash: sha256hex(OLD) });
    expect(bad).toMatchObject({ ok: false, outcome: "failed" });
    // Bound to the approved content: a changed file is never started.
    await fs.writeFile(file(), NEW);
    const changed = await call("compose.apply", { file: file(), fileHash: sha256hex(OLD) });
    expect(changed).toMatchObject({ ok: false, outcome: "stale" });
    // Not a Compose file.
    await fs.writeFile(path.join(root, "app", "notes.txt"), "x");
    expect(
      (await call("compose.apply", { file: path.join(root, "app", "notes.txt") })).result,
    ).toMatch(/not a Compose file/);
  });

  it("controls only listed units, never Hearth's own, and verifies the state", async () => {
    expect((await call("unit.control", { unit: "ssh.service", action: "restart" })).result).toMatch(
      /outside/,
    );
    expect(
      (await call("unit.control", { unit: "hearth.service", action: "restart" })).result,
    ).toMatch(/never controlled/);
    script = (cmd, args) => (args[0] === "is-active" ? { code: 0, out: "active\n" } : undefined);
    expect((await call("unit.control", { unit: "nginx.service", action: "restart" })).ok).toBe(
      true,
    );
    script = (cmd, args) => (args[0] === "is-active" ? { code: 3, out: "failed\n" } : undefined);
    const r = await call("unit.control", { unit: "nginx.service", action: "start" });
    expect(r).toMatchObject({ ok: false, outcome: "failed" });
    expect(r.result).toMatch(/not active/);
  });

  it("keeps a chained log that shows edits", async () => {
    await fs.writeFile(file(), OLD);
    await call("file.write", writeParams());
    await call("dir.create", { path: path.join(base, "outside", "x") });
    expect(await verifyAudit(cfg.auditLog)).toEqual({ records: 4 });
    const lines = (await fs.readFile(cfg.auditLog, "utf8")).split("\n");
    lines[0] = lines[0]!.replace("begin", "BEGIN");
    await fs.writeFile(cfg.auditLog, lines.join("\n"));
    expect((await verifyAudit(cfg.auditLog)).broken).toBe(2);
  });

  it("never makes a program that runs with its owner's privileges", async () => {
    const created = await call("file.write", {
      ...writeParams(),
      path: path.join(root, "app", "tool"),
      beforeHash: null,
      create: { mode: 0o4755 },
    });
    expect(created.ok).toBe(false);
    expect(created.result).toMatch(/not valid/);
    const dir = await call("dir.create", { path: path.join(root, "d"), mode: 0o2775 });
    expect(dir.ok).toBe(false);
  });

  it("refuses to work when a root lies inside a system area", async () => {
    await fs.writeFile(cfgFile, JSON.stringify({ ...cfg, roots: [root, "/etc/cron.d"] }));
    const r = await handleRequest(JSON.stringify({ v: 1, op: "status" }), cfgFile, deps());
    expect(r.status?.problems.join(" ")).toMatch(/system area/);
    await fs.writeFile(file(), OLD);
    expect((await call("file.write", writeParams())).result).toMatch(/not safe/);
  });

  it("never acts on its own files", async () => {
    await fs.writeFile(cfgFile, JSON.stringify({ ...cfg, roots: [base] }));
    const r = await call("file.write", {
      ...writeParams(),
      path: cfg.keyFile,
      beforeHash: sha256hex(key),
    });
    expect(r.result).toMatch(/part of the executor itself/);
    const st = await call("dir.create", { path: path.join(cfg.stateDir, "x") });
    expect(st.result).toMatch(/part of the executor itself/);
  });

  it("answers malformed requests without acting", async () => {
    const r: ElevatedResponse = await handleRequest("not json", cfgFile, deps());
    expect(r).toMatchObject({ ok: false, outcome: "refused" });
    const v = await handleRequest(JSON.stringify({ v: 9, op: "status" }), cfgFile, deps());
    expect(v.ok).toBe(false);
    const u = await handleRequest(
      JSON.stringify({ v: 1, op: "shell", params: {} }),
      cfgFile,
      deps(),
    );
    expect(u.result).toMatch(/not an operation/);
  });

  describe("smart.read", () => {
    const read = (device: unknown, blocks = ["/dev/sda", "/dev/sdb"]) =>
      handleRequest(JSON.stringify({ v: 1, op: "smart.read", params: { device } }), cfgFile, {
        ...deps(),
        isBlockDevice: async (p) => blocks.includes(p),
      });
    const on = () =>
      fs.writeFile(
        cfgFile,
        JSON.stringify({ ...cfg, operations: [...cfg.operations, "smart.read"] }),
      );

    it("does nothing until the owner switches it on in the scope file", async () => {
      const r = await read("/dev/sda");
      expect(r).toMatchObject({ ok: false, outcome: "refused" });
      expect(r.result).toMatch(/not switched on/);
      expect(calls).toEqual([]);
    });

    it("reads one whole drive with a fixed command and no authorization, and logs it", async () => {
      await on();
      script = () => ({ code: 0, out: JSON.stringify({ smart_status: { passed: true } }) });
      const r = await read("/dev/sda");
      expect(r).toMatchObject({ ok: true, outcome: "done" });
      expect(r.data).toMatchObject({ smart_status: { passed: true }, hearth: { via: "direct" } });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).toEqual(["--json=c", "-a", "-n", "standby,0", "/dev/sda"]);
      const log = await fs.readFile(cfg.auditLog, "utf8");
      expect(log).toMatch(/"outcome":"read"/);
      expect(log).toMatch(/\/dev\/sda/);
    });

    it("asks a USB bridge again through SAT passthrough", async () => {
      await on();
      script = (_cmd, args) =>
        args.includes("sat")
          ? { code: 0, out: JSON.stringify({ smart_status: { passed: true } }) }
          : {
              code: 2,
              out: JSON.stringify({
                smartctl: { messages: [{ string: "Unknown USB bridge", severity: "error" }] },
              }),
            };
      const r = await read("/dev/sdb");
      expect(r.data).toMatchObject({ hearth: { via: "sat" } });
      expect(r.result).toMatch(/SAT passthrough/);
    });

    it("refuses anything but a whole drive that exists", async () => {
      await on();
      for (const bad of ["/dev/sda1", "/etc/shadow", "/dev/sda -d test", "-a", 5])
        expect((await read(bad)).result).toMatch(/whole drive/);
      expect((await read("/dev/sdz")).result).toMatch(/not a drive/);
      expect(calls).toEqual([]);
    });
  });

  describe("file.rename and file.copy", () => {
    const on = () =>
      fs.writeFile(
        cfgFile,
        JSON.stringify({ ...cfg, operations: [...cfg.operations, "file.rename", "file.copy"] }),
      );
    const media = () => path.join(root, "app");

    it("moves a file exactly as approved, checks it, and moves it back on revert", async () => {
      await on();
      const from = path.join(media(), "Heat.mkv");
      await fs.writeFile(from, "h".repeat(10));
      await fs.mkdir(path.join(media(), "Films"));
      const st = await fs.stat(from);
      const params = {
        from,
        to: path.join(media(), "Films", "Heat.mkv"),
        size: 10,
        mtimeMs: Math.round(st.mtimeMs),
      };
      const r = await call("file.rename", params);
      expect(r).toMatchObject({ ok: true, outcome: "done" });
      expect(await fs.readFile(path.join(media(), "Films", "Heat.mkv"), "utf8")).toHaveLength(10);
      const back = await call("revert", { receipt: r.receipt! });
      expect(back).toMatchObject({ ok: true });
      expect(await fs.readFile(from, "utf8")).toHaveLength(10);
    });

    it("does nothing when the item changed, the destination exists, or it leaves the scope", async () => {
      await on();
      const from = path.join(media(), "A.mkv");
      await fs.writeFile(from, "a");
      await fs.writeFile(path.join(media(), "B.mkv"), "b");
      expect(
        (await call("file.rename", { from, to: path.join(media(), "C.mkv"), size: 99 })).outcome,
      ).toBe("stale");
      expect((await call("file.rename", { from, to: path.join(media(), "B.mkv") })).result).toMatch(
        /already exists/,
      );
      expect(
        (await call("file.rename", { from, to: path.join(base, "outside", "A.mkv") })).result,
      ).toMatch(/outside the executor's scope/);
      expect(await fs.readFile(path.join(media(), "B.mkv"), "utf8")).toBe("b");
    });

    it("copies a folder, never over anything, and leaves the original", async () => {
      await on();
      const from = path.join(media(), "Show");
      await fs.mkdir(path.join(from, "Season 1"), { recursive: true });
      await fs.writeFile(path.join(from, "Season 1", "e1.mkv"), "x".repeat(7));
      const r = await call("file.copy", { from, to: path.join(media(), "Show copy") });
      expect(r).toMatchObject({ ok: true });
      expect(r.result).toMatch(/7 bytes, checked/);
      expect(await fs.readFile(path.join(from, "Season 1", "e1.mkv"), "utf8")).toHaveLength(7);
      expect(
        (await call("file.copy", { from, to: path.join(media(), "Show copy") })).result,
      ).toMatch(/already exists/);
    });

    it("is refused until the owner switches it on", async () => {
      const from = path.join(media(), "Z.mkv");
      await fs.writeFile(from, "z");
      expect((await call("file.rename", { from, to: path.join(media(), "Y.mkv") })).result).toMatch(
        /not switched on/,
      );
    });
  });
});
