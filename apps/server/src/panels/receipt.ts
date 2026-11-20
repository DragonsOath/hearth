import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import {
  RECEIPT_PREFIX,
  specHashInput,
  type PanelContribution,
  type PanelReceiptPayload,
  type PanelSpec,
} from "@dragon-control/core";

/**
 * Receipts from the panel submission service (Ed25519, like Hearth's licences): proof that a
 * contribution was accepted, bound to its exact spec. Hearth unlocks a Free panel, and counts a
 * loaded file as a shared panel, only on a receipt signed by a key it trusts.
 */

/** The submission service's public keys Hearth trusts (raw Ed25519, base64url, by key id). */
export type IntakeKeys = Record<string, string>;

/**
 * Production keys. Empty until the submission service is deployed with its signing key (the
 * owner's approval): its public half is added here in a release. Without one, nothing unlocks
 * through a submission, so the Free plan's lock stays off (installs open).
 */
export const PANEL_INTAKE_KEYS: IntakeKeys = {};

export class ReceiptError extends Error {}

/** sha-256 (hex) of the published spec. */
export const specHash = (spec: PanelSpec | PanelContribution["spec"]) =>
  createHash("sha256").update(specHashInput(spec)).digest("hex");

const spki = (raw: string) =>
  createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(raw, "base64url"),
    ]),
    format: "der",
    type: "spki",
  });

/** Checks a receipt's signature and shape, and that it is for this spec hash. */
export function verifyReceipt(
  token: string,
  keys: IntakeKeys,
  expectHash?: string,
): PanelReceiptPayload {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== RECEIPT_PREFIX)
    throw new ReceiptError("That is not a panel receipt.");
  let p: PanelReceiptPayload;
  try {
    p = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as PanelReceiptPayload;
  } catch {
    throw new ReceiptError("The panel receipt is damaged.");
  }
  const pub = keys[p?.key];
  if (!pub) throw new ReceiptError("The panel receipt is not from a service Hearth trusts.");
  const ok = verify(
    null,
    Buffer.from(`${RECEIPT_PREFIX}.${parts[1]}`),
    spki(pub),
    Buffer.from(parts[2]!, "base64url"),
  );
  if (!ok) throw new ReceiptError("The panel receipt's signature does not match.");
  if (p.v !== 1 || typeof p.id !== "string" || !/^[0-9a-f]{64}$/.test(p.specHash ?? ""))
    throw new ReceiptError("The panel receipt is not one this Hearth understands.");
  if (expectHash && p.specHash !== expectHash)
    throw new ReceiptError("The panel receipt is for a different panel.");
  return p;
}

/** Signs a receipt (tests and the stand-in service; the real service signs in services/panel-intake). */
export function signReceipt(
  payload: Omit<PanelReceiptPayload, "v" | "key">,
  privatePem: string,
): string {
  const raw = createPublicKey(createPrivateKey(privatePem))
    .export({ format: "der", type: "spki" })
    .subarray(12);
  const full: PanelReceiptPayload = {
    v: 1,
    ...payload,
    key: raw.toString("base64url").slice(0, 12),
  };
  const body = Buffer.from(JSON.stringify(full)).toString("base64url");
  const sig = sign(null, Buffer.from(`${RECEIPT_PREFIX}.${body}`), createPrivateKey(privatePem));
  return `${RECEIPT_PREFIX}.${body}.${sig.toString("base64url")}`;
}
