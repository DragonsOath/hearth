import { createHash, randomInt } from "node:crypto";
import type { Vault } from "../auth/vault";
import type { DbHandle } from "../db/client";
import { getSetting, setSetting } from "../store/settings";

/**
 * The Hearth API key: what a new PC's setup asks for to link to this Hearth ("Already have a
 * Hearth account?"). It lives in the Secure Vault as a protected entry (your PIN or password to
 * see it), made when the account is, and Refresh makes a new one. Linked PCs keep their own pass,
 * so a refresh never disconnects them; the old key just stops linking new ones. Hearth checks a
 * key against its fingerprint (sha256), so linking works without the vault being unlocked.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const KEY_PATTERN = /^hearth_[A-Za-z0-9]{20}$/;

/** "hearth_" and 20 random letters and numbers (62^20, about 7 x 10^35 keys). */
export function newKey(): string {
  let s = "hearth_";
  for (let i = 0; i < 20; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

export const fingerprint = (key: string) => createHash("sha256").update(key.trim()).digest("hex");

export const KEY_NAME = "Hearth API key";

export class HearthKey {
  constructor(
    private readonly handle: DbHandle,
    private readonly vault: Vault,
  ) {}

  private get db() {
    return this.handle.db;
  }

  /** The vault entry holding it, made when missing (once the account is set up). */
  async ensure(): Promise<string> {
    const id = await getSetting(this.db, "hearth_key_secret");
    if (id && (await this.vault.exists(id))) return id;
    return this.refresh();
  }

  /** A new key: the vault entry gets it, and the old key stops linking new PCs. */
  async refresh(): Promise<string> {
    const key = newKey();
    const id = await getSetting(this.db, "hearth_key_secret");
    let secretId: string;
    if (id && (await this.vault.exists(id))) {
      await this.vault.update(id, { value: key });
      secretId = id;
    } else {
      const added = await this.vault.add({
        name: KEY_NAME,
        kind: "api-key",
        tier: "protected",
        value: key,
        notes:
          "Links a new PC to this Hearth: its setup asks for it. Refresh makes a new one; PCs already linked stay linked.",
        source: "Hearth",
        actor: "dragon-control",
      });
      secretId = added.id;
    }
    await setSetting(this.db, "hearth_key_secret", secretId);
    await setSetting(this.db, "link_key_hash", fingerprint(key));
    return secretId;
  }
}
