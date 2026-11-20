import { createHash } from "node:crypto";

/**
 * Just enough of a .torrent file to plan adding it: its name and its info hash (the SHA-1 of the
 * bencoded "info" dictionary, qBittorrent's v1 hash), so the plan can name it and refuse one that
 * qBittorrent already has. Nothing else in the file is used; the file itself goes to qBittorrent
 * as it was uploaded.
 */

export interface TorrentFileInfo {
  name: string;
  /** v1 info hash, lowercase hex. */
  hash: string;
  /** Total size of its files, when the file says. */
  sizeBytes?: number;
}

/** The most a .torrent may be (a large season pack is about 2 MB). */
export const MAX_TORRENT_FILE_BYTES = 4 * 1024 * 1024;

class Bad extends Error {}

/** Reads one bencoded value at `i`; returns its end and, for dictionaries, where each key's value sits. */
function walk(
  b: Uint8Array,
  i: number,
  depth = 0,
): { end: number; dict?: Map<string, { start: number; end: number }> } {
  if (depth > 64 || i >= b.length) throw new Bad("damaged");
  const c = b[i]!;
  if (c === 0x69 /* i */) {
    const e = b.indexOf(0x65 /* e */, i);
    if (e < 0) throw new Bad("damaged");
    return { end: e + 1 };
  }
  if (c === 0x6c /* l */) {
    let j = i + 1;
    while (b[j] !== 0x65) {
      if (j >= b.length) throw new Bad("damaged");
      j = walk(b, j, depth + 1).end;
    }
    return { end: j + 1 };
  }
  if (c === 0x64 /* d */) {
    const dict = new Map<string, { start: number; end: number }>();
    let j = i + 1;
    while (b[j] !== 0x65) {
      if (j >= b.length) throw new Bad("damaged");
      const k = str(b, j);
      const v = walk(b, k.end, depth + 1);
      dict.set(k.text, { start: k.end, end: v.end });
      j = v.end;
    }
    return { end: j + 1, dict };
  }
  if (c >= 0x30 && c <= 0x39) return { end: str(b, i).end };
  throw new Bad("damaged");
}

function str(b: Uint8Array, i: number): { text: string; end: number } {
  const colon = b.indexOf(0x3a /* : */, i);
  if (colon < 0 || colon - i > 12) throw new Bad("damaged");
  const len = Number(Buffer.from(b.subarray(i, colon)).toString("ascii"));
  if (!Number.isInteger(len) || len < 0 || colon + 1 + len > b.length) throw new Bad("damaged");
  return {
    text: Buffer.from(b.subarray(colon + 1, colon + 1 + len)).toString("utf8"),
    end: colon + 1 + len,
  };
}

function intAt(b: Uint8Array, at?: { start: number; end: number }): number | undefined {
  if (!at || b[at.start] !== 0x69) return undefined;
  const n = Number(Buffer.from(b.subarray(at.start + 1, at.end - 1)).toString("ascii"));
  return Number.isFinite(n) ? n : undefined;
}

/** The name and info hash of a .torrent file, or a plain reason it is not one. */
export function readTorrentFile(bytes: Uint8Array): TorrentFileInfo | { error: string } {
  if (!bytes.length) return { error: "The file is empty." };
  if (bytes.length > MAX_TORRENT_FILE_BYTES) return { error: "The file is larger than 4 MB." };
  try {
    const top = walk(bytes, 0);
    const at = top.dict?.get("info");
    if (!at || bytes[at.start] !== 0x64) return { error: "It is not a .torrent file (no info)." };
    const info = walk(bytes, at.start).dict!;
    const nameAt = info.get("name");
    const name = nameAt ? str(bytes, nameAt.start).text : "Unnamed torrent";
    const length = intAt(bytes, info.get("length"));
    let total = length;
    const filesAt = info.get("files");
    if (total === undefined && filesAt && bytes[filesAt.start] === 0x6c) {
      // Each file's length, summed.
      total = 0;
      let j = filesAt.start + 1;
      while (bytes[j] !== 0x65) {
        const f = walk(bytes, j);
        total += intAt(bytes, f.dict?.get("length")) ?? 0;
        j = f.end;
      }
    }
    const hash = createHash("sha1").update(bytes.subarray(at.start, at.end)).digest("hex");
    return { name, hash, ...(total !== undefined ? { sizeBytes: total } : {}) };
  } catch {
    return { error: "It is not a .torrent file, or it is damaged." };
  }
}
