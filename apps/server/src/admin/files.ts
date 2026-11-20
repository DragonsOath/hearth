import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG_LIMITS, type ConfigEdit } from "@dragon-control/core";
import { redactTranscript } from "../memory/redact";

/**
 * Configuration files Hearth was allowed to touch: reading with secrets masked, exact
 * edits, backups next to the host's own backup ledger, atomic writes that keep owner and mode.
 */

export type FileFormat = "yaml" | "json" | "ini" | "xml" | "env" | "text";

/** The format a file's masking follows, from its name. */
export function formatOf(file: string): FileFormat {
  const base = path.basename(file).toLowerCase();
  if (base === ".env" || base.endsWith(".env") || base.startsWith(".env.")) return "env";
  const ext = path.extname(base);
  if (ext === ".yml" || ext === ".yaml") return "yaml";
  if (ext === ".json") return "json";
  if (ext === ".xml") return "xml";
  if ([".ini", ".conf", ".cfg", ".toml", ".properties"].includes(ext)) return "ini";
  return "text";
}

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

const SECRET_KEY =
  /(api[_-]?key|apikey|token|password|passwd|pass$|secret|private[_-]?key|preshared|psk|client[_-]?secret|auth|credential|cookie|session[_-]?id|[_-]key$|^key$)/i;
/** A value that only refers to a secret kept elsewhere: safe to show. */
const REFERENCE = /^\s*(!env_var|!secret|!include|\$\{|\$[A-Z_]+|<masked>)/;

/**
 * The file as the AI may see it: values of secret-looking keys replaced, unless they only refer to
 * a secret stored elsewhere (Recyclarr's !env_var). Then the usual message redaction on top.
 */
export function maskSecrets(content: string, format: FileFormat | undefined): string {
  const lines = content.split("\n").map((line) => {
    if (format === "env") {
      // Environment files hold secrets by design: every value is masked, names stay.
      const e = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(.*)$/.exec(line);
      return e && e[2]!.trim() && !REFERENCE.test(e[2]!) ? `${e[1]}<masked>` : line;
    }
    if (format === "xml") {
      return line.replace(/<([A-Za-z_]+)>([^<]*)<\/\1>/g, (m, tag: string, v: string) =>
        SECRET_KEY.test(tag) && v.trim() ? `<${tag}><masked></${tag}>` : m,
      );
    }
    if (format === "json") {
      return line.replace(/"([^"]+)"\s*:\s*"([^"]*)"/g, (m, k: string, v: string) =>
        SECRET_KEY.test(k) && v && !REFERENCE.test(v) ? `"${k}": "<masked>"` : m,
      );
    }
    // yaml and ini: "key: value" or "key = value"
    const m = /^(\s*-?\s*)([A-Za-z0-9_.-]+)(\s*[:=]\s*)(.*)$/.exec(line);
    if (m && SECRET_KEY.test(m[2]!) && m[4]!.trim() && !REFERENCE.test(m[4]!))
      return `${m[1]}${m[2]}${m[3]}<masked>`;
    return line;
  });
  // TRaSH guide identifiers in Recyclarr files are 32 hex characters, like an API key, but public:
  // kept readable (only on trash_id lines and in trash_ids, select, and exclude lists) so exact edits can name them.
  // References to secrets kept elsewhere (!env_var NAME) name a variable, not a value: kept too.
  const ids: string[] = [];
  const hold = (v: string) => `__dcid${ids.push(v) - 1}__`;
  let inIds = false;
  const kept = lines.map((line) => {
    if (format !== "yaml") return line;
    if (/^\s*-?\s*[A-Za-z0-9_.-]+\s*:\s*!(env_var|secret)\s+[A-Za-z_][A-Za-z0-9_]*\s*$/.test(line))
      return hold(line);
    const ref = line.replace(/!(env_var|secret)\s+[A-Za-z_][A-Za-z0-9_]*/g, hold);
    if (/^\s*(-\s+)?(trash_ids|select|exclude)\s*:\s*$/.test(ref)) inIds = true;
    else if (inIds && ref.trim() && !/^\s*#/.test(ref)) {
      // Inside a trash_ids list only bare identifiers (with an optional comment) count.
      if (/^\s*-\s+[0-9a-f]{32}\s*(#.*)?$/.test(ref)) return ref.replace(/[0-9a-f]{32}/, hold);
      inIds = false;
    }
    return /^\s*(-\s+)?trash_id\s*:\s*[0-9a-f]{32}\s*(#.*)?$/.test(ref)
      ? ref.replace(/[0-9a-f]{32}/, hold)
      : ref;
  });
  return redactTranscript(kept.join("\n")).replace(
    /__dcid(\d+)__/g,
    (_m, i: string) => ids[Number(i)]!,
  );
}

export class EditError extends Error {}

/** Applies exact edits in order; each `find` must appear exactly once at that point. */
export function applyEdits(
  content: string,
  edits: ConfigEdit[],
): { after: string; hunks: { line: number; before: string; after: string }[] } {
  if (!edits.length) throw new EditError("No edits given.");
  if (edits.length > CONFIG_LIMITS.maxEdits)
    throw new EditError(`At most ${CONFIG_LIMITS.maxEdits} edits in one step.`);
  let cur = content;
  const hunks: { line: number; before: string; after: string }[] = [];
  for (const [i, e] of edits.entries()) {
    if (typeof e.find !== "string" || typeof e.replace !== "string")
      throw new EditError(`Edit ${i + 1}: needs find and replace text.`);
    if (e.find.trim().length < 6)
      throw new EditError(`Edit ${i + 1}: the text to find is too short to be unambiguous.`);
    if (e.find.includes("<masked>") || e.replace.includes("<masked>"))
      throw new EditError(`Edit ${i + 1}: it touches a masked secret value, which is not allowed.`);
    const at = cur.indexOf(e.find);
    if (at < 0)
      throw new EditError(`Edit ${i + 1}: the text to find is not in the file as it is now.`);
    if (cur.indexOf(e.find, at + 1) >= 0)
      throw new EditError(
        `Edit ${i + 1}: the text to find appears more than once; include more of the surrounding lines.`,
      );
    hunks.push({ line: cur.slice(0, at).split("\n").length, before: e.find, after: e.replace });
    cur = cur.slice(0, at) + e.replace + cur.slice(at + e.find.length);
  }
  if (cur === content) throw new EditError("These edits do not change anything.");
  return { after: cur, hunks };
}

/** Reads a registered file: its text, fingerprint, owner, and mode. */
export async function readTarget(file: string): Promise<{
  content: string;
  hash: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
}> {
  const real = await fs.realpath(file);
  if (path.resolve(real) !== path.resolve(file))
    throw new Error(`${file} now points somewhere else; it is not touched.`);
  const st = await fs.stat(file);
  if (!st.isFile()) throw new Error(`${file} is not a regular file.`);
  if (st.size > CONFIG_LIMITS.maxBytes)
    throw new Error(`${file} is larger than ${CONFIG_LIMITS.maxBytes / 1024} KB; not handled.`);
  const buf = await fs.readFile(file);
  return {
    content: buf.toString("utf8"),
    hash: sha256(buf),
    mode: st.mode & 0o7777,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
  };
}

export interface BackupManifest {
  file: string;
  service: string;
  reason: string;
  beforeHash: string;
  afterHash?: string;
  at: string;
}

const stamp = (d = new Date()) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;

/**
 * Copies the file into the host's backup ledger before a change:
 * <backupRoot>/<service>/<time>-dragon-control-<reason>/ with the file and a manifest (the home server's
 * documented convention: backups/<service>/<date>-<reason>/).
 */
export async function backupFile(
  backupRoot: string,
  serviceKey: string,
  file: string,
  content: string,
  manifest: Omit<BackupManifest, "file" | "service" | "at">,
): Promise<string> {
  const dir = path.join(backupRoot, serviceKey, `${stamp()}-dragon-control-${manifest.reason}`);
  await fs.mkdir(dir, { recursive: true, mode: 0o750 });
  await fs.writeFile(path.join(dir, path.basename(file)), content, { mode: 0o640, flag: "wx" });
  const m: BackupManifest = {
    file,
    service: serviceKey,
    at: new Date().toISOString(),
    ...manifest,
  };
  await fs.writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(m, null, 2)}\n`, {
    mode: 0o640,
    flag: "wx",
  });
  return dir;
}

/** The newest backup of `file` whose manifest matches (for undo and restore). */
export async function findBackup(
  backupRoot: string,
  serviceKey: string,
  file: string,
  match: (m: BackupManifest) => boolean,
): Promise<{ dir: string; manifest: BackupManifest; content: string } | undefined> {
  const root = path.join(backupRoot, serviceKey);
  const dirs = (await fs.readdir(root).catch(() => [] as string[]))
    // Hearth's own backups, and the elevated executor's (root-owned, readable by Hearth).
    .filter((d) => d.includes("-dragon-control-") || d.includes("-hearth-elevated-"))
    .sort()
    .reverse();
  for (const d of dirs) {
    const dir = path.join(root, d);
    const m = JSON.parse(
      await fs.readFile(path.join(dir, "manifest.json"), "utf8").catch(() => "null"),
    ) as BackupManifest | null;
    if (!m || m.file !== file || !match(m)) continue;
    const content = await fs
      .readFile(path.join(dir, path.basename(file)), "utf8")
      .catch(() => undefined);
    if (content !== undefined) return { dir, manifest: m, content };
  }
  return undefined;
}

/** Replaces the file in one step (temp file in the same folder, then rename), keeping mode and owner. */
export async function writeAtomic(
  file: string,
  content: string,
  keep: { mode: number; uid: number; gid: number },
): Promise<void> {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.dragon-control-${randomUUID().slice(0, 8)}.tmp`,
  );
  await fs.writeFile(tmp, content, { mode: keep.mode, flag: "wx" });
  try {
    await fs.chmod(tmp, keep.mode);
    await fs.chown(tmp, keep.uid, keep.gid).catch(() => undefined);
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/** One backup folder, read only if its manifest is for exactly this file. */
export async function readBackup(
  dir: string,
  file: string,
): Promise<{ dir: string; manifest: BackupManifest; content: string } | undefined> {
  const m = JSON.parse(
    await fs.readFile(path.join(dir, "manifest.json"), "utf8").catch(() => "null"),
  ) as BackupManifest | null;
  if (!m || m.file !== file) return undefined;
  const content = await fs
    .readFile(path.join(dir, path.basename(file)), "utf8")
    .catch(() => undefined);
  return content === undefined ? undefined : { dir, manifest: m, content };
}
