import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import {
  PREMIUM_FEATURES,
  RETIRED_PREMIUM_FEATURES,
  type GrantKind,
  type PremiumFeature,
} from "@dragon-control/core";

/**
 * A Hearth licence (docs/design/PREMIUM.md): a small signed statement that one installation has
 * some premium features, from a start date, until an end date or for good. It is signed with the
 * owner's private signing key (Ed25519) and checked here against the public keys Hearth trusts,
 * so it works offline and can't be edited: changing a single letter breaks the signature.
 *
 * The private key never lives in the code, the web page or an AI's context. It is kept in the
 * Secure Vault of the issuing Hearth only (issuer.ts).
 */

export interface LicensePayload {
  v: 1;
  /** The licence's own id (revocation names it). */
  id: string;
  /** The installation it belongs to (app_meta install_id). */
  install: string;
  features: PremiumFeature[];
  kind: GrantKind;
  /** ISO dates. No end: for good. */
  start: string;
  end?: string;
  issued: string;
  /** A short label for the recipient ("Alex's Hearth"), shown to them. */
  label?: string;
  /** The public key's id that signed it (key rotation). */
  key: string;
}

const PREFIX = "HEARTHL1";
const b64u = (b: Buffer) => b.toString("base64url");

export class LicenseError extends Error {}

/** The public keys this Hearth trusts, by key id: the raw 32-byte Ed25519 key in base64url. */
export type TrustedKeys = Record<string, string>;

/**
 * The production signing keys Hearth trusts. Empty until the owner makes the signing key (the owner's
 * approval, PREMIUM.md "Decisions"): then its public half is added here, in a release.
 */
export const PRODUCTION_KEYS: TrustedKeys = {
  // Hearth's licence service, licence.dragonsoath.com (11-17): it signs every code redeemed and
  // the licence keys the owner makes on its code site for his own installations. Not secret.
  UqekKBzqJ9gp: "UqekKBzqJ9gpqVOGgaZzCZTlFcLGyMbFFAR8uYpxvZA",
};

/**
 * Premium's locks (the owner: free for everyone, Premium by sponsoring or a code he hands out).
 * Codes and the owner's own licence keys come from the licence service's code site, never from a
 * Hearth. While false, or while no key is trusted, every premium feature is open.
 *
 * Was off for the 0.81.0 to 0.85.x test releases (the owner, 11-17) while the code site wasn't
 * live. On again for the public launch, once the owner's own Hearths hold their licences.
 */
export const PREMIUM_ENFORCED = true;

const spki = (raw: string) =>
  createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(raw, "base64url"),
    ]),
    format: "der",
    type: "spki",
  });

/** A new signing key pair: the private half as PKCS#8 PEM (for the vault), the public raw. */
export function newSigningKey(): { privatePem: string; publicKey: string; keyId: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return {
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: b64u(raw),
    keyId: keyIdOf(b64u(raw)),
  };
}

/** A key's id: the first 12 letters of its public half. */
export const keyIdOf = (publicKey: string) => publicKey.slice(0, 12);

/** The public half of a private key (to check it is one Hearth trusts). */
export function publicOf(privatePem: string): string {
  const raw = createPublicKey(createPrivateKey(privatePem))
    .export({ format: "der", type: "spki" })
    .subarray(12);
  return b64u(raw);
}

export function signLicense(
  payload: Omit<LicensePayload, "v" | "key">,
  privatePem: string,
): string {
  const full: LicensePayload = { v: 1, ...payload, key: keyIdOf(publicOf(privatePem)) };
  const body = b64u(Buffer.from(JSON.stringify(full)));
  const sig = sign(null, Buffer.from(`${PREFIX}.${body}`), createPrivateKey(privatePem));
  return `${PREFIX}.${body}.${b64u(sig)}`;
}

const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

/** Reads and checks a licence: its signature, by a trusted key, and its fields. */
export function readLicense(token: string, trusted: TrustedKeys): LicensePayload {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX)
    throw new LicenseError("That isn't a Hearth licence key.");
  let payload: LicensePayload;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as LicensePayload;
  } catch {
    throw new LicenseError("That licence key is damaged.");
  }
  const pub = trusted[payload?.key];
  if (!pub) throw new LicenseError("That licence wasn't issued by a key this Hearth trusts.");
  const ok = verify(
    null,
    Buffer.from(`${PREFIX}.${parts[1]}`),
    spki(pub),
    Buffer.from(parts[2]!, "base64url"),
  );
  if (!ok) throw new LicenseError("That licence key's signature doesn't match: it was changed.");
  if (
    payload.v !== 1 ||
    typeof payload.id !== "string" ||
    typeof payload.install !== "string" ||
    !Array.isArray(payload.features) ||
    !payload.features.every(
      (f) =>
        (PREMIUM_FEATURES as readonly string[]).includes(f) || RETIRED_PREMIUM_FEATURES.includes(f),
    ) ||
    !["complimentary", "paid", "trial"].includes(payload.kind) ||
    !ISO.test(payload.start) ||
    (payload.end !== undefined && !ISO.test(payload.end))
  )
    throw new LicenseError("That licence key isn't one this version of Hearth understands.");
  // A feature Hearth no longer has (Hearth Transfer) is dropped, so the rest of the licence works.
  return {
    ...payload,
    features: payload.features.filter((f) => !RETIRED_PREMIUM_FEATURES.includes(f)),
  };
}

/** A licence's id without checking it (to replace an older copy of the same licence). */
export function peekId(token: string): string | undefined {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      id?: unknown;
    };
    return typeof p.id === "string" ? p.id : undefined;
  } catch {
    return undefined;
  }
}
