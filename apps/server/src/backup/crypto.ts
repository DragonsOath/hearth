import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

/**
 * Backups that leave this machine are encrypted with AES-256-GCM, which
 * also detects any change to the file. The key lives next to the vault key
 * (DC_KEY_DIR), never in the backups, and you keep a copy of it yourself.
 *
 * File layout: "DCBAK1" (6 bytes), nonce (12 bytes), ciphertext, tag (16 bytes).
 */

const MAGIC = Buffer.from("DCBAK1");
const NONCE = 12;
const TAG = 16;

/** The key for off-machine backups, created on first use. */
export function backupKey(keyDir: string): Buffer {
  const file = path.join(keyDir, "backup.key");
  if (!existsSync(file)) {
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
  }
  const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error(`${file} is not a valid backup key.`);
  return key;
}

export async function encryptFile(src: string, dst: string, key: Buffer): Promise<void> {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const out = await open(dst, "w", 0o600);
  try {
    await out.write(Buffer.concat([MAGIC, nonce]));
    for await (const chunk of createReadStream(src))
      await out.write(cipher.update(chunk as Buffer));
    await out.write(cipher.final());
    await out.write(cipher.getAuthTag());
  } finally {
    await out.close();
  }
}

/** Throws if the key is wrong or the file was changed or damaged. */
export async function decryptFile(src: string, dst: string, key: Buffer): Promise<void> {
  const size = statSync(src).size;
  const head = MAGIC.length + NONCE;
  if (size < head + TAG) throw new Error("That is not a Hearth backup (too short).");
  const input = await open(src, "r");
  let nonce: Buffer;
  let tag: Buffer;
  try {
    const header = Buffer.alloc(head);
    await input.read(header, 0, head, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error("That is not a Hearth backup.");
    }
    nonce = header.subarray(MAGIC.length);
    tag = Buffer.alloc(TAG);
    await input.read(tag, 0, TAG, size - TAG);
  } finally {
    await input.close();
  }
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const out = await open(dst, "w", 0o600);
  try {
    if (size - TAG > head) {
      for await (const chunk of createReadStream(src, { start: head, end: size - TAG - 1 })) {
        await out.write(decipher.update(chunk as Buffer));
      }
    }
    await out.write(decipher.final());
  } finally {
    await out.close();
  }
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
