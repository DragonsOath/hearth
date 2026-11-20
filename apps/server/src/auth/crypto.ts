import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

/**
 * The few cryptographic building blocks Hearth uses, all from
 * Node's built-in crypto (no native add-ons):
 *
 * - scrypt for passwords and recovery keys (memory-hard, so guessing is slow);
 * - AES-256-GCM for everything encrypted at rest (tamper-evident);
 * - X25519 + HKDF so protected secrets can be added without unlocking,
 *   but only read with a key you hold.
 */

/** scrypt cost (N). 2^15 is about 100 ms and 32 MB; tests pass a lower one. */
export const DEFAULT_KDF_COST = 1 << 15;

const b64 = (b: Buffer) => b.toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

export function kdf(secret: string | Buffer, salt: Buffer, cost: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      secret,
      salt,
      32,
      { N: cost, r: 8, p: 1, maxmem: 256 * cost * 8 + 1024 * 1024 },
      (e, k) => (e ? reject(e) : resolve(k)),
    ),
  );
}

/** A one-way hash for checking a password later: "scrypt$N$salt$hash". */
export async function hashSecret(secret: string, cost: number): Promise<string> {
  const salt = randomBytes(16);
  const hash = await kdf(secret, salt, cost);
  return `scrypt$${cost}$${b64(salt)}$${b64(hash)}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [scheme, n, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !salt || !hash) return false;
  const expected = unb64(hash);
  const actual = await kdf(secret, unb64(salt), Number(n));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const randomToken = (bytes = 32) => b64(randomBytes(bytes));
export const sha256 = (s: string) => createHash("sha256").update(s).digest("base64url");
export const newSalt = () => b64(randomBytes(16));
export const saltBytes = (s: string) => unb64(s);

/** AES-256-GCM. `aad` binds the ciphertext to its context (e.g. the secret's id). */
export function seal(key: Buffer, plaintext: Buffer, aad = ""): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return b64(Buffer.concat([nonce, cipher.getAuthTag(), ct]));
}

export function open(key: Buffer, blob: string, aad = ""): Buffer {
  const raw = unb64(blob);
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
}

/* ---------- Protected secrets: encrypt to a public key ---------- */

export function newKeyPair(): { publicKey: string; privateKey: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: b64(publicKey.export({ type: "spki", format: "der" })),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }),
  };
}

function sharedKey(shared: Buffer, epk: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, epk, "dragon-control protected secret", 32));
}

export function sealTo(publicKey: string, plaintext: Buffer, aad = ""): string {
  const recipient = createPublicKey({ key: unb64(publicKey), format: "der", type: "spki" });
  const eph = generateKeyPairSync("x25519");
  const epk = eph.publicKey.export({ type: "spki", format: "der" });
  const key = sharedKey(diffieHellman({ privateKey: eph.privateKey, publicKey: recipient }), epk);
  return `${b64(epk)}.${seal(key, plaintext, aad)}`;
}

export function openWith(privateKey: Buffer, blob: string, aad = ""): Buffer {
  const [epkPart, body] = blob.split(".");
  if (!epkPart || !body) throw new Error("Malformed protected secret");
  const epk = unb64(epkPart);
  const priv = createPrivateKey({ key: privateKey, format: "der", type: "pkcs8" });
  const pub = createPublicKey({ key: epk, format: "der", type: "spki" });
  const key = sharedKey(diffieHellman({ privateKey: priv, publicKey: pub }), epk);
  return open(key, body, aad);
}

/** A key from a passkey's PRF output, for wrapping the protected private key. */
export function prfKey(prfOutput: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", prfOutput, Buffer.alloc(0), "dragon-control passkey", 32));
}

/** Recovery keys: 120 random bits, as six groups of four easy-to-read characters. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newRecoveryKey(): string {
  const bytes = randomBytes(24);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return chars.match(/.{4}/g)!.join("-");
}
/** Accepts what people type: any case, with or without dashes and spaces. */
export function normaliseRecoveryKey(input: string): string {
  const clean = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return (clean.match(/.{1,4}/g) ?? []).join("-");
}

/** One-time setup code: short enough to type, long enough not to guess (40 bits, rate limited). */
export function newSetupCode(): string {
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}
