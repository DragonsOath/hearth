import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { HOST_LIMITS, type HostEntry } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import { redactTranscript } from "../memory/redact";
import { recordAudit } from "../store/audit";
import { formatOf, maskSecrets } from "./files";
import { GapError, type HostScopes } from "./scope";

/**
 * Investigation (tier T0): read only, automatic inside the host scope. Runs as Hearth's
 * own account, with no new privilege. Commands are fixed argument lists run without a shell; the
 * AI only names a diagnostic and, for some, a unit, container, or host name checked against a
 * strict pattern. Every result is size-limited and redacted; secret content is never returned.
 * Each look is audited by what was looked at, never by what it said.
 */

export interface Runner {
  (cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }>;
}

export const realRun: Runner = (cmd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? "/tmp",
          LANG: "C.UTF-8",
          SYSTEMD_COLORS: "0",
        },
      },
      (error, stdout, stderr) => {
        const e = error as
          (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        if (e?.code === "ENOENT") return reject(e);
        if (e?.killed) return reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
        resolve({
          code: typeof e?.code === "number" ? e.code : e ? 1 : 0,
          out: `${stdout}${stderr ? `\n${stderr}` : ""}`,
        });
      },
    );
  });

const UNIT = /^[A-Za-z0-9@._:\\-]{1,120}$/;
const HOSTNAME = /^[A-Za-z0-9.-]{1,253}$/;
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

interface Diagnostic {
  purpose: string;
  arg?: { name: string; pattern: RegExp };
  commands: (arg?: string) => [string, string[]][];
  timeoutMs?: number;
  /** Post-process the output before redaction. */
  shape?: (out: string) => string;
}

/** Docker inspect without environment values: names only. */
function stripEnv(out: string): string {
  try {
    const v = JSON.parse(out) as { Config?: { Env?: string[] } }[];
    for (const c of v)
      if (c.Config?.Env) c.Config.Env = c.Config.Env.map((e) => `${e.split("=")[0]}=<masked>`);
    return JSON.stringify(v, null, 1);
  } catch {
    return out.replace(/("[A-Za-z_][A-Za-z0-9_]*=)[^"]*"/g, '$1<masked>"');
  }
}

export const DIAGNOSTICS: Record<string, Diagnostic> = {
  processes: {
    purpose: "Running processes, busiest first (CPU, memory, command).",
    commands: () => [["ps", ["-eo", "pid,user,%cpu,%mem,rss,etime,args", "--sort=-%cpu"]]],
    shape: (o) => o.split("\n").slice(0, 61).join("\n"),
  },
  listening: {
    purpose: "Ports listening on this machine (TCP and UDP).",
    commands: () => [["ss", ["-ltnuH"]]],
  },
  services: {
    purpose: "Every systemd service and its state.",
    commands: () => [
      [
        "systemctl",
        ["list-units", "--type=service", "--all", "--no-pager", "--plain", "--no-legend"],
      ],
    ],
  },
  "failed-services": {
    purpose: "systemd units that failed.",
    commands: () => [["systemctl", ["--failed", "--no-pager", "--plain", "--no-legend"]]],
  },
  "service-status": {
    purpose: "One systemd unit's status and last log lines.",
    arg: { name: "unit", pattern: UNIT },
    commands: (u) => [["systemctl", ["status", "--no-pager", "--lines=30", "--", u!]]],
  },
  "unit-file": {
    purpose: "One systemd unit's definition (environment values masked).",
    arg: { name: "unit", pattern: UNIT },
    commands: (u) => [["systemctl", ["cat", "--no-pager", "--", u!]]],
    shape: (o) => o.replace(/^(Environment=\s*"?[A-Za-z_][A-Za-z0-9_]*=)[^\n"]*/gm, "$1<masked>"),
  },
  journal: {
    purpose: "The last 150 journal lines of one systemd unit.",
    arg: { name: "unit", pattern: UNIT },
    commands: (u) => [["journalctl", ["-u", u!, "-n", "150", "--no-pager", "-o", "short-iso"]]],
  },
  "system-errors": {
    purpose: "Errors in the system journal over the last 24 hours (last 150).",
    commands: () => [
      [
        "journalctl",
        ["-p", "err", "--since", "-24h", "-n", "150", "--no-pager", "-o", "short-iso"],
      ],
    ],
  },
  timers: {
    purpose: "Scheduled systemd timers: next and last run.",
    commands: () => [["systemctl", ["list-timers", "--all", "--no-pager"]]],
  },
  crontab: {
    purpose: "Hearth's account's crontab (system cron files: host_list /etc/cron.d).",
    commands: () => [["crontab", ["-l"]]],
  },
  mounts: {
    purpose: "Mounted filesystems with their sources, types, and options.",
    commands: () => [["findmnt", ["-rn", "-o", "TARGET,SOURCE,FSTYPE,OPTIONS"]]],
    shape: (o) =>
      o
        .split("\n")
        .filter((l) => !/^\/(proc|sys|dev|run\/user)\b|^\/snap\//.test(l))
        .join("\n"),
  },
  disks: {
    purpose: "Disk space per filesystem.",
    commands: () => [
      [
        "df",
        [
          "-h",
          "--output=target,fstype,size,used,avail,pcent",
          "-x",
          "tmpfs",
          "-x",
          "squashfs",
          "-x",
          "overlay",
        ],
      ],
    ],
  },
  "block-devices": {
    purpose: "Drives and partitions.",
    commands: () => [["lsblk", ["-o", "NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL"]]],
  },
  network: {
    purpose: "Network interfaces, addresses, and routes (diagnosis only).",
    commands: () => [
      ["ip", ["-br", "addr"]],
      ["ip", ["route"]],
    ],
  },
  dns: {
    purpose: "How this machine resolves one name.",
    arg: { name: "name", pattern: HOSTNAME },
    commands: (n) => [["getent", ["ahosts", n!]]],
  },
  resources: {
    purpose: "Memory, load, uptime, kernel.",
    commands: () => [
      ["free", ["-h"]],
      ["uptime", []],
      ["uname", ["-srm"]],
    ],
  },
  "docker-networks": {
    purpose: "Docker networks (diagnosis only).",
    commands: () => [
      ["docker", ["network", "ls", "--format", "{{.Name}}\t{{.Driver}}\t{{.Scope}}"]],
    ],
  },
  "docker-volumes": {
    purpose: "Docker volumes.",
    commands: () => [
      ["docker", ["volume", "ls", "--format", "{{.Name}}\t{{.Driver}}\t{{.Mountpoint}}"]],
    ],
  },
  "compose-projects": {
    purpose: "Docker Compose projects, their state, and where their compose files are.",
    commands: () => [["docker", ["compose", "ls", "--all"]]],
  },
  containers: {
    purpose: "Every container (running or not) with image, state, and Compose project.",
    commands: () => [
      [
        "docker",
        [
          "ps",
          "-a",
          "--format",
          '{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Label "com.docker.compose.project"}}',
        ],
      ],
    ],
  },
  container: {
    purpose:
      "One container in full (mounts, networks, restart policy, health); environment values masked.",
    arg: { name: "container", pattern: CONTAINER },
    commands: (c) => [["docker", ["inspect", "--", c!]]],
    shape: stripEnv,
  },
  "container-logs": {
    purpose: "The last 200 log lines of one container.",
    arg: { name: "container", pattern: CONTAINER },
    commands: (c) => [["docker", ["logs", "--tail", "200", "--timestamps", "--", c!]]],
  },
  "docker-disk": {
    purpose: "Docker's disk use (images, containers, volumes, build cache).",
    commands: () => [["docker", ["system", "df"]]],
    timeoutMs: 60_000,
  },
  account: {
    purpose: "Which account Hearth runs as and its groups (what it can reach).",
    commands: () => [["id", []]],
  },
};

const MAX_OUT = 64 * 1024;

function ownerNames(file: string): Map<number, string> {
  const m = new Map<number, string>();
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const [name, , id] = line.split(":");
      if (name && id) m.set(Number(id), name);
    }
  } catch {
    // Not Linux: numbers only.
  }
  return m;
}

function gapOf(error: unknown, what: string): GapError {
  if (error instanceof GapError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "EACCES" || code === "EPERM")
    return new GapError(
      `The operating system does not let Hearth's account read ${what}. Reading root-only things needs the root helper, which is not approved yet (design Phase 4).`,
      "missing-permission",
    );
  if (code === "ENOENT") return new GapError(`${what} does not exist.`, "unsupported");
  if (code === "ETIMEDOUT")
    return new GapError(
      `Looking at ${what} took longer than allowed; try a narrower path.`,
      "temporary",
    );
  return new GapError(error instanceof Error ? error.message : String(error), "temporary");
}

export class HostInvestigation {
  private users = ownerNames("/etc/passwd");
  private groups = ownerNames("/etc/group");

  constructor(
    private readonly handle: DbHandle,
    private readonly scopes: HostScopes,
    private readonly run: Runner = realRun,
  ) {}

  private async audit(action: string) {
    await recordAudit(this.handle.db, { actor: "agent", action, target: "host:local" }).catch(
      () => undefined,
    );
  }

  private normal(p: string): string {
    if (typeof p !== "string" || !p.trim()) throw new GapError("Give a full path.", "unsupported");
    if (!path.isAbsolute(p))
      throw new GapError("Give a full path (starting with /).", "unsupported");
    return path.resolve(p);
  }

  private entry(p: string, st: import("node:fs").Stats): HostEntry {
    const c = this.scopes.classify(p);
    return {
      name: path.basename(p) || p,
      path: p,
      type: st.isSymbolicLink()
        ? "link"
        : st.isDirectory()
          ? "dir"
          : st.isFile()
            ? "file"
            : "other",
      sizeBytes: st.size,
      modifiedAt: st.mtime.toISOString(),
      owner: this.users.get(st.uid) ?? String(st.uid),
      group: this.groups.get(st.gid) ?? String(st.gid),
      mode: (st.mode & 0o7777).toString(8).padStart(4, "0"),
      class: c.class,
      ...(c.why ? { why: c.why } : {}),
    };
  }

  async stat(p: string) {
    await this.scopes.require("investigate");
    const abs = this.normal(p);
    try {
      const st = await fs.lstat(abs);
      const e = this.entry(abs, st);
      const target = st.isSymbolicLink()
        ? await fs.readlink(abs).catch(() => undefined)
        : undefined;
      await this.audit(`Looked at ${abs}`);
      return { ...e, ...(target ? { linkTarget: target } : {}) };
    } catch (error) {
      throw gapOf(error, abs);
    }
  }

  async list(p: string) {
    await this.scopes.require("investigate");
    const abs = this.normal(p);
    try {
      const names = (await fs.readdir(abs)).sort((a, b) => a.localeCompare(b));
      const entries: HostEntry[] = [];
      for (const n of names.slice(0, HOST_LIMITS.listEntries)) {
        const full = path.join(abs, n);
        const st = await fs.lstat(full).catch(() => undefined);
        if (st) entries.push(this.entry(full, st));
      }
      await this.audit(`Listed ${abs}`);
      return {
        path: abs,
        class: this.scopes.classify(abs).class,
        total: names.length,
        ...(names.length > entries.length
          ? {
              shown: entries.length,
              note: `Only the first ${HOST_LIMITS.listEntries} are listed; search for a name instead.`,
            }
          : {}),
        entries,
      };
    } catch (error) {
      throw gapOf(error, abs);
    }
  }

  /** A page of a text file, secrets masked. Secret files: metadata only. */
  async read(p: string, opts: { offset?: number } = {}) {
    await this.scopes.require("investigate");
    const abs = this.normal(p);
    const c = this.scopes.classify(abs);
    try {
      const st = await fs.stat(abs);
      if (!st.isFile())
        throw new GapError(`${abs} is not a regular file; list it instead.`, "unsupported");
      if (c.class === "secret") {
        await this.audit(`Looked at ${abs} (secret: content withheld)`);
        throw new GapError(
          `${abs} holds secret content (${c.why}). Its content is never shown to the Ember; its size is ${st.size} bytes and it was last changed ${st.mtime.toISOString()}.`,
          "secret",
        );
      }
      const offset = Math.max(0, Math.floor(opts.offset ?? 0));
      const fh = await fs.open(abs, "r");
      try {
        const buf = Buffer.alloc(Math.min(HOST_LIMITS.readBytes, Math.max(0, st.size - offset)));
        const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
        const chunk = buf.subarray(0, bytesRead);
        if (chunk.subarray(0, 8192).includes(0)) {
          await this.audit(`Looked at ${abs} (binary)`);
          return {
            path: abs,
            sizeBytes: st.size,
            binary: true,
            note: "A binary file; its content is not shown.",
          };
        }
        // Pages end on a whole line; the next page starts where this one stopped.
        const more = offset + bytesRead < st.size;
        let stop = chunk.length;
        if (more) {
          const nl = chunk.lastIndexOf(10);
          if (nl > 0) stop = nl + 1;
        }
        const textPage = chunk.subarray(0, stop).toString("utf8");
        await this.audit(`Read ${abs} (${stop} bytes)`);
        return {
          path: abs,
          class: c.class,
          ...(c.why ? { why: c.why } : {}),
          sizeBytes: st.size,
          ...(offset ? { offset } : {}),
          ...(more ? { nextOffset: offset + stop } : {}),
          content: maskSecrets(textPage, formatOf(abs)),
        };
      } finally {
        await fh.close();
      }
    } catch (error) {
      throw gapOf(error, abs);
    }
  }

  /** Names matching a pattern (* and ? wildcards, case-insensitive) under a folder; links not followed. */
  async search(
    root: string,
    pattern: string,
    opts: { maxDepth?: number; type?: "file" | "dir" } = {},
  ) {
    await this.scopes.require("investigate");
    const abs = this.normal(root);
    if (!pattern || pattern.length > 200) throw new GapError("Give a name pattern.", "unsupported");
    const re = new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
      "i",
    );
    const maxDepth = Math.min(Math.max(1, opts.maxDepth ?? 6), 12);
    const deadline = Date.now() + HOST_LIMITS.timeoutMs;
    const found: HostEntry[] = [];
    let truncated: string | undefined;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (found.length >= HOST_LIMITS.searchResults) return void (truncated ??= "result limit");
      if (Date.now() > deadline) return void (truncated ??= "time limit");
      if (/^\/(proc|sys|dev)(\/|$)/.test(dir)) return;
      let items: import("node:fs").Dirent[];
      try {
        items = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const it of items) {
        const full = path.join(dir, it.name);
        if (
          re.test(it.name) &&
          (!opts.type || (opts.type === "dir" ? it.isDirectory() : it.isFile()))
        ) {
          const st = await fs.lstat(full).catch(() => undefined);
          if (st) found.push(this.entry(full, st));
          if (found.length >= HOST_LIMITS.searchResults) return void (truncated ??= "result limit");
        }
        if (it.isDirectory() && depth < maxDepth) await walk(full, depth + 1);
      }
    };
    try {
      await fs.access(abs);
    } catch (error) {
      throw gapOf(error, abs);
    }
    await walk(abs, 1);
    await this.audit(`Searched ${abs} for "${pattern}"`);
    return {
      root: abs,
      pattern,
      results: found,
      ...(truncated ? { note: `Stopped at the ${truncated}; narrow the folder or pattern.` } : {}),
    };
  }

  /** Space used under a folder, one level down, largest first (stays on one filesystem). */
  async diskUsage(p: string) {
    await this.scopes.require("investigate");
    const abs = this.normal(p);
    try {
      const r = await this.run("du", ["-x", "-b", "-d", "1", "--", abs], 90_000);
      const rows = r.out
        .split("\n")
        .map((l) => /^(\d+)\s+(.+)$/.exec(l.trim()))
        .filter((m): m is RegExpExecArray => Boolean(m))
        .map((m) => ({ path: m[2]!, bytes: Number(m[1]) }));
      const total = rows.find((x) => x.path === abs);
      const children = rows
        .filter((x) => x.path !== abs)
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 60);
      await this.audit(`Measured disk use of ${abs}`);
      return {
        path: abs,
        totalBytes: total?.bytes,
        children,
        ...(r.code !== 0
          ? { note: "Some folders could not be read (permissions); their sizes are missing." }
          : {}),
      };
    } catch (error) {
      throw gapOf(error, `disk use of ${abs}`);
    }
  }

  async diagnose(name: string, arg?: string) {
    await this.scopes.require("investigate");
    const d = DIAGNOSTICS[name];
    if (!d)
      throw new GapError(
        `There is no diagnostic "${name}". Available: ${Object.keys(DIAGNOSTICS).join(", ")}.`,
        "missing-capability",
      );
    if (d.arg && (!arg || !d.arg.pattern.test(arg)))
      throw new GapError(`"${name}" needs a valid ${d.arg.name}.`, "unsupported");
    const parts: string[] = [];
    let failed = false;
    for (const [cmd, args] of d.commands(arg)) {
      try {
        const r = await this.run(cmd, args, d.timeoutMs ?? HOST_LIMITS.timeoutMs);
        if (r.code !== 0) failed = true;
        parts.push(r.out.trim());
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT")
          throw new GapError(
            `The command "${cmd}" is not installed on this machine, so "${name}" cannot run. That is a missing capability: record it, and propose how to get it (following the host's documentation) if the owner wants it.`,
            "missing-capability",
          );
        throw gapOf(error, name);
      }
    }
    let out = parts.join("\n\n");
    if (d.shape) out = d.shape(out);
    out = redactTranscript(out);
    const truncated = out.length > MAX_OUT;
    await this.audit(`Ran the "${name}" diagnostic${arg ? ` for ${arg}` : ""}`);
    return {
      diagnostic: name,
      ...(arg ? { [d.arg!.name]: arg } : {}),
      ...(failed ? { note: "The command reported a problem; its message is included." } : {}),
      output: truncated ? `${out.slice(0, MAX_OUT)}\n[cut at 64 KB]` : out,
    };
  }

  /** Where this host's own documentation and backup ledger are, for following its conventions. */
  async conventions(docsRoot: string | undefined, backupRoot: string) {
    await this.scopes.require("investigate");
    const docs: { path: string; title?: string }[] = [];
    if (docsRoot) {
      const walk = async (dir: string, depth: number): Promise<void> => {
        const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const it of items.sort((a, b) => a.name.localeCompare(b.name))) {
          const full = path.join(dir, it.name);
          if (it.isDirectory() && depth < 4) await walk(full, depth + 1);
          else if (it.isFile() && /\.(md|txt)$/i.test(it.name) && docs.length < 200) {
            const head = await fs
              .readFile(full, "utf8")
              .then((s) => s.slice(0, 2000))
              .catch(() => "");
            docs.push({ path: full, title: /^#\s+(.+)$/m.exec(head)?.[1]?.trim() });
          }
        }
      };
      await walk(docsRoot, 1);
    }
    await this.audit("Looked up the host's documentation index");
    return {
      docsRoot: docsRoot ?? null,
      documents: docs,
      backupLedger: backupRoot,
      rule: "Read the relevant documents (host_read) before proposing installations, new folders, backups, or storage changes. If no document covers it, ask the owner before establishing a new convention.",
      ...(docsRoot ? {} : { note: "No host documentation folder is configured or found." }),
    };
  }
}
