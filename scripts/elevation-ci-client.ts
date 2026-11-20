/**
 * Talks to an installed elevated executor the way Hearth's backend does (CI only, run as the
 * service account by scripts/test-elevation-install.sh). Node runs this TypeScript directly.
 *
 *   node scripts/elevation-ci-client.ts <socket> <key file> <command> [args...]
 *
 * Commands print the executor's answer as JSON and exit 0 when it says ok:
 *   write <path> <backup key> <new content>    file.write from the file's current content
 *   replay                                      sends the last request again, same authorization
 *   revert <receipt>                            undoes an earlier operation
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import {
  PROTOCOL_VERSION,
  fingerprint,
  sha256hex,
  signAuthorization,
  type ElevatedRequest,
  type OperationName,
  type Params,
} from "../apps/server/src/elevated/protocol.ts";

const [sock, keyFile, cmd, ...args] = process.argv.slice(2);
const key = fs.readFileSync(keyFile!);
const last = "/tmp/hearth-elevation-ci-last.json";

function send(req: ElevatedRequest): Promise<{ ok: boolean }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(sock!);
    let out = "";
    s.on("connect", () => s.write(`${JSON.stringify(req)}\n`));
    s.on("data", (d) => (out += d));
    s.on("error", reject);
    s.on("close", () => resolve(JSON.parse(out)));
  });
}

function request(op: OperationName, params: Params): ElevatedRequest {
  const now = Date.now();
  return {
    v: PROTOCOL_VERSION,
    op,
    params,
    auth: signAuthorization(key, {
      id: randomBytes(16).toString("hex"),
      op,
      fingerprint: fingerprint(op, params),
      jobId: "ci",
      step: 1,
      approvedBy: "you",
      approvedAt: new Date(now).toISOString(),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 5 * 60_000).toISOString(),
    }),
  };
}

let req: ElevatedRequest;
if (cmd === "write") {
  const [path, backupKey, content] = args as [string, string, string];
  const before = sha256hex(fs.readFileSync(path));
  req = request("file.write", {
    path,
    key: backupKey,
    beforeHash: before,
    afterHash: sha256hex(content),
    content: Buffer.from(content).toString("base64"),
  });
} else if (cmd === "replay") {
  req = JSON.parse(fs.readFileSync(last, "utf8")) as ElevatedRequest;
} else if (cmd === "revert") {
  req = request("revert", { receipt: args[0] });
} else throw new Error(`Unknown command ${cmd}`);
fs.writeFileSync(last, JSON.stringify(req));
const res = await send(req);
process.stdout.write(`${JSON.stringify(res)}\n`);
process.exit(res.ok ? 0 : 1);
