import { spawn } from "node:child_process";
import { readSync, realpathSync, writeSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import {
  handleRequest,
  loadConfig,
  recordJob,
  status,
  verifyAudit,
  type ExecutorDeps,
} from "./executor";
import { JOB_LOG, JOB_SPEC, JOB_STATE } from "./snapraid";
import { runSnapraidJob, type SnapraidJobSpec } from "./snapraid-job";

/**
 * The executor's program. systemd starts one per connection on Hearth's socket (Accept=yes), with
 * the connection as standard input and output: it reads one request, answers, and exits.
 *
 *   hearth-elevated --config /etc/hearth/elevation.json            (one request on stdin)
 *   hearth-elevated --config /etc/hearth/elevation.json --status   (for the owner, as root)
 *   hearth-elevated --config /etc/hearth/elevation.json --verify-log
 *
 * Standard input and output are the same socket under systemd, so they are read and written as
 * plain file descriptors (0 and 1). Node's own stream objects for them would shut the socket's
 * sending side down when input ends, before the answer is written.
 */

const MAX_REQUEST = 4 * 1024 * 1024;
const PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const WIN = process.platform === "win32";
const SYSROOT = process.env.SystemRoot ?? "C:\\Windows";
/** A minimal environment for the programs it runs: on Windows, what PowerShell needs. */
const ENV: NodeJS.ProcessEnv = WIN
  ? {
      SystemRoot: SYSROOT,
      windir: SYSROOT,
      ComSpec: `${SYSROOT}\\System32\\cmd.exe`,
      PATH: `${SYSROOT}\\System32;${SYSROOT};${SYSROOT}\\System32\\WindowsPowerShell\\v1.0`,
      PSModulePath: `${SYSROOT}\\System32\\WindowsPowerShell\\v1.0\\Modules`,
      TEMP: `${SYSROOT}\\Temp`,
      TMP: `${SYSROOT}\\Temp`,
    }
  : { PATH, LANG: "C.UTF-8" };

function run(cmd: string, args: string[], opts: { input?: string; timeoutMs?: number } = {}) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    // A fixed program and argument list, never a shell; a minimal environment.
    // Input only when there is some (setfacl): a program that exits without reading it would
    // otherwise end this one with an unhandled broken pipe.
    const child = spawn(cmd, args, {
      env: ENV,
      windowsHide: true,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let out = "";
    const add = (b: Buffer) => {
      if (out.length < 200_000) out += b.toString("utf8");
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 60_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, out: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
    if (child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(opts.input);
    }
  });
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const retrying = <T>(fn: () => T): T => {
  for (let tries = 0; ; tries++) {
    try {
      return fn();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EAGAIN" && code !== "EINTR") || tries > 6000) throw error;
      pause(10);
    }
  }
};

/** One request from file descriptor 0, ended by a newline (or the end of input). */
function readRequest(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(64 * 1024);
  let size = 0;
  for (;;) {
    const n = retrying(() => readSync(0, buf, 0, buf.length, null));
    if (n === 0) break;
    const part = Buffer.from(buf.subarray(0, n));
    chunks.push(part);
    size += n;
    if (size > MAX_REQUEST) throw new Error("The request is too large.");
    if (part.includes(10)) break;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Writes all of `text` to file descriptor 1. */
function out(text: string) {
  const data = Buffer.from(text, "utf8");
  let at = 0;
  while (at < data.length) at += retrying(() => writeSync(1, data, at, data.length - at));
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const i = args.indexOf("--config");
  const cfgFile = i >= 0 ? args[i + 1] : undefined;
  if (!cfgFile || !path.isAbsolute(cfgFile)) {
    out(`${JSON.stringify({ ok: false, outcome: "refused", result: "No --config given." })}\n`);
    return 2;
  }
  const system = WIN && /^(SYSTEM|.*\$)$/i.test(os.userInfo().username);
  const deps: ExecutorDeps = {
    run,
    now: () => Date.now(),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    isRoot: typeof process.getuid === "function" && process.getuid() === 0,
    ...(system ? { windowsSystem: true } : {}),
    selfPaths: [realpathSync(process.argv[1] ?? "/"), cfgFile],
  };
  if (args.includes("--snapraid-job")) return snapraidJob(cfgFile);
  const serve = args.indexOf("--serve");
  if (serve >= 0) return serveOn(args[serve + 1], cfgFile, deps);
  if (args.includes("--status")) {
    const cfg = await loadConfig(cfgFile);
    out(`${JSON.stringify(await status(cfg, cfgFile, deps), null, 2)}\n`);
    return 0;
  }
  if (args.includes("--verify-log")) {
    const cfg = await loadConfig(cfgFile);
    const r = await verifyAudit(cfg.auditLog);
    out(`${JSON.stringify(r)}\n`);
    return r.broken ? 1 : 0;
  }
  let raw: string;
  try {
    raw = readRequest();
  } catch (error) {
    out(
      `${JSON.stringify({ ok: false, outcome: "refused", result: error instanceof Error ? error.message : String(error) })}\n`,
    );
    return 0;
  }
  out(`${JSON.stringify(await handleRequest(raw, cfgFile, deps))}\n`);
  return 0;
}

/**
 * Windows: there is no systemd to start one process per request, so the executor runs as a
 * SYSTEM service (a scheduled task at startup) on a named pipe and answers one request per
 * connection. Anyone may connect; nothing runs without an authorization signed with the key only
 * Hearth's account and administrators can read, exactly as on Linux.
 */
function serveOn(pipe: string | undefined, cfgFile: string, deps: ExecutorDeps): Promise<number> {
  if (!pipe || !/^\\\\\.\\pipe\\[\w.-]{1,80}$/.test(pipe)) {
    out(
      `${JSON.stringify({ ok: false, outcome: "refused", result: "--serve takes a pipe like \\\\.\\pipe\\hearth-elevated." })}\n`,
    );
    return Promise.resolve(2);
  }
  const server = net.createServer((sock) => {
    let buf = "";
    let busy = false;
    sock.setEncoding("utf8");
    sock.on("error", () => undefined);
    sock.on("data", (d: string) => {
      if (busy) return;
      buf += d;
      if (buf.length > MAX_REQUEST || buf.includes("\n")) {
        busy = true;
        const answer =
          buf.length > MAX_REQUEST
            ? Promise.resolve({
                ok: false,
                outcome: "refused",
                result: "The request is too large.",
              })
            : handleRequest(buf, cfgFile, deps);
        void answer.then(
          (a) => sock.end(`${JSON.stringify(a)}\n`),
          (e: unknown) =>
            sock.end(
              `${JSON.stringify({ ok: false, outcome: "failed", result: e instanceof Error ? e.message : String(e) })}\n`,
            ),
        );
      }
    });
  });
  server.listen({ path: pipe, readableAll: true, writableAll: true });
  return new Promise(() => undefined);
}

/**
 * Job mode, started by snapraid.run in its own systemd unit: runs the SnapRAID job the executor
 * wrote to its state folder, and reports its state and SnapRAID's output beside the log, where
 * Hearth reads them. Its start and end are recorded in the chained log.
 */
async function snapraidJob(cfgFile: string): Promise<number> {
  const cfg = await loadConfig(cfgFile);
  const spec = JSON.parse(
    await readFile(path.join(cfg.stateDir, JOB_SPEC), "utf8"),
  ) as SnapraidJobSpec;
  const logDir = path.dirname(cfg.auditLog);
  const statePath = path.join(logDir, JOB_STATE);
  const logPath = path.join(logDir, JOB_LOG);
  await writeFile(logPath, "", { mode: 0o644 });
  await recordJob(cfg, {
    at: new Date().toISOString(),
    op: "snapraid.job",
    outcome: "begin",
    target: spec.conf,
    result: `${spec.action} (${spec.by})`,
  });
  const end = await runSnapraidJob(spec, {
    now: () => Date.now(),
    log: (t) => appendFile(logPath, t),
    save: async (s) => {
      await writeFile(`${statePath}.tmp`, JSON.stringify(s), { mode: 0o644 });
      await rename(`${statePath}.tmp`, statePath);
    },
    run: (cmd, a, onOutput) =>
      new Promise((resolve) => {
        const child = spawn(cmd, a, { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", (b: Buffer) => onOutput(b.toString("utf8")));
        child.stderr.on("data", (b: Buffer) => onOutput(b.toString("utf8")));
        // A stop request (systemctl kill --signal=SIGINT) reaches SnapRAID, which saves and exits.
        process.on("SIGINT", () => child.kill("SIGINT"));
        process.on("SIGTERM", () => child.kill("SIGTERM"));
        child.on("error", () => resolve(127));
        child.on("close", (code) => resolve(code ?? 1));
      }),
  });
  await recordJob(cfg, {
    at: new Date().toISOString(),
    op: "snapraid.job",
    outcome: end.ok ? "done" : "failed",
    target: spec.conf,
    result: (end.result ?? "").slice(0, 500),
  });
  return end.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    out(
      `${JSON.stringify({ ok: false, outcome: "failed", result: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exit(1);
  },
);
