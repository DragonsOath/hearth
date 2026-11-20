import http from "node:http";
import { connectDocker } from "../discovery/docker-client";
import { demuxLogs } from "../actions/tools";

/**
 * Running a fixed command inside one container, and copying one file into its /tmp (feature
 * request 21.3). Callers pass commands from code (an app's own dry run or sync), never text the AI
 * wrote. No shell is involved: Docker runs the argument list directly.
 *
 * The copy belongs to the user the container's commands run as (read with `id -u` / `id -g`
 * inside it) and only that user can read it (0600). Docker's archive endpoint would otherwise
 * write it as root, which an app running as an ordinary user (Recyclarr: 1000:1000) can neither
 * read nor remove afterwards.
 */
export interface ContainerExec {
  /** Puts one file into the container (its /tmp), owned by the container's user, mode 0600. */
  putFile(container: string, dir: string, name: string, content: Buffer): Promise<void>;
  exec(
    container: string,
    cmd: string[],
    timeoutMs: number,
  ): Promise<{ exitCode: number; output: string }>;
}

/** A one-file tar archive (ustar), which is what Docker's archive endpoint takes. */
export function tarOne(
  name: string,
  content: Buffer,
  owner: { uid: number; gid: number } = { uid: 0, gid: 0 },
  mode = 0o600,
): Buffer {
  const header = Buffer.alloc(512, 0);
  const put = (s: string, off: number, len: number) => header.write(s, off, len, "ascii");
  put(name, 0, 100);
  put(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8);
  put(`${owner.uid.toString(8).padStart(7, "0")}\0`, 108, 8);
  put(`${owner.gid.toString(8).padStart(7, "0")}\0`, 116, 8);
  put(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12);
  put(
    `${Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0")}\0`,
    136,
    12,
  );
  put("        ", 148, 8);
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of header) sum += b;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  const pad = Buffer.alloc((512 - (content.length % 512)) % 512, 0);
  return Buffer.concat([header, content, pad, Buffer.alloc(1024, 0)]);
}

function request(
  socketPath: string,
  method: string,
  path: string,
  body: Buffer | undefined,
  type: string,
  timeoutMs: number,
): Promise<{ status: number; data: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method,
        timeout: timeoutMs,
        headers: body ? { "Content-Type": type, "Content-Length": body.length } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 500, data: Buffer.concat(chunks) }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("Docker did not finish in time.")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function socket(): Promise<string> {
  const conn = await connectDocker();
  if ("error" in conn) throw new Error(conn.error);
  return conn.reader.endpoint;
}

/** The numeric user and group a container's commands run as (asked inside it, no shell). */
async function containerOwner(container: string): Promise<{ uid: number; gid: number }> {
  const num = async (flag: string) => {
    const r = await realContainerExec.exec(container, ["id", flag], 15_000);
    const n = Number(r.output.trim());
    if (r.exitCode !== 0 || !Number.isInteger(n) || n < 0)
      throw new Error(`Could not tell which user ${container} runs as.`);
    return n;
  };
  return { uid: await num("-u"), gid: await num("-g") };
}

export const realContainerExec: ContainerExec = {
  async putFile(container, dir, name, content) {
    const owner = await containerOwner(container);
    const s = await socket();
    const res = await request(
      s,
      "PUT",
      `/containers/${encodeURIComponent(container)}/archive?path=${encodeURIComponent(dir)}`,
      tarOne(name, content, owner),
      "application/x-tar",
      30_000,
    );
    if (res.status !== 200) throw new Error(`Docker refused the copy (${res.status}).`);
  },
  async exec(container, cmd, timeoutMs) {
    const s = await socket();
    const made = await request(
      s,
      "POST",
      `/containers/${encodeURIComponent(container)}/exec`,
      Buffer.from(JSON.stringify({ AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd })),
      "application/json",
      30_000,
    );
    if (made.status !== 201) throw new Error(`Docker refused to run it (${made.status}).`);
    const id = (JSON.parse(made.data.toString("utf8")) as { Id: string }).Id;
    const out = await request(
      s,
      "POST",
      `/exec/${id}/start`,
      Buffer.from(JSON.stringify({ Detach: false, Tty: false })),
      "application/json",
      timeoutMs,
    );
    const info = await request(s, "GET", `/exec/${id}/json`, undefined, "", 30_000);
    const exitCode =
      (JSON.parse(info.data.toString("utf8")) as { ExitCode?: number }).ExitCode ?? -1;
    return { exitCode, output: demuxLogs(out.data) };
  },
};
