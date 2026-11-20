/**
 * CI only, on a disposable Windows machine: talks to the Windows elevated executor (installed by
 * deploy/windows/install-elevation.ps1, running as SYSTEM on its named pipe) the way Hearth's
 * backend does, and checks Storage Spaces end to end on virtual disks (VHDX files):
 * its own setup is accepted, a mirrored pool is created with a formatted volume, a spare and a
 * drive are added, a drive is retired and put back, the pool is optimized and the space extended,
 * and the drive holding Windows, a wrong serial, a replayed authorization, and a forged one are
 * refused. Run with tsx (it imports Hearth's own Storage Spaces reader).
 *
 *   apps/server/node_modules/.bin/tsx scripts/windows-elevation-ci.ts
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  PROTOCOL_VERSION,
  fingerprint,
  signAuthorization,
  type ElevatedRequest,
  type ElevatedResponse,
  type OperationName,
  type Params,
} from "../apps/server/src/elevated/protocol.ts";
import {
  DISKS_SCRIPT,
  READ_SCRIPT,
  candidatesFrom,
  poolsToArrays,
  psArgs,
  type SpacesRead,
} from "../apps/server/src/storage/raid/spaces.ts";

const PIPE = "\\\\.\\pipe\\hearth-elevated";
const key = fs.readFileSync(
  path.join(process.env.ProgramData ?? "C:\\ProgramData", "Hearth", "elevation", "elevation.key"),
);

function send(req: ElevatedRequest): Promise<ElevatedResponse> {
  return new Promise((resolve, reject) => {
    const s = net.connect(PIPE);
    let out = "";
    s.on("connect", () => s.write(`${JSON.stringify(req)}\n`));
    s.on("data", (d) => (out += d));
    s.on("error", reject);
    s.on("close", () => resolve(JSON.parse(out) as ElevatedResponse));
  });
}

function request(op: OperationName, params: Params, signWith = key): ElevatedRequest {
  const now = Date.now();
  return {
    v: PROTOCOL_VERSION,
    op,
    params,
    auth: signAuthorization(signWith, {
      id: randomBytes(16).toString("hex"),
      op,
      fingerprint: fingerprint(op, params),
      jobId: "ci",
      step: 1,
      approvedBy: "you",
      approvedAt: new Date(now).toISOString(),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 10 * 60_000).toISOString(),
    }),
  };
}

const ps = <T>(script: string): T =>
  JSON.parse(
    execFileSync("powershell.exe", psArgs(script), { encoding: "utf8", maxBuffer: 1e7 }).trim(),
  ) as T;
const pools = () => poolsToArrays(ps<SpacesRead>(READ_SCRIPT));
const disks = () => {
  const raw = ps<unknown>(DISKS_SCRIPT);
  return {
    raw: (Array.isArray(raw) ? raw : [raw]) as {
      number?: string;
      bus?: string;
      canPool?: boolean;
      system?: boolean;
      serial?: string;
    }[],
  };
};

let failed = 0;
const pass = (m: string) => console.log(`ok    ${m}`);
const fail = (m: string, extra?: unknown) => {
  failed++;
  console.log(`FAIL  ${m}`, extra === undefined ? "" : JSON.stringify(extra));
};
async function expectOk(what: string, op: OperationName, params: Params) {
  const r = await send(request(op, params));
  if (r.ok) pass(`${what}: ${r.result}`);
  else fail(what, r);
  return r;
}
async function expectRefused(what: string, req: ElevatedRequest, words: RegExp) {
  const r = await send(req);
  if (!r.ok && words.test(r.result)) pass(`${what}: ${r.result}`);
  else fail(what, r);
}

// 1. Its own setup: running as SYSTEM, every file closed to other accounts.
const st = await send({ v: PROTOCOL_VERSION, op: "status" });
if (st.ok && st.status && st.status.problems.length === 0)
  pass(`status: ${st.status.operations.join(", ")}`);
else fail("status has problems", st.status?.problems ?? st);

// 2. The virtual drives Windows can pool, and the drive holding Windows.
const { raw } = disks();
const vhds = raw
  // Only this test's own VHDX files: runners can carry a second real drive (their D:) that Windows
  // also lists as poolable.
  .filter((d) => d.canPool && !d.system && /file backed virtual/i.test(d.bus ?? ""))
  .map((d) => `\\\\.\\PHYSICALDRIVE${d.number}`);
const system = raw.find((d) => d.system);
console.log(
  `drives: ${JSON.stringify(candidatesFrom(raw as never).map((c) => [c.device, c.state, c.reason ?? ""]))}`,
);
if (vhds.length < 4) {
  fail(`expected 4 poolable virtual drives, found ${vhds.length}`);
  process.exit(1);
}

// 3. A mirrored pool with an NTFS volume, from two of them.
const create = request("spaces.create", {
  name: "HearthCI",
  level: "spaces-mirror",
  fs: "ntfs",
  disks: vhds.slice(0, 2).map((disk) => ({ disk, serial: "" })),
});
const made = await send(create);
if (made.ok) pass(`create: ${made.result}`);
else fail("create", made);
let pool = pools().find((p) => p.name === "HearthCI");
if (pool?.health === "healthy" && pool.level === "spaces-mirror" && pool.mount)
  pass(`read back: ${pool.levelText}, ${pool.mount}`);
else fail("pool not read back healthy", pool);
const id = pool?.uuid ?? "";

// 4. The same authorization again is refused; so is one signed with another key.
await expectRefused("replay", create, /already used/);
await expectRefused(
  "forged",
  request("spaces.repair", { pool: id, action: "optimize" }, randomBytes(48)),
  /authoriz|signature|not valid/i,
);

// 5. Never the drive holding Windows; never a drive whose serial is not the approved one.
if (system)
  await expectRefused(
    "the Windows drive",
    request("spaces.member", {
      pool: id,
      action: "add",
      disk: `\\\\.\\PHYSICALDRIVE${system.number}`,
      serial: system.serial ?? "",
    }),
    /holds Windows|in use/,
  );
await expectRefused(
  "wrong serial",
  request("spaces.member", { pool: id, action: "add", disk: vhds[2]!, serial: "NOTTHISONE" }),
  /not the one approved/,
);

// 6. A hot spare, then another drive.
await expectOk("add a spare", "spaces.member", {
  pool: id,
  action: "add-spare",
  disk: vhds[2]!,
  serial: "",
});
await expectOk("add a drive", "spaces.member", {
  pool: id,
  action: "add",
  disk: vhds[3]!,
  serial: "",
});
pool = pools().find((p) => p.name === "HearthCI");
if (pool?.counts.spare === 1 && pool.members.length === 4) pass("4 drives, 1 spare");
else
  fail(
    "members after adding",
    pool?.members.map((m) => [m.device, m.role]),
  );

// 7. Retire a drive, then put it back.
const victim = pool?.members.find((m) => m.role === "active");
await expectOk("retire", "spaces.member", {
  pool: id,
  action: "retire",
  member: victim?.path ?? "",
  serial: victim?.serial ?? "",
});
pool = pools().find((p) => p.name === "HearthCI");
if (pool?.members.find((m) => m.path === victim?.path)?.role === "retired") pass("retired");
else
  fail(
    "not retired",
    pool?.members.map((m) => [m.device, m.role]),
  );
await expectOk("put back", "spaces.member", {
  pool: id,
  action: "restore",
  member: victim?.path ?? "",
  serial: victim?.serial ?? "",
});

// 8. Optimize, then extend the space over the new drive's room.
await expectOk("optimize", "spaces.repair", { pool: id, action: "optimize" });
await new Promise((r) => setTimeout(r, 15_000));
await expectOk("extend", "spaces.grow", { pool: id });

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
