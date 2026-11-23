import { createHash, createHmac } from "node:crypto";
import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
import type { BlueprintFacts } from "@dragon-control/core";

/**
 * The Lab Blueprint's package: the blueprint and the vault entries it needs, encrypted with age
 * (the standard tool, so a version opens without Hearth too) to a public key. Hearth keeps only
 * that public key; the owner keeps the recovery key (age's secret key). Hearth can't open a
 * version itself, by design: only the owner's key, typed for a test or an import, opens one, in
 * memory.
 */

export const PACKAGE_FORMAT = "hearth-blueprint-package/1";

export interface PackageEntry {
  name: string;
  kind: string;
  tier: "automation" | "protected";
  service?: string;
  username?: string;
  endpoint?: string;
  category?: string;
  notes?: string;
  tags: string[];
  value: string;
}

export interface BlueprintPackage {
  format: typeof PACKAGE_FORMAT;
  writtenAt: string;
  hearthVersion: string;
  host: string;
  keyId: string;
  markdown: string;
  facts: BlueprintFacts;
  entries: PackageEntry[];
  /** Protected vault entries named but not in this version (no unlocked session when it ran). */
  protectedLeftOut: string[];
  /**
   * This Hearth's own Premium licence keys, so a new Hearth restored from this version can move
   * Premium to itself (the licence service gives it its own and takes these back). Read only by
   * Hearth, never by Ember: they aren't in the markdown.
   */
  licences?: string[];
}

export class PackageError extends Error {}

/** A recovery key and its public half. The secret half is shown to the owner once, never kept. */
export async function newRecoveryKey(): Promise<{
  recoveryKey: string;
  recipient: string;
  keyId: string;
}> {
  const recoveryKey = await generateIdentity();
  const recipient = await identityToRecipient(recoveryKey);
  return { recoveryKey, recipient, keyId: keyIdOf(recipient) };
}

/** A short, readable id for a key ("A1B2-C3D4"), the same for the key and its public half. */
export function keyIdOf(recipient: string): string {
  const h = createHash("sha256").update(recipient).digest("hex").slice(0, 8).toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4)}`;
}

/** The public half of a recovery key the owner typed, or why it isn't one. */
export async function recipientOf(recoveryKey: string): Promise<string> {
  const key = recoveryKey.trim();
  if (!/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/.test(key))
    throw new PackageError(
      "That isn't a recovery key: it starts AGE-SECRET-KEY-1 and is 74 characters long.",
    );
  try {
    return await identityToRecipient(key);
  } catch {
    throw new PackageError("That recovery key is damaged: check it was copied in full.");
  }
}

export async function encryptPackage(
  pkg: BlueprintPackage,
  recipient: string,
): Promise<Uint8Array> {
  const e = new Encrypter();
  e.addRecipient(recipient);
  return e.encrypt(JSON.stringify(pkg));
}

/** Opens a version in memory with the owner's recovery key; nothing is written anywhere. */
export async function decryptPackage(
  bytes: Uint8Array,
  recoveryKey: string,
): Promise<BlueprintPackage> {
  await recipientOf(recoveryKey);
  const d = new Decrypter();
  d.addIdentity(recoveryKey.trim());
  let text: string;
  try {
    text = await d.decrypt(bytes, "text");
  } catch {
    throw new PackageError(
      "This recovery key doesn't open that file: it was made for another key, or the file is damaged.",
    );
  }
  let pkg: BlueprintPackage;
  try {
    pkg = JSON.parse(text) as BlueprintPackage;
  } catch {
    throw new PackageError("The file opened, but what's inside isn't a Lab Blueprint.");
  }
  if (
    pkg?.format !== PACKAGE_FORMAT ||
    typeof pkg.markdown !== "string" ||
    !Array.isArray(pkg.entries)
  )
    throw new PackageError(
      "The file opened, but what's inside isn't a Lab Blueprint this Hearth reads.",
    );
  return pkg;
}

/**
 * What changed is judged by a keyed fingerprint (HMAC with a key only this machine holds), never a
 * plain hash: a short password could be guessed back from a plain hash of it.
 */
export function fingerprint(key: Buffer, pkg: BlueprintPackage): string {
  const stable = {
    markdown: pkg.markdown.replace(/^Written .* by Hearth,/m, "Written by Hearth,"),
    entries: [...pkg.entries].sort((a, b) => a.name.localeCompare(b.name)),
    protectedLeftOut: pkg.protectedLeftOut,
    keyId: pkg.keyId,
    licences: [...(pkg.licences ?? [])].sort(),
  };
  return createHmac("sha256", key).update(JSON.stringify(stable)).digest("hex");
}
